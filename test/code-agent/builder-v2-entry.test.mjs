import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { createJob, executeBuildPipelineWork } from "../../shell/server/lib/buildJobs.mjs";
import { startAppBuildV2, startExistingAppWorkV2 } from "../../shell/server/lib/builderV2/entry.mjs";

test("accepted Builder V2 dispatch is durable-worker-only and returns handled:true", async () => {
  const calls = [];
  const project = { id: "project-1", name: "Test" };
  let projectInput = null;
  const client = {
    from(table) {
      assert.equal(table, "projects");
      return { insert: (input) => {
        projectInput = input;
        return { select: () => ({ single: async () => ({ data: project, error: null }) }) };
      } };
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
      requireWorkerAdmission: async () => ({ workerId: "worker-1" }),
      createJob: async (input) => { calls.push(input); return { job }; },
    },
  });
  assert.equal(accepted.handled, true);
  assert.equal(projectInput.builder_version, "v2", "a queued project is V2-owned before its first green snapshot");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pipelineVersion, "v2");
  assert.deepEqual(calls[0].providerSelection, { provider: "unknown", billingLane: "byok_api", manualModel: null });
});

test("new V2 build requires a fresh compatible worker before creating a project", async () => {
  let inserted = false;
  const ctx = {
    owner: "owner-1", conversation: { id: "conversation-1", product_id: null },
    conversations: {}, emit: async () => {},
  };
  await assert.rejects(startAppBuildV2(ctx, { description: "x" }, { deps: {
    workerEnabled: () => true,
    requireWorkerAdmission: async () => {
      throw Object.assign(new Error("stale"), { code: "worker_version_mismatch" });
    },
    client: { from: () => { inserted = true; throw new Error("must not write"); } },
  } }), (error) => error.code === "worker_version_mismatch");
  assert.equal(inserted, false);
});

test("advanced V2 builds pause for an explicit durable budget approval before project creation", async () => {
  let inserted = false;
  const events = [];
  const approval = { approvalId: "approval-1", complexity: "advanced", ceilingCredits: 60, status: "pending" };
  const result = await startAppBuildV2({
    owner: "owner-1", conversation: { id: "conversation-1", product_id: null },
    conversations: {}, emit: async (type, payload) => events.push({ type, payload }),
  }, { description: "Build a collaborative IDE with a Monaco code editor and node graph" }, { deps: {
    workerEnabled: () => true,
    requireWorkerAdmission: async () => ({ workerId: "worker-1" }),
    resolveBuildContext: async () => ({ byok: true }),
    client: { from: () => { inserted = true; throw new Error("must not write a project"); } },
    approvalStore: { create: async () => approval },
  } });
  assert.equal(inserted, false);
  assert.equal(result.result.waitingForApproval, true);
  assert.deepEqual(events, [{ type: "budget_approval_required", payload: approval }]);
});

test("a configured advanced ceiling can request a larger explicitly approved budget", async () => {
  const prior = process.env.THRALLO_BV2_MAX_APPROVED_BUILD_CEILING;
  process.env.THRALLO_BV2_MAX_APPROVED_BUILD_CEILING = "120";
  let requestedCeiling = null;
  try {
    await startAppBuildV2({
      owner: "owner-1", conversation: { id: "conversation-1", product_id: null },
      conversations: {}, emit: async () => {},
    }, { description: "Build a collaborative IDE with a Monaco code editor and node graph" }, { deps: {
      workerEnabled: () => true,
      requireWorkerAdmission: async () => ({ workerId: "worker-1" }),
      resolveBuildContext: async () => ({ byok: true }),
      client: { from: () => { throw new Error("must not write a project"); } },
      approvalStore: { create: async (_owner, _conversation, _input, options) => {
        requestedCeiling = options.ceilingCredits;
        return { approvalId: "approval", status: "pending", ceilingCredits: options.ceilingCredits };
      } },
    } });
    assert.equal(requestedCeiling, 120);
  } finally {
    if (prior === undefined) delete process.env.THRALLO_BV2_MAX_APPROVED_BUILD_CEILING;
    else process.env.THRALLO_BV2_MAX_APPROVED_BUILD_CEILING = prior;
  }
});

test("an approved advanced request consumes once and automatically creates one durable V2 job", async () => {
  const events = [];
  const calls = { consume: 0, createJob: 0, attach: 0 };
  const project = { id: "project-approved", name: "Advanced" };
  const approvalStore = {
    async consume(_owner, id, match) {
      calls.consume += 1;
      assert.equal(id, "approval-advanced");
      assert.equal(match.conversationId, "conversation-1");
      return { approvalId: id, status: "consumed", ceilingCredits: 60 };
    },
    async attachDispatch(_owner, id, dispatch) {
      calls.attach += 1;
      assert.equal(id, "approval-advanced");
      assert.deepEqual(dispatch, { projectId: project.id, jobId: "job-approved" });
    },
  };
  const client = {
    from(table) {
      assert.equal(table, "projects");
      return { insert: (input) => {
        assert.equal(input.budget_approval_id, "approval-advanced");
        return { select: () => ({ single: async () => ({ data: project, error: null }) }) };
      } };
    },
  };
  const result = await startAppBuildV2({
    owner: "owner-1", conversation: { id: "conversation-1", product_id: null },
    conversations: {}, emit: async (type, payload) => events.push({ type, payload }),
  }, { description: "Build a collaborative IDE with a Monaco code editor and node graph" }, {
    approvalId: "approval-advanced",
    deps: {
      client, approvalStore,
      workerEnabled: () => true,
      requireWorkerAdmission: async () => ({ workerId: "worker-1" }),
      resolveBuildContext: async () => ({ byok: true }),
      startDiagSessionSafe: async () => ({ id: "diag-approved", recorderForJob: () => ({ sessionId: "diag-approved" }) }),
      createJob: async (input) => {
        calls.createJob += 1;
        assert.equal(input.budgetApprovalId, "approval-advanced");
        return { job: { id: "job-approved", projectId: project.id, subscribers: new Set() }, existing: false };
      },
    },
  });
  assert.equal(result.result.jobId, "job-approved");
  assert.deepEqual(calls, { consume: 1, createJob: 1, attach: 1 });
  assert.deepEqual(events.map((event) => event.type), ["build_started", "budget_approval_resolved"]);
  assert.equal(events[1].payload.status, "consumed");
});

