// Headless end-to-end proof of the PRODUCT SHELL — the browser's exact API calls, driven server-side
// with a REAL Supabase session, so every step produces evidence (mirrors proveBilling.mjs discipline:
// opt-in, creds-required, real round-trips, asserted against costModel, denial = pass).
//
//   SIGNUP    a real user via the backend SDK anon flow (no service_role) -> session token
//   SEED      grant the Starter bundle via the service-role ledger (stands in for the Stripe grant,
//             whose own path proveBilling.mjs proves live) so there is a balance to spend
//   PLAN      POST /api/generate (mode plan) -> plan text only: NO tree/build/preview in the payload,
//             small metered debit = creditsForTurn exactly
//   GENERATE  POST /api/generate (mode build, with the held plan attached) -> stream -> app BUILDS ->
//             ledger DEBITS the served tokens by exactly creditsForTurn({tokens, model})
//   PREVIEW   the returned preview URL serves HTTP 200 (real local Vite)
//   ITERATE   POST /api/generate (mode iterate) with the held tree -> edit lands, still builds, debits
//   EXPORT    POST /api/export -> ZIP contains full runnable scaffold + generated files, no secrets
//   PERSIST   save the project via the SDK, then re-open through a FRESH session (= reload) -> tree +
//             prompts intact
//   ISOLATE   a second user cannot see user A's project (owner-scoped RLS; denial = pass)
//
// Spends Codex quota THREE times (plan + build + iterate) — this is the one gated live spend. Run:
//   (fill shell/.env + shell/web/.env, or export the vars)  node shell/harness/prove-shell.mjs
// Missing creds -> SKIPPED.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { createSupabaseBackend } from "../../src/scaffolds/reactVite/lib/backend/supabaseBackend.js";
import { createLedger } from "../../src/billing/ledger.mjs";
import { TIERS, WELCOME_CREDITS } from "../../src/billing/costModel.mjs";
import { loadEnv } from "../server/lib/env.mjs";
import { SAFE_ENV_EXAMPLE, assertNoPlatformSecrets, readStoredZip } from "../server/lib/exportProject.mjs";

loadEnv();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "server", "index.mjs");

const SUPA_URL = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
// Own port, decoupled from shell/.env's SHELL_PORT so the proof never collides with a dev server.
const PORT = Number(process.env.PROVE_PORT || 8791);
const BASE = `http://localhost:${PORT}`;

// ── tiny test harness ──────────────────────────────────────────────────────────────────────────
const G = "\x1b[32m", R = "\x1b[31m", D = "\x1b[2m", B = "\x1b[1m", X = "\x1b[0m";
let passes = 0, fails = 0;
const ok = (m) => { passes++; console.log(`  ${G}PASS${X}  ${m}`); };
const bad = (m) => { fails++; console.log(`  ${R}FAIL${X}  ${m}`); };
const section = (t) => console.log(`\n${B}--- ${t} ---${X}`);
const info = (m) => console.log(`  ${D}→ ${m}${X}`);
const check = (cond, m) => (cond ? ok(m) : bad(m));

if (!SUPA_URL || !ANON || !SVC) {
  console.log(`${D}SKIPPED — set SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY (shell/.env) to run the live proof.${X}`);
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Trees are { path: contents }. Compare by path-set + per-file contents — robust to Postgres jsonb
// reordering object keys on the way back out (string values themselves are preserved exactly).
function treeEqual(a, b) {
  if (!a || !b) return false;
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) => a[k] === b[k]);
}
const anonClient = () => createClient(SUPA_URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
// The PROVEN Phase 3 backend SDK — auth + its RLS-scoped Supabase _client (projects persistence goes
// through _client.from("projects"), exactly the session the browser uses).
const userBackend = () => createSupabaseBackend({ url: SUPA_URL, anonKey: ANON });
const tokenOf = async (be) => (await be._client.auth.getSession()).data.session?.access_token;
const svcClient = createClient(SUPA_URL, SVC, { auth: { persistSession: false, autoRefreshToken: false } });
const ledger = createLedger(svcClient);

async function waitHealth(deadlineMs = 30000) {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return r.json(); } catch {}
    await sleep(500);
  }
  throw new Error("server did not become healthy");
}

