// Provider Intelligence: Auto routing learns from real production builds instead of fixed
// rankings. Evidence comes from telemetry Thrallo already records — ai_requests (provider,
// model, agent, token classes, cache, cost, duration, trigger, task type) joined to
// diag_runs (verification status, build duration, repair rounds) by Build ID.
//
// Three hard rules:
//   1. Never invent statistics. Below the evidence floor a scorecard reports
//      "Collecting benchmark data." and Auto falls back to its configured order.
//   2. Deterministic. The same evidence always produces the same ranking (explicit
//      weights, stable tie-breaks) so a recommendation is reproducible and auditable.
//   3. Explainable. Every pick carries a sentence quoting the measured difference.

import { serviceClient } from "./supabase.mjs";

// Evidence floors. Below MIN_SAMPLES we say so rather than guess.
export const MIN_SAMPLES = 5;
export const CONFIDENCE_BANDS = [
  { level: "High", min: 50 },
  { level: "Medium", min: 15 },
  { level: "Low", min: MIN_SAMPLES },
];

export function confidenceFor(samples) {
  const band = CONFIDENCE_BANDS.find((b) => samples >= b.min);
  return band ? band.level : null;
}

// Task families Auto reasons about separately — an edit and a full build have different
// winners, which is the entire point of segmenting.
export const TASK_FAMILIES = ["simple_edit", "component_edit", "feature", "bug_repair", "verification_repair", "full_build"];

export function taskFamilyFor(taskType) {
  return TASK_FAMILIES.includes(taskType) ? taskType : "other";
}

// ── Evidence collection ─────────────────────────────────────────────────────────────────

// Anonymised: owners are counted, never identified, and no prompt text is read.
export async function collectEvidence({ client = null, windowDays = 60, now = new Date() } = {}) {
  const db = client || serviceClient();
  const since = new Date(now.getTime() - windowDays * 86_400_000).toISOString();
  const [{ data: requests }, { data: runs }] = await Promise.all([
    db.from("ai_requests")
      .select("owner, provider, model, agent, input_tokens, output_tokens, cached_tokens, duration_ms, cost, build_id, trigger, context, created_at")
      .gte("created_at", since).limit(50_000),
    db.from("diag_runs")
      .select("id, kind, status, duration_ms, repair_rounds, totals, model, started_at")
      .gte("started_at", since).limit(10_000),
  ]);

  const runById = new Map((runs || []).map((r) => [r.id, r]));
  const rows = [];
  for (const request of requests || []) {
    const run = request.build_id ? runById.get(request.build_id) : null;
    const context = request.context || {};
    rows.push({
      provider: request.provider || "unknown",
      model: request.model || "unknown",
      mode: context.mode || "balanced",
      task: taskFamilyFor(context.taskType),
      trigger: request.trigger || "user",
      owner: request.owner,
      cost: Number(request.cost || 0),
      inputTokens: Number(request.input_tokens || 0),
      cachedTokens: Number(request.cached_tokens || 0),
      requestMs: Number(request.duration_ms || 0),
      // Build-level outcome (only present once the build session finished).
      verified: run ? run.status === "passed" : null,
      cancelled: run ? run.status === "interrupted" : null,
      buildMs: run ? Number(run.duration_ms || 0) : null,
      repairRounds: run ? Number(run.repair_rounds || 0) : null,
      retries: Number(context.retries || 0),
      buildId: request.build_id || null,
    });
  }
  return rows;
}

// ── Scorecards ──────────────────────────────────────────────────────────────────────────

