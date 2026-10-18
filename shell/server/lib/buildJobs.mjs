// Builder V2 public-job facade.
//
// Application builds execute only as durable `builder_pipeline` work. This module owns the
// customer-visible build_jobs projection, SSE polling and cancellation; generation itself lives
// in builderV2/runtimeComposition.mjs and can run only in the isolated worker.

import crypto from "node:crypto";

import { creditsForUsage } from "../../../src/billing/costModel.mjs";
import { serviceClient } from "./supabase.mjs";
import {
  BUILD_WORK_TERMINAL, buildWorkerEnabled, dispatchBuildPipeline, getBuildWork, requestBuildWorkCancel,
} from "./buildWorkQueue.mjs";

const TERMINAL = new Set(["complete", "failed", "interrupted"]);

function db(client = null) { return (client || serviceClient()).from("build_jobs"); }

function publicResult(job) {
  if (!job.result) return null;
  const { finalText, buildOk, previewUrl, snapshotId, pipelineVersion, qualityWarnings,
    customerStatus, creditsProtected } = job.result;
  return { finalText, buildOk, previewUrl, snapshotId, pipelineVersion, qualityWarnings,
    customerStatus, creditsProtected };
}

export function isTerminal(job) { return TERMINAL.has(job.status); }

function safeTerminalError(job, customer) {
  if (!TERMINAL.has(job.status) || job.status === "complete") return null;
  if (/cancel/i.test(String(job.stopReason || ""))) return "Cancelled by user.";
  if (customer?.messageKey === "build_provider_action_required") {
    return "Your selected provider needs attention before this build can continue.";
  }
  if (customer?.actionRequired === true) {
    return "The validated scope needs your approval or clarification before generation can continue.";
  }
  return "Thrallo could not produce a verified preview. Your credits remain protected.";
}

