// Which project does "it" mean?
//
// Every app capability resolved this as "the owner's globally newest project with a tree", ignoring
// the conversation. So in a conversation about app A, "publish it" could publish app B, "fix the
// login" could apply a surgical repair to B's tree, and "send me the code" could hand over B's
// source. Same owner throughout, so not a tenancy leak — but the wrong app, and in the repair case
// destructive.
//
// The rule these tests pin: a conversation about a product never escapes that product. Nothing
// built yet is answered honestly, never with a different app that happens to be newer.

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { resolveConversationProject, projectsForProduct } from "../../shell/server/lib/appBuild/projectScope.mjs";

const OWNER = "88888888-8888-4888-8888-888888888888";
const PRODUCT_A = "prod-a";
const PRODUCT_B = "prod-b";

const project = (over = {}) => ({
  id: "p1", name: "App A", tree: { "index.html": "" }, product_id: PRODUCT_A,
  updated_at: "2026-08-01T10:00:00Z", owner: OWNER, ...over,
});

// Models the filters the real query applies, so a test cannot pass by ignoring one.
function fakeDb({ projects = [], products = [] } = {}) {
  const seen = [];
  return {
    seen,
    from(table) {
      const f = { table };
      const api = {
        select() { return api; },
        eq(c, v) { f[c] = v; return api; },
        not(c, _op, v) { f[`not_${c}`] = v; return api; },
        ilike(c, v) { f[`ilike_${c}`] = v; return api; },
        order() { return api; },
        limit(n) { f.limit = n; return api; },
        maybeSingle: async () => {
          seen.push(f);
          const match = products.find((p) => p.owner === f.owner
            && String(p.name).toLowerCase() === String(f.ilike_name || "").toLowerCase());
          return { data: match || null, error: null };
        },
        then(resolve) {
          seen.push(f);
          let rows = projects.filter((p) => p.owner === f.owner && p.tree);
          if (f.id) rows = rows.filter((p) => String(p.id) === String(f.id));
          if (f.product_id) rows = rows.filter((p) => String(p.product_id) === String(f.product_id));
          rows = [...rows].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1)).slice(0, f.limit || 50);
          return Promise.resolve({ data: rows, error: null }).then(resolve);
        },
      };
      return api;
    },
  };
}

const conversation = (productId) => ({ owner: OWNER, conversation: { id: "c1", product_id: productId } });

// ── The bug this exists for ─────────────────────────────────────────────────────────────

test("a conversation resolves ITS product, not the owner's newest project", async () => {
  const client = fakeDb({ projects: [
    project({ id: "a", product_id: PRODUCT_A, updated_at: "2026-08-01T10:00:00Z" }),
    // Touched more recently — the old code would have picked this one every time.
    project({ id: "b", product_id: PRODUCT_B, name: "App B", updated_at: "2026-08-02T10:00:00Z" }),
  ] });
  const { project: resolved, scope } = await resolveConversationProject(conversation(PRODUCT_A), { client });
  assert.equal(resolved.id, "a", "publishing from A's conversation must never reach B");
  assert.equal(scope, "conversation");
});

test("a conversation whose product has nothing built gets NOTHING, not another app", async () => {
  // The critical half. Falling back here is what let a repair be applied to the wrong tree.
  const client = fakeDb({ projects: [project({ id: "b", product_id: PRODUCT_B, updated_at: "2026-08-02T10:00:00Z" })] });
  const { project: resolved } = await resolveConversationProject(conversation(PRODUCT_A), { client });
  assert.equal(resolved, null, "the honest answer is 'nothing built yet'");
});

test("the newest project OF THAT PRODUCT wins, since a rebuild makes a new row", async () => {
  const client = fakeDb({ projects: [
    project({ id: "old", product_id: PRODUCT_A, updated_at: "2026-08-01T10:00:00Z" }),
    project({ id: "new", product_id: PRODUCT_A, updated_at: "2026-08-02T10:00:00Z" }),
  ] });
  const { project: resolved } = await resolveConversationProject(conversation(PRODUCT_A), { client });
  assert.equal(resolved.id, "new");
});

// ── Precedence ──────────────────────────────────────────────────────────────────────────

test("an explicit projectId wins over everything", async () => {
  const client = fakeDb({ projects: [
    project({ id: "a", product_id: PRODUCT_A }),
    project({ id: "b", product_id: PRODUCT_B, updated_at: "2026-08-09T10:00:00Z" }),
  ] });
  const { project: resolved, scope } = await resolveConversationProject(
    conversation(PRODUCT_A), { projectId: "b", client },
  );
  assert.equal(resolved.id, "b");
  assert.equal(scope, "explicit");
});

