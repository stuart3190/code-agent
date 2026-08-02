// The publish lifecycle: draft → published → update available → unpublished → published again.
//
// Two behaviours here were found by inspecting production data rather than by reasoning:
//
//   1. A product can own SEVERAL project rows, and published_sites points at whichever was live at
//      publish time. Comparing only that row's updated_at means a rebuild never registers as an
//      update, because the published row never changes again.
//   2. Unpublishing must keep the row. The slug, URL and history live there, and republishing has
//      to return to the same address.

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { publishStates, statusForProduct, PUBLISH_STATUS } from "../../shell/server/lib/publishState.mjs";

const OWNER = "44444444-4444-4444-8444-444444444444";
const PUBLISHED_AT = "2026-08-02T12:00:00.000Z";
const PRODUCT = "prod-1";

function fakeDb({ sites = [], projects = [], domains = [], siteError = null } = {}) {
  const seen = [];
  return {
    seen,
    from(table) {
      const filters = {};
      const api = {
        select() { return api; },
        eq(column, value) { filters[column] = value; return api; },
        in(column, values) { filters[column] = values; return api; },
        order() { return api; },
        then(resolve) {
          seen.push({ table, filters });
          if (table === "published_sites") {
            if (siteError) return resolve({ data: null, error: siteError });
            return resolve({ data: sites.filter((s) => s.owner === filters.owner), error: null });
          }
          if (table === "custom_domains") {
            return resolve({
              data: domains.filter((d) => d.owner === filters.owner && (!filters.status || d.status === filters.status)),
              error: null,
            });
          }
          return resolve({ data: projects.filter((p) => p.owner === filters.owner), error: null });
        },
      };
      return api;
    },
  };
}

const site = (over = {}) => ({
  owner: OWNER, project_id: "p1", slug: "app", url: "https://app.thrallo.com/x",
  created_at: "2026-07-01T00:00:00.000Z", updated_at: PUBLISHED_AT, unpublished_at: null, ...over,
});
const project = (over = {}) => ({
  owner: OWNER, id: "p1", product_id: PRODUCT, name: "FocusFlow", updated_at: PUBLISHED_AT, ...over,
});
const later = (ms) => new Date(Date.parse(PUBLISHED_AT) + ms).toISOString();

// ── Published ───────────────────────────────────────────────────────────────────────────

test("a live project reports its URL, product, time, environment and status", async () => {
  const [state] = await publishStates(OWNER, fakeDb({ sites: [site()], projects: [project()] }));
  assert.equal(state.url, "https://app.thrallo.com/x");
  assert.equal(state.productId, PRODUCT);
  assert.equal(state.publishedAt, PUBLISHED_AT);
  assert.equal(state.environment, "production");
  assert.equal(state.live, true);
  assert.equal(state.status, PUBLISH_STATUS.published);
});

test("a project with no publish record is a draft", () => {
  assert.equal(statusForProduct([], PRODUCT), PUBLISH_STATUS.draft);
  assert.equal(statusForProduct([{ productId: "other", status: "published" }], PRODUCT), PUBLISH_STATUS.draft);
});

// ── Update available ────────────────────────────────────────────────────────────────────

test("editing after publishing marks an update as available", async () => {
  const db = fakeDb({ sites: [site()], projects: [project({ updated_at: later(60_000) })] });
  const [state] = await publishStates(OWNER, db);
  assert.equal(state.status, PUBLISH_STATUS.updateAvailable);
  assert.equal(state.updateAvailable, true);
  assert.equal(state.live, true, "the site stays online while an update is pending");
  assert.equal(state.url, "https://app.thrallo.com/x", "and keeps showing its live URL");
});

test("a REBUILD under the same product counts as an update, not just an edit in place", async () => {
  // The production case that motivated this: one product, two project rows. published_sites points
  // at the older one, whose updated_at never changes again. Comparing only that row would report
  // "Published" forever no matter how much new work happened.
  const db = fakeDb({
    sites: [site({ project_id: "p1" })],
    projects: [
      project({ id: "p1", updated_at: PUBLISHED_AT }),          // the published row, frozen
      project({ id: "p2", updated_at: later(3_600_000) }),      // a later rebuild
    ],
  });
  const [state] = await publishStates(OWNER, db);
  assert.equal(state.status, PUBLISH_STATUS.updateAvailable);
  assert.equal(state.currentProjectId, "p2",
    "publishing an update must target the product's current project, not the stale one");
});

test("a freshly published app does NOT immediately claim an update is available", async () => {
  // The publish follows the build by a moment. Without tolerance every publish would light up
  // "Update Available" the instant it finished, and the badge would mean nothing.
  const [state] = await publishStates(OWNER, fakeDb({
    sites: [site()], projects: [project({ updated_at: later(2_000) })],
  }));
  assert.equal(state.status, PUBLISH_STATUS.published);
});

// ── Unpublished ─────────────────────────────────────────────────────────────────────────

test("an unpublished site reports offline and stops claiming an update", async () => {
  const db = fakeDb({
    sites: [site({ unpublished_at: later(120_000) })],
    projects: [project({ updated_at: later(60_000) })],   // changed before it was taken down
  });
  const [state] = await publishStates(OWNER, db);
  assert.equal(state.status, PUBLISH_STATUS.unpublished);
  assert.equal(state.live, false);
  assert.equal(state.updateAvailable, false, "an offline site cannot have a pending update");
  assert.equal(state.url, "https://app.thrallo.com/x", "the address is remembered for republishing");
  assert.equal(state.firstPublishedAt, "2026-07-01T00:00:00.000Z", "history survives");
});

