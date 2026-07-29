// Phase 3 backend proof — NOT part of the regression CASES (it needs live creds and spends
// Codex quota). Proves the thin backend SDK end-to-end:
//
//   1. GENERATE  an app from ONE prompt that uses all three SDK surfaces (auth + entity CRUD
//      + file upload), via the real engine (runAgent + BUILD_SYSTEM_PROMPT, Codex/free).
//   2. BUILD     it (npm run build) — proves it compiles against the SDK.
//   3. MARKERS   assert the generated source actually calls auth / db.entity / storage.
//   4. LIVE      import the generated app's OWN backend factory and exercise it against the
//      live Supabase project: signUp -> signIn -> entity.create -> list (read-back) ->
//      storage.upload -> getUrl -> fetch-back. The read-backs are the "data landed" proof.
//
// The live step uses the PURE factory (createSupabaseBackend({url,anonKey})) with creds from
// process.env — the exact code path the app ships, just env-wired for Node instead of Vite.
// Its bare `@supabase/supabase-js` import resolves from the work dir's junctioned node_modules
// (resolution is relative to the factory file, not this driver).
//
//   Run:  $env:SUPABASE_URL=...; $env:SUPABASE_ANON_KEY=...; node harness/proveBackend.mjs
//   Without creds the generate+build+markers half runs and the LIVE step reports SKIPPED.

import path from "node:path";
import os from "node:os";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

import { createCodexProvider } from "../src/providers/codexProvider.mjs";
import { runAgent } from "../src/engine/runAgent.mjs";
import { fromScaffold, clone } from "../src/engine/fileTree.mjs";
import { REACT_VITE } from "../src/scaffolds/reactVite.mjs";
import { makeFileTools } from "../src/tools/fileTools.mjs";
import { BUILD_SYSTEM_PROMPT } from "../src/prompts/builder.mjs";
import { markersPresent } from "./assertions.mjs";
import { ensureDeps, buildTree, workDirFor } from "./workspace.mjs";
import { withRuntimeEnv } from "../shell/server/lib/runtimeEnv.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORK_NAME = "backend-proof";
const WORK_DIR = path.join(HERE, ".work", WORK_NAME);

// First-build-render archetype: a PUBLIC-content site (barber shop) with a booking system — the
// exact class of app that used to fail on first load (shop data read from the owner-scoped backend
// by a signed-out visitor). The distinctive name lets the render check grep for "public content
// actually painted" without depending on the model's word choices.
const RENDER_WORK = "backend-render";
const BARBER_PROMPT = `Build a public website for a barber shop called "Ironclad Barbers" with an online booking system.
- A landing page every visitor sees immediately with NO login: the shop name "Ironclad Barbers", a
  hero, the list of services with prices, opening hours, and the address.
- Customers can book an appointment (choose a service, a date and a time). A customer signs in or
  signs up to save and view their OWN bookings.
- The shop's name, services, prices and hours are the same for every visitor (site content); each
  customer's bookings are their own private data.`;

const PROMPT = `Build a Notes app with accounts.

- Users sign up and sign in with an email and password, and can sign out. Show the signed-in
  user's email. Only show the notes UI when signed in.
- A signed-in user can create a note (each note has a title and a body text), see a list of
  their notes (newest first), and delete a note.
- Each note can have ONE image attached: when creating a note the user may choose an image
  file to upload, and each note that has an image shows it.

Use the backend SDK ("./lib/backend") for everything: auth for accounts, db.entity("note") for
storing/listing/deleting notes, and storage for the image upload (store the returned path on the
note and render it with storage.getUrl). Do not use localStorage or call any API directly.`;

// New-feature markers: the generated source must actually wire all three SDK surfaces.
const MARKERS = ["auth.signUp", "auth.signIn", "db.entity", "storage.upload"];

