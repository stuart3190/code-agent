const CUSTOMER_MESSAGES = Object.freeze({
  platform: "build_platform_retrying",
  provider_customer: "build_provider_action_required",
  generated_app: "build_checking_repairs",
  contract: "build_scope_action_required",
  accounting: "build_credits_protected",
});

const CLASSIFICATIONS = new Set(Object.keys(CUSTOMER_MESSAGES));

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
    internalDetail: String(overrides.internalDetail || error?.message || error || "Builder failure").slice(0, 4_000),
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

export function customerFailureMessage(failure) {
  if (failure?.customerActionRequired && failure?.classification === "provider_customer") {
    return "Your selected provider needs attention before this build can continue.";
  }
  if (failure?.customerActionRequired && failure?.classification === "contract") {
    return "The validated scope needs your approval or clarification before generation can continue.";
  }
  if (failure?.classification === "platform") {
    return "Thrallo could not finish checking this build. Your credits remain protected.";
  }
  if (failure?.classification === "accounting") {
    return "Thrallo paused this build while protecting and reconciling its credits.";
  }
  return "Thrallo could not produce a verified preview. Your credits remain protected.";
}
