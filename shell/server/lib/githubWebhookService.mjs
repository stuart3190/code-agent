import crypto from "node:crypto";
import { optionalEnv } from "./env.mjs";
import { codeAgentStore } from "./codeAgentStore.mjs";
import { getInstallation, installationRow, listInstallationRepositories } from "./githubApp.mjs";

const MAX_ATTEMPTS = 10;
const MAX_RETRY_DELAY_MS = 60 * 60_000;
const DISCONNECTED_MESSAGE = "GitHub App access to this repository was removed.";
const SUSPENDED_MESSAGE = "The GitHub App installation is suspended.";
const DELETED_MESSAGE = "The GitHub App installation was deleted.";

let timer = null;
let draining = false;
let immediateScheduled = false;

export async function acceptGithubWebhook({ deliveryId, event, payload, rawBody }, {
  store = codeAgentStore(),
} = {}) {
  const installationId = positiveInteger(payload?.installation?.id);
  const installation = installationId
    ? await store.findGithubInstallation(installationId)
    : null;
  const input = {
    delivery_id: deliveryId,
    event,
    action: payload?.action ? String(payload.action).slice(0, 100) : null,
    owner: installation?.owner || null,
    installation_id: installationId,
    payload_sha256: crypto.createHash("sha256").update(rawBody).digest("hex"),
    payload,
  };
  const accepted = await store.recordGithubWebhookDelivery(input);
  if (!accepted.isNew && accepted.delivery.payload_sha256 !== input.payload_sha256) {
    const error = new Error("GitHub delivery ID was reused with a different payload.");
    error.code = "github_delivery_conflict";
    error.status = 409;
    throw error;
  }
  kickGithubWebhookWorker();
  return accepted;
}

export function startGithubWebhookWorker() {
  if (timer || !optionalEnv("GITHUB_WEBHOOK_SECRET")) return;
  const intervalMs = boundedInteger(optionalEnv("GITHUB_WEBHOOK_POLL_MS", "1500"), 250, 60_000, 1500);
  timer = setInterval(() => {
    drainGithubWebhookDeliveries().catch(logWorkerError);
  }, intervalMs);
  timer.unref?.();
  kickGithubWebhookWorker();
}

export function stopGithubWebhookWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

export function kickGithubWebhookWorker() {
  if (immediateScheduled || !optionalEnv("GITHUB_WEBHOOK_SECRET")) return;
  immediateScheduled = true;
  setImmediate(() => {
    immediateScheduled = false;
    drainGithubWebhookDeliveries().catch(logWorkerError);
  });
}

export async function drainGithubWebhookDeliveries({
  limit = 10,
  store = codeAgentStore(),
  getInstallationFn = getInstallation,
  listRepositoriesFn = listInstallationRepositories,
} = {}) {
  if (draining) return [];
  draining = true;
  try {
    const deliveries = await store.claimGithubWebhookDeliveries(limit);
    const results = [];
    for (const delivery of deliveries) {
      try {
        const result = await processGithubWebhookDelivery(delivery, {
          store,
          getInstallationFn,
          listRepositoriesFn,
        });
        results.push(result);
      } catch (error) {
        const attempts = Number(delivery.attempts || 1);
        const delayMs = Math.min(60_000 * (2 ** Math.max(attempts - 1, 0)), MAX_RETRY_DELAY_MS);
        const failed = await store.completeGithubWebhookDelivery(delivery.delivery_id, {
          status: "failed",
          error: String(error?.message || error).slice(0, 4_000),
          next_attempt_at: attempts < MAX_ATTEMPTS
            ? new Date(Date.now() + delayMs).toISOString()
            : null,
          processed_at: null,
          result: {
            retryable: attempts < MAX_ATTEMPTS,
            attempts,
          },
        });
        results.push(failed);
      }
    }
    return results;
  } finally {
    draining = false;
  }
}

export async function processGithubWebhookDelivery(delivery, {
  store = codeAgentStore(),
  getInstallationFn = getInstallation,
  listRepositoriesFn = listInstallationRepositories,
} = {}) {
  const installationId = positiveInteger(delivery.installation_id);
  const existing = installationId
    ? await store.findGithubInstallation(installationId)
    : null;
  if (!existing) {
    return finish(store, delivery, "ignored", {
      reason: installationId ? "unclaimed_installation" : "event_without_installation",
    });
  }

  if (delivery.event === "installation") {
    if (delivery.action === "deleted") {
      await store.updateGithubInstallationLifecycle(installationId, {
        status: "deleted",
        suspended_at: null,
        deleted_at: new Date().toISOString(),
      });
      const repositories = await store.syncGithubRepositoryAccess(
        installationId,
        null,
        DELETED_MESSAGE,
      );
      return finish(store, delivery, "processed", {
        installationStatus: "deleted",
        repositories,
      });
    }
    if (delivery.action === "suspend") {
      await store.updateGithubInstallationLifecycle(installationId, {
        status: "suspended",
        suspended_at: delivery.payload?.installation?.suspended_at || new Date().toISOString(),
        deleted_at: null,
      });
      const repositories = await store.syncGithubRepositoryAccess(
        installationId,
        null,
        SUSPENDED_MESSAGE,
      );
      return finish(store, delivery, "processed", {
        installationStatus: "suspended",
        repositories,
      });
    }
    if (["created", "unsuspend", "new_permissions_accepted"].includes(delivery.action)) {
      return refreshInstallation(delivery, existing, {
        store,
        getInstallationFn,
        listRepositoriesFn,
      });
    }
    return finish(store, delivery, "ignored", { reason: "unsupported_installation_action" });
  }

  if (delivery.event === "installation_repositories"
    && ["added", "removed"].includes(delivery.action)) {
    return refreshInstallation(delivery, existing, {
      store,
      getInstallationFn,
      listRepositoriesFn,
    });
  }

  return finish(store, delivery, "ignored", { reason: "unsupported_event" });
}

async function refreshInstallation(delivery, existing, {
  store,
  getInstallationFn,
  listRepositoriesFn,
}) {
  const installationId = Number(existing.installation_id);
  const authoritative = await getInstallationFn(installationId);
  const updated = await store.updateGithubInstallationLifecycle(
    installationId,
    installationRow(existing.owner, authoritative),
  );
  if ((updated?.status || "active") !== "active") {
    const repositories = await store.syncGithubRepositoryAccess(
      installationId,
      null,
      SUSPENDED_MESSAGE,
    );
    return finish(store, delivery, "processed", {
      installationStatus: "suspended",
      repositories,
    });
  }

  const accessible = await listRepositoriesFn(installationId);
  const repositories = await store.syncGithubRepositoryAccess(
    installationId,
    accessible.map((repository) => repository.id),
    DISCONNECTED_MESSAGE,
  );
  return finish(store, delivery, "processed", {
    installationStatus: "active",
    accessibleRepositoryCount: accessible.length,
    repositories,
  });
}

function finish(store, delivery, status, result) {
  return store.completeGithubWebhookDelivery(delivery.delivery_id, {
    status,
    error: null,
    next_attempt_at: null,
    processed_at: new Date().toISOString(),
    result,
  });
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function boundedInteger(value, min, max, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? Math.min(Math.max(number, min), max) : fallback;
}

function logWorkerError(error) {
  console.error("[github-webhook] worker failed:", error?.stack || error?.message || error);
}
