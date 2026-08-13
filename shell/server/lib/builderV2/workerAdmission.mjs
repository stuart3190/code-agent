import { requireFreshWorkerPreviewProof } from "../../../../build-worker/previewIsolationPreflight.mjs";
import { serviceClient } from "../supabase.mjs";

const admissionError = (message, code) => Object.assign(new Error(message), { code });

/** Prove a compatible worker is ready before any customer state is created. */
export async function requireFreshWorkerAdmission({
  client = serviceClient(),
  jobType = "builder_pipeline",
  env = process.env,
  now = Date.now(),
  maxHeartbeatAgeMs = 30_000,
  maxProofAgeMs = 10 * 60_000,
} = {}) {
  if (env.THRALLO_BUILD_WORKER_ENABLED !== "1") {
    throw admissionError("Builder V2 requires the isolated build worker; no customer state was created.", "worker_required");
  }
  const expectedVersion = String(env.THRALLO_BUILD_WORKER_VERSION || "").trim();
  if (!expectedVersion) {
    throw admissionError("The expected Builder V2 worker release is not configured.", "worker_version_required");
  }

  const { data, error } = await client.from("build_worker_nodes")
    .select("worker_id,version,state,job_types,current_job_id,heartbeat_at,metadata");
  if (error) {
    throw admissionError(`Builder V2 worker admission could not be verified: ${error.message}`, "worker_admission_unavailable");
  }
  const capable = (data || []).filter((node) => node.state === "active"
    && node.version === expectedVersion
    && Array.isArray(node.job_types)
    && node.job_types.includes(jobType)
    && Number.isFinite(Date.parse(node.heartbeat_at))
    && now - Date.parse(node.heartbeat_at) <= maxHeartbeatAgeMs);

  if (!capable.length) {
    const freshWrongVersion = (data || []).some((node) => node.state === "active"
      && Array.isArray(node.job_types) && node.job_types.includes(jobType)
      && Number.isFinite(Date.parse(node.heartbeat_at))
      && now - Date.parse(node.heartbeat_at) <= maxHeartbeatAgeMs
      && node.version !== expectedVersion);
    throw admissionError(
      freshWrongVersion
        ? "No active Builder V2 worker matches the deployed release."
        : `No active Builder V2 worker can accept ${jobType}.`,
      freshWrongVersion ? "worker_version_mismatch" : "worker_required",
    );
  }

  if (jobType === "builder_pipeline") {
    const proof = requireFreshWorkerPreviewProof(capable, { now, maxHeartbeatAgeMs, maxProofAgeMs });
    return { ...proof, version: expectedVersion, jobType };
  }
  const node = capable.sort((left, right) => Date.parse(right.heartbeat_at) - Date.parse(left.heartbeat_at))[0];
  return { workerId: node.worker_id, heartbeatAt: node.heartbeat_at, version: expectedVersion, jobType };
}