test("unpublishing preserves the record instead of deleting it", async () => {
  const source = await readFile(fileURLToPath(new URL("../../shell/server/lib/appBuild/appPublishService.mjs", import.meta.url)), "utf8");
  const fn = source.slice(source.indexOf("export async function unpublishApp"));
  assert.match(fn, /unpublished_at: new Date\(\)/, "it stamps the row");
  assert.doesNotMatch(fn, /\.delete\(\)/, "and never deletes it — history and the slug must survive");
  assert.ok(fn.indexOf('provisiond("/unpublish"') < fn.indexOf("unpublished_at: new Date()"),
    "the files come down before the record says they did");
});

test("republishing clears the offline stamp", async () => {
  const source = await readFile(fileURLToPath(new URL("../../shell/server/lib/appBuild/appPublishService.mjs", import.meta.url)), "utf8");
  const publishFn = source.slice(source.indexOf("export async function publishApp"), source.indexOf("export async function connectDomain"));
  assert.match(publishFn, /unpublished_at: null/,
    "without this a republished site would still show as unpublished while serving");
});

// ── Isolation and resilience ────────────────────────────────────────────────────────────

test("both queries are owner-scoped", async () => {
  const db = fakeDb({ sites: [site()], projects: [project()] });
  await publishStates(OWNER, db);
  assert.equal(db.seen.length, 3, "published_sites, projects and custom_domains");
  for (const query of db.seen) assert.equal(query.filters.owner, OWNER, `${query.table} must filter by owner`);
});

test("another owner's project cannot supply the name or product", async () => {
  const db = fakeDb({ sites: [site()], projects: [project({ owner: "someone-else" })] });
  const [state] = await publishStates(OWNER, db);
  assert.equal(state.name, null);
  assert.equal(state.productId, null);
  assert.equal(state.updateAvailable, false);
});

test("an unpublished account gets an empty list without touching projects", async () => {
  const db = fakeDb({ sites: [], projects: [project()] });
  assert.deepEqual(await publishStates(OWNER, db), []);
  assert.deepEqual(db.seen.map((s) => s.table), ["published_sites"]);
});

test("neither the dashboard nor the conversation list dies if publish state fails", async () => {
  const route = await readFile(fileURLToPath(new URL("../../shell/server/routes/publishState.mjs", import.meta.url)), "utf8");
  assert.match(route, /sites: \[\], unavailable: true/, "the route degrades to an empty list");

  const conversations = await readFile(fileURLToPath(new URL("../../shell/server/routes/conversations.mjs", import.meta.url)), "utf8");
  assert.match(conversations, /publish state unavailable/, "the list logs and carries on");

  await assert.rejects(
    () => publishStates(OWNER, fakeDb({ siteError: { message: "storage unavailable" } })),
    /storage unavailable/,
    "the library still reports the failure so callers can log it",
  );
});

// ── The address a project is known by ────────────────────────────────────────────────────

test("a verified custom domain becomes the displayed address, without losing the Thrallo one", async () => {
  const db = fakeDb({
    sites: [site()],
    projects: [project()],
    domains: [{ owner: OWNER, project_id: "p1", domain: "shop.example.com", status: "active", created_at: "2026-08-01T00:00:00.000Z" }],
  });
  const [state] = await publishStates(OWNER, db);
  assert.equal(state.customDomain, "shop.example.com");
  assert.equal(state.primaryUrl, "https://shop.example.com", "this is what people are told");
  assert.equal(state.url, "https://app.thrallo.com/x", "and the Thrallo address is never discarded");
});

test("a domain still proving itself is NOT shown as the address", async () => {
  // Sending people to a hostname that does not resolve yet would be worse than showing the
  // Thrallo URL, which definitely works.
  for (const status of ["pending_dns", "verifying", "failed"]) {
    const db = fakeDb({
      sites: [site()], projects: [project()],
      domains: [{ owner: OWNER, project_id: "p1", domain: "shop.example.com", status, created_at: "2026-08-01T00:00:00.000Z" }],
    });
    const [state] = await publishStates(OWNER, db);
    assert.equal(state.customDomain, null, `${status} must not take over the address`);
    assert.equal(state.primaryUrl, "https://app.thrallo.com/x");
  }
});

test("the oldest domain stays primary when several are active", async () => {
  // Otherwise the address a project is known by would change every time another domain was added.
  const db = fakeDb({
    sites: [site()], projects: [project()],
    domains: [
      { owner: OWNER, project_id: "p1", domain: "second.example.com", status: "active", created_at: "2026-08-02T00:00:00.000Z" },
      { owner: OWNER, project_id: "p1", domain: "first.example.com", status: "active", created_at: "2026-08-01T00:00:00.000Z" },
    ],
  });
  const [state] = await publishStates(OWNER, db);
  assert.equal(state.customDomain, "first.example.com");
});

test("an unpublished project shows its Thrallo address even with an active domain", async () => {
  const db = fakeDb({
    sites: [site({ unpublished_at: "2026-08-03T00:00:00.000Z" })], projects: [project()],
    domains: [{ owner: OWNER, project_id: "p1", domain: "shop.example.com", status: "active", created_at: "2026-08-01T00:00:00.000Z" }],
  });
  const [state] = await publishStates(OWNER, db);
  assert.equal(state.primaryUrl, "https://app.thrallo.com/x",
    "nothing is serving, so pointing at the custom domain would be a lie");
});
