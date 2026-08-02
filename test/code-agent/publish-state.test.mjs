// Published state: is a project live, and is what's live current?
//
// Both facts come from timestamps that already existed. The one that needs care is
// updateAvailable — get the tolerance wrong and every freshly published app immediately claims
// changes are waiting, which trains people to ignore the badge.

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { publishStates } from "../../shell/server/lib/publishState.mjs";

const OWNER = "44444444-4444-4444-8444-444444444444";
const PUBLISHED_AT = "2026-08-02T12:00:00.000Z";

// Minimal stand-in for the two tables involved, recording the filters so owner scoping is testable.
function fakeDb({ sites = [], projects = [], siteError = null } = {}) {
  const seen = [];
  return {
    seen,
    from(table) {
      const filters = {};
      const api = {
        select() { return api; },
        eq(column, value) { filters[column] = value; return api; },
        in(column, values) { filters[column] = values; return api; },
        then(resolve) {
          seen.push({ table, filters });
          if (table === "published_sites") {
            if (siteError) return resolve({ data: null, error: siteError });
            return resolve({ data: sites.filter((s) => s.owner === filters.owner), error: null });
          }
          const ids = filters.id || [];
          return resolve({
            data: projects.filter((p) => p.owner === filters.owner && ids.includes(p.id)),
            error: null,
          });
        },
      };
      return api;
    },
  };
}

const site = (over = {}) => ({
  owner: OWNER, project_id: "p1", slug: "app", url: "https://app.thrallo.com/x",
  created_at: "2026-07-01T00:00:00.000Z", updated_at: PUBLISHED_AT, ...over,
});
const project = (over = {}) => ({
  owner: OWNER, id: "p1", product_id: "prod-1", name: "FocusFlow", updated_at: PUBLISHED_AT, ...over,
});

test("a published project reports its URL, product, time and environment", async () => {
  const db = fakeDb({ sites: [site()], projects: [project()] });
  const [state] = await publishStates(OWNER, db);
  assert.equal(state.url, "https://app.thrallo.com/x");
  assert.equal(state.productId, "prod-1", "the dashboard matches cards by product");
  assert.equal(state.publishedAt, PUBLISHED_AT);
  assert.equal(state.environment, "production");
  assert.equal(state.updateAvailable, false);
});

test("editing after publishing marks an update as available", async () => {
  const later = "2026-08-02T13:00:00.000Z";
  const db = fakeDb({ sites: [site()], projects: [project({ updated_at: later })] });
  const [state] = await publishStates(OWNER, db);
  assert.equal(state.updateAvailable, true, "a change after the publish must be visible");
});

test("a freshly published app does NOT immediately claim an update is available", async () => {
  // The publish follows the build by a moment, so projects.updated_at can land a second or two
  // before published_sites.updated_at is stamped. Without tolerance, every publish would light up
  // "Update Available" the instant it finished and the badge would mean nothing.
  const justBefore = new Date(Date.parse(PUBLISHED_AT) + 2_000).toISOString();
  const db = fakeDb({ sites: [site()], projects: [project({ updated_at: justBefore })] });
  const [state] = await publishStates(OWNER, db);
  assert.equal(state.updateAvailable, false);

  // A genuine later edit still registers.
  const wellAfter = new Date(Date.parse(PUBLISHED_AT) + 60_000).toISOString();
  const [real] = await publishStates(OWNER, fakeDb({ sites: [site()], projects: [project({ updated_at: wellAfter })] }));
  assert.equal(real.updateAvailable, true);
});

test("an unpublished account gets an empty list without touching projects", async () => {
  const db = fakeDb({ sites: [], projects: [project()] });
  assert.deepEqual(await publishStates(OWNER, db), []);
  assert.deepEqual(db.seen.map((s) => s.table), ["published_sites"], "no pointless second query");
});

test("both queries are owner-scoped", async () => {
  const db = fakeDb({ sites: [site()], projects: [project()] });
  await publishStates(OWNER, db);
  assert.equal(db.seen.length, 2);
  for (const query of db.seen) {
    assert.equal(query.filters.owner, OWNER, `${query.table} must filter by owner`);
  }
});

test("another owner's project cannot supply the name or product", async () => {
  // A site row pointing at a project belonging to someone else must not resolve it.
  const db = fakeDb({ sites: [site()], projects: [project({ owner: "someone-else" })] });
  const [state] = await publishStates(OWNER, db);
  assert.equal(state.name, null);
  assert.equal(state.productId, null);
  assert.equal(state.updateAvailable, false, "no project means nothing to compare against");
});

test("the route never fails the dashboard", async () => {
  // Publish state is decoration on top of the real work; a storage failure must not take the
  // dashboard down with it.
  const source = await readFile(fileURLToPath(new URL("../../shell/server/routes/publishState.mjs", import.meta.url)), "utf8");
  assert.match(source, /catch/, "the handler must catch");
  assert.match(source, /sites: \[\], unavailable: true/, "and degrade to an empty list");

  await assert.rejects(
    () => publishStates(OWNER, fakeDb({ siteError: { message: "storage unavailable" } })),
    /storage unavailable/,
    "the library still reports the failure so the route can log it",
  );
});