// POST /api/generate (now returns 202 {jobId} — the build is a detached server-side job) then
// drain the job's coarse event stream to its terminal frame, exactly as the browser does. The
// terminal `result` is the whitelisted payload {finalText, tree, buildOk, previewUrl, need,
// balance} — engine internals (model, telemetry, tool calls) intentionally never reach here, so
// debit-exactness is checked by balance delta below (and independently in prove-jobs / the unit
// billing suite). Returns { done } where done = { mode, ...result }.
async function generate(token, body) {
  const res = await fetch(`${BASE}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) { let e = {}; try { e = await res.json(); } catch {} throw Object.assign(new Error(e.error || res.status), { payload: e }); }
  const { jobId } = await res.json();
  const evRes = await fetch(`${BASE}/api/builds/${encodeURIComponent(jobId)}/events`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!evRes.ok) throw new Error(`events ${evRes.status}`);
  const reader = evRes.body.getReader(); const dec = new TextDecoder();
  let buf = "", terminal = null;
  for (;;) {
    const { value, done: d } = await reader.read(); if (d) break;
    buf += dec.decode(value, { stream: true });
    const frames = buf.split("\n\n"); buf = frames.pop() || "";
    for (const f of frames) {
      const dl = f.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim();
      if (!dl) continue; // skip :ping comments
      const data = JSON.parse(dl);
      if (["complete", "failed", "interrupted"].includes(data.status)) terminal = data;
    }
  }
  if (!terminal) throw new Error("stream ended with no terminal frame");
  if (terminal.status !== "complete") throw new Error(terminal.error || `build ${terminal.status}`);
  return { done: { mode: terminal.mode, ...(terminal.result || {}) } };
}

async function exportProjectZip(token, projectId) {
  const res = await fetch(`${BASE}/api/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ projectId }),
  });
  if (!res.ok) {
    let e = {};
    try { e = await res.json(); } catch {}
    throw Object.assign(new Error(e.error || `export ${res.status}`), { payload: e });
  }
  const filename = /filename="([^"]+)"/i.exec(res.headers.get("content-disposition") || "")?.[1] || "buildr101-app.zip";
  const zip = Buffer.from(await res.arrayBuffer());
  return { filename, zip, entries: readStoredZip(zip) };
}