test("a named product overrides the conversation — that is a deliberate instruction", async () => {
  const client = fakeDb({
    projects: [project({ id: "a", product_id: PRODUCT_A }), project({ id: "b", product_id: PRODUCT_B, name: "App B" })],
    products: [{ id: PRODUCT_B, name: "App B", owner: OWNER }],
  });
  const { project: resolved, scope } = await resolveConversationProject(
    conversation(PRODUCT_A), { productName: "app b", client },
  );
  assert.equal(resolved.id, "b");
  assert.equal(scope, "named_product");
});

test("a product name that matches nothing does NOT widen the search", async () => {
  // Silently falling through to "everything" is how "publish the CRM" published something else.
  const client = fakeDb({ projects: [project({ id: "a" })], products: [] });
  const { project: resolved, scope } = await resolveConversationProject(
    conversation(PRODUCT_A), { productName: "nonexistent", client },
  );
  assert.equal(resolved, null);
  assert.equal(scope, "unknown_product", "the caller can now say which name it could not find");
});

test("only a conversation with no product at all falls back to the newest", async () => {
  // Older conversations predate product ids; they are the one legitimate case.
  const client = fakeDb({ projects: [
    project({ id: "a", updated_at: "2026-08-01T10:00:00Z" }),
    project({ id: "b", updated_at: "2026-08-02T10:00:00Z" }),
  ] });
  const { project: resolved, scope } = await resolveConversationProject(
    { owner: OWNER, conversation: { id: "c1", product_id: null } }, { client },
  );
  assert.equal(resolved.id, "b");
  assert.equal(scope, "owner_latest");
});

// ── Isolation ───────────────────────────────────────────────────────────────────────────

test("every lookup is owner-scoped, including the explicit-id path", async () => {
  const client = fakeDb({ projects: [project({ id: "theirs", owner: "someone-else" })] });
  const { project: resolved } = await resolveConversationProject(
    conversation(PRODUCT_A), { projectId: "theirs", client },
  );
  assert.equal(resolved, null, "another owner's project id must resolve to nothing");
  for (const query of client.seen) assert.equal(query.owner, OWNER);
});

test("projects without a tree are never resolved", async () => {
  const client = fakeDb({ projects: [project({ id: "a", tree: null })] });
  const { project: resolved } = await resolveConversationProject(conversation(PRODUCT_A), { client });
  assert.equal(resolved, null, "an unbuilt project cannot be published, repaired or exported");
});

test("projectsForProduct is owner-scoped and newest first", async () => {
  const client = fakeDb({ projects: [
    project({ id: "old", updated_at: "2026-08-01T10:00:00Z" }),
    project({ id: "new", updated_at: "2026-08-02T10:00:00Z" }),
    project({ id: "theirs", owner: "someone-else" }),
  ] });
  const rows = await projectsForProduct(OWNER, PRODUCT_A, client);
  assert.deepEqual(rows.map((r) => r.id), ["new", "old"]);
});

// ── Every capability uses it ────────────────────────────────────────────────────────────

test("no capability resolves a project by 'the owner's newest' any more", async () => {
  // The defect was five copies of one query. A sixth copy would reintroduce it silently, so this
  // asserts the pattern is gone rather than asserting five call sites individually.
  for (const file of ["appBuildService.mjs", "appPublishService.mjs"]) {
    const source = await readFile(
      fileURLToPath(new URL(`../../shell/server/lib/appBuild/${file}`, import.meta.url)), "utf8",
    );
    const suspect = source.split("\n").filter((line) => /\.not\("tree", "is", null\)/.test(line));
    assert.equal(suspect.length, 0,
      `${file} still resolves a project without conversation scope:\n${suspect.join("\n")}`);
  }
});

test("publish, repair, preview, QA, export and domains all go through the scoped resolver", async () => {
  const build = await readFile(fileURLToPath(new URL("../../shell/server/lib/appBuild/appBuildService.mjs", import.meta.url)), "utf8");
  const publish = await readFile(fileURLToPath(new URL("../../shell/server/lib/appBuild/appPublishService.mjs", import.meta.url)), "utf8");
  // repair, preview, QA, export
  assert.equal((build.match(/resolveConversationProject\(ctx/g) || []).length, 4);
  // publish, connectDomain
  assert.equal((publish.match(/resolveConversationProject\(ctx/g) || []).length, 2);
});
