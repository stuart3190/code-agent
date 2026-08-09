import { requireCapability } from "../capabilities.mjs";
import { OfflineError, ThralloClientError, redactText } from "../errors.mjs";
import { parseAuthCallback, correlateAuthCallback } from "./deepLink.mjs";
import { createPkceTransaction } from "./pkce.mjs";
import { assertNativeAuthProvider } from "./provider.mjs";
import { AUTH_CONNECTION_METHODS } from "./patCompatibility.mjs";
import { assertAuthTransition, createAuthSnapshot } from "./states.mjs";

const CALLBACK_URI = "thrallo://auth/callback";
const ACTIVE_ACCOUNT = "desktop-auth";
const PENDING_ACCOUNT = "pending-auth";

function scope(accountId, deviceId, kind) {
  return Object.freeze({ accountId, deviceId, kind });
}

function activeScope(deviceId) {
  return scope(ACTIVE_ACCOUNT, deviceId, "active-account");
}

function pendingScope(deviceId) {
  return scope(PENDING_ACCOUNT, deviceId, "pending-authorization");
}

function sessionScope(accountId, deviceId) {
  return scope(accountId, deviceId, "device-session");
}

function errorState(error) {
  if (error?.code === "offline" || error instanceof OfflineError) return "offline";
  if (["authorization_expired", "authentication_expired"].includes(error?.code)) return "expired";
  if (["session_revoked", "refresh_replayed", "revoked"].includes(error?.code)) return "revoked";
  return "error";
}

function safeError(error) {
  return Object.freeze({
    code: String(error?.code || "authentication_error"),
    message: redactText(error?.message || "Authentication failed."),
  });
}

function validateSession(session, { deviceId, expectedAccountId = null } = {}) {
  if (!session || typeof session !== "object" || !session.accountId || !session.deviceId || !session.accessHandle || !session.refreshHandle
    || !Number.isFinite(session.accessExpiresAt) || !Number.isInteger(session.sessionRevision)) {
    throw new ThralloClientError("Authorization provider returned an invalid device session.", { code: "invalid_device_session" });
  }
  if (session.deviceId !== deviceId) throw new ThralloClientError("Authorization provider returned a different device.", { code: "device_mismatch" });
  if (expectedAccountId && session.accountId !== expectedAccountId) {
    throw new ThralloClientError("Authorization provider returned a different account.", { code: "account_mismatch" });
  }
  return Object.freeze({ ...session });
}

export class NativeAuthController {
  constructor({ provider, vault, capabilities, browser, deviceId, now = () => Date.now(), pkceFactory = createPkceTransaction } = {}) {
    this.provider = assertNativeAuthProvider(provider);
    if (!vault || !["store", "retrieve", "replace", "delete"].every((method) => typeof vault[method] === "function")) {
      throw new TypeError("Native auth controller requires a credential vault");
    }
    if (!browser || typeof browser.openExternal !== "function") throw new TypeError("Native auth controller requires a system-browser host");
    requireCapability(capabilities, "nativeKeychain", { operationId: "native-auth" });
    if (provider.capabilities?.browserAuthorization !== true) {
      throw new ThralloClientError("Native browser authorization is unavailable.", { code: "capability_unavailable" });
    }
    this.vault = vault;
    this.browser = browser;
    this.deviceId = String(deviceId || "");
    if (!this.deviceId) throw new TypeError("Native auth controller requires a stable deviceId");
    this.now = now;
    this.pkceFactory = pkceFactory;
    this.listeners = new Set();
    this.snapshot = createAuthSnapshot({ deviceId: this.deviceId });
  }

  getSnapshot() {
    return this.snapshot;
  }

  subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("Auth listener must be a function");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  transition(state, fields = {}) {
    assertAuthTransition(this.snapshot.state, state);
    this.snapshot = createAuthSnapshot({
      deviceId: this.deviceId,
      method: fields.method === undefined ? this.snapshot.method : fields.method,
      accountId: fields.accountId === undefined ? this.snapshot.accountId : fields.accountId,
      expiresAt: fields.expiresAt === undefined ? this.snapshot.expiresAt : fields.expiresAt,
      error: fields.error === undefined ? null : fields.error,
      state,
    });
    for (const listener of this.listeners) listener(this.snapshot);
    return this.snapshot;
  }

