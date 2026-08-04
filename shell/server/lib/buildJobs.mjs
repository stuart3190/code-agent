// Background build jobs — the engine loop detached from the HTTP request.
//
// POST /api/generate creates a job and returns immediately; the loop runs here, owned by an
// in-memory registry (mirrors preview/index.mjs's `live` Map), with every status/phase change
// written through to Supabase `build_jobs` (service role). The client is a passive observer:
// it subscribes to a coarse phase stream and receives ONLY the vocabulary
//   queued -> preparing -> planning|building -> finalizing -> complete | failed | interrupted
// plus a whitelisted terminal result. Engine internals (model names, tool calls, file paths,
// token counts) go to the server console/journal exactly as before — they never enter any
// client-visible frame by construction: this module is the single translation point.
//
// The engine call chain (welcome grant -> BYOK lookup -> runAgent -> buildTree -> settle ->
// preview) is handleGenerate's proven body moved verbatim; the runTurn/provider seam and all
// billing/ledger code are untouched callers. Ordering preserved exactly.
//
// Persistence split (deliberate): the `projects` row stays CLIENT-written (RLS-scoped, single
// writer — see lib/supabase.mjs header). The job's terminal result lands in build_jobs.result
// so a client that reattaches later can still apply + save it. build_stderr stays server-side
// only (full of file paths) — Fix-it composes its prompt from it HERE, not in the browser.
//
// Cancellation: a flag checked in the runner's `log` callback (called by runAgent between and
// within turns, caller-side of the seam) — throwing CancelledError aborts cleanly without
// touching the engine. A cancelled/failed loop skips settle, same as today's error path: the
// mid-flight provider tokens are forfeited undebited.

import crypto from "node:crypto";
import os from "node:os";
import { runAgent } from "../../../src/engine/runAgent.mjs";
import { fromScaffold, clone } from "../../../src/engine/fileTree.mjs";
import { REACT_VITE } from "../../../src/scaffolds/reactVite.mjs";
import { makeFileTools } from "../../../src/tools/fileTools.mjs";
import { BUILD_SYSTEM_PROMPT, PLAN_SYSTEM_PROMPT, systemPromptForEdit } from "../../../src/prompts/builder.mjs";
import { creditsForUsage } from "../../../src/billing/costModel.mjs";
import { buildTree, ensureDeps, depsNodeModules } from "../../../harness/workspace.mjs";
import { preflightImports, preflightSummary } from "./appBuild/importPreflight.mjs";
import { generateContract } from "./appBuild/contractAgent.mjs";
import { classifyComplexity, profileFor } from "./appBuild/buildProfile.mjs";
import { buildManifest } from "./appBuild/projectManifest.mjs";
import { buildStageContext, renderContext, contextReport } from "./appBuild/contextBuilder.mjs";
import { makeScopedFileTools } from "./appBuild/scopedFileTools.mjs";
import { runStagedBuild, stagesSummary, primaryStageOk } from "./appBuild/stagedBuild.mjs";
import { runStageGate } from "./appBuild/stageGate.mjs";
import { honestyScan, honestyFailures } from "./appBuild/honestyScan.mjs";
import { contractBrief, contractSummary } from "../../shared/implementationContract.mjs";
// Phase 19 re-point: the credit ledger and legacy BYOK/welcome-grant seams are replaced by
// Thrallo budget accounting and the Thrallo AI-connection store. The affordability logic
// below is unchanged — it now runs against remaining monthly managed-token budget.
import { createBudgetLedger, ensureBudgetGrant as ensureWelcomeGrant } from "./appBuild/budgetLedger.mjs";
import { resolveBuildContext } from "./appBuild/buildContext.mjs";
import { previewProvider } from "../preview/index.mjs";
import { withRuntimeEnv } from "./runtimeEnv.mjs";
import { imagesConfigured, searchImages, SEARCH_IMAGES_SCHEMA, IMAGES_PROMPT_BLOCK } from "./images.mjs";
import { serviceClient } from "./supabase.mjs";
import { optionalEnv } from "./env.mjs";
import { managedAffordableCreditLimit } from "./billingLimits.mjs";
import { STOP_REASONS, providerCondition, isTransientText } from "./appBuild/endState.mjs";
import { connectorToolsForProject } from "./connectors.mjs";
import { auditCapabilityTree } from "./capabilityAudit.mjs";
import {
  DESIGN_DIRECTOR_SYSTEM_PROMPT, auditDesign, fallbackDesignProfile,
  normalizeDesignProfile, normalizeStyle, parseDesignProfile, renderDesignBrief,
} from "../../../src/design/designProfile.mjs";



// Independent per-job runaway limits. These are NOT prices or minimum balances: any positive
// managed balance may start, and settlement charges actual usage (capped at the balance remaining).

class ManagedBillingError extends Error {
  constructor(message, reason = "billing_error") { super(message); this.name = "ManagedBillingError"; this.reason = reason; }
}

// A pre-flight refusal by the oversized-request cost guard. Distinct from a crash: the
// arithmetic that refused it will refuse an identical retry, so this must never be retried.
class CostGuardError extends Error {
  constructor(message) { super(message); this.name = "CostGuardError"; }
}

class ManagedCreditBudgetError extends ManagedBillingError {
  constructor(limit) {
    super(`This build exceeded its ${limit.toFixed(2)}-credit affordability limit and was stopped. Try a smaller change or top up.`, "job_credit_limit");
    this.name = "ManagedCreditBudgetError";
  }
}

// Per-user concurrency. A single constant on purpose — the per-tier seam is "read this from the
// entitlement row instead" later.
export const MAX_CONCURRENT_BUILDS_PER_USER = 1;

const TERMINAL = new Set(["complete", "failed", "interrupted"]);
const TERMINAL_KEEP_MS = 30 * 60 * 1000; // finished jobs linger in memory for cheap reattach

// Sweep scoping: local dev and prod share ONE Supabase project, so a dev restart must only
// sweep its own orphans. Hostname is a stable-enough identity per shell process' machine.
const SERVER_ID = optionalEnv("SHELL_SERVER_ID", "") || os.hostname();

export class CancelledError extends Error {
  constructor() { super("Cancelled by user."); this.name = "CancelledError"; }
}

// ── registry ────────────────────────────────────────────────────────────────────────────────────

const jobs = new Map();   // jobId -> job (live source of truth while this process runs)
const waiting = [];       // FIFO of queued jobIds (in-process only — no external queue)

function db() { return serviceClient().from("build_jobs"); }

function serverLog(job, line) {
  console.log(`[job ${job.id.slice(0, 8)}] ${String(line)}`);
  job.diag?.terminal(line); // diagnostics: full terminal trail, never discarded
}

// Ordered write-through: chain updates per job so a slow UPDATE can't land after a later one.
function persist(job, fields) {
  job._db = job._db
    .then(() => db().update({ ...fields, updated_at: new Date().toISOString() }).eq("id", job.id))
    .then(({ error }) => { if (error) serverLog(job, `persist WARN: ${error.message}`); })
    .catch((e) => serverLog(job, `persist WARN: ${e.message}`));
  return job._db;
}

function emit(job, name, data) {
  for (const fn of job.subscribers) {
    try { fn(name, data); } catch { job.subscribers.delete(fn); }
  }
}

// The ONLY fields any client-visible frame may carry (leak gate contract). `tree`/`finalText`
// are the user's own deliverable; everything else is scalars.
function publicResult(job) {
  if (!job.result) return null;
  const { finalText, tree, buildOk, previewUrl, need, balance, designProfile, qualityWarnings } = job.result;
  return { finalText, tree, buildOk, previewUrl, need, balance, designProfile, qualityWarnings };
}

export function isTerminal(job) { return TERMINAL.has(job.status); }

