import assert from "node:assert/strict";
import test from "node:test";
import { MemoryCodeAgentStore } from "../../shell/server/lib/codeAgentStore.mjs";
import {
  acceptGithubWebhook,
  drainGithubWebhookDeliveries,
} from "../../shell/server/lib/githubWebhookService.mjs";

test("webhook intake persists a delivery once and detects delivery ID conflicts", async () => {
  const store = new MemoryCodeAgentStore();
  const payload = { action: "created", installation: { id: 42 } };
  const rawBody = Buffer.from(JSON.stringify(payload));
  const first = await acceptGithubWebhook({
    deliveryId: "delivery-1",
    event: "installation",
    payload,
    rawBody,
  }, { store });
  const duplicate = await acceptGithubWebhook({
    deliveryId: "delivery-1",
    event: "installation",
    payload,
    rawBody,
  }, { store });

  assert.equal(first.isNew, true);
  assert.equal(duplicate.isNew, false);
  await assert.rejects(
    acceptGithubWebhook({
      deliveryId: "delivery-1",
      event: "installation",
      payload: { ...payload, action: "deleted" },
      rawBody: Buffer.from('{"action":"deleted"}'),
    }, { store }),
    /reused with a different payload/i,
  );
});

test("repository access events synchronize authoritative GitHub access", async () => {
  const store = new MemoryCodeAgentStore();
  await store.upsertGithubInstallation("owner-a", {
    installation_id: 42,
    account_login: "example",
    status: "active",
  });
  const retained = await store.createRepository("owner-a", {
    provider: "github", external_id: 7, installation_id: 42, full_name: "a/retained",
    clone_url: "https://github.com/a/retained.git", default_branch: "main", private: true,
  });
  const removed = await store.createRepository("owner-a", {
    provider: "github", external_id: 8, installation_id: 42, full_name: "a/removed",
    clone_url: "https://github.com/a/removed.git", default_branch: "main", private: true,
  });
  await store.recordGithubWebhookDelivery(delivery({
    delivery_id: "delivery-sync",
    event: "installation_repositories",
    action: "removed",
  }));

  const [processed] = await drainGithubWebhookDeliveries({
    store,
    getInstallationFn: async () => ({
      id: 42,
      account: { id: 1, login: "example", type: "User" },
      repository_selection: "selected",
      permissions: { contents: "write" },
      events: ["installation_repositories"],
      suspended_at: null,
    }),
    listRepositoriesFn: async () => [{ id: 7 }],
  });

  assert.equal(processed.status, "processed");
  assert.equal(processed.result.accessibleRepositoryCount, 1);
  assert.equal((await store.getRepository("owner-a", retained.id)).status, "ready");
  assert.equal((await store.getRepository("owner-a", removed.id)).status, "disconnected");
});

test("installation suspension is reflected locally without calling GitHub", async () => {
  const store = new MemoryCodeAgentStore();
  await store.upsertGithubInstallation("owner-a", {
    installation_id: 42,
    account_login: "example",
    status: "active",
  });
  const repository = await store.createRepository("owner-a", {
    provider: "github", external_id: 7, installation_id: 42, full_name: "a/repo",
    clone_url: "https://github.com/a/repo.git", default_branch: "main", private: true,
  });
  await store.recordGithubWebhookDelivery(delivery({
    delivery_id: "delivery-suspend",
    event: "installation",
    action: "suspend",
  }));

  const [processed] = await drainGithubWebhookDeliveries({
    store,
    getInstallationFn: async () => {
      throw new Error("GitHub should not be called");
    },
    listRepositoriesFn: async () => {
      throw new Error("GitHub should not be called");
    },
  });

  assert.equal(processed.status, "processed");
  assert.equal((await store.findGithubInstallation(42)).status, "suspended");
  assert.equal(await store.getGithubInstallation("owner-a", 42), null);
  assert.equal((await store.getRepository("owner-a", repository.id)).status, "disconnected");
});

test("transient GitHub failures are retained for an exponential retry", async () => {
  const store = new MemoryCodeAgentStore();
  await store.upsertGithubInstallation("owner-a", {
    installation_id: 42,
    account_login: "example",
    status: "active",
  });
  await store.recordGithubWebhookDelivery(delivery({
    delivery_id: "delivery-retry",
    event: "installation_repositories",
    action: "added",
  }));

  const [failed] = await drainGithubWebhookDeliveries({
    store,
    getInstallationFn: async () => {
      throw new Error("temporary GitHub outage");
    },
    listRepositoriesFn: async () => [],
  });

  assert.equal(failed.status, "failed");
  assert.equal(failed.attempts, 1);
  assert.match(failed.error, /temporary GitHub outage/);
  assert.ok(Date.parse(failed.next_attempt_at) > Date.now());
  assert.equal(failed.result.retryable, true);
});

test("default-branch pushes queue an automatic repository refresh", async () => {
  const store = new MemoryCodeAgentStore();
  await store.upsertGithubInstallation("owner-a", {
    installation_id: 42,
    account_login: "example",
    status: "active",
  });
  const repository = await store.createRepository("owner-a", {
    provider: "github",
    external_id: 7,
    installation_id: 42,
    full_name: "a/repo",
    clone_url: "https://github.com/a/repo.git",
    default_branch: "main",
    private: true,
  });
  await store.recordGithubWebhookDelivery({
    delivery_id: "delivery-push",
    event: "push",
    action: null,
    owner: "owner-a",
    installation_id: 42,
    payload_sha256: "b".repeat(64),
    payload: {
      installation: { id: 42 },
      repository: { id: 7 },
      ref: "refs/heads/main",
      after: "abc123",
    },
  });
  let request = null;
  const [processed] = await drainGithubWebhookDeliveries({
    store,
    refreshRequester: async (owner, queuedRepository, options) => {
      request = { owner, repository: queuedRepository, options };
    },
  });
  assert.equal(processed.status, "processed");
  assert.equal(processed.result.refreshQueued, true);
  assert.equal(request.owner, "owner-a");
  assert.equal(request.repository.id, repository.id);
  assert.equal(request.options.reason, "github_push");
  assert.equal(request.options.requestedHeadSha, "abc123");
});

function delivery({
  delivery_id,
  event,
  action,
}) {
  return {
    delivery_id,
    event,
    action,
    owner: "owner-a",
    installation_id: 42,
    payload_sha256: "a".repeat(64),
    payload: { action, installation: { id: 42 } },
  };
}
