// Usage insights (customer, owner-scoped) and platform analytics (admin only). Built on
// ai_requests (per-request accounting from the build pipeline) + diag_runs (build
// sessions) + ca_subscriptions (plans). Every customer query is owner-filtered at the
// query level; the tables themselves are RLS-enabled with zero policies, so nothing is
// reachable from the browser except through these owner-scoped handlers.

import { serviceClient } from "./supabase.mjs";
import { RECORDED_COST_PER_CREDIT } from "../../../src/billing/costModel.mjs";
import { planCatalog } from "./subscriptionPlans.mjs";

// Honest conversion for display: measured real provider spend per credit.
export const GBP_PER_CREDIT = RECORDED_COST_PER_CREDIT.sonnetUncached.gbp;

const monthStart = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

function sumBy(rows, keyFn) {
  const out = new Map();
  for (const row of rows) {
    const key = keyFn(row) || "unknown";
    const entry = out.get(key) || { cost: 0, tokens: 0, requests: 0 };
    entry.cost += Number(row.cost || 0);
    entry.tokens += Number(row.input_tokens || 0) + Number(row.output_tokens || 0);
    entry.requests += 1;
    out.set(key, entry);
  }
  return [...out.entries()]
    .map(([key, v]) => ({ key, ...v, cost: Number(v.cost.toFixed(4)) }))
    .sort((a, b) => b.cost - a.cost);
}

// ── Customer insights ───────────────────────────────────────────────────────────────────

export async function usageInsights(owner, { client = null, now = new Date() } = {}) {
  const db = client || serviceClient();
  const since = monthStart(now);
  const [{ data: requests }, { data: builds }] = await Promise.all([
    db.from("ai_requests").select("*").eq("owner", owner).gte("created_at", since)
      .order("created_at", { ascending: false }).limit(2000),
    db.from("diag_runs")
      .select("id, kind, status, prompt, started_at, duration_ms, repair_rounds, totals")
      .eq("owner", owner).gte("started_at", since)
      .order("started_at", { ascending: false }).limit(100),
  ]);

  const reqs = requests || [];
  const aiCost = reqs.reduce((sum, r) => sum + Number(r.cost || 0), 0);
  const tokens = reqs.reduce((sum, r) => sum + Number(r.input_tokens || 0) + Number(r.output_tokens || 0), 0);
  return {
    month: since.slice(0, 7),
    buildsThisMonth: (builds || []).length,
    aiCost: Number(aiCost.toFixed(4)),
    aiCostGbp: Number((aiCost * GBP_PER_CREDIT).toFixed(4)),
    tokens,
    requests: reqs.length,
    byModel: sumBy(reqs, (r) => r.model),
    byAgent: sumBy(reqs, (r) => r.agent),
    byProvider: sumBy(reqs, (r) => r.provider),
    recentBuilds: (builds || []).slice(0, 8).map((b) => ({
      id: b.id, kind: b.kind, status: b.status,
      prompt: String(b.prompt || "").slice(0, 120),
      startedAt: b.started_at, durationMs: b.duration_ms,
      repairRounds: b.repair_rounds || 0,
      cost: Number(Number(b.totals?.cost || 0).toFixed(4)),
      tokens: Number(b.totals?.totalTokens || 0),
    })),
    recentRequests: reqs.slice(0, 50).map((r) => ({
      provider: r.provider, model: r.model, agent: r.agent,
      inputTokens: Number(r.input_tokens || 0), outputTokens: Number(r.output_tokens || 0),
      cachedTokens: Number(r.cached_tokens || 0), reasoningTokens: Number(r.reasoning_tokens || 0),
      durationMs: r.duration_ms, cost: r.cost == null ? null : Number(Number(r.cost).toFixed(4)),
      buildId: r.build_id, projectId: r.project_id, createdAt: r.created_at,
    })),
  };
}

// Per-build cost summary: total cost/tokens/duration + cost split by agent and by model.
export async function buildCostSummary(owner, buildId, { client = null } = {}) {
  const db = client || serviceClient();
  const { data: run } = await db.from("diag_runs")
    .select("id, owner, kind, status, prompt, started_at, duration_ms, repair_rounds, totals, model")
    .eq("id", buildId).eq("owner", owner).maybeSingle();
  if (!run) return null;
  const { data: requests } = await db.from("ai_requests").select("*")
    .eq("build_id", buildId).eq("owner", owner);
  const reqs = requests || [];
  return {
    buildId: run.id, kind: run.kind, status: run.status,
    prompt: String(run.prompt || "").slice(0, 200),
    startedAt: run.started_at, durationMs: run.duration_ms,
    repairRounds: run.repair_rounds || 0,
    totalCost: Number(Number(run.totals?.cost || 0).toFixed(4)),
    totalTokens: Number(run.totals?.totalTokens || 0),
    costByAgent: sumBy(reqs, (r) => r.agent),
    costByModel: sumBy(reqs, (r) => r.model),
  };
}

