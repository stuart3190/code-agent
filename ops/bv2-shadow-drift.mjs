// Complete Builder V2 shadow proof. For every project explicitly in shadow state, compare the
// current in-memory index with the exact immutable revision set pinned by its latest shadow run.
// Every check is appended to bv2_shadow_checks. Exit 0 means full equivalence; any missing run,
// stale run, incomplete revision or graph/query mismatch exits 1 and never affects Builder V1.

import { pathToFileURL } from "node:url";
import { serviceClient } from "../shell/server/lib/supabase.mjs";
import { recordShadowCheck } from "../shell/server/lib/builderV2/supabaseTwins.mjs";
import { validateShadowRun } from "../shell/server/lib/builderV2/shadow.mjs";
import { INDEXER_VERSION } from "../shell/server/lib/builderV2/indexer.mjs";

export const SHADOW_VALIDATOR_VERSION = "full-graph-v1";

function projectKey(owner, projectId) {
  return `${owner}:${projectId}`;
}

function validWindowStart(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export async function runShadowDriftCheck({
  client = serviceClient(),
  now = Date.now(),
  maxAgeMs = Number(process.env.BV2_SHADOW_MAX_AGE_HOURS || 36) * 60 * 60 * 1000,
  completionGraceMs = Number(process.env.BV2_SHADOW_COMPLETION_GRACE_MINUTES || 10) * 60 * 1000,
  shadowClockSkewMs = Number(process.env.BV2_SHADOW_CLOCK_SKEW_SECONDS || 60) * 1000,
  windowStart = null,
  log = (line) => console.log(`[bv2-drift] ${line}`),
} = {}) {
  const processStartedAt = Date.now();
  let configuredWindowStart = validWindowStart(windowStart);
  if (!configuredWindowStart) {
    const { data: window, error: windowError } = await client.from("bv2_feature_flags")
      .select("value").eq("key", "bv2.shadow.window").maybeSingle();
    if (windowError) throw new Error(`shadow window unreadable: ${windowError.message}`);
    configuredWindowStart = validWindowStart(window?.value?.startedAt);
  }
  if (!configuredWindowStart) {
    const summary = {
      schemaVersion: 1,
      healthy: false,
      windowStart: null,
      projectsExpected: 0,
      projectsChecked: 0,
      cleanCount: 0,
      driftCount: 0,
      missingCount: 1,
      staleCount: 0,
      graphParityFailures: 0,
      deferredBuilds: 0,
      indexerVersion: INDEXER_VERSION,
      validatorVersion: SHADOW_VALIDATOR_VERSION,
      durationMs: Date.now() - processStartedAt,
      errors: ["shadow_window_not_configured"],
    };
    log(JSON.stringify({ type: "daily_shadow_summary", ...summary }));
    return { clean: false, checked: 0, drift: 1, evidence: [], summary };
  }

  const eligibleBefore = new Date(now - completionGraceMs).toISOString();
  const { data: allCompletedBuilds, error: buildError } = await client.from("build_jobs")
    .select("id,owner,project_id,updated_at")
    .eq("status", "complete")
    .gte("updated_at", configuredWindowStart)
    .order("updated_at", { ascending: false });
  if (buildError) throw new Error(`completed v1 builds unreadable: ${buildError.message}`);
  const completedBuilds = (allCompletedBuilds || []).filter((build) => build.updated_at <= eligibleBefore);

  const { data: states, error: stateError } = await client.from("bv2_migration_state")
    .select("owner,project_id,last_shadow_at,notes").eq("state", "shadow")
    .gte("last_shadow_at", configuredWindowStart);
  if (stateError) throw new Error(`migration state unreadable: ${stateError.message}`);

  const { data: runs, error: runError } = await client.from("bv2_shadow_runs")
    .select("id,owner,project_id,build_id,indexed_at,status")
    .gte("indexed_at", configuredWindowStart)
    .order("indexed_at", { ascending: false });
  if (runError) throw new Error(`shadow runs unreadable: ${runError.message}`);
  const latest = new Map();
  for (const run of runs || []) {
    const key = projectKey(run.owner, run.project_id);
    if (!latest.has(key)) latest.set(key, run);
  }

  const stateByProject = new Map((states || []).map((state) => [projectKey(state.owner, state.project_id), state]));
  const latestCompletedBuild = new Map();
  for (const build of completedBuilds || []) {
    const key = projectKey(build.owner, build.project_id);
    if (!latestCompletedBuild.has(key)) latestCompletedBuild.set(key, build);
  }
  const expected = new Map(stateByProject);
  for (const [key, build] of latestCompletedBuild) {
    if (!expected.has(key)) expected.set(key, { owner: build.owner, project_id: build.project_id, notes: {} });
  }

  const evidence = [];
  let drift = 0;
  let cleanCount = 0;
  let missingCount = 0;
  let staleCount = 0;
  let graphParityFailures = 0;
  const errors = [];
  for (const state of expected.values()) {
    const key = projectKey(state.owner, state.project_id);
    const run = latest.get(key);
    const completedBuild = latestCompletedBuild.get(key);
    const lastShadowAt = Date.parse(state.last_shadow_at || "");
    const buildCompletedAt = Date.parse(completedBuild?.updated_at || "");
    const callbackMissing = completedBuild && (!Number.isFinite(lastShadowAt)
      || lastShadowAt + shadowClockSkewMs < buildCompletedAt);
    if (callbackMissing) {
      const failure = {
        clean: false,
        owner: state.owner,
        projectId: state.project_id,
        buildId: completedBuild.id,
        shadowRunId: run?.id || null,
        checkedAt: new Date(now).toISOString(),
        mismatches: [{
          kind: "missing_shadow_for_completed_build",
          buildCompletedAt: completedBuild.updated_at,
          lastShadowAt: state.last_shadow_at || null,
        }],
      };
      if (stateByProject.has(key)) {
        await recordShadowCheck(state.owner, state.project_id, null, "failed", failure, { client });
      }
      evidence.push(failure);
      drift += 1;
      missingCount += 1;
      log(JSON.stringify(failure));
      continue;
    }
    if (!run) {
      const failure = {
        clean: false,
        owner: state.owner,
        projectId: state.project_id,
        buildId: state.notes?.buildId || null,
        shadowRunId: null,
        checkedAt: new Date(now).toISOString(),
        mismatches: [{ kind: "missing_shadow_run", lastShadowAt: state.last_shadow_at }],
      };
      await recordShadowCheck(state.owner, state.project_id, null, "failed", failure, { client });
      evidence.push(failure);
      drift += 1;
      missingCount += 1;
      log(JSON.stringify(failure));
      continue;
    }

    const { data: project, error: projectError } = await client.from("projects")
      .select("tree").eq("id", state.project_id).eq("owner", state.owner).maybeSingle();
    if (projectError || !project?.tree) {
      const failure = {
        clean: false,
        owner: state.owner,
        projectId: state.project_id,
        buildId: run.build_id,
        shadowRunId: run.id,
        checkedAt: new Date(now).toISOString(),
        mismatches: [{ kind: "missing_project_tree", message: projectError?.message || "tree absent" }],
      };
      await recordShadowCheck(state.owner, state.project_id, run.id, "failed", failure, { client });
      evidence.push(failure);
      drift += 1;
      graphParityFailures += 1;
      errors.push(`missing_project_tree:${state.owner}:${state.project_id}`);
      log(JSON.stringify(failure));
      continue;
    }

    const result = await validateShadowRun({
      owner: state.owner,
      projectId: state.project_id,
      tree: project.tree,
      shadowRunId: run.id,
      client,
      now,
      maxAgeMs,
    });
    evidence.push(result.evidence);
    if (result.status === "clean") cleanCount += 1;
    else {
      drift += 1;
      if (result.status === "stale") staleCount += 1;
      else graphParityFailures += 1;
    }
    log(JSON.stringify({
      owner: state.owner,
      projectId: state.project_id,
      buildId: run.build_id,
      shadowRunId: run.id,
      status: result.status,
      mismatches: result.evidence.mismatches,
    }));
  }
  const summary = {
    schemaVersion: 1,
    healthy: drift === 0,
    windowStart: configuredWindowStart,
    projectsExpected: expected.size,
    projectsChecked: expected.size,
    cleanCount,
    driftCount: drift,
    missingCount,
    staleCount,
    graphParityFailures,
    deferredBuilds: (allCompletedBuilds || []).length - completedBuilds.length,
    indexerVersion: INDEXER_VERSION,
    validatorVersion: SHADOW_VALIDATOR_VERSION,
    durationMs: Date.now() - processStartedAt,
    errors,
  };
  log(JSON.stringify({ type: "daily_shadow_summary", ...summary }));
  return { clean: drift === 0, checked: expected.size, drift, evidence, summary };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runShadowDriftCheck()
    .then((result) => { process.exitCode = result.clean ? 0 : 1; })
    .catch((error) => { console.error(`[bv2-drift] ${error.message}`); process.exitCode = 1; });
}
