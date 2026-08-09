function previewIsolationError(message) {
  return Object.assign(new Error(message), { code: "preview_isolation_required" });
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
}
