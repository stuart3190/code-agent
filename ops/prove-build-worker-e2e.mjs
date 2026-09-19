#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";

if (process.env.BUILD_WORKER_E2E_PROOF !== "1") throw new Error("BUILD_WORKER_E2E_PROOF=1 is required");
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url || "") || !key) {
  throw new Error("worker e2e proof refuses any target except a loopback disposable Supabase stack");
}
const image = process.env.THRALLO_BUILD_SANDBOX_IMAGE || "thrallo-build-sandbox:c7-proof";
const root = "/tmp/thrallo-c7-worker-e2e";
const owner = "a0000000-0000-4000-8000-000000000011";
const project = "b0000000-0000-4000-8000-000000000011";
const build = "c0000000-0000-4000-8000-000000000011";
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const logs = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const unwrap = (result, label) => { if (result.error) throw new Error(`${label}: ${result.error.message}`); return result.data; };
const one = (value) => Array.isArray(value) ? value[0] : value;

async function waitFor(read, predicate, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  let lastValue = null;
  while (Date.now() < end) {
    const value = await read(); lastValue = value;
    if (predicate(value)) return value;
    await sleep(200);
  }
  throw new Error(`timed out waiting for worker proof state: ${JSON.stringify(lastValue)}`);
}
function startWorker(id) {
  const child = spawn(process.execPath, ["build-worker/index.mjs"], {
    cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, THRALLO_BUILD_WORKER_ID: id, THRALLO_BUILD_JOB_TYPES: "proof_slow",
      THRALLO_BUILD_SANDBOX: "docker", THRALLO_BUILD_SANDBOX_IMAGE: image,
      THRALLO_BUILD_ARTIFACT_ROOT: root, THRALLO_BUILD_LEASE_SECONDS: "15",
      THRALLO_BUILD_POLL_MS: "250", THRALLO_MANAGED_SETTLEMENT_PAUSED: "1" },
  });
  child.stdout.on("data", (chunk) => { logs.push(chunk.toString()); process.stderr.write(chunk); });
  child.stderr.on("data", (chunk) => { logs.push(chunk.toString()); process.stderr.write(chunk); });
  return child;
}
async function stopWorker(child, signal) {
  if (child.exitCode !== null) return;
  await new Promise((resolve) => {
    child.once("exit", resolve);
    if (!child.kill(signal)) resolve();
  });
}

let first;
let second;
try {
  const created = await db.auth.admin.createUser({ id: owner, email: "worker-e2e-proof@example.invalid",
    password: "Disposable-Worker-E2E!42", email_confirm: true });
  if (created.error && !/already/i.test(created.error.message)) throw created.error;
  unwrap(await db.from("projects").upsert({ id: project, owner, name: "worker e2e proof", tree: {} }), "project");
  unwrap(await db.from("build_jobs").upsert({ id: build, owner, project_id: project, mode: "build",
    status: "queued", phase: "queued", server_id: "worker-e2e-proof" }), "build");
  const job = one(unwrap(await db.rpc("build_work_enqueue", {
    p_owner: owner, p_project_id: project, p_build_id: build, p_job_type: "proof_slow",
    p_payload: { durationMs: 5_000, phase: "crash-recovery" }, p_idempotency_key: "worker-e2e-crash",
    p_priority: 0, p_max_attempts: 3,
    p_resource_limits: { wallSeconds: 20, cpu: 0.5, memoryMb: 384, pids: 64, outputBytes: 1048576 },
  }), "enqueue"));

  const readJob = async () => one(unwrap(await db.from("build_work_jobs")
    .select("id,state,attempts,lease_owner,lease_expires_at,result_ref").eq("id", job.id).single(), "job"));
  first = startWorker("proof-e2e-first");
  await waitFor(readJob, (row) => row.state === "running" && row.lease_owner === "proof-e2e-first");
  await stopWorker(first, "SIGKILL");
  const abandoned = await readJob();
  assert.equal(abandoned.state, "running"); assert.equal(abandoned.attempts, 1);

  await waitFor(readJob, (row) => new Date(row.lease_expires_at).getTime() <= Date.now(), 25_000);
  second = startWorker("proof-e2e-second");
  const recovered = await waitFor(readJob, (row) => row.state === "succeeded", 30_000);
  assert.equal(recovered.attempts, 2); assert.ok(recovered.result_ref);
  const events = unwrap(await db.from("build_work_events").select("event_type,details")
    .eq("job_id", job.id).order("seq"), "events");
  assert.ok(events.some((event) => event.event_type === "lease_expired"));
  assert.ok(events.some((event) => event.event_type === "succeeded"));
  const remaining = execFileSync("docker", ["ps", "-aq", "--filter", `label=thrallo.durable-job-id=${job.id}`], { encoding: "utf8" }).trim();
  assert.equal(remaining, "");
  console.log(JSON.stringify({ ok: true, jobId: job.id, firstAttempt: "SIGKILL",
    recoveredBy: "proof-e2e-second", attempts: recovered.attempts, resultPersisted: true,
    leaseExpiredEvent: true, orphanContainers: 0 }, null, 2));
} catch (error) {
  console.error(logs.join("").slice(-8000));
  throw error;
} finally {
  if (first) await stopWorker(first, "SIGKILL").catch(() => {});
  if (second) await stopWorker(second, "SIGKILL").catch(() => {});
  await db.from("build_worker_nodes").delete().in("worker_id", ["proof-e2e-first", "proof-e2e-second"]);
  await db.auth.admin.deleteUser(owner).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
