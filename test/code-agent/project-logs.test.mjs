// Project logs.
//
// Logs merge three sources that already existed rather than copying them into a fourth table, so
// the interesting failures are in the merge: one noisy source starving the others out of a page,
// a cursor that skips or repeats rows as new lines arrive, and a CSV export that breaks on the
// first stack trace.

import assert from "node:assert/strict";
import test from "node:test";

import { readLogs, readSince, toCsv, LEVELS, SOURCES } from "../../shell/server/lib/logs/logReader.mjs";
import { MemoryCodeAgentStore } from "../../shell/server/lib/codeAgentStore.mjs";

process.env.CODE_AGENT_STORE = "memory";

const OWNER = "77777777-7777-4777-8777-777777777777";
const PROJECT = "p1";
const NOW = new Date("2026-08-03T12:00:00Z");

async function storeOn(plan = "pro") {
  const store = new MemoryCodeAgentStore();
  await store.upsertSubscription(OWNER, { plan, status: "active" });
  return store;
}

const at = (minutesAgo) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();

function fakeDb({ lifecycle = [], errors = [], steps = [] } = {}) {
  const applied = [];
  return {
    applied,
    from(table) {
      const filters = { table };
      const api = {
        select() { return api; },
        eq(c, v) { filters[c] = v; return api; },
        in(c, v) { filters[`in_${c}`] = v; return api; },
        gte(c, v) { filters[`gte_${c}`] = v; return api; },
        lt(c, v) { filters[`lt_${c}`] = v; return api; },
        order() { return api; },
        limit(n) { filters.limit = n; return api; },
        // A real PostgREST builder is a thenable whose `then` returns a PROMISE, so callers can
        // chain `.catch(...)` after it. A fake that returned the callback's value instead would
        // pass every assertion here while the library crashed in production.
        then(onFulfilled, onRejected) {
          applied.push(filters);
          const source = table === "project_logs" ? lifecycle
            : table === "analytics_events" ? errors
              : steps;
          const timeKey = table === "project_logs" ? "logged_at"
            : table === "analytics_events" ? "occurred_at" : "started_at";
          let rows = source.filter((r) => r.owner === filters.owner);
          if (filters[`gte_${timeKey}`]) rows = rows.filter((r) => r[timeKey] >= filters[`gte_${timeKey}`]);
          if (filters[`lt_${timeKey}`]) rows = rows.filter((r) => r[timeKey] < filters[`lt_${timeKey}`]);
          if (filters.in_source) rows = rows.filter((r) => filters.in_source.includes(r.source));
          rows = [...rows].sort((a, b) => (a[timeKey] < b[timeKey] ? 1 : -1)).slice(0, filters.limit || 100);
          return Promise.resolve({ data: rows, error: null }).then(onFulfilled, onRejected);
        },
      };
      return api;
    },
  };
}

const lifecycleRow = (over = {}) => ({
  id: 1, owner: OWNER, project_id: PROJECT, logged_at: at(5), level: "info",
  source: "publish", message: "Publish started", detail: null, ref_type: null, ref_id: null,
  duration_ms: null, ...over,
});
const errorRow = (over = {}) => ({
  id: 1, owner: OWNER, project_id: PROJECT, occurred_at: at(10), kind: "error",
  error_message: "Cannot read properties of undefined", error_source: "app.js:42",
  error_stack: "TypeError\n  at x", path: "/dashboard", browser: "Chrome", os: "Windows",
  status_code: null, request_url: null, request_method: null, ...over,
});

// ── Merging ─────────────────────────────────────────────────────────────────────────────

test("lifecycle, runtime and build entries arrive in one stream, newest first", async () => {
  const store = await storeOn();
  const db = fakeDb({
    lifecycle: [lifecycleRow({ logged_at: at(1) })],
    errors: [errorRow({ occurred_at: at(2) })],
    steps: [{ id: 9, owner: OWNER, project_id: PROJECT, started_at: at(3), agent: "Builder", name: "compile", status: "passed" }],
  });
  const { entries } = await readLogs(OWNER, PROJECT, { client: db, store, now: NOW });
  assert.deepEqual(entries.map((e) => e.source), ["publish", "runtime", "build"]);
  assert.ok(entries[0].at > entries[1].at, "newest first");
});

