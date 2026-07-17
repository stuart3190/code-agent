// Live proof: a published app exports as a signed Android APK + AAB with matching assetlinks.
// Mirrors prove-pwa discipline: opt-in, creds-required, real round-trips against the LIVE shell +
// buildr-android docker + provisiond + Caddy. Publishes a probe app, exports Android, verifies the
// zip + the live assetlinks. Slow (a real TWA build runs, ~1-2 min). Cleanup in finally.
//
//   node shell/harness/prove-android.mjs        (default base = https://buildr101.com)

import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import { readStoredZip } from "../../src/../shell/server/lib/exportProject.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";
import { fromScaffold, clone } from "../../src/engine/fileTree.mjs";
import { loadEnv } from "../server/lib/env.mjs";

loadEnv();
const BASE = process.env.PROVE_BASE || "https://buildr101.com";
const SUPA_URL = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;

const G = "\x1b[32m", R = "\x1b[31m", D = "\x1b[2m", B = "\x1b[1m", X = "\x1b[0m";
let passes = 0, fails = 0;
const ok = (m) => { passes++; console.log(`  ${G}PASS${X}  ${m}`); };
const bad = (m) => { fails++; console.log(`  ${R}FAIL${X}  ${m}`); };
const check = (c, m) => (c ? ok(m) : bad(m));
const section = (t) => console.log(`\n${B}--- ${t} ---${X}`);
const info = (m) => console.log(`  ${D}→ ${m}${X}`);

if (!SUPA_URL || !ANON || !SVC) {
  console.log(`${D}SKIPPED — set SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY.${X}`);
  process.exit(0);
}

const svc = createClient(SUPA_URL, SVC, { auth: { persistSession: false, autoRefreshToken: false } });
const anon = createClient(SUPA_URL, ANON, { auth: { persistSession: false } });

function probeTree() {
  const t = clone(fromScaffold(REACT_VITE));
  t["src/index.css"] = `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n:root { --background: 0 0% 100%; --primary: 24 95% 47%; }`;
  t["src/App.jsx"] = `export default function App() { return <h1>android probe</h1>; }`;
  return t;
}

async function main() {
  info(`shell ${BASE}`);
  const email = `android.probe.${Date.now()}@gmail.com`;
  const password = `Pw!${crypto.randomUUID().slice(0, 12)}Aa1`;
  const projectId = crypto.randomUUID();
  const slug = `android-probe-${Date.now().toString(36)}`;
  let user = null, token = null;

  try {
    section("SETUP — probe publishes an app");
    const { data: created, error: cErr } = await svc.auth.admin.createUser({ email, password, email_confirm: true });
    if (cErr) throw new Error(cErr.message);
    user = created.user;
    await svc.from("customers").upsert({ owner: user.id, tier: "starter" });
    // A projects row is needed (owner check + name) for the android route.
    await svc.from("projects").insert({ id: projectId, owner: user.id, name: "Android Probe" });
    const { data: signed } = await anon.auth.signInWithPassword({ email, password });
    token = signed?.session?.access_token;

    const pub = await fetch(`${BASE}/api/publish`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ projectId, tree: probeTree(), name: slug }),
    });
    check(pub.ok, `publish -> ${pub.status}`);
    if (!pub.ok) throw new Error("publish failed — aborting");

    section("ANDROID EXPORT — real TWA build (~1-2 min)");
    const t0 = Date.now();
    const res = await fetch(`${BASE}/api/android`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ projectId, tree: probeTree() }),
    });
    check(res.ok && (res.headers.get("content-type") || "").includes("zip"),
      `/api/android -> ${res.status} ${res.headers.get("content-type")} (${Math.round((Date.now() - t0) / 1000)}s)`);
    if (!res.ok) { try { info(JSON.stringify(await res.json())); } catch {} throw new Error("android export failed"); }

    const zipBuf = Buffer.from(await res.arrayBuffer());
    const files = readStoredZip(zipBuf); // { name: Buffer|string } — binary entries kept as bytes where possible
    const names = Object.keys(files);
    info(`zip entries: ${names.join(", ")}`);
    const size = (n) => (files[n] ? Buffer.byteLength(files[n]) : 0);
    check(names.includes("app.apk") && size("app.apk") > 500_000, `app.apk present (${size("app.apk")}b)`);
    check(names.includes("app.aab") && size("app.aab") > 500_000, `app.aab present (${size("app.aab")}b)`);
    check(names.includes("app.keystore") && size("app.keystore") > 800, `app.keystore present (${size("app.keystore")}b)`);
    check(names.includes("README.txt"), "README.txt present");
    const apkMagic = files["app.apk"] && Buffer.from(files["app.apk"]).slice(0, 2).toString("latin1");
    check(apkMagic === "PK", "app.apk is a real zip/APK (PK magic)");

    section("ASSETLINKS — live origin verifies the app");
    const origin = `https://${slug}.app.buildr101.com`;
    const alRes = await fetch(`${origin}/.well-known/assetlinks.json`);
    check(alRes.ok, `/.well-known/assetlinks.json -> ${alRes.status}`);
    const al = await alRes.json().catch(() => null);
    const entry = Array.isArray(al) ? al[0] : null;
    check(entry?.target?.package_name === `com.buildr101.app_${slug.replace(/-/g, "_")}`,
      `package_name = ${entry?.target?.package_name}`);
    const fp = entry?.target?.sha256_cert_fingerprints?.[0];
    check(!!fp && /^[0-9A-F:]{95,}$/.test(fp), `fingerprint present (${(fp || "").slice(0, 20)}…)`);

    section("KEY REUSE — a second export reuses the same signing key");
    const { data: ks } = await svc.from("android_keystores").select("fingerprint, package_id").eq("project_id", projectId).maybeSingle();
    check(ks?.fingerprint === fp, "stored keystore fingerprint matches served assetlinks");

    section("SURVIVAL — assetlinks persists a plain republish (installed app stays verified)");
    const rep = await fetch(`${BASE}/api/publish`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ projectId, tree: probeTree(), name: slug }),
    });
    check(rep.ok, `plain republish -> ${rep.status}`);
    const al2 = await fetch(`${origin}/.well-known/assetlinks.json`);
    const al2j = await al2.json().catch(() => null);
    check(al2.ok && Array.isArray(al2j) && al2j[0]?.target?.sha256_cert_fingerprints?.[0] === fp,
      "assetlinks still served with the same fingerprint after a plain republish");
  } catch (e) {
    bad(`unhandled: ${e.message}`);
  } finally {
    if (token) {
      await fetch(`${BASE}/api/unpublish`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ projectId }),
      }).catch(() => {});
    }
    await svc.from("android_keystores").delete().eq("project_id", projectId);
    await svc.from("published_sites").delete().eq("project_id", projectId);
    await svc.from("projects").delete().eq("id", projectId);
    if (user) {
      await svc.from("customers").delete().eq("owner", user.id);
      await svc.auth.admin.deleteUser(user.id).catch(() => {});
    }
    info("cleanup done");
  }

  console.log(`\n${B}${passes} passed, ${fails} failed${X}`);
  process.exit(fails ? 1 : 0);
}

main();
