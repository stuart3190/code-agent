// Operational telemetry: a platform-wide snapshot for Thrallo operators.
//
// Aggregates the durable tables that already exist — runs, webhook deliveries, usage
// records, model attempts, and repository indexes — on demand. Bounded reads (5k rows per
// source) keep the endpoint cheap at current scale; a rollup table can replace this once
// traffic outgrows it. Access is gated by the verified-email ADMIN_EMAILS allowlist.

import { codeAgentStore } from "./codeAgentStore.mjs";
import { aiRoutingStore } from "./aiRoutingStore.mjs";
import { repositoryIndexStore } from "./repositoryIndexStore.mjs";
import { TERMINAL_RUN_STATES } from "./codeAgentContracts.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function opsTelemetrySnapshot({
  store = codeAgentStore(),
  routingStore = aiRoutingStore(),
  indexStore = repositoryIndexStore(),
  now = new Date(),
} = {}) {
  const since7d = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const since24h = new Date(now.getTime() - DAY_MS).toISOString();
  const [runRows, webhooks, usageRows, attempts, indexes] = await Promise.all([
    store.opsRunRows(since7d),
    store.opsWebhookStatusCounts(),
    store.opsUsageRows(since7d),
    routingStore.listAttemptsSince(since7d),
    indexStore.indexStatusCounts(),
  ]);
  return {
    generatedAt: now.toISOString(),
    runs: {
      last24h: summarizeRuns(runRows.filter((row) => row.created_at >= since24h)),
      last7d: summarizeRuns(runRows),
      queueDepth: runRows.filter((row) => row.state === "queued").length,
      active: runRows.filter((row) => ["provisioning", "indexing", "running"].includes(row.state)).length,
      waitingForApproval: runRows.filter((row) => row.state === "waiting_for_approval").length,
    },
    webhooks,
    providers: summarizeProviders(attempts),
    usage: {
      last24h: summarizeUsage(usageRows.filter((row) => row.created_at >= since24h)),
      last7d: summarizeUsage(usageRows),
    },
    indexing: indexes,
  };
}

function summarizeRuns(rows) {
  const byState = {};
  let durationTotal = 0;
  let durationCount = 0;
  let failed = 0;
  let finished = 0;
  for (const row of rows) {
    byState[row.state] = (byState[row.state] || 0) + 1;
    if (TERMINAL_RUN_STATES.has(row.state)) {
      finished += 1;
      if (["failed", "interrupted"].includes(row.state)) failed += 1;
      if (row.started_at && row.finished_at) {
        durationTotal += new Date(row.finished_at) - new Date(row.started_at);
        durationCount += 1;
      }
    }
  }
  return {
    total: rows.length,
    byState,
    finished,
    failureRate: finished ? Number((failed / finished).toFixed(3)) : 0,
    averageDurationSeconds: durationCount ? Math.round(durationTotal / durationCount / 1000) : 0,
  };
}

function summarizeProviders(attempts) {
  const byModel = new Map();
  for (const attempt of attempts) {
    const key = `${attempt.provider}:${attempt.model}`;
    const entry = byModel.get(key)
      || { provider: attempt.provider, model: attempt.model, attempts: 0, errors: 0, latencyTotal: 0 };
    entry.attempts += 1;
    if (attempt.status === "error") entry.errors += 1;
    entry.latencyTotal += Number(attempt.latency_ms || 0);
    byModel.set(key, entry);
  }
  return [...byModel.values()]
    .map(({ latencyTotal, ...entry }) => ({
      ...entry,
      errorRate: entry.attempts ? Number((entry.errors / entry.attempts).toFixed(3)) : 0,
      averageLatencyMs: entry.attempts ? Math.round(latencyTotal / entry.attempts) : 0,
    }))
    .sort((a, b) => b.attempts - a.attempts);
}

function summarizeUsage(rows) {
  const totals = { records: 0, tokens: 0, computeSeconds: 0, bySource: {} };
  for (const row of rows) {
    const tokens = Number(row.input_tokens || 0) + Number(row.output_tokens || 0);
    const source = row.billing_source || "unknown";
    totals.records += 1;
    totals.tokens += tokens;
    totals.computeSeconds += Number(row.compute_seconds || 0);
    totals.bySource[source] = (totals.bySource[source] || 0) + tokens;
  }
  totals.computeSeconds = Math.round(totals.computeSeconds);
  return totals;
}