  async writeVault(targetScope, value) {
    const existing = await this.vault.retrieve(targetScope);
    return existing
      ? this.vault.replace(targetScope, value, { expectedRevision: existing.revision })
      : this.vault.store(targetScope, value);
  }

  async startAuthorization({ expectedAccountId = null } = {}) {
    this.transition("authorizing", { method: AUTH_CONNECTION_METHODS.preferred, accountId: expectedAccountId, expiresAt: null });
    try {
      const transaction = await this.pkceFactory({ createdAt: this.now() });
      const authorization = await this.provider.beginAuthorization({
        challenge: transaction.challenge,
        state: transaction.state,
        nonce: transaction.nonce,
        redirectUri: CALLBACK_URI,
        deviceId: this.deviceId,
        expectedAccountId,
      });
      await this.writeVault(pendingScope(this.deviceId), {
        ...transaction,
        authorizationId: authorization.authorizationId,
        expectedAccountId,
      });
      this.transition("awaiting_callback", { expiresAt: authorization.expiresAt });
      await this.browser.openExternal(authorization.authorizationUrl);
      return Object.freeze({ authorizationId: authorization.authorizationId, expiresAt: authorization.expiresAt });
    } catch (error) {
      await this.vault.delete(pendingScope(this.deviceId)).catch(() => {});
      this.transition(errorState(error), { error: safeError(error) });
      throw error;
    }
  }

  resumeAwaitingCallback() {
    if (this.snapshot.state === "awaiting_callback") return;
    if (["signed_out", "revoked", "expired", "error", "offline"].includes(this.snapshot.state)) {
      this.transition("authorizing", { method: AUTH_CONNECTION_METHODS.preferred });
      this.transition("awaiting_callback");
    }
  }

  async handleCallback(callbackUrl) {
    const callback = parseAuthCallback(callbackUrl);
    const pendingRecord = await this.vault.retrieve(pendingScope(this.deviceId));
    if (!pendingRecord) {
      throw new ThralloClientError("Authentication callback is stale or was already used.", { code: "callback_replayed" });
    }
    this.resumeAwaitingCallback();
    const pending = pendingRecord.value;
    correlateAuthCallback(callback, pending.state, { now: this.now(), expiresAt: pending.expiresAt });
    await this.vault.delete(pendingScope(this.deviceId));
    if (callback.error) {
      const denied = new ThralloClientError("Authentication was not authorized.", { code: callback.error, retryable: false });
      this.transition("error", { error: safeError(denied) });
      throw denied;
    }
    this.transition("exchanging");
    try {
      const session = validateSession(await this.provider.exchangeAuthorizationCode({
        authorizationId: pending.authorizationId,
        code: callback.code,
        verifier: pending.verifier,
        state: pending.state,
        nonce: pending.nonce,
        deviceId: this.deviceId,
      }), { deviceId: this.deviceId, expectedAccountId: pending.expectedAccountId });
      await this.writeVault(sessionScope(session.accountId, this.deviceId), session);
      try {
        await this.writeVault(activeScope(this.deviceId), { accountId: session.accountId });
      } catch (error) {
        await this.vault.delete(sessionScope(session.accountId, this.deviceId)).catch(() => {});
        throw error;
      }
      return this.transition("authenticated", {
        method: AUTH_CONNECTION_METHODS.preferred,
        accountId: session.accountId,
        expiresAt: session.accessExpiresAt,
      });
    } catch (error) {
      const state = errorState(error);
      if (state === "revoked") await this.clearStoredSession(this.snapshot.accountId).catch(() => {});
      this.transition(state, { error: safeError(error) });
      throw error;
    }
  }

