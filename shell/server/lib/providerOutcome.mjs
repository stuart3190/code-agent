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

/*
 * Failures that provably happened before any byte reached the provider.
 *
 * The default below is deliberately fail-safe: an unrecognised failure is treated
 * as ambiguous and replay is blocked, because a duplicate dispatch can charge the
 * customer twice. But that default is wrong for failures that cannot possibly have
 * reached the provider - a missing local credential file, a DNS miss, a refused
 * connection. THR-04DC8D was exactly this: the codex adapter threw ENOENT for a
 * missing ~/.codex/auth.json in 2ms, carried no dispatchState, defaulted to
 * ambiguous, and permanently blocked a conversation that had never dispatched.
 *
 * Only codes that cannot occur after a request has been written are listed. Codes
 * that CAN happen mid-flight - ECONNRESET, EPIPE, ETIMEDOUT, ABORT_ERR - are
 * deliberately absent: those really are ambiguous.
 */
const PRE_DISPATCH_CODES = new Set([
  "ENOENT", "EACCES", "EPERM", "EISDIR", "ENOTDIR",   // local credential / config read
  "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED",            // never established a connection
  "ERR_INVALID_URL",
]);

export function isPreDispatchFailure(error) {
  const code = error?.code ?? error?.cause?.code;
  return typeof code === "string" && PRE_DISPATCH_CODES.has(code);
}

export function classifyProviderFailure(error) {
  const usage = error?.usage || {};
  const hasUsage = Object.values(usage).some((value) => Number(value || 0) > 0);
  const hasIdentity = Boolean(error?.providerRequestId || usage?.providerRequestId
    || (usage?.providerRequestIds || []).length);
  // An adapter's explicit verdict always wins; inference only fills the gap.
  const declared = Object.values(DISPATCH_STATES).includes(error?.dispatchState)
    ? error.dispatchState
    : null;
  const inferred = !hasUsage && !hasIdentity && isPreDispatchFailure(error)
    ? DISPATCH_STATES.before
    : DISPATCH_STATES.ambiguous;
  const state = declared ?? inferred;
  const retrySafe = !hasUsage && !hasIdentity && (
    (error?.retrySafe === true
      && (state === DISPATCH_STATES.before || state === DISPATCH_STATES.rejected))
    || (declared === null && state === DISPATCH_STATES.before)
  );
  return { state, retrySafe, hasUsage, hasIdentity, usage, inferredState: declared === null };
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
