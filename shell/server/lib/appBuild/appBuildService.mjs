// startAppBuild: the bridge between the Lead Agent and the generation pipeline.
// Creates the project row (server-mediated — the legacy client-side tree write is gone),
// dispatches a build job, and relays the pipeline's phases into the conversation as a
// staged specialist team (Principle 4) with an unprompted preview card the moment the
// preview is reachable (Principle 5). The terminal tree is persisted server-side.

import { serviceClient } from "../supabase.mjs";
import { createJob, subscribe, getJob, isTerminal } from "../buildJobs.mjs";
import { notifyOwnerIfAway } from "../notifications/notificationService.mjs";
import { previewProvider } from "../../preview/index.mjs";
import { startDiagSessionSafe } from "./buildDiagnostics.mjs";
import { fingerprintFailure, fingerprintPrompt } from "./contextScope.mjs";
import {
  classifyEndState, classifyVerificationState, humanInputNeed,
  isAutomaticallyRetryable, isProviderBlocked,
} from "./endState.mjs";
import { createLifecycleBudget, budgetBlockedMessage } from "./lifecycleBudget.mjs";
import {
  createCheckpointStore, restoreCheckpoint, checkpointWriter,
  loadCheckpointRows, releaseLifecycleCheckpoints,
} from "./buildCheckpoints.mjs";
import { dailyByokSpend, dailyVerdict, dailyWarningMessage } from "./byokSpend.mjs";
import { roundSignals, evaluateProgress, regressed } from "./repairProgress.mjs";
import { buildRepairBrief, headlineError } from "./repairContext.mjs";
import { STRATEGIES, FIRST_STRATEGY, strategy, escalate, verifyPatch } from "./patchVerification.mjs";
import { verifyJourneys, journeyFailures, journeySummary } from "./journeyVerifier.mjs";
import { normalizeByokSafety, byokDispatchCheck, byokBlockedMessage, byokWarning } from "./byokSafety.mjs";
import { providerLabel, alternativeProviders, recordProviderSwitch, switchedMessage } from "../providerQuota.mjs";

// The end-of-build message NEVER claims a live preview unless a URL actually exists
// (Stuart, 2026-07-31: "a build should never claim success unless the preview is actually
// visible"). Pure and unit-tested.
export function buildEndSummary(result) {
  if (!result?.previewUrl) {
    return "Your app is built. The preview is still warming up — I'll drop it into this conversation the moment it's ready.";
  }
  return "Your app is built and the preview is live in this conversation.";
}

// Autonomous failure handling (Stuart, 2026-07-31): a failed build is UNFINISHED WORK, not
// a reason to hand control back. Routine failures (build checks, runtime config, tests,
// verification) NEVER ask permission.
//
// Rewritten 2026-08-01: retry eligibility is no longer inferred from `status`. Every job end
// is classified into an explicit end state first (endState.mjs), and only genuine transient
// interruptions enter the automatic retry path. A user cancellation, a managed-budget stop,
// a cost-guard refusal and a provider-quota exhaustion each have their own outcome — before
// this, all four were indistinguishable from a crash and were retried as paid work.
//
// MAX_AUTO_ROUNDS counts JOBS, not repairs: the initial build plus at most MAX_AUTO_REPAIRS
// follow-ups. The old exhaustion copy said "3 autonomous repair rounds" when at most 2
// repairs ever ran.
export const MAX_AUTO_ROUNDS = 3;
export const MAX_AUTO_REPAIRS = MAX_AUTO_ROUNDS - 1;

// Accurate, plain-English account of what was actually attempted (§9).
export function attemptSummary(attempt) {
  const repairs = Math.max(0, Math.min(attempt, MAX_AUTO_ROUNDS) - 1);
  if (repairs === 0) return "I completed the initial build.";
  if (repairs === 1) return "I completed the initial build and 1 automatic repair attempt.";
  return `I completed the initial build and ${repairs} automatic repair attempts.`;
}

// The calm in-progress status line: "Repairing the build — attempt 1 of 2."
export function repairStatusLine(repairNumber, { improved = null } = {}) {
  const line = `Repairing the build — attempt ${repairNumber} of ${MAX_AUTO_REPAIRS}.`;
  if (improved === true) return `The last repair improved the build. ${line}`;
  return line;
}

// The brief the repair agent is dispatched with.
//
// This used to be the reason list and nothing else — the reasons themselves capped at 200
// characters — so a repair agent was asked to fix a rollup error it had never seen. It said so, in
// production: "found no compile-time issue in the current source that can be safely changed without
// the actual Build Diagnostics `baa3e8fc` output". Then it guessed, twice, wrongly.
//
// `diagnostics` carries the real thing: the command, the complete output, the previous patch and
// whether it moved the failure. When it is absent (quality-warning rounds, and the pure-planner
// unit tests) the reason list still stands on its own.
function repairBriefFor(reasons, diagnostics = null) {
  if (!diagnostics?.output) {
    return [
      "AUTONOMOUS REPAIR — the previous round failed these checks. Diagnose the root cause and",
      "apply the smallest safe fix for each; change nothing else:",
      ...reasons.map((r) => `- ${r}`),
      "",
      "Preserve the existing design, layout, branding and component structure exactly.",
    ].join("\n");
  }
  return buildRepairBrief({ ...diagnostics, reasons });
}

function reasonsFor(data, diagnostics = null) {
  if (data.status === "complete") {
    // A compile failure arrives HERE, not on the failed branch: the job completes and reports
    // buildOk false. It used to be described as "the build's quality checks failed" — which is
    // exactly the sentence the repair agent read before announcing it was "addressing the build
    // quality/lint failure" and deleting three unused imports. It is a compiler error; say so, and
    // name it.
    const warnings = data.result?.qualityWarnings || [];
    if (data.result?.buildOk === false) {
      const headline = diagnostics?.output ? headlineError(diagnostics.output) : "";
      // The compile failure LEADS — it is why nothing runs — but the quality warnings are real
      // findings and are still worth fixing in the same round, so they are kept alongside it.
      // Naming the compiler error here also gives the fingerprint something to distinguish on:
      // every compile failure used to hash to the same constant string, so two genuinely different
      // errors looked like "the same failure came back unchanged" and ended the run.
      return [
        headline ? `the compiler rejected the project: ${headline}` : "the project failed to compile",
        ...warnings,
      ];
    }
    return warnings.length ? warnings : ["the build's quality checks failed"];
  }
  // Kept short deliberately: this is the fingerprint input and the customer-facing sentence. The
  // complete output travels in the brief's COMPLETE OUTPUT block, not through here.
  return [`the build ${data.status}${data.error ? `: ${String(data.error).slice(0, 200)}` : ""}`];
}

