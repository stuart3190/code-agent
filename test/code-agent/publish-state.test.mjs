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

import { publishStates, PUBLISH_STATUS } from "../../shell/server/lib/publishState.mjs";
import { resolvePublishState, pickActiveSite } from "../../shell/shared/publishResolution.mjs";

const OWNER = "44444444-4444-4444-8444-444444444444";
const PUBLISHED_AT = "2026-08-02T12:00:00.000Z";
const PRODUCT = "prod-1";

function fakeDb({ sites = [], projects = [], domains = [], deployments = [], siteError = null } = {}) {
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
        limit() { return api; },
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
          // Named explicitly. The fallback used to be "anything else is projects", so a new table
          // silently received project rows instead of its own — the fake would have agreed with a
          // reader of the wrong table.
          if (table === "deployments") {
            return resolve({
              data: [...deployments.filter((d) => d.owner === filters.owner)]
                .sort((a, b) => b.number - a.number),
              error: null,
            });
          }
          if (table === "projects") {
            return resolve({ data: projects.filter((p) => p.owner === filters.owner), error: null });
          }
          throw new Error(`fakeDb has no model for table "${table}"`);
        },
      };
      return api;
    },
  };
}

const deployment = (over = {}) => ({
  owner: OWNER, id: "d1", project_id: "p1", product_id: PRODUCT, number: 1, status: "live",
  environment: "production", triggered_by_kind: "user", build_run_id: "run-1",
  build_duration_ms: 1800, deploy_duration_ms: 300, deployed_at: PUBLISHED_AT,
  created_at: PUBLISHED_AT, failure_reason: null, url: "https://app.thrallo.com/x", ...over,
});

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
  assert.equal(resolvePublishState([]).statusFor({ productId: PRODUCT }), PUBLISH_STATUS.draft);
  assert.equal(
    resolvePublishState([{ projectId: "px", productId: "other", status: "published", live: true }])
      .statusFor({ productId: PRODUCT }),
    PUBLISH_STATUS.draft,
    "another product's live site must never label this one",
  );
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
  // Specifically the SITE record. Unpublishing does now delete health_status — a dead site has
  // nothing to report on — so a blanket "no deletes" assertion would forbid correct behaviour
  // while still not saying what actually matters here.
  assert.doesNotMatch(fn, /from\("published_sites"\)\s*\n?\s*\.delete\(\)/,
    "the site record must survive — history and the claimed slug live in it");
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

