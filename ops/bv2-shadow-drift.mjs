// Complete Builder V2 shadow proof. For every project explicitly in shadow state, compare the
// current in-memory index with the exact immutable revision set pinned by its latest shadow run.
// Every check is appended to bv2_shadow_checks. Exit 0 means full equivalence; any missing run,
// stale run, incomplete revision or graph/query mismatch exits 1 and never affects Builder V1.

import { pathToFileURL } from "node:url";
import { serviceClient } from "../shell/server/lib/supabase.mjs";
import { recordShadowCheck } from "../shell/server/lib/builderV2/supabaseTwins.mjs";
import { validateShadowRun } from "../shell/server/lib/builderV2/shadow.mjs";

export async function runShadowDriftCheck({
  client = serviceClient(),
  now = Date.now(),
  maxAgeMs = Number(process.env.BV2_SHADOW_MAX_AGE_HOURS || 36) * 60 * 60 * 1000,
  log = (line) => console.log(`[bv2-drift] ${line}`),
} = {}) {
  const { data: states, error: stateError } = await client.from("bv2_migration_state")
    .select("owner,project_id,last_shadow_at,notes").eq("state", "shadow");
  if (stateError) throw new Error(`migration state unreadable: ${stateError.message}`);
  if (!states?.length) {
    log("no projects in shadow state; no rollout evidence is accruing");
    return { clean: true, checked: 0, drift: 0, evidence: [] };
  }

  const { data: runs, error: runError } = await client.from("bv2_shadow_runs")
    .select("id,owner,project_id,build_id,indexed_at,status").order("indexed_at", { ascending: false });
  if (runError) throw new Error(`shadow runs unreadable: ${runError.message}`);
  const latest = new Map();
  for (const run of runs || []) {
    const key = `${run.owner}:${run.project_id}`;
    if (!latest.has(key)) latest.set(key, run);
  }

  const evidence = [];
  let drift = 0;
  for (const state of states) {
    const key = `${state.owner}:${state.project_id}`;
    const run = latest.get(key);
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
    if (result.status !== "clean") drift += 1;
    log(JSON.stringify({
      owner: state.owner,
      projectId: state.project_id,
      buildId: run.build_id,
      shadowRunId: run.id,
      status: result.status,
      mismatches: result.evidence.mismatches,
    }));
  }
  log(`${states.length} shadow project(s), ${drift} with drift`);
  return { clean: drift === 0, checked: states.length, drift, evidence };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runShadowDriftCheck()
    .then((result) => { process.exitCode = result.clean ? 0 : 1; })
    .catch((error) => { console.error(`[bv2-drift] ${error.message}`); process.exitCode = 1; });
}
