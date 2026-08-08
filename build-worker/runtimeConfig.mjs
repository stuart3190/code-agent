export function assertWorkerCredentialAuthority(jobTypes, env = process.env) {
  if (!(jobTypes || []).includes("builder_pipeline")) return;
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
