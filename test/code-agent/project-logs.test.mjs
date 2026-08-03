// Project logs.
//
// Logs merge three sources that already existed rather than copying them into a fourth table, so
// the interesting failures are in the merge: one noisy source starving the others out of a page,
// a cursor that skips or repeats rows as new lines arrive, and a CSV export that breaks on the
// first stack trace.

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

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

/**
 * Stands in for project_logs, analytics_events, diag_runs and diag_steps.
 *
 * The critical detail, and the reason the old fake let a broken reader pass: **diag_steps has no
 * `owner` and no `project_id`**. It links to its run through `run_id` alone. The previous fake
 * modelled steps as owner-scoped rows, which is the schema the broken code assumed rather than the
 * one production has — so the tests agreed with the bug.
 *
 * This version refuses a filter on a column the table does not have, exactly as PostgREST does.
 */
const COLUMNS = {
  project_logs: new Set(["id", "owner", "project_id", "logged_at", "level", "source", "message", "detail", "ref_type", "ref_id", "duration_ms"]),
  analytics_events: new Set(["id", "owner", "project_id", "occurred_at", "kind", "error_message", "error_source", "error_stack", "path", "browser", "os", "status_code", "request_url", "request_method", "visitor_hash"]),
  diag_runs: new Set(["id", "owner", "project_id", "conversation_id", "kind", "status", "started_at", "finished_at", "duration_ms", "repair_rounds"]),
  diag_steps: new Set(["id", "run_id", "seq", "round", "agent", "kind", "label", "status", "output", "output_gz", "started_at", "created_at", "duration_ms"]),
};

function fakeDb({ lifecycle = [], errors = [], steps = [], runs = [], fail = null } = {}) {
  const applied = [];
  return {
    applied,
    from(table) {
      const filters = { table };
      const known = COLUMNS[table];
      const guard = (column) => {
        if (known && !known.has(column)) {
          // What PostgREST actually does, and what the old code walked into on every call.
          const error = new Error(`column ${table}.${column} does not exist`);
          error.code = "42703";
          filters.badColumn = error;
        }
      };
      const api = {
        select() { return api; },
        eq(c, v) { guard(c); filters[c] = v; return api; },
        in(c, v) { guard(c); filters[`in_${c}`] = v; return api; },
        gte(c, v) { guard(c); filters[`gte_${c}`] = v; return api; },
        lt(c, v) { guard(c); filters[`lt_${c}`] = v; return api; },
        order() { return api; },
        limit(n) { filters.limit = n; return api; },
        // A real PostgREST builder is a thenable whose `then` returns a PROMISE, so callers can
        // chain `.catch(...)` after it. A fake that returned the callback's value instead would
        // pass every assertion here while the library crashed in production.
        then(onFulfilled, onRejected) {
          applied.push(filters);
          if (filters.badColumn) {
            return Promise.resolve({ data: null, error: filters.badColumn }).then(onFulfilled, onRejected);
          }
          if (fail && fail === table) {
            return Promise.resolve({ data: null, error: { message: "connection reset" } }).then(onFulfilled, onRejected);
          }
          const source = table === "project_logs" ? lifecycle
            : table === "analytics_events" ? errors
              : table === "diag_runs" ? runs : steps;
          const timeKey = table === "project_logs" ? "logged_at"
            : table === "analytics_events" ? "occurred_at" : "started_at";
          let rows = table === "diag_steps"
            ? source.filter((r) => (filters.in_run_id || []).includes(String(r.run_id)))
            : source.filter((r) => r.owner === filters.owner);
          if (filters[`gte_${timeKey}`]) rows = rows.filter((r) => r[timeKey] >= filters[`gte_${timeKey}`]);
          if (filters[`lt_${timeKey}`]) rows = rows.filter((r) => r[timeKey] < filters[`lt_${timeKey}`]);
          if (filters.in_source) rows = rows.filter((r) => filters.in_source.includes(r.source));
          if (filters.ref_id) rows = rows.filter((r) => String(r.ref_id) === String(filters.ref_id));
          rows = [...rows].sort((a, b) => (a[timeKey] < b[timeKey] ? 1 : -1)).slice(0, filters.limit || 100);
          return Promise.resolve({ data: rows, error: null }).then(onFulfilled, onRejected);
        },
      };
      return api;
    },
  };
}

