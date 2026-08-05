// Regression suite for the app-build retry/repair pipeline hardening (2026-08-01).
//
// The four confirmed defects these lock down:
//   1. user cancellation was classified as a crash and retried as paid work
//   2. managed-budget / cost-guard stops were retried, spending more against a spent budget
//   3. the retry path read job.prompt, which never existed (the prompt is job.input.prompt),
//      so every retry dispatched with an undefined prompt
//   4. each dispatched job received a fresh independent allowance — no aggregate ceiling
// Plus the protections added alongside them: no-progress detection, checkpoints, provider
// fallback, human-input blockers, accurate attempt wording, consistent owner notification.

process.env.CODE_AGENT_STORE = "memory";

import assert from "node:assert/strict";
import test from "node:test";

import {
  planEndAction, planVerificationAction, attemptSummary, repairStatusLine,
  MAX_AUTO_ROUNDS, MAX_AUTO_REPAIRS,
} from "../../shell/server/lib/appBuild/appBuildService.mjs";
import {
  classifyEndState, classifyVerificationState, providerCondition, humanInputNeed,
  isAutomaticallyRetryable, isProviderBlocked, END_STATES, STOP_REASONS,
} from "../../shell/server/lib/appBuild/endState.mjs";
import { createLifecycleBudget, lifecycleLimits } from "../../shell/server/lib/appBuild/lifecycleBudget.mjs";
import { resolveProviderPolicy } from "../../shell/server/lib/appBuild/providerPolicy.mjs";
import {
  normalizeByokSafety, byokDispatchCheck, byokControlsEnabled, BYOK_SAFETY_DEFAULTS,
} from "../../shell/server/lib/appBuild/byokSafety.mjs";
import { roundSignals, evaluateProgress, regressed } from "../../shell/server/lib/appBuild/repairProgress.mjs";
import { createCheckpointStore, restoreCheckpoint, markForState } from "../../shell/server/lib/appBuild/buildCheckpoints.mjs";

const CANCELLED = { status: "failed", error: "Cancelled by user.", stopReason: STOP_REASONS.cancelled };
const BUDGET = { status: "failed", error: "Your monthly managed-usage safety limit has been reached.", stopReason: STOP_REASONS.managedBudget };
const COST_GUARD = { status: "failed", error: "projected above the autonomous ceiling", stopReason: STOP_REASONS.costGuard };
const RESTART = { status: "interrupted", error: "Build was interrupted by a server restart — please rebuild." };
const FAILED_CHECKS = { status: "complete", result: { buildOk: false, qualityWarnings: ["auth configuration invalid"] } };

// ── 1. user cancellation ────────────────────────────────────────────────────────────────

test("user cancellation never retries and never dispatches follow-up work", () => {
  assert.equal(classifyEndState(CANCELLED), "cancelled");
  const action = planEndAction(CANCELLED, { attempt: 1 });
  assert.equal(action.kind, "cancelled");
  assert.equal(action.endState, "cancelled");
  assert.match(action.message, /Build cancelled\. Your current progress has been saved\./);
  // The whole point: no dispatch-shaped action, at any attempt number.
  for (const attempt of [1, 2, 3]) {
    const a = planEndAction(CANCELLED, { attempt });
    assert.ok(!["repair", "retry", "switch_provider"].includes(a.kind), `attempt ${attempt} must not dispatch`);
  }
  assert.equal(isAutomaticallyRetryable("cancelled"), false);
});

test("cancellation creates zero new AI calls — no brief, no prompt, nothing to send", () => {
  const action = planEndAction(CANCELLED, { attempt: 2, previousFingerprints: [] });
  assert.equal(action.brief, undefined, "a cancelled build must not compose a repair brief");
  assert.equal(action.announcement, undefined, "a cancelled build must not announce further work");
});

// ── 2. budget and quota exhaustion ──────────────────────────────────────────────────────

test("managed budget exhaustion is blocked, never retried", () => {
  assert.equal(classifyEndState(BUDGET), "managed_budget_blocked");
  const action = planEndAction(BUDGET, { attempt: 1 });
  assert.equal(action.kind, "request_user_input");
  assert.notEqual(action.kind, "retry");
  assert.equal(action.reason, "budget");
});

test("a cost-guard refusal is a budget decision, not a crash", () => {
  assert.equal(classifyEndState(COST_GUARD), "managed_budget_blocked");
  assert.equal(planEndAction(COST_GUARD, { attempt: 1 }).kind, "request_user_input");
});

