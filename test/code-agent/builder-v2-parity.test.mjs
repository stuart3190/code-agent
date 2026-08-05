// WP-1 parity suite — the C7 stop condition made executable.
//
// The SAME contract assertions run against the memory twin and the supabase twin (over an
// in-memory fake of the PostgREST/storage surface the twin actually uses). Divergence in any
// answer is a hard stop. Graph persistence is proven by round-trip: persist the real modular
// production tree's index, load it back, and every graph answer must match the in-memory graph.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { indexTree } from "../../shell/server/lib/builderV2/indexerV0.mjs";
import { memoryGraph } from "../../shell/server/lib/builderV2/graphStore.mjs";
import { createSnapshotStore, memorySnapshotStorage } from "../../shell/server/lib/builderV2/snapshotStore.mjs";
import { persistIndex, loadIndex, supabaseGraph, supabaseSnapshotStorage } from "../../shell/server/lib/builderV2/supabaseTwins.mjs";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const TREE = JSON.parse(readFileSync(path.join(FIXTURES, "run17b6513f-tree.json"), "utf8"));

// ── a faithful in-memory fake of the query surface the twin uses ─────────────────────────────

function fakeSupabase() {
  const tables = new Map();
  const objects = new Map(); // storage bucket
  let idCounter = 0;
  const rowsOf = (name) => { if (!tables.has(name)) tables.set(name, []); return tables.get(name); };

  function chain(tableName) {
    const state = { filters: [], op: "select", payload: null, single: false, maybe: false, order: null, onConflict: null };
    const matches = (row) => state.filters.every(([col, val]) => row[col] === val);
    const runQuery = () => {
      const rows = rowsOf(tableName);
      if (state.op === "select") {
        let out = rows.filter(matches).map((r) => ({ ...r }));
        if (state.order) out.sort((a, b) => (a[state.order] > b[state.order] ? 1 : -1));
        if (state.single || state.maybe) {
          if (state.single && out.length !== 1) return { data: null, error: { message: `expected 1 row, got ${out.length}` } };
          return { data: out[0] || null, error: null };
        }
        return { data: out, error: null };
      }
      if (state.op === "insert") {
        const inserted = (Array.isArray(state.payload) ? state.payload : [state.payload]).map((row) => {
          const withId = { id: `row-${++idCounter}`, ...row };
          rows.push(withId);
          return { ...withId };
        });
        if (state.single) return { data: inserted[0], error: null };
        return { data: inserted, error: null };
      }
      if (state.op === "upsert") {
        const keys = (state.onConflict || "").split(",").filter(Boolean);
        const row = state.payload;
        const existing = keys.length ? rows.find((r) => keys.every((k) => r[k] === row[k])) : null;
        if (existing) Object.assign(existing, row);
        else rows.push({ id: `row-${++idCounter}`, ...row });
        return { data: null, error: null };
      }
      if (state.op === "update") {
        for (const row of rows) if (matches(row)) Object.assign(row, state.payload);
        return { data: null, error: null };
      }
      if (state.op === "delete") {
        const keep = rows.filter((r) => !matches(r));
        rows.length = 0;
        rows.push(...keep);
        return { data: null, error: null };
      }
      return { data: null, error: { message: `unsupported op ${state.op}` } };
    };
    const api = {
      select() { if (state.op === "select") return api; state.selectAfter = true; return api; },
      insert(payload) { state.op = "insert"; state.payload = payload; return api; },
      upsert(payload, opts = {}) { state.op = "upsert"; state.payload = payload; state.onConflict = opts.onConflict; return api; },
      update(payload) { state.op = "update"; state.payload = payload; return api; },
      delete() { state.op = "delete"; return api; },
      eq(col, val) { state.filters.push([col, val]); return api; },
      order(col) { state.order = col; return api; },
      single() { state.single = true; return Promise.resolve(runQuery()); },
      maybeSingle() { state.maybe = true; return Promise.resolve(runQuery()); },
      then(resolve, reject) { return Promise.resolve(runQuery()).then(resolve, reject); },
    };
    return api;
  }

  return {
    from: (name) => chain(name),
    storage: {
      from: () => ({
        upload: async (p, buf) => { objects.set(p, Buffer.from(buf)); return { error: null }; },
        download: async (p) => (objects.has(p)
          ? { data: { arrayBuffer: async () => objects.get(p) }, error: null }
          : { data: null, error: { message: "not found" } }),
        remove: async (paths) => { for (const p of paths) objects.delete(p); return { error: null }; },
      }),
    },
    _tables: tables,
    _objects: objects,
  };
}

// ── shared contract: identical assertions against both storages ──────────────────────────────

