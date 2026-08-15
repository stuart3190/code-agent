import {
  PREVIEW_ISOLATION_PROOF_MAX_AGE_MS,
  jitteredPreviewIsolationDelay,
} from "./previewIsolationPolicy.mjs";

const cleanMessage = (error) => String(error?.message || error || "preview isolation preflight failed")
  .replace(/[\r\n\t]+/g, " ").trim().slice(0, 1_000);

export function failedPreviewIsolationProof(error, { now = Date.now } = {}) {
  return Object.freeze({
    status: "failed",
    checkedAt: new Date(now()).toISOString(),
    code: String(error?.code || "preview_isolation_required").slice(0, 120),
    message: cleanMessage(error),
  });
}

export function previewIsolationProofReady(proof, {
  now = Date.now(), maxProofAgeMs = PREVIEW_ISOLATION_PROOF_MAX_AGE_MS,
} = {}) {
  return proof?.status === "passed"
    && Number.isFinite(Date.parse(proof.checkedAt))
    && now - Date.parse(proof.checkedAt) <= maxProofAgeMs;
}

export function readinessJobTypes(configuredJobTypes, proof, options = {}) {
  const configured = [...new Set(configuredJobTypes || [])];
  if (!configured.includes("builder_pipeline") || previewIsolationProofReady(proof, options)) return configured;
  return configured.filter((jobType) => jobType !== "builder_pipeline");
}

/**
 * One controller is created per worker process. It never overlaps its own preflights, publishes
 * every transition through the caller's atomic worker-heartbeat seam, and continues retrying
 * after a failure without terminating or cancelling in-flight customer work.
 */
export function createPreviewIsolationReadiness({
  enabled,
  prove,
  publish,
  refreshMs,
  retryMs,
  jitterMs = 0,
  maxProofAgeMs = PREVIEW_ISOLATION_PROOF_MAX_AGE_MS,
  now = Date.now,
  random = Math.random,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onEvent = () => {},
} = {}) {
  if (enabled && (typeof prove !== "function" || typeof publish !== "function")) {
    throw new TypeError("preview-isolation readiness requires prove and publish functions");
  }
  let proof = Object.freeze(enabled
    ? { status: "pending", checkedAt: null }
    : { status: "not_required", checkedAt: new Date(now()).toISOString() });
  let timer = null;
  let inFlight = null;
  let stopped = false;

  const emit = (event) => {
    try { onEvent(event); } catch {}
  };
  const schedule = (baseMs, delayJitterMs = jitterMs) => {
    if (stopped || !enabled) return;
    if (timer) clearTimer(timer);
    const delayMs = jitteredPreviewIsolationDelay(baseMs, delayJitterMs, random);
    timer = setTimer(async () => {
      timer = null;
      try {
        await refresh("scheduled");
      } catch (error) {
        emit({ event: "worker_preview_isolation_publish_failed", code: error?.code || "worker_heartbeat_failed",
          message: cleanMessage(error) });
      }
    }, delayMs);
    timer?.unref?.();
    emit({ event: "worker_preview_isolation_scheduled", delayMs, status: proof.status });
  };

  const refresh = async (reason = "manual") => {
    if (!enabled || stopped) return proof;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      let next;
      try {
        next = await prove();
        if (next?.status !== "passed" || !Number.isFinite(Date.parse(next.checkedAt))) {
          throw Object.assign(new Error("preview isolation preflight returned an invalid passing proof"), {
            code: "preview_isolation_invalid_proof",
          });
        }
      } catch (error) {
        next = failedPreviewIsolationProof(error, { now });
      }
      proof = Object.freeze({ ...next });
      emit({ event: "worker_preview_isolation_preflight", reason, ...proof });
      try {
        await publish(proof);
      } finally {
        // Jitter spreads healthy workers across the refresh window. It must not be symmetric on
        // the short failure retry: with retryMs=jitterMs=30s that previously collapsed to a one-
        // second retry and amplified a slow provisiond request into a failure storm.
        schedule(proof.status === "passed" ? refreshMs : retryMs,
          proof.status === "passed" ? jitterMs : 0);
      }
      return proof;
    })().finally(() => { inFlight = null; });
    return inFlight;
  };

  return Object.freeze({
    async start() {
      if (!enabled) {
        await publish?.(proof);
        return proof;
      }
      try {
        await publish(proof);
      } catch (error) {
        emit({ event: "worker_preview_isolation_publish_failed", reason: "startup_pending",
          code: error?.code || "worker_heartbeat_failed", message: cleanMessage(error) });
      }
      return refresh("startup");
    },
    refresh,
    snapshot: () => proof,
    isReady: () => previewIsolationProofReady(proof, { now: now(), maxProofAgeMs }),
    jobTypes: (configuredJobTypes) => readinessJobTypes(configuredJobTypes, proof, {
      now: now(), maxProofAgeMs,
    }),
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
    },
  });
}