test("ids are namespaced so two sources cannot collide", async () => {
  // Every source has its own id sequence starting at 1; without a prefix the client would treat
  // build step 1 and log line 1 as the same entry and drop one.
  const store = await storeOn();
  const db = fakeDb({ lifecycle: [lifecycleRow({ id: 1 })], errors: [errorRow({ id: 1 })] });
  const { entries } = await readLogs(OWNER, PROJECT, { client: db, store, now: NOW });
  assert.equal(new Set(entries.map((e) => e.id)).size, entries.length);
});

test("each source is queried for a full page, so a noisy one cannot starve the others", async () => {
  const store = await storeOn();
  const db = fakeDb({ lifecycle: [lifecycleRow()], errors: [errorRow()] });
  await readLogs(OWNER, PROJECT, { client: db, store, limit: 50, now: NOW });
  for (const query of db.applied) {
    assert.equal(query.limit, 50, `${query.table} must fetch a full page before the merge`);
  }
});

// ── Severity ────────────────────────────────────────────────────────────────────────────

test("a 404 is a warning; a failed request is an error; a 5xx is critical", async () => {
  // A missing page is usually a bad link, not a broken site. Colouring them all red makes the
  // filter useless.
  const store = await storeOn();
  const db = fakeDb({ errors: [
    errorRow({ id: 1, status_code: 404, request_url: "/missing", occurred_at: at(1) }),
    errorRow({ id: 2, status_code: 403, request_url: "/api/thing", occurred_at: at(2) }),
    errorRow({ id: 3, status_code: 500, request_url: "/api/thing", occurred_at: at(3) }),
  ] });
  const { entries } = await readLogs(OWNER, PROJECT, { client: db, store, now: NOW });
  assert.deepEqual(entries.map((e) => e.level), ["warning", "error", "critical"]);
  assert.deepEqual(entries.map((e) => e.source), ["visitor", "visitor", "visitor"]);
});

test("an uncaught exception is a runtime entry, not a visitor one", async () => {
  const store = await storeOn();
  const db = fakeDb({ errors: [errorRow()] });
  const { entries } = await readLogs(OWNER, PROJECT, { client: db, store, now: NOW });
  assert.equal(entries[0].source, "runtime");
  assert.match(entries[0].detail, /app\.js:42/);
  assert.match(entries[0].detail, /Chrome on Windows/);
});

// ── Filters ─────────────────────────────────────────────────────────────────────────────

test("filtering by level and by source both narrow the stream", async () => {
  const store = await storeOn();
  const db = fakeDb({
    lifecycle: [lifecycleRow({ id: 1, level: "error", message: "Publish failed" }), lifecycleRow({ id: 2, level: "info" })],
    errors: [errorRow()],
  });
  const errorsOnly = await readLogs(OWNER, PROJECT, { client: db, store, levels: ["error"], now: NOW });
  assert.ok(errorsOnly.entries.every((e) => e.level === "error"));

  const publishOnly = await readLogs(OWNER, PROJECT, { client: db, store, sources: ["publish"], now: NOW });
  assert.ok(publishOnly.entries.every((e) => e.source === "publish"));
  assert.ok(!publishOnly.entries.some((e) => e.source === "runtime"), "analytics is not queried when not asked for");
});

test("search matches the message and the detail", async () => {
  const store = await storeOn();
  const db = fakeDb({ lifecycle: [
    lifecycleRow({ id: 1, message: "Publish failed", detail: "ENOSPC: no space left on device" }),
    lifecycleRow({ id: 2, message: "Publish started" }),
  ] });
  const byMessage = await readLogs(OWNER, PROJECT, { client: db, store, search: "failed", now: NOW });
  assert.equal(byMessage.entries.length, 1);
  // A stack trace or build output is exactly where the useful string usually is.
  const byDetail = await readLogs(OWNER, PROJECT, { client: db, store, search: "ENOSPC", now: NOW });
  assert.equal(byDetail.entries.length, 1);
});

