import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyBv2TerminalConsistency,
  readBv2TerminalConsistencyEvidence,
} from "../../ops/lib/bv2TerminalConsistency.mjs";

const COMMIT = "a".repeat(40);
const MANIFEST = "b".repeat(64);
const activation = (activatedAt) => ({ value: {
  state: "active", policyVersion: "managed_recovery_v1", activatedAt,
  deploymentCommit: COMMIT, deploymentManifestSha256: MANIFEST,
} });

function mismatch({ suffix = "1", finishedAt = "2030-01-01T00:00:00.000Z", work = "succeeded",
  publicState = "failed", internal = "blocked" } = {}) {
  const owner = `owner-${suffix}`;
  return {
    publicBuilds: [{ id: `public-${suffix}`, owner, work_job_id: `work-${suffix}`,
      bv2_build_id: `internal-${suffix}`, status: publicState }],
    workJobs: [{ id: `work-${suffix}`, owner, build_id: `public-${suffix}`, state: work,
      finished_at: finishedAt }],
    internalBuilds: [{ id: `internal-${suffix}`, owner, state: internal,
      finished_at: finishedAt }],
  };
}

test("a pre-activation terminal mismatch remains visible historical evidence and does not block forward runtime", () => {
  const report = classifyBv2TerminalConsistency({
    activation: activation("2030-01-02T00:00:00.000Z"), ...mismatch(),
  });
  assert.equal(report.historical_inconsistencies, 1);
  assert.equal(report.post_activation_inconsistencies, 0);
  assert.equal(report.active_inconsistencies, 0);
  assert.equal(report.forward_runtime_consistent, true);
  assert.equal(report.historical_records[0].work_state, "succeeded");
  assert.equal(report.historical_records[0].public_state, "failed");
  assert.equal(report.historical_records[0].internal_state, "blocked");
});

test("a post-activation terminal mismatch still fails the acceptance gate", () => {
  const report = classifyBv2TerminalConsistency({
    activation: activation("2029-12-31T23:59:59.000Z"), ...mismatch(),
  });
  assert.equal(report.historical_inconsistencies, 0);
  assert.equal(report.post_activation_inconsistencies, 1);
  assert.equal(report.forward_runtime_consistent, false);
});

test("an active mismatch fails regardless of when the public build was created", () => {
  const report = classifyBv2TerminalConsistency({
    activation: activation("2030-01-02T00:00:00.000Z"),
    ...mismatch({ work: "running", finishedAt: null }),
  });
  assert.equal(report.active_inconsistencies, 1);
  assert.equal(report.forward_runtime_consistent, false);
});

test("the exact historical 23 blocked plus 11 failed shape is accepted without rewriting evidence", () => {
  const evidence = { publicBuilds: [], workJobs: [], internalBuilds: [] };
  for (let index = 0; index < 34; index += 1) {
    const row = mismatch({ suffix: String(index), internal: index < 23 ? "blocked" : "failed" });
    evidence.publicBuilds.push(...row.publicBuilds);
    evidence.workJobs.push(...row.workJobs);
    evidence.internalBuilds.push(...row.internalBuilds);
  }
  const before = structuredClone(evidence);
  const report = classifyBv2TerminalConsistency({
    activation: activation("2030-01-02T00:00:00.000Z"), ...evidence,
  });
  assert.equal(report.historical_inconsistencies, 34);
  assert.equal(report.forward_runtime_consistent, true);
  assert.deepEqual(evidence, before);
});

test("the persisted activation boundary is authoritative rather than a hard-coded date", () => {
  const evidence = mismatch({ finishedAt: "2042-06-01T12:00:00.000Z" });
  const historical = classifyBv2TerminalConsistency({
    activation: activation("2042-06-01T12:00:01.000Z"), ...evidence,
  });
  const current = classifyBv2TerminalConsistency({
    activation: activation("2042-06-01T11:59:59.000Z"), ...evidence,
  });
  assert.equal(historical.historical_inconsistencies, 1);
  assert.equal(current.post_activation_inconsistencies, 1);
});

test("the evidence reader performs selects only and leaves source rows untouched", async () => {
  const tables = {
    bv2_feature_flags: [activation("2030-01-02T00:00:00.000Z")],
    build_jobs: [{ id: "public", owner: "owner", work_job_id: "work", bv2_build_id: "internal",
      status: "failed", pipeline_version: "v2" }],
    build_work_jobs: [{ id: "work", owner: "owner", build_id: "public", state: "succeeded",
      job_type: "builder_pipeline", finished_at: "2030-01-01T00:00:00.000Z" }],
    bv2_builds: [{ id: "internal", owner: "owner", state: "failed" }],
  };
  const before = structuredClone(tables);
  const operations = [];
  const client = { from(table) {
    let rows = tables[table] || [];
    const query = {
      select() { operations.push([table, "select"]); return query; },
      eq(column, value) { operations.push([table, "eq"]); rows = rows.filter((row) => row[column] === value); return query; },
      range(from, to) { operations.push([table, "range"]); return Promise.resolve({ data: rows.slice(from, to + 1), error: null }); },
      maybeSingle() { operations.push([table, "maybeSingle"]); return Promise.resolve({ data: rows[0] || null, error: null }); },
    };
    return query;
  } };

  const evidence = await readBv2TerminalConsistencyEvidence(client, { pageSize: 10 });
  assert.equal(evidence.publicBuilds.length, 1);
  assert.ok(operations.length > 0);
  assert.equal(operations.some(([, operation]) => !["select", "eq", "range", "maybeSingle"].includes(operation)), false);
  assert.deepEqual(tables, before);
});

test("an invalid or missing activation record fails closed", () => {
  assert.throws(() => classifyBv2TerminalConsistency({ activation: null }), (error) => (
    error.code === "bv2_recovery_activation_required"
  ));
});
