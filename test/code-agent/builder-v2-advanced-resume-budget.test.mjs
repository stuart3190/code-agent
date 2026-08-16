import { test } from "node:test";
import assert from "node:assert/strict";

import { startExistingAppWorkV2 } from "../../shell/server/lib/builderV2/entry.mjs";

const query = (rows, record = () => {}) => {
  const chain = {
    select: (columns) => { record("select", columns); return chain; },
    eq: () => chain, in: () => chain,
    order: (column, options) => { record("order", { column, options }); return chain; },
    limit: () => chain,
    maybeSingle: async () => ({ data: Array.isArray(rows) ? rows[0] || null : rows, error: null }),
    then(resolve, reject) { return Promise.resolve({ data: Array.isArray(rows) ? rows : [rows], error: null }).then(resolve, reject); },
  };
  return chain;
};

function fixture({ expiresAt = "2099-08-16T09:19:27.332Z", unapproved = false } = {}) {
  const calls = [];
  const tables = [];
  const queryCalls = [];
  const client = {
    from(table) {
      tables.push(table);
      if (table === "bv2_builds") return query([{ id: "advanced-source", state: "blocked",
        profile: "advanced", budget_credits: unapproved ? 12 : 60,
        error: "no runnable tree within 3 generation attempts" }],
      (operation, value) => queryCalls.push({ table, operation, value }));
      if (table === "bv2_snapshots") return query([{ id: "candidate", build_id: "advanced-source",
        reason: "candidate:core:2" }]);
      if (table === "bv2_build_budget_approvals") return query({ id: "approval-60", status: "consumed",
        ceiling_credits: 60, expires_at: expiresAt, dispatch_project_id: "project" });
      if (table === "bv2_model_reservations") return query(unapproved ? [
        { state: "settled", actual_credits: 0.9583, reserved_credits: 1 },
        { state: "settled", actual_credits: 0.9159, reserved_credits: 1 },
        { state: "settled", actual_credits: 3.1649, reserved_credits: 3.2 },
        { state: "settled", actual_credits: 2.4814, reserved_credits: 2.5 },
        { state: "settled", actual_credits: 2.4902, reserved_credits: 2.5 },
      ] : [
        { state: "settled", actual_credits: 1.0508, reserved_credits: 1.0805 },
        { state: "settled", actual_credits: 1.0387, reserved_credits: 1.1089 },
        { state: "settled", actual_credits: 1.9495, reserved_credits: 3.0638 },
        { state: "settled", actual_credits: 1.6048, reserved_credits: 2.8822 },
        { state: "settled", actual_credits: 2.1766, reserved_credits: 3.7738 },
      ]);
      throw new Error(`unexpected table ${table}`);
    },
  };
  const job = { id: "repair-job", diagSessionId: "diag", subscribers: new Set() };
  const deps = {
    workerEnabled: () => true, client,
    requireWorkerAdmission: async () => ({ workerId: "worker" }),
    resolveBuildContext: async () => ({ byok: true, providerLabel: "codex",
      policy: { primaryProvider: "codex", billingLane: "connected_allowance" } }),
    startDiagSessionSafe: async () => ({ id: "diag", flush: async () => {},
      recorderForJob: () => ({ sessionId: "diag" }) }),
    createJob: async (input) => { calls.push(input); return { job, existing: false }; },
  };
  return { client, deps, calls, tables, queryCalls };
}

const ctx = () => ({
  owner: "owner", conversation: { id: "conversation" }, emit: async () => {},
  conversations: { appendTurn: async () => {} },
});

test("an advanced pre-green repair reuses only the original approval's remaining headroom", async () => {
  const { deps, calls, tables, queryCalls } = fixture();
  const result = await startExistingAppWorkV2(ctx(), {
    project: { id: "project", bv2_green_snapshot_id: null, budget_approval_id: "approval-60" },
    request: "repair the retained candidate", kind: "repair",
  }, { deps });
  assert.equal(result.handled, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, "resume_repair");
  assert.equal(calls[0].projectId, "project", "repair never creates a duplicate project");
  assert.equal(calls[0].budgetApprovalId, "approval-60");
  assert.ok(Math.abs(calls[0].budgetAllowance - 52.1796) < 1e-9, calls[0].budgetAllowance);
  assert.deepEqual(calls[0].v2Input, {
    sourceBuildId: "advanced-source", problems: ["no runnable tree within 3 generation attempts"],
  });
  assert.equal(tables.includes("projects"), false, "the existing project is reused");
  assert.deepEqual(queryCalls.filter((call) => call.table === "bv2_builds"), [
    { table: "bv2_builds", operation: "select", value: "id,state,error,started_at,budget_credits" },
    { table: "bv2_builds", operation: "order", value: { column: "started_at", options: { ascending: false } } },
  ]);
});

test("a pre-green build without an approval retains only its source build headroom", async () => {
  const { deps, calls } = fixture({ unapproved: true });
  const result = await startExistingAppWorkV2(ctx(), {
    project: { id: "project", bv2_green_snapshot_id: null, budget_approval_id: null },
    request: "repair the retained candidate", kind: "repair",
  }, { deps });
  assert.equal(result.handled, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, "resume_repair");
  assert.equal(calls[0].budgetApprovalId, null);
  assert.ok(Math.abs(calls[0].budgetAllowance - 1.9893) < 1e-9, calls[0].budgetAllowance);
});

test("an expired advanced authorization fails before job or provider dispatch", async () => {
  const { deps, calls } = fixture({ expiresAt: "2020-01-01T00:00:00Z" });
  await assert.rejects(startExistingAppWorkV2(ctx(), {
    project: { id: "project", bv2_green_snapshot_id: null, budget_approval_id: "approval-60" },
    request: "repair the retained candidate", kind: "repair",
  }, { deps }), (error) => error?.code === "build_approval_expired");
  assert.equal(calls.length, 0);
});
