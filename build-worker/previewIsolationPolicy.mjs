function policyError(message) {
  return Object.assign(new Error(message), { code: "preview_isolation_refresh_invalid" });
}

export const PREVIEW_ISOLATION_PROOF_MAX_AGE_MS = 10 * 60_000;
export const PREVIEW_ISOLATION_REFRESH_MS = 4 * 60_000;
export const PREVIEW_ISOLATION_RETRY_MS = 30_000;
export const PREVIEW_ISOLATION_REFRESH_JITTER_MS = 30_000;

function integer(env, name, fallback, { min, max }) {
  const raw = env?.[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw policyError(`${name} must be an integer between ${min} and ${max} milliseconds.`);
  }
  return value;
}

/**
 * Keep refresh comfortably inside the admission window. The proof itself is bounded separately,
 * so even the latest jittered start leaves minutes for one failed attempt and an automatic retry.
 */
export function resolvePreviewIsolationRefreshPolicy(env = process.env) {
  const maxProofAgeMs = PREVIEW_ISOLATION_PROOF_MAX_AGE_MS;
  const refreshMs = integer(env, "THRALLO_PREVIEW_ISOLATION_REFRESH_MS", PREVIEW_ISOLATION_REFRESH_MS, {
    min: 60_000, max: maxProofAgeMs - 3 * 60_000,
  });
  const retryMs = integer(env, "THRALLO_PREVIEW_ISOLATION_RETRY_MS", PREVIEW_ISOLATION_RETRY_MS, {
    min: 5_000, max: refreshMs,
  });
  const jitterMs = integer(env, "THRALLO_PREVIEW_ISOLATION_REFRESH_JITTER_MS",
    PREVIEW_ISOLATION_REFRESH_JITTER_MS, { min: 0, max: 60_000 });
  if (refreshMs + jitterMs > maxProofAgeMs - 2 * 60_000) {
    throw policyError("Preview-isolation refresh plus jitter must leave at least two minutes before proof expiry.");
  }
  return Object.freeze({ maxProofAgeMs, refreshMs, retryMs, jitterMs });
}

export function jitteredPreviewIsolationDelay(baseMs, jitterMs, random = Math.random) {
  if (!jitterMs) return baseMs;
  const sample = Math.max(0, Math.min(1, Number(random()) || 0));
  return Math.max(1_000, Math.round(baseMs + ((sample * 2) - 1) * jitterMs));
}
