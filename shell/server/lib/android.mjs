// Android export — wrap a published PWA into a signed APK + AAB (TWA) and return a download zip.
// The heavy lifting runs in the buildr-android Docker image (JDK + Android SDK + Bubblewrap);
// this module orchestrates: per-project signing key (encrypted at rest, mirrors byokStore),
// the assetlinks republish (so the live origin verifies the app full-screen), the docker run,
// and zip assembly. VPS-only (needs docker + the image), like publish.
//
//   buildAndroid({ owner, projectId, slug, tree, log }) -> { zip: Buffer, filename }

import { execFileSync } from "node:child_process";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { serviceClient } from "./supabase.mjs";
import { _internal as byokCrypto } from "./byokStore.mjs";
import { pwaColors } from "./pwa.mjs";
import { createStoredZip } from "./exportProject.mjs";
import { packageIdFor } from "./androidLinks.mjs";
import { ensureAppIdentity } from "./appIdentity.mjs";
import { materializeAndPublish } from "../routes/publish.mjs";

const IMAGE = "buildr-android:latest";
const APEX = "app.buildr101.com";

// Binary keystore <-> encrypted column: byokStore's crypto is utf8-only, so base64 the bytes.
const encBytes = (buf) => byokCrypto.encrypt(Buffer.from(buf).toString("base64"));
const decBytes = (stored) => Buffer.from(byokCrypto.decrypt(stored), "base64");
const encStr = (s) => byokCrypto.encrypt(s);
const decStr = (s) => byokCrypto.decrypt(s);

async function loadKeystore(projectId) {
  const { data } = await serviceClient()
    .from("android_keystores").select("*").eq("project_id", projectId).maybeSingle();
  if (!data) return null;
  return {
    keystore: decBytes(data.keystore_encrypted),
    password: decStr(data.password_encrypted),
    fingerprint: data.fingerprint,
    packageId: data.package_id,
  };
}

async function saveKeystore({ projectId, owner, keystore, password, fingerprint, packageId }) {
  const now = new Date().toISOString();
  const { error } = await serviceClient().from("android_keystores").upsert({
    project_id: projectId, owner,
    keystore_encrypted: encBytes(keystore),
    password_encrypted: encStr(password),
    fingerprint, package_id: packageId, updated_at: now,
  }, { onConflict: "project_id" });
  if (error) throw new Error(`android keystore store: ${error.message}`);
}

function readme({ appName, packageId, fingerprint, origin }) {
  return `${appName} — Android app (built by Buildr101)
${"=".repeat(48)}

WHAT'S IN THIS ZIP
  app.apk        Install this directly on an Android phone to test
                 (Settings may ask you to allow installing from this source).
  app.aab        The Android App Bundle to UPLOAD to the Google Play Store.
  app.keystore   Your app's signing key. KEEP THIS SAFE — you need the exact
                 same file to publish UPDATES. If you lose it you cannot update
                 the app on Play.
  keystore-password.txt   The password for the keystore above.

PUT IT ON THE PLAY STORE (your own account)
  1. Create a Google Play developer account (one-time $25) at
     https://play.google.com/console
  2. Create an app, then upload app.aab to a release track.
  3. When Play asks about app signing, choose "Play App Signing" and use this
     keystore as your UPLOAD key.
  4. Fill in the store listing (icon, screenshots, description) and submit.

DETAILS
  App ID (package name): ${packageId}   (permanent once published)
  Signing SHA-256:       ${fingerprint}
  Verified against:      ${origin}

The app opens your published site full-screen with no browser bar because that
site serves /.well-known/assetlinks.json matching the signing key above. Keep
the app published (or on your own custom domain) for that to keep working.

Questions? support@buildr101.com
`;
}

export async function buildAndroid({ owner, projectId, slug, tree, appName: rawName, log = () => {} }) {
  const origin = `https://${slug}.${APEX}`;
  const manifestUrl = `${origin}/manifest.webmanifest`;
  // Use the SAME generated identity name as the PWA (already cached — the app was published first),
  // so the Android launcher label matches the home-screen name.
  const identity = await ensureAppIdentity({ projectId, fallbackName: rawName || slug, log });
  const { name: appName, themeColor, backgroundColor } = pwaColors(tree, identity.name);

  const existing = await loadKeystore(projectId);
  const packageId = existing?.packageId || packageIdFor(slug);
  const password = existing?.password || crypto.randomBytes(18).toString("base64").replace(/[/+=]/g, "");

  const work = path.join(os.tmpdir(), `buildr-android-${projectId}-${Date.now()}`);
  try {
    await mkdir(path.join(work, "out"), { recursive: true });
    await writeFile(path.join(work, "params.json"), JSON.stringify({
      manifestUrl, host: `${slug}.${APEX}`, origin, appName, packageId,
      keyPassword: password, themeColor, backgroundColor,
      iconUrl: `${origin}/icons/icon-512.png`,
    }), "utf8");
    if (existing) await writeFile(path.join(work, "in.keystore"), existing.keystore);

    log("android: building signed APK + AAB (this takes a couple of minutes)…");
    try {
      // Persist the gradle cache across runs (the container is --rm) so only the FIRST build
      // downloads gradle + deps; later builds reuse the named volume and finish faster.
      execFileSync("docker", ["run", "--rm", "-v", `${work}:/work`, "-v", "buildr-gradle:/root/.gradle", IMAGE], {
        stdio: "pipe", timeout: 12 * 60_000, maxBuffer: 64 * 1024 * 1024, // gradle is chatty; cold builds are slow
      });
    } catch (e) {
      const tail = String(e.stderr || e.stdout || e.message).split("\n").slice(-6).join("\n");
      console.error(`[android] docker build failed:\n${tail}`);
      const err = new Error("build_failed"); err.code = "build_failed"; throw err;
    }

    const apk = await readFile(path.join(work, "out", "app.apk"));
    const aab = await readFile(path.join(work, "out", "app.aab"));
    const keystore = await readFile(path.join(work, "out", "app.keystore"));
    const fingerprint = (await readFile(path.join(work, "out", "fingerprint.txt"), "utf8")).trim();
    if (!fingerprint) throw new Error("build produced no signing fingerprint");

    // Persist the key FIRST — once the row exists, materializeAndPublish injects assetlinks into
    // this (and every future) publish automatically, so the installed app stays verified.
    await saveKeystore({ projectId, owner: owner.id, keystore, password, fingerprint, packageId });

    // Republish so the live origin serves the fresh assetlinks (injected by the publish core).
    log("android: publishing app verification…");
    await materializeAndPublish({ owner, projectId, tree, name: null });

    const zip = createStoredZip({
      "app.apk": apk,
      "app.aab": aab,
      "app.keystore": keystore,
      "keystore-password.txt": password + "\n",
      "README.txt": readme({ appName, packageId, fingerprint, origin }),
    });
    return { zip, filename: `${slug}-android.zip` };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
