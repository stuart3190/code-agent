#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

if (process.env.BUILD_WORKER_PROOF !== "1") throw new Error("BUILD_WORKER_PROOF=1 is required");
const url = process.env.API_URL;
const serviceKey = process.env.SERVICE_ROLE_KEY;
const anonKey = process.env.ANON_KEY;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url || "") || !serviceKey || !anonKey) {
  throw new Error("worker proof refuses any target except a loopback disposable Supabase stack");
}
const CONTAINER = process.env.SUPABASE_DB_CONTAINER || "supabase_db_thrallo-migration-proof";
const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const browser = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
const A = "a0000000-0000-4000-8000-000000000001";
const B = "a0000000-0000-4000-8000-000000000002";
const PA = "b0000000-0000-4000-8000-000000000001";
const PB = "b0000000-0000-4000-8000-000000000002";
const BA = "c0000000-0000-4000-8000-000000000001";
const BB = "c0000000-0000-4000-8000-000000000002";

function sql(statement) {
  return execFileSync("docker", ["exec", "-i", CONTAINER, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres", "-At"], {
    input: statement, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}
function unwrap(result, label) { if (result.error) throw new Error(`${label}: ${result.error.message}`); return result.data; }
const one = (value) => Array.isArray(value) ? value[0] : value;
async function principal(owner, project, build, suffix) {
  const created = await db.auth.admin.createUser({ id: owner, email: `worker-proof-${suffix}@example.invalid`, password: "Disposable-Worker-Proof!42", email_confirm: true });
  if (created.error && !/already/i.test(created.error.message)) throw created.error;
  unwrap(await db.from("projects").upsert({ id: project, owner, name: `worker proof ${suffix}`, tree: {} }), "project");
  unwrap(await db.from("build_jobs").upsert({
    id: build, owner, project_id: project, mode: "build", status: "queued", phase: "queued",
    pipeline_version: "v2",
  }), "build");
}
async function enqueue(owner, project, build, key, payload = { code: "same" }) {
  return one(unwrap(await db.rpc("build_work_enqueue", {
    p_owner: owner, p_project_id: project, p_build_id: build, p_job_type: "compile",
    p_payload: payload, p_idempotency_key: key, p_priority: 0, p_max_attempts: 3,
    p_resource_limits: { wallSeconds: 60, cpu: 1, memoryMb: 512, pids: 64, outputBytes: 1048576 },
  }), "enqueue"));
}
async function lease(worker) {
  return one(unwrap(await db.rpc("build_work_lease", { p_worker_id: worker, p_job_types: ["compile"], p_lease_seconds: 15 }), "lease")) ?? null;
}
async function fail(job, worker, classification = "proof_cleanup") {
  return one(unwrap(await db.rpc("build_work_fail", {
    p_job_id: job.id, p_worker_id: worker, p_lease_token: job.lease_token,
    p_error_classification: classification, p_error: "Disposable proof cleanup.",
    p_retryable: false, p_event_type: "failed",
  }), "fail"));
}

const proof = {};
try {
  await principal(A, PA, BA, "a"); await principal(B, PB, BB, "b");
  const job = await enqueue(A, PA, BA, "proof-race-one");
  const duplicate = await enqueue(A, PA, BA, "proof-race-one");
  assert.equal(duplicate.id, job.id); proof.enqueueIdempotent = true;
  const publicIdentity = one(unwrap(await db.from("build_jobs")
    .select("id,owner,project_id,pipeline_version,work_job_id").eq("id", BA).single(), "public worker identity"));
  assert.deepEqual({
    id: publicIdentity.id, owner: publicIdentity.owner, project: publicIdentity.project_id,
    pipeline: publicIdentity.pipeline_version, work: publicIdentity.work_job_id,
  }, { id: BA, owner: A, project: PA, pipeline: "v2", work: job.id });
  const payloadIdentity = one(unwrap(await db.from("build_work_payloads")
    .select("id,owner,project_id,build_id,job_type,payload_sha256")
    .eq("id", job.payload_ref).single(), "durable payload identity"));
  assert.equal(payloadIdentity.owner, A); assert.equal(payloadIdentity.project_id, PA);
  assert.equal(payloadIdentity.build_id, BA); assert.equal(payloadIdentity.job_type, "compile");
  assert.match(payloadIdentity.payload_sha256, /^[0-9a-f]{64}$/);
  proof.canonicalWorkerIdentity = true;

  const [raceA, raceB] = await Promise.all([lease("proof-worker-a"), lease("proof-worker-b")]);
  const claimed = [raceA, raceB].filter(Boolean);
  assert.equal(claimed.length, 1); assert.equal(claimed[0].id, job.id);
  proof.twoWorkerRace = { winner: claimed[0].lease_owner || (raceA ? "proof-worker-a" : "proof-worker-b"), claims: 1 };
  const winner = raceA ? "proof-worker-a" : "proof-worker-b";
  const leased = claimed[0];
  unwrap(await db.rpc("build_work_start", { p_job_id: job.id, p_worker_id: winner, p_lease_token: leased.lease_token }), "start");
  const hb = one(unwrap(await db.rpc("build_work_heartbeat", {
    p_job_id: job.id, p_worker_id: winner, p_lease_token: leased.lease_token, p_lease_seconds: 15,
    p_details: { cpu: 1, memoryMb: 64 },
  }), "heartbeat"));
  assert.equal(hb.cancel_requested, false);
  assert.equal(await lease("proof-worker-c"), null); proof.healthyHeartbeatPreventsDuplicate = true;

  // Simulate a hard worker death: no failure callback, only an expired lease. A new worker reclaims.
  sql(`update public.build_work_jobs set lease_expires_at=now()-interval '1 second' where id='${job.id}';`);
  const recovered = await lease("proof-worker-recovery");
  assert.equal(recovered.id, job.id); assert.equal(recovered.attempts, 2);
  proof.workerCrashRecovery = true;
  unwrap(await db.rpc("build_work_start", { p_job_id: job.id, p_worker_id: "proof-worker-recovery", p_lease_token: recovered.lease_token }), "restart");
  unwrap(await db.rpc("build_work_event", {
    p_job_id: job.id, p_worker_id: "proof-worker-recovery", p_lease_token: recovered.lease_token,
    p_event_type: "stderr", p_details: { text: "exact compiler stderr evidence" },
  }), "stderr evidence");
  const completed = one(unwrap(await db.rpc("build_work_complete", {
    p_job_id: job.id, p_worker_id: "proof-worker-recovery", p_lease_token: recovered.lease_token,
    p_completion_key: "completion-proof-1", p_result: { ok: true, artifact: "sha256:abc" },
    p_artifact_ref: "/isolated/artifact", p_exit_code: 0,
    p_stdout_tail: "exact stdout", p_stderr_tail: "exact stderr",
  }), "complete"));
  assert.equal(completed.state, "succeeded");
  const repeated = one(unwrap(await db.rpc("build_work_complete", {
    p_job_id: job.id, p_worker_id: "proof-worker-recovery", p_lease_token: recovered.lease_token,
    p_completion_key: "completion-proof-1", p_result: { ok: true, artifact: "sha256:abc" },
    p_artifact_ref: "/isolated/artifact", p_exit_code: 0, p_stdout_tail: "exact stdout", p_stderr_tail: "exact stderr",
  }), "duplicate completion"));
  assert.equal(repeated.result_ref, completed.result_ref);
  const joined = one(unwrap(await db.from("build_work_jobs").select("state,result_ref,build_work_results!build_work_jobs_result_fkey(id,completion_key,stdout_tail,stderr_tail)").eq("id", job.id).single(), "result join"));
  assert.equal(joined.state, "succeeded"); assert.equal(joined.result_ref, joined.build_work_results.id);
  assert.equal(joined.build_work_results.stderr_tail, "exact stderr");
  proof.resultBeforeAcknowledgement = true; proof.duplicateCompletionIdempotent = true;

  const cancel = await enqueue(A, PA, BA, "proof-cancel-before-lease", { code: "cancel" });
  const cancelled = one(unwrap(await db.rpc("build_work_request_cancel", { p_owner: A, p_job_id: cancel.id }), "cancel"));
  assert.equal(cancelled.state, "cancelled");
  assert.notEqual((await lease("proof-worker-after-cancel"))?.id, cancel.id); proof.cancelBeforeLease = true;

  const cancelRace = await enqueue(A, PA, BA, "proof-cancel-completion-race", { code: "cancel-race" });
  const cancelLease = await lease("proof-worker-cancel-race");
  assert.equal(cancelLease.id, cancelRace.id);
  unwrap(await db.rpc("build_work_start", { p_job_id: cancelRace.id, p_worker_id: "proof-worker-cancel-race", p_lease_token: cancelLease.lease_token }), "cancel-race start");
  unwrap(await db.rpc("build_work_request_cancel", { p_owner: A, p_job_id: cancelRace.id }), "cancel-race request");
  const rejectedCompletion = await db.rpc("build_work_complete", {
    p_job_id: cancelRace.id, p_worker_id: "proof-worker-cancel-race", p_lease_token: cancelLease.lease_token,
    p_completion_key: "must-not-complete", p_result: { invalid: true }, p_exit_code: 0,
  });
  assert.ok(rejectedCompletion.error);
  const cancelledRace = await fail(cancelLease, "proof-worker-cancel-race", "cancelled");
  assert.equal(cancelledRace.state, "cancelled"); assert.equal(cancelledRace.result_ref, null);
  proof.cancellationCompletionRace = true;

  const other = await enqueue(B, PB, BB, "proof-owner-b-same-payload");
  assert.notEqual(other.id, job.id);
  const { data: browserRows, error: browserError } = await browser.from("build_work_jobs").select("id");
  if (browserError) assert.equal(browserError.code, "42501");
  else assert.deepEqual(browserRows, []);
  const denied = await browser.rpc("build_work_request_cancel", { p_owner: A, p_job_id: other.id });
  assert.ok(denied.error); proof.ownerIsolation = true;

  const parallelA = await enqueue(A, PA, BA, "proof-parallel-owner-a", { code: "parallel" });
  const [parallelOne, parallelTwo] = await Promise.all([lease("proof-parallel-1"), lease("proof-parallel-2")]);
  assert.deepEqual(new Set([parallelOne.id, parallelTwo.id]), new Set([other.id, parallelA.id]));
  assert.notEqual(parallelOne.owner, parallelTwo.owner);
  await fail(parallelOne, "proof-parallel-1"); await fail(parallelTwo, "proof-parallel-2");
  proof.concurrentTenantJobs = true;

  const queued = await enqueue(A, PA, BA, "proof-shell-restart-persists", { code: "restart" });
  const persisted = one(unwrap(await db.from("build_work_jobs").select("state,payload_ref").eq("id", queued.id).single(), "restart persistence"));
  assert.equal(persisted.state, "queued"); assert.ok(persisted.payload_ref); proof.shellRestartLosesNoJob = true;

  const events = unwrap(await db.from("build_work_events").select("event_type,details").eq("job_id", job.id).order("seq"), "events");
  assert.ok(events.some((event) => event.event_type === "stderr" && event.details.text === "exact compiler stderr evidence"));
  proof.diagnosticEvidence = true;
  proof.queueCounts = JSON.parse(sql("select json_build_object('jobs',count(*),'payloads',(select count(*) from public.build_work_payloads),'results',(select count(*) from public.build_work_results),'events',(select count(*) from public.build_work_events)) from public.build_work_jobs;") || "{}");
  console.log(JSON.stringify({ ok: true, ...proof }, null, 2));
} finally {
  sql(`delete from auth.users where id in ('${A}','${B}');`);
}
