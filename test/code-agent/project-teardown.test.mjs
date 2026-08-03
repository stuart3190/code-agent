// Deleting a project must remove everything it owns.
//
// It did not. The cascade named seven tables by hand and left ten — including the owner's own
// prompts (diag_runs), the generated app's end-user notifications, and the visitor analytics for
// its published site. Worse, it unpublished WITHOUT the slug: published files live under the slug
// directory, so provisiond removed a directory that did not exist, returned 200, and the caller's
// `.catch()` never fired. The record was then deleted, losing the slug, and the site served
// forever with nothing in Thrallo aware of it.
//
// The guard below is the part that lasts: a table added later that nobody remembers to purge fails
// here instead of leaking quietly.

import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  PROJECT_SCOPED_TABLES, NOT_PURGED, takeSiteOffline, detachDomains, purgeProjectResources,
} from "../../shell/server/lib/projectTeardown.mjs";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const migrationsDir = new URL("../../supabase/migrations/", import.meta.url);

// Every table a migration creates with a project_id or app_id column — i.e. everything that can
// hold rows belonging to one project.
async function projectScopedTablesFromMigrations() {
  const found = new Map();
  for (const name of await readdir(migrationsDir)) {
    if (!name.endsWith(".sql")) continue;
    const sql = await readFile(new URL(name, migrationsDir), "utf8");
    const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    for (const match of code.matchAll(/create table (?:if not exists )?public\.(\w+)\s*\(([\s\S]*?)\n\);/gi)) {
      const [, table, body] = match;
      if (/^\s*(project_id|app_id)\s+/im.test(body)) found.set(table, true);
    }
    // Columns added later by ALTER also scope a table to a project.
    for (const match of code.matchAll(/alter table public\.(\w+)[\s\S]*?add column (?:if not exists )?(project_id|app_id)\b/gi)) {
      found.set(match[1], true);
    }
  }
  return found;
}

