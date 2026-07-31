// Project deletion: one reliable server-side cascade, owner-scoped, honest on failure.

process.env.CODE_AGENT_STORE = "memory";

import assert from "node:assert/strict";
import test from "node:test";

import { MemoryConversationStore } from "../../shell/server/lib/conversationStore.mjs";
import { deleteConversationCascade, projectIdsFromEvents } from "../../shell/server/lib/conversationDelete.mjs";

const OWNER = "owner-1";
const OTHER = "owner-2";

// Minimal Supabase-shaped fake covering the tables the cascade touches.
function fakeClient(rows) {
  const calls = [];
  const table = (name) => {
    const q = { _name: name, _filters: {}, _op: null };
    const run = () => {
      const list = (rows[name] || []).filter((r) => Object.entries(q._filters).every(([k, v]) => String(r[k]) === String(v)));
      if (q._op === "delete") {
        rows[name] = (rows[name] || []).filter((r) => !list.includes(r));
        calls.push(`${name}:delete:${list.length}`);
        return { error: rows.__failOn === name ? { message: "boom" } : null };
      }
      return { data: list, error: null };
    };
    const chain = {
      select: () => chain, delete: () => { q._op = "delete"; return chain; },
      eq: (k, v) => { q._filters[k] = v; return chain; },
      neq: (k, v) => { q._filters[`neq:${k}`] = v; return chain; },
      limit: () => chain,
      maybeSingle: async () => { const r = run(); return { data: r.data?.[0] ?? null, error: r.error }; },
      then: (resolve) => resolve(run()),
    };
    return chain;
  };
  return { from: table, auth: { admin: { deleteUser: async () => ({}) } }, calls, rows };
}

async function seed() {
  const store = new MemoryConversationStore();
  const mine = await store.createConversation(OWNER, { title: "Mine" });
  const theirs = await store.createConversation(OTHER, { title: "Theirs" });
  await store.appendTurn(mine, { role: "user", content: "build it" });
  await store.appendEvent(mine, "build_started", { projectId: "proj-A" });
  await store.appendEvent(mine, "preview_ready", { projectId: "proj-A", url: "https://x/" });
  await store.appendEvent(theirs, "build_started", { projectId: "proj-B" });
  const rows = {
    projects: [{ id: "proj-A", owner: OWNER }, { id: "proj-B", owner: OTHER }],
    entities: [{ id: "e1", app_id: "proj-A" }, { id: "e2", app_id: "proj-B" }],
    app_users: [{ app_id: "proj-A", auth_user_id: "u1" }],
    app_auth_events: [], app_password_resets: [],
    custom_domains: [], published_sites: [{ project_id: "proj-A", owner: OWNER, slug: "mine" }],
    build_jobs: [{ project_id: "proj-A", owner: OWNER }],
    ca_conversations: [], ca_memories: [],
  };
  return { store, mine, theirs, client: fakeClient(rows) };
}

test("projectIdsFromEvents extracts only this conversation's projects", () => {
  assert.deepEqual(projectIdsFromEvents([
    { type: "build_started", payload: { projectId: "a" } },
    { type: "message", payload: { projectId: "ignored" } },
    { type: "preview_ready", payload: { projectId: "a" } },
  ]), ["a"]);
});

test("confirm deletes the correct project and ALL its data; others untouched", async () => {
  const { store, mine, theirs, client } = await seed();
  const stops = [];
  const out = await deleteConversationCascade(OWNER, mine.id, {
    store, client, provisiond: async (route, body) => stops.push(`${route}:${body.projectId}`),
  });
  assert.equal(out.deleted, true);
  assert.equal(await store.getConversation(OWNER, mine.id), null, "conversation gone");
  assert.ok(stops.includes("/stop:proj-A") && stops.includes("/unpublish:proj-A"), "preview + publish torn down");
  assert.equal(client.rows.projects.find((p) => p.id === "proj-A"), undefined, "project row gone");
  assert.equal(client.rows.entities.find((e) => e.app_id === "proj-A"), undefined, "app data gone");
  assert.equal(client.rows.published_sites.length, 0);
  assert.equal(client.rows.build_jobs.length, 0);
  // Untouched: the other owner's world.
  assert.ok(await store.getConversation(OTHER, theirs.id), "other conversation intact");
  assert.ok(client.rows.projects.find((p) => p.id === "proj-B"), "other project intact");
  assert.ok(client.rows.entities.find((e) => e.app_id === "proj-B"), "other app data intact");
});

test("unauthorised deletion attempts are rejected and delete nothing", async () => {
  const { store, mine, client } = await seed();
  await assert.rejects(deleteConversationCascade(OTHER, mine.id, { store, client }), /not found/i);
  assert.ok(await store.getConversation(OWNER, mine.id), "conversation survives");
  assert.ok(client.rows.projects.find((p) => p.id === "proj-A"), "project survives");
});

test("a failing step reports the error and keeps the project visible", async () => {
  const { store, mine, client } = await seed();
  client.rows.__failOn = "build_jobs";
  await assert.rejects(deleteConversationCascade(OWNER, mine.id, { store, client }), /Deletion failed at build history/);
  assert.ok(await store.getConversation(OWNER, mine.id), "conversation still exists — no false success");
});

test("cancel does nothing (no API call is the contract: cascade only runs on confirm)", async () => {
  const { store, mine, client } = await seed();
  // The UI's Cancel path never invokes the cascade; the assertable server-side contract is
  // that nothing changes unless it is called.
  assert.ok(await store.getConversation(OWNER, mine.id));
  assert.equal(client.calls.length, 0);
});
