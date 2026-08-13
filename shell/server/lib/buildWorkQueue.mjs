import crypto from "node:crypto";
import { serviceClient } from "./supabase.mjs";

export const BUILD_WORK_STATES = Object.freeze({
  queued: "queued", leased: "leased", running: "running", cancelRequested: "cancel_requested",
  succeeded: "succeeded", failed: "failed", cancelled: "cancelled", expired: "expired",
});

export const BUILD_WORK_TERMINAL = new Set([
  BUILD_WORK_STATES.succeeded, BUILD_WORK_STATES.failed, BUILD_WORK_STATES.cancelled,
]);

const LIMITS = Object.freeze({
  builder_pipeline: { wallSeconds: 5400, cpu: 2, memoryMb: 3072, pids: 384, outputBytes: 16 * 1024 * 1024 },
  dependency_install: { wallSeconds: 600, cpu: 2, memoryMb: 2048, pids: 256, outputBytes: 4 * 1024 * 1024 },
  compile: { wallSeconds: 300, cpu: 2, memoryMb: 2048, pids: 256, outputBytes: 4 * 1024 * 1024 },
  browser_verify: { wallSeconds: 300, cpu: 2, memoryMb: 2048, pids: 384, outputBytes: 8 * 1024 * 1024 },
  qa_browser: { wallSeconds: 600, cpu: 2, memoryMb: 3072, pids: 512, outputBytes: 16 * 1024 * 1024 },
  image_optimise: { wallSeconds: 90, cpu: 1.5, memoryMb: 1024, pids: 128, outputBytes: 32 * 1024 * 1024 },
  publish_package: { wallSeconds: 420, cpu: 2, memoryMb: 2048, pids: 256, outputBytes: 32 * 1024 * 1024 },
  proof_slow: { wallSeconds: 120, cpu: 1, memoryMb: 512, pids: 64, outputBytes: 1024 * 1024 },
  // Hashes five files and exits. It runs before every pipeline job, so it is deliberately the
  // cheapest thing the sandbox can be asked to do.
  sandbox_provenance: { wallSeconds: 60, cpu: 1, memoryMb: 512, pids: 64, outputBytes: 256 * 1024 },
});

export function buildWorkerEnabled(env = process.env) {
  return env.THRALLO_BUILD_WORKER_ENABLED === "1";
}

export function limitsFor(jobType, requested = {}) {
  const policy = LIMITS[jobType];
  if (!policy) throw new Error(`unsupported build work type: ${jobType}`);
  const positive = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
  return {
    wallSeconds: Math.min(policy.wallSeconds, positive(requested.wallSeconds, policy.wallSeconds)),
    cpu: Math.min(policy.cpu, positive(requested.cpu, policy.cpu)),
    memoryMb: Math.floor(Math.min(policy.memoryMb, positive(requested.memoryMb, policy.memoryMb))),
    pids: Math.floor(Math.min(policy.pids, positive(requested.pids, policy.pids))),
    outputBytes: Math.floor(Math.min(policy.outputBytes, positive(requested.outputBytes, policy.outputBytes))),
  };
}

export function workIdempotencyKey({ jobType, owner, projectId, buildId = null, key = null, payload = null }) {
  if (key) return String(key).slice(0, 200);
  const hash = crypto.createHash("sha256").update(JSON.stringify(payload || {})).digest("hex").slice(0, 24);
  return `${jobType}:${owner}:${projectId}:${buildId || "none"}:${hash}`.slice(0, 200);
}

export async function enqueueBuildWork({
  owner, projectId, buildId = null, jobType, payload = {}, idempotencyKey = null,
  priority = 0, maxAttempts = 3, resourceLimits = {}, client = null,
}) {
  const db = client || serviceClient();
  const limits = limitsFor(jobType, resourceLimits);
  const { data, error } = await db.rpc("build_work_enqueue", {
    p_owner: owner,
    p_project_id: projectId,
    p_build_id: buildId,
    p_job_type: jobType,
    p_payload: payload,
    p_idempotency_key: workIdempotencyKey({ jobType, owner, projectId, buildId, key: idempotencyKey, payload }),
    p_priority: Math.max(-100, Math.min(100, Number(priority) || 0)),
    p_max_attempts: Math.max(1, Math.min(10, Number(maxAttempts) || 3)),
    p_resource_limits: limits,
  });
  if (error) throw new Error(`build work enqueue: ${error.message}`);
  return Array.isArray(data) ? data[0] : data;
}

export async function getBuildWork(owner, jobId, { client = null, includeResult = true } = {}) {
  const db = client || serviceClient();
  const { data: job, error } = await db.from("build_work_jobs").select("*")
    .eq("id", jobId).eq("owner", owner).maybeSingle();
  if (error) throw new Error(`build work read: ${error.message}`);
  if (!job || !includeResult || !job.result_ref) return job || null;
  const { data: result, error: resultError } = await db.from("build_work_results").select("*")
    .eq("id", job.result_ref).eq("owner", owner).maybeSingle();
  if (resultError) throw new Error(`build work result read: ${resultError.message}`);
  return { ...job, workResult: result || null };
}

export async function awaitBuildWork(owner, jobId, {
  client = null, signal = null, timeoutMs = 10 * 60_000, pollMs = 500,
} = {}) {
  const started = Date.now();
  while (true) {
    if (signal?.aborted) {
      await requestBuildWorkCancel(owner, jobId, { client }).catch(() => {});
      throw Object.assign(new Error("Build work cancelled."), { name: "AbortError", code: "cancelled" });
    }
    const job = await getBuildWork(owner, jobId, { client, includeResult: true });
    if (!job) throw Object.assign(new Error("Build work not found."), { code: "not_found" });
    if (job.state === BUILD_WORK_STATES.succeeded) return job;
    if (job.state === BUILD_WORK_STATES.cancelled) throw Object.assign(new Error(job.error || "Build work cancelled."), { code: "cancelled", job });
    if (job.state === BUILD_WORK_STATES.failed) throw Object.assign(new Error(job.error || "Build work failed."), { code: job.error_classification || "worker_failed", job });
    if (Date.now() - started >= timeoutMs) {
      await requestBuildWorkCancel(owner, jobId, { client }).catch(() => {});
      throw Object.assign(new Error("Timed out waiting for build work."), { code: "wait_timeout", job });
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(50, pollMs)));
  }
}

export async function requestBuildWorkCancel(owner, jobId, { client = null } = {}) {
  const db = client || serviceClient();
  const { data, error } = await db.rpc("build_work_request_cancel", { p_owner: owner, p_job_id: jobId });
  if (error) throw new Error(`build work cancellation: ${error.message}`);
  return Array.isArray(data) ? data[0] : data;
}

export async function listBuildWorkEvents(owner, jobId, { after = 0, client = null } = {}) {
  const db = client || serviceClient();
  const { data, error } = await db.from("build_work_events")
    .select("seq,event_type,details,created_at").eq("owner", owner).eq("job_id", jobId)
    .gt("seq", Number(after) || 0).order("seq").limit(500);
  if (error) throw new Error(`build work events: ${error.message}`);
  return data || [];
}

export const __buildWorkLimits = LIMITS;