test("provider quota exhaustion never retries the same provider blindly", () => {
  const quota = { status: "failed", error: "The AI provider has reached its current limit.", stopReason: STOP_REASONS.providerQuota };
  assert.equal(classifyEndState(quota), "provider_quota_blocked");
  // No alternatives configured -> ask, never retry.
  const alone = planEndAction(quota, { attempt: 1, alternatives: [] });
  assert.equal(alone.kind, "request_user_input");
  assert.notEqual(alone.kind, "retry");
  // Alternatives configured -> offer a switch, still never a same-provider retry.
  const withAlt = planEndAction(quota, { attempt: 1, alternatives: [{ id: "xai", label: "Grok" }] });
  assert.equal(withAlt.kind, "switch_provider");
  assert.notEqual(withAlt.kind, "retry");
});

test("provider conditions are classified apart from one another", () => {
  assert.equal(providerCondition("429 insufficient_quota: you exceeded your current quota"), "provider_quota_blocked");
  assert.equal(providerCondition("429 rate limit reached for requests"), "provider_rate_limited");
  assert.equal(providerCondition("503 service unavailable"), "provider_unavailable");
  assert.equal(providerCondition("something ordinary went wrong"), null);
  // A spent balance reported with a 429 is exhaustion, not a rate limit — different remedy.
  assert.equal(providerCondition("429 Your credit balance is too low"), "provider_quota_blocked");
  for (const state of ["provider_quota_blocked", "provider_rate_limited", "provider_unavailable"]) {
    assert.equal(isProviderBlocked(state), true);
    assert.equal(isAutomaticallyRetryable(state), false, `${state} must not auto-retry`);
  }
});

test("automatic fallback only happens when the owner enabled it", () => {
  const quota = { status: "failed", stopReason: STOP_REASONS.providerQuota, error: "limit" };
  const alternatives = [{ id: "xai", label: "Grok" }];
  const off = planEndAction(quota, { attempt: 1, alternatives, autoFallback: false });
  assert.equal(off.auto, false);
  assert.match(off.message, /Switch and continue\?/);
  const on = planEndAction(quota, { attempt: 1, alternatives, autoFallback: true });
  assert.equal(on.auto, true);
});

// ── 3. retry prompt loss ────────────────────────────────────────────────────────────────

test("a legitimate retry is planned for transient interruptions only", () => {
  assert.equal(classifyEndState(RESTART), "transient_interruption");
  const action = planEndAction(RESTART, { attempt: 1 });
  assert.equal(action.kind, "retry");
  // A plain unexplained failure is NOT transient — it used to be retried blindly.
  const permanent = { status: "failed", error: "The build hit an unexpected error — please try again." };
  assert.equal(classifyEndState(permanent), "permanent_failure");
  assert.equal(planEndAction(permanent, { attempt: 1 }).kind, "blocked");
});

test("retries carry the complete original prompt; repairs carry their targeted brief", async () => {
  const { dispatched, lifecycle } = await runRelayScenario([RESTART]);
  assert.equal(dispatched.length, 1, "exactly one retry dispatched");
  const retry = dispatched[0];
  assert.equal(retry.prompt, lifecycle.originalInput.prompt, "the ORIGINAL prompt, unmutated");
  assert.equal(retry.mode, "build", "a retry resumes the original request, not an edit");
  assert.ok(String(retry.prompt || "").trim().length > 0, "never undefined or empty");
  assert.equal(retry.trigger, "transient_retry");

  const repaired = await runRelayScenario([FAILED_CHECKS]);
  const repair = repaired.dispatched[0];
  assert.equal(repair.mode, "iterate");
  assert.match(repair.prompt, /AUTONOMOUS REPAIR/);
  assert.match(repair.prompt, /auth configuration invalid/);
  assert.notEqual(repair.prompt, repaired.lifecycle.originalInput.prompt);
});

test("no dispatch ever receives an undefined or empty prompt", async () => {
  for (const scenario of [[RESTART], [FAILED_CHECKS], [RESTART, FAILED_CHECKS]]) {
    const { dispatched } = await runRelayScenario(scenario);
    for (const job of dispatched) {
      assert.ok(job.prompt !== undefined, "prompt must be defined");
      assert.ok(String(job.prompt).trim().length > 0, "prompt must be non-empty");
    }
  }
});

test("existing project state is preserved across a retry", async () => {
  const { projectTree } = await runRelayScenario([RESTART], { treeAtRound: { "src/App.jsx": "kept" } });
  assert.deepEqual(projectTree, { "src/App.jsx": "kept" }, "the stored tree survives the retry");
});

// ── 4. aggregate lifecycle budget ───────────────────────────────────────────────────────

test("the managed budget spans the whole lifecycle instead of resetting per job", () => {
  const budget = createLifecycleBudget({ plan: "free", mode: "build", managed: true });
  const cap = budget.limits.credits;
  assert.ok(cap > 0);
  budget.noteJob();
  budget.record({ usage: { input: 1000, output: 100, cached: 10 }, credits: cap * 0.6, turns: 8 });
  // A second job sees a REDUCED allowance — the defect was that it saw the full cap again.
  const afterFirst = budget.remaining().credits;
  assert.ok(afterFirst < cap, "remaining credits fall after the first job");
  assert.equal(budget.jobAllowance(Infinity), afterFirst);
  budget.noteJob();
  budget.record({ credits: cap * 0.5, turns: 8 });
  assert.equal(budget.canDispatch().ok, false, "the lifecycle refuses once the aggregate is spent");
  assert.equal(budget.canDispatch().reason, "credits");
});

