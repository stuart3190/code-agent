// Live proof: published apps ship as installable PWAs (2026-07-16 feature).
// Mirrors the prove-* discipline: opt-in, creds-required, real round-trips against the LIVE
// shell + provisiond + Caddy, cleanup in finally. Publishes a tiny real app as a tier-seeded
// probe user, then asserts the served site carries the full PWA surface.
//
//   PROVE_BASE=https://buildr101.com node shell/harness/prove-pwa.mjs   (default base = live)
//
//   PUBLISH   probe user + starter tier -> POST /api/publish (minimal tree, known tokens)
//   MANIFEST  /manifest.webmanifest -> 200 manifest+json; name + colours correct
//   SW        /sw.js -> 200 js with versioned cache const
//   ICONS     icon-192 / icon-512 / apple-touch-icon -> 200 PNG, non-trivial bytes
//   HTML      / -> contains manifest link + SW registration + swapped title
//   FRESH     republish under a new name -> manifest name changes (nothing stale)
//   CLEANUP   unpublish + delete probe user/tier rows

import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
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
  console.log(`${D}SKIPPED — set SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY (shell/.env).${X}`);
  process.exit(0);
}

const svc = createClient(SUPA_URL, SVC, { auth: { persistSession: false, autoRefreshToken: false } });
const anon = createClient(SUPA_URL, ANON, { auth: { persistSession: false } });

function probeTree() {
  const tree = clone(fromScaffold(REACT_VITE));
  tree["src/index.css"] = `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n:root { --background: 0 0% 100%; --primary: 24 95% 47%; }`;
  tree["src/App.jsx"] = `export default function App() { return <h1>pwa probe v1</h1>; }`;
  return tree;
}

async function main() {
  info(`shell ${BASE} · supabase ${new URL(SUPA_URL).host}`);
  const email = `pwa.probe.${Date.now()}@gmail.com`;
  const password = `Pw!${crypto.randomUUID().slice(0, 12)}Aa1`;
  const projectId = crypto.randomUUID();
  const slugBase = `pwa-probe-${Date.now().toString(36)}`;
  let user = null, siteUrl = null, token = null;

  try {
    // ── PUBLISH ──────────────────────────────────────────────────────────────────────────────
    section("PUBLISH — tier-seeded probe publishes a minimal app");
    const { data: created, error: cErr } = await svc.auth.admin.createUser({ email, password, email_confirm: true });
    if (cErr) throw new Error(cErr.message);
    user = created.user;
    await svc.from("customers").upsert({ owner: user.id, tier: "starter" });
    const { data: signed } = await anon.auth.signInWithPassword({ email, password });
    token = signed?.session?.access_token;
    check(!!token, "probe signed in (tier: starter seeded)");

    const pub = await fetch(`${BASE}/api/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ projectId, tree: probeTree(), name: slugBase }),
    });
    const pubOut = await pub.json().catch(() => ({}));
    check(pub.ok && pubOut.url, `publish -> ${pub.status} ${pubOut.url || pubOut.error}`);
    if (!pubOut.url) throw new Error("no site url — aborting assertions");
    siteUrl = pubOut.url.replace(/\/$/, "");

    // ── MANIFEST ─────────────────────────────────────────────────────────────────────────────
    section("MANIFEST");
    const mRes = await fetch(`${siteUrl}/manifest.webmanifest`);
    const mType = mRes.headers.get("content-type") || "";
    check(mRes.ok, `/manifest.webmanifest -> ${mRes.status}`);
    check(mType.includes("manifest"), `content-type is manifest+json (${mType})`);
    const manifest = await mRes.json().catch(() => ({}));
    check(manifest.name === slugBase, `manifest name = site name ("${manifest.name}")`);
    check(manifest.display === "standalone" && manifest.start_url === "/", "standalone display, start_url /");
    check(manifest.theme_color === "#ea6106", `theme colour derived from app tokens (${manifest.theme_color})`);
    check(manifest.icons?.length === 3, "3 icon entries (192, 512, maskable)");

    // ── SW ───────────────────────────────────────────────────────────────────────────────────
    section("SERVICE WORKER");
    const swRes = await fetch(`${siteUrl}/sw.js`);
    const swText = await swRes.text();
    check(swRes.ok && /const CACHE = "app-\d+"/.test(swText), `/sw.js -> ${swRes.status}, versioned cache`);
    check(swText.includes("navigate"), "network-first navigation handler present");

    // ── ICONS ────────────────────────────────────────────────────────────────────────────────
    section("ICONS — rendered per-app letter tiles");
    for (const f of ["icon-192.png", "icon-512.png", "apple-touch-icon.png"]) {
      const r = await fetch(`${siteUrl}/icons/${f}`);
      const bytes = (await r.arrayBuffer()).byteLength;
      check(r.ok && bytes > 800 && (r.headers.get("content-type") || "").includes("png"),
        `/icons/${f} -> ${r.status}, ${bytes}b png`);
    }

    // ── HTML ─────────────────────────────────────────────────────────────────────────────────
    section("HTML");
    const html = await (await fetch(`${siteUrl}/`)).text();
    check(html.includes('rel="manifest"'), "index links the manifest");
    check(html.includes("serviceWorker.register"), "index registers the service worker");
    check(html.includes("overflow-x:clip"), "index carries the horizontal-overflow guard (no right-edge clipping on phones)");
    check(html.includes(`<title>${slugBase}</title>`), "title swapped to the app name");

    // ── FRESH — republish must not serve stale PWA metadata ─────────────────────────────────
    section("FRESH — republish updates what's served");
    const name2 = `${slugBase}-v2`;
    const tree2 = probeTree();
    tree2["src/App.jsx"] = `export default function App() { return <h1>pwa probe v2</h1>; }`;
    const pub2 = await fetch(`${BASE}/api/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ projectId, tree: tree2, name: name2 }),
    });
    const pubOut2 = await pub2.json().catch(() => ({}));
    check(pub2.ok && pubOut2.url, `republish under new name -> ${pub2.status}${pubOut2.error ? ` (${String(pubOut2.error).slice(0, 300)})` : ""}`);
    if (pubOut2.url) {
      siteUrl = pubOut2.url.replace(/\/$/, "");
      const m2 = await (await fetch(`${siteUrl}/manifest.webmanifest`)).json().catch(() => ({}));
      check(m2.name === name2, `served manifest carries the new name ("${m2.name}")`);
    }
  } catch (e) {
    bad(`unhandled: ${e.message}`);
  } finally {
    // ── cleanup ──────────────────────────────────────────────────────────────────────────────
    if (token) {
      await fetch(`${BASE}/api/unpublish`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ projectId }),
      }).catch(() => {});
    }
    await svc.from("published_sites").delete().eq("project_id", projectId);
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
