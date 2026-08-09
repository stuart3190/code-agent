import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AUTH_CONNECTION_METHODS,
  NATIVE_AUTH_STATES,
  ThralloClientError,
  assertAuthTransition,
  assertNativeAuthProvider,
  canTransitionAuthState,
  createDevelopmentCredentialVault,
  createDeterministicAuthProvider,
  createFixtureProviderSuite,
  createHostCapabilities,
  createLegacyPatConnection,
  createNativeAuthDeepLinkDispatcher,
  createNativeAuthController,
  createNativeCredentialVault,
  createPkceChallenge,
  createPkceTransaction,
  createUnavailableServerAuthProvider,
  parseAuthCallback,
  redact,
  redactText,
} from "../../shared/thrallo-client/src/index.mjs";
import { forbiddenReferences } from "../../desktop/d0/guard.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEVICE_ID = "fixture-device-windows-0001";
const capabilities = createHostCapabilities({ nativeKeychain: true });

function deterministicPkceFactory(offset = 0) {
  let call = 0;
  return (options) => createPkceTransaction({
    ...options,
    randomBytes(length) {
      call += 1;
      return Uint8Array.from({ length }, (_, index) => (offset + call * 37 + index * 13) % 256);
    },
  });
}

function setup({ provider = createDeterministicAuthProvider(), vault = createDevelopmentCredentialVault(), deviceId = DEVICE_ID, pkceOffset = 0 } = {}) {
  const opened = [];
  const controller = createNativeAuthController({
    provider,
    vault,
    capabilities,
    deviceId,
    now: provider.now,
    pkceFactory: deterministicPkceFactory(pkceOffset),
    browser: { openExternal: async (url) => opened.push(url) },
  });
  return { provider, vault, controller, opened };
}

async function authenticate(context, expectedAccountId = null) {
  const initiated = await context.controller.startAuthorization({ expectedAccountId });
  const callback = context.provider.completeAuthorization(initiated.authorizationId);
  const snapshot = await context.controller.handleCallback(callback);
  return { initiated, callback, snapshot };
}

async function directAuthorization(provider, { deviceId = DEVICE_ID, expectedAccountId = null, pkceOffset = 70 } = {}) {
  const transaction = await deterministicPkceFactory(pkceOffset)({ createdAt: provider.now() });
  const authorization = await provider.beginAuthorization({
    challenge: transaction.challenge,
    state: transaction.state,
    nonce: transaction.nonce,
    redirectUri: "thrallo://auth/callback",
    deviceId,
    expectedAccountId,
  });
  const parsed = parseAuthCallback(provider.completeAuthorization(authorization.authorizationId));
  return { transaction, authorization, parsed };
}

test("native authentication states and transitions are explicit", () => {
  assert.deepEqual(NATIVE_AUTH_STATES, [
    "signed_out", "authorizing", "awaiting_callback", "exchanging", "authenticated",
    "refreshing", "expired", "revoked", "offline", "error",
  ]);
  assert.equal(canTransitionAuthState("signed_out", "authorizing"), true);
  assert.equal(canTransitionAuthState("awaiting_callback", "authenticated"), false);
  assert.throws(() => assertAuthTransition("awaiting_callback", "authenticated"), /Invalid native auth transition/);
});

