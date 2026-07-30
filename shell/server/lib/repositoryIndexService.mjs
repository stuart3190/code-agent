import { optionalEnv } from "./env.mjs";
import { codeAgentStore } from "./codeAgentStore.mjs";
import { createDaytonaIndexRunner, daytonaConfigured } from "./daytonaRunner.mjs";
import { indexRepository } from "./repositoryIndexer.mjs";
import { repositoryIndexStore } from "./repositoryIndexStore.mjs";

let timer = null;
let draining = false;
let immediateScheduled = false;

export async function requestRepositoryRefresh(owner, repository, {
  reason = "manual",
  requestedBy = null,
  requestedHeadSha = null,
  store = repositoryIndexStore(),
  kick = kickRepositoryIndexWorker,
} = {}) {
  if (!repository || repository.owner !== owner) {
    const error = new Error("Repository not found.");
    error.code = "repository_not_found";
    error.status = 404;
    throw error;
  }
  if (repository.status !== "ready") {
    const error = new Error(repository.last_error || "Repository access is unavailable.");
    error.code = "repository_unavailable";
    error.status = 409;
    throw error;
  }
  const queued = await store.requestRefresh(owner, repository.id, {
    reason,
    requestedBy,
    requestedHeadSha,
  });
  kick();
  return queued;
}

export function startRepositoryIndexWorker() {
  if (timer || optionalEnv("CODE_AGENT_WORKER", "on").toLowerCase() === "off") return;
  const interval = Math.min(Math.max(Number(optionalEnv("CODE_AGENT_INDEX_POLL_MS", "2500")) || 2500, 500), 60_000);
  timer = setInterval(() => drainRepositoryIndexRefreshes().catch(logError), interval);
  timer.unref?.();
  kickRepositoryIndexWorker();
}

export function stopRepositoryIndexWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

export function kickRepositoryIndexWorker() {
  if (immediateScheduled || !daytonaConfigured()) return;
  immediateScheduled = true;
  setImmediate(() => {
    immediateScheduled = false;
    drainRepositoryIndexRefreshes().catch(logError);
  });
}

export async function drainRepositoryIndexRefreshes({
  limit = 1,
  store = repositoryIndexStore(),
  repositories = codeAgentStore(),
  runnerFactory = createDaytonaIndexRunner,
  indexer = indexRepository,
} = {}) {
  if (draining) return [];
  draining = true;
  try {
    const jobs = await store.claimRefreshes(limit);
    const results = [];
    for (const job of jobs) {
      let runner = null;
      try {
        const repository = await repositories.getRepository(job.owner, job.repository_id);
        if (!repository || repository.status !== "ready") {
          throw new Error(repository?.last_error || "Repository access is unavailable.");
        }
        runner = await runnerFactory({
          repository,
          emit: async () => {},
        });
        const result = await indexer({
          owner: job.owner,
          repository,
          runner,
          store,
          emit: async () => {},
        });
        results.push(result);
      } catch (error) {
        await store.failIndex(job.owner, job.repository_id, error.message).catch(() => {});
        results.push({ repository_id: job.repository_id, status: "error", error: error.message });
      } finally {
        if (runner?.dispose) await runner.dispose().catch(() => {});
      }
    }
    return results;
  } finally {
    draining = false;
  }
}

function logError(error) {
  console.error("[repository-index] worker failed:", error?.stack || error?.message || error);
}
