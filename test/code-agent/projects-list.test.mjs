// The Projects list: paging past twenty, sorting, favourites, archive and bulk actions.
//
// The defect that motivated most of this: `listConversations` carried a default limit of 20 and the
// route called it without one, so PR 7's paging could never reach a twenty-first project however
// carefully it was written. Its e2e stubbed the server, so nothing caught it.

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { MemoryConversationStore } from "../../shell/server/lib/conversationStore.mjs";

const OWNER = "99999999-9999-4999-8999-999999999999";
const read = (p) => readFile(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const readCode = async (p) => (await read(p))
  .replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").map((l) => l.replace(/(^|\s)\/\/.*$/, "$1")).join("\n");

async function storeWith(count) {
  const store = new MemoryConversationStore();
  const made = [];
  for (let i = 0; i < count; i += 1) {
    const row = await store.createConversation(OWNER, { title: `Project ${String(i).padStart(2, "0")}` });
    // Distinct activity times so ordering is deterministic.
    await store.updateConversation(row, { last_activity_at: new Date(Date.now() - i * 60_000).toISOString() });
    made.push(row);
  }
  return { store, made };
}

// ── The limit that made paging impossible ───────────────────────────────────────────────

test("listing projects returns all of them, not the first twenty", async () => {
  const { store } = await storeWith(45);
  const rows = await store.listConversations(OWNER);
  assert.equal(rows.length, 45,
    "a silent cap here meant page two could never exist, whatever the paging above did");
});

test("a limit is honoured when one is actually asked for", async () => {
  const { store } = await storeWith(45);
  assert.equal((await store.listConversations(OWNER, { limit: 10 })).length, 10);
});

test("no caller relies on a default cap", async () => {
  const route = await readCode("../../shell/server/routes/conversations.mjs");
  assert.doesNotMatch(route, /listConversations\(owner\.id\)\s*;/,
    "calling it bare is what silently truncated the list");
  assert.match(route, /listConversations\(owner\.id, \{ archived \}\)/);

  const store = await readCode("../../shell/server/lib/conversationStore.mjs");
  assert.doesNotMatch(store, /listConversations\(owner, limit = 20\)/, "the default cap is gone");
});

// ── Archive is not delete ───────────────────────────────────────────────────────────────

test("archiving hides a project from the list without deleting anything", async () => {
  const { store, made } = await storeWith(3);
  await store.setConversationFlags(OWNER, [made[0].id], { archived_at: new Date().toISOString() });

  const active = await store.listConversations(OWNER);
  assert.equal(active.length, 2, "it leaves the default list");
  assert.ok(!active.some((r) => r.id === made[0].id));

  const archived = await store.listConversations(OWNER, { archived: true });
  assert.deepEqual(archived.map((r) => r.id), [made[0].id], "and appears in the archive");
  assert.equal(archived[0].deleted_at, undefined,
    "nothing is scheduled for removal — that is what delete does");
});

test("restoring puts it back", async () => {
  const { store, made } = await storeWith(2);
  await store.setConversationFlags(OWNER, [made[0].id], { archived_at: new Date().toISOString() });
  await store.setConversationFlags(OWNER, [made[0].id], { archived_at: null });
  assert.equal((await store.listConversations(OWNER)).length, 2);
});

test("a deleted project is not resurrected by an archive action", async () => {
  const { store, made } = await storeWith(2);
  await store.softDeleteConversation(OWNER, made[0].id);
  const changed = await store.setConversationFlags(OWNER, [made[0].id], { favourite: true });
  assert.deepEqual(changed, [], "flags never touch a project in Recently Deleted");
});

// ── Ownership ───────────────────────────────────────────────────────────────────────────

test("another owner's ids simply do not match", async () => {
  const { store, made } = await storeWith(2);
  const changed = await store.setConversationFlags("11111111-1111-4111-8111-111111111111",
    made.map((r) => r.id), { favourite: true });
  assert.deepEqual(changed, [],
    "scoped in the statement rather than checked and then trusted");
  assert.ok((await store.listConversations(OWNER)).every((r) => !r.favourite));
});

// ── Activity in one query ───────────────────────────────────────────────────────────────

test("every card's activity is fetched together, not two queries each", async () => {
  const { store, made } = await storeWith(3);
  await store.appendEvent(made[0], "agent_spawned", { agent: "Builder", status: "Working…" });
  await store.appendEvent(made[1], "preview_ready", { url: "https://x" });

  const byId = await store.listEventsForConversations(OWNER, made.map((r) => r.id), ["agent_spawned", "preview_ready"]);
  assert.equal(byId.size, 3, "every requested conversation is present, even with no events");
  assert.equal(byId.get(made[0].id).length, 1);
  assert.equal(byId.get(made[2].id).length, 0, "an empty list, not a missing key");
});

test("the route batches activity and filters to what a card renders", async () => {
  const route = await readCode("../../shell/server/routes/conversations.mjs");
  assert.match(route, /listEventsForConversations/,
    "two queries per card meant a page of twenty cost forty round trips");
  // The single-conversation SSE endpoint still uses listEvents legitimately; what must be gone is
  // the call inside the per-card enrichment loop.
  const start = route.indexOf("const conversations = page.map");
  const enrichment = route.slice(start, route.indexOf("return sendJson", start));
  assert.ok(enrichment.length > 200 && enrichment.length < route.length, "the enrichment block was isolated");
  assert.doesNotMatch(enrichment, /store\.listEvents\(/, "the per-card call is gone");
  assert.match(route, /CARD_EVENT_TYPES/, "and only the event types a card reads are fetched");
});

// ── Sorting ─────────────────────────────────────────────────────────────────────────────

test("favourites lead whatever the sort is, and every order is total", async () => {
  const route = await readCode("../../shell/server/routes/conversations.mjs");
  assert.match(route, /if \(!!a\.row\.favourite !== !!b\.row\.favourite\) return a\.row\.favourite \? -1 : 1;/,
    "pinning something and then losing it to an alphabetical sort would make the pin pointless");
  assert.match(route, /localeCompare\(String\(b\.row\.id\)\)/,
    "a stable tiebreak, or page two can repeat or skip a row");
  // Never deployed must sort last, which a 0 timestamp would not do.
  assert.match(route, /-Infinity/);
});

test("an unknown sort falls back rather than erroring", async () => {
  const route = await readCode("../../shell/server/routes/conversations.mjs");
  assert.match(route, /SORTS\[params\?\.get\("sort"\)\] \? params\.get\("sort"\) : "activity"/);
});

// ── Bulk ────────────────────────────────────────────────────────────────────────────────

test("bulk delete is the SAME soft delete a single project gets", async () => {
  const route = await readCode("../../shell/server/routes/conversations.mjs");
  assert.match(route, /softDeleteConversation/,
    "a bulk action that deleted more permanently than the individual one would be a trap");
  assert.doesNotMatch(route, /deleteConversationCascade/);
});

test("bulk actions are bounded and de-duplicated", async () => {
  const route = await readCode("../../shell/server/routes/conversations.mjs");
  assert.match(route, /new Set\(/, "the same id twice must not count twice");
  assert.match(route, /\.slice\(0, 200\)/, "and an unbounded list is not accepted");
});

test("search covers the names a project is actually remembered by", async () => {
  const route = await readCode("../../shell/server/routes/conversations.mjs");
  // Title alone missed the case where someone remembers the address rather than the name.
  for (const field of ["c.row.title", "c.site?.slug", "c.site?.customDomain"]) {
    assert.ok(route.includes(field), `${field} must be searchable`);
  }
});
