// Shadow indexing (finish plan WP-14 / V2-24; master plan Phase 12).
//
// Every COMPLETED v1 build gets its final tree indexed into the v2 stores — real
// production trees exercising the real persistence path for a week before any cutover
// decision. Behind bv2.shadow (kill switch beats it), and ABSOLUTELY ISOLATED: this
// function never throws, is never awaited by the build path, and a total shadow-store
// outage costs v1 nothing but one log line. The fault-injection test pins that.
//
// Each shadow pass upserts bv2_migration_state (state "shadow", last_shadow_at) — the
// drift check (ops/bv2-shadow-drift.mjs) walks those rows daily and compares a fresh
// index of the live tree against what the twins persisted.

import { killSwitchActive, flagOn } from "./featureFlags.mjs";
import { indexTree } from "./indexer.mjs";
import { compareGraphIndexes } from "./graphParity.mjs";
import {
  beginShadowRun,
  loadShadowRunIndex,
  persistIndex,
  recordShadowCheck,
} from "./supabaseTwins.mjs";
import { serviceClient } from "../supabase.mjs";

export async function validateShadowRun({
  owner,
  projectId,
  tree,
  shadowRunId,
  client = serviceClient(),
  now = Date.now(),
  maxAgeMs = 36 * 60 * 60 * 1000,
}) {
  const fresh = indexTree(tree);
  let loaded;
  try {
    loaded = await loadShadowRunIndex(owner, projectId, shadowRunId, { client });
  } catch (error) {
    const evidence = {
      clean: false,
      owner,
      projectId,
      shadowRunId,
      checkedAt: new Date(now).toISOString(),
      mismatches: [{ kind: "shadow_validation_error", message: error.message }],
    };
    await recordShadowCheck(owner, projectId, shadowRunId, "failed", evidence, { client });
    return { status: "failed", evidence, run: null, fresh, persisted: null };
  }
  const { run, index: persisted } = loaded;
  const evidence = compareGraphIndexes(fresh, persisted, {
    owner,
    projectId,
    buildId: run.build_id,
    shadowRunId,
    shadowAt: run.indexed_at,
    maxAgeMs,
    now,
  });
  const stale = evidence.mismatches.some((mismatch) => mismatch.kind === "stale_shadow_run");
  const status = evidence.clean ? "clean" : stale ? "stale" : "drift";
  await recordShadowCheck(owner, projectId, shadowRunId, status, evidence, { client });
  return { status, evidence, run, fresh, persisted };
}

/**
 * Fire-and-forget from the v1 completion path: `void shadowIndexBuild({...})`.
 * Returns { shadowed, reason } for tests and ops — callers ignore it.
 */
export async function shadowIndexBuild({
  owner, projectId, tree, buildId = null,
  client = null, flagOptions = undefined, log = (line) => console.log(`[bv2-shadow] ${line}`),
}) {
  try {
    if (killSwitchActive(flagOptions?.env || process.env)) return { shadowed: false, reason: "kill switch" };
    if (!(await flagOn("bv2.shadow", flagOptions))) return { shadowed: false, reason: "bv2.shadow off" };
    if (!owner || !projectId || !tree || !Object.keys(tree).length) {
      return { shadowed: false, reason: "nothing to shadow" };
    }

    const db = client || serviceClient();
    const treeIndex = indexTree(tree);
    await persistIndex(owner, projectId, treeIndex, { client: db });
    const shadowRunId = await beginShadowRun(owner, projectId, buildId, treeIndex, { client: db });
    const validation = await validateShadowRun({ owner, projectId, tree, shadowRunId, client: db });
    if (validation.status !== "clean") {
      const kinds = [...new Set(validation.evidence.mismatches.map((mismatch) => mismatch.kind))];
      log(`DRIFT ${shadowRunId}: ${kinds.join(", ")} (v1 unaffected)`);
      return {
        shadowed: false,
        reason: "persisted graph failed full parity",
        shadowRunId,
        evidence: validation.evidence,
      };
    }
    log(`CLEAN ${shadowRunId}: indexed ${treeIndex.files.size} files and verified the full graph for ${String(projectId).slice(0, 8)} (tree ${treeIndex.treeHash.slice(0, 12)})`);
    return { shadowed: true, treeHash: treeIndex.treeHash, shadowRunId, evidence: validation.evidence };
  } catch (error) {
    // Shadow trouble is SHADOW trouble: one loud line, zero effect on the build that fed it.
    log(`shadow failed (v1 unaffected): ${error.message}`);
    return { shadowed: false, reason: error.message };
  }
}
