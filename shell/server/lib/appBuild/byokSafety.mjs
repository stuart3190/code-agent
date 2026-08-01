// Optional BYOK safety controls.
//
// Principle (Stuart, 2026-08-01): a BYOK user's tokens are billed by their OWN provider
// account, so Thrallo must not impose a spend cap on them by default. Every control here
// is null — meaning off — until the user turns it on. The previous behaviour was the
// mirror-image defect: managed jobs had a per-job guard and BYOK had NOTHING, so a BYOK
// loop was bounded only by the engine's 25-turn cap.
//
// What still applies to BYOK with every control disabled (these are loop protections, not
// spend limits, and they are enforced elsewhere in the pipeline):
//   fixed repair-attempt limits, failure fingerprinting, duplicate repair-brief detection,
//   no-progress detection, cancellation handling, provider quota detection, transient-error
//   classification, and the lifecycle job/turn/elapsed ceilings.
// BYOK must never mean infinite retries caused by a platform bug.

export const BYOK_CONTROLS = Object.freeze([
  "maxCostPerBuild",
  "maxDailySpend",
  "warnThreshold",
  "approvalThreshold",
  "maxRepairJobs",
]);

// Every control defaults to disabled. This object is the contract: a stored row that omits
// a key leaves it off, and an explicit null turns it back off.
export const BYOK_SAFETY_DEFAULTS = Object.freeze({
  maxCostPerBuild: null,    // credits-equivalent cost of one build lifecycle
  maxDailySpend: null,      // credits-equivalent cost across a rolling day
  warnThreshold: null,      // tell the user once when a lifecycle passes this cost
  approvalThreshold: null,  // ask before an autonomous repair projected above this cost
  maxRepairJobs: null,      // hard cap on autonomous repair jobs per lifecycle
});

function positiveOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function normalizeByokSafety(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const out = { ...BYOK_SAFETY_DEFAULTS };
  for (const key of BYOK_CONTROLS) out[key] = positiveOrNull(source[key]);
  return out;
}

export function byokControlsEnabled(settings) {
  const s = normalizeByokSafety(settings);
  return BYOK_CONTROLS.some((key) => s[key] !== null);
}

// The gate for a BYOK follow-up dispatch. With nothing enabled this ALWAYS allows —
// asserted directly by the regression suite.
export function byokDispatchCheck(settings, { lifecycleCost = 0, dailySpend = 0, repairJobs = 0, projectedCost = 0 } = {}) {
  const s = normalizeByokSafety(settings);

  if (s.maxRepairJobs !== null && repairJobs >= s.maxRepairJobs) {
    return { ok: false, reason: "max_repair_jobs", limit: s.maxRepairJobs };
  }
  if (s.maxCostPerBuild !== null && lifecycleCost >= s.maxCostPerBuild) {
    return { ok: false, reason: "max_cost_per_build", limit: s.maxCostPerBuild };
  }
  if (s.maxDailySpend !== null && dailySpend >= s.maxDailySpend) {
    return { ok: false, reason: "max_daily_spend", limit: s.maxDailySpend };
  }
  if (s.approvalThreshold !== null && projectedCost > s.approvalThreshold) {
    return { ok: false, reason: "approval_required", limit: s.approvalThreshold, needsApproval: true };
  }
  return { ok: true };
}

// One-time warning, separate from blocking: crossing the warn threshold informs, it does
// not stop the build.
export function byokWarning(settings, { lifecycleCost = 0, alreadyWarned = false } = {}) {
  const s = normalizeByokSafety(settings);
  if (alreadyWarned || s.warnThreshold === null) return null;
  if (lifecycleCost < s.warnThreshold) return null;
  return "This build has passed the spending warning level you set for your own API account. It's still running — tell me to stop if you'd rather it didn't.";
}

export function byokBlockedMessage(check) {
  switch (check?.reason) {
    case "max_repair_jobs":
      return "I've reached the automatic repair limit you set for your own API account. Your current progress is saved — tell me to continue if you'd like more attempts.";
    case "max_cost_per_build":
      return "This build has reached the per-build spending limit you set for your own API account. Your current progress is saved.";
    case "max_daily_spend":
      return "You've reached the daily spending limit you set for your own API account. Your current progress is saved and the limit resets tomorrow.";
    case "approval_required":
      return "This next repair looks more expensive than the approval level you set for your own API account. Your progress is saved — say the word and I'll run it.";
    default:
      return "I've paused this build against a safety limit you set. Your current progress is saved.";
  }
}