  async readActiveSession() {
    const active = await this.vault.retrieve(activeScope(this.deviceId));
    if (!active?.value?.accountId) return null;
    const stored = await this.vault.retrieve(sessionScope(active.value.accountId, this.deviceId));
    if (!stored) {
      await this.vault.delete(activeScope(this.deviceId));
      return null;
    }
    const session = validateSession(stored.value, { deviceId: this.deviceId, expectedAccountId: active.value.accountId });
    return Object.freeze({ accountId: active.value.accountId, session, vaultRevision: stored.revision });
  }

  async startup() {
    const active = await this.readActiveSession();
    if (!active) return this.snapshot;
    if (this.provider.getConnectivity?.() === "offline") {
      return this.transition("offline", { method: AUTH_CONNECTION_METHODS.preferred, accountId: active.accountId, expiresAt: active.session.accessExpiresAt });
    }
    if (active.session.accessExpiresAt > this.now()) {
      return this.transition("authenticated", { method: AUTH_CONNECTION_METHODS.preferred, accountId: active.accountId, expiresAt: active.session.accessExpiresAt });
    }
    this.transition("expired", { method: AUTH_CONNECTION_METHODS.preferred, accountId: active.accountId, expiresAt: active.session.accessExpiresAt });
    return this.refreshActive(active);
  }

  async refreshActive(active = null) {
    const current = active || await this.readActiveSession();
    if (!current) {
      if (this.snapshot.state !== "signed_out") this.transition("signed_out", { method: null, accountId: null, expiresAt: null });
      return this.snapshot;
    }
    this.transition("refreshing", { accountId: current.accountId });
    try {
      const rotated = validateSession(await this.provider.refreshDeviceSession({
        accountId: current.accountId,
        deviceId: this.deviceId,
        refreshHandle: current.session.refreshHandle,
        sessionRevision: current.session.sessionRevision,
      }), { deviceId: this.deviceId, expectedAccountId: current.accountId });
      await this.vault.replace(sessionScope(current.accountId, this.deviceId), rotated, { expectedRevision: current.vaultRevision });
      return this.transition("authenticated", { expiresAt: rotated.accessExpiresAt });
    } catch (error) {
      const state = errorState(error);
      if (state === "revoked") await this.clearStoredSession(current.accountId).catch(() => {});
      this.transition(state, { error: safeError(error) });
      throw error;
    }
  }

  async refresh() {
    return this.refreshActive();
  }

  async reconnect() {
    if (this.provider.getConnectivity?.() === "offline") {
      if (this.snapshot.state !== "offline") this.transition("offline", { error: safeError(new OfflineError()) });
      return this.snapshot;
    }
    const active = await this.readActiveSession();
    if (!active) return this.transition("signed_out", { method: null, accountId: null, expiresAt: null });
    if (active.session.accessExpiresAt > this.now()) {
      return this.transition("authenticated", { method: AUTH_CONNECTION_METHODS.preferred, accountId: active.accountId, expiresAt: active.session.accessExpiresAt });
    }
    return this.refreshActive(active);
  }

  async clearStoredSession(accountId) {
    if (accountId) await this.vault.delete(sessionScope(accountId, this.deviceId));
    await this.vault.delete(activeScope(this.deviceId));
  }

  async logout() {
    const active = await this.readActiveSession().catch(() => null);
    if (active) {
      try {
        await this.provider.revokeDeviceSession({
          accountId: active.accountId,
          deviceId: this.deviceId,
          refreshHandle: active.session.refreshHandle,
        });
      } catch {
        // Local secure deletion is authoritative for logout even while offline.
      }
      await this.clearStoredSession(active.accountId);
    } else {
      await this.vault.delete(activeScope(this.deviceId));
    }
    await this.vault.delete(pendingScope(this.deviceId));
    return this.transition("signed_out", { method: null, accountId: null, expiresAt: null });
  }

  async switchAccount(accountId) {
    if (!accountId) throw new TypeError("Account switch requires an accountId");
    await this.logout();
    return this.startAuthorization({ expectedAccountId: accountId });
  }
}

export function createNativeAuthController(options) {
  return new NativeAuthController(options);
}
