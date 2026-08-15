import { readDeploymentIdentity } from "../deploymentIdentity.mjs";

function releaseError(message, cause = null) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), {
    code: "worker_release_identity_required",
  });
}

/**
 * Production has one version authority: the validated deployment manifest in the active release.
 * The legacy private-env value remains readable for drift telemetry and local development only;
 * it can never override a durable production manifest.
 */
export async function resolveWorkerReleaseIdentity({
  env = process.env,
  readIdentity = readDeploymentIdentity,
  requireManifest = String(env.CODE_AGENT_STORE || "").toLowerCase() === "supabase",
} = {}) {
  const configuredVersion = String(env.THRALLO_BUILD_WORKER_VERSION || "").trim() || null;
  let manifest;
  try {
    manifest = await readIdentity();
  } catch (error) {
    if (requireManifest) {
      throw releaseError(`The durable Builder V2 release manifest is unavailable: ${error.message}`, error);
    }
  }
  if (manifest) {
    return Object.freeze({
      version: manifest.gitCommit,
      source: "deployment_manifest",
      manifestSha256: manifest.manifestSha256,
      configuredVersion,
      configuredVersionDrift: !!configuredVersion && configuredVersion !== manifest.gitCommit,
    });
  }
  return Object.freeze({
    version: configuredVersion || "c7/1",
    source: configuredVersion ? "development_environment" : "development_default",
    manifestSha256: null,
    configuredVersion,
    configuredVersionDrift: false,
  });
}