test("aggregate counters accumulate every dimension across rounds and switches", () => {
  const budget = createLifecycleBudget({ plan: "pro", mode: "build", managed: true });
  budget.noteJob();
  budget.record({ usage: { input: 100, output: 20, cached: 5, reasoning: 3 }, credits: 1, turns: 4 });
  budget.noteRepair();
  budget.noteJob();
  budget.record({ usage: { input: 200, output: 40, cached: 10, reasoning: 6 }, credits: 2, turns: 6 });
  const t = budget.totals;
  assert.equal(t.inputTokens, 300);
  assert.equal(t.outputTokens, 60);
  assert.equal(t.cachedTokens, 15);
  assert.equal(t.turns, 10);
  assert.equal(t.credits, 3);
  assert.equal(t.jobs, 2);
  assert.equal(t.repairRounds, 1);
  assert.ok(Number.isFinite(t.elapsedMs));
});

test("the lifecycle job ceiling preserves the existing three-job maximum", () => {
  const budget = createLifecycleBudget({ plan: "free", mode: "build", managed: true });
  assert.equal(budget.limits.jobs, MAX_AUTO_ROUNDS);
  budget.noteJob(); budget.noteJob(); budget.noteJob();
  const check = budget.canDispatch();
  assert.equal(check.ok, false);
  assert.equal(check.reason, "jobs");
});

test("limits are configurable by plan and build mode", () => {
  const free = lifecycleLimits({ plan: "free", mode: "build" });
  const pro = lifecycleLimits({ plan: "pro", mode: "build" });
  assert.ok(pro.credits > free.credits, "a higher plan gets a larger lifecycle budget");
  assert.ok(lifecycleLimits({ plan: "free", mode: "iterate" }).credits < free.credits, "an edit lifecycle is smaller than a build");
  process.env.THRALLO_LIFECYCLE_CREDITS_FREE_BUILD = "7";
  try {
    assert.equal(lifecycleLimits({ plan: "free", mode: "build" }).credits, 7, "env override applies");
  } finally {
    delete process.env.THRALLO_LIFECYCLE_CREDITS_FREE_BUILD;
  }
});

test("a blocked lifecycle budget stops the loop instead of dispatching", () => {
  const action = planEndAction(FAILED_CHECKS, { attempt: 1, budgetCheck: { ok: false, reason: "credits" } });
  assert.equal(action.kind, "blocked");
  assert.notEqual(action.kind, "repair");
});

// ── 5. BYOK ─────────────────────────────────────────────────────────────────────────────

test("BYOK has no mandatory default cost cap", () => {
  const defaults = normalizeByokSafety(null);
  for (const [key, value] of Object.entries(BYOK_SAFETY_DEFAULTS)) {
    assert.equal(defaults[key], value);
    assert.equal(value, null, `${key} must default to disabled`);
  }
  assert.equal(byokControlsEnabled(null), false);
  // With nothing enabled, an expensive lifecycle is still allowed to continue.
  const check = byokDispatchCheck(null, { lifecycleCost: 10_000, dailySpend: 50_000, repairJobs: 2, projectedCost: 9_999 });
  assert.equal(check.ok, true, "BYOK is never blocked by a Thrallo-imposed spend cap");
});

test("optional BYOK limits take effect once the user enables them", () => {
  assert.equal(byokDispatchCheck({ maxRepairJobs: 1 }, { repairJobs: 1 }).reason, "max_repair_jobs");
  assert.equal(byokDispatchCheck({ maxCostPerBuild: 5 }, { lifecycleCost: 6 }).reason, "max_cost_per_build");
  assert.equal(byokDispatchCheck({ maxDailySpend: 20 }, { dailySpend: 25 }).reason, "max_daily_spend");
  const approval = byokDispatchCheck({ approvalThreshold: 3 }, { projectedCost: 9 });
  assert.equal(approval.reason, "approval_required");
  assert.equal(approval.needsApproval, true);
  assert.equal(byokControlsEnabled({ maxDailySpend: 20 }), true);
  // Zero and nonsense values mean "off", not "block everything".
  assert.equal(byokDispatchCheck({ maxCostPerBuild: 0 }, { lifecycleCost: 100 }).ok, true);
  assert.equal(byokDispatchCheck({ maxCostPerBuild: "nonsense" }, { lifecycleCost: 100 }).ok, true);
});