function summarise(rows) {
  const builds = new Map();
  let cost = 0;
  let requestMs = 0;
  let inputTokens = 0;
  let cachedTokens = 0;
  let retries = 0;
  const owners = new Set();
  for (const row of rows) {
    cost += row.cost;
    requestMs += row.requestMs;
    inputTokens += row.inputTokens;
    cachedTokens += row.cachedTokens;
    retries += row.retries;
    owners.add(row.owner);
    if (row.buildId && !builds.has(row.buildId)) {
      builds.set(row.buildId, { verified: row.verified, cancelled: row.cancelled, buildMs: row.buildMs, repairRounds: row.repairRounds });
    }
  }
  const buildList = [...builds.values()].filter((b) => b.verified !== null);
  const verified = buildList.filter((b) => b.verified).length;
  const cancelled = buildList.filter((b) => b.cancelled).length;
  const samples = buildList.length || rows.length;
  return {
    samples,
    builds: buildList.length,
    owners: owners.size,
    requests: rows.length,
    verificationRate: buildList.length ? Number(((verified / buildList.length) * 100).toFixed(1)) : null,
    cancellationRate: buildList.length ? Number(((cancelled / buildList.length) * 100).toFixed(1)) : null,
    avgCost: rows.length ? Number((cost / Math.max(builds.size, 1)).toFixed(4)) : null,
    // The number that actually matters: what a VERIFIED result costs.
    costPerVerifiedBuild: verified ? Number((cost / verified).toFixed(4)) : null,
    avgBuildMs: buildList.length ? Math.round(buildList.reduce((a, b) => a + (b.buildMs || 0), 0) / buildList.length) : null,
    avgRequestMs: rows.length ? Math.round(requestMs / rows.length) : null,
    avgRepairRounds: buildList.length ? Number((buildList.reduce((a, b) => a + (b.repairRounds || 0), 0) / buildList.length).toFixed(2)) : null,
    avgRetries: rows.length ? Number((retries / rows.length).toFixed(2)) : null,
    cacheEfficiency: inputTokens ? Number(((cachedTokens / inputTokens) * 100).toFixed(1)) : null,
    confidence: confidenceFor(buildList.length || rows.length),
  };
}

// Scorecards keyed by provider, by model, and by (model × task family).
export function buildScorecards(rows) {
  const group = (keyFn) => {
    const map = new Map();
    for (const row of rows) {
      const key = keyFn(row);
      if (!key) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(row);
    }
    return [...map.entries()]
      .map(([key, list]) => ({ key, ...summarise(list) }))
      .sort((a, b) => a.key.localeCompare(b.key)); // deterministic base order
  };
  return {
    byProvider: group((r) => r.provider),
    byModel: group((r) => r.model),
    byModelTask: group((r) => `${r.model}|${r.task}`),
    byMode: group((r) => r.mode),
    generatedAt: new Date().toISOString(),
    totalRequests: rows.length,
  };
}

// ── Deterministic ranking ───────────────────────────────────────────────────────────────
// Lower score wins. Weights are explicit so a ranking can be re-derived by hand from the
// numbers shown in the dashboard — that is what makes Auto auditable.
export const WEIGHTS = { costPerVerified: 0.5, duration: 0.25, verification: 0.25 };

export function rankCandidates(scorecards, { task = null } = {}) {
  const source = task
    ? scorecards.byModelTask
      .filter((s) => s.key.endsWith(`|${task}`))
      .map((s) => ({ ...s, key: s.key.split("|")[0] }))
    : scorecards.byModel;
  const eligible = source.filter((s) => s.samples >= MIN_SAMPLES && s.costPerVerifiedBuild != null);
  if (eligible.length < 2) return { ranked: [], evidence: "insufficient", eligible };

  const norm = (values, value) => {
    const min = Math.min(...values);
    const max = Math.max(...values);
    return max === min ? 0 : (value - min) / (max - min);
  };
  const costs = eligible.map((s) => s.costPerVerifiedBuild);
  const durations = eligible.map((s) => s.avgBuildMs ?? 0);
  const rates = eligible.map((s) => s.verificationRate ?? 0);

  const ranked = eligible
    .map((s) => ({
      ...s,
      score: Number((
        WEIGHTS.costPerVerified * norm(costs, s.costPerVerifiedBuild)
        + WEIGHTS.duration * norm(durations, s.avgBuildMs ?? 0)
        + WEIGHTS.verification * (1 - norm(rates, s.verificationRate ?? 0))
      ).toFixed(6)),
    }))
    .sort((a, b) => (a.score - b.score) || a.key.localeCompare(b.key)); // stable tie-break
  return { ranked, evidence: "measured", eligible };
}

// ── Explanations (quote the measured difference; never invent one) ─────────────────────