test("every query is owner-scoped", async () => {
  const db = fakeDb({ sites: [site()], projects: [project()] });
  await publishStates(OWNER, db);
  assert.deepEqual(db.seen.map((q) => q.table).sort(),
    ["custom_domains", "deployments", "projects", "published_sites"]);
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

// ── One resolver, no disagreement ───────────────────────────────────────────────────────
//
// There were two. routes/conversations.mjs built a Map from the states — LAST wins. The web app's
// publishState.js used .find() — FIRST wins. For a product with two published rows the same
// project could read UNPUBLISHED on its card and LIVE in the panel directly above it, from one
// fetch, in the same second.

test("the resolver picks the same record however the rows are ordered", () => {
  const older = { projectId: "p1", productId: PRODUCT, live: false, status: PUBLISH_STATUS.unpublished, publishedAt: "2026-07-01T00:00:00Z" };
  const newer = { projectId: "p2", productId: PRODUCT, live: true, status: PUBLISH_STATUS.published, publishedAt: "2026-08-01T00:00:00Z" };

  // The exact condition the old code disagreed on: order the array either way and the answer must
  // not move.
  assert.equal(resolvePublishState([older, newer]).forProduct(PRODUCT).projectId, "p2");
  assert.equal(resolvePublishState([newer, older]).forProduct(PRODUCT).projectId, "p2");
});

test("a live record always beats a historical one, whatever the dates say", () => {
  // A newer unpublished record must not retire a site that is still serving.
  const live = { projectId: "p1", productId: PRODUCT, live: true, status: PUBLISH_STATUS.published, publishedAt: "2026-06-01T00:00:00Z" };
  const retired = { projectId: "p2", productId: PRODUCT, live: false, status: PUBLISH_STATUS.unpublished, publishedAt: "2026-08-02T00:00:00Z" };
  assert.equal(pickActiveSite([retired, live]).projectId, "p1");
  assert.equal(resolvePublishState([retired, live]).statusFor({ productId: PRODUCT }), PUBLISH_STATUS.published);
});

test("historical records never make a product look live again", () => {
  const states = [
    { projectId: "p1", productId: PRODUCT, live: false, status: PUBLISH_STATUS.unpublished, publishedAt: "2026-07-01T00:00:00Z" },
    { projectId: "p2", productId: PRODUCT, live: false, status: PUBLISH_STATUS.unpublished, publishedAt: "2026-08-01T00:00:00Z" },
  ];
  assert.equal(resolvePublishState(states).statusFor({ productId: PRODUCT }), PUBLISH_STATUS.unpublished);
});

test("two live records for one product are REPORTED, not silently resolved", () => {
  // Picking a winner is necessary so the UI can render, but doing it quietly would leave the fault
  // in the database forever. ops/repair-publish-state.mjs acts on exactly this.
  const states = [
    { projectId: "p1", productId: PRODUCT, live: true, status: PUBLISH_STATUS.published, publishedAt: "2026-07-01T00:00:00Z" },
    { projectId: "p2", productId: PRODUCT, live: true, status: PUBLISH_STATUS.published, publishedAt: "2026-08-01T00:00:00Z" },
  ];
  const resolved = resolvePublishState(states);
  assert.equal(resolved.forProduct(PRODUCT).projectId, "p2", "the newest is still shown");
  assert.deepEqual(resolved.conflicts, [
    { productId: PRODUCT, kind: "multiple_live", active: "p2", superseded: ["p1"] },
  ]);
});

test("a published project with no product is still resolvable by its own id", () => {
  // Filtering these out is what made a genuinely live site render as a draft.
  const orphan = { projectId: "p9", productId: null, live: true, status: PUBLISH_STATUS.published, publishedAt: "2026-08-01T00:00:00Z" };
  const resolved = resolvePublishState([orphan]);
  assert.equal(resolved.forProject("p9").projectId, "p9");
  assert.equal(resolved.statusFor({ projectId: "p9" }), PUBLISH_STATUS.published);
  assert.equal(resolved.statusFor({ productId: null, projectId: "p9" }), PUBLISH_STATUS.published);
  assert.deepEqual(resolved.conflicts, [], "standing alone is not a conflict");
});

test("nothing published at all is a draft, not an absence", () => {
  const resolved = resolvePublishState([]);
  assert.equal(resolved.statusFor({ productId: PRODUCT }), PUBLISH_STATUS.draft);
  assert.equal(resolved.statusFor({}), PUBLISH_STATUS.draft);
});

test("a tie resolves the same way every time", () => {
  const same = "2026-08-01T00:00:00Z";
  const a = { projectId: "aaa", productId: PRODUCT, live: true, status: PUBLISH_STATUS.published, publishedAt: same };
  const b = { projectId: "bbb", productId: PRODUCT, live: true, status: PUBLISH_STATUS.published, publishedAt: same };
  assert.equal(pickActiveSite([a, b]).projectId, pickActiveSite([b, a]).projectId,
    "an unstable tiebreak is how two surfaces disagree while both are 'correct'");
});

test("there is exactly ONE publish resolver in the codebase", async () => {
  const server = await readFile(fileURLToPath(new URL("../../shell/server/lib/publishState.mjs", import.meta.url)), "utf8");
  assert.doesNotMatch(server, /export function statusForProduct/,
    "the first-wins resolver must be gone, not merely unused");

  const route = await readFile(fileURLToPath(new URL("../../shell/server/routes/conversations.mjs", import.meta.url)), "utf8");
  assert.match(route, /resolvePublishState/, "the route must use the shared resolver");
  assert.doesNotMatch(route, /new Map\(\s*\(await publishStates/,
    "building its own Map is the last-wins bug");

  const web = await readFile(fileURLToPath(new URL("../../shell/web/src/publish/publishState.js", import.meta.url)), "utf8");
  assert.match(web, /resolvePublishState/, "the web app must use it too");
  assert.doesNotMatch(web, /sites\.find\(/, "`.find()` is the first-wins bug");

  // The status vocabulary must not be redefined either — two definitions of "published" is the
  // same class of problem one level down.
  const lifecycle = await readFile(fileURLToPath(new URL("../../shell/web/src/publish/publishLifecycle.js", import.meta.url)), "utf8");
  assert.doesNotMatch(lifecycle, /export const STATUS = Object\.freeze/,
    "STATUS must be re-exported from the shared module, never redefined");
});

test("the database refuses a second live record for one product", async () => {
  const migration = await readFile(fileURLToPath(new URL(
    "../../supabase/migrations/20260803210000_one_live_site_per_product.sql", import.meta.url)), "utf8");
  assert.match(migration, /create unique index[\s\S]*published_sites_one_live_per_product/i);
  assert.match(migration, /where unpublished_at is null and product_id is not null/i,
    "partial, so a retired record and a project with no product are both exempt");
  // The repair must come BEFORE the index, or the migration fails on the very data it fixes.
  assert.ok(migration.indexOf("set unpublished_at = now()") < migration.indexOf("create unique index"),
    "repair before constrain");
  assert.doesNotMatch(migration, /delete from public\.published_sites/i,
    "a superseded record is retired, never deleted — the slug and history live on it");
});

// ── The deployment travels with the publish state ───────────────────────────────────────
//
// The panel's facts are read server-side rather than assembled from the publish event, so there is
// one source of truth for "which version is live and how long did it take". Before this the panel
// could not name a version at all — deployments existed but nothing carried them to it.

test("the live deployment rides along with its version and both durations", async () => {
  const db = fakeDb({ sites: [site()], projects: [project()], deployments: [deployment()] });
  const [state] = await publishStates(OWNER, db);
  assert.equal(state.deployment.number, 1);
  assert.equal(state.deployment.buildDurationMs, 1800);
  assert.equal(state.deployment.deployDurationMs, 300, "measured separately, not one total split");
  assert.equal(state.deployment.buildRunId, "run-1", "so View Logs can open the exact build");
});

test("source_tree is never fetched — it is the entire app", async () => {
  const source = await readFile(fileURLToPath(new URL("../../shell/server/lib/publishState.mjs", import.meta.url)), "utf8");
  // The selected COLUMNS, not the surrounding prose — the comment above the query explains why
  // source_tree is omitted and would otherwise match.
  const columns = source
    .slice(source.indexOf('from("deployments")'))
    .match(/\.select\("([^"]+)"\)/)?.[1] || "";
  assert.ok(columns.includes("build_duration_ms"), "the query was found");
  assert.ok(!columns.includes("source_tree"),
    "selecting it for every deployment of every project would make this query enormous");
});

test("a failed publish is reported alongside what is still serving", async () => {
  // The case the panel had no way to describe: the newest attempt is not what people are getting.
  const db = fakeDb({
    sites: [site()], projects: [project()],
    deployments: [
      deployment({ id: "d1", number: 1, status: "live" }),
      deployment({ id: "d2", number: 2, status: "failed", failure_reason: "build failed", deployed_at: null }),
    ],
  });
  const [state] = await publishStates(OWNER, db);
  assert.equal(state.deployment.number, 1, "what is SERVING is still #1");
  assert.equal(state.lastAttempt.number, 2, "and the newest attempt is named separately");
  assert.equal(state.lastAttempt.status, "failed");
  assert.equal(state.lastAttempt.failureReason, "build failed");
});

test("a publish in flight is visible without disturbing what is live", async () => {
  const db = fakeDb({
    sites: [site()], projects: [project()],
    deployments: [
      deployment({ id: "d1", number: 1, status: "live" }),
      deployment({ id: "d2", number: 2, status: "building", deployed_at: null }),
    ],
  });
  const [state] = await publishStates(OWNER, db);
  assert.equal(state.deployment.number, 1, "nothing has changed on the live site yet");
  assert.equal(state.lastAttempt.status, "building");
});

test("deployments resolve per APP, so a rebuild keeps its history", async () => {
  // A rebuild creates a new project row under the same product; its deployments are the same app's.
  const db = fakeDb({
    sites: [site({ project_id: "p1" })],
    projects: [project({ id: "p1" }), project({ id: "p2", updated_at: later(3_600_000) })],
    deployments: [deployment({ id: "d2", project_id: "p2", number: 2, status: "live" })],
  });
  const [state] = await publishStates(OWNER, db);
  assert.equal(state.deployment.number, 2,
    "the deployment belongs to the product, not to the project row published months ago");
});

test("a project that has never deployed carries null rather than a guess", async () => {
  const db = fakeDb({ sites: [site()], projects: [project()], deployments: [] });
  const [state] = await publishStates(OWNER, db);
  assert.equal(state.deployment, null);
  assert.equal(state.lastAttempt, null);
});

test("a deployments read failure is raised, not reported as no history", async () => {
  const db = {
    from: (table) => ({
      select() { return this; }, eq() { return this; }, order() { return this; }, limit() { return this; },
      then: (resolve) => resolve(table === "deployments"
        ? { data: null, error: { message: "connection reset" } }
        : { data: table === "published_sites" ? [site()] : [], error: null }),
    }),
  };
  await assert.rejects(() => publishStates(OWNER, db), /connection reset/);
});
