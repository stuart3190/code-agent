// Restart recovery + retention for persistent app-build checkpoints.
//
// The in-memory ring shipped in #119 vanished with the process, so a restart mid-repair left
// the project at whatever the last (possibly worse) round wrote, with no way back. Checkpoints
// are now written through to build_checkpoints, and this module closes the loop:
//
//   * on boot, every lifecycle this server killed mid-build is examined. If the project's
//     current tree is a WORSE state than a surviving checkpoint, the last known good is
//     restored — the same rule the live relay applies, just after the fact.
//   * a periodic sweep drops rows past their retention window.
//
// Both are best-effort and never throw into boot: losing recovery is survivable, a shell
// that will not start is not.

import { serviceClient } from "../supabase.mjs";
import {
  CHECKPOINT_TABLE, checkpointRank, loadCheckpointRows,
  restoreCheckpoint, sweepCheckpoints, checkpointRetentionHours,
} from "./buildCheckpoints.mjs";

const SWEEP_INTERVAL_MS = 60 * 60_000;
let sweepTimer = null;

export function startCheckpointSweeper({ client = null, intervalMs = SWEEP_INTERVAL_MS } = {}) {
  if (sweepTimer) return sweepTimer;
  const run = () => sweepCheckpoints({ client: client || serviceClient() })
    .then((n) => { if (n) console.log(`[checkpoints] swept ${n} expired checkpoint(s)`); })
    .catch((error) => console.error("[checkpoints] sweep:", error.message));
  run();
  sweepTimer = setInterval(run, intervalMs);
  sweepTimer.unref?.();
  return sweepTimer;
}

export function stopCheckpointSweeper() {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}

// Is the project's CURRENT stored tree worse than the best surviving checkpoint? A restart
// that happened after a failed repair round is exactly this shape.
export function shouldRestore({ rows, currentTree }) {
  if (!rows?.length) return null;
  const best = rows.reduce((a, b) => (checkpointRank(b.mark) >= checkpointRank(a.mark) ? b : a));
  const latest = rows.reduce((a, b) => ((Number(b.seq) || 0) >= (Number(a.seq) || 0) ? b : a));
  // Nothing better exists than where we already are.
  if (best.id === latest.id) return null;
  if (checkpointRank(best.mark) <= checkpointRank(latest.mark)) return null;
  // If the project already holds the good tree (the relay restored it before dying), skip.
  if (currentTree && best.tree && sameTree(currentTree, best.tree)) return null;
  return best;
}

function sameTree(a, b) {
  const aKeys = Object.keys(a || {});
  const bKeys = Object.keys(b || {});
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}

// Boot-time recovery for lifecycles interrupted by this server's restart.
export async function recoverInterruptedLifecycles({ client = null, limit = 50 } = {}) {
  const db = client || serviceClient();
  let recovered = 0;
  try {
    // Jobs the boot sweep just marked interrupted are the ones whose relay died with us.
    const { data: jobs, error } = await db.from("build_jobs")
      .select("id, owner, project_id, updated_at")
      .eq("status", "interrupted")
      .order("updated_at", { ascending: false })
      .limit(limit);
    if (error) { console.error("[checkpoints] recovery:", error.message); return 0; }

    const seen = new Set();
    for (const job of jobs || []) {
      const key = `${job.owner}:${job.project_id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const rows = await loadCheckpointRows({ client: db, owner: job.owner, projectId: job.project_id });
      if (!rows.length) continue;

      const { data: project } = await db.from("projects")
        .select("tree").eq("id", job.project_id).eq("owner", job.owner).maybeSingle();

      const best = shouldRestore({ rows, currentTree: project?.tree });
      if (!best) continue;

      const result = await restoreCheckpoint(
        { ...best, tree: best.tree, id: best.id },
        { client: db, owner: job.owner, projectId: job.project_id },
      );
      if (result.restored) {
        recovered += 1;
        console.log(`[checkpoints] restored ${best.mark} checkpoint for project ${job.project_id} after an interrupted build`);
      }
    }
  } catch (error) {
    console.error("[checkpoints] recovery:", error.message);
  }
  if (recovered) console.log(`[checkpoints] recovered ${recovered} interrupted lifecycle(s)`);
  return recovered;
}

export { CHECKPOINT_TABLE, checkpointRetentionHours };