// `data` is the job's terminal frame. Every other argument is state the relay owns: the
// lifecycle budget verdict, the no-progress verdict for the round that just ended, the
// providers actually available to switch to, and whether the owner enabled auto-fallback.
export function planEndAction(data, {
  attempt = 1,
  maxAttempts = MAX_AUTO_ROUNDS,
  previousFingerprints = [],
  budgetCheck = { ok: true },
  progress = null,
  alternatives = [],
  autoFallback = false,
  diagnostics = null,
  strategyId = FIRST_STRATEGY,
} = {}) {
  const endState = classifyEndState(data);

  // 1. The user asked us to stop. Nothing further is dispatched, nothing further is charged.
  if (endState === "cancelled") {
    return {
      kind: "cancelled", endState,
      message: "Build cancelled. Your current progress has been saved.",
    };
  }

  // 2. Success routes through the verification gate exactly as before.
  if (endState === "success") {
    return { kind: data.result?.previewUrl ? "verify" : "warmup", endState };
  }

  const reasons = reasonsFor(data, diagnostics);
  const fingerprint = fingerprintFailure(reasons);

  // 3. A provider limit needs a DIFFERENT provider, never another blind attempt on the same
  //    one. With auto-fallback on we switch and continue from the same step; otherwise we
  //    offer the switch and wait.
  if (isProviderBlocked(endState)) {
    const kindOfLimit = endState === "provider_quota_blocked" ? "quota"
      : endState === "provider_rate_limited" ? "rate_limit" : "outage";
    if (!alternatives.length) {
      return {
        kind: "request_user_input", endState, fingerprint, limit: kindOfLimit,
        message: `${providerLabelFor(data)} has reached its current limit and no other provider is connected. Your progress is safe — connect another provider or wait for the limit to reset, and I'll continue from where I stopped.`,
      };
    }
    return {
      kind: "switch_provider", endState, fingerprint, limit: kindOfLimit,
      alternatives, auto: Boolean(autoFallback),
      message: autoFallback
        ? null // the relay writes the "switched and continued" sentence after the switch lands
        : `${providerLabelFor(data)} has reached its current limit. Your progress is safe — ${alternatives.map((a) => a.label || a).join(" or ")} is available. Switch and continue?`,
    };
  }

  // 4. Money and human input both mean: pause, keep everything, ask.
  if (endState === "managed_budget_blocked") {
    return {
      kind: "request_user_input", endState, fingerprint, reason: "budget",
      message: null, // the relay renders this from the lifecycle budget, with real options
    };
  }
  if (endState === "user_input_required") {
    const need = humanInputNeed(reasons) || "something only you can provide";
    return {
      kind: "request_user_input", endState, fingerprint, reason: "human_input", need,
      message: `I've stopped rather than guess: finishing this needs ${need}. ${attemptSummary(attempt)} Your current progress is saved, and I'll pick up from exactly here once you've sorted it.`,
    };
  }

  // 5. Structural stops that apply to every remaining state.
  if (!budgetCheck.ok) {
    return { kind: "blocked", endState, fingerprint, budgetCheck, message: null };
  }
  if (attempt >= maxAttempts) {
    return {
      kind: "blocked", endState, fingerprint,
      message: `${attemptSummary(attempt)} This still fails:\n${reasons.map((r) => `- ${r}`).join("\n")}\nThat's the safe automatic repair limit — your current work is saved. I need a decision from you on how to proceed.`,
    };
  }

  // 6. A genuine transient interruption may retry — with the ORIGINAL prompt, which the
  //    relay supplies from the lifecycle rather than from a field that never existed.
  if (isAutomaticallyRetryable(endState)) {
    return {
      kind: "retry", endState, fingerprint,
      announcement: "That was interrupted by a temporary infrastructure problem. I'm resuming it now — nothing needs you.",
    };
  }

  // 7. Permanent failures are not repairable by definition.
  if (endState === "permanent_failure") {
    return {
      kind: "blocked", endState, fingerprint,
      message: `${attemptSummary(attempt)} This failed in a way that repeating won't fix. Your current work is saved — I need a decision from you on how to proceed.`,
    };
  }

  // 8. Repairable failure.
  //
  //    This used to block the moment the fingerprint repeated — at attempt 2 of 3, before the
  //    budget was spent — because an unchanged failure was treated as terminal. It is not: it is
  //    the strongest signal available that the STRATEGY is wrong, and the answer to a wrong
  //    strategy is a different one. The run now climbs the escalation ladder, and only stops when
  //    the ladder is exhausted or the attempt budget genuinely runs out.
  const repeated = previousFingerprints.includes(fingerprint);
  const stalled = repeated || progress?.improved === false;
  const escalated = stalled ? escalate(strategyId) : strategyId;

  if (stalled && !escalated) {
    // Every materially different approach has now been tried on this same failure.
    return {
      kind: "blocked", endState, fingerprint, progress, strategy: strategyId, exhausted: true,
      message: `I tried four materially different approaches to this and it still fails the same way:\n${reasons.map((r) => `- ${r}`).join("\n")}\nRepeating it would spend your budget without progress. Your current work is saved — I need a decision from you on how to proceed.`,
    };
  }

  const plan = strategy(escalated);
  const improved = progress?.improved === true && attempt > 1;
  return {
    kind: "repair", endState, fingerprint,
    strategy: escalated,
    // Tier 4 is a rollback: the relay restores the last green checkpoint before dispatching, so
    // the customer's floor is a working project rather than whatever the failed repairs left.
    restoreCheckpoint: escalated === "revert_and_rebuild",
    brief: repairBriefFor(reasons, diagnostics && {
      ...diagnostics,
      fingerprint,
      previousFingerprint: previousFingerprints[previousFingerprints.length - 1] || null,
      attempt, maxAttempts,
      strategy: plan,
    }),
    announcement: stalled
      ? `That didn't fix it — the build fails in exactly the same way. I'm changing approach: ${plan.label}.`
      : improved
        ? `The last repair improved the build. I'm fixing the remaining issue now and will re-run verification — attempt ${attempt} of ${MAX_AUTO_REPAIRS}.`
        : `A check found a problem. I'm repairing it now and will re-run verification — attempt ${attempt} of ${MAX_AUTO_REPAIRS}.`,
  };
}

function providerLabelFor(data) {
  return providerLabel(data?.provider || "provider");
}

// The verification gate's planner. Verification failures are their own end state: the app
// compiled and ran but behaved wrongly, which is repairable — unless it needs the user.
export function planVerificationAction(verdict, {
  attempt = 1,
  maxAttempts = MAX_AUTO_ROUNDS,
  previousFingerprints = [],
  budgetCheck = { ok: true },
  progress = null,
} = {}) {
  const failures = verdict?.failures || [];
  const endState = classifyVerificationState(failures);
  const fingerprint = fingerprintFailure(failures);

  if (endState === "user_input_required") {
    const need = humanInputNeed(failures) || "something only you can provide";
    return {
      kind: "request_user_input", endState, fingerprint, reason: "human_input", need,
      message: `I've stopped rather than guess: the remaining problem needs ${need}. ${attemptSummary(attempt)} Your current progress is saved, and I'll pick up from exactly here once you've sorted it.`,
    };
  }
  if (!budgetCheck.ok) {
    return { kind: "blocked", endState, fingerprint, budgetCheck, message: null };
  }
  if (attempt >= maxAttempts || previousFingerprints.includes(fingerprint)) {
    return {
      kind: "blocked", endState, fingerprint,
      message: `${attemptSummary(attempt)} Verification still finds:\n${failures.map((f) => `- ${f}`).join("\n")}\nThat's the safe automatic repair limit — your current work is saved. I need a decision from you on how to proceed.`,
    };
  }
  if (progress && progress.improved === false) {
    return {
      kind: "blocked", endState, fingerprint, progress,
      message: `${attemptSummary(attempt)} The last repair didn't move verification forward, so I've stopped rather than keep spending:\n${failures.map((f) => `- ${f}`).join("\n")}\nYour current work is saved. I need a decision from you on how to proceed.`,
    };
  }
  return {
    kind: "repair", endState, fingerprint,
    announcement: `A check found a problem. I'm repairing it now and will re-run verification — attempt ${attempt} of ${MAX_AUTO_REPAIRS}.`,
  };
}

// ── Lifecycle state ─────────────────────────────────────────────────────────────────────
// One object per build lifecycle, threaded through every follow-up dispatch. Before this,
// each dispatch received a fresh independent allowance and the original prompt was read
// from a field that never existed on the job object.