test("BYOK still cannot loop forever: the structural limits are not spend limits", () => {
  // Even with every optional control off, the lifecycle's job ceiling still applies.
  const budget = createLifecycleBudget({ plan: "free", mode: "build", managed: false });
  assert.equal(budget.remaining().credits, Infinity, "no credit ceiling for BYOK");
  budget.noteJob(); budget.noteJob(); budget.noteJob();
  assert.equal(budget.canDispatch().ok, false, "the job ceiling still stops the loop");
  assert.equal(budget.canDispatch().reason, "jobs");
});

// ── 6. fingerprints and no-progress detection ───────────────────────────────────────────

// PR3 changed what an identical failure MEANS. It used to end the run — and in production it did,
// at attempt 2 of 3, on four builds whose fingerprints were all ac60a9b42a79f171. Detecting no
// progress was always right; surrendering to it was not. It now escalates to a different strategy,
// and only the exhaustion of every strategy stops the loop.
test("an identical failure escalates the strategy instead of ending the run", () => {
  const first = planEndAction(FAILED_CHECKS, { attempt: 1 });
  assert.equal(first.kind, "repair");
  assert.equal(first.strategy, "targeted_fix");

  const repeat = planEndAction(FAILED_CHECKS, {
    attempt: 2, previousFingerprints: [first.fingerprint], strategyId: first.strategy,
  });
  assert.equal(repeat.kind, "repair", "the same failure twice is a reason to change approach, not to stop");
  assert.equal(repeat.strategy, "dependency_inspection");
  assert.match(repeat.announcement, /changing approach/);
});

test("a repair that changes nothing meaningful escalates too", () => {
  const before = roundSignals({ compileOk: false, failures: ["a", "b"], filesChanged: 1, diffChars: 500 });
  const after = roundSignals({ compileOk: false, failures: ["a", "b"], filesChanged: 0, diffChars: 0 });
  const verdict = evaluateProgress(before, after);
  assert.equal(verdict.improved, false);
  assert.match(verdict.reason, /no meaningful code change/);

  const action = planEndAction(FAILED_CHECKS, { attempt: 2, progress: verdict, strategyId: "targeted_fix" });
  assert.equal(action.kind, "repair");
  assert.equal(action.strategy, "dependency_inspection");
});

test("the loop stops only when every strategy has been tried", () => {
  // The fingerprint must genuinely repeat, or this is a first attempt rather than an escalation.
  const fingerprint = planEndAction(FAILED_CHECKS, { attempt: 1 }).fingerprint;
  const at = (strategyId) => planEndAction(FAILED_CHECKS, {
    attempt: 2, previousFingerprints: [fingerprint], strategyId,
  });

  assert.equal(at("targeted_fix").strategy, "dependency_inspection");
  assert.equal(at("dependency_inspection").strategy, "regenerate_module");
  assert.equal(at("regenerate_module").strategy, "revert_and_rebuild");
  // Tier 4 restores the last green checkpoint before rebuilding, so the floor is a working project.
  assert.equal(at("regenerate_module").restoreCheckpoint, true);

  const exhausted = at("revert_and_rebuild");
  assert.equal(exhausted.kind, "blocked");
  assert.equal(exhausted.exhausted, true);
  assert.match(exhausted.message, /four materially different approaches/);
});

test("measurable improvement lets the loop continue", () => {
  const before = roundSignals({ compileOk: false, failures: ["a", "b", "c"], filesChanged: 1, diffChars: 300 });
  assert.equal(evaluateProgress(before, roundSignals({ compileOk: true, failures: ["a"], filesChanged: 1, diffChars: 300 })).improved, true);
  assert.equal(evaluateProgress(before, roundSignals({ compileOk: false, failures: ["a", "b"], filesChanged: 1, diffChars: 300 })).improved, true);
  assert.equal(
    evaluateProgress(
      roundSignals({ previewOk: false, failures: ["x"] }),
      roundSignals({ previewOk: true, failures: ["x"] }),
    ).improved, true, "the preview loading further is progress",
  );
  assert.equal(
    evaluateProgress(
      roundSignals({ verificationChecksPassed: 2, verificationChecksTotal: 6, failures: ["x", "y"] }),
      roundSignals({ verificationChecksPassed: 4, verificationChecksTotal: 6, failures: ["x", "y"] }),
    ).improved, true, "a better verification score is progress",
  );
  // A broad failure narrowing to a subset is progress even at an unchanged count elsewhere.
  const broad = roundSignals({ failures: ["Signup: no fields", "Data persists: none", "Console clean: errors"], filesChanged: 2, diffChars: 400 });
  const narrow = roundSignals({ failures: ["Console clean: errors"], filesChanged: 2, diffChars: 400 });
  assert.equal(evaluateProgress(broad, narrow).improved, true);
});

test("a repeated repair strategy is not progress", () => {
  const before = roundSignals({ failures: ["a"], briefFingerprint: "same", filesChanged: 3, diffChars: 900 });
  const after = roundSignals({ failures: ["a"], briefFingerprint: "same", filesChanged: 3, diffChars: 900 });
  const verdict = evaluateProgress(before, after);
  assert.equal(verdict.improved, false);
  assert.match(verdict.reason, /repeated the previous strategy/);
});

