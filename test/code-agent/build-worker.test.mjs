import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { buildWorkerEnabled, limitsFor, workIdempotencyKey } from "../../shell/server/lib/buildWorkQueue.mjs";
import { runProcess } from "../../build-worker/processTree.mjs";
import { safeChildEnvironment, sandboxTmpfsMb } from "../../build-worker/sandboxRunner.mjs";
import { createWorkerQueue } from "../../build-worker/queue.mjs";

const slowScript = (phase, ms = 1_200) => `console.log(${JSON.stringify(`${phase}:stdout`)}); console.error(${JSON.stringify(`${phase}:stderr`)}); setTimeout(()=>{},${ms});`;

async function responsivenessProof(phase) {
  const server = http.createServer((req, res) => {
    if (req.url === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("event: status\ndata: {\"ok\":true}\n\n");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const work = runProcess(process.execPath, ["-e", slowScript(phase)], { wallMs: 5_000 });
  const samples = [];
  for (const route of ["/health", "/api/lightweight", "/events", "/health", "/api/lightweight"]) {
    const start = performance.now();
    const response = await fetch(`http://127.0.0.1:${port}${route}`);
    await response.text();
    samples.push(performance.now() - start);
  }
  const result = await work;
  await new Promise((resolve) => server.close(resolve));
  samples.sort((a, b) => a - b);
  return { result, maxMs: samples.at(-1), p95Ms: samples[Math.floor(samples.length * 0.95)] };
}

for (const phase of ["npm-install", "compile", "browser-verification"]) {
  test(`C7 shell stays responsive during ${phase}`, async (t) => {
    const proof = await responsivenessProof(phase);
    assert.equal(proof.result.ok, true);
    assert.match(proof.result.stdout, new RegExp(`${phase}:stdout`));
    assert.match(proof.result.stderr, new RegExp(`${phase}:stderr`));
    assert.ok(proof.maxMs < 500, `max lightweight HTTP latency ${proof.maxMs.toFixed(1)}ms`);
    t.diagnostic(JSON.stringify({ phase, maxMs: Number(proof.maxMs.toFixed(2)), p95Ms: Number(proof.p95Ms.toFixed(2)) }));
  });
}

for (const phase of ["install", "compile", "browser-verification"]) {
  test(`C7 cancellation during ${phase} kills the owned process`, async () => {
    const controller = new AbortController();
    const started = Date.now();
    const work = runProcess(process.execPath, ["-e", slowScript(phase, 30_000)], {
      signal: controller.signal, wallMs: 35_000,
    });
    setTimeout(() => controller.abort(), 150);
    const result = await work;
    assert.equal(result.classification, "cancelled");
    assert.ok(Date.now() - started < 5_000);
  });
}

test("C7 timeout terminates the full process group", async () => {
  const script = "const{spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)";
  const result = await runProcess(process.execPath, ["-e", script], { wallMs: 250 });
  assert.equal(result.classification, "timeout");
  const childPid = Number(result.stdout.trim().split(/\s+/)[0]);
  assert.ok(childPid > 0);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.throws(() => process.kill(childPid, 0));
});

test("C7 resource termination is classified from cgroup/container exit 137", async () => {
  class FakeChild extends EventEmitter {
    constructor() { super(); this.pid = 12345; this.exitCode = null; this.stdout = new PassThrough(); this.stderr = new PassThrough(); }
    kill() {}
  }
  const fake = new FakeChild();
  const promise = runProcess("ignored", [], { spawnImpl: () => fake, wallMs: 2_000 });
  queueMicrotask(() => { fake.exitCode = 137; fake.emit("exit", 137, null); });
  const result = await promise;
  assert.equal(result.classification, "resource_limit");
});

test("C7 output cap stops a noisy child and preserves bounded exact evidence", async () => {
  const result = await runProcess(process.execPath, ["-e", "process.stdout.write('A'.repeat(200000));setInterval(()=>{},1000)"], {
    wallMs: 5_000, outputBytes: 32_000,
  });
  assert.equal(result.classification, "output_limit");
  assert.ok(Buffer.byteLength(result.stdout) <= 32_000);
});

test("C7 sandbox children receive no platform or provider credentials", () => {
  const env = safeChildEnvironment({ PATH: "x", SystemRoot: "y", SUPABASE_SERVICE_ROLE_KEY: "secret", OPENAI_API_KEY: "secret", STRIPE_SECRET_KEY: "secret" });
  assert.deepEqual(env, { PATH: "x", SystemRoot: "y" });
});

test("C7 browser sandboxes reserve bounded temp space for sequential WebGL verification", () => {
  assert.equal(sandboxTmpfsMb("browser_verify", 2048), 1024);
  assert.equal(sandboxTmpfsMb("qa_browser", 3072), 1024);
  assert.equal(sandboxTmpfsMb("browser_verify", 1024), 512);
  assert.equal(sandboxTmpfsMb("compile", 2048), 256);
});

test("C7 worker policy caps every requested resource", () => {
  assert.deepEqual(limitsFor("compile", { wallSeconds: 9999, cpu: 99, memoryMb: 99999, pids: 9999, outputBytes: 999999999 }), {
    wallSeconds: 300, cpu: 2, memoryMb: 2048, pids: 256, outputBytes: 4 * 1024 * 1024,
  });
});

test("C7 idempotency includes tenant, project, build and payload", () => {
  const a = workIdempotencyKey({ jobType: "compile", owner: "a", projectId: "p", buildId: "b", payload: { x: 1 } });
  const b = workIdempotencyKey({ jobType: "compile", owner: "b", projectId: "p", buildId: "b", payload: { x: 1 } });
  const c = workIdempotencyKey({ jobType: "compile", owner: "a", projectId: "p", buildId: "b", payload: { x: 2 } });
  assert.notEqual(a, b); assert.notEqual(a, c);
});

test("C7 worker retires only stale peer registrations and clears their dead job pointer", async () => {
  const calls = [];
  const query = {
    neq(field, value) { calls.push(["neq", field, value]); return this; },
    in(field, value) { calls.push(["in", field, value]); return this; },
    lt(field, value) { calls.push(["lt", field, value]); return this; },
    async select(field) { calls.push(["select", field]); return { data: [{ worker_id: "stale" }], error: null }; },
  };
  const client = { from(table) { calls.push(["from", table]); return {
    update(value) { calls.push(["update", value]); return query; },
  }; } };
  const retired = await createWorkerQueue(client).retireStaleNodes("current", "2026-08-13T00:00:00.000Z");
  assert.deepEqual(retired, [{ worker_id: "stale" }]);
  assert.deepEqual(calls, [
    ["from", "build_worker_nodes"],
    ["update", { state: "stopped", current_job_id: null }],
    ["neq", "worker_id", "current"],
    ["in", "state", ["active", "paused", "draining"]],
    ["lt", "heartbeat_at", "2026-08-13T00:00:00.000Z"],
    ["select", "worker_id"],
  ]);
});

test("C7 cutover leaves no shell fallback and rejects non-V2 worker payloads", async () => {
  assert.equal(buildWorkerEnabled({}), false);
  assert.equal(buildWorkerEnabled({ THRALLO_BUILD_WORKER_ENABLED: "0" }), false);
  const source = await readFile(new URL("../../shell/server/lib/buildJobs.mjs", import.meta.url), "utf8");
  const worker = await readFile(new URL("../../build-worker/index.mjs", import.meta.url), "utf8");
  assert.match(source, /pipelineVersion !== "v2"[\s\S]*builder_v1_retired/);
  assert.match(source, /payload\.pipelineVersion !== "v2"[\s\S]*builder_v1_retired/);
  assert.match(worker, /THRALLO_BV2_KILL[\s\S]*payload\?\.pipelineVersion !== "v2"/);
});

test("C7 service and sandbox enforce one-job cgroup and per-job Docker isolation", async () => {
  const unit = await readFile(new URL("../../build-worker/thrallo-build-worker.service", import.meta.url), "utf8");
  const runner = await readFile(new URL("../../build-worker/sandboxRunner.mjs", import.meta.url), "utf8");
  assert.match(unit, /MemoryMax=3G/); assert.match(unit, /CPUQuota=250%/); assert.match(unit, /KillMode=control-group/);
  assert.match(runner, /--memory/); assert.match(runner, /--cpus/); assert.match(runner, /--pids-limit/);
  assert.match(runner, /--read-only/); assert.match(runner, /--cap-drop/); assert.match(runner, /no-new-privileges/);
  assert.match(runner, /size=\$\{tmpfsMb\}m/);
  assert.match(runner, /thrallo\.durable-job-id/); assert.match(runner, /removeSandboxContainer\(name\)/);
  assert.match(runner, /reconcileOrphanSandboxes/);
  assert.match(runner, /jobRoot.*artifactRoot/);
});