// ── Admin analytics (platform-wide; caller must already be admin-gated) ─────────────────

function bucketSeries(rows, { days, bucket }) {
  const buckets = new Map();
  for (const row of rows) {
    const d = new Date(row.created_at);
    let key;
    if (bucket === "day") key = d.toISOString().slice(0, 10);
    else if (bucket === "week") {
      const monday = new Date(d);
      monday.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      key = monday.toISOString().slice(0, 10);
    } else key = d.toISOString().slice(0, 7);
    const entry = buckets.get(key) || { cost: 0, requests: 0 };
    entry.cost += Number(row.cost || 0);
    entry.requests += 1;
    buckets.set(key, entry);
  }
  return [...buckets.entries()]
    .map(([key, v]) => ({ period: key, cost: Number(v.cost.toFixed(4)), requests: v.requests }))
    .sort((a, b) => a.period.localeCompare(b.period))
    .slice(-days);
}

export async function adminAnalytics({ client = null, now = new Date(), windowDays = 90 } = {}) {
  const db = client || serviceClient();
  const since = new Date(now.getTime() - windowDays * 86_400_000).toISOString();
  const [{ data: requests }, { data: builds }, { data: subs }] = await Promise.all([
    db.from("ai_requests").select("owner, model, agent, cost, input_tokens, output_tokens, build_id, created_at")
      .gte("created_at", since).limit(50_000),
    db.from("diag_runs").select("id, owner, kind, status, prompt, totals, started_at")
      .gte("started_at", since).limit(5_000),
    db.from("ca_subscriptions").select("owner, plan, status"),
  ]);

  const reqs = requests || [];
  const runs = builds || [];
  const totalSpendCredits = reqs.reduce((sum, r) => sum + Number(r.cost || 0), 0);
  const totalSpendGbp = totalSpendCredits * GBP_PER_CREDIT;

  // Revenue: active paid subscriptions at catalog prices (monthly, current book value).
  const catalog = planCatalog();
  let monthlyRevenueGbp = 0;
  let paidSubscribers = 0;
  for (const sub of subs || []) {
    if (!sub.plan || sub.plan === "free") continue;
    if (sub.status && !["active", "trialing"].includes(sub.status)) continue;
    const plan = catalog.find((p) => p.id === sub.plan);
    if (plan?.priceGbp) { monthlyRevenueGbp += plan.priceGbp; paidSubscribers += 1; }
  }

  const owners = new Set(reqs.map((r) => r.owner));
  const buildCount = runs.length || 1;
  const topBuilds = runs
    .map((b) => ({
      buildId: b.id, owner: b.owner, kind: b.kind, status: b.status,
      prompt: String(b.prompt || "").slice(0, 100),
      cost: Number(Number(b.totals?.cost || 0).toFixed(4)),
      startedAt: b.started_at,
    }))
    .sort((a, b) => b.cost - a.cost).slice(0, 10);
  const topUsers = sumBy(reqs, (r) => r.owner).slice(0, 10)
    .map((u) => ({ owner: u.key, cost: u.cost, tokens: u.tokens, requests: u.requests }));

  return {
    windowDays,
    generatedAt: now.toISOString(),
    gbpPerCredit: GBP_PER_CREDIT,
    totals: {
      aiSpendCredits: Number(totalSpendCredits.toFixed(4)),
      aiSpendGbp: Number(totalSpendGbp.toFixed(2)),
      monthlyRevenueGbp: Number(monthlyRevenueGbp.toFixed(2)),
      grossProfitGbp: Number((monthlyRevenueGbp - totalSpendGbp).toFixed(2)),
      paidSubscribers,
      activeUsers: owners.size,
      builds: runs.length,
      requests: reqs.length,
      avgCostPerUser: Number((totalSpendCredits / Math.max(owners.size, 1)).toFixed(4)),
      avgCostPerBuild: Number((totalSpendCredits / buildCount).toFixed(4)),
    },
    costByModel: sumBy(reqs, (r) => r.model),
    costByAgent: sumBy(reqs, (r) => r.agent),
    topBuilds,
    topUsers,
    series: {
      daily: bucketSeries(reqs, { days: 30, bucket: "day" }),
      weekly: bucketSeries(reqs, { days: 12, bucket: "week" }),
      monthly: bucketSeries(reqs, { days: 12, bucket: "month" }),
    },
  };
}
