// Deployments: a real publish history rather than a reformatted list of build runs.
//
// The behaviour that matters is what is NOT destroyed. published_sites holds one row per project
// and is overwritten on every publish, so before this there was no record of the previous
// deployment — nothing to roll back to, and no answer to "what was live last Tuesday".

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  openDeployment, markBuilt, markLive, markFailed, listDeployments, getDeployment,
  assertBelongsTo, publicDeployment, DEPLOY_STATUS,
} from "../../shell/server/lib/deployments/deploymentService.mjs";

const OWNER = "88888888-8888-4888-8888-888888888888";
const PROJECT = "proj-1";
const PRODUCT = "prod-1";

// A fake that behaves like PostgREST where it matters: a unique index that actually refuses a
// duplicate, so the number-allocation race is exercised rather than assumed away.
function fakeDb({ rows = [], projects = [{ id: PROJECT, owner: OWNER, product_id: PRODUCT }] } = {}) {
  const store = rows.map((r) => ({ ...r }));
  return {
    rows: store,
    from(table) {
      const filters = {};
      const list = [];
      let pending = null;
      let ordering = null;
      let limitTo = null;
      const api = {
        select() { return api; },
        eq(c, v) { filters[c] = v; return api; },
        is(c, v) { filters[c] = v; return api; },
        in(c, v) { filters[`in_${c}`] = v; return api; },
        order(c, o) { ordering = { column: c, asc: o?.ascending !== false }; return api; },
        limit(n) { limitTo = n; return api; },
        insert(row) { list.push(row); return api; },
        update(patch) { pending = patch; return api; },
        _match() {
          const source = table === "projects" ? projects : store;
          return source.filter((r) => Object.entries(filters).every(([k, v]) => {
            if (k.startsWith("in_")) return v.includes(r[k.slice(3)]);
            if (v === null) return r[k] == null;
            return String(r[k]) === String(v);
          }));
        },
        _rows() {
          let out = api._match();
          if (ordering) {
            out = [...out].sort((a, b) => {
              const x = a[ordering.column]; const y = b[ordering.column];
              return (x < y ? -1 : x > y ? 1 : 0) * (ordering.asc ? 1 : -1);
            });
          }
          if (pending) { for (const row of out) Object.assign(row, pending); pending = null; }
          if (limitTo != null) out = out.slice(0, limitTo);
          return out;
        },
        single: async () => {
          if (list.length) {
            const row = { id: `d${store.length + 1}`, created_at: new Date().toISOString(), ...list[0] };
            // The unique (owner, app, number) index, enforced.
            const clash = store.some((r) => r.owner === row.owner && r.number === row.number
              && String(r.product_id || r.project_id) === String(row.product_id || row.project_id));
            if (clash) return { data: null, error: { message: "duplicate key value violates unique constraint" } };
            store.push(row);
            return { data: row, error: null };
          }
          return { data: api._rows()[0] || null, error: null };
        },
        maybeSingle: async () => ({ data: api._rows()[0] || null, error: null }),
        then(resolve) {
          if (list.length) {
            for (const row of list) store.push({ id: `d${store.length + 1}`, created_at: new Date().toISOString(), ...row });
            list.length = 0;
            return resolve({ data: null, error: null });
          }
          return resolve({ data: api._rows(), error: null });
        },
      };
      return api;
    },
  };
}

const NOW = new Date("2026-08-03T12:00:00Z");
const later = (ms) => new Date(NOW.getTime() + ms);

// ── Numbering and history ───────────────────────────────────────────────────────────────

test("the first publish is #1 and the second is #2, and #1 survives", async () => {
  const db = fakeDb();
  const first = await openDeployment({ owner: OWNER, projectId: PROJECT, productId: PRODUCT, client: db, now: NOW });
  assert.equal(first.deployment.number, 1);
  await markBuilt(first.deployment.id, { client: db, now: later(1000), sourceTree: { "a.js": "one" } });
  await markLive(first.deployment.id, { url: "https://x.thrallo.com/", slug: "x", client: db, now: later(2000) });

  const second = await openDeployment({ owner: OWNER, projectId: PROJECT, productId: PRODUCT, client: db, now: later(10_000) });
  assert.equal(second.deployment.number, 2, "publishing again allocates a new number");
  await markBuilt(second.deployment.id, { client: db, now: later(11_000), sourceTree: { "a.js": "two" } });
  await markLive(second.deployment.id, { url: "https://x.thrallo.com/", slug: "x", client: db, now: later(12_000) });

  const one = db.rows.find((r) => r.number === 1);
  const two = db.rows.find((r) => r.number === 2);
  assert.equal(one.status, DEPLOY_STATUS.superseded, "the previous deployment becomes history, not nothing");
  assert.equal(two.status, DEPLOY_STATUS.live);
  assert.deepEqual(one.source_tree, { "a.js": "one" },
    "and keeps the exact source it published — this is what rollback restores");
});