export async function createLifecycle({ owner, projectId, diag, originalInput, mode, redesign = false, client = null }) {
  let managed = true;
  let byokSafety = normalizeByokSafety(null);
  let allowFallback = true;
  let activeProvider = "managed";
  let credentials = [];
  let plan = "free";

  try {
    const { aiCredentialStore, activeAiCredential } = await import("../aiCredentialStore.mjs");
    const store = aiCredentialStore();
    const [preference, active, list] = await Promise.all([
      store.getPreference(owner).catch(() => null),
      activeAiCredential(owner).catch(() => ({ provider: "managed" })),
      store.listCredentials(owner).catch(() => []),
    ]);
    activeProvider = active?.provider || "managed";
    managed = activeProvider === "managed" || activeProvider === "codex" || !active?.secret;
    // Per-provider safeguards override the user's global defaults for the connection this
    // lifecycle actually runs on.
    byokSafety = normalizeByokSafety(preference?.byok_safety, { provider: activeProvider });
    allowFallback = preference?.allow_fallback ?? true;
    credentials = list || [];
  } catch { /* an unreadable connection means managed defaults — never a crash */ }

  try {
    const { ownerSubscription } = await import("../usageBudgets.mjs");
    plan = (await ownerSubscription(owner))?.plan || "free";
  } catch { /* free-plan limits are the safe default */ }

  const db = client || serviceClient();
  // Checkpoints are written through to build_checkpoints so a server restart mid-build no
  // longer loses the safety net. A lifecycle resuming on an existing project seeds itself
  // from that project's surviving rows.
  const seed = await loadCheckpointRows({ client: db, owner, projectId }).catch(() => []);

  return {
    owner, projectId, diag, client: db,
    originalInput,                                   // the COMPLETE original job input
    repairMemory: { fingerprints: [], briefs: [] },  // unchanged semantics, now lifecycle-scoped
    budget: createLifecycleBudget({ plan, mode, redesign, managed }),
    checkpoints: createCheckpointStore({
      seed,
      persist: checkpointWriter({ client: db, owner, projectId, buildId: diag.id }),
    }),
    rounds: [],                                      // measured signals, one per round
    plan, managed, byokSafety, allowFallback,
    activeProvider, credentials,
    providerOverride: null,                          // set when a fallback switch happens
    notify: notifyOwnerIfAway,                       // seam: every terminal path notifies once
    switches: [],
    notified: false,                                 // owner notification de-duplication
    byokWarned: false,
    endState: null,
  };
}

// alternativeProviders returns provider IDs; the planner and its copy work in {id, label}
// pairs. Only CONNECTED credentials are offered — a provider whose key last failed is not
// an alternative.
function alternativesFor(lifecycle) {
  return alternativeProviders({
    current: lifecycle.providerOverride || lifecycle.activeProvider,
    credentials: (lifecycle.credentials || []).filter((c) => c.status === "connected"),
    managedAvailable: lifecycle.activeProvider !== "managed",
  }).map((id) => ({ id, label: providerLabel(id) }));
}

// One Diagnostics row per decision (§15). Raw technical detail stays here and never reaches
// the conversation.
function recordOutcome(lifecycle, { action, attempt, trigger, signals = null, progress = null, checkpointBefore = null, checkpointAfter = null, notified = false, extra = {} }) {
  try {
    lifecycle.diag?.step({
      agent: "Lead Agent", kind: "outcome",
      label: `End state: ${action.endState || "unknown"} → ${action.kind}`,
      status: action.kind === "repair" || action.kind === "retry" || action.kind === "verify" || action.kind === "warmup" ? "ok" : "failed",
      round: attempt,
      output: JSON.stringify({
        endState: action.endState || null,
        action: action.kind,
        trigger,
        failureFingerprint: action.fingerprint || null,
        briefFingerprint: extra.briefFingerprint || null,
        attemptedStrategy: extra.strategy || null,
        attempt,
        maxAttempts: MAX_AUTO_ROUNDS,
        filesChanged: signals?.filesChanged ?? null,
        diffChars: signals?.diffChars ?? null,
        checkpointBefore, checkpointAfter,
        provider: extra.provider || lifecycle.providerOverride || lifecycle.activeProvider,
        model: extra.model || null,
        usage: signals?.usage || null,
        managedCredits: lifecycle.managed ? lifecycle.budget.totals.credits : null,
        byokCost: lifecycle.managed ? null : lifecycle.budget.totals.credits,
        durationMs: lifecycle.budget.totals.elapsedMs,
        verificationBefore: extra.verificationBefore ?? null,
        verificationAfter: extra.verificationAfter ?? null,
        progressMade: progress ? progress.improved : null,
        decisionReason: progress?.reason || extra.reason || null,
        ownerNotified: notified,
        lifecycleTotals: lifecycle.budget.totals,
      }, null, 2),
    });
  } catch { /* diagnostics must never break a build */ }
}

// Owner notification with de-duplication: every terminal blocked path notifies, once (§10).
async function notifyTerminal(ctx, lifecycle, { title, body, url = null }) {
  if (lifecycle.notified) return false;
  lifecycle.notified = true;
  const notify = lifecycle.notify || notifyOwnerIfAway;
  await notify(ctx.owner, ctx.conversation.id, {
    title, body, url, tag: `build-${lifecycle.projectId}`,
  }).catch(() => {});
  return true;
}

// The gate every follow-up dispatch must pass — aggregate managed budget for managed users,
// the user's own optional controls for BYOK users (off unless enabled).
async function dispatchCheck(lifecycle, { estimatedCredits = 0 } = {}) {
  const budgetCheck = lifecycle.budget.canDispatch({ estimatedCredits });
  if (!budgetCheck.ok) return { ok: false, kind: "budget", budgetCheck };
  if (!lifecycle.managed) {
    const totals = lifecycle.budget.totals;
    // Real rolling daily spend, but ONLY when the user enabled a daily limit — no query,
    // and no possibility of blocking, when the control is off.
    let dailySpend = 0;
    let daily = { enforced: false, blocked: false, warn: false };
    if (lifecycle.byokSafety.maxDailySpend !== null) {
      const spend = await dailyByokSpend({
        client: lifecycle.client, owner: lifecycle.owner,
        provider: lifecycle.providerOverride || lifecycle.activeProvider,
        timezone: lifecycle.byokSafety.timezone,
      });
      lifecycle.dailySpend = spend;
      daily = dailyVerdict({
        spend, limit: lifecycle.byokSafety.maxDailySpend,
        warnAt: lifecycle.byokSafety.warnThreshold,
      });
      // Fail open: unavailable accounting must never cost the user their own paid capacity.
      dailySpend = daily.enforced ? daily.total : 0;
      if (!daily.enforced && daily.reason) {
        lifecycle.diag?.step?.({
          agent: "Lead Agent", kind: "log", label: "BYOK daily spend unavailable",
          status: "ok", output: `Daily limit not enforced this round: ${daily.reason}. Continuing rather than blocking the user's own provider account.`,
        });
      }
    }
    const byok = byokDispatchCheck(lifecycle.byokSafety, {
      lifecycleCost: totals.credits,
      dailySpend,
      repairJobs: totals.repairRounds,
      projectedCost: estimatedCredits,
    });
    if (!byok.ok) return { ok: false, kind: "byok", byok, daily };
    return { ok: true, budgetCheck, daily };
  }
  return { ok: true, budgetCheck };
}

// Measure the round that just ended, from the job's own server-side measurements.
function signalsFromJob(job, data, { verdict = null, briefFingerprint = null } = {}) {
  const m = job?.measurements || {};
  const failures = verdict ? (verdict.failures || []) : (data?.result?.qualityWarnings || []);
  const checks = verdict?.checks || [];
  return roundSignals({
    compileOk: m.compileOk ?? null,
    compilerErrorCount: m.compilerErrorCount ?? null,
    failures,
    failureFingerprint: fingerprintFailure(failures),
    briefFingerprint,
    previewOk: m.previewOk ?? null,
    verificationPassed: verdict ? verdict.pass : null,
    verificationChecksPassed: checks.length ? checks.filter((c) => c.status === "pass").length : null,
    verificationChecksTotal: checks.length || null,
    filesChanged: m.filesChanged ?? 0,
    changedPaths: m.changedPaths || [],
    diffChars: m.diffChars ?? 0,
  });
}

// Everything the repair agent needs to see the failure rather than be told one exists.
//
// Assembled at the moment a round ends, from the job that just ran: the command, its complete
// output, the tree it built, the manifest it built against, and what the round that just finished
// actually touched. `buildRepairBrief` redacts before any of it reaches a model.
function diagnosticsFor(job, data, lifecycle, signals, patchVerdict = null) {
  const tree = data?.result?.tree || job?.result?.tree || null;
  const output = job?.buildStderr || (data?.error ? String(data.error) : "");
  if (!output) return null;
  // The round that just ended IS the previous repair, from the next brief's point of view.
  const previousRound = lifecycle.rounds.length > 1 ? lifecycle.rounds[lifecycle.rounds.length - 2] : null;
  return {
    command: job?.buildCommand || "npm run build",
    output,
    changedFiles: signals?.changedPaths || [],
    tree,
    manifest: tree?.["package.json"] || null,
    worktree: job?.workdir || null,
    patchVerdict,
    previousAttempts: previousRound?.changedPaths?.length
      ? [`round ${lifecycle.rounds.length - 1} edited ${previousRound.changedPaths.join(", ")} and the build still failed`]
      : [],
  };
}