export function publicJob(job) {
  return {
    jobId: job.id, projectId: job.projectId, mode: job.mode,
    status: job.status, phase: job.phase, error: job.error || null,
    // Why the job stopped, recorded where the truth was known. Status alone cannot tell a
    // user cancellation from a crash, and treating the two alike was retrying cancellations.
    stopReason: job.stopReason || null,
    result: TERMINAL.has(job.status) ? publicResult(job) : null,
  };
}

function setPhase(job, phase) {
  job.phase = phase;
  persist(job, { phase });
  emit(job, "phase", { jobId: job.id, status: job.status, phase });
}

function finish(job, status, { error = null, stopReason = null } = {}) {
  job.status = status;
  job.phase = status;
  job.error = error;
  job.stopReason = stopReason;
  job.finishedAt = Date.now();
  try { job.diag?.jobEnd(status); } catch { /* diagnostics must never break a build */ }
  persist(job, {
    status, phase: status, error, stop_reason: stopReason,
    result: job.result ? publicResult(job) : null,
    build_stderr: job.buildStderr || null,
  });
  emit(job, "end", publicJob(job));
  setTimeout(() => { if (jobs.get(job.id) === job) jobs.delete(job.id); }, TERMINAL_KEEP_MS).unref?.();
  schedule();
}

function runningFor(ownerId) {
  let n = 0;
  for (const j of jobs.values()) if (j.owner.id === ownerId && j.status === "running") n++;
  return n;
}

// FIFO with a per-user cap: skip (don't drop) queued jobs whose owner is at the cap.
function schedule() {
  for (let i = 0; i < waiting.length; ) {
    const job = jobs.get(waiting[i]);
    if (!job || job.status !== "queued") { waiting.splice(i, 1); continue; }
    if (runningFor(job.owner.id) >= MAX_CONCURRENT_BUILDS_PER_USER) { i++; continue; }
    waiting.splice(i, 1);
    job.status = "running";
    persist(job, { status: "running" });
    runJob(job).catch((e) => serverLog(job, `runner WARN (should be unreachable): ${e.message}`));
  }
}

// ── creation / lookup / cancel (the API the routes call) ────────────────────────────────────────

// One active job per project: creating while one runs returns the existing job (client just
// subscribes to it) instead of stacking a second build of the same app.
export function activeJobFor(ownerId, projectId) {
  for (const j of jobs.values()) {
    if (j.owner.id === ownerId && j.projectId === projectId && !TERMINAL.has(j.status)) return j;
  }
  return null;
}

export async function createJob({ owner, projectId, mode, prompt, tree, plan, knowledge, style, designProfile, redesign, diag = null, trigger = "user", taskHint = null, budgetAllowance = null, byokCostLimit = null, providerOverride = null }) {
  const existing = activeJobFor(owner.id, projectId);
  if (existing) return { job: existing, existing: true };

  const job = {
    id: crypto.randomUUID(),
    owner, projectId, mode,
    input: { prompt, tree, plan, knowledge, style, designProfile, redesign }, // in-memory only; restart sweeps the job
    status: "queued", phase: "queued", error: null,
    result: null, buildStderr: null,
    diag,                                  // diagnostics recorder (nullable, never throws)
    trigger,                               // user | autonomous_repair | verification_repair | external | scheduled
    taskHint,                              // the USER's own words, for task classification
    budgetAllowance,                       // managed: what the LIFECYCLE budget has left for this job
    byokCostLimit,                         // BYOK: only set when the user enabled a per-build limit
    providerOverride,                      // set by a fallback switch — continue on a different provider
    stopReason: null,                      // set at finish() — why this job stopped
    measurements: null,                    // server-side only: what the relay compares between rounds
    cancelled: false,
    subscribers: new Set(),
    createdAt: Date.now(), finishedAt: null,
    _db: Promise.resolve(),
  };
  const { error } = await db().insert({
    id: job.id, owner: owner.id, project_id: projectId, mode,
    status: "queued", phase: "queued", server_id: SERVER_ID,
  });
  if (error) throw new Error(`could not create build job: ${error.message}`);
  jobs.set(job.id, job);
  waiting.push(job.id);
  schedule();
  return { job, existing: false };
}

// Registry first, DB fallback (terminal jobs evicted from memory, or from before a restart).
// Owner-checked HERE so no route can forget it.
export async function getJob(ownerId, jobId) {
  const live = jobs.get(jobId);
  if (live) return live.owner.id === ownerId ? live : null;
  const { data } = await db().select("*").eq("id", jobId).maybeSingle();
  if (!data || data.owner !== ownerId) return null;
  return rowToJob(data);
}

// The running (or else most recent) job for a project — the reattach-on-open query.
export async function activeBuildFor(ownerId, projectId) {
  const live = activeJobFor(ownerId, projectId);
  if (live) return live;
  let newest = null;
  for (const j of jobs.values()) {
    if (j.owner.id === ownerId && j.projectId === projectId && (!newest || j.createdAt > newest.createdAt)) newest = j;
  }
  if (newest) return newest;
  const { data } = await db().select("*").eq("owner", ownerId).eq("project_id", projectId)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  return data ? rowToJob(data) : null;
}

function rowToJob(row) {
  return {
    id: row.id, owner: { id: row.owner }, projectId: row.project_id, mode: row.mode,
    status: row.status, phase: row.phase, error: row.error,
    result: row.result, buildStderr: row.build_stderr,
    subscribers: new Set(), fromDb: true,
    createdAt: new Date(row.created_at).getTime(), finishedAt: null, _db: Promise.resolve(),
  };
}

export async function cancelJob(ownerId, jobId) {
  const job = jobs.get(jobId);
  if (!job || job.owner.id !== ownerId) return { ok: false, error: "not found" };
  if (TERMINAL.has(job.status)) return { ok: false, error: "already finished" };
  job.cancelled = true;
  if (job.status === "queued") {
    const i = waiting.indexOf(job.id);
    if (i >= 0) waiting.splice(i, 1);
    finish(job, "failed", { error: "Cancelled by user.", stopReason: STOP_REASONS.cancelled });
  }
  // Running: the log-callback check throws CancelledError between engine turns.
  return { ok: true };
}

// Subscribe to a job's coarse events. Returns unsubscribe. The caller (SSE route) sends the
// snapshot itself via publicJob() — the snapshot IS the replay: phases are monotonic, so
// current state supersedes any missed transitions (no ring buffer needed).
export function subscribe(job, fn) {
  if (job.fromDb || TERMINAL.has(job.status)) return () => {};
  job.subscribers.add(fn);
  return () => job.subscribers.delete(fn);
}

// Latest failed-build stderr for a project — the server-side half of "Fix it" (stderr never
// reaches the browser; it is full of file paths).
export async function latestBuildStderr(ownerId, projectId) {
  for (const j of [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt)) {
    if (j.owner.id === ownerId && j.projectId === projectId && j.buildStderr) return j.buildStderr;
  }
  const { data } = await db().select("build_stderr").eq("owner", ownerId).eq("project_id", projectId)
    .not("build_stderr", "is", null).order("created_at", { ascending: false }).limit(1).maybeSingle();
  return data?.build_stderr || null;
}

// Startup sweep: rows this server left non-terminal are dead (their in-memory loop is gone).
// Scoped to OUR server_id — never touch another environment's running jobs.
export async function sweepInterrupted() {
  const { data, error } = await db()
    .update({ status: "interrupted", phase: "interrupted",
      error: "Build was interrupted by a server restart — please rebuild.",
      updated_at: new Date().toISOString() })
    .in("status", ["queued", "running"]).eq("server_id", SERVER_ID).select("id");
  if (error) console.log(`[jobs] sweep WARN: ${error.message}`);
  else if (data?.length) console.log(`[jobs] swept ${data.length} interrupted job(s) from a previous run`);
}

