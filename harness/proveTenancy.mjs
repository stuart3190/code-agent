// Phase 3.1 tenancy proof — proves per-END-USER ISOLATION, not just access. Opt-in,
// creds-required, NOT part of the regression CASES (spends a tiny bit of Supabase free-tier
// quota: two signups + a handful of small CRUD/storage ops).
//
// The 3.0 proof (proveBackend.mjs) showed ONE user can round-trip data. That ran under a
// permissive "authenticated = full access" policy, so it could NOT have caught cross-tenant
// leakage. This proof closes that: with owner-scoped RLS on `entities` and path-scoped RLS on a
// PRIVATE `uploads` bucket, user B must be unable to see, read, or mutate user A's data — while
// A's own access keeps working. The DENIAL is the pass condition.
//
//   1. SETUP   two INDEPENDENT backend instances (= two independent auth sessions in one process);
//              A and B each signUp + signIn (normal anon flow — NO service_role key).
//   2. ACCESS  A creates an entity + uploads a file, and reads both back (legitimate use works).
//   3. ISOLATE B queries the same table/bucket and CANNOT see or read A's entity or file.
//   4. IMMUTABLE B cannot update or delete A's entity (RLS denies silently -> verify via A re-read).
//   5. CLEANUP A removes its own row + object (best-effort).
//
// Uses the PURE factory (createSupabaseBackend({url,anonKey})) — the exact code path the app
// ships, env-wired for Node. Its bare `@supabase/supabase-js` import resolves from the work dir's
// junctioned node_modules (set up by buildTree, same trick as proveBackend.mjs).
//
//   Run:  $env:SUPABASE_URL=...; $env:SUPABASE_ANON_KEY=...; node harness/proveTenancy.mjs
//   Without creds it exits early (nothing to prove offline — isolation is a live property).

import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { fromScaffold, clone } from "../src/engine/fileTree.mjs";
import { REACT_VITE } from "../src/scaffolds/reactVite.mjs";
import { ensureDeps, buildTree } from "./workspace.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORK_NAME = "tenancy-proof";
const WORK_DIR = path.join(HERE, ".work", WORK_NAME);

