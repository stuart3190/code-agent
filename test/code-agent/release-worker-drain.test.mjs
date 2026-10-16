import test from "node:test";
import assert from "node:assert/strict";
import { drainIdleWorker } from "../../ops/lib/drainIdleWorker.mjs";

function fixture({ state = "active", job = null, fresh = {}, pid = 42 } = {}) {
  const calls = [];
  const node = { worker_id: "host:42:proof", metadata: { pid: 42, hostname: "host" }, state, current_job_id: job };
  return { calls, args: {
    pid: 42, hostname: "host", currentPid: () => pid, now: () => 1_000, sleep: async () => {}, polls: 2,
    stop: async () => { calls.push("stop"); },
    registry: {
      list: async () => [node],
      drain: async () => { calls.push("drain"); },
      get: async () => ({ state: "draining", current_job_id: null, heartbeat_at: new Date(2_000).toISOString(), ...fresh }),
      resume: async () => { calls.push("resume"); },
    },
  } };
}

test("release drain stops only after a fresh idle-worker acknowledgment", async () => {
  const f = fixture(); assert.equal((await drainIdleWorker(f.args)).stopped, true);
  assert.deepEqual(f.calls, ["drain", "stop"]);
});
for (const options of [{ state: "paused" }, { job: "customer-job" }]) test(`release drain preserves operator/job state ${JSON.stringify(options)}`, async () => {
  const f = fixture(options); await assert.rejects(drainIdleWorker(f.args), /postponed/);
  assert.deepEqual(f.calls, []);
});
for (const options of [{ fresh: { current_job_id: "racing-job" } }, { pid: 43 },
  { fresh: { heartbeat_at: new Date(1_000).toISOString() } }]) test(`release drain fails safely on race or missing acknowledgment ${JSON.stringify(options)}`, async () => {
  const f = fixture(options); await assert.rejects(drainIdleWorker(f.args));
  assert.deepEqual(f.calls, ["drain", "resume"]);
});