// Catch rows abandoned by one-off test servers, killed hosts, or renamed server identities. The
// normal per-server sweep above is immediate; this cross-server sweep only touches jobs old enough
// that no legitimate build should still be running.
export async function sweepStaleJobs(maxAgeMs = 90 * 60 * 1000) {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const { data, error } = await db()
    .update({ status: "interrupted", phase: "interrupted",
      error: "Build was interrupted before it could finish — please rebuild.",
      updated_at: new Date().toISOString() })
    .in("status", ["queued", "running"]).lt("created_at", cutoff).select("id");
  if (error) console.log(`[jobs] stale sweep WARN: ${error.message}`);
  else if (data?.length) console.log(`[jobs] swept ${data.length} stale job(s)`);
}

/**
 * Keep sweeping while the server is up.
 *
 * The stale sweep ran only at boot, so it caught a build orphaned by a restart and nothing else. A
 * build that stopped making progress on a server that stayed up — a runner wedged on a provider, a
 * job whose loop threw somewhere unhandled — was never swept at all: it kept `running` until the
 * next deploy. On a healthy service that can be weeks, and "building" is what the customer sees
 * for all of it.
 */
let staleTimer = null;
export function startStaleJobSweeper({ intervalMs = 10 * 60 * 1000 } = {}) {
  if (staleTimer) return;
  staleTimer = setInterval(() => {
    sweepStaleJobs().catch((error) => console.log(`[jobs] stale sweep failed: ${error.message}`));
  }, Math.max(intervalMs, 60_000));
  staleTimer.unref?.();
}

export function stopStaleJobSweeper() {
  if (staleTimer) clearInterval(staleTimer);
  staleTimer = null;
}

export async function interruptLiveJobs(reason = "Build was interrupted by a server restart — please rebuild.") {
  const active = [...jobs.values()].filter((job) => !TERMINAL.has(job.status));
  await Promise.all(active.map(async (job) => {
    job.cancelled = true;
    finish(job, "interrupted", { error: reason });
    await job._db;
  }));
  return active.length;
}

// ── the runner — handleGenerate's proven engine body, verbatim, minus the res coupling ─────────

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

function managedUsageGuard(limit, model, tracked = usageBucket()) {
  return async (turnUsage) => {
    tracked.add(turnUsage);
    if (creditsForUsage({ usage: tracked.summary(), model }) > limit + 1e-9) {
      throw new ManagedCreditBudgetError(limit);
    }
  };
}

async function directDesign({ provider, prompt, projectId, style, knowledge, plan, log, onUsage }) {
  const context = { prompt, projectId, style: normalizeStyle(style) };
  const fallback = fallbackDesignProfile(context);
  const request = JSON.stringify({
    productRequest: prompt,
    requestedStyle: context.style,
    projectKnowledge: knowledge || undefined,
    approvedPlan: plan || undefined,
    variationSeed: projectId,
    fallbackFamilyToBeat: fallback.family,
  });
  try {
    const out = await runAgent({
      provider, systemPrompt: DESIGN_DIRECTOR_SYSTEM_PROMPT,
      tools: [], toolImpls: {}, tree: {}, prompt: request, log, onUsage,
    });
    return { profile: parseDesignProfile(out.finalText, context), telemetry: out.telemetry };
  } catch (e) {
    if (e instanceof ManagedCreditBudgetError) throw e;
    log(`design: director unavailable (${e.message}) — using deterministic premium brief`);
    return { profile: fallback, telemetry: null };
  }
}

async function preparePhotography(profile, log) {
  if (!profile?.imagery?.required) return { assets: [], unavailable: false };
  if (!imagesConfigured()) {
    // Names what it costs, not just what is missing: this design profile asked for photographs and
    // will not get any, so the app ships with placeholder imagery.
    log("design: this design needs photographs and none are available — PEXELS_API_KEY is not configured on this deployment, so the app will be built with placeholder imagery instead");
    return { assets: [], unavailable: true };
  }
  const queries = [...(profile.imagery.queries || []), `${profile.category} authentic premium photography`];
  const assets = [];
  const seen = new Set();
  for (const query of queries.slice(0, 3)) {
    if (assets.length >= 6) break;
    try {
      const photos = await searchImages(query, { count: 8, orientation: "landscape" });
      for (const photo of photos || []) {
        if (!photo?.url || seen.has(photo.url)) continue;
        seen.add(photo.url);
        assets.push(photo);
      }
    } catch (e) {
      log(`design: image search retry needed (${e.message})`);
    }
  }
  if (!assets.length) log("design: photo search returned no usable results after retry");
  else log(`design: prepared ${assets.length} approved photo options`);
  return { assets: assets.slice(0, 8), unavailable: assets.length === 0 };
}

// What changed in this round, and how healthy the result is. Pure measurement — the
// judgement about whether it counts as progress lives in repairProgress.mjs.
function measureRound({ baseline, tree, build, usage, credits, model, previewUrl, qualityWarnings }) {
  let diffChars = 0;
  // The PATHS, not just the count. A repair brief that can say "your last patch touched
  // src/lib/format.js" lets the next round notice it edited something the error never named —
  // which is precisely what went unnoticed when two repairs in a row edited the wrong file.
  const changedPaths = [];
  const paths = new Set([...Object.keys(baseline || {}), ...Object.keys(tree || {})]);
  for (const path of paths) {
    const before = baseline?.[path];
    const after = tree?.[path];
    if (before === after) continue;
    changedPaths.push(path);
    diffChars += Math.abs(String(after || "").length - String(before || "").length)
      || Math.max(String(after || "").length, String(before || "").length);
  }
  const filesChanged = changedPaths.length;
  // Compiler error lines: a count, so "fewer errors than last round" is measurable.
  const stderr = build?.ok ? "" : String(build?.stderr || "");
  const compilerErrorCount = stderr
    ? (stderr.match(/^.*\b(error|ERROR)\b.*$/gm) || []).length || (stderr ? 1 : 0)
    : 0;
  return {
    compileOk: Boolean(build?.ok),
    compilerErrorCount,
    previewOk: Boolean(previewUrl),
    filesChanged,
    changedPaths,
    diffChars,
    qualityWarnings: [...(qualityWarnings || [])],
    usage: { ...usage },
    turns: Number(usage?.turns || 0),
    credits: Number(credits) || 0,
    model,
  };
}

