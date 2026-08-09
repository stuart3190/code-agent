import { OfflineError, ThralloClientError, redact } from "../../errors.mjs";
import { constantTimeEqual, createPkceChallenge } from "../pkce.mjs";
import { assertNativeAuthProvider } from "../provider.mjs";

export const AUTH_FIXTURE_CLOCK = "2032-04-05T12:00:00.000Z";
export const AUTH_FIXTURE_SEED = "thrallo-native-auth-d2";

function digest(value) {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (const character of String(value)) {
    const code = character.charCodeAt(0);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
  }
  return `${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
}

function authError(code, message) {
  return new ThralloClientError(message, { code, retryable: code === "offline" });
}

export function createDeterministicAuthProvider({
  seed = AUTH_FIXTURE_SEED,
  clock = AUTH_FIXTURE_CLOCK,
  authorizationLifetimeMs = 120_000,
  accessLifetimeMs = 900_000,
} = {}) {
  let now = Date.parse(clock);
  let online = true;
  let authorizationSequence = 0;
  let sessionSequence = 0;
  let callSequence = 0;
  const authorizations = new Map();
  const sessions = new Map();
  const usedRefreshHandles = new Set();
  const calls = [];

  function record(operation, details = {}) {
    callSequence += 1;
    calls.push(Object.freeze({ sequence: callSequence, operation, at: new Date(now).toISOString(), details: redact(details) }));
  }

  function requireOnline(operation) {
    if (!online) {
      record(operation, { outcome: "offline" });
      throw new OfflineError("Deterministic authorization provider is offline.");
    }
  }

  function opaque(kind, sequence) {
    return `fixture-${kind}-${digest(`${seed}:${kind}:${sequence}`)}`;
  }

  async function beginAuthorization({ challenge, state, nonce, redirectUri, deviceId, expectedAccountId = null } = {}) {
    requireOnline("beginAuthorization");
    if (!/^[A-Za-z0-9_-]{43}$/.test(challenge || "") || !state || !nonce || redirectUri !== "thrallo://auth/callback" || !deviceId) {
      throw authError("invalid_authorization_request", "Deterministic authorization request is invalid.");
    }
    authorizationSequence += 1;
    const authorizationId = opaque("authorization", authorizationSequence);
    const code = opaque("code", authorizationSequence);
    const accountId = expectedAccountId || "fixture-account-alpha";
    authorizations.set(authorizationId, {
      authorizationId, challenge, state, nonce, redirectUri, deviceId, accountId, code,
      expiresAt: now + authorizationLifetimeMs, used: false,
    });
    record("beginAuthorization", { authorizationId, deviceId, accountId, outcome: "awaiting_callback" });
    return Object.freeze({
      authorizationId,
      authorizationUrl: `thrallo-fixture://authorize/${authorizationId}`,
      expiresAt: now + authorizationLifetimeMs,
    });
  }

  function completeAuthorization(authorizationId, overrides = {}) {
    const authorization = authorizations.get(authorizationId);
    if (!authorization) throw authError("authorization_not_found", "Deterministic authorization was not found.");
    const code = overrides.code ?? authorization.code;
    const state = overrides.state ?? authorization.state;
    record("completeAuthorization", { authorizationId, outcome: "callback_created" });
    return `thrallo://auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
  }

  async function exchangeAuthorizationCode({ authorizationId, code, verifier, state, nonce, deviceId } = {}) {
    requireOnline("exchangeAuthorizationCode");
    const authorization = authorizations.get(authorizationId);
    if (!authorization) throw authError("authorization_not_found", "Authorization result was not found.");
    if (authorization.used) throw authError("authorization_replayed", "Authorization result has already been used.");
    if (now > authorization.expiresAt) throw authError("authorization_expired", "Authorization result expired.");
    if (!constantTimeEqual(code, authorization.code)) throw authError("authorization_code_mismatch", "Authorization code does not match.");
    if (!constantTimeEqual(state, authorization.state) || !constantTimeEqual(nonce, authorization.nonce)) {
      throw authError("authorization_correlation_failed", "Authorization correlation failed.");
    }
    if (deviceId !== authorization.deviceId) throw authError("device_mismatch", "Authorization device does not match.");
    if (!constantTimeEqual(await createPkceChallenge(verifier), authorization.challenge)) {
      throw authError("pkce_verifier_mismatch", "PKCE verifier does not match.");
    }
    authorization.used = true;
    sessionSequence += 1;
    const session = Object.freeze({
      accountId: authorization.accountId,
      deviceId,
      accessHandle: opaque("access", sessionSequence),
      refreshHandle: opaque("refresh", sessionSequence),
      accessExpiresAt: now + accessLifetimeMs,
      sessionRevision: 1,
    });
    sessions.set(session.refreshHandle, session);
    record("exchangeAuthorizationCode", { authorizationId, accountId: session.accountId, deviceId, outcome: "authenticated" });
    return session;
  }

  async function refreshDeviceSession({ accountId, deviceId, refreshHandle, sessionRevision } = {}) {
    requireOnline("refreshDeviceSession");
    if (usedRefreshHandles.has(refreshHandle)) throw authError("refresh_replayed", "Rotated refresh material was reused.");
    const current = sessions.get(refreshHandle);
    if (!current) throw authError("session_revoked", "Device session was revoked.");
    if (current.accountId !== accountId) throw authError("account_mismatch", "Device session account does not match.");
    if (current.deviceId !== deviceId) throw authError("device_mismatch", "Device session device does not match.");
    if (current.sessionRevision !== sessionRevision) throw authError("refresh_replayed", "Device session revision was already rotated.");
    usedRefreshHandles.add(refreshHandle);
    sessions.delete(refreshHandle);
    sessionSequence += 1;
    const rotated = Object.freeze({
      accountId,
      deviceId,
      accessHandle: opaque("access", sessionSequence),
      refreshHandle: opaque("refresh", sessionSequence),
      accessExpiresAt: now + accessLifetimeMs,
      sessionRevision: current.sessionRevision + 1,
    });
    sessions.set(rotated.refreshHandle, rotated);
    record("refreshDeviceSession", { accountId, deviceId, sessionRevision: rotated.sessionRevision, outcome: "rotated" });
    return rotated;
  }

  async function revokeDeviceSession({ accountId, deviceId, refreshHandle } = {}) {
    requireOnline("revokeDeviceSession");
    const current = sessions.get(refreshHandle);
    if (current && (current.accountId !== accountId || current.deviceId !== deviceId)) {
      throw authError("session_scope_mismatch", "Device session scope does not match.");
    }
    if (current) {
      sessions.delete(refreshHandle);
      usedRefreshHandles.add(refreshHandle);
    }
    record("revokeDeviceSession", { accountId, deviceId, outcome: "revoked" });
    return Object.freeze({ revoked: true });
  }

  function revokeDevice({ accountId, deviceId }) {
    for (const [handle, session] of sessions) {
      if (session.accountId === accountId && session.deviceId === deviceId) {
        sessions.delete(handle);
        usedRefreshHandles.add(handle);
      }
    }
    record("revokeDevice", { accountId, deviceId, outcome: "revoked" });
  }

  const provider = {
    kind: "deterministic-development-auth",
    capabilities: Object.freeze({ browserAuthorization: true, productionMutation: false }),
    beginAuthorization,
    exchangeAuthorizationCode,
    refreshDeviceSession,
    revokeDeviceSession,
    completeAuthorization,
    revokeDevice,
    setOffline(value = true) { online = value !== true; record("setConnectivity", { online }); },
    advance(milliseconds) { now += Number(milliseconds); record("advanceClock", { milliseconds: Number(milliseconds) }); return now; },
    now: () => now,
    getConnectivity: () => online ? "online" : "offline",
    getCalls: () => Object.freeze(calls.map((call) => Object.freeze(structuredClone(call)))),
  };
  return Object.freeze(assertNativeAuthProvider(provider));
}
