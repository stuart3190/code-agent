const PUBLIC_TERMINAL = new Map([
  ["complete", "green"],
  ["failed", "failed"],
  ["interrupted", "failed"],
]);
const WORK_TERMINAL = new Map([
  ["succeeded", "green"],
  ["failed", "failed"],
  ["cancelled", "failed"],
]);
const INTERNAL_TERMINAL = new Map([
  ["green", "green"],
  ["failed", "failed"],
  ["blocked", "failed"],
  ["cancelled", "failed"],
]);

const outcome = (state, terminal) => state == null ? null : terminal.get(String(state)) || "active";
const identity = (owner, id) => `${owner || ""}:${id || ""}`;

function activationBoundary(record) {
  const value = record?.value && typeof record.value === "object" ? record.value : record;
  const activatedAt = Date.parse(value?.activatedAt || "");
  if (value?.state !== "active"
      || value?.policyVersion !== "managed_recovery_v1"
      || !/^[0-9a-f]{40}$/i.test(String(value?.deploymentCommit || ""))
      || !/^[0-9a-f]{64}$/i.test(String(value?.deploymentManifestSha256 || ""))
      || !Number.isFinite(activatedAt)) {
    throw Object.assign(new Error("Builder V2 terminal consistency requires the immutable managed recovery activation record."), {
      code: "bv2_recovery_activation_required",
    });
  }
  return { value, activatedAt };
}

function mismatchRecord(publicBuild, workJob, internalBuild, reason) {
  return {
    public_build_id: publicBuild.id,
    work_job_id: workJob?.id || publicBuild.work_job_id || null,
    internal_build_id: internalBuild?.id || publicBuild.bv2_build_id || null,
    public_state: publicBuild.status,
    work_state: workJob?.state || "missing",
    internal_state: internalBuild?.state || "none",
    work_finished_at: workJob?.finished_at || null,
    reason,
  };
}

function rowMismatch(publicBuild, workJob, internalBuild) {
  if (!workJob || String(workJob.build_id || "") !== String(publicBuild.id)
      || String(workJob.owner || "") !== String(publicBuild.owner || "")) {
    return { kind: "active", reason: "work_identity_missing_or_mismatched" };
  }

  const states = [
    outcome(publicBuild.status, PUBLIC_TERMINAL),
    outcome(workJob.state, WORK_TERMINAL),
    outcome(internalBuild?.state, INTERNAL_TERMINAL),
  ].filter(Boolean);
  const active = states.includes("active");
  const terminal = states.filter((state) => state !== "active");

  if (active) {
    return terminal.length || new Set(states).size > 1
      ? { kind: "active", reason: "active_and_terminal_state_disagree" }
      : null;
  }
  if (new Set(terminal).size > 1) {
    return { kind: "terminal", reason: "terminal_outcomes_disagree" };
  }
  return null;
}

export function classifyBv2TerminalConsistency({ activation, publicBuilds = [], workJobs = [], internalBuilds = [] } = {}) {
  const boundary = activationBoundary(activation);
  const workById = new Map(workJobs.map((row) => [identity(row.owner, row.id), row]));
  const internalById = new Map(internalBuilds.map((row) => [identity(row.owner, row.id), row]));
  const historical = [];
  const postActivation = [];
  const active = [];
  let compared = 0;

  for (const publicBuild of publicBuilds) {
    if (!publicBuild?.work_job_id) continue;
    compared += 1;
    const workJob = workById.get(identity(publicBuild.owner, publicBuild.work_job_id));
    const internalBuild = publicBuild.bv2_build_id
      ? internalById.get(identity(publicBuild.owner, publicBuild.bv2_build_id)) : null;
    const mismatch = rowMismatch(publicBuild, workJob, internalBuild);
    if (!mismatch) continue;
    const record = mismatchRecord(publicBuild, workJob, internalBuild, mismatch.reason);
    if (mismatch.kind === "active") {
      active.push(record);
      continue;
    }
    const finishedAt = Date.parse(workJob?.finished_at || "");
    if (Number.isFinite(finishedAt) && finishedAt < boundary.activatedAt) historical.push(record);
    else postActivation.push(record);
  }

  return {
    activation: {
      policy_version: boundary.value.policyVersion,
      activated_at: new Date(boundary.activatedAt).toISOString(),
      deployment_commit: boundary.value.deploymentCommit,
      deployment_manifest_sha256: boundary.value.deploymentManifestSha256,
    },
    compared_records: compared,
    historical_inconsistencies: historical.length,
    post_activation_inconsistencies: postActivation.length,
    active_inconsistencies: active.length,
    forward_runtime_consistent: postActivation.length === 0 && active.length === 0,
    historical_records: historical,
    post_activation_records: postActivation,
    active_records: active,
  };
}

async function readAll(client, table, columns, filters, pageSize) {
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    let query = client.from(table).select(columns);
    for (const [column, value] of filters) query = query.eq(column, value);
    const { data, error } = await query.range(from, from + pageSize - 1);
    if (error) throw new Error(`Builder V2 terminal consistency read failed for ${table}: ${error.message}`);
    rows.push(...(data || []));
    if ((data || []).length < pageSize) return rows;
  }
}

export async function readBv2TerminalConsistencyEvidence(client, { pageSize = 1_000 } = {}) {
  const { data: activation, error: activationError } = await client.from("bv2_feature_flags")
    .select("value").eq("key", "recovery.funding_policy").maybeSingle();
  if (activationError) throw new Error(`Builder V2 recovery activation read failed: ${activationError.message}`);

  const [publicBuilds, workJobs, internalBuilds] = await Promise.all([
    readAll(client, "build_jobs",
      "id,owner,work_job_id,bv2_build_id,status,created_at,updated_at", [["pipeline_version", "v2"]], pageSize),
    readAll(client, "build_work_jobs",
      "id,owner,build_id,state,created_at,updated_at,finished_at", [["job_type", "builder_pipeline"]], pageSize),
    readAll(client, "bv2_builds", "id,owner,state,started_at,finished_at", [], pageSize),
  ]);
  return { activation, publicBuilds, workJobs, internalBuilds };
}

export async function proveBv2TerminalConsistency({ client, pageSize } = {}) {
  if (!client) throw new Error("Builder V2 terminal consistency requires a Supabase service client.");
  return classifyBv2TerminalConsistency(await readBv2TerminalConsistencyEvidence(client, { pageSize }));
}