test("a consumed large-build approval reopens when dispatch fails before any durable job exists", async () => {
  const approval = { approvalId: "approval-1", complexity: "advanced", ceilingCredits: 60, status: "consumed" };
  const reopened = [];
  let projectInput = null;
  const approvalStore = {
    consume: async () => approval,
    reopen: async (owner, id) => { reopened.push({ owner, id }); return { ...approval, status: "approved" }; },
  };
  const ctx = {
    owner: "owner-1", conversation: { id: "conversation-1", product_id: null },
    conversations: {}, emit: async () => {},
  };
  await assert.rejects(startAppBuildV2(ctx, {
    description: "Build a collaborative IDE with a Monaco code editor and node graph",
  }, {
    approvalId: approval.approvalId,
    deps: {
      workerEnabled: () => true,
      requireWorkerAdmission: async () => ({ workerId: "worker-1" }),
      resolveBuildContext: async () => ({ byok: true }),
      approvalStore,
      client: {
        from(table) {
          assert.equal(table, "projects");
          return { insert: (input) => { projectInput = input; return ({ select: () => ({ single: async () => ({
            data: null, error: { message: "database unavailable" },
          }) }) }); } };
        },
      },
    },
  }), /project creation failed/);
  assert.equal(projectInput.budget_approval_id, "approval-1",
    "a crash after project insert remains traceable to the consumed approval");
  assert.deepEqual(reopened, [{ owner: "owner-1", id: "approval-1" }]);
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

test("public-job creation and worker execution reject every non-V2 pipeline before durable work", async () => {
  await assert.rejects(createJob({
    owner: { id: "owner" }, projectId: "project", mode: "build", prompt: "x", pipelineVersion: "v1",
  }), (error) => error.code === "builder_v1_retired");
  await assert.rejects(createJob({
    owner: { id: "owner" }, projectId: "project", mode: "build", prompt: "x",
  }), (error) => error.code === "builder_v1_retired");
  await assert.rejects(executeBuildPipelineWork({
    id: "work", owner: "owner", project_id: "project", build_id: "build", payload: {},
  }), (error) => error.code === "builder_v1_retired" && error.retryable === false);
});

test("worker execution rechecks the V2 kill switch before runtime composition", async () => {
  const prior = process.env.THRALLO_BV2_KILL;
  process.env.THRALLO_BV2_KILL = "1";
  try {
    await assert.rejects(executeBuildPipelineWork({
      id: "work", owner: "owner", project_id: "project", build_id: "build",
      payload: { pipelineVersion: "v2" },
    }), (error) => error.code === "builder_v2_killed" && error.retryable === false);
  } finally {
    if (prior === undefined) delete process.env.THRALLO_BV2_KILL;
    else process.env.THRALLO_BV2_KILL = prior;
  }
});

test("V2-only kill switch refuses before worker admission or project creation", async () => {
  let touched = false;
  const ctx = {
    owner: "owner-1", conversation: { id: "conversation-1", product_id: null },
    conversations: {}, emit: async () => {},
  };
  await assert.rejects(startAppBuildV2(ctx, { description: "x" }, {
    env: { THRALLO_BV2_KILL: "1" },
    deps: {
      workerEnabled: () => { touched = true; return true; },
      client: { from: () => { touched = true; throw new Error("must not write"); } },
    },
  }), (error) => error.code === "builder_v2_killed");
  assert.equal(touched, false);
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
  assert.match(capabilities, /startAppBuildV2\(ctx, input\)/);
  assert.doesNotMatch(capabilities, /v2BuildEligible|startAppBuild\(|repairApp\(/);
});

test("runtime composition migration preserves V1 defaults and adds explicit V2 links", async () => {
  const sql = await readFile(new URL("../../supabase/migrations/20260807221000_bv2_runtime_composition.sql", import.meta.url), "utf8");
  assert.match(sql, /pipeline_version text not null default 'v1'/i);
  assert.match(sql, /project_id_text text generated always as \(project_id::text\) stored/i);
  assert.match(sql, /builder_version text not null default 'v1'/i);
  assert.match(sql, /bv2_green_snapshot_id uuid/i);
  assert.match(sql, /bv2_builds_project_owner_fkey/i);
  assert.match(sql, /build_jobs_bv2_build_owner_project_fkey/i);
  assert.match(sql, /build_jobs_diag_run_owner_project_fkey/i);
  assert.match(sql, /foreign key \(bv2_build_id, owner, project_id\)[\s\S]*references public\.bv2_builds\(id, owner, project_id_text\)/i);
  assert.match(sql, /foreign key \(diag_run_id, owner, project_id\)[\s\S]*references public\.diag_runs\(id, owner, project_id_text\)/i);
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