// Build phases → the specialist the user watches. Sequential: each phase change retires the
// previous specialist (✓) and spawns the next, so the team appears as work actually begins.
const PHASE_SPECIALISTS = {
  preparing: { agent: "Planner", status: "Preparing the build…" },
  planning: { agent: "Planner", status: "Planning the architecture…" },
  designing: { agent: "Designer", status: "Creating the design system…" },
  building: { agent: "Builder", status: "Writing the code…" },
  "quality-checking": { agent: "Tester", status: "Running quality checks…" },
  polishing: { agent: "Designer", status: "Polishing the design…" },
  finalizing: { agent: "Publisher", status: "Preparing your preview…" },
};

export async function startAppBuild(ctx, { description, productName = null }) {
  const client = serviceClient();
  const name = (productName || "").trim() || null;

  // Product memory: an app build always belongs to a named product when one is given.
  let productId = ctx.conversation.product_id || null;
  if (name) {
    const product = await ctx.conversations.upsertProduct(ctx.owner, name.slice(0, 120));
    productId = product.id;
    if (!ctx.conversation.product_id) {
      await ctx.conversations.updateConversation(ctx.conversation, { product_id: product.id });
    }
  }

  const { data: project, error } = await client.from("projects").insert({
    owner: ctx.owner,
    name: name || String(description).slice(0, 120),
    product_id: productId,
  }).select("*").single();
  if (error) throw new Error(`project creation failed: ${error.message}`);

  const diag = await startDiagSessionSafe({
    owner: ctx.owner, projectId: project.id, conversationId: ctx.conversation.id,
    kind: "app_build", prompt: String(description),
  });
  // The COMPLETE original input, kept for the lifetime of the lifecycle. A legitimate retry
  // re-sends exactly this — untruncated and unmutated.
  const originalInput = { mode: "build", prompt: String(description) };
  const lifecycle = await createLifecycle({
    owner: ctx.owner, projectId: project.id, diag, originalInput, mode: "build", client,
  });
  const { job } = await createJob({
    owner: { id: ctx.owner },
    projectId: project.id,
    ...originalInput,
    diag: diag.recorderForJob({ round: 1 }),
    budgetAllowance: lifecycle.managed ? lifecycle.budget.jobAllowance(Infinity) : null,
    byokCostLimit: lifecycle.managed ? null : lifecycle.byokSafety.maxCostPerBuild,
  });
  lifecycle.budget.noteJob();

  // Stage checkpoints (PR5). A green stage is the tree the run falls back to, so it is recorded
  // in the same store as round checkpoints and with the same retention — a safety net that only
  // exists in memory would not survive the restart it is most needed after.
  job.onStageCheckpoint = ({ tree, stage, label, changedFiles }) => {
    try {
      lifecycle.checkpoints.create({
        tree, buildId: lifecycle.diag.id, jobId: job.id, attempt: 1,
        status: "stage", compileOk: true, previewOk: null,
        usageTotals: lifecycle.budget.totals,
        label: label || `stage ${stage}`,
        stage, changedFiles,
      });
    } catch (error) {
      console.error(`[app-build] stage checkpoint (${stage}):`, error.message);
    }
  };

  relayBuildJob(ctx, { job, projectId: project.id, lifecycle });
  await ctx.emit("build_started", {
    jobId: job.id,
    projectId: project.id,
    buildId: diag.id,
    message: "The team is assembling to build this.",
  });
  return { jobId: job.id, projectId: project.id, buildId: diag.id, note: "Build dispatched; the team's progress streams into this conversation." };
}

// Milestone copy for phase transitions during LONG builds — an engineering manager keeping
// the user informed, only when there's real progress to report.
const PHASE_MILESTONES = {
  designing: "Planning's done — the Designer is shaping the look and feel now.",
  building: "Design's locked in. The Builder has started implementation.",
  "quality-checking": "Implementation is in — running quality checks on the build.",
  polishing: "Checks pass. Giving the design a final polish.",
  finalizing: "Nearly there — packaging the build and preparing your preview.",
};
const MILESTONE_MIN_PHASE_MS = 2 * 60_000;   // fast builds stay quiet; the roster covers them
const REASSURE_AFTER_MS = 4 * 60_000;        // never silent for long, never noisy either

// Injectable seams. Production always uses the real ones; the regression suite substitutes
// them to assert what the relay actually DISPATCHES, not merely what the planner returns.
const REAL_DEPS = {
  createJob,
  subscribe,
  persistBuildResult: (owner, projectId, result) => persistBuildResult(owner, projectId, result),
  verify: (ctx, args) => runVerificationGate(ctx, args),
};

export function __relayForTests(ctx, options) {
  return relayBuildJob(ctx, options);
}

