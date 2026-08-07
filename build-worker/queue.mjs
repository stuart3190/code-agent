export function createWorkerQueue(client) {
  const rpc = async (name, args) => {
    const { data, error } = await client.rpc(name, args);
    if (error) throw new Error(`${name}: ${error.message}`);
    return Array.isArray(data) ? data[0] : data;
  };
  return {
    async nodeState(workerId) {
      const { data, error } = await client.from("build_worker_nodes").select("state").eq("worker_id", workerId).maybeSingle();
      if (error) throw new Error(`worker node state: ${error.message}`);
      return data?.state || null;
    },
    async lease(workerId, jobTypes, leaseSeconds) {
      const { data, error } = await client.rpc("build_work_lease", {
        p_worker_id: workerId, p_job_types: jobTypes, p_lease_seconds: leaseSeconds,
      });
      if (error) throw new Error(`build_work_lease: ${error.message}`);
      return Array.isArray(data) ? (data[0] || null) : (data || null);
    },
    start: (job, workerId) => rpc("build_work_start", {
      p_job_id: job.id, p_worker_id: workerId, p_lease_token: job.lease_token,
    }),
    heartbeat: (job, workerId, leaseSeconds, details = {}) => rpc("build_work_heartbeat", {
      p_job_id: job.id, p_worker_id: workerId, p_lease_token: job.lease_token,
      p_lease_seconds: leaseSeconds, p_details: details,
    }),
    event: (job, workerId, eventType, details = {}) => rpc("build_work_event", {
      p_job_id: job.id, p_worker_id: workerId, p_lease_token: job.lease_token,
      p_event_type: eventType, p_details: details,
    }),
    complete: (job, workerId, result) => rpc("build_work_complete", {
      p_job_id: job.id, p_worker_id: workerId, p_lease_token: job.lease_token,
      p_completion_key: result.completionKey,
      p_result: result.result || {}, p_artifact_ref: result.artifactRef || null,
      p_exit_code: result.exitCode ?? 0,
      p_stdout_tail: String(result.stdout || "").slice(-65536),
      p_stderr_tail: String(result.stderr || "").slice(-65536),
    }),
    fail: (job, workerId, error) => rpc("build_work_fail", {
      p_job_id: job.id, p_worker_id: workerId, p_lease_token: job.lease_token,
      p_error_classification: error.classification || error.code || "worker_error",
      p_error: String(error.message || error).slice(0, 4000),
      p_retryable: error.retryable === true,
      p_event_type: ["timeout", "resource_limit", "worker_crash"].includes(error.classification)
        ? error.classification : "failed",
    }),
    nodeHeartbeat: (workerId, version, state, jobTypes, currentJobId, metadata = {}) =>
      rpc("build_worker_heartbeat", {
        p_worker_id: workerId, p_version: version, p_state: state,
        p_job_types: jobTypes, p_current_job_id: currentJobId, p_metadata: metadata,
      }),
  };
}
