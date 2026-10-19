const CUSTOMER_MESSAGES = Object.freeze({
  platform: "build_platform_retrying",
  provider_customer: "build_provider_action_required",
  generated_app: "build_checking_repairs",
  contract: "build_scope_action_required",
  accounting: "build_credits_protected",
});

const CLASSIFICATIONS = new Set(Object.keys(CUSTOMER_MESSAGES));

// An AggregateError or a cause chain hides the failure that mattered behind the one that wrapped
// it. On 2026-09-16 the advanced qualification recorded only "Builder V2 failed and terminal
// accounting could not be completed" while the provider rejection underneath it was never
// persisted anywhere. Every member and cause is flattened here, outermost first, so the record
// and the log carry the whole chain.
export function describeErrorChain(error, { limit = 6 } = {}) {
  const seen = new Set();
  const lines = [];
  const visit = (value, depth) => {
    if (value == null || lines.length >= limit || seen.has(value)) return;
    seen.add(value);
    const message = typeof value?.message === "string" && value.message.trim() ? value.message.trim() : String(value);
    const code = value?.code ? ` [${value.code}]` : "";
    lines.push(`${"  ".repeat(depth)}${message}${code}`);
    for (const member of Array.isArray(value?.errors) ? value.errors : []) visit(member, depth + 1);
    if (value?.cause) visit(value.cause, depth + 1);
  };
  visit(error, 0);
  return lines.join("\n");
}

export function structuredBuildFailure(error, overrides = {}) {
  const classification = CLASSIFICATIONS.has(overrides.classification || error?.classification)
    ? (overrides.classification || error.classification)
    : error?.code === "cancelled" ? "platform"
      : /provider|quota|rate.?limit|billing/i.test(String(error?.code || "")) ? "provider_customer"
        : /contract|scope|profile/i.test(String(error?.code || "")) ? "contract"
          : /billing|accounting|settlement|reservation/i.test(String(error?.code || "")) ? "accounting"
            : /verifier|worker|sandbox|preview|platform|runtime/i.test(String(error?.code || "")) ? "platform"
              : "generated_app";
  const providerCallMade = overrides.providerCallMade ?? (error?.dispatchState
    ? !["before_dispatch", "provider_rejected"].includes(error.dispatchState) : null);
  return {
    code: overrides.code || error?.code || error?.name || "builder_failure",
    classification,
    action: overrides.action || error?.action || (error?.retryable ? "retry_from_checkpoint" : "stop"),
    retryable: overrides.retryable ?? error?.retryable === true,
    providerCallMade,
    reservationState: overrides.reservationState || error?.reservationState
      || (error?.reservationId ? "held_or_ambiguous" : "not_created"),
    checkpointId: overrides.checkpointId || error?.checkpointId || null,
    customerActionRequired: overrides.customerActionRequired
      ?? (classification === "provider_customer" || classification === "contract"),
    internalDetail: String(overrides.internalDetail || describeErrorChain(error) || "Builder failure").slice(0, 4_000),
    customerMessageKey: overrides.customerMessageKey || error?.customerMessageKey
      || CUSTOMER_MESSAGES[classification],
  };
}

export function customerBuildStatus({ internalState, previewUrl = null, failure = null,
  creditsProtected = true, retrying = false } = {}) {
  const value = String(internalState || "").toLowerCase();
  let state = "building";
  let progressLabel = "Building";
  if (value === "green" || value === "complete") { state = "ready"; progressLabel = "Ready"; }
  else if (/verify|check|browser|compile/.test(value)) { state = "checking"; progressLabel = "Checking"; }
  else if (/promot|project|finish|preview/.test(value)) { state = "finishing"; progressLabel = "Finishing"; }
  else if (failure?.customerActionRequired) { state = "action_required"; progressLabel = "Action required"; }
  else if (["failed", "blocked", "cancelled"].includes(value)) { state = "failed"; progressLabel = "Needs attention"; }
  return {
    state, progressLabel, retrying: retrying === true,
    actionRequired: failure?.customerActionRequired === true,
    creditsProtected: creditsProtected === true,
    previewUrl,
    messageKey: failure?.customerMessageKey || (state === "ready" ? "build_ready" : `build_${state}`),
  };
}

// These stops happen after a model call has already settled, or before a builder reservation
// while the lead turn has settled. Either way "credits remain protected" is false.
export const SPEND_VISIBLE_FAILURES = new Set([
  "smallest_scoped_call_exceeds_headroom",
  "no_substantive_generation",
]);

export function failureShowsSettledCredits(failure) {
  return SPEND_VISIBLE_FAILURES.has(String(failure?.code || ""));
}

export function settlementSpentCredits(settlement) {
  const breakdown = settlement?.spentBreakdown || settlement?.spent_breakdown;
  if (!breakdown || typeof breakdown !== "object") return 0;
  const total = Object.values(breakdown).reduce((sum, value) => sum + Number(value || 0), 0);
  return Number.isFinite(total) && total > 0 ? Math.round(total * 100) / 100 : 0;
}

export function customerFailureMessage(failure) {
  if (failureShowsSettledCredits(failure)) {
    const spent = Number(failure.consumedCredits);
    if (Number.isFinite(spent) && spent > 0) {
      return `Thrallo stopped before changing the app. This attempt used ${spent.toFixed(2)} credits.`;
    }
    return "Thrallo stopped before changing the app. Credits already used to handle this message are not refunded.";
  }
  if (failure?.customerActionRequired && failure?.classification === "provider_customer") {
    return "Your selected provider needs attention before this build can continue.";
  }
  if (failure?.customerActionRequired && failure?.classification === "contract") {
    return "The validated scope needs your approval or clarification before generation can continue.";
  }
  if (failure?.code === "direct_edit_unchanged" || failure?.code === "direct_edit_fallback"
    || failure?.code === "direct_edit_infra") {
    const spent = Number(failure.consumedCredits);
    const spend = Number.isFinite(spent) && spent > 0 ? ` This attempt used ${spent.toFixed(2)} credits.` : "";
    if (failure.code === "direct_edit_infra") {
      return `The preview check didn't finish, so your app is unchanged.${spend}`;
    }
    return `I couldn't apply that, your app is unchanged.${spend}`;
  }
  if (failure?.classification === "platform" && !(Number(failure?.consumedCredits) > 0)) {
    return "Thrallo could not finish checking this build. Your credits remain protected.";
  }
  if (failure?.classification === "accounting") {
    return "Thrallo paused this build while protecting and reconciling its credits.";
  }
  if (Number(failure?.consumedCredits) > 0) {
    return `Thrallo could not produce a verified preview. This attempt used ${Number(failure.consumedCredits).toFixed(2)} credits.`;
  }
  return "Thrallo could not produce a verified preview. Your credits remain protected.";
}