function relayBuildJob(ctx, { job, projectId, attempt = 1, lifecycle, deps = REAL_DEPS }) {
  const jobId = job.id;
  let lastSpecialist = null;
  let phaseStartedAt = Date.now();
  let lastEventAt = Date.now();
  let reassured = false;
  const sayProgress = async (text) => {
    await ctx.conversations.appendTurn(ctx.conversation, { role: "lead", content: text, payload: { projectId, progress: true } });
    await ctx.emit("message", { role: "lead", text, projectId });
  };
  // Reassurance heartbeat: if nothing meaningful has happened for a while mid-build, say
  // so once, honestly — "still working…" spam is banned.
  const heartbeat = setInterval(() => {
    if (Date.now() - lastEventAt > REASSURE_AFTER_MS && !reassured) {
      reassured = true;
      sayProgress("Long stretch of deep work — the team is progressing normally; nothing needs you yet.").catch(() => {});
    }
  }, 60_000);
  heartbeat.unref?.();

  const finishSpecialist = async (ok = true) => {
    if (lastSpecialist) {
      await ctx.emit("agent_done", { agent: lastSpecialist, ok });
      lastSpecialist = null;
    }
  };

  const unsubscribe = deps.subscribe(job, async (name, data) => {
    try {
      if (name === "phase") {
        lastEventAt = Date.now();
        reassured = false;
        const specialist = PHASE_SPECIALISTS[data.phase];
        if (!specialist) return;
        if (specialist.agent !== lastSpecialist) {
          await finishSpecialist(true);
          await ctx.emit("agent_spawned", { agent: specialist.agent, status: specialist.status });
          lastSpecialist = specialist.agent;
        } else {
          await ctx.emit("agent_status", { agent: specialist.agent, status: specialist.status });
        }
        // Milestone message only when the finished phase genuinely took a while.
        if (Date.now() - phaseStartedAt > MILESTONE_MIN_PHASE_MS && PHASE_MILESTONES[data.phase]) {
          sayProgress(PHASE_MILESTONES[data.phase]).catch(() => {});
        }
        phaseStartedAt = Date.now();
        return;
      }
      if (name === "end") {
        clearInterval(heartbeat);
        unsubscribe();

        // Fold this job's real usage into the LIFECYCLE totals before any decision — the
        // aggregate budget is what the next dispatch is checked against.
        const measurements = job.measurements || null;
        lifecycle.budget.record({
          usage: measurements?.usage, credits: measurements?.credits, turns: measurements?.turns,
        });

        const signals = signalsFromJob(job, data);
        const previous = lifecycle.rounds[lifecycle.rounds.length - 1] || null;
        const progress = attempt > 1 ? evaluateProgress(previous, signals) : null;

        // Did the patch this round applied do the right thing? Checked BEFORE the plan, so the
        // planner can act on the verdict and the next brief can quote it. A patch that never
        // engaged with the error costs no attempt — otherwise escalating just burns budget faster.
        const patchVerdict = attempt > 1 && lifecycle.treeBefore
          ? verifyPatch({
            before: lifecycle.treeBefore,
            after: data.result?.tree || lifecycle.treeBefore,
            output: job?.buildStderr || String(data?.error || ""),
            fingerprint: signals.failureFingerprint,
            previousFingerprint: previous?.failureFingerprint || null,
            resolved: data.result?.buildOk === true,
          })
          : null;
        if (patchVerdict) {
          console.log(`[app-build ${lifecycle.diag.id.slice(0, 8)}] patch ${patchVerdict.verdict}: ${patchVerdict.summary}`);
          lifecycle.diag.step({
            agent: "Lead Agent", kind: "verification", label: `Patch verification (round ${attempt})`,
            status: patchVerdict.verdict === "effective" ? "ok" : "failed",
            output: JSON.stringify(patchVerdict, null, 2), round: attempt,
          });
        }
        // The tree the NEXT round will be judged against.
        if (data.result?.tree) lifecycle.treeBefore = data.result.tree;
        lifecycle.rounds.push(signals);

        const check = await dispatchCheck(lifecycle);
        const action = planEndAction(data, {
          attempt,
          previousFingerprints: lifecycle.repairMemory.fingerprints,
          budgetCheck: check.ok ? { ok: true } : (check.budgetCheck || { ok: false, reason: "byok" }),
          progress,
          alternatives: alternativesFor(lifecycle),
          autoFallback: lifecycle.allowFallback,
          diagnostics: diagnosticsFor(job, data, lifecycle, signals, patchVerdict),
          strategyId: lifecycle.strategy || FIRST_STRATEGY,
        });
        // Which rung the NEXT round climbs to, remembered on the lifecycle so an escalation
        // survives across dispatches rather than restarting from the bottom every time.
        if (action.strategy) lifecycle.strategy = action.strategy;
        lifecycle.endState = action.endState;
        await finishSpecialist(action.kind === "verify" || action.kind === "warmup");

        // Persist the latest state for every completed job so progress is never lost. A
        // checkpoint of the state BEFORE this round already exists, so a regression can be
        // undone at the terminal stop.
        if (data.status === "complete") await deps.persistBuildResult(ctx.owner, projectId, data.result);
        if (data.result?.tree) {
          lifecycle.checkpoints.create({
            tree: data.result.tree, buildId: lifecycle.diag.id, jobId, attempt,
            status: data.status, compileOk: signals.compileOk, previewOk: signals.previewOk,
            usageTotals: lifecycle.budget.totals, label: `round ${attempt}`,
          });
        }

        // ── Cancellation: stop everything. No dispatch, no model call, no further spend. ──
        if (action.kind === "cancelled") {
          lifecycle.diag.finish("cancelled");
          recordOutcome(lifecycle, { action, attempt, trigger: job.trigger || "user", signals, progress });
          await ctx.conversations.appendTurn(ctx.conversation, {
            role: "lead", content: action.message, payload: { jobId, projectId, cancelled: true },
          });
          await ctx.emit("message", { role: "lead", text: action.message, projectId });
          return;
        }

        if (action.kind === "verify") {
          await ctx.emit("preview_ready", { url: data.result.previewUrl, projectId, message: "Preview ready — take a look." });
          deps.verify(ctx, { projectId, jobId, previewUrl: data.result.previewUrl, result: data.result, attempt, lifecycle, job, deps })
            .catch((error) => console.error("[app-build] verification:", error.message));
          return;
        }
        if (action.kind === "warmup") {
          lifecycle.diag.finish("complete_unverified");
          recordOutcome(lifecycle, { action, attempt, trigger: job.trigger || "user", signals, progress });
          recoverPreview(ctx, projectId).catch((error) => console.error("[app-build] preview recovery:", error.message));
          const text = `${buildEndSummary(data.result)}${data.result?.finalText ? ` ${String(data.result.finalText).slice(0, 400)}` : ""}`;
          await ctx.conversations.appendTurn(ctx.conversation, { role: "lead", content: text, payload: { jobId, projectId } });
          await ctx.emit("message", { role: "lead", text, projectId });
          return;
        }

        // ── Provider limit: switch, never retry the same provider blindly. ───────────────
        if (action.kind === "switch_provider") {
          await handleProviderSwitch(ctx, {
            action, lifecycle, attempt, jobId, projectId, signals, progress, job, deps,
          });
          return;
        }

        // ── Repair / legitimate retry ────────────────────────────────────────────────────
        if (action.kind === "repair" || action.kind === "retry") {
          const isRetry = action.kind === "retry";
          // THE PROMPT FIX: a retry re-sends the complete ORIGINAL input from the lifecycle.
          // `job.prompt` never existed — the prompt lives at job.input.prompt — so every
          // retry used to dispatch with an undefined prompt.
          const nextBrief = isRetry ? lifecycle.originalInput.prompt : action.brief;
          if (!isRetry && !String(nextBrief || "").trim()) {
            // Defensive: a repair with no brief is never dispatched.
            await stopWithMessage(ctx, lifecycle, {
              action: { ...action, kind: "blocked" }, attempt, jobId, projectId, signals, progress,
              text: `${attemptSummary(attempt)} I couldn't compose a safe repair for what failed, so I've stopped rather than guess. Your current work is saved.`,
            });
            return;
          }
          const briefFp = fingerprintPrompt(nextBrief);
          if (!isRetry && lifecycle.repairMemory.briefs.includes(briefFp)) {
            await stopWithMessage(ctx, lifecycle, {
              action: { ...action, kind: "blocked" }, attempt, jobId, projectId, signals, progress,
              text: `I stopped the repair loop: it was about to send the exact same repair instructions again, which means the previous attempt didn't change the outcome.`,
              briefFingerprint: briefFp,
            });
            return;
          }
          if (action.fingerprint) lifecycle.repairMemory.fingerprints.push(action.fingerprint);
          if (!isRetry) lifecycle.repairMemory.briefs.push(briefFp);

          const nextRound = attempt + 1;
          // Checkpoint the state we are about to change, so a worse result can be undone.
          const before = lifecycle.checkpoints.latest();
          await sayProgress(action.announcement);
          if (!lifecycle.managed) {
            const warning = byokWarning(lifecycle.byokSafety, {
              lifecycleCost: lifecycle.budget.totals.credits, alreadyWarned: lifecycle.byokWarned,
            });
            if (warning) { lifecycle.byokWarned = true; await sayProgress(warning); }
          }
          lifecycle.diag.repairDispatched({ prompt: nextBrief, round: nextRound });
          if (!isRetry) lifecycle.budget.noteRepair();
          recordOutcome(lifecycle, {
            action, attempt, trigger: job.trigger || "user", signals, progress,
            checkpointBefore: before?.id || null,
            extra: { briefFingerprint: briefFp, strategy: isRetry ? "resume original request" : "targeted repair brief", reason: progress?.reason || null },
          });

          const { job: next } = await deps.createJob({
            owner: { id: ctx.owner }, projectId,
            // A retry resumes the ORIGINAL request; a repair is a targeted edit.
            ...(isRetry
              ? { ...lifecycle.originalInput }
              : { mode: "iterate", prompt: nextBrief }),
            trigger: isRetry ? "transient_retry" : "autonomous_repair",
            diag: lifecycle.diag.recorderForJob({ round: nextRound }),
            budgetAllowance: lifecycle.managed ? lifecycle.budget.jobAllowance(Infinity) : null,
            byokCostLimit: lifecycle.managed ? null : lifecycle.byokSafety.maxCostPerBuild,
            providerOverride: lifecycle.providerOverride,
          });
          lifecycle.budget.noteJob();
          relayBuildJob(ctx, { job: next, projectId, attempt: nextRound, lifecycle, deps });
          return;
        }

        // ── Terminal: blocked, or waiting on the user ────────────────────────────────────
        await stopWithMessage(ctx, lifecycle, {
          action, attempt, jobId, projectId, signals, progress,
          text: action.message || terminalMessageFor(lifecycle, action, check),
        });
      }
    } catch (error) {
      console.error("[app-build] relay:", error.message);
    }
  });
}

