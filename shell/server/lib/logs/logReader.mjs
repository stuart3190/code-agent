// Reading project logs.
//
// Three sources, one stream. Lifecycle events come from project_logs, runtime and visitor errors
// from analytics_events (where they were already being collected), and build detail from
// diag_steps. Merging on read rather than copying on write means there is exactly one version of
// each fact — a build log cannot say one thing in diagnostics and another in logs.
//
// Pagination is by timestamp cursor rather than offset, because new lines arrive constantly and an
// offset would silently skip or repeat rows as the list shifts underneath it.

import { serviceClient } from "../supabase.mjs";
import { ownerSubscription } from "../usageBudgets.mjs";
import { retentionFor } from "../analytics/reports.mjs";

export const SOURCES = Object.freeze(["publish", "deploy", "build", "domain", "system", "runtime", "visitor"]);
export const LEVELS = Object.freeze(["info", "warning", "error", "critical"]);

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

// A failed request is an error; a 404 is a warning, because a missing page is usually a bad link
// rather than a broken site. Distinguishing them is the difference between a useful filter and
// a wall of red.
function levelForVisitorEvent(row) {
  if (row.status_code === 404) return "warning";
  if (row.status_code >= 500) return "critical";
  if (row.status_code >= 400) return "error";
  return "error";
}

function fromAnalytics(row) {
  const isRequest = !!row.request_url;
  return {
    id: `a:${row.id}`,
    at: row.occurred_at,
    level: levelForVisitorEvent(row),
    source: isRequest ? "visitor" : "runtime",
    message: row.error_message || "Client error",
    detail: [
      row.error_source ? `at ${row.error_source}` : null,
      row.request_url ? `${row.request_method || "GET"} ${row.request_url}` : null,
      row.status_code ? `status ${row.status_code}` : null,
      row.path ? `page ${row.path}` : null,
      row.browser ? `${row.browser} on ${row.os}` : null,
      row.error_stack || null,
    ].filter(Boolean).join("\n"),
    refType: null,
    refId: null,
    durationMs: null,
  };
}

function fromLifecycle(row) {
  return {
    id: `l:${row.id}`,
    at: row.logged_at,
    level: row.level,
    source: row.source,
    message: row.message,
    detail: row.detail,
    refType: row.ref_type,
    refId: row.ref_id,
    durationMs: row.duration_ms,
  };
}

function fromBuildStep(row) {
  const failed = row.status === "failed" || row.ok === false;
  return {
    id: `b:${row.id}`,
    at: row.started_at || row.created_at,
    level: failed ? "error" : "info",
    source: "build",
    message: `${row.agent || "Build"} — ${row.name || row.step || "step"}`,
    detail: [row.summary, row.output].filter(Boolean).join("\n").slice(0, 8_000) || null,
    refType: "build",
    refId: row.run_id ? String(row.run_id) : null,
    durationMs: row.duration_ms || null,
  };
}

/**
 * One page of merged logs, newest first.
 *
 * Each source is queried for `limit` rows and the merge takes the newest `limit` overall, so a
 * burst from one source cannot starve the others out of the page.
 */
export async function readLogs(owner, projectId, {
  client = serviceClient(), store = null, limit = DEFAULT_LIMIT, before = null,
  sources = null, levels = null, search = "", since = null, now = new Date(),
} = {}) {
  const size = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT));
  const subscription = await ownerSubscription(owner, store ? { store } : {});
  const retention = retentionFor(subscription.plan);

  // Logs follow the same retention as analytics: a plan that keeps 7 days of traffic should not
  // quietly keep 90 days of errors.
  const floor = retention === null ? null : new Date(now.getTime() - retention * 86_400_000).toISOString();
  const from = [since, floor].filter(Boolean).sort().pop() || null;
  const cursor = before || null;

  const wanted = (source) => !sources?.length || sources.includes(source);

  const queries = [];

  if (wanted("publish") || wanted("deploy") || wanted("build") || wanted("domain") || wanted("system")) {
    let q = client.from("project_logs").select("*")
      .eq("owner", owner).eq("project_id", String(projectId))
      .order("logged_at", { ascending: false }).limit(size);
    if (from) q = q.gte("logged_at", from);
    if (cursor) q = q.lt("logged_at", cursor);
    if (sources?.length) q = q.in("source", sources.filter((s) => s !== "runtime" && s !== "visitor"));
    queries.push(q.then(({ data }) => (data || []).map(fromLifecycle)));
  }

  if (wanted("runtime") || wanted("visitor")) {
    let q = client.from("analytics_events").select("*")
      .eq("owner", owner).eq("project_id", String(projectId)).eq("kind", "error")
      .order("occurred_at", { ascending: false }).limit(size);
    if (from) q = q.gte("occurred_at", from);
    if (cursor) q = q.lt("occurred_at", cursor);
    queries.push(q.then(({ data }) => (data || []).map(fromAnalytics)));
  }

  if (wanted("build")) {
    let q = client.from("diag_steps").select("*")
      .eq("owner", owner).eq("project_id", String(projectId))
      .order("started_at", { ascending: false }).limit(size);
    if (from) q = q.gte("started_at", from);
    if (cursor) q = q.lt("started_at", cursor);
    // diag_steps is the richest source and the most likely to be absent on a young project;
    // a failure here must not empty the whole log view.
    queries.push(q.then(({ data }) => (data || []).map(fromBuildStep)).catch(() => []));
  }

  const merged = (await Promise.all(queries)).flat().filter((row) => row.at);

  const needle = String(search || "").trim().toLowerCase();
  const filtered = merged
    .filter((row) => !levels?.length || levels.includes(row.level))
    .filter((row) => !needle
      || row.message.toLowerCase().includes(needle)
      || String(row.detail || "").toLowerCase().includes(needle));

  const page = filtered
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, size);

  return {
    entries: page,
    // The cursor is the oldest row returned, so the next page continues from exactly here.
    nextCursor: page.length === size ? page[page.length - 1].at : null,
    retentionDays: retention,
    plan: subscription.plan,
  };
}

// Anything newer than `after`, oldest first — the shape a live stream wants.
export async function readSince(owner, projectId, after, options = {}) {
  const { entries, ...rest } = await readLogs(owner, projectId, { ...options, limit: 200 });
  const fresh = entries.filter((row) => !after || row.at > after).reverse();
  return { entries: fresh, ...rest };
}

export function toCsv(entries) {
  const escape = (value) => {
    const text = value == null ? "" : String(value);
    // Quote everything: log messages routinely contain commas, quotes and newlines, and a CSV that
    // breaks on the first stack trace is worse than no export.
    return `"${text.replace(/"/g, '""')}"`;
  };
  const header = ["timestamp", "level", "source", "message", "detail", "reference", "duration_ms"];
  return [
    header.join(","),
    ...entries.map((e) => [
      e.at, e.level, e.source, e.message, e.detail, e.refId || "", e.durationMs ?? "",
    ].map(escape).join(",")),
  ].join("\n");
}
