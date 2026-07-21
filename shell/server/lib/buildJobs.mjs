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
import { createRoutingProvider } from "../../../src/providers/routingProvider.mjs";
import { creditsForUsage } from "../../../src/billing/costModel.mjs";
import { buildTree, ensureDeps } from "../../../harness/workspace.mjs";
import { ledger } from "./services.mjs";
import { getDecryptedKey } from "./byokStore.mjs";
import { previewProvider } from "../preview/index.mjs";
import { withRuntimeEnv } from "./runtimeEnv.mjs";
import { imagesConfigured, searchImages, SEARCH_IMAGES_SCHEMA, IMAGES_PROMPT_BLOCK } from "./images.mjs";
import { ensureWelcomeGrant } from "./welcome.mjs";
import { serviceClient } from "./supabase.mjs";
import { optionalEnv } from "./env.mjs";
import { managedAffordableCreditLimit } from "./billingLimits.mjs";
import { connectorToolsForProject } from "./connectors.mjs";
import { auditCapabilityTree } from "./capabilityAudit.mjs";
import {
  DESIGN_DIRECTOR_SYSTEM_PROMPT, auditDesign, fallbackDesignProfile,
  normalizeDesignProfile, normalizeStyle, parseDesignProfile, renderDesignBrief,
} from "../../../src/design/designProfile.mjs";

const BYOK_MODEL = "claude-sonnet-4-6"; // adapter default for the BYOK (Anthropic) lane; a picker is deferred

// Independent per-job runaway limits. These are NOT prices or minimum balances: any positive
// managed balance may start, and settlement charges actual usage (capped at the balance remaining).

class ManagedBillingError extends Error {
  constructor(message, reason = "billing_error") { super(message); this.name = "ManagedBillingError"; this.reason = reason; }
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
    result: TERMINAL.has(job.status) ? publicResult(job) : null,
  };
}

function setPhase(job, phase) {
  job.phase = phase;
  persist(job, { phase });
  emit(job, "phase", { jobId: job.id, status: job.status, phase });
}

