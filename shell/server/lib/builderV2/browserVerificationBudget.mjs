const SECOND = 1_000;

const count = (value) => Array.isArray(value) ? value.length : 0;

export function browserVerificationUsesBackend(runtimeRequirements = {}) {
  return runtimeRequirements.accounts === true || runtimeRequirements.durableMutation === true;
}

/**
 * Derive the sandbox budget for one contracted journey.
 *
 * A browser job runs two sequential phases in one Chromium process: the generic runtime smoke
 * followed by the contracted journey. The container must cover both phases plus bounded cleanup;
 * treating the journey timeout as the whole job timeout lets Docker kill Chromium while the
 * verifier is still opening a context.
 */
export function browserVerificationBudget({ journey = {}, contract = {}, usesBackend = false } = {}) {
  const stepCount = Math.max(1, count(journey.steps));
  const journeyId = journey.id || null;
  const flows = (contract?.interactionContract?.flows || [])
    .filter((flow) => !journeyId || flow?.journeyId === journeyId);
  const flowCount = Math.max(stepCount, flows.length);
  const controlCount = flows.reduce((total, flow) => total
    + count(flow?.controls) + count(flow?.actions), 0);

  // Static smoke is bounded primarily by navigation. Stateful smoke also proves account/session
  // and durable mutation mechanics, so its allowance is larger. The journey allowance scales from
  // the validated contract rather than a universal complexity-class timeout.
  const appTimeoutMs = (usesBackend ? 210 : 75) * SECOND;
  const journeyTimeoutMs = (
    120
    + (stepCount * 20)
    + (flowCount * 5)
    + (controlCount * 2.5)
    + (usesBackend ? 50 : 0)
  ) * SECOND;
  const cleanupHeadroomMs = Math.max(60 * SECOND, stepCount * 12 * SECOND);
  const wallMs = Math.ceil(appTimeoutMs + journeyTimeoutMs + cleanupHeadroomMs);

  return Object.freeze({
    appTimeoutMs,
    journeyTimeoutMs: Math.ceil(journeyTimeoutMs),
    cleanupHeadroomMs,
    wallMs,
    wallSeconds: Math.ceil(wallMs / SECOND),
    basis: Object.freeze({ stepCount, flowCount, controlCount, usesBackend: Boolean(usesBackend) }),
  });
}
