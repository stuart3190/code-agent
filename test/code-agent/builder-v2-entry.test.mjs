import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { createJob } from "../../shell/server/lib/buildJobs.mjs";
import { startAppBuildV2, startExistingAppWorkV2 } from "../../shell/server/lib/builderV2/entry.mjs";

test("accepted Builder V2 dispatch is durable-worker-only and returns handled:true", async () => {
  const calls = [];
  const project = { id: "project-1", name: "Test" };
  const client = {
    from(table) {
      assert.equal(table, "projects");
      return { insert: () => ({ select: () => ({ single: async () => ({ data: project, error: null }) }) }) };
    },
  };
  const diag = { id: "diag-1", recorderForJob: () => ({ sessionId: "diag-1" }) };
  const job = { id: "job-1", projectId: project.id, status: "queued", phase: "queued", subscribers: new Set() };
  const ctx = {
    owner: "owner-1", conversation: { id: "conversation-1", product_id: null },
    conversations: { upsertProduct: async () => null, updateConversation: async () => {}, appendTurn: async () => {} },
    emit: async () => {},
  };
  const accepted = await startAppBuildV2(ctx, { description: "Build a contact app", productName: null }, {
    deps: {
      client,
      resolveBuildContext: async () => ({ byok: true }),
      budgetLedger: () => ({ getBalance: async () => ({ total: 60 }) }),
      startDiagSessionSafe: async () => diag,
      workerEnabled: () => true,
      createJob: async (input) => { calls.push(input); return { job }; },
    },
  });
  assert.equal(accepted.handled, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pipelineVersion, "v2");
  assert.deepEqual(calls[0].providerSelection, { provider: "unknown", billingLane: "byok_api", manualModel: null });
});

test("createJob refuses V2 before writing when worker dispatch is disabled", async () => {
  const prior = process.env.THRALLO_BUILD_WORKER_ENABLED;
  process.env.THRALLO_BUILD_WORKER_ENABLED = "0";
  try {
    await assert.rejects(createJob({
      owner: { id: "owner" }, projectId: "project", mode: "build", prompt: "x", pipelineVersion: "v2",
    }), (error) => error.code === "worker_required");
  } finally {
    if (prior === undefined) delete process.env.THRALLO_BUILD_WORKER_ENABLED;
    else process.env.THRALLO_BUILD_WORKER_ENABLED = prior;
  }
});

test("new V2 build refuses before creating a project when the worker is disabled", async () => {
  let inserted = false;
  const ctx = {
    owner: "owner-1", conversation: { id: "conversation-1", product_id: null },
    conversations: {}, emit: async () => {},
  };
  await assert.rejects(startAppBuildV2(ctx, { description: "x" }, {
    deps: {
      workerEnabled: () => false,
      client: { from: () => { inserted = true; throw new Error("must not write"); } },
    },
  }), (error) => error.code === "worker_required");
  assert.equal(inserted, false);
});

test("existing V2 work refuses before creating diagnostics when the worker is disabled", async () => {
  let diagnosticsStarted = false;
  await assert.rejects(startExistingAppWorkV2({ owner: "owner", conversation: { id: "conversation" } }, {
    project: { id: "project" }, request: "repair it",
  }, { deps: {
    workerEnabled: () => false,
    startDiagSessionSafe: async () => { diagnosticsStarted = true; },
  } }), (error) => error.code === "worker_required");
  assert.equal(diagnosticsStarted, false);
});

test("the accepted V2 capability path has no handled:false fallback", async () => {
  const [entry, capabilities] = await Promise.all([
    readFile(new URL("../../shell/server/lib/builderV2/entry.mjs", import.meta.url), "utf8"),
    readFile(new URL("../../shell/server/lib/capabilities/coreCapabilities.mjs", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(entry, /handled:\s*false/);
  assert.match(capabilities, /if \(!shadow\.handled\) throw/);
  assert.doesNotMatch(capabilities, /eligible owner declined/);
});

test("runtime composition migration preserves V1 defaults and adds explicit V2 links", async () => {
  const sql = await readFile(new URL("../../supabase/migrations/20260807221000_bv2_runtime_composition.sql", import.meta.url), "utf8");
  assert.match(sql, /pipeline_version text not null default 'v1'/i);
  assert.match(sql, /builder_version text not null default 'v1'/i);
  assert.match(sql, /bv2_green_snapshot_id uuid/i);
  assert.match(sql, /bv2_builds_project_owner_fkey/i);
  assert.match(sql, /build_jobs_bv2_build_owner_project_fkey/i);
  assert.match(sql, /build_jobs_diag_run_owner_project_fkey/i);
  assert.match(sql, /projects_bv2_green_snapshot_owner_fkey/i);
  assert.match(sql, /bv2_retrieval_traces_build_owner_fkey/i);
  assert.match(sql, /bv2_verification_cache_snapshot_owner_project_fkey/i);
  assert.match(sql, /build_jobs_one_active_project_idx[\s\S]*where status in \('queued', 'running'\)/i);
  assert.doesNotMatch(sql, /one_active_v2_project/i,
    "V1 and V2 must not run concurrently for the same project during cutover");
  assert.doesNotMatch(sql, /add constraint projects_id_owner_unique/i,
    "the already-applied C4 constraint must not be recreated");
});

test("the worker durably marks a V2 public lifecycle running before pipeline execution", async () => {
  const worker = await readFile(new URL("../../build-worker/index.mjs", import.meta.url), "utf8");
  assert.match(worker, /job\.job_type === "builder_pipeline"[\s\S]*status: "running", phase: "running"/);
  assert.match(worker, /public build start persistence/);
  assert.match(worker, /worker evidence persistence failed/);
  assert.match(worker, /await eventChain;[\s\S]*if \(eventFailure\) throw eventFailure;[\s\S]*queue\.complete/,
    "completion must wait for durable stdout/stderr evidence");
});
