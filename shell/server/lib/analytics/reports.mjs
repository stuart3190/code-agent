// Reading analytics back.
//
// Retention is a plan feature, so it is enforced HERE rather than in the UI — asking for 365 days
// on Free returns 7, it does not return an error and it does not return 365. Deployment history
// comes from data Thrallo already had (diag_runs, published_sites), so it works from the first
// publish with nothing to collect.

import { serviceClient } from "../supabase.mjs";
import { ownerSubscription } from "../usageBudgets.mjs";
import { buildRunsFor } from "../logs/buildRuns.mjs";

// Free sees a week, Starter a quarter, Pro everything. Null means unlimited.
export const RETENTION_DAYS = Object.freeze({ free: 7, starter: 90, pro: null });

// Only Starter and above get error reporting and the full dimension breakdowns.
export const FULL_ANALYTICS_PLANS = Object.freeze(["starter", "pro"]);
export const ADVANCED_PLANS = Object.freeze(["pro"]);

export function retentionFor(plan) {
  return Object.prototype.hasOwnProperty.call(RETENTION_DAYS, plan) ? RETENTION_DAYS[plan] : 7;
}

export function analyticsCapabilities(plan) {
  return {
    plan,
    retentionDays: retentionFor(plan),
    fullAnalytics: FULL_ANALYTICS_PLANS.includes(plan),
    errorReporting: FULL_ANALYTICS_PLANS.includes(plan),
    buildHistory: FULL_ANALYTICS_PLANS.includes(plan),
    export: ADVANCED_PLANS.includes(plan),
    multiDomain: ADVANCED_PLANS.includes(plan),
  };
}

// The window actually queried: what was asked for, clamped to what the plan includes.
export function resolveWindow({ requestedDays, plan, now = new Date() }) {
  const allowed = retentionFor(plan);
  const asked = Number.isFinite(Number(requestedDays)) ? Math.max(1, Math.floor(Number(requestedDays))) : 30;
  const days = allowed === null ? asked : Math.min(asked, allowed);
  const from = new Date(now.getTime() - (days - 1) * 86_400_000);
  return { days, clamped: allowed !== null && asked > allowed, from: from.toISOString().slice(0, 10) };
}

async function ownedProject(owner, projectId, client) {
  const { data } = await client.from("published_sites")
    .select("project_id,slug").eq("project_id", String(projectId)).eq("owner", owner).maybeSingle();
  return data || null;
}

function emptyOverview() {
  return {
    totals: { pageviews: 0, visitors: 0, sessions: 0, errors: 0 },
    series: [], topPages: [], referrers: [], browsers: [], operatingSystems: [], devices: [],
    vitals: null,
  };
}

const rank = (rows, dimension) => rows
  .filter((r) => r.dimension === dimension)
  .reduce((acc, r) => {
    const found = acc.find((a) => a.key === r.key);
    if (found) { found.pageviews += r.pageviews; found.visitors += r.visitors; return acc; }
    return acc.concat({ key: r.key, pageviews: r.pageviews, visitors: r.visitors });
  }, [])
  .sort((a, b) => b.pageviews - a.pageviews)
  .slice(0, 20);

