// Which provider a build is ALLOWED to use, decided once and enforced everywhere.
//
// The defect this closes: the owner's active connection was Codex, and resolveBuildContext's
// header said so out loud — "a Codex-subscription selection falls back to managed for builds".
// Seven managed gpt-5.6 calls later, the owner's managed OpenAI credits were spent by a build
// they had explicitly routed elsewhere. A silent provider substitution is a silent billing-lane
// substitution, and after the cached-token incident the rule is the same one: the lane that
// takes the money must be the lane that was chosen.
//
// The policy is resolved from the active credential at lifecycle start, persisted on the
// lifecycle, and consulted by every dispatch, fallback and retry. It cannot be widened
// mid-build — a fallback may only narrow to "stop".

export const BILLING_LANES = Object.freeze({
  managed: "managed",             // Thrallo's own OpenAI key; reserves and debits managed credits
  byokApi: "byok_api",            // the owner's API key; their provider account pays
  connectedAllowance: "connected_allowance", // a subscription-linked transport (Codex/ChatGPT)
});

/**
 * Resolve the policy from the active credential.
 *
 * `allowManagedFallback` defaults FALSE for every non-managed lane: falling back to managed is a
 * billing decision, and billing decisions are not made by error handlers.
 */
export function resolveProviderPolicy(credential = { provider: "managed" }, { now = () => new Date().toISOString() } = {}) {
  const provider = credential?.provider || "managed";
  const base = {
    primaryProvider: provider,
    selectedBy: credential?.selectedBy || "active_connection",
    resolvedAt: now(),
    allowedFallbackProviders: [],
    allowManagedFallback: false,
  };

  if (provider === "codex") {
    // Strict: Codex is a subscription allowance, not an API key, and there is no lane it may
    // silently become. If the transport fails, the build stops.
    return { ...base, billingLane: BILLING_LANES.connectedAllowance };
  }
  if (provider === "managed") {
    return { ...base, billingLane: BILLING_LANES.managed, allowManagedFallback: true };
  }
  // API-key lanes may switch among the owner's OTHER connected API-key providers (the owner's
  // allow_fallback preference still gates whether that happens automatically) — but never onto
  // managed: every one of these lanes bills the owner's own account, and managed bills Thrallo
  // credits, which is a different agreement, not a fallback.
  return {
    ...base,
    billingLane: BILLING_LANES.byokApi,
    allowedFallbackProviders: ["anthropic", "openai", "xai"].filter((p) => p !== provider),
  };
}

/** May this build create a managed reservation or debit managed credits? */
export function usesManagedCredits(policy) {
  return policy?.billingLane === BILLING_LANES.managed;
}

/**
 * Filter fallback candidates through the policy. "managed" is a candidate only when the policy
 * says so; everything else must be in the allowed list. An empty result means the correct
 * behaviour on provider failure is to STOP, and the existing provider-blocked stop already says
 * that plainly to the customer.
 */
export function permittedAlternatives(policy, candidates = []) {
  return candidates.filter((id) => {
    if (id === "managed") return policy?.allowManagedFallback === true;
    return (policy?.allowedFallbackProviders || []).includes(id);
  });
}

/** The global managed-settlement kill switch, readable from every lane — not only buildJobs. */
export function managedSettlementPaused() {
  return process.env.THRALLO_MANAGED_SETTLEMENT_PAUSED === "1";
}

export const MANAGED_PAUSED_MESSAGE =
  "Managed AI is briefly paused while we correct a billing calculation in your favour. "
  + "Your work and credits are safe — please try again shortly, or connect your own API key to continue now.";

/** The pre-build summary the operator sees before any live spend. */
export function preflightSummary(policy) {
  const lane = {
    [BILLING_LANES.managed]: "managed credits",
    [BILLING_LANES.byokApi]: "owner's own API key",
    [BILLING_LANES.connectedAllowance]: "connected allowance",
  }[policy?.billingLane] || policy?.billingLane;
  return [
    `Provider: ${policy?.primaryProvider === "codex" ? "Codex" : policy?.primaryProvider}`,
    `Billing lane: ${lane}`,
    `Managed fallback: ${policy?.allowManagedFallback ? "ENABLED" : "disabled"}`,
    `Managed credits at risk: ${usesManagedCredits(policy) ? "the build ceiling" : "0"}`,
  ].join("\n");
}