// The message for a stop whose copy depends on live lifecycle state rather than the pure
// planner: budget refusals and BYOK-control refusals.
function terminalMessageFor(lifecycle, action, check) {
  if (check && check.kind === "byok" && check.byok) return byokBlockedMessage(check.byok);
  if (action.endState === "managed_budget_blocked" || check?.kind === "budget") {
    return budgetBlockedMessage(check?.budgetCheck || { reason: "credits" }, {
      alternatives: alternativesFor(lifecycle),
    });
  }
  return `${attemptSummary(1)} I've reached the safe automatic repair limit. Your current work is saved.`;
}

// Every terminal stop goes through here: restore a better checkpoint if this round made
// things worse, finish Diagnostics, tell the user calmly, and notify exactly once.
async function stopWithMessage(ctx, lifecycle, { action, attempt, jobId, projectId, signals, progress, text, briefFingerprint = null }) {
  // If the last round regressed, put the better version back before stopping (§8).
  let restored = null;
  const previous = lifecycle.rounds[lifecycle.rounds.length - 2] || null;
  if (regressed(previous, signals)) {
    const better = lifecycle.checkpoints.betterThanLatest();
    if (better) {
      restored = await restoreCheckpoint(better, {
        client: lifecycle.client, owner: ctx.owner, projectId,
      });
      if (restored?.restored) {
        // Outcome evidence, and the one negative signal produced server-side: this build was
        // bad enough that a previous version had to be put back. The build id is known
        // directly from the lifecycle, so no lookup is needed.
        const { signalBuildOutcome } = await import("../buildOutcomes.mjs");
        signalBuildOutcome({
          owner: ctx.owner, buildId: lifecycle.diag.id, signal: "rolled_back",
          client: lifecycle.client,
        }).catch(() => {});
      }
    }
  }

  const needsUser = action.kind === "request_user_input";
  lifecycle.diag.finish(needsUser ? "needs_input" : "failed");

  const restoredLine = restored?.restored
    ? "\n\nI've put the last working version back, so nothing you had is lost."
    : "";
  const body = `${text}${restoredLine}\n\n${lifecycle.diag.failureEvidence()}`;
  await ctx.conversations.appendTurn(ctx.conversation, {
    role: "lead", content: body, payload: { jobId, projectId, buildId: lifecycle.diag.id },
  });
  await ctx.emit("message", { role: "lead", text: body, projectId });

  // Lifecycle over: keep the best checkpoint as the safety net and release the rest now
  // rather than waiting for the retention sweep.
  releaseLifecycleCheckpoints({ client: lifecycle.client, owner: ctx.owner, buildId: lifecycle.diag.id })
    .catch(() => {});

  const notified = await notifyTerminal(ctx, lifecycle, {
    title: needsUser ? "Build needs your input" : "Build needs a decision",
    body: needsUser
      ? "Something only you can provide is needed — open the conversation."
      : "Automatic repair has stopped — open the conversation.",
  });

  recordOutcome(lifecycle, {
    action, attempt, trigger: "lead", signals, progress, notified,
    checkpointBefore: lifecycle.checkpoints.latest()?.id || null,
    checkpointAfter: restored?.restored ? restored.checkpointId : null,
    extra: { briefFingerprint, reason: progress?.reason || action.reason || null },
  });
}

// Provider quota / rate limit / outage: preserve state, keep every lifecycle counter, and
// either switch automatically (when the owner enabled fallback) or offer the switch.
async function handleProviderSwitch(ctx, { action, lifecycle, attempt, jobId, projectId, signals, progress, job, deps = REAL_DEPS }) {
  const target = action.alternatives[0];
  const from = lifecycle.providerOverride || lifecycle.activeProvider;

  if (!action.auto) {
    lifecycle.diag.finish("needs_input");
    await ctx.conversations.appendTurn(ctx.conversation, {
      role: "lead", content: action.message, payload: { jobId, projectId, buildId: lifecycle.diag.id, providerSwitchOffered: true },
    });
    await ctx.emit("message", { role: "lead", text: action.message, projectId });
    const notified = await notifyTerminal(ctx, lifecycle, {
      title: "Build paused — provider limit",
      body: "Your progress is safe. Open the conversation to switch provider.",
    });
    recordOutcome(lifecycle, { action, attempt, trigger: job.trigger || "user", signals, progress, notified, extra: { provider: from, reason: `offered switch to ${target?.id || "alternative"}` } });
    return;
  }

  // Automatic fallback: switch and continue from the SAME step, keeping the lifecycle
  // budget, repair memory and fingerprints intact — this is not a new build.
  const check = await dispatchCheck(lifecycle);
  if (!check.ok) {
    await stopWithMessage(ctx, lifecycle, {
      action: { ...action, kind: "blocked" }, attempt, jobId, projectId, signals, progress,
      text: terminalMessageFor(lifecycle, action, check),
    });
    return;
  }

  lifecycle.providerOverride = target.id;
  lifecycle.switches.push({ from, to: target.id, reason: action.limit });
  await recordProviderSwitch({
    owner: ctx.owner, conversationId: ctx.conversation.id, buildId: lifecycle.diag.id,
    from, to: target.id, reason: action.limit === "rate_limit" ? "rate_limit" : action.limit === "outage" ? "outage" : "quota",
    detail: `app build round ${attempt}`, client: lifecycle.client,
  }).catch(() => {});

  const text = switchedMessage({ from, to: target.id, reason: action.limit });
  await ctx.conversations.appendTurn(ctx.conversation, { role: "lead", content: text, payload: { projectId, providerSwitched: true } });
  await ctx.emit("message", { role: "lead", text, projectId });

  const nextRound = attempt + 1;
  lifecycle.diag.repairDispatched({ prompt: lifecycle.originalInput.prompt, round: nextRound });
  recordOutcome(lifecycle, {
    action, attempt, trigger: job.trigger || "user", signals, progress,
    checkpointBefore: lifecycle.checkpoints.latest()?.id || null,
    extra: { provider: target.id, strategy: `switched from ${from} after ${action.limit}` },
  });

  const { job: next } = await deps.createJob({
    owner: { id: ctx.owner }, projectId,
    ...lifecycle.originalInput,
    trigger: "provider_switch",
    diag: lifecycle.diag.recorderForJob({ round: nextRound }),
    budgetAllowance: lifecycle.managed ? lifecycle.budget.jobAllowance(Infinity) : null,
    byokCostLimit: lifecycle.managed ? null : lifecycle.byokSafety.maxCostPerBuild,
    providerOverride: target.id,
  });
  lifecycle.budget.noteJob();
  relayBuildJob(ctx, { job: next, projectId, attempt: nextRound, lifecycle, deps });
}