test("successful deterministic PKCE flow reaches authenticated state", async () => {
  const context = setup();
  const states = [];
  context.controller.subscribe((snapshot) => states.push(snapshot.state));
  const result = await authenticate(context);
  assert.equal(result.snapshot.state, "authenticated");
  assert.equal(result.snapshot.method, "native_browser_pkce");
  assert.equal(result.snapshot.accountId, "fixture-account-alpha");
  assert.deepEqual(states, ["authorizing", "awaiting_callback", "exchanging", "authenticated"]);
  assert.equal(context.opened.length, 1);
  assert.match(context.opened[0], /^thrallo-fixture:\/\/authorize\//);
});

test("PKCE uses a high-entropy verifier and the standard S256 challenge", async () => {
  const transaction = await deterministicPkceFactory(29)({ createdAt: 1_000 });
  assert.equal(transaction.verifier.length, 86);
  assert.match(transaction.verifier, /^[A-Za-z0-9_-]{86}$/);
  assert.equal(transaction.state.length, 43);
  assert.equal(transaction.nonce.length, 43);
  assert.notEqual(transaction.state, transaction.nonce);
  assert.equal(
    await createPkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});

test("PKCE verifier mismatch is rejected without issuing a session", async () => {
  const provider = createDeterministicAuthProvider();
  const flow = await directAuthorization(provider);
  const wrong = await deterministicPkceFactory(91)({ createdAt: provider.now() });
  await assert.rejects(provider.exchangeAuthorizationCode({
    authorizationId: flow.authorization.authorizationId,
    code: flow.parsed.code,
    verifier: wrong.verifier,
    state: flow.transaction.state,
    nonce: flow.transaction.nonce,
    deviceId: DEVICE_ID,
  }), (error) => error.code === "pkce_verifier_mismatch");
});

test("mismatched callback state is rejected while the valid single-use result remains pending", async () => {
  const context = setup();
  const initiated = await context.controller.startAuthorization();
  const wrongCallback = context.provider.completeAuthorization(initiated.authorizationId, { state: "mismatched-state-value" });
  await assert.rejects(context.controller.handleCallback(wrongCallback), (error) => error.code === "state_mismatch");
  assert.equal(context.controller.getSnapshot().state, "awaiting_callback");
  const valid = context.provider.completeAuthorization(initiated.authorizationId);
  assert.equal((await context.controller.handleCallback(valid)).state, "authenticated");
});

test("expired authorization codes and replayed codes fail closed", async () => {
  const expired = setup();
  const initiated = await expired.controller.startAuthorization();
  expired.provider.advance(121_000);
  await assert.rejects(expired.controller.handleCallback(expired.provider.completeAuthorization(initiated.authorizationId)),
    (error) => error.code === "authorization_expired");
  assert.equal(expired.controller.getSnapshot().state, "expired");

  const provider = createDeterministicAuthProvider();
  const flow = await directAuthorization(provider);
  const input = {
    authorizationId: flow.authorization.authorizationId,
    code: flow.parsed.code,
    verifier: flow.transaction.verifier,
    state: flow.transaction.state,
    nonce: flow.transaction.nonce,
    deviceId: DEVICE_ID,
  };
  await provider.exchangeAuthorizationCode(input);
  await assert.rejects(provider.exchangeAuthorizationCode(input), (error) => error.code === "authorization_replayed");
});

test("duplicate, malformed, and unknown callback payloads are rejected as untrusted input", async () => {
  for (const callback of [
    "not-a-url",
    "https://auth/callback?code=valid-code-value&state=valid-state-value",
    "thrallo://wrong/callback?code=valid-code-value&state=valid-state-value",
    "thrallo://auth/callback?code=valid-code-value&code=other-code-value&state=valid-state-value",
    "thrallo://auth/callback?code=valid-code-value&state=valid-state-value&extra=nope-value",
    "thrallo://auth/callback?code=valid-code-value&state=valid-state-value&error_description=not-allowed",
    "thrallo://auth/callback#code=valid-code-value&state=valid-state-value",
  ]) assert.throws(() => parseAuthCallback(callback), (error) => error.code === "invalid_callback");

  const context = setup();
  const result = await authenticate(context);
  await assert.rejects(context.controller.handleCallback(result.callback), (error) => error.code === "callback_replayed");
  assert.equal(context.controller.getSnapshot().state, "authenticated");
});

test("a correlated authorization denial is single-use and does not expose its description", async () => {
  const context = setup();
  const initiated = await context.controller.startAuthorization();
  const pending = await context.vault.retrieve({ accountId: "pending-auth", deviceId: DEVICE_ID, kind: "pending-authorization" });
  const callback = `thrallo://auth/callback?error=access_denied&error_description=${encodeURIComponent("Bearer private-denial-detail")}&state=${encodeURIComponent(pending.value.state)}`;
  await assert.rejects(context.controller.handleCallback(callback), (error) => {
    assert.equal(error.code, "access_denied");
    assert.doesNotMatch(error.message, /private-denial-detail/);
    return true;
  });
  assert.equal(context.controller.getSnapshot().state, "error");
  await assert.rejects(context.controller.handleCallback(callback), (error) => error.code === "callback_replayed");
  assert.ok(initiated.authorizationId);
});

test("callback-launched desktop can recover a pending flow from the secure vault", async () => {
  const provider = createDeterministicAuthProvider();
  const vault = createDevelopmentCredentialVault();
  const first = setup({ provider, vault, pkceOffset: 4 });
  const initiated = await first.controller.startAuthorization();
  const launchedByCallback = setup({ provider, vault, pkceOffset: 5 });
  const dispatcher = createNativeAuthDeepLinkDispatcher({ controller: launchedByCallback.controller });
  const callback = provider.completeAuthorization(initiated.authorizationId);
  const snapshot = await dispatcher.handleLaunchArguments(["--unity-launch", callback]);
  assert.equal(snapshot.state, "authenticated");
});

test("already-running deep-link delivery is serialized so concurrent duplicates cannot exchange twice", async () => {
  const context = setup();
  const initiated = await context.controller.startAuthorization();
  const callback = context.provider.completeAuthorization(initiated.authorizationId);
  const dispatcher = createNativeAuthDeepLinkDispatcher({ controller: context.controller });
  const [first, duplicate] = await Promise.allSettled([
    dispatcher.handleOpenUrl(callback),
    dispatcher.handleOpenUrl(callback),
  ]);
  assert.equal(first.status, "fulfilled");
  assert.equal(first.value.state, "authenticated");
  assert.equal(duplicate.status, "rejected");
  assert.equal(duplicate.reason.code, "callback_replayed");
});

test("refresh rotates opaque material and rejects reuse", async () => {
  const context = setup();
  await authenticate(context);
  const before = await context.controller.readActiveSession();
  const rotatedSnapshot = await context.controller.refresh();
  const after = await context.controller.readActiveSession();
  assert.equal(rotatedSnapshot.state, "authenticated");
  assert.notEqual(before.session.refreshHandle, after.session.refreshHandle);
  assert.equal(after.session.sessionRevision, before.session.sessionRevision + 1);
  await assert.rejects(context.provider.refreshDeviceSession({
    accountId: before.accountId,
    deviceId: DEVICE_ID,
    refreshHandle: before.session.refreshHandle,
    sessionRevision: before.session.sessionRevision,
  }), (error) => error.code === "refresh_replayed");
});

test("account and device session mix-ups are rejected", async () => {
  const provider = createDeterministicAuthProvider();
  const flow = await directAuthorization(provider);
  const session = await provider.exchangeAuthorizationCode({
    authorizationId: flow.authorization.authorizationId,
    code: flow.parsed.code,
    verifier: flow.transaction.verifier,
    state: flow.transaction.state,
    nonce: flow.transaction.nonce,
    deviceId: DEVICE_ID,
  });
  await assert.rejects(provider.refreshDeviceSession({ ...session, accountId: "fixture-account-other" }),
    (error) => error.code === "account_mismatch");
  await assert.rejects(provider.refreshDeviceSession({ ...session, deviceId: "fixture-device-other" }),
    (error) => error.code === "device_mismatch");
});

test("revoked stored session forces reauthentication after restart", async () => {
  const context = setup();
  await authenticate(context);
  context.provider.advance(901_000);
  context.provider.revokeDevice({ accountId: "fixture-account-alpha", deviceId: DEVICE_ID });
  const restarted = setup({ provider: context.provider, vault: context.vault });
  await assert.rejects(restarted.controller.startup(), (error) => error.code === "refresh_replayed");
  assert.equal(restarted.controller.getSnapshot().state, "revoked");
  assert.deepEqual(context.vault.inspectKeys(), []);
});

test("logout securely deletes stored material and account switch enforces account binding", async () => {
  const context = setup();
  await authenticate(context);
  assert.ok(context.vault.inspectKeys().length > 0);
  assert.equal((await context.controller.logout()).state, "signed_out");
  assert.deepEqual(context.vault.inspectKeys(), []);

  await authenticate(context);
  const initiated = await context.controller.switchAccount("fixture-account-beta");
  const switched = await context.controller.handleCallback(context.provider.completeAuthorization(initiated.authorizationId));
  assert.equal(switched.accountId, "fixture-account-beta");
});

test("offline startup preserves a secure session and reconnect recovers", async () => {
  const context = setup();
  await authenticate(context);
  context.provider.setOffline(true);
  const restarted = setup({ provider: context.provider, vault: context.vault });
  assert.equal((await restarted.controller.startup()).state, "offline");
  context.provider.setOffline(false);
  assert.equal((await restarted.controller.reconnect()).state, "authenticated");
});

test("expired offline session refreshes after reconnect", async () => {
  const context = setup();
  await authenticate(context);
  context.provider.advance(901_000);
  context.provider.setOffline(true);
  const restarted = setup({ provider: context.provider, vault: context.vault });
  assert.equal((await restarted.controller.startup()).state, "offline");
  context.provider.setOffline(false);
  assert.equal((await restarted.controller.reconnect()).state, "authenticated");
});

test("credential-store failure is explicit and secure deletion is observable without values", async () => {
  const failed = setup({ vault: createDevelopmentCredentialVault({ failOperations: ["store"] }) });
  await assert.rejects(failed.controller.startAuthorization(), (error) => error.code === "credential_store_failure");
  assert.equal(failed.controller.getSnapshot().state, "error");

  const context = setup();
  await authenticate(context);
  await context.controller.logout();
  assert.deepEqual(context.vault.inspectKeys(), []);
  assert.ok(context.vault.getCalls().some((call) => call.operation === "delete" && call.outcome === "deleted"));
  assert.doesNotMatch(JSON.stringify(context.vault.getCalls()), /fixture-(?:access|refresh|code)-/);
});

test("native credential adapter uses only host SecretStorage semantics", async () => {
  const storage = new Map();
  const calls = [];
  const vault = createNativeCredentialVault({ secretStorage: {
    async get(key) { calls.push(["get", key]); return storage.get(key); },
    async store(key, value) { calls.push(["store", key]); storage.set(key, value); },
    async delete(key) { calls.push(["delete", key]); storage.delete(key); },
  } });
  const target = { accountId: "fixture-account", deviceId: DEVICE_ID, kind: "device-session" };
  assert.equal((await vault.store(target, { refreshHandle: "fixture-refresh-private" })).revision, 1);
  assert.equal((await vault.retrieve(target)).value.refreshHandle, "fixture-refresh-private");
  assert.equal((await vault.replace(target, { refreshHandle: "fixture-refresh-rotated" }, { expectedRevision: 1 })).revision, 2);
  await vault.delete(target);
  assert.equal(await vault.retrieve(target), null);
  assert.deepEqual(new Set(calls.map(([operation]) => operation)), new Set(["get", "store", "delete"]));
});

test("manual PAT connection remains available but is explicitly legacy", async () => {
  const connection = createLegacyPatConnection({ getPat: async () => "thrallo_pat_fixture_compatibility" });
  assert.equal(AUTH_CONNECTION_METHODS.preferred, "native_browser_pkce");
  assert.equal(connection.mode, "legacy_manual_pat");
  assert.equal(connection.preferred, false);
  assert.deepEqual(await connection.getAuthHeaders(), { authorization: "Bearer thrallo_pat_fixture_compatibility" });
  const extension = readFileSync(path.join(ROOT, "editor/vscode/extension.js"), "utf8");
  assert.match(extension, /registerCommand\("thrallo\.connect"/);
  assert.match(extension, /context\.secrets\.store\(TOKEN_KEY/);
  assert.match(extension, /Tokens start with thrallo_pat_/);
});

test("auth secrets, PKCE correlation, callbacks, and session material are redacted", async () => {
  const callback = "thrallo://auth/callback?code=private-code-value&state=private-state-value&nonce=private-nonce-value";
  const rendered = JSON.stringify(redact({
    verifier: "private-verifier-value",
    nonce: "private-nonce-value",
    authorizationCode: "private-code-value",
    accessHandle: "private-access-value",
    refreshHandle: "private-refresh-value",
    message: callback,
  }));
  for (const secret of ["private-verifier-value", "private-nonce-value", "private-code-value", "private-access-value", "private-refresh-value", "private-state-value"]) {
    assert.doesNotMatch(rendered, new RegExp(secret));
  }
  assert.doesNotMatch(redactText(callback), /private-code-value|private-state-value|private-nonce-value/);

  const context = setup();
  const result = await authenticate(context);
  assert.doesNotMatch(JSON.stringify(result.snapshot), /fixture-(?:access|refresh|code)-/);
  assert.doesNotMatch(JSON.stringify(context.provider.getCalls()), /private|fixture-(?:access|refresh|code)-/);
});

test("deterministic auth providers produce identical state and call sequences", async () => {
  const left = setup({ pkceOffset: 11 });
  const right = setup({ pkceOffset: 11 });
  await authenticate(left);
  await authenticate(right);
  assert.deepEqual(left.controller.getSnapshot(), right.controller.getSnapshot());
  assert.deepEqual(left.provider.getCalls(), right.provider.getCalls());
  assert.deepEqual(left.vault.getCalls(), right.vault.getCalls());
});

test("server authorization boundary is explicit and capability-unavailable", async () => {
  const provider = createUnavailableServerAuthProvider();
  assertNativeAuthProvider(provider);
  assert.equal(provider.capabilities.productionMutation, false);
  await assert.rejects(provider.beginAuthorization({}), (error) => error.code === "capability_unavailable");
});

test("D1 provider contracts remain compatible and auth tests make no network call", async () => {
  assert.equal(createFixtureProviderSuite().contractVersion, "1.0");
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => { networkCalls += 1; throw new Error("D2 fixtures cannot access a network"); };
  try {
    const context = setup();
    await authenticate(context);
    await context.controller.refresh();
    await context.controller.logout();
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(networkCalls, 0);
});

test("D2 auth code contains no Builder V2 or retired Buildr101 dependency", () => {
  const denylist = JSON.parse(readFileSync(path.join(ROOT, "desktop/d0/buildr101-denylist.json"), "utf8"));
  const authRoot = path.join(ROOT, "shared/thrallo-client/src/auth");
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else files.push(target);
    }
  };
  visit(authRoot);
  const source = files.map((file) => readFileSync(file, "utf8")).join("\n");
  assert.deepEqual(forbiddenReferences(source, denylist), []);
  assert.doesNotMatch(source, /shell\/server|supabase|build-worker|provisiond|runtime-worker|app\.thrallo\.com|\bfetch\s*\(/i);
});