function contract(name, makeStorage) {
  test(`PARITY[${name}] — atomic creation, isolation, promotion, gc: the memory contract holds`, async () => {
    const storage = makeStorage();
    const store = createSnapshotStore(storage);

    // C1 isolation.
    const tree = { "src/a.js": "export const same = 1;" };
    const snapA = await store.createSnapshot("owner-A", "proj-A", tree, { reason: "initial" });
    const snapB = await store.createSnapshot("owner-B", "proj-B", tree, { reason: "initial" });
    assert.equal(snapA.tree_hash, snapB.tree_hash);
    assert.equal(snapA.state, "ready");
    await assert.rejects(store.materialize("owner-B", snapA.id), /not found for this owner/);

    // C2 promotion discipline.
    await store.promote("owner-A", "proj-A", "green", snapA.id);
    assert.equal(await store.pointer("owner-A", "proj-A", "green"), snapA.id);
    await storage.updateSnapshot(snapA.id, { state: "corrupt" });
    const v2 = await store.createSnapshot("owner-A", "proj-A", { "src/a.js": "two" }, { reason: "increment:1" });
    await assert.rejects(store.promote("owner-A", "proj-A", "green", snapA.id), /only ready/);
    assert.equal(await store.pointer("owner-A", "proj-A", "green"), snapA.id, "failed promotion keeps the pointer");
    const promoted = await store.promote("owner-A", "proj-A", "green", v2.id);
    assert.equal(promoted.previous, snapA.id);

    // Materialise round-trip.
    const materialized = await store.materialize("owner-A", v2.id);
    assert.deepEqual(materialized, { "src/a.js": "two" });

    // GC: owner-scoped blob sweep, cross-owner blobs untouched.
    await store.gc("owner-A", "proj-A", { keepLatest: 1 });
    const bTree = await store.materialize("owner-B", snapB.id);
    assert.equal(bTree["src/a.js"], "export const same = 1;", "owner B untouched by owner A's GC");
  });
}

contract("memory", () => memorySnapshotStorage());
contract("supabase-fake", () => supabaseSnapshotStorage({ client: fakeSupabase() }));

test("PARITY — large blobs route through the bucket and round-trip byte-identically", async () => {
  const client = fakeSupabase();
  const storage = supabaseSnapshotStorage({ client });
  const store = createSnapshotStore(storage);
  const big = "x".repeat(70_000);
  const snap = await store.createSnapshot("owner-A", "proj", { "src/big.js": big, "src/small.js": "tiny" });
  assert.equal(snap.state, "ready");
  assert.equal(client._objects.size, 1, "exactly the oversized blob went to the bucket");
  const [bucketPath] = client._objects.keys();
  assert.match(bucketPath, /^bv2\/owner-A\//, "bucket path is owner-prefixed (C1)");
  const tree = await store.materialize("owner-A", snap.id);
  assert.equal(tree["src/big.js"], big);
  assert.equal(tree["src/small.js"], "tiny");
});

// ── graph round-trip parity on the real production tree ──────────────────────────────────────

test("PARITY — the persisted graph answers exactly like the in-memory graph (round-trip)", async () => {
  const client = fakeSupabase();
  const treeIndex = indexTree(TREE);
  const manifest = Object.fromEntries([...treeIndex.files].map(([p, f]) => [p, f.contentHash]));

  const first = await persistIndex("owner-A", "proj", treeIndex, { client });
  assert.ok(first.written.length > 0);
  const second = await persistIndex("owner-A", "proj", treeIndex, { client });
  assert.deepEqual(second.written, [], "idempotent: an unchanged tree writes nothing");

  const memory = memoryGraph("owner-A", "proj", treeIndex);
  const persisted = await supabaseGraph("owner-A", "proj", manifest, { client });

  assert.equal(persisted.treeHash, memory.treeHash, "tree hash survives the round-trip");
  for (const probe of ["src/components/BookingSlotSelector.jsx", "src/data/bookings.js", "src/App.jsx"]) {
    assert.deepEqual(persisted.importersOf(probe), memory.importersOf(probe), `importersOf(${probe})`);
    assert.deepEqual(persisted.importsOf(probe), memory.importsOf(probe), `importsOf(${probe})`);
    assert.deepEqual(persisted.neighbors(probe, { depth: 1 }), memory.neighbors(probe, { depth: 1 }), `neighbors(${probe})`);
  }
  const journey = { id: "reserve-picking-slot", title: "A visitor reserves an available strawberry picking slot", entities: ["booking"] };
  assert.deepEqual(persisted.owners(journey), memory.owners(journey), "journey ownership identical");
  assert.deepEqual(persisted.staleCheck(manifest), [], "nothing stale after a faithful round-trip");

  // A stale manifest entry fails LOUDLY — the graph never silently answers from missing rows.
  const tampered = { ...manifest, "src/App.jsx": "0".repeat(64) };
  await assert.rejects(supabaseGraph("owner-A", "proj", tampered, { client }), /stale — reindex/);
});