let fails = 0;
const step = (ok, label, detail = "") => {
  if (!ok) fails++;
  console.log(`   ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

// A signed-in backend for one user, built from the generated app's OWN factory.
async function makeUser(createSupabaseBackend, url, anonKey, tag) {
  const be = createSupabaseBackend({ url, anonKey });
  const email = `${tag}+${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const password = `Pw-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  await be.auth.signUp({ email, password });
  const user = await be.auth.signIn({ email, password });
  if (!user?.id) {
    throw new Error(
      `${tag}: signIn returned no session — is Auth "Confirm email" disabled on the project?`
    );
  }
  return { be, email, uid: user.id };
}

async function main() {
  console.log("Tenancy proof — owner/path-scoped RLS: A's access works ▸ B is fully isolated");

  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    console.log(
      "\n  SKIPPED — set SUPABASE_URL and SUPABASE_ANON_KEY (anon public key only) to run.\n" +
        "  Isolation is a live DB property; there is nothing to assert offline."
    );
    process.exit(0);
  }

  // Flush the scaffold + junction node_modules so the factory's @supabase import resolves.
  await ensureDeps();
  const build = await buildTree(clone(fromScaffold(REACT_VITE)), WORK_NAME);
  if (!build.ok) throw new Error("scaffold failed to build — cannot stage the SDK factory");
  const factoryUrl = pathToFileURL(
    path.join(WORK_DIR, "src", "lib", "backend", "supabaseBackend.js")
  );
  const { createSupabaseBackend } = await import(factoryUrl.href);

  console.log("\n══ 1. SETUP — two independent users (A, B), normal signUp/signIn, no service_role");
  const A = await makeUser(createSupabaseBackend, url, anonKey, "a");
  const B = await makeUser(createSupabaseBackend, url, anonKey, "b");
  step(!!A.uid && !!B.uid && A.uid !== B.uid, "two distinct authed users", `A=${A.uid.slice(0, 8)}… B=${B.uid.slice(0, 8)}…`);

  const noteA = A.be.db.entity("note");
  const noteB = B.be.db.entity("note");
  const TITLE = "A's private note";

  console.log("\n══ 2. ACCESS — A creates + reads its own entity and file (legitimate use still works)");
  const created = await noteA.create({ title: TITLE, body: "owned by A only" });
  step(!!created?.id && created.owner === A.uid, "A db.entity.create (owner = A)", created?.id);

  const aList = await noteA.list();
  step(!!aList.find((r) => r.id === created.id), "A list() reads its own note back", `${aList.length} note(s)`);
  const aGet = await noteA.get(created.id);
  step(aGet?.data?.title === TITLE, "A get() reads its own note back");

  const payload = Buffer.from(`A-secret-bytes-${Date.now()}`);
  const { path: objPath } = await A.be.storage.upload(payload, "doc.txt");
  step(!!objPath && objPath.startsWith(`${A.uid}/`), "A storage.upload (namespaced under A's uid)", objPath);
  const aUrl = await A.be.storage.getUrl(objPath);
  const aResp = await fetch(aUrl);
  const aBack = Buffer.from(await aResp.arrayBuffer());
  step(aResp.ok && aBack.equals(payload), "A signed-URL fetch-back bytes match", `${aBack.length}b`);

  console.log("\n══ 3. ISOLATE — B queries the SAME table/bucket and cannot see or read A's data");
  const bList = await noteB.list();
  step(!bList.some((r) => r.id === created.id), "B list() does NOT contain A's note", `B sees ${bList.length} note(s)`);

  let bGetBlocked = false;
  try {
    const r = await noteB.get(created.id);
    bGetBlocked = !r; // RLS-filtered single() normally throws; null would also be a denial
  } catch {
    bGetBlocked = true;
  }
  step(bGetBlocked, "B get(A's id) is blocked (no row returned)");

  // Storage: B lists A's folder, downloads A's object, and tries to sign it — all via the raw
  // client (the surface a real attacker would use). Every one must be denied/empty.
  const sB = B.be._client.storage.from("uploads");
  const bFolder = await sB.list(A.uid);
  const bFolderEmpty = !bFolder.error && Array.isArray(bFolder.data) && bFolder.data.length === 0;
  step(bFolderEmpty || !!bFolder.error, "B cannot list A's storage folder", `${bFolder.data?.length ?? "err"} entr(ies)`);

  const bDownload = await sB.download(objPath);
  step(!!bDownload.error || !bDownload.data, "B cannot download A's object");

  let bSignBlocked = false;
  try {
    await B.be.storage.getUrl(objPath); // createSignedUrl on an unseen object must fail
  } catch {
    bSignBlocked = true;
  }
  step(bSignBlocked, "B cannot mint a signed URL for A's object");

  console.log("\n══ 4. IMMUTABLE — B cannot update or delete A's entity (verified by A re-reading)");
  let bUpdate;
  try {
    bUpdate = await noteB.update(created.id, { title: "HACKED BY B", body: "owned by B now" });
  } catch {
    bUpdate = undefined; // a throw is also a denial
  }
  step(!bUpdate, "B update(A's id) affects 0 rows (no row returned)");

  try { await noteB.delete(created.id); } catch {}
  // The decisive checks: A's data is byte-for-byte intact and still present.
  const afterMutate = await noteA.get(created.id);
  step(afterMutate?.data?.title === TITLE, "A's note title UNCHANGED after B's update attempt", afterMutate?.data?.title);
  step(!!afterMutate?.id, "A's note STILL EXISTS after B's delete attempt");

  console.log("\n══ 5. CLEANUP (best-effort)");
  try { await noteA.delete(created.id); } catch {}
  try { await A.be._client.storage.from("uploads").remove([objPath]); } catch {}
  console.log("   removed A's note + object");

  console.log("\n══ RESULT");
  if (fails === 0) {
    console.log("  ALL GREEN — isolation holds (B reached none of A's data) AND A's own access works.");
    console.log(`  evidence: A=${A.email} owns note ${created.id} + ${objPath}; B saw/changed nothing.`);
    process.exit(0);
  }
  console.log(`  ${fails} assertion(s) FAILED — isolation is NOT proven. See FAILs above.`);
  process.exit(1);
}

main().catch((e) => {
  console.error("\nPROOF ERRORED:", e?.message || e);
  process.exit(1);
});
