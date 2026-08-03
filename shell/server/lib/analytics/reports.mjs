// Reading analytics back.
//
// Retention is a plan feature, so it is enforced HERE rather than in the UI — asking for 365 days
// on Free returns 7, it does not return an error and it does not return 365. Deployment history
// comes from data Thrallo already had (diag_runs, published_sites), so it works from the first
// publish with nothing to collect.

import { serviceClient } from "../supabase.mjs";
import { ownerSubscription } from "../usageBudgets.mjs";

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

const sumOf = (rows) => rows.reduce((acc, r) => ({
  pageviews: acc.pageviews + r.pageviews,
  visitors: acc.visitors + r.visitors,
  sessions: acc.sessions + r.sessions,
  errors: acc.errors + r.errors,
}), { pageviews: 0, visitors: 0, sessions: 0, errors: 0 });

// Percentage change, or null when there is nothing to compare against. Zero → anything is not
// "infinite growth", it is a period with no previous data, and saying so is more useful than a
// number nobody can act on.
function changeBetween(current, previous) {
  const out = {};
  for (const key of Object.keys(current)) {
    const before = previous[key];
    out[key] = before > 0 ? Number((((current[key] - before) / before) * 100).toFixed(1)) : null;
  }
  return out;
}

export async function overview(owner, projectId, {
  days = 30, client = serviceClient(), store = null, now = new Date(),
} = {}) {
  const subscription = await ownerSubscription(owner, store ? { store } : {});
  const capabilities = analyticsCapabilities(subscription.plan);
  const window = resolveWindow({ requestedDays: days, plan: subscription.plan, now });

  const project = await ownedProject(owner, projectId, client);
  if (!project) return { capabilities, window, ...emptyOverview(), unavailable: "not_published" };

  // The comparison window is the SAME length immediately before this one, so "up 12%" compares
  // like with like. Clamped to retention: a 90-day comparison on a 7-day plan would silently read
  // an empty period and report a collapse.
  const previousFrom = new Date(Date.parse(`${window.from}T00:00:00Z`) - window.days * 86_400_000)
    .toISOString().slice(0, 10);
  const comparable = capabilities.retentionDays === null || window.days * 2 <= capabilities.retentionDays;

  const { data: rows, error } = await client.from("analytics_daily")
    .select("*").eq("project_id", String(projectId)).eq("owner", owner)
    .gte("day", comparable ? previousFrom : window.from);
  if (error) throw new Error(`analytics read failed: ${error.message || error}`);
  const fetched = rows || [];
  const all = fetched.filter((r) => r.day >= window.from);
  const priorRows = comparable ? fetched.filter((r) => r.day < window.from && r.day >= previousFrom) : [];

  const totalsRows = all.filter((r) => r.dimension === "totals");
  const totals = sumOf(totalsRows);

  // Errors are a paid feature. The count was returned to everyone regardless, so Free saw a number
  // its plan says it does not get — the entitlement existed and nothing consulted it. Null, not
  // zero: "you do not have this" and "there were none" are different answers.
  if (!capabilities.errorReporting) totals.errors = null;

  const previousTotals = sumOf(priorRows.filter((r) => r.dimension === "totals"));
  if (!capabilities.errorReporting) previousTotals.errors = null;

  const series = totalsRows
    .map((r) => ({
      day: r.day,
      pageviews: r.pageviews,
      visitors: r.visitors,
      sessions: r.sessions,
      errors: capabilities.errorReporting ? r.errors : null,
    }))
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

  // Visitors who had more than one session ON THE SAME DAY. Never called "returning visitors":
  // the visitor hash rotates daily and the salts are destroyed, so cross-day identity does not
  // exist by construction and claiming it would be a lie about the privacy model.
  const returningRows = all.filter((r) => r.dimension === "returning");
  const sameDayReturning = returningRows.reduce((n, r) => n + r.visitors, 0);

  return {
    capabilities,
    window: {
      ...window,
      // What the comparison is against, so the UI can name the period rather than say "previous".
      previousFrom: comparable ? previousFrom : null,
      comparable,
    },
    totals,
    // Absent rather than fabricated when the plan cannot see back far enough to compare.
    previous: comparable ? previousTotals : null,
    change: comparable ? changeBetween(totals, previousTotals) : null,
    series,
    vitals,
    sameDayReturning: {
      visitors: sameDayReturning,
      // Stated in the payload, not only in the UI, so an export carries the caveat too.
      note: "Visitors with more than one session on the same day. Cross-day visitor identity is deliberately not tracked.",
    },
    topPages: rank(all, "path"),
    referrers: rank(all, "referrer"),
    // The breakdowns are what Starter adds; Free gets the headline numbers and the trend.
    browsers: capabilities.fullAnalytics ? rank(all, "browser") : [],
    operatingSystems: capabilities.fullAnalytics ? rank(all, "os") : [],
    devices: capabilities.fullAnalytics ? rank(all, "device") : [],
    // The error breakdown, which now survives the raw-event prune. Gated by the same entitlement
    // as the count, so a Free account cannot read through the headline to the detail.
    errors: capabilities.errorReporting
      ? all.filter((r) => r.dimension === "error")
        .reduce((acc, r) => {
          const found = acc.find((e) => e.key === r.key);
          if (found) { found.errors += r.errors; found.visitors += r.visitors; return acc; }
          return acc.concat({ key: r.key, errors: r.errors, visitors: r.visitors });
        }, [])
        .sort((a, b) => b.errors - a.errors).slice(0, 20)
      : null,
    // Countries need MaxMind GeoLite2 and there is no licence key. Reported as unavailable rather
    // than inferred from language or timezone, which would be a guess presented as a fact.
    countries: { available: false, reason: "geoip_unconfigured" },
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

// deployments() lived here and presented diag_runs — diagnostic BUILD runs — as deployment
// history. PR 8 replaced its route with real deployment records and left this behind; nothing
// imported it afterwards. Deleted rather than kept, because an unused reader of the wrong table
// is one import away from coming back.
