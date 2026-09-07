import assert from "node:assert/strict";
import test from "node:test";

import {
  PREVIEW_ISOLATION_PROOF_MAX_AGE_MS,
  resolvePreviewIsolationRefreshPolicy,
} from "../../build-worker/previewIsolationPolicy.mjs";
import { createPreviewIsolationReadiness } from "../../build-worker/previewIsolationReadiness.mjs";
import { requireFreshWorkerAdmission } from "../../shell/server/lib/builderV2/workerAdmission.mjs";
import { readFile } from "node:fs/promises";

const CONFIGURED_TYPES = ["builder_pipeline", "compile", "browser_verify"];
const ENV = { THRALLO_BUILD_WORKER_ENABLED: "1", THRALLO_BUILD_WORKER_VERSION: "release-1" };

function passingProof(now) {
  return {
    status: "passed", checkedAt: new Date(now).toISOString(), resolvedMode: "vps",
    health: { reachable: true, capacity: 4 },
    preview: { mode: "vps", markerMatched: true }, teardown: { stopped: true, absent: true },
  };
}

function clientFor(node) {
  return { from: () => ({ select: async () => ({ data: [node], error: null }) }) };
}

function fakeTimers() {
  const scheduled = [];
  return {
    scheduled,
    setTimer(fn, delayMs) {
      const timer = { fn, delayMs, unref() {} };
      scheduled.push(timer);
      return timer;
    },
    clearTimer(timer) {
      const index = scheduled.indexOf(timer);
      if (index >= 0) scheduled.splice(index, 1);
    },
    async runNext() {
      const timer = scheduled.shift();
      assert.ok(timer, "a readiness refresh was scheduled");
      await timer.fn();
      return timer;
    },
  };
}

test("preview readiness defaults refresh well before the ten-minute admission deadline", () => {
  const policy = resolvePreviewIsolationRefreshPolicy({});
  assert.equal(policy.maxProofAgeMs, 10 * 60_000);
  assert.equal(policy.refreshMs, 4 * 60_000);
  assert.equal(policy.retryMs, 30_000);
  assert.equal(policy.jitterMs, 30_000);
  assert.ok(policy.refreshMs + policy.jitterMs < policy.maxProofAgeMs / 2);
  assert.throws(() => resolvePreviewIsolationRefreshPolicy({
    THRALLO_PREVIEW_ISOLATION_REFRESH_MS: "590000",
  }), (error) => error.code === "preview_isolation_refresh_invalid");
});

test("startup stays unavailable until proof passes, then automatic refresh spans several expiry windows", async () => {
  let now = Date.parse("2026-08-15T08:00:00.000Z");
  let node;
  let proofRuns = 0;
  let releaseStartup;
  const startupGate = new Promise((resolve) => { releaseStartup = resolve; });
  const timers = fakeTimers();
  let readiness;
  const publish = async (proof) => {
    node = {
      worker_id: "worker-1", version: "release-1", state: "active", current_job_id: null,
      heartbeat_at: new Date(now).toISOString(), job_types: readiness.jobTypes(CONFIGURED_TYPES),
      metadata: { configuredJobTypes: CONFIGURED_TYPES, previewIsolation: proof },
    };
  };
  readiness = createPreviewIsolationReadiness({
    enabled: true, prove: async () => {
      proofRuns += 1;
      if (proofRuns === 1) await startupGate;
      return passingProof(now);
    }, publish,
    refreshMs: 4 * 60_000, retryMs: 30_000, jitterMs: 0, now: () => now,
    setTimer: timers.setTimer, clearTimer: timers.clearTimer,
  });

  const starting = readiness.start();
  while (!node) await Promise.resolve();
  await assert.rejects(requireFreshWorkerAdmission({ client: clientFor(node), env: ENV, now }),
    (error) => error.code === "preview_isolation_required");
  releaseStartup();
  await starting;
  assert.equal((await requireFreshWorkerAdmission({ client: clientFor(node), env: ENV, now })).workerId, "worker-1");

  for (let cycle = 1; cycle <= 6; cycle += 1) {
    const timer = timers.scheduled[0];
    assert.equal(timer.delayMs, 4 * 60_000);
    now += timer.delayMs;
    await timers.runNext();
    now += (cycle % 2) * 5 * 60_000;
    node = { ...node, heartbeat_at: new Date(now).toISOString() };
    const admitted = await requireFreshWorkerAdmission({ client: clientFor(node), env: ENV, now });
    assert.equal(admitted.workerId, "worker-1");
    now -= (cycle % 2) * 5 * 60_000;
  }
  assert.equal(proofRuns, 7);
  assert.ok(now - Date.parse("2026-08-15T08:00:00.000Z") > 2 * PREVIEW_ISOLATION_PROOF_MAX_AGE_MS);
  readiness.stop();
});