async function main() {
  console.log(`${B}=== Shell E2E proof — describe → generate → preview → iterate → persist ===${X}`);
  info(`server ${BASE} · supabase ${new URL(SUPA_URL).host}`);

  // Boot the server as a child (inherits env).
  const child = spawn(process.execPath, [SERVER], {
    // SHELL_HOST cleared: the proof always talks to its child on localhost, regardless of the
    // production bind (on the VPS, shell/.env sets SHELL_HOST=10.83.7.1 for the Caddy-only bind).
    env: { ...process.env, SHELL_PORT: String(PORT), SHELL_HOST: "" },
    stdio: ["ignore", "inherit", "inherit"],
  });
  let owner = null;
  try {
    const health = await waitHealth();
    check(health.ok && health.supabase, `server healthy (supabase env: ${health.supabase}, preview: ${health.previewMode})`);

    // ── SIGNUP ─────────────────────────────────────────────────────────────────────────────────
    section("SIGNUP — real user via the backend SDK anon flow");
    const email = `shell.probe.${Date.now()}@gmail.com`;
    const password = `Pw!${Math.random().toString(36).slice(2)}Aa1`;
    const backend = userBackend();
    const user = await backend.auth.signUp({ email, password }); // SDK returns the user (throws on error)
    check(!!user?.id, `signUp -> user ${user?.id?.slice(0, 8)}…`);
    owner = user.id;
    // ensure a session (Phase 3 setup disables email confirmation so signUp establishes it directly)
    let token = await tokenOf(backend);
    if (!token) { await backend.auth.signIn({ email, password }); token = await tokenOf(backend); }
    check(!!token, "have an access token (session established)");

    // ── WELCOME credits land once, up front (a server balance read triggers the idempotent grant)
    // — flushed BEFORE the seed so every later balance delta measures ONLY its own debit.
    section("WELCOME — new account gets its one-time welcome credits on first server contact");
    const wr = await fetch(`${BASE}/api/billing/balance`, { headers: { Authorization: `Bearer ${token}` } });
    const welcomed = (await wr.json())?.balance?.total ?? (await ledger.getBalance(owner)).total;
    check(Math.abs(welcomed - WELCOME_CREDITS) < 1e-6, `welcome grant landed = ${welcomed} cr (WELCOME_CREDITS ${WELCOME_CREDITS})`);

    // ── SEED balance (stands in for the Stripe subscription grant) ───────────────────────────────
    section("SEED — grant the Starter bundle (service role; the Stripe grant path is proven in proveBilling)");
    const starter = TIERS.find((t) => t.id === "starter");
    await ledger.grant({ owner, credits: starter.bundledCredits, bucket: "bundle", kind: "grant", cycle: "seed", ref: `seed:${owner}` });
    await ledger.setEntitlement({ owner, tier: "starter", currentPeriod: "seed" });
    const seeded = await ledger.getBalance(owner);
    check(Math.abs(seeded.total - (starter.bundledCredits + WELCOME_CREDITS)) < 1e-6,
      `seeded balance = ${seeded.total} cr (Starter ${starter.bundledCredits} + welcome ${WELCOME_CREDITS})`);

    // ── PLAN (plan-only pass: no tools, no build, no preview) ───────────────────────────────────
    section("PLAN — plan-only pass produces a plan, builds nothing, meters the debit");
    const appPrompt = "a notes app: add a note with a title and body, list notes newest-first, delete a note";
    const balBeforePlan = (await ledger.getBalance(owner)).total;
    const gp = await generate(token, { prompt: appPrompt, mode: "plan" });
    const dp = gp.done;
    check(!!dp?.finalText?.trim(), `plan produced (${(dp?.finalText || "").trim().length} chars of plan text)`);
    check(dp?.tree === undefined && dp?.buildOk === undefined && dp?.previewUrl === undefined,
      "plan payload carries NO tree/build/preview (nothing was built or served)");
    check(dp.need > 0, `plan metered a positive debit (${dp.need.toFixed(4)} cr)`);
    const balAfterPlan = (await ledger.getBalance(owner)).total;
    check(Math.abs((balBeforePlan - balAfterPlan) - dp.need) < 1e-3, `ledger dropped by exactly the reported plan debit (${balBeforePlan.toFixed(3)} → ${balAfterPlan.toFixed(3)})`);

    // ── GENERATE (build, steered by the held plan — the browser's plan→generate sequence) ────────
    section("GENERATE — describe → engine builds a real app (against the plan) → live debit");
    const balBefore = (await ledger.getBalance(owner)).total;
    const g1 = await generate(token, { prompt: appPrompt, mode: "build", plan: dp.finalText });
    const d1 = g1.done;
    check(!!d1, "generation returned a done payload");
    check(d1?.buildOk === true, `generated app BUILDS (npm run build PASS) — ${Object.keys(d1?.tree || {}).length} files`);
    check(d1.need > 0, `build metered a positive debit (${d1.need.toFixed(4)} cr)`);
    const balAfter = (await ledger.getBalance(owner)).total;
    check(Math.abs((balBefore - balAfter) - d1.need) < 1e-3, `ledger dropped by exactly the reported debit (${balBefore.toFixed(3)} → ${balAfter.toFixed(3)})`);

    // ── PREVIEW ───────────────────────────────────────────────────────────────────────────────────
    section("PREVIEW — the returned URL serves the running app");
    if (d1.previewUrl) {
      const pr = await fetch(d1.previewUrl).catch(() => null);
      const html = pr ? await pr.text() : "";
      check(pr?.status === 200 && /<div id="root">|<script/.test(html), `preview ${d1.previewUrl} -> HTTP ${pr?.status}`);
    } else { info("preview returned no URL (VPS provisiond unreachable from this box) — skipped"); }

    // ── PERSIST (save to the dedicated projects table via the user's own session) ────────────────
    section("PERSIST — save the project (dedicated public.projects, RLS-scoped)");
    const insP = await backend._client.from("projects").insert({
      name: "Notes app", tree: d1.tree, history: [{ prompt: "notes app", mode: "build", need: d1.need }], preview_ref: d1.previewUrl || null,
    }).select().single();
    if (insP.error) throw insP.error;
    const proj = insP.data;
    check(!!proj?.id, `project saved -> ${proj.id.slice(0, 8)}…`);

    // ── ITERATE (edit holds) ──────────────────────────────────────────────────────────────────────
    section("ITERATE — a follow-up edit against the held tree");
    const g2 = await generate(token, { projectId: proj.id, prompt: "add a search box that filters notes by title", mode: "iterate", tree: d1.tree });
    const d2 = g2.done;
    check(d2?.buildOk === true, "iterated app still BUILDS");
    const changed = d2 && !treeEqual(d2.tree, d1.tree);
    check(changed, "the tree actually changed (edit applied)");
    check(d2.need > 0, `iterate metered a positive debit (${d2.need.toFixed(4)} cr)`);
    const updP = await backend._client.from("projects").update({
      name: "Notes app", tree: d2.tree, history: [{ prompt: "notes app" }, { prompt: "search box" }], preview_ref: d2.previewUrl || null, updated_at: new Date().toISOString(),
    }).eq("id", proj.id);
    if (updP.error) throw updP.error;

    section("EXPORT - authenticated ZIP download from the saved project");
    const exported = await exportProjectZip(token, proj.id);
    check(exported.filename.endsWith(".zip") && exported.zip.length > 1000,
      `downloaded ${exported.filename} (${exported.zip.length} bytes)`);
    const requiredExportPaths = [
      "README.txt",
      ".gitignore",
      ".env.example",
      "package.json",
      "index.html",
      "vite.config.js",
      "tailwind.config.js",
      "postcss.config.js",
      "src/main.jsx",
      "src/index.css",
      "src/App.jsx",
      "src/lib/backend/index.js",
      "src/lib/backend/supabaseBackend.js"
    ];
    for (const path of requiredExportPaths) {
      check(Boolean(exported.entries[path]), `ZIP contains ${path}`);
    }
    const pkg = JSON.parse(exported.entries["package.json"]);
    check(pkg.scripts?.dev === "vite" && pkg.scripts?.build === "vite build",
      "exported package.json has working Vite dev/build scripts");
    check(pkg.dependencies?.react && pkg.dependencies?.["react-dom"] && pkg.devDependencies?.vite,
      "exported package.json includes React and Vite dependencies");
    check(exported.entries[".env.example"] === SAFE_ENV_EXAMPLE,
      ".env.example is regenerated with placeholders only");
    const readme = exported.entries["README.txt"];
    check(/npm install/.test(readme) &&
      /npm run dev/.test(readme) &&
      /npm run build/.test(readme) &&
      /Before You Start/.test(readme) &&
      /RUN THE APP ON YOUR COMPUTER/.test(readme) &&
      /COMMON PROBLEMS/.test(readme) &&
      /Vercel/.test(readme) &&
      /Netlify/.test(readme) &&
      !readme.includes("```") && !/^#/m.test(readme),
      "README.txt is plain-text and documents beginner setup, install, run, build, troubleshooting, and static deploy");
    const unsafeExportPaths = [".env", ".env.local", "node_modules/pkg/index.js", "dist/assets/app.js", "server/platform.js"];
    check(!unsafeExportPaths.some((path) => Object.hasOwn(exported.entries, path)),
      "ZIP excludes env files, build output, node_modules, and platform paths");
    try {
      assertNoPlatformSecrets(exported.entries);
      ok("secret gate found no service-role, Stripe, BYOK, Cloudflare, or sk_ markers");
    } catch (e) {
      bad(e.message);
    }

    // ── RELOAD/REOPEN (fresh session = reload) ───────────────────────────────────────────────────
    section("PERSIST across reload — reopen through a FRESH session");
    const fresh = userBackend();
    await fresh.auth.signIn({ email, password });
    const relP = await fresh._client.from("projects").select("*").eq("id", proj.id).single();
    if (relP.error) throw relP.error;
    const reopened = relP.data;
    check(!!reopened?.tree, "project reopened with its tree intact");
    check(treeEqual(reopened.tree, d2.tree), "reopened tree == the iterated tree (edits held across reload)");
    check((reopened.history?.length || 0) === 2, `prompt history intact (${reopened.history?.length} turns)`);

    // ── ISOLATE (RLS) ────────────────────────────────────────────────────────────────────────────
    section("ISOLATE — a second user cannot see user A's project (RLS)");
    const bEmail = `shell.probe.b.${Date.now()}@gmail.com`; const bPw = `Pw!${Math.random().toString(36).slice(2)}Bb2`;
    const b = userBackend(); const bUser = await b.auth.signUp({ email: bEmail, password: bPw });
    if (!(await tokenOf(b))) await b.auth.signIn({ email: bEmail, password: bPw });
    const bl = await b._client.from("projects").select("*");
    const bList = bl.data || [];
    const leaked = bList.some((r) => r.id === proj.id);
    check(!leaked, `user B sees none of A's projects (B list: ${bList.length} rows) — denial = pass`);

    // ── cleanup ──────────────────────────────────────────────────────────────────────────────────
    section("CLEANUP");
    try { await backend._client.from("projects").delete().eq("id", proj.id); } catch {}
    try {
      await svcClient.from("credit_ledger").delete().eq("owner", owner);
      await svcClient.from("customers").delete().eq("owner", owner);
      const bOwner = bUser?.id; if (bOwner) await svcClient.from("credit_ledger").delete().eq("owner", bOwner);
    } catch (e) { info(`cleanup note: ${e.message}`); }
    info("removed test project + ledger/entitlement rows (test users remain in auth)");

  } catch (e) {
    bad(`threw: ${e.message}${e.payload ? " · " + JSON.stringify(e.payload) : ""}`);
  } finally {
    child.kill();
  }

  console.log(`\n${B}${fails === 0 ? G : R}${passes} passed, ${fails} failed${X}`);
  process.exit(fails === 0 ? 0 : 1);
}

main();