// The Verification Agent gate (Stuart, 2026-07-31): before ANY completion message, the
// Verifier drives the live preview like a real user. PASS → completion + ✓ summary.
// FAIL → the build is rejected, the failures go back to the Builder in surgical repair
// mode (design/layout/branding preserved), and the repaired build is re-verified — up to
// two automatic repair rounds before reporting honestly.
async function runVerificationGate(ctx, { projectId, jobId, previewUrl, result, attempt = 1, lifecycle, job = null, deps = REAL_DEPS }) {
  const { verifyApp, repairPrompt } = await import("./verificationAgent.mjs");
  const { treeUsesBackendSdk } = await import("../appRuntimeStatus.mjs");
  const diag = lifecycle.diag;
  await ctx.emit("agent_spawned", { agent: "Verifier", status: "Verifying the app like a real user…" });
  const verifyStarted = Date.now();
  let verdict;
  try {
    verdict = await verifyApp({ previewUrl, usesBackend: treeUsesBackendSdk(result?.tree) });
  } catch (error) {
    verdict = { pass: false, failures: [`Verification could not run: ${error.message}`], summary: "" };
  }
  diag.step({
    agent: "Verifier", kind: "verification", label: `Verification (round ${attempt})`,
    status: verdict.pass ? "ok" : "failed", round: attempt,
    output: verdict.pass ? verdict.summary : (verdict.failures || []).join("\n"),
    durationMs: Date.now() - verifyStarted,
  });

  // ── CONTRACT JOURNEYS (PR6) ─────────────────────────────────────────────────────────────────
  //
  // The check above proves the app LOADS. This proves it DOES what was agreed, by driving the
  // contract's journeys in a real browser against the real preview and the real backend. Reported
  // and repaired SEPARATELY from compile success, because "it compiles" and "the booking persists"
  // are different claims and conflating them is how a convincing non-functional app ships.
  const contract = diag.contract;
  if (contract?.journeys?.length && previewUrl) {
    const journeyStarted = Date.now();
    let journeys;
    try {
      journeys = await verifyJourneys({ previewUrl, contract });
    } catch (error) {
      journeys = { unavailable: true, error: error.message, journeys: [] };
    }
    diag.step({
      agent: "Verifier", kind: "journey", label: `Contract journeys (round ${attempt})`,
      status: journeys.unavailable ? "ok" : (journeys.pass ? "ok" : "failed"), round: attempt,
      output: [
        journeySummary(journeys),
        ...(journeys.journeys || []).flatMap((j) => [
          `${j.status.toUpperCase()} ${j.title}`,
          ...(j.steps || []).map((s) => `    ${s.status}: ${s.action} → ${s.detail || s.expect}`),
        ]),
      ].join("\n"),
      durationMs: Date.now() - journeyStarted,
    });

    // A journey the driver could not steer is NOT a defect — failing a build because a heuristic
    // could not find a button would be the confidently-wrong mistake again, in the place where it
    // costs a whole rebuild. Only a real failure joins the verdict.
    const failures = journeyFailures(journeys);
    if (journeys.pass === false && failures.length) {
      verdict = {
        ...verdict,
        pass: false,
        failures: [...(verdict.failures || []), ...failures],
        journeyFailure: true,
      };
    }
    verdict.journeys = journeys;
  }

  if (verdict.pass) {
    diag.finish("passed");
    await ctx.emit("agent_done", { agent: "Verifier", ok: true });
    await ctx.emit("verification", { pass: true, summary: verdict.summary, projectId });
    const text = `Your app is built, verified, and live in this conversation.\n\n${verdict.summary}${result?.finalText ? `\n\n${String(result.finalText).slice(0, 300)}` : ""}`;
    await ctx.conversations.appendTurn(ctx.conversation, { role: "lead", content: text, payload: { jobId, projectId, verified: true } });
    await ctx.emit("message", { role: "lead", text, projectId });
    notifyOwnerIfAway(ctx.owner, ctx.conversation.id, {
      title: "App verified", body: "Built, tested as a real user, and live.", url: previewUrl, tag: `build-${projectId}`,
    }).catch(() => {});
    return;
  }

  await ctx.emit("agent_done", { agent: "Verifier", ok: false });
  await ctx.emit("verification", { pass: false, failures: verdict.failures, projectId });

  // Fold the verification result into this round's signals so no-progress detection can see
  // whether the repair actually moved verification forward.
  const signals = signalsFromJob(job, { result }, { verdict });
  const previousIndex = lifecycle.rounds.length - 1;
  if (previousIndex >= 0) lifecycle.rounds[previousIndex] = signals;
  const previous = lifecycle.rounds[previousIndex - 1] || null;
  const progress = attempt > 1 ? evaluateProgress(previous, signals) : null;

  const check = await dispatchCheck(lifecycle);
  const action = planVerificationAction(verdict, {
    attempt,
    previousFingerprints: lifecycle.repairMemory.fingerprints,
    budgetCheck: check.ok ? { ok: true } : (check.budgetCheck || { ok: false, reason: "byok" }),
    progress,
  });
  lifecycle.endState = action.endState;

  if (action.kind === "repair") {
    const brief = repairPrompt(verdict.failures);
    const briefFp = fingerprintPrompt(brief);
    if (lifecycle.repairMemory.briefs.includes(briefFp)) {
      await stopWithMessage(ctx, lifecycle, {
        action: { ...action, kind: "blocked" }, attempt, jobId, projectId, signals, progress,
        text: "I stopped the repair loop: it was about to send the exact same repair instructions again, which means the previous attempt didn't change the outcome.",
        briefFingerprint: briefFp,
      });
      return;
    }
    lifecycle.repairMemory.fingerprints.push(action.fingerprint);
    lifecycle.repairMemory.briefs.push(briefFp);

    const text = progress?.improved
      ? `The last repair improved the build. I'm fixing the remaining issue now — attempt ${attempt} of ${MAX_AUTO_REPAIRS}.`
      : `A check found a problem. I'm repairing it now and will re-run verification — attempt ${attempt} of ${MAX_AUTO_REPAIRS}.`;
    await ctx.conversations.appendTurn(ctx.conversation, { role: "lead", content: text, payload: { projectId } });
    await ctx.emit("message", { role: "lead", text, projectId });

    const nextRound = attempt + 1;
    const before = lifecycle.checkpoints.latest();
    diag.repairDispatched({ prompt: brief, round: nextRound });
    lifecycle.budget.noteRepair();
    recordOutcome(lifecycle, {
      action, attempt, trigger: "verification_repair", signals, progress,
      checkpointBefore: before?.id || null,
      extra: {
        briefFingerprint: briefFp, strategy: "verification repair brief",
        verificationBefore: previous?.verificationPassed ?? null, verificationAfter: verdict.pass,
      },
    });
    const { job: next } = await deps.createJob({
      owner: { id: ctx.owner }, projectId, mode: "iterate",
      prompt: brief,
      trigger: "verification_repair",
      diag: diag.recorderForJob({ round: nextRound }),
      budgetAllowance: lifecycle.managed ? lifecycle.budget.jobAllowance(Infinity) : null,
      byokCostLimit: lifecycle.managed ? null : lifecycle.byokSafety.maxCostPerBuild,
      providerOverride: lifecycle.providerOverride,
    });
    lifecycle.budget.noteJob();
    relayBuildJob(ctx, { job: next, projectId, attempt: nextRound, lifecycle, deps });
    return;
  }

  // Terminal: exhausted, blocked, or waiting on the user. Same single stop path as the
  // build-failure gate, so owner notification and checkpoint restore are never skipped.
  await stopWithMessage(ctx, lifecycle, {
    action, attempt, jobId, projectId, signals, progress,
    text: action.message || terminalMessageFor(lifecycle, action, check),
  });
}

// Late preview recovery: the container often finishes warming up shortly after the build
// relay ends. Poll the provider, and the moment a URL exists, deliver the card + an honest
// follow-up. If it never comes up, say so — with the sentence that fixes it.
async function recoverPreview(ctx, projectId, { attempts = 9, delayMs = 20_000 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      const preview = await previewProvider().get(projectId);
      if (preview?.url) {
        await serviceClient().from("projects").update({ preview_ref: preview.url, updated_at: new Date().toISOString() })
          .eq("id", projectId).eq("owner", ctx.owner);
        await ctx.emit("preview_ready", { url: preview.url, projectId, message: "Preview ready — take a look." });
        const text = "Here's the preview — it needed a moment to warm up.";
        await ctx.conversations.appendTurn(ctx.conversation, { role: "lead", content: text, payload: { projectId } });
        await ctx.emit("message", { role: "lead", text, projectId });
        notifyOwnerIfAway(ctx.owner, ctx.conversation.id, {
          title: "Preview ready", body: "Your app's preview is up — take a look.", url: preview.url, tag: `build-${projectId}`,
        }).catch(() => {});
        return;
      }
    } catch { /* provider hiccup — keep polling */ }
  }
  const text = "The preview infrastructure isn't responding after repeated automatic attempts — the build itself is fine, and I'll bring the preview up the moment the infrastructure recovers.";
  await ctx.conversations.appendTurn(ctx.conversation, { role: "lead", content: text, payload: { projectId } });
  await ctx.emit("message", { role: "lead", text, projectId });
}

