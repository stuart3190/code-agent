// A published address is never given up.
//
// `claimSlug` used to prefer `slugify(project.name)` over the slug already claimed, and resolved
// per PROJECT rather than per PRODUCT. Two consequences, both silent:
//
//   * Renaming a project moved its URL. Anyone who had been given the old address lost it.
//   * A rebuild inserts a NEW project row, so it claimed a fresh slug while the previous build
//     kept serving — two live URLs for one app, the custom domain still pointing at the old one
//     (its CNAME target and Caddy label are built from the slug), and analytics orphaned under the
//     old app id, because the analytics app id IS the slug.

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const OWNER = "99999999-9999-4999-8999-999999999999";
const PRODUCT = "prod-1";

// Stands in for published_sites + projects, recording writes so a transfer is observable.
function fakeDb({ sites = [], projects = [] } = {}) {
  const db = {
    sites: sites.map((s) => ({ ...s })),
    projects: projects.map((p) => ({ ...p })),
    writes: [],
    from(table) {
      const f = {};
      let pending = null;
      const api = {
        select() { return api; },
        eq(c, v) { f[c] = v; return api; },
        in(c, v) { f[`in_${c}`] = v; return api; },
        order() { return api; },
        limit(n) { f.limit = n; return api; },
        update(patch) { pending = patch; return api; },
        maybeSingle: async () => {
          const rows = api._rows();
          return { data: rows[0] || null, error: null };
        },
        then(resolve) {
          if (pending) {
            const rows = api._rows();
            db.writes.push({ table, filters: { ...f }, patch: pending });
            for (const row of rows) Object.assign(row, pending);
            pending = null;
            return Promise.resolve({ data: rows, error: null }).then(resolve);
          }
          return Promise.resolve({ data: api._rows(), error: null }).then(resolve);
        },
        _rows() {
          const source = table === "published_sites" ? db.sites : db.projects;
          let rows = source.filter((r) => (!f.owner || r.owner === f.owner));
          if (f.project_id) rows = rows.filter((r) => String(r.project_id) === String(f.project_id));
          if (f.slug) rows = rows.filter((r) => r.slug === f.slug);
          if (f.product_id) rows = rows.filter((r) => String(r.product_id) === String(f.product_id));
          if (f.in_project_id) rows = rows.filter((r) => f.in_project_id.includes(String(r.project_id)));
          rows = [...rows].sort((a, b) => ((a.updated_at || "") < (b.updated_at || "") ? 1 : -1));
          return f.limit ? rows.slice(0, f.limit) : rows;
        },
      };
      return api;
    },
  };
  return db;
}

const site = (over = {}) => ({
  owner: OWNER, project_id: "p1", slug: "focusflow", url: "https://focusflow.app.thrallo.com",
  created_at: "2026-07-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z", unpublished_at: null, ...over,
});
const project = (over = {}) => ({ owner: OWNER, id: "p1", product_id: PRODUCT, updated_at: "2026-08-01T00:00:00Z", ...over });

import { claimSlug } from "../../shell/server/lib/appBuild/appPublishService.mjs";

const claim = (db, projectId, wanted, productId = PRODUCT) =>
  claimSlug(OWNER, projectId, wanted, { productId, client: db });

// ── Behaviour ───────────────────────────────────────────────────────────────────────────

test("a published project keeps its address after being renamed", async () => {
  const db = fakeDb({ sites: [site({ project_id: "p1", slug: "focusflow" })], projects: [project({ id: "p1" })] });
  // The project is now called something completely different.
  const result = await claim(db, "p1", "Totally New Name");
  assert.equal(result.slug, "focusflow", "a URL people have been given must not move when a name changes");
  assert.equal(result.supersedes, null);
});

test("a rebuild of the same product inherits the live address", async () => {
  // p2 is a fresh project row from a rebuild; p1 holds the site.
  const db = fakeDb({
    sites: [site({ project_id: "p1", slug: "focusflow" })],
    projects: [project({ id: "p1", updated_at: "2026-08-01T00:00:00Z" }), project({ id: "p2", updated_at: "2026-08-02T00:00:00Z" })],
  });
  const result = await claim(db, "p2", "FocusFlow Rebuilt");
  assert.equal(result.slug, "focusflow", "one product, one address");
  assert.equal(result.supersedes, "p1", "and the record moves onto the new project");
});

test("a product that has never been live gets a fresh address from its name", async () => {
  const db = fakeDb({ sites: [], projects: [project({ id: "p1" })] });
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ exists: false }) });
  try {
    const result = await claim(db, "p1", "Focus Flow");
    assert.equal(result.slug, "focus-flow");
    assert.equal(result.supersedes, null);
  } finally { globalThis.fetch = original; }
});

test("another product's site is never inherited", async () => {
  const db = fakeDb({
    sites: [site({ project_id: "other", slug: "someone-elses-app" })],
    projects: [project({ id: "p1", product_id: PRODUCT }), project({ id: "other", product_id: "prod-2" })],
  });
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ exists: false }) });
  try {
    const result = await claim(db, "p1", "My App");
    assert.equal(result.slug, "my-app", "inheritance is scoped to the product, not to anything published");
    assert.equal(result.supersedes, null);
  } finally { globalThis.fetch = original; }
});

test("the site record is MOVED, never deleted and recreated", async () => {
  const source = await readFile(fileURLToPath(new URL("../../shell/server/lib/appBuild/appPublishService.mjs", import.meta.url)), "utf8");
  const fn = source.slice(source.indexOf("async function transferSite"), source.indexOf("export async function publishApp"));
  assert.match(fn, /\.update\(/, "a move preserves created_at — the date the product first went live");
  assert.doesNotMatch(fn, /\.delete\(/,
    "delete-then-insert would lose the first-published date and can leave two rows on a unique slug");
});

test("the transfer happens BEFORE the site is published", async () => {
  // published_sites.slug is unique. Upserting the new project's row while the old one still holds
  // the slug would fail, so the move must come first.
  const source = await readFile(fileURLToPath(new URL("../../shell/server/lib/appBuild/appPublishService.mjs", import.meta.url)), "utf8");
  const fn = source.slice(source.indexOf("export async function publishApp"));
  assert.ok(fn.indexOf("if (claim.supersedes) await transferSite") < fn.indexOf('provisiond("/publish"'),
    "the record must be moved before the upload, not after");
});

test("publish reads the slug from the claim result, not from a bare string", async () => {
  // claimSlug returns { slug, supersedes } now; a caller still treating it as a string would
  // silently publish under "[object Object]".
  const source = await readFile(fileURLToPath(new URL("../../shell/server/lib/appBuild/appPublishService.mjs", import.meta.url)), "utf8");
  assert.match(source, /const claim = await claimSlug\(/);
  assert.match(source, /const slug = claim\.slug;/);
  assert.doesNotMatch(source, /const slug = await claimSlug\(/, "the old string contract must be gone");
});

test("everything downstream of the slug stays stable, by construction", async () => {
  // These three all derive from the slug, which is why moving it was so damaging:
  //   analytics app id, the custom-domain CNAME target, and the Caddy attach label.
  const publish = await readFile(fileURLToPath(new URL("../../shell/server/lib/appBuild/appPublishService.mjs", import.meta.url)), "utf8");
  assert.match(publish, /withAnalytics\(built, slug\)/, "the analytics app id is the slug");
  const domains = await readFile(fileURLToPath(new URL("../../shell/server/lib/customDomains.mjs", import.meta.url)), "utf8");
  assert.match(domains, /\$\{slug\}\.\$\{appSuffix\(\)\}/, "the CNAME target is built from the slug");
});
