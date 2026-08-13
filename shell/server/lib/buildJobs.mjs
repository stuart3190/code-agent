// Builder V2 public-job facade.
//
// Application builds execute only as durable `builder_pipeline` work. This module owns the
// customer-visible build_jobs projection, SSE polling and cancellation; generation itself lives
// in builderV2/runtimeComposition.mjs and can run only in the isolated worker.

import crypto from "node:crypto";

import { creditsForUsage } from "../../../src/billing/costModel.mjs";
import { serviceClient } from "./supabase.mjs";
import {
  BUILD_WORK_TERMINAL, buildWorkerEnabled, enqueueBuildWork, getBuildWork, requestBuildWorkCancel,
} from "./buildWorkQueue.mjs";

const TERMINAL = new Set(["complete", "failed", "interrupted"]);
const jobs = new Map();

function db(client = null) { return (client || serviceClient()).from("build_jobs"); }

function publicResult(job) {
  if (!job.result) return null;
  const { finalText, buildOk, previewUrl, snapshotId, pipelineVersion, qualityWarnings } = job.result;
  return { finalText, buildOk, previewUrl, snapshotId, pipelineVersion, qualityWarnings };
}

export function isTerminal(job) { return TERMINAL.has(job.status); }

export function publicJob(job) {
  return {
    jobId: job.id,
    projectId: job.projectId,
    mode: job.mode,
    pipelineVersion: "v2",
    status: job.status,
    phase: job.phase,
    error: job.error || null,
    stopReason: job.stopReason || null,
    result: TERMINAL.has(job.status) ? publicResult(job) : null,
  };
}

function rowToJob(row) {
  return {
    id: row.id,
    owner: { id: row.owner },
    projectId: row.project_id,
    mode: row.mode,
    pipelineVersion: "v2",
    diagSessionId: row.diag_run_id || null,
    status: row.status,
    phase: row.phase,
    error: row.error,
    stopReason: row.stop_reason || null,
    result: row.result,
    workJobId: row.work_job_id || null,
    subscribers: new Set(),
    fromDb: true,
    createdAt: new Date(row.created_at).getTime(),
  };
}

export function activeJobFor(ownerId, projectId) {
  for (const job of jobs.values()) {
    if (job.owner.id === ownerId && String(job.projectId) === String(projectId) && !TERMINAL.has(job.status)) return job;
  }
  return null;
}

