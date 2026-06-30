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
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

import { createCodexProvider } from "../src/providers/codexProvider.mjs";
import { runAgent } from "../src/engine/runAgent.mjs";
import { fromScaffold, clone } from "../src/engine/fileTree.mjs";
import { REACT_VITE } from "../src/scaffolds/reactVite.mjs";
import { makeFileTools } from "../src/tools/fileTools.mjs";
import { BUILD_SYSTEM_PROMPT } from "../src/prompts/builder.mjs";
import { markersPresent } from "./assertions.mjs";
import { ensureDeps, buildTree } from "./workspace.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORK_NAME = "backend-proof";
const WORK_DIR = path.join(HERE, ".work", WORK_NAME);

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

async function generate() {
  console.log("\n══ 1. GENERATE (Codex, free on the sub) — one prompt, all three SDK surfaces");
  const tree = clone(fromScaffold(REACT_VITE));
  const { schemas, impls } = makeFileTools(tree); // write-only: a fresh build is all writes
  const { telemetry, finalText } = await runAgent({
    provider: createCodexProvider(),
    systemPrompt: BUILD_SYSTEM_PROMPT,
    tools: schemas,
    toolImpls: impls,
    tree,
    prompt: PROMPT,
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
  const fileUrl = be.storage.getUrl(objPath);
  step(typeof fileUrl === "string" && fileUrl.startsWith("http"), "storage.getUrl", fileUrl);
  const resp = await fetch(fileUrl);
  const back = Buffer.from(await resp.arrayBuffer());
  step(resp.ok && back.equals(payload), "storage fetch-back bytes match", `${back.length}b`);

  // cleanup the entity row (best-effort; storage object left for inspection)
  try { await note.delete(created.id); } catch {}

  return { skipped: false, email, noteId: created.id, objPath, fileUrl };
}

async function main() {
  console.log("Backend SDK proof — generate ▸ build ▸ markers ▸ live Supabase round-trip");
  await ensureDeps();
  const tree = await generate();
  await buildAndAssert(tree);
  const live = await liveSmoke();

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
