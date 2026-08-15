import { requireFreshWorkerPreviewProof } from "../../../../build-worker/previewIsolationPreflight.mjs";
import { PREVIEW_ISOLATION_PROOF_MAX_AGE_MS } from "../../../../build-worker/previewIsolationPolicy.mjs";
import { serviceClient } from "../supabase.mjs";
import { resolveWorkerReleaseIdentity } from "./workerReleaseIdentity.mjs";

const admissionError = (message, code) => Object.assign(new Error(message), { code });

/** Prove a compatible worker is ready before any customer state is created. */
export async function requireFreshWorkerAdmission({
  client = serviceClient(),
  jobType = "builder_pipeline",
  env = process.env,
  expectedVersion = null,
  releaseIdentityResolver = resolveWorkerReleaseIdentity,
  now = Date.now(),
  maxHeartbeatAgeMs = 30_000,
  maxProofAgeMs = PREVIEW_ISOLATION_PROOF_MAX_AGE_MS,
} = {}) {
  if (env.THRALLO_BUILD_WORKER_ENABLED !== "1") {
    throw admissionError("Builder V2 requires the isolated build worker; no customer state was created.", "worker_required");
  }
  let release;
  try {
    release = expectedVersion ? { version: expectedVersion, source: "explicit" }
      : await releaseIdentityResolver({ env });
  } catch (error) {
    throw admissionError(error.message, error.code || "worker_version_required");
  }
  const deployedVersion = String(release.version || "").trim();
  if (!deployedVersion) throw admissionError("The expected Builder V2 worker release is not configured.", "worker_version_required");

  const { data, error } = await client.from("build_worker_nodes")
    .select("worker_id,version,state,job_types,current_job_id,heartbeat_at,metadata");
  if (error) {
    throw admissionError(`Builder V2 worker admission could not be verified: ${error.message}`, "worker_admission_unavailable");
  }
  const releaseCompatible = (data || []).filter((node) => node.state === "active"
    && node.version === deployedVersion
    && Number.isFinite(Date.parse(node.heartbeat_at))
    && now - Date.parse(node.heartbeat_at) <= maxHeartbeatAgeMs);
  const capable = releaseCompatible.filter((node) => Array.isArray(node.job_types)
    && node.job_types.includes(jobType));

  if (!releaseCompatible.length) {
    const freshWrongVersion = (data || []).some((node) => node.state === "active"
      && (node.job_types?.includes(jobType) || node.metadata?.configuredJobTypes?.includes(jobType))
      && Number.isFinite(Date.parse(node.heartbeat_at))
      && now - Date.parse(node.heartbeat_at) <= maxHeartbeatAgeMs
      && node.version !== deployedVersion);
    throw admissionError(
      freshWrongVersion
        ? "No active Builder V2 worker matches the deployed release."
        : `No active Builder V2 worker can accept ${jobType}.`,
      freshWrongVersion ? "worker_version_mismatch" : "worker_required",
    );
  }

  if (jobType === "builder_pipeline") {
    const configured = releaseCompatible.filter((node) => node.job_types?.includes(jobType)
      || node.metadata?.configuredJobTypes?.includes(jobType));
    if (!configured.length) {
      throw admissionError(`No active Builder V2 worker can accept ${jobType}.`, "worker_required");
    }
    const proof = requireFreshWorkerPreviewProof(configured, { now, maxHeartbeatAgeMs, maxProofAgeMs });
    return { ...proof, version: deployedVersion, jobType, releaseIdentitySource: release.source };
  }
  if (!capable.length) {
    throw admissionError(`No active Builder V2 worker can accept ${jobType}.`, "worker_required");
  }
  const node = capable.sort((left, right) => Date.parse(right.heartbeat_at) - Date.parse(left.heartbeat_at))[0];
  return { workerId: node.worker_id, heartbeatAt: node.heartbeat_at, version: deployedVersion,
    jobType, releaseIdentitySource: release.source };
}