// ── Pagination and streaming ────────────────────────────────────────────────────────────

test("the cursor is a timestamp, so new lines cannot shift a page", async () => {
  // With an offset, a line arriving between requests would push a row across the boundary and it
  // would be shown twice or not at all.
  const store = await storeOn();
  const rows = Array.from({ length: 5 }, (_, i) => lifecycleRow({ id: i + 1, logged_at: at(i + 1) }));
  const db = fakeDb({ lifecycle: rows });
  const first = await readLogs(OWNER, PROJECT, { client: db, store, limit: 2, now: NOW });
  assert.equal(first.entries.length, 2);
  assert.equal(first.nextCursor, first.entries[1].at);

  const second = await readLogs(OWNER, PROJECT, { client: db, store, limit: 2, before: first.nextCursor, now: NOW });
  assert.ok(second.entries.every((e) => e.at < first.nextCursor), "the next page continues from exactly there");
});

test("the last page reports no cursor", async () => {
  const store = await storeOn();
  const db = fakeDb({ lifecycle: [lifecycleRow()] });
  const { nextCursor } = await readLogs(OWNER, PROJECT, { client: db, store, limit: 50, now: NOW });
  assert.equal(nextCursor, null);
});

test("the stream returns only what is newer, oldest first", async () => {
  const store = await storeOn();
  const db = fakeDb({ lifecycle: [
    lifecycleRow({ id: 1, logged_at: at(10) }),
    lifecycleRow({ id: 2, logged_at: at(1) }),
  ] });
  const { entries } = await readSince(OWNER, PROJECT, at(5), { client: db, store, now: NOW });
  assert.equal(entries.length, 1);
  // Oldest first, so appending to a live view keeps the order a reader expects.
  assert.equal(entries[0].id, "l:2");
});

// ── Retention ───────────────────────────────────────────────────────────────────────────

test("logs follow the plan's retention", async () => {
  // A plan keeping 7 days of traffic should not quietly keep 90 days of errors.
  const free = await storeOn("free");
  const db = fakeDb({ lifecycle: [lifecycleRow()] });
  const result = await readLogs(OWNER, PROJECT, { client: db, store: free, now: NOW });
  assert.equal(result.retentionDays, 7);
  const floor = db.applied.find((q) => q.table === "project_logs").gte_logged_at;
  assert.ok(floor && Date.parse(floor) > NOW.getTime() - 8 * 86_400_000);

  const pro = await storeOn("pro");
  const unlimited = await readLogs(OWNER, PROJECT, { client: fakeDb({ lifecycle: [lifecycleRow()] }), store: pro, now: NOW });
  assert.equal(unlimited.retentionDays, null);
});

// ── Export ──────────────────────────────────────────────────────────────────────────────

test("CSV survives commas, quotes and stack traces", async () => {
  const csv = toCsv([
    { at: "2026-08-03T12:00:00Z", level: "error", source: "build", message: 'Failed: "compile", step 2', detail: "line 1\nline 2", refId: null, durationMs: 1200 },
  ]);
  assert.ok(csv.startsWith("timestamp,level,source,message,detail,reference,duration_ms\n"));
  // Doubled quotes and a quoted newline are what keep a spreadsheet from splitting the row.
  // Asserted against the whole document, not a line: a correct CSV row CONTAINS newlines, which
  // is precisely the case naive splitting gets wrong.
  assert.ok(csv.includes('"Failed: ""compile"", step 2"'));
  assert.ok(csv.includes('"line 1\nline 2"'));
  assert.ok(csv.trimEnd().endsWith('"1200"'));
});

test("the vocabulary the UI filters on matches the reader", () => {
  assert.deepEqual([...LEVELS], ["info", "warning", "error", "critical"]);
  for (const source of ["publish", "deploy", "build", "domain", "system", "runtime", "visitor"]) {
    assert.ok(SOURCES.includes(source), `${source} must be filterable`);
  }
});