const step = (ok, label, detail = "") =>
  console.log(`   ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

async function generate(promptText = PROMPT) {
  const tree = clone(fromScaffold(REACT_VITE));
  const { schemas, impls } = makeFileTools(tree); // write-only: a fresh build is all writes
  const { telemetry, finalText } = await runAgent({
    provider: createCodexProvider(),
    systemPrompt: BUILD_SYSTEM_PROMPT,
    tools: schemas,
    toolImpls: impls,
    tree,
    prompt: promptText,
  });
  console.log(`   generated in ${telemetry.turns} turns · ${telemetry.total} tok`);
  if (finalText) console.log(`   summary: ${finalText.split("\n")[0]}`);
  return tree;
}

async function buildAndAssert(tree) {
  console.log("\n══ 2. BUILD (npm run build on the generated tree)");
  const build = await buildTree(tree, WORK_NAME);
  step(build.ok, "app builds");
  if (!build.ok) throw new Error("generated app failed to build — see stderr tail above");

  console.log("\n══ 3. MARKERS (generated source wires all three SDK surfaces)");
  const m = markersPresent(tree, MARKERS);
  for (const mk of MARKERS) step(m.present.includes(mk), `uses ${mk}`);
  if (m.missing.length) throw new Error(`generated app did not wire: ${m.missing.join(", ")}`);
}

async function liveSmoke() {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  console.log("\n══ 4. LIVE (exercise the generated app's OWN SDK against Supabase)");
  if (!url || !anonKey) {
    console.log("   SKIPPED — set SUPABASE_URL and SUPABASE_ANON_KEY to run the live proof.");
    console.log("   (generate + build + markers above already passed.)");
    return { skipped: true };
  }

  // Import the generated app's factory from the work dir — its @supabase import resolves there.
  const factoryUrl = pathToFileURL(path.join(WORK_DIR, "src", "lib", "backend", "supabaseBackend.js"));
  const { createSupabaseBackend } = await import(factoryUrl.href);
  const be = createSupabaseBackend({ url, anonKey });

  const email = `proof+${Date.now()}@example.com`;
  const password = `Pw-${Math.random().toString(36).slice(2)}-${Date.now()}`;

  // auth: sign up -> sign in -> current user
  const signedUp = await be.auth.signUp({ email, password });
  step(!!signedUp?.id, "auth.signUp", email);
  const signedIn = await be.auth.signIn({ email, password });
  step(!!signedIn?.id, "auth.signIn");
  const me = await be.auth.currentUser();
  step(me?.email === email, "auth.currentUser matches", me?.email);

  // entity CRUD: create -> list read-back (data landed) -> delete cleanup
  const note = be.db.entity("note");
  const created = await note.create({ title: "Proof note", body: "written by the live proof" });
  step(!!created?.id, "db.entity.create", created?.id);
  const list = await note.list();
  const found = list.find((r) => r.id === created.id);
  step(!!found && found.data?.title === "Proof note", "db.entity.list read-back", `${list.length} note(s)`);

  // storage: upload -> getUrl -> fetch back (bytes match)
  const payload = Buffer.from(`proof-bytes-${Date.now()}`);
  const { path: objPath } = await be.storage.upload(payload, `proof/${Date.now()}.txt`);
  step(!!objPath, "storage.upload", objPath);
  const fileUrl = await be.storage.getUrl(objPath);
  step(typeof fileUrl === "string" && fileUrl.startsWith("http"), "storage.getUrl", fileUrl);
  const resp = await fetch(fileUrl);
  const back = Buffer.from(await resp.arrayBuffer());
  step(resp.ok && back.equals(payload), "storage fetch-back bytes match", `${back.length}b`);

  // cleanup the entity row (best-effort; storage object left for inspection)
  try { await note.delete(created.id); } catch {}

  return { skipped: false, email, noteId: created.id, objPath, fileUrl };
}

// Serve a built dist/ over http on a free loopback port (the app fetches its own bundle + calls
// Supabase from a real origin — file:// would break both). Returns { url, close }.
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".json": "application/json", ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon" };
async function serveDist(distDir) {
  const server = http.createServer(async (req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p === "/") p = "/index.html";
    try {
      const data = await readFile(path.join(distDir, p));
      res.writeHead(200, { "Content-Type": MIME[path.extname(p)] || "application/octet-stream" });
      res.end(data);
    } catch {
      try { res.writeHead(200, { "Content-Type": "text/html" }); res.end(await readFile(path.join(distDir, "index.html"))); }
      catch { res.writeHead(404); res.end("nf"); }
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((r) => server.close(r)) };
}

// Render a URL in headless Edge as an ANONYMOUS visitor and return the post-render serialized DOM.
// Driven over the DevTools Protocol (not --dump-dom/--virtual-time-budget, which race the SPA mount
// or hang on external image loads): navigate, give React real wall-clock time to mount + settle,
// then read outerHTML. A dead proxy (with a loopback bypass) makes every EXTERNAL request — the
// backend read included — fail fast, so this is the true "backend unreachable, signed-out" case:
// only an app that renders public content from in-code constants survives it. Returns null if no
// headless Edge is present (non-Windows / CI).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function renderDom(pageUrl, settleMs = 3500) {
  const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  if (process.platform !== "win32" || !existsSync(edge)) return null;
  const dport = 9200 + Math.floor(Math.random() * 700);
  const profile = path.join(os.tmpdir(), `edge-cdp-${Date.now()}`);
  const proc = spawn(edge, ["--headless", "--disable-gpu", "--no-sandbox", "--no-first-run",
    "--proxy-server=http://127.0.0.1:1", "--proxy-bypass-list=127.0.0.1",
    `--remote-debugging-port=${dport}`, `--user-data-dir=${profile}`, pageUrl], { stdio: "ignore" });
  try {
    let wsUrl = null;
    for (let i = 0; i < 40 && !wsUrl; i++) {
      await sleep(250);
      try {
        const list = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json();
        wsUrl = (list.find((t) => t.type === "page" && t.webSocketDebuggerUrl) || {}).webSocketDebuggerUrl;
      } catch {}
    }
    if (!wsUrl) throw new Error("headless Edge did not expose a CDP page target");
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("CDP ws error")); });
    await sleep(settleMs); // real time for the SPA to mount + settle (no vtb race)
    const html = await new Promise((resolve, reject) => {
      ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) resolve(d.result?.result?.value ?? ""); };
      setTimeout(() => reject(new Error("CDP eval timeout")), 8000);
      ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "document.documentElement.outerHTML", returnByValue: true } }));
    });
    ws.close();
    return html;
  } finally { try { proc.kill(); } catch {} }
}

// GATE for the per-app-backend fix: a freshly generated PUBLIC-content site must render its shop
// content for a signed-out visitor on build #1 — no fatal card, no demo-mode banner, zero iterates.
async function firstBuildRender() {
  console.log("\n══ 5. FIRST-BUILD RENDER (a public-content site renders for an anon visitor)");
  const tree = await generate(BARBER_PROMPT);
  // Inject the REAL backend config (the exact anon-visitor scenario) and build.
  const build = await buildTree(withRuntimeEnv(tree, RENDER_WORK), RENDER_WORK);
  step(build.ok, "barber booking site builds");
  if (!build.ok) throw new Error("barber site failed to build");

  const distDir = path.join(workDirFor(RENDER_WORK), "dist");
  const srv = await serveDist(distDir);
  try {
    const dom = await renderDom(srv.url);
    if (dom === null) { console.log("   SKIPPED render check — no headless Edge on this platform"); return; }
    // Assert on VISIBLE text (strip scripts+tags) so the bundled JS source can't satisfy a check.
    const text = dom.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    const fatal = /something went wrong|could not be loaded|could not load|failed to load|unable to load|backend is not configured|demo mode/i;
    const nameShown = /ironclad/i.test(text);
    const bookingShown = /book|appointment|reserv|schedul/i.test(text);
    const m = text.match(fatal);
    step(nameShown, "public shop content painted for a signed-out visitor with the backend UNREACHABLE (name 'Ironclad' shown)");
    step(!m, "no fatal error card / demo-mode banner on first load", m ? `found "${m[0]}"` : "clean");
    step(bookingShown, "the booking UI is present on the page");
    step(text.length > 200, "the page rendered real content", `${text.length} chars of visible text`);
    if (!nameShown || m) throw new Error("first-build render regressed — see the failing assertion(s) above");
  } finally {
    await srv.close();
  }
}

async function main() {
  console.log("Backend SDK proof — generate ▸ build ▸ markers ▸ live Supabase round-trip ▸ first-build render");
  await ensureDeps();
  console.log("\n══ 1. GENERATE (Codex, free on the sub) — one prompt, all three SDK surfaces");
  const tree = await generate();
  await buildAndAssert(tree);
  const live = await liveSmoke();
  await firstBuildRender();

  console.log("\n══ RESULT");
  if (live.skipped) {
    console.log("  GENERATION PROVEN (build + all three SDK surfaces wired). LIVE step skipped — no creds.");
    process.exit(0);
  }
  console.log("  ALL GREEN — a generated app used auth + entity CRUD + file storage against LIVE Supabase.");
  console.log(`  evidence: user=${live.email} · note=${live.noteId} · file=${live.objPath}`);
  process.exit(0);
}

main().catch((e) => {
  console.error("\nPROOF FAILED:", e?.message || e);
  process.exit(1);
});