export async function createJob({
  owner, projectId, mode, prompt, diag = null, trigger = "user", taskHint = null,
  budgetAllowance = null, byokCostLimit = null, providerOverride = null,
  pipelineVersion = null, manualModel = null, providerSelection = null, routingMode = null,
  v2Input = null, budgetApprovalId = null,
}) {
  if (pipelineVersion !== "v2") {
    throw Object.assign(new Error("Builder V1 dispatch is retired; only Builder V2 jobs are accepted."), {
      code: "builder_v1_retired",
    });
  }
  if (!buildWorkerEnabled()) {
    throw Object.assign(new Error("Builder V2 requires the durable build worker; dispatch is disabled."), {
      code: "worker_required",
    });
  }

  const live = activeJobFor(owner.id, projectId);
  if (live) return { job: live, existing: true };

  const { data: durableExisting, error: existingError } = await db().select("*")
    .eq("owner", owner.id).eq("project_id", projectId)
    .in("status", ["queued", "running"]).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (existingError) throw new Error(`could not inspect active Builder V2 jobs: ${existingError.message}`);
  if (durableExisting) return { job: rowToJob(durableExisting), existing: true };

  const job = {
    id: crypto.randomUUID(), owner, projectId, mode, pipelineVersion: "v2",
    diagSessionId: diag?.sessionId || null,
    input: { prompt, ...(v2Input || {}) },
    status: "queued", phase: "queued", error: null, stopReason: null, result: null,
    trigger, taskHint, budgetAllowance, byokCostLimit, providerOverride,
    manualModel, providerSelection, routingMode,
    subscribers: new Set(), createdAt: Date.now(), workJobId: null,
  };
  const { error } = await db().insert({
    id: job.id, owner: owner.id, project_id: projectId, mode,
    status: "queued", phase: "queued", pipeline_version: "v2",
    diag_run_id: diag?.sessionId || null, budget_approval_id: budgetApprovalId,
  });
  if (error) {
    if (error.code === "23505") {
      const { data: winner } = await db().select("*").eq("owner", owner.id).eq("project_id", projectId)
        .in("status", ["queued", "running"])
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (winner) return { job: rowToJob(winner), existing: true };
    }
    throw new Error(`could not create build job: ${error.message}`);
  }

  jobs.set(job.id, job);
  try {
    const work = await enqueueBuildWork({
      owner: owner.id, projectId, buildId: job.id, jobType: "builder_pipeline",
      payload: {
        input: job.input, mode, trigger, taskHint, budgetAllowance, byokCostLimit, providerOverride,
        diagSessionId: diag?.sessionId || null, pipelineVersion: "v2", manualModel, providerSelection, routingMode,
      },
      idempotencyKey: `builder-pipeline:${job.id}`,
      priority: trigger === "user" ? 20 : 10,
      maxAttempts: 2,
    });
    job.workJobId = work.id;
    return { job, existing: false };
  } catch (queueError) {
    jobs.delete(job.id);
    const { error: markError } = await db().update({
      status: "failed", phase: "failed", error: "Build work could not be queued.",
      stop_reason: "worker_enqueue_failed", updated_at: new Date().toISOString(),
    }).eq("id", job.id).eq("owner", owner.id);
    if (markError) throw new AggregateError([queueError, markError], "Build enqueue and failure persistence both failed.");
    throw queueError;
  }
}

export async function getJob(ownerId, jobId) {
  const live = jobs.get(jobId);
  if (live) return live.owner.id === ownerId ? live : null;
  const { data } = await db().select("*").eq("id", jobId).maybeSingle();
  return data?.owner === ownerId ? rowToJob(data) : null;
}

export async function activeBuildFor(ownerId, projectId) {
  const live = activeJobFor(ownerId, projectId);
  if (live) return live;
  const { data } = await db().select("*").eq("owner", ownerId).eq("project_id", projectId)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  return data ? rowToJob(data) : null;
}

export async function activeBuildsFor(ownerId, projectIds, { client = null } = {}) {
  const ids = [...new Set((projectIds || []).filter(Boolean).map(String))];
  if (!ids.length) return new Map();
  const byProject = new Map();
  for (const job of jobs.values()) {
    if (job.owner.id !== ownerId || !ids.includes(String(job.projectId))
        || !["queued", "running"].includes(job.status)) continue;
    const prior = byProject.get(String(job.projectId));
    if (!prior || job.createdAt > prior.createdAt) byProject.set(String(job.projectId), job);
  }
  const { data, error } = await db(client).select("*").eq("owner", ownerId)
    .in("project_id", ids).in("status", ["queued", "running"])
    .order("created_at", { ascending: false });
  if (error) throw new Error(`active build summary: ${error.message}`);
  for (const row of data || []) {
    const key = String(row.project_id);
    if (!byProject.has(key)) byProject.set(key, rowToJob(row));
  }
  return new Map([...byProject].map(([projectId, job]) => [projectId, publicJob(job)]));
}

export async function cancelJob(ownerId, jobId, { client = null } = {}) {
  let job = jobs.get(jobId);
  if (!job) {
    const { data } = await db(client).select("*").eq("id", jobId).eq("owner", ownerId).maybeSingle();
    if (data) job = rowToJob(data);
  }
  if (!job || job.owner.id !== ownerId) return { ok: false, error: "not found" };
  if (!job.workJobId) return { ok: false, error: TERMINAL.has(job.status) ? "already finished" : "work unavailable" };
  const work = await getBuildWork(ownerId, job.workJobId, { client, includeResult: false });
  if (!work || BUILD_WORK_TERMINAL.has(work.state)) return { ok: false, error: "already finished" };
  await requestBuildWorkCancel(ownerId, job.workJobId, { client });
  return { ok: true };
}