test("exactly one deployment is live at a time", async () => {
  const db = fakeDb();
  for (let i = 0; i < 3; i += 1) {
    const { deployment } = await openDeployment({ owner: OWNER, projectId: PROJECT, productId: PRODUCT, client: db, now: later(i * 1000) });
    await markBuilt(deployment.id, { client: db, now: later(i * 1000 + 10) });
    await markLive(deployment.id, { url: "https://x/", slug: "x", client: db, now: later(i * 1000 + 20) });
  }
  assert.equal(db.rows.filter((r) => r.status === DEPLOY_STATUS.live).length, 1);
  assert.equal(db.rows.length, 3, "and all three are kept");
});

test("a number collision retries instead of duplicating", async () => {
  // Two publishes both compute "next is 2"; the unique index refuses the loser, which must take 3
  // rather than silently sharing 2.
  const db = fakeDb({ rows: [{ id: "d1", owner: OWNER, project_id: PROJECT, product_id: PRODUCT, number: 1, status: "superseded" }] });
  const a = await openDeployment({ owner: OWNER, projectId: PROJECT, productId: PRODUCT, client: db, now: NOW });
  await markLive(a.deployment.id, { url: "https://x/", slug: "x", client: db, now: NOW });
  const b = await openDeployment({ owner: OWNER, projectId: PROJECT, productId: PRODUCT, client: db, now: NOW });
  assert.notEqual(a.deployment.number, b.deployment.number);
});

// ── Idempotency ─────────────────────────────────────────────────────────────────────────

test("a second click while a publish is in flight joins it rather than opening a rival", async () => {
  const db = fakeDb();
  const first = await openDeployment({ owner: OWNER, projectId: PROJECT, productId: PRODUCT, client: db, now: NOW });
  const again = await openDeployment({ owner: OWNER, projectId: PROJECT, productId: PRODUCT, client: db, now: later(500) });
  assert.equal(again.joined, true);
  assert.equal(again.deployment.id, first.deployment.id);
  assert.equal(db.rows.length, 1, "two rows would make the history lie about how often this shipped");
});

test("a publish abandoned by a dead process stops blocking new ones", async () => {
  const db = fakeDb();
  await openDeployment({ owner: OWNER, projectId: PROJECT, productId: PRODUCT, client: db, now: NOW });
  const next = await openDeployment({
    owner: OWNER, projectId: PROJECT, productId: PRODUCT, client: db, now: later(25 * 60_000),
  });
  assert.equal(next.joined, false, "after the timeout a new publish may proceed");
  assert.equal(db.rows[0].status, DEPLOY_STATUS.failed, "and the abandoned one is recorded honestly");
});

// ── Failure ─────────────────────────────────────────────────────────────────────────────

test("a failed publish is kept, never goes live, and leaves the live one alone", async () => {
  const db = fakeDb();
  const good = await openDeployment({ owner: OWNER, projectId: PROJECT, productId: PRODUCT, client: db, now: NOW });
  await markBuilt(good.deployment.id, { client: db, now: later(10) });
  await markLive(good.deployment.id, { url: "https://x/", slug: "x", client: db, now: later(20) });

  const bad = await openDeployment({ owner: OWNER, projectId: PROJECT, productId: PRODUCT, client: db, now: later(30_000) });
  await markFailed(bad.deployment.id, "ENOSPC: no space left on device", { client: db, now: later(31_000) });

  const failed = db.rows.find((r) => r.id === bad.deployment.id);
  assert.equal(failed.status, DEPLOY_STATUS.failed);
  assert.match(failed.failure_reason, /ENOSPC/, "the reason is recorded, not swallowed");
  assert.equal(db.rows.find((r) => r.id === good.deployment.id).status, DEPLOY_STATUS.live,
    "a failed attempt must never disturb what is serving");
});

// ── Durations ───────────────────────────────────────────────────────────────────────────

test("build and deploy are measured separately, not one total split by guesswork", async () => {
  const db = fakeDb();
  const { deployment } = await openDeployment({ owner: OWNER, projectId: PROJECT, productId: PRODUCT, client: db, now: NOW });
  await markBuilt(deployment.id, { client: db, now: later(4_000) });
  await markLive(deployment.id, { url: "https://x/", slug: "x", client: db, now: later(6_500) });
  const row = db.rows[0];
  assert.equal(row.build_duration_ms, 4_000);
  assert.equal(row.deploy_duration_ms, 2_500);
});

// ── Scope ───────────────────────────────────────────────────────────────────────────────