export function explainChoice(ranked, { task = null } = {}) {
  if (!ranked?.length) return "Collecting benchmark data.";
  const [winner, runnerUp] = ranked;
  const scope = task && task !== "other" ? `${task.replace(/_/g, " ")} builds` : "recent builds";
  if (!runnerUp) {
    return `Selected ${winner.key} — the only model with enough verified ${scope} to compare (${winner.samples} samples, ${winner.confidence} confidence).`;
  }
  const cheaper = runnerUp.costPerVerifiedBuild > 0
    ? Math.round(((runnerUp.costPerVerifiedBuild - winner.costPerVerifiedBuild) / runnerUp.costPerVerifiedBuild) * 100)
    : 0;
  const faster = (runnerUp.avgBuildMs || 0) > 0
    ? Math.round((((runnerUp.avgBuildMs || 0) - (winner.avgBuildMs || 0)) / (runnerUp.avgBuildMs || 1)) * 100)
    : 0;
  const sameQuality = Math.abs((winner.verificationRate ?? 0) - (runnerUp.verificationRate ?? 0)) <= 2;

  let reason;
  if (cheaper >= 5 && sameQuality) {
    reason = `it achieved equivalent verified results at approximately ${cheaper}% lower average cost`;
  } else if (faster >= 5 && sameQuality) {
    reason = `${scope} completed ${faster}% faster with the same verification success`;
  } else if ((winner.verificationRate ?? 0) > (runnerUp.verificationRate ?? 0)) {
    reason = `it verified successfully ${winner.verificationRate}% of the time versus ${runnerUp.verificationRate}% for ${runnerUp.key}`;
  } else if (cheaper > 0) {
    reason = `it cost approximately ${cheaper}% less per verified build`;
  } else {
    reason = `it scored best across cost, duration and verification on the measured evidence`;
  }
  return `Selected ${winner.key} because ${reason} (${winner.samples} verified ${scope}, ${winner.confidence} confidence).`;
}

// ── The routing recommendation ─────────────────────────────────────────────────────────

// Returns null when evidence is insufficient — callers keep their configured behaviour.
export async function recommendModel({ task = null, client = null, scorecards = null, windowDays = 60 } = {}) {
  const cards = scorecards || buildScorecards(await collectEvidence({ client, windowDays }));
  // Try the task-specific ranking first; fall back to the overall one.
  for (const scope of [task, null]) {
    const { ranked, evidence } = rankCandidates(cards, { task: scope });
    if (evidence === "measured" && ranked.length) {
      const winner = ranked[0];
      return {
        model: winner.key,
        task: scope,
        confidence: winner.confidence,
        samples: winner.samples,
        explanation: explainChoice(ranked, { task: scope }),
        stats: {
          costPerVerifiedBuild: winner.costPerVerifiedBuild,
          verificationRate: winner.verificationRate,
          avgBuildMs: winner.avgBuildMs,
          avgRepairRounds: winner.avgRepairRounds,
          cacheEfficiency: winner.cacheEfficiency,
        },
        ranked: ranked.map((r) => ({ model: r.key, score: r.score, samples: r.samples, confidence: r.confidence })),
      };
    }
  }
  return null;
}

// ── Admin dashboard payload ────────────────────────────────────────────────────────────

export async function providerIntelligenceSnapshot({ client = null, windowDays = 60 } = {}) {
  const rows = await collectEvidence({ client, windowDays });
  const scorecards = buildScorecards(rows);
  const overall = rankCandidates(scorecards);
  const perTask = {};
  for (const task of TASK_FAMILIES) {
    const ranking = rankCandidates(scorecards, { task });
    perTask[task] = ranking.evidence === "measured"
      ? { ranked: ranking.ranked.map((r) => ({ model: r.key, score: r.score, samples: r.samples, confidence: r.confidence, costPerVerifiedBuild: r.costPerVerifiedBuild, avgBuildMs: r.avgBuildMs, verificationRate: r.verificationRate })), explanation: explainChoice(ranking.ranked, { task }) }
      : { ranked: [], explanation: "Collecting benchmark data." };
  }
  // Recent trend: this week versus the previous one, per model (measured, never smoothed).
  const now = Date.now();
  const week = 7 * 86_400_000;
  const recent = buildScorecards(rows.filter((r) => r.buildId));
  return {
    windowDays,
    generatedAt: scorecards.generatedAt,
    minSamples: MIN_SAMPLES,
    weights: WEIGHTS,
    providers: scorecards.byProvider,
    models: scorecards.byModel,
    modes: scorecards.byMode,
    perTask,
    overall: overall.evidence === "measured"
      ? { ranked: overall.ranked.map((r) => ({ model: r.key, score: r.score, samples: r.samples, confidence: r.confidence })), explanation: explainChoice(overall.ranked) }
      : { ranked: [], explanation: "Collecting benchmark data." },
    trend: recent.byModel.map((m) => ({ model: m.key, samples: m.samples, costPerVerifiedBuild: m.costPerVerifiedBuild, verificationRate: m.verificationRate })),
    sampleWindow: { from: new Date(now - windowDays * 86_400_000).toISOString(), to: new Date(now).toISOString(), week },
  };
}