test("failed refresh removes builder admission, preserves exact reason, and a retry restores it", async () => {
  let now = Date.parse("2026-08-15T08:00:00.000Z");
  let node;
  let currentJobId = null;
  const outcomes = [passingProof(now), Object.assign(new Error("provisiond capacity probe timed out"), {
    code: "preview_isolation_required",
  }), null];
  const timers = fakeTimers();
  let readiness;
  readiness = createPreviewIsolationReadiness({
    enabled: true,
    prove: async () => {
      const outcome = outcomes.shift();
      if (outcome instanceof Error) throw outcome;
      return outcome || passingProof(now);
    },
    publish: async (proof) => {
      node = {
        worker_id: "worker-1", version: "release-1", state: "active", current_job_id: currentJobId,
        heartbeat_at: new Date(now).toISOString(), job_types: readiness.jobTypes(CONFIGURED_TYPES),
        metadata: { configuredJobTypes: CONFIGURED_TYPES, previewIsolation: proof },
      };
    },
    refreshMs: 4 * 60_000, retryMs: 30_000, jitterMs: 30_000, random: () => 0, now: () => now,
    setTimer: timers.setTimer, clearTimer: timers.clearTimer,
  });
  await readiness.start();
  currentJobId = "11111111-1111-4111-8111-111111111111";
  now += 4 * 60_000;
  await timers.runNext();
  assert.equal(node.current_job_id, currentJobId, "readiness failure must not cancel active work");
  assert.ok(!node.job_types.includes("builder_pipeline"), "failed worker must not lease new pipeline work");
  await assert.rejects(requireFreshWorkerAdmission({ client: clientFor(node), env: ENV, now }),
    (error) => error.code === "preview_isolation_required"
      && /provisiond capacity probe timed out/.test(error.message));

  assert.equal(timers.scheduled[0].delayMs, 30_000);
  now += 30_000;
  await timers.runNext();
  assert.ok(node.job_types.includes("builder_pipeline"));
  assert.equal(node.current_job_id, currentJobId);
  assert.equal((await requireFreshWorkerAdmission({ client: clientFor(node), env: ENV, now })).workerId, "worker-1");
  readiness.stop();
});

test("failed readiness never applies symmetric jitter that collapses retries to one second", async () => {
  const timers = fakeTimers();
  const readiness = createPreviewIsolationReadiness({
    enabled: true,
    prove: async () => { throw Object.assign(new Error("isolated preview timed out"), {
      code: "preview_isolation_required",
    }); },
    publish: async () => {},
    refreshMs: 4 * 60_000,
    retryMs: 30_000,
    jitterMs: 30_000,
    random: () => 0,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  await readiness.start();
  assert.equal(timers.scheduled[0].delayMs, 30_000);
  readiness.stop();
});

test("an expired local proof removes builder work even if a delayed timer has not fired", async () => {
  let now = Date.parse("2026-08-15T08:00:00.000Z");
  let readiness;
  readiness = createPreviewIsolationReadiness({
    enabled: true, prove: async () => passingProof(now), publish: async () => {},
    refreshMs: 4 * 60_000, retryMs: 30_000, jitterMs: 0, now: () => now,
    setTimer: () => ({ unref() {} }), clearTimer: () => {},
  });
  await readiness.start();
  now += PREVIEW_ISOLATION_PROOF_MAX_AGE_MS + 1;
  assert.equal(readiness.isReady(), false);
  assert.deepEqual(readiness.jobTypes(CONFIGURED_TYPES), ["compile", "browser_verify"]);
  readiness.stop();
});

test("active jobs keep node liveness while the independent readiness controller refreshes", async () => {
  const worker = await readFile(new URL("../../build-worker/index.mjs", import.meta.url), "utf8");
  const readiness = await readFile(new URL("../../build-worker/previewIsolationReadiness.mjs", import.meta.url), "utf8");
  // Lease renewal and node liveness are two independent mechanisms: a retrying lease heartbeat
  // (so a transient transport blip cannot drop the job) and a plain interval that keeps publishing
  // this node while that job runs. They were one setInterval until the lease heartbeat gained
  // retries. This test used to slice the source between two literals and assert inside the slice —
  // when the first literal stopped existing, indexOf returned -1 and the slice silently became
  // meaningless rather than failing, so the assertions below anchor on each mechanism directly.
  assert.match(worker, /renew:\s*\(\{\s*signal\s*\}\)\s*=>\s*queue\.heartbeat\(job/,
    "the job lease must still be renewed against the queue");
  const nodeHeartbeat = worker.match(/const nodeHeartbeat = setInterval\([\s\S]*?nodeHeartbeat\.unref/);
  assert.ok(nodeHeartbeat, "the worker-node heartbeat interval must still exist");
  assert.match(nodeHeartbeat[0], /publishWorkerNode\(\)/,
    "a long-running job must not let its worker-node heartbeat go stale");
  assert.doesNotMatch(readiness, /currentJob|current_job/,
    "readiness refresh must not be blocked by an active customer job");
  assert.match(worker, /current\?\.id \|\| null[\s\S]*configuredJobTypes: JOB_TYPES[\s\S]*previewIsolation/,
    "readiness and busy state must be published in one worker heartbeat");
});
