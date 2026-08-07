#!/usr/bin/env node

// Production-safe, zero-model proof fixture for the daily Builder V2 shadow checker.
// It uses fixed disposable principals and refuses to run without an explicit operator guard.

import assert from "node:assert/strict";

import { serviceClient } from "../shell/server/lib/supabase.mjs";
import { indexTree } from "../shell/server/lib/builderV2/indexer.mjs";
import { persistIndex, beginShadowRun } from "../shell/server/lib/builderV2/supabaseTwins.mjs";
import { validateShadowRun } from "../shell/server/lib/builderV2/shadow.mjs";
import { runShadowDriftCheck } from "./bv2-shadow-drift.mjs";

if (process.env.BV2_SHADOW_WINDOW_PROOF !== "1") {
  throw new Error("BV2_SHADOW_WINDOW_PROOF=1 is required");
}

const MODE = process.argv[2];
const OWNER = "93000000-0000-4000-8000-000000000001";
const PROJECT = "93000000-0000-4000-8000-000000000002";
const BUILD = "93000000-0000-4000-8000-000000000003";
const EMAIL = "bv2-shadow-window-proof@example.invalid";
const PASSWORD = "Disposable-Bv2-Shadow-Window-Proof!42";
const TREE = {
  "src/a.js": 'import { target } from "./b.js";\nexport function caller() { return target(); }\n',
  "src/b.js": "export function target() { return 1; }\n",
};
const db = serviceClient();

function unwrap(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}

async function cleanup() {
  unwrap(await db.from("bv2_shadow_checks").delete().eq("owner", OWNER), "cleanup checks");
  unwrap(await db.from("bv2_shadow_runs").delete().eq("owner", OWNER), "cleanup runs");
  unwrap(await db.from("bv2_file_revisions").delete().eq("owner", OWNER), "cleanup graph");
  unwrap(await db.from("bv2_migration_state").delete().eq("owner", OWNER), "cleanup state");
  unwrap(await db.from("build_jobs").delete().eq("owner", OWNER), "cleanup build");
  unwrap(await db.from("projects").delete().eq("owner", OWNER), "cleanup project");
  const deleted = await db.auth.admin.deleteUser(OWNER);
  if (deleted.error && !/not found/i.test(deleted.error.message)) throw deleted.error;
}

async function setupClean() {
  await cleanup();
  const created = await db.auth.admin.createUser({
    id: OWNER,
    email: EMAIL,
    password: PASSWORD,
    email_confirm: true,
  });
  if (created.error) throw created.error;
  unwrap(await db.from("projects").insert({ id: PROJECT, owner: OWNER, name: "BV2 shadow timer proof", tree: TREE }), "project setup");
  unwrap(await db.from("build_jobs").insert({
    id: BUILD,
    owner: OWNER,
    project_id: PROJECT,
    mode: "create",
    status: "complete",
    phase: "complete",
    server_id: "bv2-shadow-window-proof",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }), "build setup");
  const index = indexTree(TREE);
  await persistIndex(OWNER, PROJECT, index, { client: db });
  const shadowRunId = await beginShadowRun(OWNER, PROJECT, BUILD, index, { client: db });
  const validation = await validateShadowRun({ owner: OWNER, projectId: PROJECT, tree: TREE, shadowRunId, client: db });
  assert.equal(validation.status, "clean", JSON.stringify(validation.evidence.mismatches));
  const daily = await runShadowDriftCheck({ client: db, completionGraceMs: 0, log: () => {} });
  assert.equal(daily.clean, true, JSON.stringify(daily.evidence));
  return { shadowRunId, counts: validation.evidence.actualCounts };
}

if (MODE === "setup-clean") {
  console.log(JSON.stringify({ ok: true, mode: MODE, ...(await setupClean()) }));
} else if (MODE === "make-drift") {
  const { data: revisions, error } = await db.from("bv2_file_revisions")
    .select("id").eq("owner", OWNER).eq("project_id", PROJECT).order("path").limit(1);
  if (error || !revisions?.[0]) throw new Error(error?.message || "proof revision missing");
  const { data: symbols, error: symbolError } = await db.from("bv2_symbols")
    .select("id").eq("revision_id", revisions[0].id).limit(1);
  if (symbolError || !symbols?.[0]) throw new Error(symbolError?.message || "proof symbol missing");
  unwrap(await db.from("bv2_symbols").delete().eq("id", symbols[0].id), "inject missing symbol");
  console.log(JSON.stringify({ ok: true, mode: MODE, injected: "missing_symbol" }));
} else if (MODE === "make-missing") {
  unwrap(await db.from("bv2_shadow_runs").delete().eq("owner", OWNER).eq("project_id", PROJECT), "inject missing run");
  console.log(JSON.stringify({ ok: true, mode: MODE, injected: "missing_shadow_run" }));
} else if (MODE === "cleanup") {
  await cleanup();
  console.log(JSON.stringify({ ok: true, mode: MODE }));
} else {
  throw new Error("usage: prove-bv2-shadow-window.mjs setup-clean|make-drift|make-missing|cleanup");
}