export function subscribe(job, fn) {
  if (!job.workJobId || TERMINAL.has(job.status)) return () => {};
  let previous = `${job.status}:${job.phase}`;
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    const { data } = await db().select("*").eq("id", job.id).eq("owner", job.owner.id).maybeSingle();
    if (!data) return;
    const current = rowToJob(data);
    Object.assign(job, current, { subscribers: job.subscribers });
    const key = `${current.status}:${current.phase}`;
    if (key !== previous) {
      previous = key;
      fn("phase", { jobId: job.id, status: current.status, phase: current.phase });
    }
    if (TERMINAL.has(current.status)) {
      stopped = true;
      clearInterval(timer);
      jobs.delete(job.id);
      fn("end", publicJob(current));
    }
  };
  const timer = setInterval(tick, 750);
  timer.unref?.();
  void tick();
  return () => { stopped = true; clearInterval(timer); };
}

// V2 jobs are durable worker work. Shell restarts and stale in-process loops therefore have
// nothing to interrupt; the queue's lease/retry reconciliation owns recovery.
export async function sweepInterrupted() { return 0; }
export async function sweepStaleJobs() { return 0; }
export function startStaleJobSweeper() {}
export function stopStaleJobSweeper() {}
export async function interruptLiveJobs() { return 0; }

function usageBucket() {
  const total = { turns: 0, input: 0, output: 0, reasoning: 0, cached: 0, cacheWrite: 0, total: 0 };
  return {
    add(telemetry) {
      if (!telemetry) return;
      for (const key of Object.keys(total)) total[key] += Number(telemetry[key] || 0);
    },
    summary() { return { ...total }; },
  };
}

class ManagedCreditBudgetError extends Error {
  constructor(limit) {
    super(`This build exceeded its ${limit.toFixed(2)}-credit affordability limit and was stopped. Try a smaller change or top up.`);
    this.name = "ManagedCreditBudgetError";
    this.reason = "job_credit_limit";
  }
}

export function managedUsageGuard(limit, model, tracked = usageBucket()) {
  return async (turnUsage) => {
    tracked.add(turnUsage);
    const spent = creditsForUsage({ usage: tracked.summary(), model });
    if (spent > limit + 1e-9) throw new ManagedCreditBudgetError(limit);
    const minNextTurn = creditsForUsage({
      usage: { input: turnUsage.input || 0, cached: turnUsage.input || 0, output: 0 }, model,
    });
    if (spent + minNextTurn > limit + 1e-9) throw new ManagedCreditBudgetError(limit);
  };
}

export async function executeBuildPipelineWork(workJob, { signal = null, onEvent = null } = {}) {
  const payload = workJob.payload || {};
  if (payload.pipelineVersion !== "v2") {
    throw Object.assign(new Error("The durable worker refused a non-V2 Builder payload."), {
      code: "builder_v1_retired", retryable: false,
    });
  }
  if (process.env.THRALLO_BV2_KILL === "1") {
    throw Object.assign(new Error("Builder V2 is disabled by its emergency kill switch."), {
      code: "builder_v2_killed", retryable: false,
    });
  }
  const { executeBuilderV2PipelineWork } = await import("./builderV2/runtimeComposition.mjs");
  const outcome = await executeBuilderV2PipelineWork(workJob, { signal, onEvent });
  const publicOutcome = outcome.result || null;
  const terminal = outcome.status === "complete" ? "complete" : "failed";
  const { error } = await db().update({
    status: terminal,
    phase: terminal,
    error: terminal === "complete" ? null : publicOutcome?.finalText || "Builder V2 failed.",
    stop_reason: outcome.stopReason || null,
    result: publicOutcome ? { ...publicOutcome, _worker: { pipelineVersion: "v2", bv2: outcome.bv2 || null } } : null,
    updated_at: new Date().toISOString(),
  }).eq("id", workJob.build_id).eq("owner", workJob.owner);
  if (error) throw new Error(`Builder V2 public job persistence: ${error.message}`);
  return outcome;
}