test("the first repair is never blocked for lack of a comparison", () => {
  assert.equal(evaluateProgress(null, roundSignals({ failures: ["a"] })).improved, true);
});

test("regressions are detected so a worse state can be rolled back", () => {
  assert.equal(regressed(roundSignals({ compileOk: true }), roundSignals({ compileOk: false })), true);
  assert.equal(regressed(roundSignals({ failures: ["a"] }), roundSignals({ failures: ["a", "b"] })), true);
  assert.equal(regressed(roundSignals({ failures: ["a", "b"] }), roundSignals({ failures: ["a"] })), false);
});

// ── 7. human-input blockers ─────────────────────────────────────────────────────────────

test("human-input blockers stop immediately without consuming repair attempts", () => {
  const cases = [
    "The Stripe API key is not configured",
    "Permission denied writing to the bucket",
    "Missing file: logo.svg was never uploaded",
    "Please clarify which behaviour you want when a booking overlaps",
  ];
  for (const failure of cases) {
    assert.ok(humanInputNeed([failure]), `${failure} must be recognised as needing the user`);
    const data = { status: "complete", result: { buildOk: false, qualityWarnings: [failure] } };
    assert.equal(classifyEndState(data), "user_input_required");
    const action = planEndAction(data, { attempt: 1 });
    assert.equal(action.kind, "request_user_input", `${failure} must not enter the repair loop`);
    assert.notEqual(action.kind, "repair");
    assert.match(action.message, /needs /);
  }
  assert.equal(classifyVerificationState(["Signup: the API key is missing"]), "user_input_required");
  assert.equal(classifyVerificationState(["Console clean: TypeError in App.jsx"]), "verification_failed");
});

// ── 8. checkpoints ──────────────────────────────────────────────────────────────────────

test("checkpoints mark build quality and expose a last known good", () => {
  const store = createCheckpointStore();
  store.create({ tree: { a: "1" }, attempt: 1, compileOk: true, previewOk: true, verificationPassed: null });
  store.create({ tree: { a: "2" }, attempt: 2, compileOk: false });
  assert.equal(markForState({ compileOk: true, previewOk: true }), "preview-ready");
  assert.equal(markForState({ verificationPassed: true }), "verification-passed");
  assert.equal(markForState({ verificationPassed: false }), "verification-failed");
  assert.equal(markForState({}), "generated");
  const good = store.lastKnownGood();
  assert.equal(good.mark, "preview-ready");
  assert.deepEqual(good.tree, { a: "1" }, "the better state is retained in full");
  const better = store.betterThanLatest();
  assert.equal(better.id, good.id, "a worse latest round exposes a better checkpoint to restore");
});

test("a failed repair can restore the last better checkpoint", async () => {
  const store = createCheckpointStore();
  const good = store.create({ tree: { "src/App.jsx": "working" }, attempt: 1, compileOk: true, previewOk: true });
  store.create({ tree: { "src/App.jsx": "broken" }, attempt: 2, compileOk: false });
  const writes = [];
  const client = {
    from: () => ({ update: (row) => ({ eq: () => ({ eq: () => { writes.push(row); return { error: null }; } }) }) }),
  };
  const result = await restoreCheckpoint(store.betterThanLatest(), { client, owner: "o", projectId: "p" });
  assert.equal(result.restored, true);
  assert.equal(result.checkpointId, good.id);
  assert.deepEqual(writes[0].tree, { "src/App.jsx": "working" }, "the better tree is written back");
});

test("checkpoint retention is bounded but never evicts the best state", () => {
  const store = createCheckpointStore({ max: 3 });
  store.create({ tree: { v: "good" }, attempt: 1, compileOk: true, previewOk: true, verificationPassed: true });
  for (let i = 2; i <= 8; i += 1) store.create({ tree: { v: `bad${i}` }, attempt: i, compileOk: false });
  assert.ok(store.size() <= 3, "retention is bounded");
  assert.equal(store.lastKnownGood().mark, "verification-passed", "the best checkpoint survives pruning");
  assert.deepEqual(store.lastKnownGood().tree, { v: "good" });
});

test("checkpoints are not coupled to repo-agent checkpoints", async () => {
  const fs = await import("node:fs");
  const source = await fs.promises.readFile(
    new URL("../../shell/server/lib/appBuild/buildCheckpoints.mjs", import.meta.url), "utf8");
  // Comments may explain WHY the repo-agent table is not used; code must never touch it.
  const code = source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.doesNotMatch(code, /ca_checkpoints|ca_runs|sandbox_id|git_sha/, "must not touch repo-agent checkpoint storage");
  assert.match(code, /from\("projects"\)/, "restore writes through the app-build projects row");
});

