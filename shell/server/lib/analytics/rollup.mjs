// Rolling raw events into daily totals.
//
// Two reasons this exists rather than querying raw events directly. Queries stay cheap no matter
// how much traffic a site gets, and — more importantly — the raw rows can then be deleted while
// the history survives. Aggregates cannot be traced back to a visit, so keeping them for years is
// fine where keeping raw events would not be.

import { serviceClient } from "../supabase.mjs";
import { sweepSalts } from "./visitorIdentity.mjs";
import { errorSignature } from "./scrub.mjs";

// Raw events are held just long enough to roll up and to answer "live visitors". Everything older
// is aggregate-only.
export const RAW_RETENTION_DAYS = 3;
const TICK_MS = 5 * 60_000;

let timer = null;

const dayOf = (iso) => String(iso).slice(0, 10);

function blank() {
  return {
    pageviews: 0, errors: 0, visitors: new Set(), sessions: new Set(),
    lcp: 0, fcp: 0, inp: 0, ttfb: 0, load: 0, cls: 0, vitals: 0,
  };
}

/**
 * Aggregate every event since the last rollup into analytics_daily.
 *
 * Recomputes whole days rather than accumulating deltas: a rollup that runs twice, or after a
 * crash mid-write, must not double-count. Idempotence matters more here than doing less work.
 */
export async function rollupAnalytics({ client = serviceClient(), now = new Date(), sinceDays = RAW_RETENTION_DAYS } = {}) {
  const from = new Date(now.getTime() - sinceDays * 86_400_000).toISOString().slice(0, 10);
  const { data: events, error } = await client.from("analytics_events")
    .select("*").gte("occurred_at", from);
  if (error) throw new Error(`analytics rollup read failed: ${error.message || error}`);
  if (!events?.length) return { days: 0, rows: 0 };

  // key: project|day|dimension|value
  const buckets = new Map();
  const bucket = (row, dimension, key) => {
    const id = `${row.project_id}|${dayOf(row.occurred_at)}|${dimension}|${key ?? ""}`;
    if (!buckets.has(id)) {
      buckets.set(id, { owner: row.owner, project_id: row.project_id, day: dayOf(row.occurred_at), dimension, key: key ?? "", ...blank() });
    }
    return buckets.get(id);
  };

  // visitor → sessions, per project-day. Used only to count how many visitors had more than one
  // session that day; the hashes never leave this function.
  const sessionsByVisitor = new Map();

  for (const row of events) {
    const totals = bucket(row, "totals", "");
    totals.visitors.add(row.visitor_hash);
    totals.sessions.add(row.session_hash);

    const dayKey = `${row.project_id}|${dayOf(row.occurred_at)}`;
    if (!sessionsByVisitor.has(dayKey)) sessionsByVisitor.set(dayKey, new Map());
    const perVisitor = sessionsByVisitor.get(dayKey);
    if (!perVisitor.has(row.visitor_hash)) perVisitor.set(row.visitor_hash, new Set());
    perVisitor.get(row.visitor_hash).add(row.session_hash);

    if (row.kind === "pageview") {
      totals.pageviews += 1;
      for (const [dimension, value] of [
        ["path", row.path], ["referrer", row.referrer_host],
        ["browser", row.browser], ["os", row.os], ["device", row.device],
      ]) {
        if (!value) continue;
        const b = bucket(row, dimension, value);
        b.pageviews += 1;
        b.visitors.add(row.visitor_hash);
      }
    }

    if (row.kind === "error") {
      totals.errors += 1;
      // The error DETAIL, aggregated so it survives the three-day raw prune. Without this the
      // count outlived the messages, so "14 errors last month" could never be investigated.
      // The key is a signature, not the raw message: already scrubbed at ingest, and further
      // generalised so the same fault at two line numbers groups together.
      const signature = errorSignature(row.error_message);
      const detail = bucket(row, "error", signature);
      detail.errors += 1;
      detail.visitors.add(row.visitor_hash);
      // One representative source, kept for context. Paths only — the query string went at ingest.
      if (!detail.sample && row.error_source) detail.sample = row.error_source;
    }

    if (row.kind === "vitals") {
      totals.vitals += 1;
      totals.lcp += row.lcp_ms || 0;
      totals.fcp += row.fcp_ms || 0;
      totals.inp += row.inp_ms || 0;
      totals.ttfb += row.ttfb_ms || 0;
      totals.cls += Number(row.cls || 0);
    }
    if (row.kind === "pageview" && row.load_ms) totals.load += row.load_ms;
  }

  // Same-day returning: visitors who had more than one session on that day. This is the ONLY
  // returning figure the design can honestly produce — the visitor hash rotates daily and the
  // salts are destroyed, so the same person is a different hash tomorrow by construction.
  for (const [dayKey, perVisitor] of sessionsByVisitor) {
    const [projectId, day] = dayKey.split("|");
    const sample = events.find((e) => String(e.project_id) === projectId && dayOf(e.occurred_at) === day);
    if (!sample) continue;
    const returning = [...perVisitor.values()].filter((sessions) => sessions.size > 1);
    const b = bucket(sample, "returning", "");
    b.visitors = new Set(returning.map((_, i) => `v${i}`));   // size is the count; hashes never stored
    b.sessions = new Set(returning.flatMap((s, i) => [...s].map((_, j) => `s${i}-${j}`)));
  }

  const rows = [...buckets.values()].map((b) => ({
    owner: b.owner, project_id: b.project_id, day: b.day, dimension: b.dimension, key: b.key,
    pageviews: b.pageviews, errors: b.errors,
    visitors: b.visitors.size, sessions: b.sessions.size,
    lcp_sum: b.lcp, fcp_sum: b.fcp, inp_sum: b.inp, ttfb_sum: b.ttfb, load_sum: b.load,
    cls_sum: Number(b.cls.toFixed(4)), vitals_count: b.vitals,
    updated_at: new Date().toISOString(),
  }));

  const { error: writeError } = await client.from("analytics_daily")
    .upsert(rows, { onConflict: "project_id,day,dimension,key" });
  if (writeError) throw new Error(`analytics rollup write failed: ${writeError.message || writeError}`);

  return { days: new Set(rows.map((r) => r.day)).size, rows: rows.length };
}

// Delete raw events past their window, and the salts that made them. After this, the remaining
// aggregates cannot be tied to any individual visit even in principle.
export async function pruneRawEvents({ client = serviceClient(), now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - RAW_RETENTION_DAYS * 86_400_000).toISOString();
  const { error } = await client.from("analytics_events").delete().lt("occurred_at", cutoff);
  if (error) throw new Error(`analytics prune failed: ${error.message || error}`);
  await sweepSalts(client, now);
  return { before: cutoff };
}

export async function analyticsMaintenance(options = {}) {
  const rolled = await rollupAnalytics(options);
  const pruned = await pruneRawEvents(options);
  return { ...rolled, ...pruned };
}

export function startAnalyticsRollup() {
  if (timer) return;
  timer = setInterval(() => {
    analyticsMaintenance().catch((error) => console.error(`[analytics] ${error?.message || error}`));
  }, TICK_MS);
  timer.unref?.();
}

export function stopAnalyticsRollup() {
  if (timer) clearInterval(timer);
  timer = null;
}