function finish(job, status, { error = null } = {}) {
  job.status = status;
  job.phase = status;
  job.error = error;
  job.finishedAt = Date.now();
  persist(job, {
    status, phase: status, error,
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

export async function createJob({ owner, projectId, mode, prompt, tree, plan, knowledge, style, designProfile, redesign }) {
  const existing = activeJobFor(owner.id, projectId);
  if (existing) return { job: existing, existing: true };

  const job = {
    id: crypto.randomUUID(),
    owner, projectId, mode,
    input: { prompt, tree, plan, knowledge, style, designProfile, redesign }, // in-memory only; restart sweeps the job
    status: "queued", phase: "queued", error: null,
    result: null, buildStderr: null,
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
    finish(job, "failed", { error: "Cancelled by user." });
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
      error: "Build was interrupted before it could finish â€” please rebuild.",
      updated_at: new Date().toISOString() })
    .in("status", ["queued", "running"]).lt("created_at", cutoff).select("id");
  if (error) console.log(`[jobs] stale sweep WARN: ${error.message}`);
  else if (data?.length) console.log(`[jobs] swept ${data.length} stale job(s)`);
}

export async function interruptLiveJobs(reason = "Build was interrupted by a server restart â€” please rebuild.") {
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
    log("design: photography unavailable (PEXELS_API_KEY is not configured)");
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

async function runJob(job) {
  const { prompt, tree: inputTree, plan, knowledge, style, designProfile: inputDesignProfile, redesign } = job.input;
  const projectId = job.projectId;
  const mode = job.mode;
  const owner = job.owner;
  const led = ledger();
  let failureMeter = null;

  const withKnowledge = (p) =>
    knowledge ? `${p}\n\nProject knowledge (standing instructions — always apply):\n${knowledge}` : p;

  try {
    setPhase(job, "preparing");

    // BYOK: if the user has saved a provider key, generation runs on THEIR account and debits NO
    // platform credits. The decrypted key stays server-side (never in any frame, never logged).
    let byokKey = null;
    try { byokKey = await getDecryptedKey(owner.id); } catch { byokKey = null; }
    const byok = !!byokKey;
    const providerConfig = byok
      ? { provider: "anthropic", strong: BYOK_MODEL, apiKey: byokKey }
      : { provider: "codex", strong: "gpt-5.5" };
    const buildProvider = (intent) => createRoutingProvider({ config: providerConfig, turnMeta: { intent } });

    await ensureWelcomeGrant(owner.id);
    const preBal = await led.getBalance(owner.id);
    const jobCreditLimit = managedAffordableCreditLimit({ balance: preBal.total, mode, redesign });
    const trackedUsage = usageBucket();
    failureMeter = byok ? null : { trackedUsage, model: providerConfig.strong };
    const onUsage = byok ? null : managedUsageGuard(jobCreditLimit, providerConfig.strong, trackedUsage);

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

      const { telemetry, finalText } = await runAgent({
        provider, systemPrompt: planSystemPrompt, tools: [], toolImpls: {},
        tree: {}, prompt: withKnowledge(prompt), log, onUsage,
      });
      if (job.cancelled) throw new CancelledError();

      const { need, balance } = await settle(telemetry, provider.model, "plan");
      job.result = { finalText, need, balance: balance.total };
      return finish(job, "complete");
    }

    // ── BUILD / ITERATE pass ────────────────────────────────────────────────────────────────
    const intent = mode === "iterate" ? "edit" : "generate";
    const provider = buildProvider(intent);

    const combinedUsage = usageBucket();
    const needsDesignPass = mode === "build" || redesign === true;
    let designProfile = inputDesignProfile
      ? normalizeDesignProfile(inputDesignProfile, { prompt, projectId, style })
      : null;
    let photography = { assets: [], unavailable: false };
    if (needsDesignPass) {
      setPhase(job, "designing");
      const directed = await directDesign({
        provider: buildProvider("generate"), prompt, projectId, style, knowledge, plan, log, onUsage,
      });
      designProfile = directed.profile;
      combinedUsage.add(directed.telemetry);
      photography = await preparePhotography(designProfile, log);
    }

    const tree = mode === "iterate" ? { ...inputTree } : clone(fromScaffold(REACT_VITE));
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
    if (redesign === true) {
      enginePrompt = `This is an explicit full-product frontend redesign. Preserve every working feature, route, data flow, form, and important piece of content while comprehensively replacing the visual system and composition. Read the shared shell and EVERY reachable screen component before editing. Apply one premium design language to the public page, dashboard, navigation destinations, forms, tables, calendars, modals, empty states and mobile menu. Keep an obvious route back to the public site from the app. At 360px, large mockups and floating panels must return to normal document flow and nothing may collide, clip or overlap unintentionally. Do not stop after making the landing page attractive.\n\n${enginePrompt}`;
    }

    const initial = await runAgent({
      provider, systemPrompt, tools, toolImpls, tree, prompt: enginePrompt, log, onUsage,
    });
    combinedUsage.add(initial.telemetry);
    let finalText = initial.finalText;
    if (job.cancelled) throw new CancelledError();

    // Prove it builds (same bar as the harness) before we serve/save it. Runtime tree carries
    // the injected backend .env — the SAVED tree stays clean.
    await ensureDeps(() => {});
    await ensureDeps(() => {});
    let runtimeTree = withRuntimeEnv(tree, projectId);
    serverLog(job, "build: npm run build ...");
    let build = await buildTree(runtimeTree, `shell-${projectId}`.replace(/[^a-zA-Z0-9_-]/g, "_"), () => {});
    serverLog(job, `build: ${build.ok ? "PASS" : "FAIL"}`);
    if (!build.ok) job.buildStderr = (build.stderr || "").slice(-2000);

    let qualityWarnings = [];
    if (needsDesignPass && build.ok && designProfile) {
      setPhase(job, "quality-checking");
      let audit = auditDesign(tree, {
        profile: designProfile, assets: approvedPhotos, imageUnavailable: photography.unavailable,
      });
      qualityWarnings = audit.warnings;

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
        const polished = await runAgent({
          provider: buildProvider("edit"),
          systemPrompt: polishSystem,
          tools: polishTools,
          toolImpls: polishImpls,
          tree,
          prompt: `The premium design audit found the issues below. Correct only these issues while preserving all behavior, routes, data, content, and working interactions. Re-read the relevant files and use apply_patch.\n\n${audit.issues.map((issue) => `- ${issue}`).join("\n")}`,
          log, onUsage,
        });
        combinedUsage.add(polished.telemetry);
        if (polished.finalText) finalText = polished.finalText;
        if (job.cancelled) throw new CancelledError();

        runtimeTree = withRuntimeEnv(tree, projectId);
        serverLog(job, "build: verifying polished result ...");
        build = await buildTree(runtimeTree, `shell-${projectId}`.replace(/[^a-zA-Z0-9_-]/g, "_"), () => {});
        serverLog(job, `build: ${build.ok ? "PASS" : "FAIL"}`);
        if (!build.ok) job.buildStderr = (build.stderr || "").slice(-2000);
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
    if (capabilityAudit.hardIssues.length) {
      qualityWarnings.push(...capabilityAudit.hardIssues);
      build = { ...build, ok: false };
      serverLog(job, `capabilities: FAIL (${capabilityAudit.hardIssues.length} unsafe direct integration issue(s))`);
    } else if (capabilityManifest.length) {
      serverLog(job, `capabilities: PASS (${capabilityManifest.length} configured action(s))`);
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

    job.result = {
      finalText, tree, buildOk: build.ok, previewUrl: preview?.url || null,
      need, balance: balance.total, designProfile, qualityWarnings,
    };
    finish(job, "complete");
  } catch (e) {
    if (e instanceof CancelledError) {
      serverLog(job, "cancelled between turns — no settle, no result");
      finish(job, "failed", { error: "Cancelled by user." });
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
      finish(job, "failed", { error: e.message });
    } else {
      serverLog(job, `FAILED: ${e.stack || e.message}`);
      // Human message only — raw errors can carry internals (models, paths, provider chatter).
      finish(job, "failed", { error: "The build hit an unexpected error — please try again." });
    }
  }
}