export async function overview(owner, projectId, {
  days = 30, client = serviceClient(), store = null, now = new Date(),
} = {}) {
  const subscription = await ownerSubscription(owner, store ? { store } : {});
  const capabilities = analyticsCapabilities(subscription.plan);
  const window = resolveWindow({ requestedDays: days, plan: subscription.plan, now });

  const project = await ownedProject(owner, projectId, client);
  if (!project) return { capabilities, window, ...emptyOverview(), unavailable: "not_published" };

  const { data: rows } = await client.from("analytics_daily")
    .select("*").eq("project_id", String(projectId)).eq("owner", owner).gte("day", window.from);
  const all = rows || [];

  const totalsRows = all.filter((r) => r.dimension === "totals");
  const totals = totalsRows.reduce((acc, r) => ({
    pageviews: acc.pageviews + r.pageviews,
    visitors: acc.visitors + r.visitors,
    sessions: acc.sessions + r.sessions,
    errors: acc.errors + r.errors,
  }), { pageviews: 0, visitors: 0, sessions: 0, errors: 0 });

  const series = totalsRows
    .map((r) => ({ day: r.day, pageviews: r.pageviews, visitors: r.visitors, sessions: r.sessions, errors: r.errors }))
    .sort((a, b) => (a.day < b.day ? -1 : 1));

  // Averaged from stored sums and a count, so merging days stays accurate rather than averaging
  // averages.
  const vitalsCount = totalsRows.reduce((n, r) => n + r.vitals_count, 0);
  const avg = (field) => (vitalsCount ? Math.round(totalsRows.reduce((n, r) => n + Number(r[field] || 0), 0) / vitalsCount) : null);
  const vitals = vitalsCount ? {
    samples: vitalsCount,
    lcpMs: avg("lcp_sum"), fcpMs: avg("fcp_sum"), inpMs: avg("inp_sum"),
    ttfbMs: avg("ttfb_sum"), loadMs: avg("load_sum"),
    cls: Number((totalsRows.reduce((n, r) => n + Number(r.cls_sum || 0), 0) / vitalsCount).toFixed(3)),
  } : null;

  return {
    capabilities,
    window,
    totals,
    series,
    vitals,
    topPages: rank(all, "path"),
    referrers: rank(all, "referrer"),
    // The breakdowns are what Starter adds; Free gets the headline numbers and the trend.
    browsers: capabilities.fullAnalytics ? rank(all, "browser") : [],
    operatingSystems: capabilities.fullAnalytics ? rank(all, "os") : [],
    devices: capabilities.fullAnalytics ? rank(all, "device") : [],
  };
}

// Near-real-time: distinct visitors seen in the last few minutes, straight from raw events.
export async function liveVisitors(owner, projectId, { client = serviceClient(), now = new Date(), windowMs = 5 * 60_000 } = {}) {
  const since = new Date(now.getTime() - windowMs).toISOString();
  const { data } = await client.from("analytics_events")
    .select("visitor_hash,path")
    .eq("owner", owner).eq("project_id", String(projectId)).eq("kind", "pageview")
    .gte("occurred_at", since);
  const rows = data || [];
  const visitors = new Set(rows.map((r) => r.visitor_hash));
  const byPath = new Map();
  for (const row of rows) byPath.set(row.path, (byPath.get(row.path) || 0) + 1);
  return {
    live: visitors.size,
    windowMinutes: Math.round(windowMs / 60_000),
    pages: [...byPath.entries()].map(([key, views]) => ({ key, views }))
      .sort((a, b) => b.views - a.views).slice(0, 10),
  };
}

// Deployment history needs no collection at all — Thrallo already recorded every one of these.
export async function deployments(owner, projectId, { client = serviceClient(), store = null, limit = 50 } = {}) {
  const subscription = await ownerSubscription(owner, store ? { store } : {});
  const capabilities = analyticsCapabilities(subscription.plan);
  // Free sees recent history rather than none: knowing the last few deploys is table stakes.
  const cap = capabilities.buildHistory ? limit : 5;

  const { data: site } = await client.from("published_sites")
    .select("created_at,updated_at,unpublished_at,slug,url")
    .eq("project_id", String(projectId)).eq("owner", owner).maybeSingle();

  // The SAME resolver the Logs view uses, so a deployment and its logs cannot disagree about which
  // builds exist or what they are called. It also throws on a read failure rather than reporting
  // an empty build history, which is indistinguishable from a project that has never been built.
  const runs = await buildRunsFor(owner, projectId, { client, limit: cap });

  const builds = (runs || []).map((run) => ({
    id: run.id,
    status: run.status,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    durationMs: run.started_at && run.finished_at
      ? Math.max(0, Date.parse(run.finished_at) - Date.parse(run.started_at)) : null,
    repairRounds: run.repair_rounds || 0,
  }));

  return {
    capabilities,
    truncated: !capabilities.buildHistory,
    site: site ? {
      firstPublishedAt: site.created_at,
      lastPublishedAt: site.updated_at,
      unpublishedAt: site.unpublished_at,
      url: site.url,
    } : null,
    builds,
    summary: {
      total: builds.length,
      failed: builds.filter((b) => b.status === "failed").length,
      averageDurationMs: builds.length
        ? Math.round(builds.filter((b) => b.durationMs).reduce((n, b) => n + b.durationMs, 0)
          / Math.max(1, builds.filter((b) => b.durationMs).length))
        : null,
    },
  };
}