// ── 9. attempt wording ──────────────────────────────────────────────────────────────────

test("attempt counts are accurate: the initial build plus at most two repairs", () => {
  assert.equal(MAX_AUTO_REPAIRS, MAX_AUTO_ROUNDS - 1);
  assert.equal(attemptSummary(1), "I completed the initial build.");
  assert.equal(attemptSummary(2), "I completed the initial build and 1 automatic repair attempt.");
  assert.equal(attemptSummary(3), "I completed the initial build and 2 automatic repair attempts.");
  const exhausted = planEndAction(FAILED_CHECKS, { attempt: MAX_AUTO_ROUNDS });
  assert.equal(exhausted.kind, "blocked");
  assert.match(exhausted.message, /2 automatic repair attempts/);
  assert.doesNotMatch(exhausted.message, /3 autonomous repair rounds/, "the old overstated wording is gone");
});

test("the in-progress status line is calm and states attempt N of M", () => {
  assert.equal(repairStatusLine(1), `Repairing the build — attempt 1 of ${MAX_AUTO_REPAIRS}.`);
  assert.match(repairStatusLine(2, { improved: true }), /The last repair improved the build\./);
});

// ── 10. end-state classification ────────────────────────────────────────────────────────

test("every classification maps to a defined action and no state falls through to retry", () => {
  const samples = {
    success: { status: "complete", result: { buildOk: true, previewUrl: "https://x/" } },
    cancelled: CANCELLED,
    managed_budget_blocked: BUDGET,
    provider_quota_blocked: { status: "failed", stopReason: STOP_REASONS.providerQuota },
    provider_rate_limited: { status: "failed", stopReason: STOP_REASONS.providerRateLimit },
    provider_unavailable: { status: "failed", stopReason: STOP_REASONS.providerUnavailable },
    transient_interruption: RESTART,
    repairable_failure: FAILED_CHECKS,
    permanent_failure: { status: "failed", error: "The build hit an unexpected error — please try again." },
    user_input_required: { status: "complete", result: { buildOk: false, qualityWarnings: ["The API key is not configured"] } },
  };
  const allowed = new Set(["verify", "warmup", "repair", "retry", "switch_provider", "request_user_input", "blocked", "cancelled", "complete"]);
  for (const [expected, data] of Object.entries(samples)) {
    assert.equal(classifyEndState(data), expected, `${expected} must classify as itself`);
    assert.ok(END_STATES.includes(expected));
    const action = planEndAction(data, { attempt: 1, alternatives: [{ id: "xai", label: "Grok" }] });
    assert.ok(allowed.has(action.kind), `${expected} produced an unknown action ${action.kind}`);
    if (expected !== "transient_interruption") {
      assert.notEqual(action.kind, "retry", `${expected} must not be retried`);
    }
  }
  assert.equal(classifyVerificationState(["Console clean: TypeError"]), "verification_failed");
});

test("success still routes only through the verification gate", () => {
  assert.equal(planEndAction({ status: "complete", result: { buildOk: true, previewUrl: "https://x/" } }, { attempt: 2 }).kind, "verify");
  assert.equal(planEndAction({ status: "complete", result: { buildOk: true, previewUrl: null } }, { attempt: 1 }).kind, "warmup");
});

// ── 11. verification gate planning ──────────────────────────────────────────────────────

test("verification failures repair, exhaust accurately, and respect the aggregate budget", () => {
  const verdict = { pass: false, failures: ["Signup: signed-in view never appeared"] };
  const first = planVerificationAction(verdict, { attempt: 1 });
  assert.equal(first.kind, "repair");
  const repeated = planVerificationAction(verdict, { attempt: 2, previousFingerprints: [first.fingerprint] });
  assert.equal(repeated.kind, "blocked");
  const exhausted = planVerificationAction(verdict, { attempt: MAX_AUTO_ROUNDS });
  assert.equal(exhausted.kind, "blocked");
  assert.match(exhausted.message, /2 automatic repair attempts/);
  const broke = planVerificationAction(verdict, { attempt: 2, budgetCheck: { ok: false, reason: "credits" } });
  assert.equal(broke.kind, "blocked");
  const stalled = planVerificationAction(verdict, { attempt: 2, progress: { improved: false, reason: "no change" } });
  assert.equal(stalled.kind, "blocked");
});

// ── 12. user-facing copy ────────────────────────────────────────────────────────────────

