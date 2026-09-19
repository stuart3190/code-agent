import crypto from "node:crypto";

import { workerPreviewConfiguration } from "./runtimeConfig.mjs";
import { PREVIEW_ISOLATION_PROOF_MAX_AGE_MS } from "./previewIsolationPolicy.mjs";

const MARKER = "thrallo-isolated-preview-preflight";
// provisiond may legitimately wait up to 240 seconds for a newly-created Vite preview. The
// worker must not abandon the HTTP request after 15 seconds while provisiond continues working;
// doing so lets scheduled retries overlap server-side work that the controller can no longer see.
export const PREVIEW_ISOLATION_START_TIMEOUT_MS = 255_000;

export function resolvePreviewIsolationRunId({ configured = "", nodeIdentity = "" } = {}) {
  const explicit = String(configured || "").trim().toLowerCase();
  if (explicit) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(explicit)) {
      throw Object.assign(new Error("THRALLO_PREVIEW_ISOLATION_RUN_ID must be a DNS-safe stable identifier."), {
        code: "preview_isolation_identity_invalid",
      });
    }
    return explicit;
  }
  const digest = crypto.createHash("sha256")
    .update(`thrallo-preview-isolation:${String(nodeIdentity || "worker")}`)
    .digest("hex").slice(0, 32);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-`
    + `${digest.slice(16, 20)}-${digest.slice(20)}`;
}

function isolationError(message, cause = null) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), {
    code: "preview_isolation_required",
  });
}

function expectedPreviewId(projectId) {
  const slug = String(projectId).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 48);
  return `p${slug || "x"}`;
}

const SMOKE_TREE = Object.freeze({
  "index.html": "<!doctype html><html><body><main id=\"proof\">thrallo-isolated-preview-preflight</main></body></html>",
});

export async function proveWorkerPreviewIsolation({
  env = process.env,
  preview,
  fetchImpl = fetch,
  randomUUID = crypto.randomUUID,
  now = Date.now,
} = {}) {
  const config = workerPreviewConfiguration(env);
  if (!preview || preview.mode !== "vps") {
    throw isolationError(`Worker preview provider resolved to ${preview?.mode || "unknown"}, not vps.`);
  }

  const healthUrl = new URL("/health", `${config.provisiondOrigin}/`).href;
  let health;
  try {
    const response = await fetchImpl(healthUrl, { signal: AbortSignal.timeout(10_000) });
    health = await response.json();
    if (!response.ok || health?.ok !== true || !Number.isFinite(Number(health.capacity))) {
      throw new Error(`unexpected health response (${response.status})`);
    }
  } catch (error) {
    throw isolationError(`Isolated provisioner is unreachable: ${error.message}`, error);
  }

  const projectId = `worker-preflight-${randomUUID()}`;
  const expectedId = expectedPreviewId(projectId);
  let created = null;
  let primaryError = null;
  let destroyed = null;
  let absentAfterDestroy = false;
  try {
    created = await preview.start(projectId, SMOKE_TREE, {
      signal: AbortSignal.timeout(PREVIEW_ISOLATION_START_TIMEOUT_MS),
    });
    if (created?.mode !== "vps" || created?.id !== expectedId || !created?.url) {
      throw isolationError("Provisiond returned an unexpected isolated preview identity or mode.");
    }
    const publicUrl = new URL(created.url);
    if (!["http:", "https:"].includes(publicUrl.protocol) || publicUrl.hostname.split(".")[0] !== expectedId) {
      throw isolationError("Provisiond returned an invalid isolated preview URL.");
    }
    const observed = await preview.get(projectId, { signal: AbortSignal.timeout(15_000) });
    if (observed?.mode !== "vps" || observed?.url !== created.url) {
      throw isolationError("Provisiond did not return the created preview through the worker lookup path.");
    }
    const response = await fetchImpl(created.url, { signal: AbortSignal.timeout(15_000) });
    const body = await response.text();
    if (!response.ok || !body.includes(MARKER)) {
      throw isolationError(`Isolated preview marker was not served (${response.status}).`);
    }
  } catch (error) {
    primaryError = error.code === "preview_isolation_required"
      ? error : isolationError(`Disposable isolated preview failed: ${error.message}`, error);
  } finally {
    try {
      destroyed = await preview.stop(projectId, { signal: AbortSignal.timeout(15_000) });
      absentAfterDestroy = (await preview.get(projectId, { signal: AbortSignal.timeout(15_000) })) === null;
    } catch (error) {
      if (!primaryError) primaryError = isolationError(`Disposable isolated preview teardown failed: ${error.message}`, error);
    }
  }
  if (!destroyed?.stopped || !absentAfterDestroy) {
    primaryError ||= isolationError("Disposable isolated preview was not torn down cleanly.");
  }
  if (primaryError) throw primaryError;

  return {
    status: "passed",
    checkedAt: new Date(now()).toISOString(),
    resolvedMode: config.mode,
    provisiondOrigin: config.provisiondOrigin,
    health: { reachable: true, capacity: Number(health.capacity) },
    preview: { projectId, id: created.id, url: created.url, mode: created.mode, markerMatched: true },
    teardown: { stopped: true, absent: true },
  };
}

export function requireFreshWorkerPreviewProof(nodes, {
  now = Date.now(), maxHeartbeatAgeMs = 30_000, maxProofAgeMs = PREVIEW_ISOLATION_PROOF_MAX_AGE_MS,
} = {}) {
  const candidates = (nodes || []).filter((node) => Array.isArray(node.job_types)
    && (node.job_types.includes("builder_pipeline")
      || node.metadata?.configuredJobTypes?.includes("builder_pipeline"))
    && ["active", "draining"].includes(node.state)
    && Number.isFinite(Date.parse(node.heartbeat_at))
    && now - Date.parse(node.heartbeat_at) <= maxHeartbeatAgeMs);
  const passing = candidates.filter((node) => {
    const proof = node?.metadata?.previewIsolation;
    return proof?.status === "passed" && proof.resolvedMode === "vps"
      && Number.isFinite(Date.parse(proof.checkedAt)) && now - Date.parse(proof.checkedAt) <= maxProofAgeMs
      && proof.health?.reachable === true && proof.preview?.mode === "vps"
      && proof.preview?.markerMatched === true && proof.teardown?.stopped === true
      && proof.teardown?.absent === true;
  }).sort((left, right) => Date.parse(right.heartbeat_at) - Date.parse(left.heartbeat_at));
  const node = passing[0];
  const proof = node?.metadata?.previewIsolation;
  if (!node) {
    const failed = candidates.filter((candidate) => candidate.metadata?.previewIsolation?.status === "failed")
      .sort((left, right) => Date.parse(right.metadata.previewIsolation.checkedAt || right.heartbeat_at)
        - Date.parse(left.metadata.previewIsolation.checkedAt || left.heartbeat_at))[0];
    if (failed) {
      const failure = failed.metadata.previewIsolation;
      if (failure.code && failure.code !== "preview_isolation_required") {
        throw Object.assign(new Error(
          `Builder V2 worker readiness failed on ${failed.worker_id}: ${failure.message}`,
          { cause: Object.assign(new Error(failure.message), { code: failure.code }) },
        ), { code: failure.code });
      }
      throw isolationError(`Builder V2 isolated-preview preflight failed on ${failed.worker_id}: ${failure.message}`,
        Object.assign(new Error(failure.message), { code: failure.code }));
    }
    throw isolationError("No fresh production Builder V2 worker has a passing isolated-preview preflight.");
  }
  return { workerId: node.worker_id, heartbeatAt: node.heartbeat_at, ...proof };
}
