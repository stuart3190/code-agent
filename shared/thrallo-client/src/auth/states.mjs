export const NATIVE_AUTH_STATES = Object.freeze([
  "signed_out",
  "authorizing",
  "awaiting_callback",
  "exchanging",
  "authenticated",
  "refreshing",
  "expired",
  "revoked",
  "offline",
  "error",
]);

const TRANSITIONS = Object.freeze({
  signed_out: Object.freeze(["authorizing", "authenticated", "expired", "offline", "error"]),
  authorizing: Object.freeze(["awaiting_callback", "signed_out", "offline", "error"]),
  awaiting_callback: Object.freeze(["exchanging", "signed_out", "expired", "offline", "error"]),
  exchanging: Object.freeze(["authenticated", "signed_out", "expired", "revoked", "offline", "error"]),
  authenticated: Object.freeze(["refreshing", "signed_out", "expired", "revoked", "offline", "error"]),
  refreshing: Object.freeze(["authenticated", "signed_out", "expired", "revoked", "offline", "error"]),
  expired: Object.freeze(["authorizing", "refreshing", "signed_out", "revoked", "offline", "error"]),
  revoked: Object.freeze(["authorizing", "signed_out"]),
  offline: Object.freeze(["authorizing", "authenticated", "refreshing", "signed_out", "expired", "revoked", "error"]),
  error: Object.freeze(["authorizing", "signed_out", "offline"]),
});

export function canTransitionAuthState(from, to) {
  if (!NATIVE_AUTH_STATES.includes(from) || !NATIVE_AUTH_STATES.includes(to)) return false;
  return from === to || TRANSITIONS[from].includes(to);
}

export function assertAuthTransition(from, to) {
  if (!canTransitionAuthState(from, to)) throw new TypeError(`Invalid native auth transition: ${from} -> ${to}`);
  return to;
}

export function createAuthSnapshot({ state = "signed_out", method = null, accountId = null, deviceId, expiresAt = null, error = null } = {}) {
  if (!NATIVE_AUTH_STATES.includes(state)) throw new TypeError(`Unknown native auth state: ${state}`);
  if (!deviceId || typeof deviceId !== "string") throw new TypeError("Native auth requires a host-supplied deviceId");
  return Object.freeze({
    state,
    method,
    accountId,
    deviceId,
    expiresAt,
    error: error ? Object.freeze({ code: error.code || "authentication_error", message: error.message || "Authentication failed." }) : null,
  });
}