test("a deployment belonging to another app is refused", async () => {
  const db = fakeDb({
    rows: [{ id: "d9", owner: OWNER, project_id: "other-project", product_id: "other-product", number: 1, status: "superseded" }],
    projects: [{ id: PROJECT, owner: OWNER, product_id: PRODUCT }],
  });
  const foreign = await getDeployment(OWNER, "d9", { client: db });
  await assert.rejects(
    () => assertBelongsTo(OWNER, foreign, PROJECT, { client: db }),
    (e) => e.code === "wrong_app" && e.status === 403,
    "owner scoping alone would let someone roll one of their apps onto another's address",
  );
});

test("another owner's deployment is not readable at all", async () => {
  const db = fakeDb({ rows: [{ id: "d9", owner: "someone-else", project_id: PROJECT, number: 1 }] });
  assert.equal(await getDeployment(OWNER, "d9", { client: db }), null);
});

// ── What is shown ───────────────────────────────────────────────────────────────────────

test("no Git fields are invented", () => {
  const shown = publicDeployment({
    id: "d1", number: 3, status: "live", environment: "production", triggered_by_kind: "user",
    build_run_id: "run-1", created_at: NOW.toISOString(), source_tree: { "a.js": "x" },
  });
  for (const field of ["commit", "commitSha", "branch", "author", "sha", "repository"]) {
    assert.ok(!(field in shown), `${field} must be absent, not null — Thrallo has no repository here`);
  }
  assert.equal(shown.sourceAvailable, true, "whether it can be restored is stated rather than guessed at");
  assert.equal(shown.buildRunId, "run-1", "and the exact build log is addressable");
});

test("history is listed per APP, so a rebuild does not restart the numbering", async () => {
  const db = fakeDb({
    rows: [
      { id: "d1", owner: OWNER, project_id: "old-project", product_id: PRODUCT, number: 1, status: "superseded", created_at: "2026-07-01T00:00:00Z" },
      { id: "d2", owner: OWNER, project_id: PROJECT, product_id: PRODUCT, number: 2, status: "live", created_at: "2026-08-01T00:00:00Z" },
    ],
  });
  const list = await listDeployments(OWNER, PROJECT, { client: db });
  assert.deepEqual(list.map((d) => d.number), [2, 1],
    "a rebuild creates a new project row; its deployments belong to the same history");
});

// ── The old view is gone ────────────────────────────────────────────────────────────────

test("nothing still presents diagnostic build runs as deployments", async () => {
  const analytics = await readFile(fileURLToPath(new URL("../../shell/server/routes/thralloAnalytics.mjs", import.meta.url)), "utf8");
  assert.doesNotMatch(analytics, /export async function handleDeploymentHistory/,
    "an unused reader of the wrong table is one route change away from coming back");

  const view = await readFile(fileURLToPath(new URL("../../shell/web/src/publish/DeploymentsView.jsx", import.meta.url)), "utf8");
  assert.doesNotMatch(view, /repairRounds/, "repair rounds are a property of a build, not a deployment");
  assert.match(view, /Currently serving/, "the live deployment must be unmistakable");
});

test("rollback does not route through the dead Buildr101 release mechanism", async () => {
  const source = await readFile(fileURLToPath(new URL("../../shell/server/lib/appBuild/appPublishService.mjs", import.meta.url)), "utf8");
  const start = source.indexOf("export async function rollbackToDeployment");
  const fn = source.slice(start, source.indexOf("\n// Take a published site offline", start));
  assert.doesNotMatch(fn, /project_releases|project_environments|requireFeature/,
    "those tables do not exist in Thrallo's database; rollback would throw on the first real call");
  assert.match(fn, /openDeployment/, "a rollback is itself a deployment");
  assert.match(fn, /rolled_back_from|rolledBackFrom|rollbackFrom/i, "and records what it restored");
  assert.match(fn, /site\.slug/, "the same slug, so the URL and custom domains do not move");
});

test("download runs the secret scrubber and uses the deployment's own source", async () => {
  const route = await readFile(fileURLToPath(new URL("../../shell/server/routes/deployments.mjs", import.meta.url)), "utf8");
  assert.match(route, /assertNoPlatformSecrets/, "a deployment archive can carry a secret like any other");
  assert.match(route, /deployment\.source_tree/,
    "never the project's current source — an older deployment must not hand back today's code");
  assert.match(route, /X-Thrallo-Source-Reconstruction/,
    "labelled for what it is: the built artifact is not stored");
});

test("deleting a project takes its deployment history with it", async () => {
  const { PROJECT_SCOPED_TABLES } = await import("../../shell/server/lib/projectTeardown.mjs");
  assert.ok(PROJECT_SCOPED_TABLES.some((t) => t.table === "deployments"),
    "source_tree is the whole app; a deleted project must not leave it behind");
});