// repair_app capability backing: surgical fix on the EXISTING tree (iterate mode) with the
// preservation rules baked into the prompt. Build once, repair precisely, verify completely.
export async function repairApp(ctx, { issue, productName = null }) {
  const client = serviceClient();
  // Scoped to this conversation's product. Resolving by "the owner's newest project" meant this
  // could act on an app from a different conversation entirely.
  const { resolveConversationProject } = await import("./projectScope.mjs");
  const { project } = await resolveConversationProject(ctx, { productName, columns: "id, name, tree, product_id, updated_at", client });
  if (!project) {
    const error = new Error("There's no existing app to repair — describe what you want built instead.");
    error.code = "nothing_to_repair";
    throw error;
  }
  const prompt = [
    `REPAIR MODE — fix ONLY this reported problem in the existing app "${project.name}":`,
    issue,
    "",
    "Hard rules: preserve the existing design, layout, colours, branding, UX and component",
    "structure exactly. Do NOT redesign, restyle, or rebuild anything. Make the minimum code",
    "change that fixes the reported problem. Do not touch unrelated files.",
  ].join("\n");
  const diag = await startDiagSessionSafe({
    owner: ctx.owner, projectId: project.id, conversationId: ctx.conversation.id,
    kind: "repair", prompt: String(issue),
  });
  const originalInput = { mode: "iterate", prompt, taskHint: String(issue) };
  const lifecycle = await createLifecycle({
    owner: ctx.owner, projectId: project.id, diag, originalInput, mode: "iterate", client,
  });
  const { job } = await createJob({
    owner: { id: ctx.owner }, projectId: project.id,
    ...originalInput, // taskHint classifies from the user's words, not the REPAIR MODE wrapper
    diag: diag.recorderForJob({ round: 1 }),
    budgetAllowance: lifecycle.managed ? lifecycle.budget.jobAllowance(Infinity) : null,
    byokCostLimit: lifecycle.managed ? null : lifecycle.byokSafety.maxCostPerBuild,
  });
  lifecycle.budget.noteJob();
  relayBuildJob(ctx, { job, projectId: project.id, lifecycle });
  await ctx.emit("build_started", { jobId: job.id, projectId: project.id, buildId: diag.id, message: "Repairing — design untouched." });
  return { jobId: job.id, projectId: project.id, buildId: diag.id, note: "Repair dispatched; the fix will be verified before completion is announced." };
}

// show_preview capability backing: (re)provision the preview for a project from its stored
// tree — heals reaped containers, warm-up timeouts, and old conversations alike.
export async function showPreview(ctx, { productName = null } = {}) {
  const client = serviceClient();
  // Scoped to this conversation's product. Resolving by "the owner's newest project" meant this
  // could act on an app from a different conversation entirely.
  const { resolveConversationProject } = await import("./projectScope.mjs");
  const { project } = await resolveConversationProject(ctx, { productName, columns: "id, name, tree, product_id, updated_at", client });
  if (!project) {
    const error = new Error("There's no built app to preview yet — ask me to build something first.");
    error.code = "nothing_to_preview";
    throw error;
  }
  await ctx.emit("agent_spawned", { agent: "Publisher", status: "Bringing the preview up…" });
  try {
    const { withRuntimeEnv } = await import("../runtimeEnv.mjs");
    const preview = await previewProvider().start(project.id, withRuntimeEnv(project.tree, project.id));
    if (!preview?.url) throw new Error("The preview service returned no address.");
    await client.from("projects").update({ preview_ref: preview.url, updated_at: new Date().toISOString() })
      .eq("id", project.id).eq("owner", ctx.owner);
    await ctx.emit("agent_done", { agent: "Publisher", ok: true });
    await ctx.emit("preview_ready", { url: preview.url, projectId: project.id, message: "Preview ready — take a look." });
    return { url: preview.url, projectId: project.id, note: "The preview card is in the conversation — do not repeat the URL." };
  } catch (error) {
    await ctx.emit("agent_done", { agent: "Publisher", ok: false });
    throw error;
  }
}

// run_qa capability backing: a responsive/multi-route sweep of the user's live app.
//
// Complements rather than duplicates the Verification Agent. That proves ONE path works at ONE
// viewport (signup → data → reload → persistence); this crawls the app's routes at several
// widths, collecting console errors and screenshots. Responsive quality had no coverage at all
// before this — verificationAgent.mjs contains zero viewport handling.
export async function runQaSweep(ctx, { productName = null } = {}) {
  const client = serviceClient();
  // Scoped to this conversation's product. Resolving by "the owner's newest project" meant this
  // could act on an app from a different conversation entirely.
  const { resolveConversationProject } = await import("./projectScope.mjs");
  const { project } = await resolveConversationProject(ctx, { productName, columns: "id, name, tree, product_id, updated_at", client });
  if (!project) {
    const error = new Error("There's no built app to test yet — ask me to build something first.");
    error.code = "nothing_to_test";
    throw error;
  }

  const { createQaRun } = await import("../qaRuns.mjs");
  await ctx.emit("agent_spawned", { agent: "Tester", status: "Testing the app across screen sizes…" });
  try {
    const run = await createQaRun({ id: ctx.owner }, project.id, client);
    if (!run) throw new Error("That project could not be found.");
    return {
      runId: run.id,
      projectId: project.id,
      status: run.status,
      note: "The sweep is running; I'll report what it finds across phone, tablet and desktop widths.",
    };
  } catch (error) {
    await ctx.emit("agent_done", { agent: "Tester", ok: false });
    throw error;
  }
}

// export_project capability backing: package the user's source as a downloadable ZIP.
//
// The artifact is theirs, not the platform's: dependencies, build output and every secret are
// stripped before the ZIP is assembled, and assertNoPlatformSecrets refuses to produce it at all
// if anything slipped through. Both filters read the same rule set (lib/secretScrub.mjs).
export async function exportProject(ctx, { productName = null } = {}) {
  const client = serviceClient();
  // Scoped to this conversation's product. Resolving by "the owner's newest project" meant this
  // could act on an app from a different conversation entirely.
  const { resolveConversationProject } = await import("./projectScope.mjs");
  const { project } = await resolveConversationProject(ctx, { productName, columns: "id, name, tree, history, product_id, updated_at", client });
  if (!project) {
    const error = new Error("There's no built app to export yet — ask me to build something first.");
    error.code = "nothing_to_export";
    throw error;
  }

  const { buildProjectZip } = await import("../exportProject.mjs");
  const { assertNoPlatformSecrets, stripExportNoise } = await import("../secretScrub.mjs");

  await ctx.emit("agent_spawned", { agent: "Publisher", status: "Packaging the source…" });
  try {
    const cleaned = stripExportNoise(project.tree);
    const built = buildProjectZip({ ...project, tree: cleaned.files });
    assertNoPlatformSecrets(built.files);

    // Outcome evidence: a user who exports their source has kept the build. Recorded only
    // after the artifact is proven safe, and never allowed to fail the export.
    const { signalBuildOutcome } = await import("../buildOutcomes.mjs");
    signalBuildOutcome({ owner: ctx.owner, projectId: project.id, signal: "exported" }).catch(() => {});

    await ctx.emit("agent_done", { agent: "Publisher", ok: true });
    await ctx.emit("download_ready", {
      projectId: project.id,
      filename: built.filename,
      url: `/api/export?projectId=${encodeURIComponent(project.id)}`,
      sizeBytes: built.zip.length,
      fileCount: Object.keys(built.files).length,
      message: "Your source package is ready.",
    });
    return {
      projectId: project.id,
      filename: built.filename,
      fileCount: Object.keys(built.files).length,
      note: "The download card is in the conversation — do not repeat the link.",
    };
  } catch (error) {
    await ctx.emit("agent_done", { agent: "Publisher", ok: false });
    throw error;
  }
}

async function persistBuildResult(owner, projectId, result) {
  if (!result?.tree) return;
  const client = serviceClient();
  const { error } = await client.from("projects").update({
    tree: result.tree,
    design_profile: result.designProfile || null,
    preview_ref: result.previewUrl || null,
    updated_at: new Date().toISOString(),
  }).eq("id", projectId).eq("owner", owner);
  if (error) console.error("[app-build] tree persistence:", error.message);
}

export async function buildJobSnapshot(ownerId, jobId) {
  const job = await getJob(ownerId, jobId);
  if (!job) return null;
  return { jobId: job.id, status: job.status, phase: job.phase, terminal: isTerminal(job) };
}
