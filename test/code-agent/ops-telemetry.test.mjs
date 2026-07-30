import assert from "node:assert/strict";
import test from "node:test";

import { MemoryCodeAgentStore } from "../../shell/server/lib/codeAgentStore.mjs";
import { MemoryAiRoutingStore } from "../../shell/server/lib/aiRoutingStore.mjs";
import { MemoryRepositoryIndexStore } from "../../shell/server/lib/repositoryIndexStore.mjs";
import { opsTelemetrySnapshot } from "../../shell/server/lib/opsTelemetry.mjs";
import { handleOpsTelemetry } from "../../shell/server/routes/subscription.mjs";

const OWNER = "33333333-3333-4333-8333-333333333333";

async function seededStores() {
  const store = new MemoryCodeAgentStore();
  const routingStore = new MemoryAiRoutingStore();
  const indexStore = new MemoryRepositoryIndexStore();
  const repository = await store.createRepository(OWNER, {
    full_name: "owner/repo", clone_url: "https://github.com/owner/repo.git",
    default_branch: "main", private: true, provider: "github",
  });
  const agent = await store.createAgent(OWNER, { repository_id: repository.id, name: "a", mode: "agent" });

  const succeeded = await store.createRun(OWNER, agent, repository, { prompt: "x", mode: "agent", model: "auto" });
  const startedAt = new Date(Date.now() - 90_000).toISOString();
  await store.updateRun(succeeded, {
    state: "succeeded", started_at: startedAt,
    finished_at: new Date(new Date(startedAt).getTime() + 60_000).toISOString(),
  });
  const failed = await store.createRun(OWNER, agent, repository, { prompt: "y", mode: "agent", model: "auto" });
  await store.updateRun(failed, {
    state: "failed", started_at: startedAt, finished_at: new Date().toISOString(),
  });
  await store.createRun(OWNER, agent, repository, { prompt: "z", mode: "agent", model: "auto" });

  await store.recordUsage(succeeded, {
    billing_source: "managed", input_tokens: 700, output_tokens: 300, compute_seconds: 60,
  });
  await store.recordGithubWebhookDelivery({ delivery_id: "d1", event: "push", action: null, payload: {} });
  await routingStore.recordAttempt(OWNER, {
    provider: "openai", model: "gpt-test", status: "success", latency_ms: 900,
  });
  await routingStore.recordAttempt(OWNER, {
    provider: "openai", model: "gpt-test", status: "error", latency_ms: 100, retryable: true,
  });
  await indexStore.beginIndex(OWNER, repository.id, "abc", "embed-model");
  return { store, routingStore, indexStore };
}

test("ops snapshot aggregates runs, providers, webhooks, usage, and indexing", async () => {
  const { store, routingStore, indexStore } = await seededStores();
  const snapshot = await opsTelemetrySnapshot({ store, routingStore, indexStore });

  assert.equal(snapshot.runs.last24h.total, 3);
  assert.equal(snapshot.runs.last24h.byState.succeeded, 1);
  assert.equal(snapshot.runs.last24h.byState.failed, 1);
  assert.equal(snapshot.runs.queueDepth, 1);
  assert.equal(snapshot.runs.last24h.failureRate, 0.5);
  assert.equal(snapshot.runs.last24h.averageDurationSeconds > 0, true);

  assert.equal(snapshot.webhooks.received, 1);

  const provider = snapshot.providers[0];
  assert.equal(provider.model, "gpt-test");
  assert.equal(provider.attempts, 2);
  assert.equal(provider.errorRate, 0.5);
  assert.equal(provider.averageLatencyMs, 500);

  assert.equal(snapshot.usage.last24h.tokens, 1_000);
  assert.equal(snapshot.usage.last24h.bySource.managed, 1_000);
  assert.equal(snapshot.usage.last24h.computeSeconds, 60);

  assert.equal(snapshot.indexing.indexing, 1);
});

test("the telemetry route is operator-gated by verified email", async () => {
  const previous = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = "ops@thrallo.com";
  const response = () => {
    const out = { code: null, body: null };
    return {
      out,
      writeHead(code) { out.code = code; },
      end(body) { out.body = body; },
    };
  };
  const denied = response();
  await assert.rejects(
    handleOpsTelemetry(null, denied, { id: OWNER, email: "user@example.com" }),
    (error) => error.status === 403 && error.code === "operator_only",
  );
  process.env.ADMIN_EMAILS = previous ?? "";
  if (previous === undefined) delete process.env.ADMIN_EMAILS;
});
