function previewIsolationError(message) {
  return Object.assign(new Error(message), { code: "preview_isolation_required" });
}

function connectedRecoveryAuthorityError(message) {
  return Object.assign(new Error(message), {
    code: "recovery_provider_unavailable",
    classification: "platform",
    retryable: true,
    dispatchState: "before_dispatch",
  });
}

export const SUPPORTED_BUILD_JOB_TYPES = Object.freeze([
  "builder_pipeline", "dependency_install", "compile", "browser_verify", "qa_browser",
  "image_optimise", "publish_package", "proof_slow",
]);

export function resolveWorkerJobTypes(value = process.env.THRALLO_BUILD_JOB_TYPES) {
  const requested = String(value || SUPPORTED_BUILD_JOB_TYPES.join(","))
    .split(",").map((jobType) => jobType.trim()).filter(Boolean);
  const unique = [...new Set(requested)];
  if (!unique.length) {
    throw Object.assign(new Error("The build worker must advertise at least one supported job type."), {
      code: "worker_job_types_required",
    });
  }
  const unsupported = unique.filter((jobType) => !SUPPORTED_BUILD_JOB_TYPES.includes(jobType));
  if (unsupported.length) {
    throw Object.assign(new Error(`Unsupported build worker job type(s): ${unsupported.join(", ")}.`), {
      code: "unsupported_worker_job_type",
    });
  }
  return unique;
}

export function workerPreviewConfiguration(env = process.env) {
  const mode = String(env.PREVIEW_MODE || "local").trim().toLowerCase();
  if (mode !== "vps") {
    throw previewIsolationError(
      `Builder V2 production preview requires the isolated provisioner; PREVIEW_MODE resolved to ${mode || "unknown"}.`,
    );
  }
  if (!String(env.PROVISIOND_TOKEN || "").trim()) {
    throw previewIsolationError("Builder V2 isolated preview requires PROVISIOND_TOKEN.");
  }
  let url;
  try { url = new URL(String(env.PROVISIOND_URL || "")); }
  catch { throw previewIsolationError("Builder V2 isolated preview requires a valid PROVISIOND_URL."); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password
      || url.search || url.hash || !["", "/"].includes(url.pathname)) {
    throw previewIsolationError("Builder V2 isolated preview requires a valid HTTP(S) PROVISIOND_URL origin.");
  }
  return { mode, provisiondOrigin: url.origin };
}

/**
 * Builder V2 correction and repair use an internal owner's encrypted connected-Codex authority.
 * This synchronous startup proof validates only the private server-side identity selector; the
 * worker readiness proof separately resolves that owner's stored Codex credential without a
 * provider call. Neither the selector nor credential is passed to a sandbox or browser.
 */
export function workerConnectedRecoveryConfiguration(env = process.env) {
  const ownerId = String(env.THRALLO_BV2_RECOVERY_OWNER_ID || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ownerId)) {
    throw connectedRecoveryAuthorityError(
      "Builder V2 platform Codex recovery identity is unavailable; no customer state was created.",
    );
  }
  return Object.freeze({
    available: true,
    provider: "codex",
    billingLane: "connected_allowance",
    fundingPool: "thrallo_recovery",
    policyVersion: "owner_connected_recovery_v1",
  });
}

export function assertWorkerCredentialAuthority(jobTypes, env = process.env) {
  if (!(jobTypes || []).includes("builder_pipeline")) return;
  workerPreviewConfiguration(env);
  if (String(env.CODE_AGENT_STORE || "").toLowerCase() !== "supabase") {
    throw Object.assign(new Error(
      "Builder pipeline workers require CODE_AGENT_STORE=supabase; refusing the process-local credential store.",
    ), { code: "worker_credential_store_required" });
  }
  if (!(env.PLATFORM_ENC_KEY || env.BYOK_ENC_KEY)) {
    throw Object.assign(new Error(
      "Builder pipeline workers require the platform credential encryption key.",
    ), { code: "worker_credential_key_required" });
  }
  return workerConnectedRecoveryConfiguration(env);
}
