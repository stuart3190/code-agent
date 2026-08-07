// Builder V2 per-step routing. This module decides; transports execute elsewhere.
// Decisions are deterministic for identical inputs and are suitable for ai_requests.context.

const TIER_STRENGTH = Object.freeze({ fast: 1, balanced: 2, quality: 3 });

const normalProvider = (value) => value === "openai-managed" ? "managed" : String(value || "");

function manualSelection(value) {
  const raw = String(value || "").trim();
  const separator = raw.indexOf(":");
  if (separator <= 0) return { provider: null, model: raw };
  return { provider: normalProvider(raw.slice(0, separator)), model: raw.slice(separator + 1) };
}

export function requiredTier({
  step, complexity = "simple", affectedModules = 1, retrievalTokens = 0,
  repairRound = 0, requiredReasoning = null,
} = {}) {
  if (requiredReasoning && TIER_STRENGTH[requiredReasoning]) return requiredReasoning;
  if (step === "contract" || complexity === "complex" || affectedModules >= 6
      || retrievalTokens >= 12_000 || repairRound >= 2) return "quality";
  if (complexity === "medium" || affectedModules >= 3 || retrievalTokens >= 6_000
      || step === "repair") return "balanced";
  return "fast";
}

export function providerAllowed(policy, candidate) {
  // A managed billing lane may execute an OpenAI/Anthropic/Gemini transport. Provider policy
  // governs who pays; `provider` records the wire transport. Never conflate the two identities.
  const provider = normalProvider(candidate.laneProvider || candidate.provider);
  const primary = normalProvider(policy?.primaryProvider || "managed");
  if (provider === primary) return true;
  if (provider === "managed") return policy?.allowManagedFallback === true;
  return (policy?.allowedFallbackProviders || []).map(normalProvider).includes(provider);
}

function evidenceFor(history, candidate, taskClass) {
  const rows = (history || []).filter((row) => (
    normalProvider(row.provider) === normalProvider(candidate.provider)
    && row.model === candidate.model
    && (!taskClass || row.taskClass === taskClass)
  ));
  const sample = rows.length;
  const successes = rows.filter((row) => row.verified === true).length;
  return {
    sample,
    successRate: sample ? successes / sample : null,
    averageCost: sample ? rows.reduce((sum, row) => sum + Number(row.cost || 0), 0) / sample : null,
  };
}

export function routeV2Step({
  step, taskClass = "generated_app", complexity = "simple", affectedModules = 1,
  retrievalTokens = 0, repairRound = 0, requiredReasoning = null,
  deterministicSolution = null, candidates = [], history = [], policy = {}, manualModel = null,
  minimumEvidence = 5, minimumSuccessRate = 0.8,
} = {}) {
  if (deterministicSolution?.available) {
    return {
      kind: "deterministic", step, taskClass, model: null, provider: null, estimatedCredits: 0,
      reason: deterministicSolution.reason || "a verified deterministic implementation is available",
    };
  }

  const tier = requiredTier({ step, complexity, affectedModules, retrievalTokens, repairRound, requiredReasoning });
  const eligible = candidates
    .filter((candidate) => candidate.available !== false && providerAllowed(policy, candidate))
    .filter((candidate) => (TIER_STRENGTH[candidate.tier] || 0) >= TIER_STRENGTH[tier])
    .map((candidate) => ({ ...candidate, evidence: evidenceFor(history, candidate, taskClass) }));

  if (manualModel) {
    const requested = manualSelection(manualModel);
    const chosen = eligible.find((candidate) => candidate.model === requested.model
      && (!requested.provider || normalProvider(candidate.provider) === requested.provider));
    if (!chosen) throw Object.assign(new Error("manual model is unavailable or forbidden by provider policy"), { code: "model_unavailable" });
    return decision(chosen, { step, taskClass, tier, reason: "manual model selection" });
  }
  if (!eligible.length) throw Object.assign(new Error(`no ${tier} Builder V2 model is available within the selected billing lane`), { code: "provider_unavailable" });

  const proven = eligible.filter((candidate) => candidate.evidence.sample >= minimumEvidence
    && candidate.evidence.successRate >= minimumSuccessRate);
  const pool = proven.length ? proven : eligible;
  pool.sort((a, b) => {
    // Among models proven for this task class, spend is the first discriminator. With no useful
    // evidence, favour success and strength before price: cheap unproven failure is not savings.
    if (proven.length) return Number(a.estimatedCredits ?? Infinity) - Number(b.estimatedCredits ?? Infinity)
      || b.evidence.successRate - a.evidence.successRate || a.model.localeCompare(b.model);
    const aSuccess = a.evidence.successRate ?? -1;
    const bSuccess = b.evidence.successRate ?? -1;
    return bSuccess - aSuccess || (TIER_STRENGTH[b.tier] || 0) - (TIER_STRENGTH[a.tier] || 0)
      || Number(a.estimatedCredits ?? Infinity) - Number(b.estimatedCredits ?? Infinity)
      || a.model.localeCompare(b.model);
  });
  const chosen = pool[0];
  const reason = proven.length
    ? `cheapest model with >=${minimumEvidence} comparable runs and >=${Math.round(minimumSuccessRate * 100)}% verified success`
    : `no model has sufficient class evidence; selected strongest available ${tier}+ candidate`;
  return decision(chosen, { step, taskClass, tier, reason });
}

function decision(candidate, { step, taskClass, tier, reason }) {
  return {
    kind: "model", step, taskClass, requiredTier: tier,
    provider: candidate.provider, model: candidate.model, tier: candidate.tier,
    billingLane: candidate.billingLane, estimatedCredits: Number(candidate.estimatedCredits || 0),
    evidence: candidate.evidence, reason,
  };
}
