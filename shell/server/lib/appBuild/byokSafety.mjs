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

// Stored shape (ca_ai_preferences.byok_safety), both accepted:
//   flat   { maxCostPerBuild: 5, ... }                     — global defaults
//   nested { global: {...}, providers: { openai: {...} }, timezone: "Europe/London" }
// A provider entry overrides the global default control-by-control, so a user can cap one
// connection without touching the others.
export function normalizeByokSafety(raw, { provider = null } = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const global = source.global && typeof source.global === "object" ? source.global : source;
  const perProvider = provider && source.providers && typeof source.providers === "object"
    ? source.providers[provider] || {}
    : {};
  const out = { ...BYOK_SAFETY_DEFAULTS };
  for (const key of BYOK_CONTROLS) {
    // An explicit provider value wins; `null` there means "off for this provider".
    out[key] = Object.prototype.hasOwnProperty.call(perProvider, key)
      ? positiveOrNull(perProvider[key])
      : positiveOrNull(global[key]);
  }
  out.timezone = typeof source.timezone === "string" && source.timezone.trim() ? source.timezone.trim() : null;
  return out;
}

// The full settings document, for the Settings UI and its save path.
export function normalizeByokSafetyDocument(raw, { providers = [] } = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const global = source.global && typeof source.global === "object" ? source.global : source;
  const document = { global: {}, providers: {}, timezone: null };
  for (const key of BYOK_CONTROLS) document.global[key] = positiveOrNull(global[key]);
  const stored = source.providers && typeof source.providers === "object" ? source.providers : {};
  for (const provider of new Set([...providers, ...Object.keys(stored)])) {
    const entry = stored[provider];
    if (!entry || typeof entry !== "object") continue;
    const normalized = {};
    let any = false;
    for (const key of BYOK_CONTROLS) {
      if (!Object.prototype.hasOwnProperty.call(entry, key)) continue;
      normalized[key] = positiveOrNull(entry[key]);
      any = true;
    }
    if (any) document.providers[provider] = normalized;
  }
  if (typeof source.timezone === "string" && source.timezone.trim()) document.timezone = source.timezone.trim();
  return document;
}

// Validation for the save path: numbers must be positive and finite, or null to disable.
export function validateByokSafetyInput(input) {
  const errors = [];
  const check = (scope, entry) => {
    if (!entry || typeof entry !== "object") return;
    for (const [key, value] of Object.entries(entry)) {
      if (!BYOK_CONTROLS.includes(key)) { errors.push(`${scope}: unknown control "${key}"`); continue; }
      if (value === null || value === "" || value === undefined) continue; // disabling is always valid
      const n = Number(value);
      if (!Number.isFinite(n)) { errors.push(`${scope}: ${key} must be a number`); continue; }
      if (n <= 0) errors.push(`${scope}: ${key} must be greater than zero (leave it empty to turn it off)`);
      if (key === "maxRepairJobs" && n !== Math.floor(n)) errors.push(`${scope}: ${key} must be a whole number`);
    }
  };
  const source = input && typeof input === "object" ? input : {};
  // A flat document is treated as the global defaults, but the document-level keys are not
  // controls — reading them as controls rejected every valid `{ timezone }`-only save.
  const flat = Object.fromEntries(
    Object.entries(source).filter(([key]) => !["global", "providers", "timezone"].includes(key)),
  );
  check("global", source.global && typeof source.global === "object" ? source.global : flat);
  for (const [provider, entry] of Object.entries(source.providers || {})) check(provider, entry);
  if (source.timezone != null && source.timezone !== "") {
    try { new Intl.DateTimeFormat("en-US", { timeZone: String(source.timezone) }); }
    catch { errors.push("timezone: not a recognised time zone"); }
  }
  return { ok: errors.length === 0, errors };
}

export function byokControlsEnabled(settings, { provider = null } = {}) {
  const s = normalizeByokSafety(settings, { provider });
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