const RUN = "run-1";
const runRow = (over = {}) => ({
  id: RUN, owner: OWNER, project_id: PROJECT, kind: "app_build", status: "passed",
  started_at: at(6), finished_at: at(4), duration_ms: 120_000, repair_rounds: 0, ...over,
});
const stepRow = (over = {}) => ({
  id: 9, run_id: RUN, seq: 1, agent: "Builder", kind: "log", label: "compile",
  status: "ok", output: null, output_gz: null, started_at: at(3), created_at: at(3),
  duration_ms: null, ...over,
});

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
    runs: [runRow()],
    steps: [stepRow()],
  });
  const { entries } = await readLogs(OWNER, PROJECT, { client: db, store, now: NOW });
  assert.deepEqual(entries.map((e) => e.source), ["publish", "runtime", "build"]);
  assert.ok(entries[0].at > entries[1].at, "newest first");
  assert.equal(entries[2].message, "Builder — compile", "the step's real label, not a placeholder");
  assert.equal(entries[2].refId, RUN, "and it carries the build identity");
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

// ── The build source ────────────────────────────────────────────────────────────────────
//
// The defect this section exists for: diag_steps was queried by `owner` and `project_id`, columns
// that table does not have. Every call errored, a `.catch(() => [])` swallowed it, and the Build
// source rendered as a project that had simply never been built. Two years of build history was
// one unreachable query away the whole time.

test("build steps are resolved through their RUN, never by columns diag_steps lacks", async () => {
  const store = await storeOn();
  const db = fakeDb({ runs: [runRow()], steps: [stepRow()] });
  const { entries } = await readLogs(OWNER, PROJECT, { client: db, store, sources: ["build"], now: NOW });

  assert.equal(entries.length, 1, "the build source returns its steps");
  const stepQuery = db.applied.find((q) => q.table === "diag_steps");
  assert.ok(stepQuery, "diag_steps was queried");
  assert.equal(stepQuery.owner, undefined, "diag_steps has no owner column");
  assert.equal(stepQuery.project_id, undefined, "nor a project_id column");
  assert.deepEqual(stepQuery.in_run_id, [RUN], "it is scoped by the runs that passed the owner check");

  const runQuery = db.applied.find((q) => q.table === "diag_runs");
  assert.equal(runQuery.owner, OWNER, "ownership is proved on the table that carries it");
  assert.equal(runQuery.project_id, PROJECT);
});

test("another owner's run cannot supply steps", async () => {
  const store = await storeOn();
  const db = fakeDb({
    runs: [runRow({ owner: "someone-else" })],
    steps: [stepRow()],
  });
  const { entries } = await readLogs(OWNER, PROJECT, { client: db, store, sources: ["build"], now: NOW });
  assert.deepEqual(entries, [], "no run passes the owner check, so no steps are fetched");
});

test("a compressed build output is readable, not blank", async () => {
  // The sweeper compresses every output on runs older than seven days, and anything over 16KB is
  // stored compressed from the start. Reading `output` alone showed an empty detail for exactly
  // the builds someone is most likely to be digging through.
  const { gzipSync } = await import("node:zlib");
  const store = await storeOn();
  const db = fakeDb({
    runs: [runRow()],
    steps: [stepRow({ output: null, output_gz: gzipSync(Buffer.from("ENOSPC: no space left on device")).toString("base64") })],
  });
  const { entries } = await readLogs(OWNER, PROJECT, { client: db, store, sources: ["build"], now: NOW });
  assert.match(entries[0].detail, /ENOSPC/, "the stored output must survive compression");
});

test("steps sharing a timestamp keep the order they ran in", async () => {
  // Steps are written in a chained batch and several routinely share a millisecond. Sorting on
  // time alone let a long build come back in an order it never ran in.
  const store = await storeOn();
  const sameMoment = at(3);
  const db = fakeDb({
    runs: [runRow()],
    steps: [
      stepRow({ id: 1, seq: 1, label: "plan", started_at: sameMoment }),
      stepRow({ id: 2, seq: 2, label: "build", started_at: sameMoment }),
      stepRow({ id: 3, seq: 3, label: "verify", started_at: sameMoment }),
    ],
  });
  const { entries } = await readLogs(OWNER, PROJECT, { client: db, store, sources: ["build"], now: NOW });
  assert.deepEqual(entries.map((e) => e.message), [
    "Builder — verify", "Builder — build", "Builder — plan",
  ], "newest first means highest seq first when the clock cannot separate them");
});

