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
// Build outputs over 16KB are stored gzipped, and the diagnostics sweeper compresses every
// output on runs older than seven days. Reading `output` alone therefore showed an empty detail
// for exactly the builds someone is most likely to be digging through.
import { unpackOutput } from "../appBuild/buildDiagnostics.mjs";
import { buildRunsFor } from "./buildRuns.mjs";
import { VISITOR_SOURCES } from "../../../shared/logSources.mjs";

// One list, shared with the web app so a filter chip and the server cannot disagree about what
// a source is called.
export { LOG_SOURCE_IDS as SOURCES, LOG_LEVEL_IDS as LEVELS } from "../../../shared/logSources.mjs";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
// One run, read whole. A long build can run to hundreds of steps and a deep link into it must show
// the build, not the first page of it — this is a sanity bound, not a display limit.
const MAX_STEPS_PER_RUN = 2_000;

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

/**
 * A build step, as the log stream sees it.
 *
 * The columns here are the ones diag_steps actually has. The previous version read `row.name`,
 * `row.step`, `row.summary` and `row.ok` — none of which exist on that table — so even had the
 * query worked, every line would have read "Build — step" with no detail.
 *
 * `seq` is carried through because it, not the timestamp, is the true order within a run: steps
 * are written in a chained batch and several can share a millisecond.
 */
function fromBuildStep(row) {
  const failed = row.status === "failed";
  const output = unpackOutput(row);
  return {
    id: `b:${row.id}`,
    at: row.started_at || row.created_at,
    seq: Number.isFinite(row.seq) ? row.seq : null,
    level: failed ? "error" : "info",
    source: "build",
    message: `${row.agent || "Build"} — ${row.label || row.kind || "step"}`,
    detail: output ? String(output).slice(0, 8_000) : null,
    refType: "build",
    refId: row.run_id ? String(row.run_id) : null,
    durationMs: row.duration_ms || null,
  };
}

export { buildRunsFor } from "./buildRuns.mjs";

/**
 * One page of merged logs, newest first.
 *
 * Each source is queried for `limit` rows and the merge takes the newest `limit` overall, so a
 * burst from one source cannot starve the others out of the page.
 */
export async function readLogs(owner, projectId, {
  client = serviceClient(), store = null, limit = DEFAULT_LIMIT, before = null,
  sources = null, levels = null, search = "", since = null, now = new Date(), ref = null,
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
  // A build reference narrows the whole view to ONE run — the deep link from Deployments, and what
  // "view the logs for this deployment" has to mean if it is to be a link at all.
  const onlyRun = ref ? String(ref) : null;

  // Reading a page must never invent an empty log out of a database failure. `readOrThrow` names
  // the source in the message so an operator knows which one broke; the route turns that into a
  // 500 the UI shows as an error, rather than a log that reads "nothing has happened here".
  const readOrThrow = async (label, query) => {
    const { data, error } = await query;
    if (error) throw new Error(`logs: could not read ${label}: ${error.message}`);
    return data || [];
  };

  const queries = [];

  // Lifecycle rows are not per-run, so a build reference excludes them unless they point at it.
  if (!onlyRun && (wanted("publish") || wanted("deploy") || wanted("build") || wanted("domain") || wanted("system"))) {
    let q = client.from("project_logs").select("*")
      .eq("owner", owner).eq("project_id", String(projectId))
      .order("logged_at", { ascending: false }).limit(size);
    if (from) q = q.gte("logged_at", from);
    if (cursor) q = q.lt("logged_at", cursor);
    if (sources?.length) q = q.in("source", sources.filter((s) => !VISITOR_SOURCES.includes(s)));
    queries.push(readOrThrow("lifecycle logs", q).then((rows) => rows.map(fromLifecycle)));
  } else if (onlyRun) {
    let q = client.from("project_logs").select("*")
      .eq("owner", owner).eq("project_id", String(projectId)).eq("ref_id", onlyRun)
      .order("logged_at", { ascending: false }).limit(size);
    queries.push(readOrThrow("lifecycle logs", q).then((rows) => rows.map(fromLifecycle)));
  }

  if (!onlyRun && (wanted("runtime") || wanted("visitor"))) {
    let q = client.from("analytics_events").select("*")
      .eq("owner", owner).eq("project_id", String(projectId)).eq("kind", "error")
      .order("occurred_at", { ascending: false }).limit(size);
    if (from) q = q.gte("occurred_at", from);
    if (cursor) q = q.lt("occurred_at", cursor);
    queries.push(readOrThrow("runtime errors", q).then((rows) => rows.map(fromAnalytics)));
  }

  if (wanted("build")) {
    queries.push((async () => {
      // Runs first — that is where `owner` lives. A reference is honoured only if it belongs to
      // this owner and project, so a deep link cannot be edited into someone else's build.
      const runs = await buildRunsFor(owner, projectId, { client });
      const ids = runs.map((r) => String(r.id)).filter((id) => !onlyRun || id === onlyRun);
      if (!ids.length) return [];

      // A single run is read whole: a long build's steps must not be truncated at the page size
      // and then re-sorted into a partial, misleading sequence.
      let q = client.from("diag_steps")
        .select("id,run_id,seq,agent,kind,label,status,output,output_gz,started_at,created_at,duration_ms")
        .in("run_id", ids)
        .order("started_at", { ascending: false })
        .order("seq", { ascending: false })
        .limit(onlyRun ? MAX_STEPS_PER_RUN : size);
      if (from) q = q.gte("started_at", from);
      if (cursor && !onlyRun) q = q.lt("started_at", cursor);
      return (await readOrThrow("build steps", q)).map(fromBuildStep);
    })());
  }

  const merged = (await Promise.all(queries)).flat().filter((row) => row.at);

  const needle = String(search || "").trim().toLowerCase();
  const filtered = merged
    .filter((row) => !levels?.length || levels.includes(row.level))
    .filter((row) => !needle
      || row.message.toLowerCase().includes(needle)
      || String(row.detail || "").toLowerCase().includes(needle));

  // A single run is returned WHOLE. Capping it at the page size and then re-sorting would show a
  // partial sequence, which for a build log reads as a build that stopped early — the page limit
  // exists to keep a busy project's stream manageable, not to truncate one build someone asked to
  // see in full.
  const page = onlyRun
    ? filtered.sort(newestFirst)
    : filtered.sort(newestFirst).slice(0, size);

  return {
    entries: page,
    // The cursor is the oldest row returned, so the next page continues from exactly here. A
    // single run is returned whole, so there is nothing after it to page to.
    nextCursor: !onlyRun && page.length === size ? page[page.length - 1].at : null,
    retentionDays: retention,
    plan: subscription.plan,
    ref: onlyRun,
  };
}

/**
 * Newest first, with `seq` breaking ties.
 *
 * Timestamps alone are not enough. Build steps are written in a chained batch and several
 * routinely share the same millisecond, so sorting on time only let a long build's steps come back
 * in an order it never ran in — the one thing a build log must never do.
 */
function newestFirst(a, b) {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  if (a.seq != null && b.seq != null && a.seq !== b.seq) return b.seq - a.seq;
  return 0;
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
