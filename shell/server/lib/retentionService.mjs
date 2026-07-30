// Retention sweeper: removes run timelines and artifact content (rows and storage objects)
// for runs that finished more than CODE_AGENT_RETENTION_DAYS ago. Runs, checkpoints, and
// usage records are kept — they are the billing and audit history. Set the retention days
// to 0 to disable pruning entirely.

import { optionalEnv } from "./env.mjs";
import { codeAgentStore } from "./codeAgentStore.mjs";

let timer = null;

export function retentionDays() {
  const value = Number(optionalEnv("CODE_AGENT_RETENTION_DAYS", "90"));
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 90;
}

export async function sweepRetention({ store = codeAgentStore(), now = new Date(), batch = 50 } = {}) {
  const days = retentionDays();
  if (!days) return { pruned: 0, disabled: true };
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60_000).toISOString();
  let pruned = 0;
  for (let round = 0; round < 20; round += 1) {
    const runs = await store.listPrunableRuns(cutoff, batch);
    if (!runs.length) break;
    for (const run of runs) {
      await store.pruneRun(run);
      pruned += 1;
    }
    if (runs.length < batch) break;
  }
  return { pruned, cutoff };
}

export function startRetentionSweeper() {
  if (timer || !retentionDays()) return;
  const interval = Math.max(Number(optionalEnv("CODE_AGENT_RETENTION_SWEEP_MS", String(6 * 60 * 60_000))), 60_000);
  timer = setInterval(() => {
    sweepRetention()
      .then(({ pruned }) => { if (pruned) console.log(`[code-agent] retention pruned ${pruned} runs`); })
      .catch((error) => console.error("[code-agent] retention sweep:", error));
  }, interval);
  timer.unref?.();
}

export function stopRetentionSweeper() {
  if (timer) clearInterval(timer);
  timer = null;
}
