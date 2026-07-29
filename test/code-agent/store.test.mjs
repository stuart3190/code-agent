import assert from "node:assert/strict";
import test from "node:test";
import { MemoryCodeAgentStore } from "../../shell/server/lib/codeAgentStore.mjs";

test("memory control plane isolates owners and preserves ordered run events", async () => {
  const store = new MemoryCodeAgentStore();
  const repo = await store.createRepository("owner-a", {
    provider: "github", full_name: "a/repo", clone_url: "https://github.com/a/repo.git",
    default_branch: "main", private: true,
  });
  const agent = await store.createAgent("owner-a", { repository_id: repo.id, name: "Agent", mode: "agent" });
  const run = await store.createRun("owner-a", agent, repo, { prompt: "Do work", mode: "agent", model: "auto" });
  await store.appendEvent(run, "tool.started", { name: "read_file" });

  assert.equal(await store.getRepository("owner-b", repo.id), null);
  assert.equal(await store.getRun("owner-b", run.id), null);
  assert.deepEqual((await store.listEvents("owner-a", run.id)).map((x) => x.sequence), [1, 2]);
  assert.equal(await store.listEvents("owner-b", run.id), null);
});

test("queued cancellation is terminal and cannot be claimed", async () => {
  const store = new MemoryCodeAgentStore();
  const repo = await store.createRepository("owner", {
    provider: "github", full_name: "a/repo", clone_url: "https://github.com/a/repo.git",
    default_branch: "main", private: false,
  });
  const agent = await store.createAgent("owner", { repository_id: repo.id, name: "Agent", mode: "agent" });
  const run = await store.createRun("owner", agent, repo, { prompt: "Do work", mode: "agent", model: "auto" });
  assert.equal((await store.requestCancel("owner", run.id)).state, "cancelled");
  assert.deepEqual(await store.claimRuns(1), []);
});

test("latest agent run survives refresh and remains owner scoped", async () => {
  const store = new MemoryCodeAgentStore();
  const repo = await store.createRepository("owner-a", {
    provider: "github", full_name: "a/repo", clone_url: "https://github.com/a/repo.git",
    default_branch: "main", private: false,
  });
  const agent = await store.createAgent("owner-a", { repository_id: repo.id, name: "Agent", mode: "agent" });
  await store.createRun("owner-a", agent, repo, { prompt: "First", mode: "agent", model: "auto" });
  const latest = await store.createRun("owner-a", agent, repo, { prompt: "Second", mode: "agent", model: "auto" });

  assert.equal((await store.getLatestRun("owner-a", agent.id)).id, latest.id);
  assert.equal(await store.getLatestRun("owner-b", agent.id), null);
});

test("a GitHub installation cannot be reassigned between owners", async () => {
  const store = new MemoryCodeAgentStore();
  const installation = await store.upsertGithubInstallation("owner-a", {
    installation_id: 42, account_login: "example",
  });
  assert.equal((await store.getGithubInstallation("owner-a", 42)).id, installation.id);
  assert.equal(await store.getGithubInstallation("owner-b", 42), null);
  await assert.rejects(
    store.upsertGithubInstallation("owner-b", { installation_id: 42, account_login: "example" }),
    /already connected/i,
  );
});

test("GitHub installation lifecycle disables inaccessible repositories", async () => {
  const store = new MemoryCodeAgentStore();
  await store.upsertGithubInstallation("owner-a", {
    installation_id: 42, account_login: "example", status: "active",
  });
  const retained = await store.createRepository("owner-a", {
    provider: "github", external_id: 7, installation_id: 42, full_name: "a/retained",
    clone_url: "https://github.com/a/retained.git", default_branch: "main", private: true,
  });
  const removed = await store.createRepository("owner-a", {
    provider: "github", external_id: 8, installation_id: 42, full_name: "a/removed",
    clone_url: "https://github.com/a/removed.git", default_branch: "main", private: true,
  });

  assert.deepEqual(await store.syncGithubRepositoryAccess(42, [7], "Access removed"), {
    ready: 1, disconnected: 1, total: 2,
  });
  assert.equal((await store.getRepository("owner-a", retained.id)).status, "ready");
  assert.equal((await store.getRepository("owner-a", removed.id)).status, "disconnected");
  assert.equal((await store.getRepository("owner-a", removed.id)).last_error, "Access removed");

  await store.updateGithubInstallationLifecycle(42, { status: "suspended" });
  assert.equal(await store.getGithubInstallation("owner-a", 42), null);
  assert.equal((await store.findGithubInstallation(42)).status, "suspended");
});

test("GitHub webhook deliveries are idempotent, claimable, and terminal", async () => {
  const store = new MemoryCodeAgentStore();
  const input = {
    delivery_id: "delivery-1",
    event: "installation",
    action: "created",
    owner: null,
    installation_id: 42,
    payload_sha256: "a".repeat(64),
    payload: { action: "created", installation: { id: 42 } },
  };
  assert.equal((await store.recordGithubWebhookDelivery(input)).isNew, true);
  assert.equal((await store.recordGithubWebhookDelivery(input)).isNew, false);

  const [claimed] = await store.claimGithubWebhookDeliveries(10);
  assert.equal(claimed.status, "processing");
  assert.equal(claimed.attempts, 1);
  assert.deepEqual(await store.claimGithubWebhookDeliveries(10), []);

  const completed = await store.completeGithubWebhookDelivery("delivery-1", {
    status: "processed",
    processed_at: new Date().toISOString(),
    result: { synchronized: true },
  });
  assert.equal(completed.status, "processed");
  assert.deepEqual(completed.result, { synchronized: true });
});

test("artifacts and usage remain scoped to the run owner", async () => {
  const store = new MemoryCodeAgentStore();
  const repo = await store.createRepository("owner-a", {
    provider: "github", full_name: "a/repo", clone_url: "https://github.com/a/repo.git",
    default_branch: "main", private: false,
  });
  const agent = await store.createAgent("owner-a", { repository_id: repo.id, name: "Agent", mode: "agent" });
  const run = await store.createRun("owner-a", agent, repo, { prompt: "Work", mode: "agent", model: "auto" });
  await store.createArtifact(run, { type: "diff", name: "changes.patch", content: "diff", size_bytes: 4 });
  await store.recordUsage(run, { provider: "openai", model: "gpt-test", input_tokens: 12, output_tokens: 3 });
  assert.equal((await store.listArtifacts("owner-a", run.id)).length, 1);
  assert.equal(await store.listArtifacts("owner-b", run.id), null);
  assert.equal((await store.usageSummary("owner-a")).totals.inputTokens, 12);
  assert.equal((await store.usageSummary("owner-b")).totals.inputTokens, 0);
});

test("stale active runs are marked interrupted while fresh runs continue", async () => {
  const store = new MemoryCodeAgentStore();
  const repo = await store.createRepository("owner", {
    provider: "github", full_name: "a/repo", clone_url: "https://github.com/a/repo.git",
    default_branch: "main", private: false,
  });
  const agent = await store.createAgent("owner", { repository_id: repo.id, name: "Agent", mode: "agent" });
  const stale = await store.createRun("owner", agent, repo, { prompt: "Old", mode: "agent", model: "auto" });
  await store.claimRuns(1);
  stale.updated_at = "2020-01-01T00:00:00.000Z";
  const interrupted = await store.interruptStaleRuns("2026-01-01T00:00:00.000Z");
  assert.equal(interrupted.length, 1);
  assert.equal((await store.getRun("owner", stale.id)).state, "interrupted");
});
