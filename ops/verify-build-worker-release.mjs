#!/usr/bin/env node

// Post-restart, zero-model release gate. It reads the validated deployment manifest through the
// same resolver as production admission, then requires a fresh compatible worker proof. It never
// creates a project, queue job, reservation or provider request.

import { loadEnv } from "../shell/server/lib/env.mjs";
import { serviceClient } from "../shell/server/lib/supabase.mjs";
import { requireFreshWorkerAdmission } from "../shell/server/lib/builderV2/workerAdmission.mjs";
import { resolveWorkerReleaseIdentity } from "../shell/server/lib/builderV2/workerReleaseIdentity.mjs";

loadEnv();
const release = await resolveWorkerReleaseIdentity();
const client = serviceClient();
const admission = await requireFreshWorkerAdmission({ client });
const { data: nodes, error } = await client.from("build_worker_nodes")
  .select("worker_id,version,state,current_job_id,heartbeat_at,job_types,metadata")
  .in("state", ["active", "paused", "draining"]);
if (error) throw error;
const matching = (nodes || []).filter((node) => node.state === "active"
  && node.version === release.version && node.job_types?.includes("builder_pipeline"));
if (!matching.some((node) => node.worker_id === admission.workerId)) {
  throw new Error("admitted Builder V2 worker is not an active manifest-compatible registration");
}
console.log(JSON.stringify({
  ok: true,
  zeroModel: true,
  deployedVersion: release.version,
  manifestSha256: release.manifestSha256,
  configuredVersionDrift: release.configuredVersionDrift,
  workerId: admission.workerId,
  heartbeatAt: admission.heartbeatAt,
  previewCheckedAt: admission.checkedAt,
  managedRecoveryAuthorityAvailable: true,
  jobTypes: matching.find((node) => node.worker_id === admission.workerId)?.job_types || [],
}));