test("no raw technical detail reaches the conversation copy", () => {
  const RAW = /(stack ?trace|at [A-Za-z]+\.[a-z]+ \(|node_modules|\/home\/|C:\\\\|Error:|ECONN|\bhttp_\d|insufficient_quota|sk-[a-zA-Z0-9]|constraint|relation "|column ")/i;
  const messages = [
    planEndAction(CANCELLED, { attempt: 1 }).message,
    planEndAction(BUDGET, { attempt: 1 }).message,
    planEndAction(COST_GUARD, { attempt: 1 }).message,
    planEndAction({ status: "failed", stopReason: STOP_REASONS.providerQuota }, { attempt: 1, alternatives: [] }).message,
    planEndAction({ status: "failed", stopReason: STOP_REASONS.providerQuota }, { attempt: 1, alternatives: [{ id: "xai", label: "Grok" }] }).message,
    planEndAction(FAILED_CHECKS, { attempt: MAX_AUTO_ROUNDS }).message,
    planEndAction(FAILED_CHECKS, { attempt: 1 }).announcement,
    planVerificationAction({ pass: false, failures: ["Console clean: TypeError"] }, { attempt: MAX_AUTO_ROUNDS }).message,
    repairStatusLine(1),
    attemptSummary(3),
  ];
  for (const message of messages) {
    if (message == null) continue;
    assert.doesNotMatch(message, RAW, `technical detail leaked: ${message}`);
  }
});

test("routine repair still never asks permission", () => {
  const BANNED = /say the word|would you like|tell me to (continue|try again)|if you say/i;
  const action = planEndAction(FAILED_CHECKS, { attempt: 1 });
  assert.equal(action.kind, "repair");
  assert.doesNotMatch(action.announcement, BANNED);
  assert.ok(!action.announcement.includes("?"), "routine repair must not ask");
});

// ── Relay-level dispatch proof ──────────────────────────────────────────────────────────
// The planner returning "don't retry" is necessary but not sufficient: these assert what the
// relay actually DISPATCHES.

test("cancellation dispatches zero follow-up jobs and makes zero AI calls", async () => {
  const { dispatched, lifecycle } = await runRelayScenario([CANCELLED]);
  assert.equal(dispatched.length, 0, "no job may be created after a cancellation");
  assert.equal(lifecycle.budget.totals.jobs, 0, "no further job counted");
  assert.equal(lifecycle.budget.totals.repairRounds, 0, "no repair counted");
  assert.equal(lifecycle.diagFinished, "cancelled", "Diagnostics finishes as cancelled, not failed");
});

test("managed budget exhaustion dispatches nothing and notifies the owner once", async () => {
  const { dispatched, lifecycle } = await runRelayScenario([BUDGET]);
  assert.equal(dispatched.length, 0, "a spent budget must not fund another paid attempt");
  assert.equal(lifecycle.notifications.length, 1, "the owner is told exactly once");
});

test("BYOK provider quota exhaustion never retries blindly", async () => {
  const quota = { status: "failed", stopReason: STOP_REASONS.providerQuota, error: "The AI provider has reached its current limit." };
  const { dispatched } = await runRelayScenario([quota], { managed: false, allowFallback: false });
  assert.equal(dispatched.length, 0, "no same-provider retry");
});

test("automatic fallback switches provider and resumes from the same project state", async () => {
  const quota = { status: "failed", stopReason: STOP_REASONS.providerQuota, error: "limit reached" };
  const { dispatched, lifecycle } = await runRelayScenario([quota], {
    allowFallback: true,
    credentials: [{ provider: "xai", status: "connected" }],
    activeProvider: "openai",
  });
  assert.equal(dispatched.length, 1, "the build continues on another provider");
  assert.equal(dispatched[0].providerOverride, "xai");
  assert.equal(dispatched[0].prompt, lifecycle.originalInput.prompt, "resumes the original request");
  assert.equal(lifecycle.switches.length, 1);
  assert.deepEqual(lifecycle.switches[0], { from: "openai", to: "xai", reason: "quota" });
});

test("a provider switch keeps the lifecycle counters and repair memory — it is not a new build", async () => {
  const quota = { status: "failed", stopReason: STOP_REASONS.providerQuota, error: "limit reached" };
  const { lifecycle } = await runRelayScenario([FAILED_CHECKS, quota], {
    allowFallback: true,
    credentials: [{ provider: "xai", status: "connected" }],
    activeProvider: "openai",
  });
  assert.ok(lifecycle.repairMemory.fingerprints.length >= 1, "fingerprints survive the switch");
  assert.equal(lifecycle.budget.totals.jobs, 2, "job count accumulates across the switch");
  assert.ok(lifecycle.rounds.length >= 2, "round history is continuous");
});

test("owner notification fires on every terminal blocked path, exactly once", async () => {
  for (const frame of [BUDGET, { status: "failed", error: "The build hit an unexpected error — please try again." }]) {
    const { lifecycle } = await runRelayScenario([frame]);
    assert.equal(lifecycle.notifications.length, 1, `${frame.stopReason || frame.error} must notify`);
  }
  // Exhaustion after the full loop notifies once, not once per round.
  const { lifecycle } = await runRelayScenario([FAILED_CHECKS, FAILED_CHECKS, FAILED_CHECKS]);
  assert.equal(lifecycle.notifications.length, 1, "no duplicate notifications across rounds");
});

test("a transient interruption resumes without resetting the loop's counters", async () => {
  const { dispatched, lifecycle } = await runRelayScenario([FAILED_CHECKS, RESTART]);
  assert.equal(dispatched.length, 2, "repair then resume");
  assert.equal(dispatched[1].trigger, "transient_retry");
  assert.equal(dispatched[1].prompt, lifecycle.originalInput.prompt);
  assert.ok(lifecycle.repairMemory.fingerprints.length >= 1, "previous fingerprints are retained");
  assert.equal(lifecycle.budget.totals.jobs, 2, "counters continue rather than restart");
});

test("the three-job ceiling still holds end to end", async () => {
  const { dispatched } = await runRelayScenario([FAILED_CHECKS, FAILED_CHECKS, FAILED_CHECKS], { distinctFailures: true });
  assert.ok(dispatched.length <= MAX_AUTO_REPAIRS, `at most ${MAX_AUTO_REPAIRS} repairs, got ${dispatched.length}`);
});

// ── Relay harness ───────────────────────────────────────────────────────────────────────
// Drives the REAL relay against stubbed job/persistence seams so dispatch behaviour — not
// just the planner's opinion — is asserted.

async function runRelayScenario(endFrames, {
  treeAtRound = null, managed = true, allowFallback = false,
  credentials = [], activeProvider = "managed", distinctFailures = false,
} = {}) {
  const service = await import("../../shell/server/lib/appBuild/appBuildService.mjs");

  const dispatched = [];
  const subscribers = [];
  let projectTree = treeAtRound;

  // Stub persistence: record tree writes, answer everything else benignly.
  const client = {
    from: () => ({
      update: (row) => ({ eq: () => ({ eq: () => { if (row.tree) projectTree = row.tree; return { error: null }; } }) }),
      insert: () => ({ select: () => ({ single: async () => ({ data: { id: "p1" }, error: null }) }) }),
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
    }),
  };

  // The relay's injectable seams (ESM exports are read-only, so the relay takes them as a
  // parameter rather than being monkey-patched).
  const deps = {
    createJob: async (input) => {
      dispatched.push(input);
      return { job: { id: `job-${dispatched.length}`, trigger: input.trigger, measurements: null }, existing: false };
    },
    subscribe: (job, fn) => { subscribers.push({ job, fn }); return () => {}; },
    persistBuildResult: async (_owner, _projectId, result) => { if (result?.tree) projectTree = result.tree; },
    verify: async () => {},
  };

  const notifications = [];
  const lifecycle = {
    owner: "o1", projectId: "p1", client,
    originalInput: { mode: "build", prompt: "Build me a booking system for a barber shop" },
    repairMemory: { fingerprints: [], briefs: [] },
    budget: createLifecycleBudget({ plan: "pro", mode: "build", managed }),
    checkpoints: createCheckpointStore(),
    rounds: [], plan: "pro", managed,
    byokSafety: normalizeByokSafety(null), allowFallback,
    activeProvider, credentials, providerOverride: null,
    // Mirrors createLifecycle: the provider policy is resolved from the active connection and is
    // what alternativesFor filters every fallback candidate through.
    providerPolicy: resolveProviderPolicy({ provider: activeProvider }),
    notify: async (...args) => { notifications.push(args); },
    switches: [], notified: false, byokWarned: false, endState: null,
    notifications, diagFinished: null,
  };
  lifecycle.diag = stubDiag(lifecycle);

  const ctx = {
    owner: "o1",
    conversation: { id: "c1" },
    conversations: { appendTurn: async () => {} },
    emit: async () => {},
  };

  // The relay is internal; it is reached through the exported test seam.
  service.__relayForTests(ctx, {
    job: { id: "job-0", trigger: "user", measurements: null },
    projectId: "p1", attempt: 1, lifecycle, deps,
  });
  for (let i = 0; i < endFrames.length; i += 1) {
    const entry = subscribers[i];
    if (!entry) break;
    const frame = { ...endFrames[i] };
    if (treeAtRound && frame.status === "complete") frame.result = { ...frame.result, tree: treeAtRound };
    // Distinct failures per round exercise the ATTEMPT ceiling rather than the identical-
    // failure fingerprint guard, which would otherwise stop the loop first.
    if (distinctFailures && frame.result?.qualityWarnings) {
      frame.result = { ...frame.result, qualityWarnings: [`distinct failure ${i}`] };
    }
    await entry.fn("end", frame);
  }
  return { dispatched, lifecycle, projectTree };
}

function stubDiag(lifecycle) {
  return {
    id: "diag-1",
    step: () => {},
    finish: (status) => { lifecycle.diagFinished = status; },
    repairDispatched: () => {},
    recorderForJob: () => ({ step: () => {}, terminal: () => {}, jobEnd: () => {}, files: () => {} }),
    failureEvidence: () => "Evidence is in the Diagnostics view.",
  };
}
