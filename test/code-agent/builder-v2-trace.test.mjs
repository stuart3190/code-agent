// WP-12 — the trace hierarchy and per-step routing: every v2 model call lands in the
// canonical tables WITH its trace ids and pipeline step; the diagnostics API aggregates
// spend by step; routing picks reasoning effort per step kind.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createDiagSession } from "../../shell/server/lib/appBuild/buildDiagnostics.mjs";
import { routeForStep, STEP_ROUTING } from "../../shell/server/lib/builderV2/modelLanes.mjs";
import { handleDiagnosticsBv2 } from "../../shell/server/routes/diagnostics.mjs";

function captureClient(tables = {}) {
  const inserts = [];
  return {
    inserts,
    from(table) {
      const state = { filters: [], table };
      const rows = tables[table] || [];
      const api = {
        insert: (row) => { inserts.push({ table, row }); return { select: () => api, then: (r) => Promise.resolve({ data: null, error: null }).then(r) }; },
        update: () => api,
        select: () => api,
        eq: (c, v) => { state.filters.push([c, v]); return api; },
        order: () => api,
        limit: () => api,
        maybeSingle: () => Promise.resolve({ data: rows.find((r) => state.filters.every(([c, v]) => r[c] === v)) || null, error: null }),
        then: (resolve, reject) => Promise.resolve({ data: rows.filter((r) => state.filters.every(([c, v]) => r[c] === v)), error: null }).then(resolve, reject),
      };
      return api;
    },
  };
}

test("WP12 — diag.step threads trace ids into diag_steps AND ai_requests", async () => {
  const client = captureClient();
  const session = await createDiagSession({
    owner: "o", projectId: "p", kind: "app_build_v2", prompt: "x", model: "gpt-5.5", client,
  });
  session.step({
    agent: "BuilderV2", kind: "agent", label: "core: patches (3)",
    usage: { input: 1000, output: 100, cached: 0, reasoning: 0, total: 1100 },
    trace: { traceId: session.id, parentId: session.id, step: "core" },
  });
  await session._chain;

  const stepRow = client.inserts.find((i) => i.table === "diag_steps")?.row;
  assert.equal(stepRow.trace_id, session.id);
  assert.equal(stepRow.parent_id, session.id);
  const aiRow = client.inserts.find((i) => i.table === "ai_requests")?.row;
  assert.equal(aiRow.trace_id, session.id);
  assert.equal(aiRow.step, "core", "the pipeline step names every model call");

  // v1 callers pass no trace — columns stay null, behaviour unchanged.
  session.step({ kind: "log", label: "plain", usage: { input: 1, output: 1, total: 2 } });
  await session._chain;
  const plain = client.inserts.filter((i) => i.table === "ai_requests").pop().row;
  assert.equal(plain.trace_id, null);
  assert.equal(plain.step, null);
});

test("WP12 — per-step routing: full thinking where design happens, less where mechanical", () => {
  assert.equal(routeForStep("core").reasoningEffort, "medium");
  assert.equal(routeForStep("repair").reasoningEffort, "medium");
  assert.equal(routeForStep("edit").reasoningEffort, "low");
  assert.equal(routeForStep("increment:newsletter-signup").reasoningEffort, "low");
  assert.equal(routeForStep("unknown-step"), STEP_ROUTING.core, "unknowns get the strong default");
});

test("WP12 — the bv2 diagnostics endpoint aggregates spend by pipeline step", async () => {
  const client = captureClient({
    diag_runs: [{ id: "run-1", owner: "o", project_id: "p", kind: "app_build_v2" }],
    bv2_builds: [{ id: "b1", owner: "o", project_id: "p", profile: "simple", state: "green", final_snapshot: "s1", started_at: "t" }],
    bv2_snapshots: [{ id: "s1", owner: "o", project_id: "p", reason: "core", state: "ready", file_count: 40, created_at: "t" }],
    bv2_project_pointers: [{ owner: "o", project_id: "p", label: "green", snapshot_id: "s1" }],
    ai_requests: [
      { build_id: "run-1", owner: "o", step: "contract", input_tokens: 1000, output_tokens: 500, cached_tokens: 0, cost: 0.3 },
      { build_id: "run-1", owner: "o", step: "core", input_tokens: 4000, output_tokens: 5000, cached_tokens: 1000, cost: 1.0 },
      { build_id: "run-1", owner: "o", step: "core", input_tokens: 4000, output_tokens: 2000, cached_tokens: 3000, cost: 0.6 },
    ],
  });
  let sent = null;
  const res = { writeHead: () => {}, end: (b) => { sent = JSON.parse(b); } };
  await handleDiagnosticsBv2(null, res, { owner: { id: "o" }, runId: "run-1", client });

  assert.equal(sent.v2, true);
  assert.equal(sent.builds[0].state, "green");
  assert.equal(sent.pointers[0].label, "green");
  assert.equal(sent.pointers[0].snapshot_id, "s1");
  const core = sent.steps.find((s) => s.step === "core");
  assert.equal(core.calls, 2);
  assert.equal(core.inputTokens, 8000);
  assert.equal(core.cachedTokens, 4000);
  assert.ok(Math.abs(core.cost - 1.6) < 1e-9);
  assert.equal(sent.steps[0].step, "core", "sorted by cost desc");

  // A v1 run reports v2:false and nothing else.
  const client2 = captureClient({ diag_runs: [{ id: "run-2", owner: "o", project_id: "p", kind: "app_build" }] });
  let sent2 = null;
  await handleDiagnosticsBv2(null, { writeHead: () => {}, end: (b) => { sent2 = JSON.parse(b); } }, { owner: { id: "o" }, runId: "run-2", client: client2 });
  assert.deepEqual(sent2, { v2: false });
});
