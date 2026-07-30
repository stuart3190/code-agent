import assert from "node:assert/strict";
import test from "node:test";
import { MemoryCodeAgentStore } from "../../shell/server/lib/codeAgentStore.mjs";
import { MemoryRepositoryIndexStore } from "../../shell/server/lib/repositoryIndexStore.mjs";
import {
  drainRepositoryIndexRefreshes,
  requestRepositoryRefresh,
} from "../../shell/server/lib/repositoryIndexService.mjs";

test("manual repository refresh is durable, claimable, and disposes its sandbox", async () => {
  const repositories = new MemoryCodeAgentStore();
  const store = new MemoryRepositoryIndexStore();
  const repository = await repositories.createRepository("owner-a", {
    provider: "github",
    full_name: "example/repo",
    clone_url: "https://github.com/example/repo.git",
    default_branch: "main",
    private: true,
  });
  const queued = await requestRepositoryRefresh("owner-a", repository, {
    store,
    reason: "manual",
    requestedBy: "owner-a",
    kick: () => {},
  });
  assert.equal(queued.status, "queued");
  assert.equal(queued.refresh_reason, "manual");

  let disposed = false;
  const results = await drainRepositoryIndexRefreshes({
    store,
    repositories,
    runnerFactory: async () => ({
      dispose: async () => { disposed = true; },
    }),
    indexer: async ({ owner, repository: indexedRepository, store: indexStore }) => {
      await indexStore.completeIndex(owner, indexedRepository.id, {
        head_sha: "sha-1",
        file_count: 2,
        chunk_count: 3,
        indexed_bytes: 100,
        symbol_count: 4,
        relation_count: 5,
        dependency_count: 1,
        embedding_model: "text-embedding-3-small",
      });
      return indexStore.getIndex(owner, indexedRepository.id);
    },
  });
  assert.equal(results[0].status, "ready");
  assert.equal(disposed, true);
  assert.equal((await store.getIndex("owner-a", repository.id)).symbol_count, 4);
});

test("repository refresh cannot be queued across owners", async () => {
  const repositories = new MemoryCodeAgentStore();
  const repository = await repositories.createRepository("owner-a", {
    provider: "github",
    full_name: "example/repo",
    clone_url: "https://github.com/example/repo.git",
    default_branch: "main",
    private: true,
  });
  await assert.rejects(
    requestRepositoryRefresh("owner-b", repository, {
      store: new MemoryRepositoryIndexStore(),
      kick: () => {},
    }),
    /not found/i,
  );
});

test("a push received during indexing is queued for a follow-up refresh", async () => {
  const store = new MemoryRepositoryIndexStore();
  await store.beginIndex("owner-a", "repo-1", "sha-1", "text-embedding-3-small");
  store.indexes.get("repo-1").started_at = new Date(Date.now() - 5_000).toISOString();
  await store.requestRefresh("owner-a", "repo-1", {
    reason: "github_push",
    requestedHeadSha: "sha-2",
  });
  const completed = await store.completeIndex("owner-a", "repo-1", {
    head_sha: "sha-1",
    file_count: 1,
  });
  assert.equal(completed.status, "queued");
  assert.equal(completed.requested_head_sha, "sha-2");
});

test("a push received during a failed index is still queued for a follow-up refresh", async () => {
  const store = new MemoryRepositoryIndexStore();
  await store.beginIndex("owner-a", "repo-1", "sha-1", "text-embedding-3-small");
  store.indexes.get("repo-1").started_at = new Date(Date.now() - 5_000).toISOString();
  await store.requestRefresh("owner-a", "repo-1", {
    reason: "github_push",
    requestedHeadSha: "sha-2",
  });
  const failed = await store.failIndex("owner-a", "repo-1", "temporary failure");
  assert.equal(failed.status, "queued");
  assert.equal(failed.last_error, null);
  assert.equal(failed.requested_head_sha, "sha-2");
});
