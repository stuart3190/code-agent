import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";

process.env.PLATFORM_ENC_KEY = "11".repeat(32);
process.env.CODE_AGENT_STORE = "memory";

const {
  MemoryAiCredentialStore,
  activeAiCredential,
  aiConnectionSummary,
  connectApiKey,
  connectCodexAuth,
  disconnectAiProvider,
  updateAiRoutingPolicy,
} = await import("../../shell/server/lib/aiCredentialStore.mjs");
const {
  _internal,
  codexLoginStatus,
  startCodexLogin,
  stopCodexLoginSessions,
} = await import("../../shell/server/lib/codexLogin.mjs");

test.afterEach(async () => {
  await stopCodexLoginSessions();
});

test("BYOK keys are validated, encrypted, redacted, selected, and removable", async () => {
  const store = new MemoryAiCredentialStore();
  const key = `sk-proj-${"a".repeat(40)}`;
  const connected = await connectApiKey("owner-a", "openai", key, {
    store,
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://api.openai.com/v1/models");
      assert.equal(options.headers.Authorization, `Bearer ${key}`);
      return { ok: true };
    },
  });

  assert.equal(connected.provider, "openai");
  assert.doesNotMatch(JSON.stringify(connected), new RegExp(key));
  const stored = await store.getCredential("owner-a", "openai");
  assert.notEqual(stored.secret_encrypted, key);
  assert.doesNotMatch(stored.secret_encrypted, /sk-proj/);

  const active = await activeAiCredential("owner-a", { store });
  assert.equal(active.provider, "openai");
  assert.equal(active.secret, key);
  const summary = await aiConnectionSummary("owner-a", { store });
  assert.equal(summary.activeProvider, "openai");
  assert.doesNotMatch(JSON.stringify(summary), new RegExp(key));

  const disconnected = await disconnectAiProvider("owner-a", "openai", { store });
  assert.equal(disconnected.activeProvider, "managed");
  assert.equal(disconnected.connections.length, 0);
});

test("rejected API keys are never stored", async () => {
  const store = new MemoryAiCredentialStore();
  await assert.rejects(
    connectApiKey("owner-a", "anthropic", `sk-ant-${"x".repeat(30)}`, {
      store,
      fetchImpl: async () => ({ ok: false }),
    }),
    (error) => error.code === "provider_key_rejected",
  );
  assert.equal((await store.listCredentials("owner-a")).length, 0);
});

test("Gemini keys are verified with a header and routing preferences are persisted", async () => {
  const store = new MemoryAiCredentialStore();
  const key = `AIza${"g".repeat(36)}`;
  await connectApiKey("owner-g", "gemini", key, {
    store,
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1");
      assert.equal(options.headers["x-goog-api-key"], key);
      return { ok: true };
    },
  });
  const summary = await updateAiRoutingPolicy("owner-g", {
    routingMode: "quality",
    allowFallback: false,
  }, { store });
  assert.equal(summary.activeProvider, "gemini");
  assert.deepEqual(summary.routing, {
    routingMode: "quality",
    preferredModel: null,
    allowFallback: false,
  });
});

test("Codex auth state is encrypted and summaries expose account metadata only", async () => {
  const store = new MemoryAiCredentialStore();
  const auth = JSON.stringify({ tokens: { access_token: "very-secret-access-token" } });
  const result = await connectCodexAuth("owner-a", auth, {
    email: "user@example.com",
    planType: "plus",
  }, { store });

  assert.equal(result.provider, "codex");
  assert.equal(result.hint, "user@example.com");
  assert.deepEqual(result.metadata, { email: "user@example.com", planType: "plus" });
  assert.doesNotMatch(JSON.stringify(result), /very-secret/);
  assert.equal((await activeAiCredential("owner-a", { store })).secret, auth);
});

test("Codex device login is owner-scoped and persists completed app-server auth", async () => {
  const store = new MemoryAiCredentialStore();
  class FakeClient {
    constructor({ codexHome }) { this.codexHome = codexHome; }
    async start() { return this; }
    async request(method) {
      if (method === "account/login/start") {
        await writeFile(
          `${this.codexHome}/auth.json`,
          JSON.stringify({ tokens: { access_token: "codex-login-secret" } }),
        );
        return {
          loginId: "login-1",
          verificationUrl: "https://auth.openai.com/codex/device",
          userCode: "ABCD-EFGH",
        };
      }
      if (method === "account/read") {
        return { account: { type: "chatgpt", email: "member@example.com", planType: "plus" } };
      }
      return {};
    }
    latestNotification() { return null; }
    close() {}
  }

  const login = await startCodexLogin("owner-a", {
    clientFactory: (options) => new FakeClient(options),
  });
  assert.equal(login.status, "pending");
  assert.equal(login.userCode, "ABCD-EFGH");
  await assert.rejects(
    codexLoginStatus("owner-b", login.sessionId, { credentialStore: store }),
    (error) => error.code === "codex_login_not_found",
  );

  const completed = await codexLoginStatus("owner-a", login.sessionId, { credentialStore: store });
  assert.equal(completed.status, "connected");
  assert.equal(completed.connection.hint, "member@example.com");
  assert.equal(_internal.sessions.size, 0);
  const active = await activeAiCredential("owner-a", { store });
  assert.equal(active.provider, "codex");
  assert.match(active.secret, /codex-login-secret/);
});
