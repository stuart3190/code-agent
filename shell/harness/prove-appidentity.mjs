// Live proof: a published app gets a GENERATED name + glyph icon (2026-07-17), cached per project.
// Opt-in, creds-required, real round-trips. Publishes a probe whose history describes a barber
// shop, then checks the served manifest name + that projects.app_name/app_icon populated, the icon
// is a non-trivial PNG, and a republish reuses the cached identity (no second generation).
//
//   node shell/harness/prove-appidentity.mjs

import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import { GLYPH_SLUGS } from "../server/lib/iconGlyphs.mjs";
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

if (!SUPA_URL || !ANON || !SVC) { console.log(`${D}SKIPPED — creds required.${X}`); process.exit(0); }
const svc = createClient(SUPA_URL, SVC, { auth: { persistSession: false, autoRefreshToken: false } });
const anon = createClient(SUPA_URL, ANON, { auth: { persistSession: false } });

async function main() {
  const email = `identity.probe.${Date.now()}@gmail.com`;
  const password = `Pw!${crypto.randomUUID().slice(0, 12)}Aa1`;
  const projectId = crypto.randomUUID();
  const slug = `identity-probe-${Date.now().toString(36)}`;
  let user = null;

  try {
    section("SETUP — probe with a barber-shop build history");
    const { data: created, error } = await svc.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw new Error(error.message);
    user = created.user;
    await svc.from("customers").upsert({ owner: user.id, tier: "starter" });
    // A generic project name + a descriptive first prompt: the generator should invent a real name.
    await svc.from("projects").insert({
      id: projectId, owner: user.id, name: "Untitled app",
      history: [{ prompt: "a website for a local barber shop with services, prices, opening hours and a booking form" }],
    });
    const { data: signed } = await anon.auth.signInWithPassword({ email, password });
    const token = signed?.session?.access_token;

    const tree = clone(fromScaffold(REACT_VITE));
    tree["src/index.css"] = `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n:root { --background: 0 0% 100%; --primary: 24 95% 47%; }`;
    tree["src/App.jsx"] = `export default function App(){ return <h1>barber</h1>; }`;

    section("PUBLISH — identity generated");
    const pub = await fetch(`${BASE}/api/publish`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ projectId, tree }), // NO explicit name -> generated name is used
    });
    const pubOut = await pub.json().catch(() => ({}));
    check(pub.ok, `publish -> ${pub.status}`);
    if (!pub.ok) throw new Error("publish failed");
    const origin = pubOut.url.replace(/\/$/, "");

    const { data: proj } = await svc.from("projects").select("app_name, app_icon").eq("id", projectId).maybeSingle();
    info(`generated: name="${proj?.app_name}" icon="${proj?.app_icon}"`);
    check(!!proj?.app_name && proj.app_name !== "Untitled app", `app_name generated ("${proj?.app_name}")`);
    check(GLYPH_SLUGS.includes(proj?.app_icon), `app_icon is a valid glyph slug ("${proj?.app_icon}")`);
    // A barber prompt should pick scissors (best case) — not required, but log it.
    if (proj?.app_icon === "scissors") ok("icon is scissors (barber-appropriate)");
    else info(`icon = ${proj?.app_icon} (any valid slug passes)`);

    section("MANIFEST + ICON served");
    const man = await (await fetch(`${origin}/manifest.webmanifest`)).json().catch(() => ({}));
    check(man.name === proj?.app_name, `manifest name = generated name ("${man.name}")`);
    const icon = await fetch(`${origin}/icons/icon-512.png`);
    const bytes = (await icon.arrayBuffer()).byteLength;
    check(icon.ok && bytes > 1500, `/icons/icon-512.png served (${bytes}b png)`);

    section("CACHED — republish reuses the identity (no regeneration)");
    const rep = await fetch(`${BASE}/api/publish`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ projectId, tree }),
    });
    check(rep.ok, `republish -> ${rep.status}`);
    const { data: proj2 } = await svc.from("projects").select("app_name, app_icon").eq("id", projectId).maybeSingle();
    check(proj2?.app_name === proj?.app_name && proj2?.app_icon === proj?.app_icon,
      "identity unchanged on republish (cached, not regenerated)");
  } catch (e) {
    bad(`unhandled: ${e.message}`);
  } finally {
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