export function publicJob(job) {
  const customer = job.result?.customerStatus || null;
  const state = customer?.state || (job.status === "complete" ? "ready"
    : TERMINAL.has(job.status) ? "failed" : /verify|compile|check/i.test(job.phase || "")
      ? "checking" : /finish|preview|promot/i.test(job.phase || "") ? "finishing" : "building");
  return {
    jobId: job.id,
    projectId: job.projectId,
    mode: job.mode,
    pipelineVersion: "v2",
    status: job.status,
    phase: state,
    error: safeTerminalError(job, customer),
    stopReason: /cancel/i.test(String(job.stopReason || "")) ? "cancelled"
      : customer?.actionRequired === true ? "action_required"
        : TERMINAL.has(job.status) && job.status !== "complete" ? "failed" : null,
    result: TERMINAL.has(job.status) ? publicResult(job) : null,
    state,
    progressLabel: customer?.progressLabel || (job.status === "complete" ? "Ready"
      : TERMINAL.has(job.status) ? "Needs attention" : "Building"),
    retrying: customer?.retrying === true,
    actionRequired: customer?.actionRequired === true,
    creditsProtected: customer?.creditsProtected !== false,
    previewUrl: customer?.previewUrl || job.result?.previewUrl || null,
    messageKey: customer?.messageKey || null,
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

export async function createJob({
  owner, projectId, mode, prompt, diag = null, trigger = "user", taskHint = null,
  budgetAllowance = null, byokCostLimit = null, providerOverride = null,
  pipelineVersion = null, manualModel = null, providerSelection = null, routingMode = null,
  v2Input = null, budgetApprovalId = null, client = null,
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

  const { data: durableExisting, error: existingError } = await db(client).select("*")
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
  try {
    const dispatched = await dispatchBuildPipeline({
      owner: owner.id, projectId, buildId: job.id, mode,
      diagRunId: diag?.sessionId || null, budgetApprovalId,
      payload: {
        input: job.input, mode, trigger, taskHint, budgetAllowance, byokCostLimit, providerOverride,
        diagSessionId: diag?.sessionId || null, pipelineVersion: "v2", manualModel, providerSelection, routingMode,
      },
      priority: trigger === "user" ? 20 : 10, client,
    });
    if (dispatched.existing) return { job: rowToJob(dispatched.job), existing: true };
    job.workJobId = dispatched.work.id;
    // The durable transaction is the authority, including after browser disconnects.
    return { job, existing: false };
  } catch (error) {
    // A database failure rolls back the whole dispatch. A lost response may have committed;
    // never mark that potentially executing job failed. A retry reads its durable authority.
    throw Object.assign(new Error(`could not dispatch build job: ${error.message}`, { cause: error }), {
      code: "build_job_create_failed",
      publicMessage: "Thrallo could not confirm the build was queued. Retry to reconnect safely.",
    });
  }
}

export async function getJob(ownerId, jobId, { client = null } = {}) {
  const { data, error } = await db(client).select("*").eq("id", jobId).eq("owner", ownerId).maybeSingle();
  if (error) throw new Error(`could not read build job: ${error.message}`);
  return data?.owner === ownerId ? rowToJob(data) : null;
}

export async function activeBuildFor(ownerId, projectId, { client = null } = {}) {
  const { data, error } = await db(client).select("*").eq("owner", ownerId).eq("project_id", projectId)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(`could not read project build: ${error.message}`);
  return data ? rowToJob(data) : null;
}

export async function activeBuildsFor(ownerId, projectIds, { client = null } = {}) {
  const ids = [...new Set((projectIds || []).filter(Boolean).map(String))];
  if (!ids.length) return new Map();
  const byProject = new Map();
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
  const job = await getJob(ownerId, jobId, { client });
  if (!job || job.owner.id !== ownerId) return { ok: false, error: "not found" };
  if (!job.workJobId) return { ok: false, error: TERMINAL.has(job.status) ? "already finished" : "work unavailable" };
  const work = await getBuildWork(ownerId, job.workJobId, { client, includeResult: false });
  if (!work || BUILD_WORK_TERMINAL.has(work.state)) return { ok: false, error: "already finished" };
  await requestBuildWorkCancel(ownerId, job.workJobId, { client });
  return { ok: true };
}

export function subscribe(job, fn, { client = null, pollMs = 750 } = {}) {
  if (!job.workJobId || TERMINAL.has(job.status)) return () => {};
  let previous = `${job.status}:${job.phase}`;
  let stopped = false;
  let reading = false;
  const tick = async () => {
    if (stopped || reading) return;
    reading = true;
    try {
      let response;
      try {
        response = await db(client).select("*").eq("id", job.id).eq("owner", job.owner.id).maybeSingle();
      } catch {
        // A lost observation is not a build failure. Retry on the next poll.
        return;
      }
      if (stopped || response.error || !response.data) return;
      const current = rowToJob(response.data);
      Object.assign(job, current, { subscribers: job.subscribers });
      const key = `${current.status}:${current.phase}`;
      if (key !== previous) {
        previous = key;
        fn("phase", { jobId: job.id, status: current.status, phase: current.phase });
      }
      if (!stopped && TERMINAL.has(current.status)) {
        stopped = true;
        clearInterval(timer);
        fn("end", publicJob(current));
      }
    } catch {
      // A closed/throwing consumer must not take down detached builds or the shell.
      stopped = true;
      clearInterval(timer);
    } finally {
      reading = false;
    }
  };
  const timer = setInterval(tick, pollMs);
  timer.unref?.();
  void tick();
  return () => { stopped = true; clearInterval(timer); };
}

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
  if (outcome.status !== "complete") {
    throw Object.assign(new Error(publicOutcome?.finalText || "Builder V2 ended without a green preview."), {
      code: outcome.failure?.code || outcome.stopReason || "builder_v2_not_green",
      classification: outcome.failure?.classification || "generated_app",
      retryable: outcome.failure?.retryable === true,
      providerCallMade: outcome.failure?.providerCallMade ?? null,
      reservationState: outcome.failure?.reservationState || null,
      checkpointId: outcome.failure?.checkpointId || outcome.bv2?.workingSnapshotId || null,
      customerActionRequired: outcome.failure?.customerActionRequired === true,
      customerMessageKey: outcome.failure?.customerMessageKey || null,
    });
  }
  return outcome;
}