// ── Deep links ──────────────────────────────────────────────────────────────────────────

test("a build reference narrows every source to that one run", async () => {
  const store = await storeOn();
  const db = fakeDb({
    lifecycle: [lifecycleRow({ id: 1, ref_id: RUN }), lifecycleRow({ id: 2, ref_id: null })],
    errors: [errorRow()],
    runs: [runRow(), runRow({ id: "run-2", started_at: at(20) })],
    steps: [stepRow({ id: 1, run_id: RUN }), stepRow({ id: 2, run_id: "run-2", label: "other" })],
  });
  const { entries, ref } = await readLogs(OWNER, PROJECT, { client: db, store, ref: RUN, now: NOW });

  assert.equal(ref, RUN, "the response says which build it is showing");
  assert.ok(entries.every((e) => e.source !== "runtime" && e.source !== "visitor"),
    "visitor errors are not part of a build");
  assert.ok(!entries.some((e) => e.message.includes("other")), "another run's steps are excluded");
  assert.ok(entries.some((e) => e.refId === RUN), "and this run's are included");
});

test("a reference to a run belonging to someone else resolves to nothing", async () => {
  const store = await storeOn();
  const db = fakeDb({
    runs: [runRow()],                                 // the only run this owner has
    steps: [stepRow({ run_id: "someone-elses-run" })],
  });
  const { entries } = await readLogs(OWNER, PROJECT, {
    client: db, store, ref: "someone-elses-run", sources: ["build"], now: NOW,
  });
  assert.deepEqual(entries, [], "a deep link cannot be edited into another owner's build");
});

test("one run is returned whole, not cut off at the page size", async () => {
  // A long build runs to hundreds of steps. Truncating at the page size and then re-sorting would
  // show a partial sequence that reads as a build that stopped early.
  const store = await storeOn();
  const steps = Array.from({ length: 240 }, (_, i) =>
    stepRow({ id: i + 1, seq: i + 1, label: `step ${i + 1}`, started_at: at(3) }));
  const db = fakeDb({ runs: [runRow()], steps });
  const { entries, nextCursor } = await readLogs(OWNER, PROJECT, {
    client: db, store, ref: RUN, sources: ["build"], limit: 100, now: NOW,
  });
  assert.equal(entries.length, 240, "every step of the build is present");
  assert.equal(nextCursor, null, "and there is no page after a whole run");
});

// ── Failures are operational, never an empty log ────────────────────────────────────────

test("a database failure is raised, never rendered as 'nothing has happened here'", async () => {
  const store = await storeOn();
  for (const table of ["project_logs", "analytics_events", "diag_runs", "diag_steps"]) {
    const db = fakeDb({ runs: [runRow()], steps: [stepRow()], fail: table });
    await assert.rejects(
      () => readLogs(OWNER, PROJECT, { client: db, store, now: NOW }),
      /connection reset/,
      `a failure reading ${table} must surface`,
    );
  }
});

test("no source swallows its own errors", async () => {
  const source = await readFile(fileURLToPath(new URL("../../shell/server/lib/logs/logReader.mjs", import.meta.url)), "utf8");
  assert.doesNotMatch(source, /catch\(\s*\(\)\s*=>\s*\[\]\s*\)/,
    "a catch returning [] is how the build source went missing for months");
  assert.doesNotMatch(source, /\.then\(\(\{ data \}\)/,
    "destructuring only `data` discards the error alongside it");
});

test("analytics no longer reads build runs as though they were deployments", async () => {
  // This used to assert that reports.mjs shared the Logs resolver. The stronger outcome arrived
  // with PR 8: deployment history comes from real deployment records, so reports.mjs has no
  // business reading diag_runs at all. Its deployments() lingered afterwards with no caller and
  // was deleted — an unused reader of the wrong table is one import away from coming back.
  const reports = await readFile(fileURLToPath(new URL("../../shell/server/lib/analytics/reports.mjs", import.meta.url)), "utf8");
  assert.doesNotMatch(reports, /export async function deployments/);
  assert.doesNotMatch(reports, /from\("diag_runs"\)/, "no direct query either");
  assert.doesNotMatch(reports, /buildRunsFor/, "and nothing left importing the resolver");

  // Deployment history now comes from the deployment records themselves.
  const route = await readFile(fileURLToPath(new URL("../../shell/server/routes/deployments.mjs", import.meta.url)), "utf8");
  assert.match(route, /listDeployments/);
});
