// Explicit end-state classification for app-build jobs.
//
// The defect this replaces: the relay inferred retry eligibility from `status` alone, so
// EVERY non-complete job became a blind paid retry — including a build the user cancelled,
// one stopped for hitting its credit ceiling, and one refused by the cost guard. Status is
// not intent. A job now carries a `stopReason` set at the point the pipeline actually knows
// why it stopped, and this module turns (status, stopReason, error, result) into one of a
// closed set of end states. Retry eligibility is derived from the STATE, never the status.
//
// Pure and dependency-free on purpose: every branch is unit-testable without a database,
// a provider, or a running job.

export const END_STATES = Object.freeze([
  "success",
  "cancelled",
  "managed_budget_blocked",
  "provider_quota_blocked",
  "provider_rate_limited",
  "provider_unavailable",
  "transient_interruption",
  "repairable_failure",
  "permanent_failure",
  "verification_failed",
  "user_input_required",
]);

// Stop reasons the pipeline stamps on a job. Anything not listed here is unclassified and
// falls through to text analysis — never straight to "retry".
export const STOP_REASONS = Object.freeze({
  cancelled: "cancelled",
  managedBudget: "managed_budget",
  costGuard: "cost_guard",
  providerQuota: "provider_quota",
  providerRateLimit: "provider_rate_limit",
  providerUnavailable: "provider_unavailable",
  transient: "transient",
});

const STOP_REASON_STATES = Object.freeze({
  [STOP_REASONS.cancelled]: "cancelled",
  [STOP_REASONS.managedBudget]: "managed_budget_blocked",
  // A cost-guard refusal is a budget decision, not a crash: retrying it re-runs the same
  // arithmetic and refuses again.
  [STOP_REASONS.costGuard]: "managed_budget_blocked",
  [STOP_REASONS.providerQuota]: "provider_quota_blocked",
  [STOP_REASONS.providerRateLimit]: "provider_rate_limited",
  [STOP_REASONS.providerUnavailable]: "provider_unavailable",
  [STOP_REASONS.transient]: "transient_interruption",
});

// ── Provider-condition detection ────────────────────────────────────────────────────────
// Ordered most-specific first: a 429 that names a spent balance is exhaustion, not a rate
// limit, and the two have completely different remedies.

const QUOTA = /(insufficient[_ ]?quota|quota[_ ]?exceeded|exceeded your current quota|billing[_ ]?hard[_ ]?limit|credit balance is too low|insufficient (funds|credits|balance)|out of credits|payment required|no remaining (credit|quota))/i;
const RATE_LIMIT = /(rate[_ ]?limit|too many requests|requests per (minute|second)|tokens per minute|slow down|overloaded)/i;
const UNAVAILABLE = /(service unavailable|temporarily unavailable|bad gateway|gateway timeout|upstream (error|connect)|internal server error|provider (is )?down|api (is )?unavailable)/i;
// Genuine transient infrastructure: the work would plausibly succeed on an identical
// re-run. Compute that died under us belongs here; a build that failed on its own contents
// does not (an ENOENT from a missing file reproduces exactly, so retrying it is waste).
const TRANSIENT = /(timeout|timed[_ ]?out|econn|socket hang up|network|fetch failed|connection (reset|refused|closed)|abort|temporar|interrupted by a server restart|restart|(sandbox|container|runner|worker|pod|instance)\s+(died|crashed|terminated|was killed|killed|disappeared|went away|unavailable))/i;

// Things no amount of autonomous repair can invent. Consuming repair attempts on these
// burns the user's budget guessing at information only they hold.
const HUMAN_INPUT = [
  [/\b(api[_ ]?key|secret[_ ]?key|access[_ ]?token|credential|client[_ ]?secret|service account|connection string)\b/i, "a credential only you can provide"],
  [/\b(permission denied|not authorised|not authorized|forbidden|insufficient (permission|privileges|role)|access denied|admin (access|rights) required)\b/i, "an account permission only you can grant"],
  [/\b(stripe|paypal|payment (setup|method|provider)|billing account|merchant account)\b.*\b(not (configured|connected|set up)|missing|required)\b/i, "payment setup only you can complete"],
  [/\b(not configured|is not set|missing (env|environment) variable|env var .* (missing|required)|configure .* (before|first))\b/i, "external service configuration only you can supply"],
  [/\b(missing file|file not found|no such file|cannot find (module|file)|asset (is )?missing|upload .* (required|missing))\b/i, "a file that has not been supplied"],
  [/\b(business rule|which (behaviour|behavior|option|approach) (do|should) you|ambiguous requirement|unclear (requirement|specification)|need(s)? a product decision|please (clarify|specify|decide))\b/i, "a product decision only you can make"],
];

export function providerCondition(text) {
  const value = String(text || "");
  if (!value) return null;
  if (QUOTA.test(value)) return "provider_quota_blocked";
  if (RATE_LIMIT.test(value)) return "provider_rate_limited";
  if (UNAVAILABLE.test(value)) return "provider_unavailable";
  return null;
}

// Returns the plain-English need when a failure can only be resolved by the user.
export function humanInputNeed(reasons) {
  for (const reason of [].concat(reasons || [])) {
    const text = String(reason || "");
    for (const [pattern, need] of HUMAN_INPUT) {
      if (pattern.test(text)) return need;
    }
  }
  return null;
}

export function isTransientText(text) {
  return TRANSIENT.test(String(text || ""));
}

// ── The classifier ──────────────────────────────────────────────────────────────────────

// `data` is the job's terminal frame: { status, error, stopReason, result }.
export function classifyEndState(data = {}) {
  const status = data.status;
  const stopReason = data.stopReason || null;

  // An explicit stop reason always wins — it was recorded where the truth was known.
  if (stopReason && STOP_REASON_STATES[stopReason]) return STOP_REASON_STATES[stopReason];

  if (status === "complete") {
    if (data.result?.buildOk !== false) return "success";
    const warnings = data.result?.qualityWarnings || [];
    if (humanInputNeed(warnings)) return "user_input_required";
    // A completed-but-failing build produced a tree; its checks are repairable by definition.
    return "repairable_failure";
  }

  const text = `${data.error || ""}`;
  const provider = providerCondition(text);
  if (provider) return provider;
  if (humanInputNeed([text])) return "user_input_required";

  // A server restart is the canonical transient interruption.
  if (status === "interrupted") return "transient_interruption";
  if (isTransientText(text)) return "transient_interruption";

  // Anything else that failed outright, with no evidence it would behave differently on a
  // second run, is permanent. This is the branch that used to be a blind retry.
  return "permanent_failure";
}

// Verification failures are their own state: the build compiled and ran, but behaved wrongly.
export function classifyVerificationState(failures = []) {
  if (humanInputNeed(failures)) return "user_input_required";
  return "verification_failed";
}

// The states that may legitimately re-enter the automatic retry path (§7).
export function isAutomaticallyRetryable(endState) {
  return endState === "transient_interruption";
}

// The states where a different provider is the remedy rather than another attempt (§12).
export function isProviderBlocked(endState) {
  return endState === "provider_quota_blocked"
    || endState === "provider_rate_limited"
    || endState === "provider_unavailable";
}

// Terminal states that must never dispatch further paid work without explicit approval.
export function isBlockedWithoutApproval(endState) {
  return endState === "managed_budget_blocked"
    || endState === "user_input_required"
    || isProviderBlocked(endState);
}