async function runJob(job) {
  const { prompt, tree: inputTree, plan, knowledge, style, designProfile: inputDesignProfile, redesign,
    contract: inputContract, maxTurns: inputMaxTurns } = job.input;
  const projectId = job.projectId;
  const mode = job.mode;
  const owner = job.owner;
  const led = createBudgetLedger();
  let failureMeter = null;

  const withKnowledge = (p) =>
    knowledge ? `${p}\n\nProject knowledge (standing instructions — always apply):\n${knowledge}` : p;

  try {
    setPhase(job, "preparing");

    // BYOK: if the owner's active Thrallo AI connection is their own Anthropic/OpenAI key,
    // generation runs on THEIR account and consumes no managed budget. The decrypted key
    // stays server-side (never in any frame, never logged). Otherwise: Thrallo managed OpenAI.
    const buildContext = await resolveBuildContext(owner.id, { preferProvider: job.providerOverride });
    const byok = buildContext.byok;
    job.diag?.setByok?.(byok); // stamps ai_requests so BYOK spend is separable from managed
    const providerConfig = { provider: buildContext.providerLabel, strong: buildContext.strongModel };
    const buildProvider = buildContext.buildProvider;

    await ensureWelcomeGrant(owner.id);
    const preBal = await led.getBalance(owner.id);
    // Per-job runaway cap, further reduced by whatever the LIFECYCLE budget has left — a
    // follow-up job no longer receives a completely fresh independent allowance.
    const perJobLimit = managedAffordableCreditLimit({ balance: preBal.total, mode, redesign });
    const jobCreditLimit = job.budgetAllowance == null
      ? perJobLimit
      : Math.min(perJobLimit, Number(job.budgetAllowance) || 0);
    const trackedUsage = usageBucket();
    failureMeter = byok ? null : { trackedUsage, model: providerConfig.strong };
    // BYOK has NO mandatory cap: a guard exists only when the user enabled a per-build
    // limit themselves. Managed builds always carry one.
    const onUsage = byok
      ? (job.byokCostLimit ? managedUsageGuard(Number(job.byokCostLimit), providerConfig.strong, trackedUsage) : null)
      : managedUsageGuard(jobCreditLimit, providerConfig.strong, trackedUsage);

    // Managed jobs are post-metered. Charge exact usage when the balance covers it; otherwise
    // consume the remaining prepaid balance down to zero. That lets a customer use every last
    // credit on a final change without creating debt or an unlimited free-build loophole.
    async function settle(telemetry, model, kind) {
      if (byok) {
        serverLog(job, `billing: BYOK — ${telemetry.total} tok billed to the user's ${providerConfig.provider} key`);
        return { need: 0, balance: preBal };
      }
      const ref = `${kind}:${projectId}:${crypto.randomUUID()}`;
      const charged = await led.debit({ owner: owner.id, usage: telemetry, model, ref, allowPartial: true });
      if (!charged.ok) {
        if (charged.reason === "hard_ceiling") {
          throw new ManagedBillingError("Your monthly managed-usage safety limit has been reached. No credits were charged.", charged.reason);
        }
        throw new ManagedBillingError("We could not confirm the credit charge. No credits were charged; please try again.", charged.reason);
      }
      const need = charged.debited;
      const balance = await led.getBalance(owner.id);
      const capped = charged.partial ? ` (actual ${charged.need.toFixed(4)} cr; used remaining balance)` : "";
      serverLog(job, `billing: debited ${need.toFixed(4)} cr${capped} (model ${model}, ${telemetry.total} raw tok, cache-adjusted) -> balance ${balance.total.toFixed(4)} cr`);
      return { need, balance };
    }

    // Cancellation seam: runAgent calls `log` between/within turns (caller-side of the seam);
    // throwing here aborts the loop cleanly without touching the engine.
    const log = (line) => {
      if (job.cancelled) throw new CancelledError();
      serverLog(job, line);
    };

    // ── PLAN-ONLY pass ──────────────────────────────────────────────────────────────────────
    if (mode === "plan") {
      const provider = buildProvider("generate");
      serverLog(job, `engine: plan on model ${provider.model} — plan-only pass, no build${byok ? " · BYOK" : ""}`);
      setPhase(job, "planning");

      let planSystemPrompt = PLAN_SYSTEM_PROMPT;
      try {
        const capabilityContext = await connectorToolsForProject(owner.id, projectId);
        if (capabilityContext.manifest?.length) {
          planSystemPrompt = `${planSystemPrompt}\n\nAVAILABLE SERVER ACTIONS FOR THIS APP:\n${JSON.stringify(capabilityContext.manifest, null, 2)}\nPlan only with these exact action keys and input/output schemas. Do not invent provider calls, credentials, or unavailable backend features.`;
        }
      } catch (error) {
        serverLog(job, `capabilities: plan context unavailable (${error.message})`);
      }

      const planStarted = Date.now();
      const { telemetry, finalText } = await runAgent({
        provider, systemPrompt: planSystemPrompt, tools: [], toolImpls: {},
        tree: {}, prompt: withKnowledge(prompt), log, onUsage,
      });
      if (job.cancelled) throw new CancelledError();
      job.diag?.step({
        agent: "Planner", kind: "agent", label: "Plan generation",
        prompt: withKnowledge(prompt), output: finalText,
        usage: telemetry, model: provider.model, durationMs: Date.now() - planStarted,
      });

      const { need, balance } = await settle(telemetry, provider.model, "plan");
      job.result = { finalText, need, balance: balance.total };
      return finish(job, "complete");
    }

    // ── BUILD / ITERATE pass ────────────────────────────────────────────────────────────────
    const intent = mode === "iterate" ? "edit" : "generate";
    const provider = buildProvider(intent);
    job.diag?.setModel?.(provider.model);

    const combinedUsage = usageBucket();
    const needsDesignPass = mode === "build" || redesign === true;
    let designProfile = inputDesignProfile
      ? normalizeDesignProfile(inputDesignProfile, { prompt, projectId, style })
      : null;
    let photography = { assets: [], unavailable: false };
    if (needsDesignPass) {
      setPhase(job, "designing");
      const designStarted = Date.now();
      const directed = await directDesign({
        provider: buildProvider("generate"), prompt, projectId, style, knowledge, plan, log, onUsage,
      });
      designProfile = directed.profile;
      combinedUsage.add(directed.telemetry);
      job.diag?.step({
        agent: "Designer", kind: "agent", label: "Design direction",
        prompt, output: JSON.stringify(designProfile, null, 2),
        usage: directed.telemetry, model: buildProvider("generate").model,
        durationMs: Date.now() - designStarted,
      });
      photography = await preparePhotography(designProfile, log);
    }

    // ── IMPLEMENTATION CONTRACT (PR4) ────────────────────────────────────────────────────────
    //
    // What "built" means for this request, as observable outcomes. `diag_runs.plan` was null on
    // both failed production runs, and the plan the planner did produce was prose — so nothing
    // downstream could ask "did the booking actually persist?", because nothing had written down
    // that it must. The contract is what the Builder is told, what a repair is judged against, and
    // what the journey verifier drives.
    //
    // Only for fresh builds: an iterate has a contract already, carried on the run it belongs to.
    let contract = inputContract || null;
    if (mode === "build" && !contract) {
      const contractStarted = Date.now();
      try {
        const result = await generateContract({
          provider: buildProvider("generate"), prompt, knowledge, log, onUsage,
        });
        contract = result.contract;
        combinedUsage.add(result.usage);
        job.diag?.step({
          agent: "Planner", kind: "contract", label: "Implementation contract",
          prompt, status: contract ? "ok" : "failed",
          output: contract
            ? `${contractSummary(contract)}\n\n${JSON.stringify(contract, null, 2)}`
            : `No usable contract after ${result.attempts} attempts:\n${result.problems.join("\n")}`,
          usage: result.usage, model: buildProvider("generate").model,
          durationMs: Date.now() - contractStarted,
        });
        if (contract) {
          job.diag?.setContract(contract);
          serverLog(job, `contract: ${contractSummary(contract)}`);
        }
      } catch (error) {
        // A contract is leverage, not a prerequisite. Losing it costs verification; blocking the
        // build on it would cost the customer their app.
        serverLog(job, `contract: unavailable (${error.message})`);
      }
    }
    job.contract = contract;

    // Iterate/repair jobs dispatched server-side (relay repairs, verification repairs,
    // repair_app) carry no client tree — hydrate the stored project tree. Building an
    // "edit" from an empty tree produced ENOENT repair rounds (diagnostics 17e00fd2).
    let iterateBase = inputTree;
    if (mode === "iterate" && (!iterateBase || !Object.keys(iterateBase).length)) {
      const { data: stored } = await serviceClient().from("projects")
        .select("tree").eq("id", projectId).eq("owner", owner.id).maybeSingle();
      iterateBase = stored?.tree || null;
      if (!iterateBase || !Object.keys(iterateBase).length) {
        throw new Error("iterate: no tree was provided and the project has no stored tree to edit");
      }
      serverLog(job, `iterate: hydrated stored project tree (${Object.keys(iterateBase).length} files)`);
    }
    const tree = mode === "iterate" ? { ...iterateBase } : clone(fromScaffold(REACT_VITE));
    const diagBaseline = { ...tree }; // snapshot for created/modified/deleted + diffs

    // Scoped context (audit 2026-08-01): edits and repairs run in seeded context-selection
    // mode — entry file + direct imports ride along, everything else stays paths-only, and
    // the engine prunes accumulated tool payloads out of re-sent history. Builds author
    // from a scaffold and keep the default loop. Never blocks a user-triggered job.
    const { scopeForJob, costGuard } = await import("./appBuild/contextScope.mjs");
    const scope = scopeForJob({
      mode, prompt, redesign, trigger: job.trigger || "user",
      // Classify from the USER's request when we have it: capability wrappers like
      // "REPAIR MODE — fix ONLY this reported problem" would otherwise make every
      // conversational edit look like debugging and poison the per-task learning.
      classifyPrompt: job.taskHint || prompt,
      tree: mode === "iterate" ? tree : null,
    });
    for (const warning of scope.warnings) serverLog(job, `context: WARN ${warning}`);
    const guard = costGuard({ estContextTokens: scope.estContextTokens, model: provider.model, trigger: job.trigger || "user" });
    if (guard.blocked) {
      throw new CostGuardError(`This ${scope.taskType} is projected at ~${guard.projectedCredits} credits — above the ${guard.threshold}-credit autonomous ceiling. It needs explicit approval before running.`);
    }
    serverLog(job, `context: ${scope.taskType} budget ${scope.budgetTokens} tok · est ${scope.estContextTokens} tok · ${scope.contextSelection ? `seeded ${scope.files.map((f) => f.path).join(", ")}` : "scaffold build"}`);
    if (mode === "iterate") {
      // The backend SDK is a protected platform seam, not user-authored app code. Persist the
      // latest version into edited legacy projects so future exports and builds keep new APIs.
      tree["src/lib/backend/index.js"] = REACT_VITE["src/lib/backend/index.js"];
      tree["src/lib/backend/supabaseBackend.js"] = REACT_VITE["src/lib/backend/supabaseBackend.js"];
    }
    const editFormat = mode === "iterate" ? "apply_patch" : undefined;
    const { schemas, impls } = makeFileTools(tree, { editFormat });
    const approvedPhotos = [...photography.assets];
    const approvedPhotoUrls = new Set(approvedPhotos.map((photo) => photo.url));

    let tools = schemas;
    let toolImpls = impls;
    let systemPrompt = mode === "iterate" ? systemPromptForEdit(editFormat) : BUILD_SYSTEM_PROMPT;
    let capabilityManifest = [];
    try {
      const connectors = await connectorToolsForProject(owner.id, projectId);
      capabilityManifest = connectors.manifest || [];
      if (connectors.promptBlock) {
        if (connectors.schemas.length) tools = [...tools, ...connectors.schemas];
        if (connectors.schemas.length) toolImpls = { ...toolImpls, ...connectors.impls };
        systemPrompt = `${systemPrompt}\n\n${connectors.promptBlock}`;
      }
    } catch (error) {
      serverLog(job, `connectors: unavailable (${error.message})`);
    }
    if (imagesConfigured()) {
      tools = [...tools, SEARCH_IMAGES_SCHEMA];
      toolImpls = {
        ...toolImpls,
        search_images: async ({ query, count, orientation }) => {
          try {
            const photos = await searchImages(query, { count, orientation });
            for (const photo of photos || []) {
              if (!photo?.url || approvedPhotoUrls.has(photo.url)) continue;
              approvedPhotoUrls.add(photo.url);
              approvedPhotos.push(photo);
            }
            return { photos };
          } catch (e) {
            return { error: `image search unavailable (${e.message}) — build without photos`, photos: [] };
          }
        },
      };
      systemPrompt = `${systemPrompt}\n${IMAGES_PROMPT_BLOCK}`;
    }

    if (needsDesignPass && designProfile) {
      systemPrompt = `${systemPrompt}\n\n${renderDesignBrief(designProfile, approvedPhotos)}`;
    } else if (designProfile) {
      systemPrompt = `${systemPrompt}\n\nPERSISTED DESIGN DIRECTION: Preserve the existing ${designProfile.family} visual family, ${designProfile.typography.display}/${designProfile.typography.body} typography, and established palette unless the user's edit explicitly asks to change the visual direction.`;
    }

    serverLog(job, `engine: ${mode} on model ${provider.model} — ${provider.decision?.reason || ""}${plan ? " · steering by approved plan" : ""}`);
    setPhase(job, "building");

    let enginePrompt = withKnowledge(plan
      ? `${prompt}\n\nAn approved implementation plan for this app follows. Build according to it:\n\n${plan}`
      : prompt);
    // The contract goes LAST, after the request and any approved plan, because it is the thing the
    // result is actually measured against — the prose above says what to build, this says what
    // will be checked. An agent that reads only the tail still reads the checks.
    if (contract) enginePrompt = `${enginePrompt}\n\n${contractBrief(contract)}`;
    if (redesign === true) {
      enginePrompt = `This is an explicit full-product frontend redesign. Preserve every working feature, route, data flow, form, and important piece of content while comprehensively replacing the visual system and composition. Read the shared shell and EVERY reachable screen component before editing. Apply one premium design language to the public page, dashboard, navigation destinations, forms, tables, calendars, modals, empty states and mobile menu. Keep an obvious route back to the public site from the app. At 360px, large mockups and floating panels must return to normal document flow and nothing may collide, clip or overlap unintentionally. Do not stop after making the landing page attractive.\n\n${enginePrompt}`;
    }

    const builderStarted = Date.now();
    // Each stage narrates what it did; the customer-facing summary is those, joined.
    const finalTextParts = [];
    // ── STAGED GENERATION (PR5) ──────────────────────────────────────────────────────────────
    //
    // A fresh build with a contract is generated in five gated stages instead of one turn, so a
    // fault in the foundation is found before 27 files rest on it, and a late failure has a green
    // tree to fall back to. Iterates and contract-less builds keep the single-turn path: staging
    // an edit would be five model calls to change one line, and staging without a contract has no
    // basis on which to allocate the work.
    const staged = mode === "build" && contract && !job.disableStaging;
    // Bound how many times a stage may re-read the project. Measured: the later a stage runs the
    // larger the tree it re-reads, and Supporting screens reached a 37:1 input-to-output ratio.
    const stageTurnCap = profileFor(
      classifyComplexity({ prompt, contract }).level,
    ).maxStageTurns;
    // Hard ceiling on what any one stage may be handed, enforced before the call.
    const stageContextBudget = 40_000;
    let initial;
    let stageReport = null;

    if (staged) {
      setPhase(job, "building");
      const stageResult = await runStagedBuild({
        contract, tree, request: prompt,
        // The design audit + polish turn below already does the visual pass.
        includePolish: !designProfile,
        log: (line) => serverLog(job, line),
        cancelled: () => job.cancelled,
        runStage: async (stage, { tree: stageTree, prompt: stagePromptText, mode: stageMode, attempt }) => {
          const stageStarted = Date.now();
          // The first stage authors from the scaffold; every later one edits what exists, so it
          // gets the edit prompt and apply_patch rather than whole-file rewrites.
          const first = stage.id === "foundation" && attempt === 0;
          // SELECTIVE CONTEXT. Rebuilt each stage because earlier stages have written files; it
          // costs no model call and is about 4% of the tree.
          const stageManifest = buildManifest(stageTree, { contract });
          const selected = buildStageContext({
            tree: stageTree, manifest: stageManifest, stageId: stage.id, contract,
            objective: stagePromptText,
            systemPrompt: first ? systemPrompt : systemPromptForEdit("apply_patch"),
            budgetTokens: stageContextBudget,
          });

          // Enforced at the TOOL boundary too. A small initial context achieves nothing if the
          // model then reads its way back to the whole project — which is exactly what produced the
          // 292,652-token stage: overwhelmingly repeated reads, 81% of them cached.
          const stageTools = makeScopedFileTools(stageTree, {
            manifest: stageManifest,
            allowed: selected.full.map((c) => c.path),
            editFormat: first ? undefined : "apply_patch",
            onEvent: (event) => {
              if (event.type === "expanded") serverLog(job, `context: expanded ${event.path} (+${event.tokens} tok) — ${String(event.reason).slice(0, 70)}`);
              if (event.type === "refused") serverLog(job, `context: refused ${event.path} — ${event.why}`);
            },
          });

          serverLog(job, contextReport(selected).split("\n")[0]);
          if (!selected.ok) serverLog(job, `context: OVER BUDGET for ${stage.id} — ${selected.tokens}/${selected.budget}`);

          const turn = await runAgent({
            provider,
            systemPrompt: first ? systemPrompt : `${systemPromptForEdit("apply_patch")}\n\n${designProfile ? renderDesignBrief(designProfile, approvedPhotos) : ""}`,
            tools: stageTools.schemas, toolImpls: stageTools.impls,
            tree: stageTree,
            // The selected context leads: manifest, the files this stage may modify, summaries for
            // everything else. The stage objective follows it.
            prompt: `${renderContext(selected, stageTree, stageManifest)}\n\n${stagePromptText}`,
            log, onUsage,
            maxTurns: stageTurnCap,
          });

          // What it was given, what it asked for, and whether it rebuilt the tree anyway.
          const rebuilt = stageTools.reconstructedTree(Object.keys(stageTree).length);
          if (rebuilt) serverLog(job, `context: WARNING — ${stage.id} reconstructed more than half the tree through tools`);
          job.contextTelemetry = job.contextTelemetry || [];
          job.contextTelemetry.push({
            stage: stage.id, attempt,
            initialTokens: selected.tokens, budget: selected.budget,
            wholeTreeTokens: selected.wholeTreeTokens,
            fullFiles: selected.full.length, summaries: selected.summaries.length,
            omitted: selected.omitted.length,
            expansions: stageTools.telemetry.expansionCount,
            expansionTokens: stageTools.telemetry.expansionTokens,
            summaryReads: stageTools.telemetry.summaryReads.length,
            refusals: stageTools.telemetry.refusals.length,
            reconstructedTree: rebuilt,
            reasons: selected.full.map((c) => ({ path: c.path, reason: c.reason })),
            usage: turn.telemetry,
          });
          combinedUsage.add(turn.telemetry);
          if (job.cancelled) throw new CancelledError();
          job.diag?.step({
            agent: "Builder", kind: "agent",
            label: `${stage.title}${stageMode === "repair" ? ` — repair ${attempt}` : ""}`,
            prompt: stagePromptText, output: turn.finalText,
            usage: turn.telemetry, model: provider.model, durationMs: Date.now() - stageStarted,
          });
          finalTextParts.push(turn.finalText);
        },
        gate: async (stageTree) => {
          const runtime = withRuntimeEnv(stageTree, projectId);
          return runStageGate(runtime, {
            nodeModules: depsNodeModules(),
            baseline: REACT_VITE,
            log: (line) => serverLog(job, line),
            compile: async (candidate) => buildTree(
              candidate, `stage-${projectId}`.replace(/[^a-zA-Z0-9_-]/g, "_"), () => {},
            ),
          });
        },
        checkpoint: ({ tree: greenTree, stage, label, changedFiles }) => {
          // A green stage IS the fallback, so it is checkpointed from the gated tree only.
          job.onStageCheckpoint?.({ tree: greenTree, stage, label, changedFiles });
        },
        onStageStart: (stage, index, total) => {
          serverLog(job, `stage ${index + 1}/${total}: ${stage.title}`);
          emit(job, "stage", { jobId: job.id, stage: stage.id, title: stage.title, index, total });
        },
        onStageEnd: (stage, result) => {
          job.diag?.step({
            agent: "Compiler", kind: "stage_gate", label: `${stage.title} gate`,
            status: result.ok ? "ok" : "failed",
            output: [
              `${result.ok ? "GREEN" : "LOST"} after ${result.repairs} repair(s)`,
              `checks: ${(result.checks || []).map((c) => `${c.name}:${c.ok ? "ok" : "FAILED"}`).join(" ")}`,
              `files: ${result.changedFiles.join(", ") || "none"}`,
              ...(result.problems || []).map((p) => `problem: ${p}`),
            ].join("\n"),
            durationMs: result.durationMs,
          });
        },
      });

      // The delivered tree is the last GREEN one — never whatever a failed stage left behind.
      for (const path of Object.keys(tree)) if (!(path in stageResult.tree)) delete tree[path];
      Object.assign(tree, stageResult.tree);
      stageReport = stageResult;
      job.stages = stageResult.stages;
      serverLog(job, `staged build: ${stagesSummary(stageResult.stages)}`);
      initial = { telemetry: null, finalText: finalTextParts.filter(Boolean).join("\n\n") };
    } else {
      // ── REPAIR CONTEXT v2 ──────────────────────────────────────────────────────────────────
      //
      // Staged generation was moved onto selective context and this path was left on the whole
      // tree, which made repair 60% of the last build's cost: one call read 288,270 input tokens
      // against 7,880 out — 36.6:1 — for 23.69 credits, while the largest staged call was 6.29.
      //
      // A repair gets the failing files, their direct callers and imports, the shared interfaces,
      // the contract fragment and the exact findings. Nothing else, and it cannot read its way
      // back to the rest.
      const repairing = mode === "iterate";
      let repairTools = { schemas: tools, impls: toolImpls };
      let repairPrompt = enginePrompt;
      let repairSelection = null;

      if (repairing) {
        const repairManifest = buildManifest(tree, { contract });
        // The files the verifier and the diagnostics actually named — that is the change set.
        const named = [...new Set([
          ...String(enginePrompt).matchAll(/\b(src\/[\w./-]+\.(?:jsx?|tsx?|css))\b/g),
        ].map((m) => m[1]))].filter((p) => tree[p]);

        repairSelection = buildStageContext({
          tree, manifest: repairManifest, stageId: "repair", contract,
          objective: enginePrompt, systemPrompt,
          failures: named.length ? named : [],
          budgetTokens: 20_000,
        });
        const scoped = makeScopedFileTools(tree, {
          manifest: repairManifest,
          allowed: repairSelection.full.map((c) => c.path),
          editFormat: "apply_patch",
          maxExpansions: 4,
          maxExpansionTokens: 8_000,
          onEvent: (event) => {
            if (event.type === "expanded") serverLog(job, `repair context: expanded ${event.path} (+${event.tokens} tok)`);
            if (event.type === "refused") serverLog(job, `repair context: refused ${event.path}`);
          },
        });
        repairTools = { schemas: scoped.schemas, impls: scoped.impls };
        repairPrompt = `${renderContext(repairSelection, tree, repairManifest)}\n\n${enginePrompt}`;
        job.repairScope = scoped;
        serverLog(job, `repair context: ${repairSelection.tokens} tokens of ${repairSelection.budget} `
          + `(whole tree ${repairSelection.wholeTreeTokens}) · ${repairSelection.full.length} full, `
          + `${repairSelection.omitted.length} omitted`);
      }

      initial = await runAgent({
        provider, systemPrompt,
        tools: repairTools.schemas, toolImpls: repairTools.impls,
        tree, prompt: repairPrompt, log, onUsage,
        // The selected context replaces seeded selection; leaving both on sends the files twice.
        ...(repairing ? {} : {
          contextSelection: scope.contextSelection,
          entryFile: scope.entryFile || "__no_entry__",
        }),
        // A repair that runs to the 25-turn default re-sends the project on every turn.
        ...(inputMaxTurns ? { maxTurns: inputMaxTurns } : {}),
      });

      if (repairSelection) {
        const rebuilt = job.repairScope?.reconstructedTree(Object.keys(tree).length);
        if (rebuilt) serverLog(job, "repair context: WARNING — the repair reconstructed more than half the tree");
        job.contextTelemetry = job.contextTelemetry || [];
        job.contextTelemetry.push({
          stage: "repair",
          initialTokens: repairSelection.tokens, budget: repairSelection.budget,
          wholeTreeTokens: repairSelection.wholeTreeTokens,
          fullFiles: repairSelection.full.length, omitted: repairSelection.omitted.length,
          expansions: job.repairScope?.telemetry.expansionCount || 0,
          expansionTokens: job.repairScope?.telemetry.expansionTokens || 0,
          reconstructedTree: !!rebuilt,
          reasons: repairSelection.full.map((c) => ({ path: c.path, reason: c.reason })),
          usage: initial.telemetry,
        });
      }
      combinedUsage.add(initial.telemetry);
    }
    let finalText = initial.finalText;
    if (job.cancelled) throw new CancelledError();
    // A staged build already recorded a step per stage, with its own prompt, output and duration.
    // Recording one more "Initial implementation" on top of them double-counts the work and reads,
    // in Diagnostics, as though the whole project had been written twice.
    if (!staged) job.diag?.step({
      agent: "Builder", kind: "agent", label: mode === "iterate" ? "Code changes" : "Initial implementation",
      prompt: enginePrompt, output: finalText,
      usage: initial.telemetry, model: provider.model, durationMs: Date.now() - builderStarted,
      contextMeta: {
        trigger: job.trigger || "user", runId: job.id,
        taskType: scope.taskType, budgetTokens: scope.budgetTokens,
        estContextTokens: scope.estContextTokens,
        contextSelection: scope.contextSelection,
        files: scope.files, warnings: scope.warnings,
        promptTokens: Math.round(String(enginePrompt).length / 4),
        systemTokens: Math.round(String(systemPrompt).length / 4),
      },
    });

    // Prove it builds (same bar as the harness) before we serve/save it. Runtime tree carries
    // the injected backend .env — the SAVED tree stays clean.
    await ensureDeps(() => {});
    await ensureDeps(() => {});
    let runtimeTree = withRuntimeEnv(tree, projectId);

    // PREFLIGHT — resolve every import before spending a compile on it.
    //
    // The production failure this exists for cost a full build plus two repair rounds (~21 credits)
    // to discover that one icon import named a symbol the pinned package does not export. Reading
    // the export surface takes about 20ms. Corrections are applied to the SAVED tree as well as the
    // runtime one, so the fix persists into the project rather than being re-broken next round.
    const preflightStarted = Date.now();
    try {
      const preflight = await preflightImports(runtimeTree, { nodeModules: depsNodeModules() });
      if (preflight.corrections.length) {
        for (const correction of preflight.corrections) serverLog(job, `preflight: ${correction.message}`);
        runtimeTree = preflight.tree;
        // Carry each correction back into the saved tree too — the runtime tree is a copy with the
        // backend .env injected, and only the saved tree survives the round.
        for (const { file } of preflight.corrections) tree[file] = preflight.tree[file];
      }
      if (preflight.problems.length) {
        for (const problem of preflight.problems) serverLog(job, `preflight: ${problem.message}`);
      }
      job.preflight = preflight;
      job.diag?.step({
        agent: "Compiler", kind: "preflight", label: "Import resolution",
        status: preflight.ok ? "ok" : "failed",
        output: [
          preflightSummary(preflight),
          ...preflight.corrections.map((c) => `CORRECTED ${c.message}`),
          ...preflight.problems.map((p) => `UNRESOLVED ${p.message}`),
        ].join("\n"),
        durationMs: Date.now() - preflightStarted,
      });
    } catch (error) {
      // A preflight that throws must never be the reason a good build does not happen.
      serverLog(job, `preflight: skipped (${error.message})`);
    }

    serverLog(job, "build: npm run build ...");
    const compileStarted = Date.now();
    let build = await buildTree(runtimeTree, `shell-${projectId}`.replace(/[^a-zA-Z0-9_-]/g, "_"), () => {});
    serverLog(job, `build: ${build.ok ? "PASS" : "FAIL"}`);
    // The repair brief quotes this verbatim, so it keeps far more than the 2 000 characters a
    // status line needed. A rollup error names the file, symbol and importer across several lines;
    // truncating to the tail of 2 000 was losing the "imported by" half of the only line that
    // mattered. The brief redacts and trims it again on the way to the model.
    job.buildCommand = "npm run build";
    if (!build.ok) job.buildStderr = (build.stderr || "").slice(-20_000);
    job.diag?.step({
      agent: "Compiler", kind: "compiler", label: "npm run build",
      status: build.ok ? "ok" : "failed",
      output: build.ok ? "Build passed with no compiler errors." : build.stderr, // FULL output, untruncated
      durationMs: Date.now() - compileStarted,
    });

    // ── HONESTY SCAN (PR7) ───────────────────────────────────────────────────────────────────
    //
    // Everything above proves the app compiles, loads and can be driven. None of it catches the
    // failure the customer actually reported: a convincing interface whose controls do nothing.
    // This reads the source, where "saved to the backend" and "saved to a variable" are plainly
    // different — from outside they look identical.
    let honesty = null;
    if (build.ok) {
      try {
        honesty = honestyScan(tree, { contract });
        job.honesty = honesty;
        for (const finding of honesty.findings) serverLog(job, `honesty: ${finding.message}`);
        job.diag?.step({
          agent: "Tester", kind: "honesty", label: "Implementation honesty scan",
          status: honesty.ok ? "ok" : "failed",
          output: [
            honesty.summary,
            ...honesty.findings.map((f) => `FAILS ${f.message}\n      ${f.snippet}`),
            ...honesty.warnings.map((w) => `warns ${w.message}`),
          ].join("\n"),
        });
      } catch (error) {
        serverLog(job, `honesty: scan unavailable (${error.message})`);
      }
    }

    let qualityWarnings = [];
    if (needsDesignPass && build.ok && designProfile) {
      setPhase(job, "quality-checking");
      let audit = auditDesign(tree, {
        profile: designProfile, assets: approvedPhotos, imageUnavailable: photography.unavailable,
      });
      qualityWarnings = audit.warnings;
      job.diag?.step({
        agent: "Tester", kind: "lint", label: "Design quality audit",
        status: audit.issues.length ? "failed" : "ok",
        output: JSON.stringify({ issues: audit.issues, warnings: audit.warnings }, null, 2),
      });

      if (audit.issues.length) {
        setPhase(job, "polishing");
        serverLog(job, `quality: ${audit.issues.length} issue(s) found; running one focused polish pass`);
        const polishFiles = makeFileTools(tree, { editFormat: "apply_patch" });
        let polishTools = polishFiles.schemas;
        let polishImpls = polishFiles.impls;
        let polishSystem = `${systemPromptForEdit("apply_patch")}\n\n${renderDesignBrief(designProfile, approvedPhotos)}`;
        if (imagesConfigured()) {
          polishTools = [...polishTools, SEARCH_IMAGES_SCHEMA];
          polishImpls = { ...polishImpls, search_images: toolImpls.search_images };
          polishSystem = `${polishSystem}\n${IMAGES_PROMPT_BLOCK}`;
        }
        const polishStarted = Date.now();
        const polishPrompt = `The premium design audit found the issues below. Correct only these issues while preserving all behavior, routes, data, content, and working interactions. Re-read the relevant files and use apply_patch.\n\n${audit.issues.map((issue) => `- ${issue}`).join("\n")}`;
        const polished = await runAgent({
          provider: buildProvider("edit"),
          systemPrompt: polishSystem,
          tools: polishTools,
          toolImpls: polishImpls,
          tree,
          prompt: polishPrompt,
          log, onUsage,
        });
        combinedUsage.add(polished.telemetry);
        if (polished.finalText) finalText = polished.finalText;
        if (job.cancelled) throw new CancelledError();
        job.diag?.step({
          agent: "Designer", kind: "agent", label: "Polish pass",
          prompt: polishPrompt, output: polished.finalText,
          usage: polished.telemetry, model: buildProvider("edit").model,
          durationMs: Date.now() - polishStarted,
        });

        runtimeTree = withRuntimeEnv(tree, projectId);
        serverLog(job, "build: verifying polished result ...");
        const recompileStarted = Date.now();
        build = await buildTree(runtimeTree, `shell-${projectId}`.replace(/[^a-zA-Z0-9_-]/g, "_"), () => {});
        serverLog(job, `build: ${build.ok ? "PASS" : "FAIL"}`);
        if (!build.ok) job.buildStderr = (build.stderr || "").slice(-2000);
        job.diag?.step({
          agent: "Compiler", kind: "compiler", label: "npm run build (after polish)",
          status: build.ok ? "ok" : "failed",
          output: build.ok ? "Build passed with no compiler errors." : build.stderr,
          durationMs: Date.now() - recompileStarted,
        });
        audit = auditDesign(tree, {
          profile: designProfile, assets: approvedPhotos, imageUnavailable: photography.unavailable,
        });
        qualityWarnings = [...audit.warnings];
        if (audit.issues.length) {
          qualityWarnings.push("The automated polish could not fully satisfy every premium design check.");
        }
      }
    }

    const capabilityAudit = auditCapabilityTree(tree, capabilityManifest);
    qualityWarnings.push(...capabilityAudit.warnings);
    job.diag?.step({
      agent: "Tester", kind: "lint", label: "Capability safety audit",
      status: capabilityAudit.hardIssues.length ? "failed" : "ok",
      output: JSON.stringify({ hardIssues: capabilityAudit.hardIssues, warnings: capabilityAudit.warnings }, null, 2),
    });
    if (capabilityAudit.hardIssues.length) {
      qualityWarnings.push(...capabilityAudit.hardIssues);
      build = { ...build, ok: false };
      serverLog(job, `capabilities: FAIL (${capabilityAudit.hardIssues.length} unsafe direct integration issue(s))`);
    } else if (capabilityManifest.length) {
      serverLog(job, `capabilities: PASS (${capabilityManifest.length} configured action(s))`);
    }

    // Runtime honesty gate: if the generated app uses the backend SDK but the per-app
    // runtime is down/missing, the build must NOT report success — the app would render
    // with every backend call failing.
    {
      const { backendRuntimeReady, treeUsesBackendSdk } = await import("./appRuntimeStatus.mjs");
      if (treeUsesBackendSdk(tree)) {
        const runtime = await backendRuntimeReady();
        job.diag?.step({
          agent: "Tester", kind: "runtime", label: "Backend runtime probe",
          status: runtime.ready ? "ok" : "failed",
          output: runtime.ready ? "app-auth + entities reachable" : `Backend runtime unavailable: ${runtime.reason}`,
        });
        if (!runtime.ready) {
          qualityWarnings.push(`Backend runtime unavailable: ${runtime.reason}`);
          build = { ...build, ok: false };
          serverLog(job, `backend runtime: FAIL (${runtime.reason})`);
        } else {
          serverLog(job, "backend runtime: PASS (app-auth + entities reachable)");
        }
      }
    }

    setPhase(job, "finalizing");
    const { need, balance } = await settle(combinedUsage.summary(), provider.model, "gen");

    let preview = null;
    try {
      preview = mode === "iterate"
        ? await previewProvider().update(projectId, runtimeTree)
        : await previewProvider().start(projectId, runtimeTree);
      serverLog(job, `preview: ${preview.url ? preview.url : "(vps stub — no url)"}`);
    } catch (e) {
      serverLog(job, `preview: unavailable (${e.message})`);
      preview = { url: null };
    }

    job.diag?.files(diagBaseline, tree, {
      label: mode === "iterate" ? "Files changed by this repair/edit" : "Files authored by the build",
    });
    // Server-side measurements for no-progress detection and checkpointing. Never part of
    // publicResult — the relay reads them off the live job object.
    job.measurements = measureRound({
      baseline: diagBaseline, tree, build, usage: combinedUsage.summary(),
      credits: need, model: provider.model, previewUrl: preview?.url || null,
      qualityWarnings,
    });
    // Honesty findings are real defects, so they join the warnings the repair loop already acts
    // on — a control that does nothing is not a lesser problem than a missing hero image.
    if (honesty && !honesty.ok) qualityWarnings = [...qualityWarnings, ...honestyFailures(honesty)];
    job.result = {
      finalText, tree, buildOk: build.ok, previewUrl: preview?.url || null,
      need, balance: balance.total, designProfile, qualityWarnings,
    };
    finish(job, "complete");
  } catch (e) {
    if (e instanceof CancelledError) {
      serverLog(job, "cancelled between turns — no settle, no result");
      finish(job, "failed", { error: "Cancelled by user.", stopReason: STOP_REASONS.cancelled });
    } else if (e instanceof CostGuardError) {
      serverLog(job, `cost guard: refused before running (${e.message})`);
      finish(job, "failed", { error: e.message, stopReason: STOP_REASONS.costGuard });
    } else if (e instanceof ManagedBillingError) {
      if (e.reason === "job_credit_limit" && failureMeter?.trackedUsage) {
        const usage = failureMeter.trackedUsage.summary();
        if (usage.total > 0) {
          const ref = `limit:${projectId}:${crypto.randomUUID()}`;
          const charged = await led.debit({ owner: owner.id, usage, model: failureMeter.model, ref, allowPartial: true })
            .catch(() => null);
          if (charged?.ok) serverLog(job, `billing: affordability stop debited ${charged.debited.toFixed(4)} cr`);
        }
      }
      serverLog(job, `billing: stopped (${e.reason})`);
      finish(job, "failed", { error: e.message, stopReason: STOP_REASONS.managedBudget });
    } else {
      serverLog(job, `FAILED: ${e.stack || e.message}`);
      job.diag?.step({
        agent: "Platform", kind: "runtime", label: "Unhandled build error",
        status: "failed", output: e.stack || e.message,
      });
      // Classify BEFORE reporting: a provider that is out of quota, rate limited or down
      // needs a different provider, not another identical attempt on the same one. The raw
      // text is read here and discarded — only the classification and a human sentence leave.
      const raw = `${e.code || ""} ${e.status || ""} ${e.message || ""}`;
      const condition = providerCondition(raw);
      const stopReason = condition === "provider_quota_blocked" ? STOP_REASONS.providerQuota
        : condition === "provider_rate_limited" ? STOP_REASONS.providerRateLimit
          : condition === "provider_unavailable" ? STOP_REASONS.providerUnavailable
            : isTransientText(raw) ? STOP_REASONS.transient
              : null;
      // Human message only — raw errors can carry internals (models, paths, provider chatter).
      const message = stopReason === STOP_REASONS.providerQuota
        ? "The AI provider has reached its current limit."
        : stopReason === STOP_REASONS.providerRateLimit
          ? "The AI provider is rate limiting requests right now."
          : stopReason === STOP_REASONS.providerUnavailable
            ? "The AI provider is temporarily unavailable."
            : "The build hit an unexpected error — please try again.";
      finish(job, "failed", { error: message, stopReason });
    }
  }
}
