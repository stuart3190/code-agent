// Canonical provider-dispatch outcome contract. Only an explicit pre-dispatch/rejected
// outcome may be replayed. Anything ambiguous after the transport was invoked stops.

export const DISPATCH_STATES = Object.freeze({
  before: "before_dispatch",
  rejected: "provider_rejected",
  ambiguous: "provider_dispatch_ambiguous",
  complete: "provider_completed",
});

export function providerFailure(error, { state, providerRequestId = null, usage = null, retrySafe = null } = {}) {
  error.dispatchState = state;
  error.retrySafe = retrySafe == null ? state === DISPATCH_STATES.before : Boolean(retrySafe);
  if (providerRequestId) error.providerRequestId = providerRequestId;
  if (usage) error.usage = usage;
  return error;
}

export function classifyProviderFailure(error) {
  const usage = error?.usage || {};
  const hasUsage = Object.values(usage).some((value) => Number(value || 0) > 0);
  const hasIdentity = Boolean(error?.providerRequestId || usage?.providerRequestId
    || (usage?.providerRequestIds || []).length);
  const state = Object.values(DISPATCH_STATES).includes(error?.dispatchState)
    ? error.dispatchState
    : DISPATCH_STATES.ambiguous;
  const retrySafe = !hasUsage && error?.retrySafe === true
    && (state === DISPATCH_STATES.before || state === DISPATCH_STATES.rejected);
  return { state, retrySafe, hasUsage, hasIdentity, usage };
}

export function replayUnsafe(error, evidence = {}) {
  return Object.assign(new Error(
    "Provider dispatch may have occurred. Automatic replay is blocked until durable provider evidence is reconciled.",
    { cause: error },
  ), {
    code: "provider_replay_unsafe", status: 409, retryable: false,
    dispatchState: DISPATCH_STATES.ambiguous, providerError: error, ...evidence,
  });
}
