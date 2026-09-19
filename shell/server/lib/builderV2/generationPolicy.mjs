const POLICIES = Object.freeze({
  simple: Object.freeze({ maxGenerationAttempts: 3, maxCandidateCorrections: 2 }),
  medium: Object.freeze({ maxGenerationAttempts: 4, maxCandidateCorrections: 3 }),
  advanced: Object.freeze({ maxGenerationAttempts: 5, maxCandidateCorrections: 5 }),
});

/**
 * Complexity changes the amount of bounded generation work, never the correctness gates and never
 * the approved credit ceiling. Candidate corrections are deliberately separate: fixing one named
 * file should not consume a whole-tree generation attempt.
 */
export function generationPolicyFor(profile = "simple", {
  simpleAttempts = POLICIES.simple.maxGenerationAttempts,
  simpleCorrections = POLICIES.simple.maxCandidateCorrections,
} = {}) {
  const base = POLICIES[profile] || POLICIES.simple;
  return {
    profile: POLICIES[profile] ? profile : "simple",
    maxGenerationAttempts: profile === "simple"
      ? Math.max(1, Number(simpleAttempts) || POLICIES.simple.maxGenerationAttempts)
      : Math.max(Number(simpleAttempts) || 0, base.maxGenerationAttempts),
    maxCandidateCorrections: profile === "simple"
      ? Math.max(0, Number(simpleCorrections) || 0)
      : Math.max(Number(simpleCorrections) || 0, base.maxCandidateCorrections),
  };
}

export const MAX_CANDIDATE_CORRECTIONS = POLICIES.advanced.maxCandidateCorrections;