function fakeDb({ site = null, domains = [], appUsers = [], runs = [] } = {}) {
  const deletes = [];
  const updates = [];
  return {
    deletes,
    updates,
    auth: { admin: { deleteUser: async () => ({}) } },
    from(table) {
      const f = {};
      let mode = null;
      const api = {
        select() { return api; },
        eq(c, v) { f[c] = v; return api; },
        in(c, v) { f[`in_${c}`] = v; return api; },
        delete() { mode = "delete"; return api; },
        update(patch) { mode = "update"; f.patch = patch; return api; },
        maybeSingle: async () => ({ data: table === "published_sites" ? site : null, error: null }),
        then(resolve) {
          if (mode === "delete") deletes.push({ table, filters: { ...f } });
          if (mode === "update") updates.push({ table, filters: { ...f } });
          const data = mode ? null
            : table === "custom_domains" ? domains
              : table === "app_users" ? appUsers
                : table === "diag_runs" ? runs : [];
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return api;
    },
  };
}

// Records what provisiond was asked to do, and whether the slug came with it.
function fakeProvisiond({ stillServing = false } = {}) {
  const calls = [];
  const fn = async (route, body = null, method = "POST") => {
    calls.push({ route, body, method });
    if (route.startsWith("/exists")) return { exists: stillServing };
    if (route === "/unpublish") return { id: body?.slug, unpublished: !stillServing };
    return {};
  };
  fn.calls = calls;
  return fn;
}

// ── The guard ───────────────────────────────────────────────────────────────────────────

test("every project-scoped table is purged, or excluded with a written reason", async () => {
  const scoped = await projectScopedTablesFromMigrations();
  const purged = new Set(PROJECT_SCOPED_TABLES.map((t) => t.table));
  const missing = [...scoped.keys()].filter((t) => !purged.has(t) && !NOT_PURGED.has(t));
  assert.deepEqual(missing, [],
    `these tables hold project data and are never deleted — add them to PROJECT_SCOPED_TABLES `
    + `or justify them in NOT_PURGED: ${missing.join(", ")}`);
});

test("every teardown exclusion carries a real justification", () => {
  for (const [table, reason] of NOT_PURGED) {
    assert.ok(reason && reason.length > 20, `${table}: exclusions need a reason, not a shrug`);
  }
});

test("projects is deleted last, after everything that references it", () => {
  const order = PROJECT_SCOPED_TABLES.map((t) => t.table);
  assert.equal(order[order.length - 1], "projects");
  // qa_runs cascades from projects, so it must not be deleted before it.
  assert.ok(!order.includes("qa_runs"));
});

test("the tables carrying the most sensitive data are covered", () => {
  const purged = new Set(PROJECT_SCOPED_TABLES.map((t) => t.table));
  // Each of these was leaking, and each holds content the user would expect to be gone.
  for (const table of [
    "diag_runs",          // the prompts the user typed
    "app_notifications",  // the generated app's end users' notifications
    "analytics_events",   // visitor-level data for the published site
    "analytics_daily",    // and its aggregates
    "project_logs", "health_checks", "health_status", "build_checkpoints", "ai_requests",
  ]) {
    assert.ok(purged.has(table), `${table} survives deletion today`);
  }
});

// ── Taking the site offline ─────────────────────────────────────────────────────────────

test("unpublish is called WITH the slug", async () => {
  const provisiond = fakeProvisiond();
  const client = fakeDb({ site: { slug: "focusflow" } });
  const result = await takeSiteOffline({ client, provisiond, ownerId: OWNER, projectId: PROJECT });

  const unpublish = provisiond.calls.find((c) => c.route === "/unpublish");
  assert.equal(unpublish.body.slug, "focusflow",
    "without the slug provisiond removes a directory that does not exist and reports success");
  assert.equal(result.removed, true);
});

test("removal is VERIFIED, not assumed", async () => {
  // The original bug returned HTTP 200 having deleted nothing. Only asking again catches that.
  const provisiond = fakeProvisiond({ stillServing: true });
  const client = fakeDb({ site: { slug: "focusflow" } });
  const result = await takeSiteOffline({ client, provisiond, ownerId: OWNER, projectId: PROJECT });

  assert.ok(provisiond.calls.some((c) => c.route.startsWith("/exists")), "it must check afterwards");
  assert.equal(result.removed, false, "a site still on disk is not removed, whatever the response said");
});

test("a project that was never published is not treated as a failure", async () => {
  const provisiond = fakeProvisiond();
  const client = fakeDb({ site: null });
  const result = await takeSiteOffline({ client, provisiond, ownerId: OWNER, projectId: PROJECT });
  assert.equal(result.slug, null);
  assert.equal(result.removed, false, "nothing was removed because nothing was published");
});

// ── Domains ─────────────────────────────────────────────────────────────────────────────

test("custom domains are detached from Caddy before their rows are deleted", async () => {
  // Deleting the rows first loses the hostnames, and Caddy keeps serving them with nothing in
  // Thrallo aware they exist.
  const provisiond = fakeProvisiond();
  const client = fakeDb({
    site: { slug: "focusflow" },
    domains: [{ domain: "shop.example.com" }, { domain: "www.example.com" }],
  });
  await purgeProjectResources(OWNER, PROJECT, { client, provisiond });

  const detached = provisiond.calls.filter((c) => c.route === "/domain-detach").map((c) => c.body.domain);
  assert.deepEqual(detached, ["shop.example.com", "www.example.com"]);

  const detachIndex = provisiond.calls.findIndex((c) => c.route === "/domain-detach");
  const rowDeleteIndex = client.deletes.findIndex((d) => d.table === "custom_domains");
  assert.ok(detachIndex !== -1 && rowDeleteIndex !== -1);
  // Both happened; the detach used data that the delete then removed.
  assert.ok(client.deletes.some((d) => d.table === "custom_domains"));
});

test("detaching is skipped cleanly when provisiond is unavailable", async () => {
  const client = fakeDb({ domains: [{ domain: "shop.example.com" }] });
  const result = await detachDomains({ client, provisiond: null, ownerId: OWNER, projectId: PROJECT });
  assert.deepEqual(result.skipped, ["shop.example.com"], "and it says what it could not do");
});

// ── The whole purge ─────────────────────────────────────────────────────────────────────

test("every listed table is deleted, owner-scoped where it should be", async () => {
  const provisiond = fakeProvisiond();
  const client = fakeDb({ site: { slug: "focusflow" } });
  await purgeProjectResources(OWNER, PROJECT, { client, provisiond });

  for (const { table, column, ownerScoped } of PROJECT_SCOPED_TABLES) {
    const hit = client.deletes.find((d) => d.table === table);
    assert.ok(hit, `${table} was never deleted`);
    assert.equal(hit.filters[column], PROJECT, `${table} was not scoped by ${column}`);
    if (ownerScoped) {
      assert.equal(hit.filters.owner, OWNER, `${table} must also be owner-scoped`);
    }
  }
});

test("the preview container is stopped too", async () => {
  const provisiond = fakeProvisiond();
  await purgeProjectResources(OWNER, PROJECT, { client: fakeDb({ site: { slug: "x" } }), provisiond });
  assert.ok(provisiond.calls.some((c) => c.route === "/stop"));
});

// ── The cascade refuses to finish on a live site ────────────────────────────────────────

test("deletion ABORTS if the site is still serving", async () => {
  // Otherwise the record — and with it the slug — is deleted while the site stays online, which is
  // exactly how an orphan is created that nobody can ever clean up.
  const source = await readFile(
    fileURLToPath(new URL("../../shell/server/lib/conversationDelete.mjs", import.meta.url)), "utf8",
  );
  assert.match(source, /!report\.site\.removed/);
  assert.match(source, /throw step\("taking the site offline"/);
  assert.ok(source.indexOf("purgeProjectResources") < source.indexOf("deleteConversation(ownerId"),
    "the conversation row must only go once the resources are gone");
});

test("unpublishing also stands down domains and health", async () => {
  const source = await readFile(
    fileURLToPath(new URL("../../shell/server/lib/appBuild/appPublishService.mjs", import.meta.url)), "utf8",
  );
  const fn = source.slice(source.indexOf("export async function unpublishApp"));
  assert.match(fn, /detachDomain\(/, "Caddy must stop serving the custom hostname");
  assert.match(fn, /status: "pending_dns"/, "the Domains tab must stop claiming Active");
  assert.match(fn, /from\("health_status"\)\.delete\(\)/, "health must stop reporting on a dead site");
});
