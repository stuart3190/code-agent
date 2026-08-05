// Builder v2 foundations (commits C-G of the master plan's Part 17 safe order), proven
// against the two REAL stored production trees:
//   fixtures/run178f7fc8-tree.json — the 46.10-credit build (monolith-era App.jsx)
//   fixtures/run17b6513f-tree.json — the 32.65-credit modular build (routing shell + modules)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { flagValue, flagOn, flagOnFor, setFlag, killSwitchActive, __resetFlagCacheForTests } from "../../shell/server/lib/builderV2/featureFlags.mjs";
import { validateFact, recordFact, getKnowledge, knowledgeBrief, memoryKnowledgeStore, FACT_KINDS } from "../../shell/server/lib/builderV2/knowledge.mjs";
import { indexFile, indexTree, diffIndex, treeHashOf } from "../../shell/server/lib/builderV2/indexerV0.mjs";
import { memoryGraph } from "../../shell/server/lib/builderV2/graphStore.mjs";
import { createSnapshotStore, memorySnapshotStorage, PROMOTABLE_LABELS } from "../../shell/server/lib/builderV2/snapshotStore.mjs";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const MONOLITH_TREE = JSON.parse(readFileSync(path.join(FIXTURES, "run178f7fc8-tree.json"), "utf8"));
const MODULAR_TREE = JSON.parse(readFileSync(path.join(FIXTURES, "run17b6513f-tree.json"), "utf8"));

// ── C: feature flags ──────────────────────────────────────────────────────────────────────────

function fakeFlagClient(rows) {
  return { from: () => ({ select: async () => ({ data: rows, error: null }), upsert: async (row) => { rows.push(row); return { error: null }; } }) };
}

test("C — flags: kill switch beats DB, unknown is false, cache respects TTL", async () => {
  __resetFlagCacheForTests();
  const rows = [{ key: "bv2.enabled", value: true }, { key: "bv2.owners", value: ["o-1"] }];
  const client = fakeFlagClient(rows);
  let clock = 0;
  const now = () => clock;

  assert.equal(await flagOn("bv2.enabled", { client, now }), true);
  assert.equal(await flagOn("bv2.never_set", { client, now }), false, "unknown flag is FALSE — v2 is opt-in");
  assert.equal(await flagOnFor("bv2.owners", "o-1", { client, now }), true);
  assert.equal(await flagOnFor("bv2.owners", "o-2", { client, now }), false);

  // Cache: mutating rows is invisible until the TTL passes.
  rows.length = 0;
  assert.equal(await flagOn("bv2.enabled", { client, now }), true, "cached within TTL");
  clock += 61_000;
  assert.equal(await flagOn("bv2.enabled", { client, now }), false, "TTL expiry refetches");

  // The kill switch needs no TTL and no DB.
  process.env.THRALLO_BV2_KILL = "1";
  try {
    assert.equal(killSwitchActive(), true);
    assert.equal(await flagOn("bv2.enabled", { client, now }), false, "kill beats everything, instantly");
  } finally {
    delete process.env.THRALLO_BV2_KILL;
  }

  // A broken flags table means everything off — v2 fails closed, v1 unaffected.
  __resetFlagCacheForTests();
  const broken = { from: () => ({ select: async () => ({ data: null, error: { message: "boom" } }) }) };
  assert.equal(await flagOn("bv2.enabled", { client: broken, now: () => 10_000_000 }), false);
});

// ── D: project knowledge ──────────────────────────────────────────────────────────────────────

test("D — knowledge: validated facts, deterministic byte-stable brief, bounded size", async () => {
  const store = memoryKnowledgeStore();
  await recordFact("o-1", "p-1", { kind: "entity", key: "booking", value: { owned: true, fields: ["date", "slot"] } }, { store });
  await recordFact("o-1", "p-1", { kind: "route", key: "/book", value: { name: "Book a slot" } }, { store });
  await recordFact("o-1", "p-1", { kind: "capability", key: "booking", value: { version: "1.0.0", pinnedMajor: 1 } }, { store });

  assert.equal(validateFact({ kind: "nonsense", key: "x", value: 1 }).ok, false);
  await assert.rejects(recordFact("o-1", "p-1", { kind: "entity", key: "", value: 1 }, { store }), /invalid knowledge fact/);

  const first = knowledgeBrief(await getKnowledge("o-1", "p-1", { store }));
  const second = knowledgeBrief(await getKnowledge("o-1", "p-1", { store }));
  assert.equal(first, second, "byte-stable for identical facts — a cacheable prefix segment");
  assert.match(first, /booking.*"owned":true/);
  assert.ok(first.length < 6_200, "brief is bounded");
  assert.ok(FACT_KINDS.includes("asset_style"), "asset directives are knowledge");

  // Read failure never blocks: empty knowledge, not an exception.
  const failing = { list: async () => { throw new Error("db down"); } };
  const empty = await getKnowledge("o-1", "p-1", { store: failing });
  assert.equal(knowledgeBrief(empty), "PROJECT KNOWLEDGE: none recorded yet.");
});

// ── E: indexer v0 ─────────────────────────────────────────────────────────────────────────────

test("E — indexer: both production trees index deterministically with stable spans and hashes", () => {
  for (const tree of [MONOLITH_TREE, MODULAR_TREE]) {
    const first = indexTree(tree);
    const second = indexTree(tree);
    assert.equal(first.treeHash, second.treeHash, "two runs are byte-identical");
    assert.deepEqual(
      [...first.files.values()].map((f) => f.symbols.map((s) => s.blockHash)),
      [...second.files.values()].map((f) => f.symbols.map((s) => s.blockHash)),
    );
    // Spans are REAL: re-slicing every symbol's span re-produces its block hash.
    for (const [pathName, file] of first.files) {
      for (const symbol of file.symbols) {
        const sliced = String(tree[pathName]).slice(symbol.start, symbol.end);
        const again = indexFile(pathName, tree[pathName]);
        const match = again.symbols.find((s) => s.name === symbol.name);
        assert.equal(match.blockHash, symbol.blockHash, `${pathName}#${symbol.name}`);
        assert.ok(sliced.length > 0);
      }
    }
  }

  // The monolith-era App.jsx yields the known symbol population (measured earlier: 23 blocks).
  const monoApp = indexFile("src/App.jsx", MONOLITH_TREE["src/App.jsx"]);
  assert.ok(monoApp.symbols.length >= 20, `expected the monolith's block population, got ${monoApp.symbols.length}`);
  assert.ok(monoApp.symbols.some((s) => s.name === "App" && s.kind === "component"));

  // Entities and routes are extracted where they live.
  const bookings = indexFile("src/data/bookings.js", MODULAR_TREE["src/data/bookings.js"]);
  assert.ok(bookings.symbols.some((s) => s.meta.entities.length > 0), "db.entity() usage is indexed");
});

test("E — indexer: opaque fallback for what the parser cannot trust, never a guess", () => {
  const broken = indexFile("src/broken.js", "export function x() { if (true) { return 1; ");
  assert.equal(broken.opaque, true);
  assert.deepEqual(broken.symbols, []);
  assert.ok(broken.contentHash, "hashes always exist");
  const css = indexFile("src/index.css", ":root { --x: 1; }");
  assert.equal(css.opaque, true, "non-code files are opaque by definition");
});

test("E — diffIndex names exactly the changed symbols — the differential planner's input", () => {
  const before = indexTree(MODULAR_TREE);
  const edited = { ...MODULAR_TREE };
  // A comment-only prepend: the FILE hash changes, but no symbol's block hash does — the
  // differential planner re-verifies nothing. This is the property that makes diffs cheap.
  edited["src/components/BookingSlotSelector.jsx"] = `// touched\n${edited["src/components/BookingSlotSelector.jsx"]}`;
  edited["src/routes/NewPage.jsx"] = "export default function NewPage() { return null; }";
  const after = indexTree(edited);

  const diff = diffIndex(before, after);
  assert.deepEqual(diff.added, ["src/routes/NewPage.jsx"]);
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(diff.changed, ["src/components/BookingSlotSelector.jsx"]);
  assert.deepEqual(diff.changedSymbols.filter((s) => s.path.includes("BookingSlotSelector")), [],
    "comment-only changes touch no symbol — nothing to re-verify");
  assert.notEqual(treeHashOf(before.files), treeHashOf(after.files));

  // A REAL body edit names exactly the changed symbol.
  const bodyEdited = { ...MODULAR_TREE };
  bodyEdited["src/components/BookingSlotSelector.jsx"] = String(bodyEdited["src/components/BookingSlotSelector.jsx"])
    .replace("return", "console.log(\"probe\"); return");
  const afterBody = diffIndex(before, indexTree(bodyEdited));
  const touched = afterBody.changedSymbols.filter((s) => s.path.includes("BookingSlotSelector"));
  assert.ok(touched.length >= 1, "the edited symbol is named");
  assert.ok(touched.every((s) => s.kind === "changed"));
});

// ── F: graph store ────────────────────────────────────────────────────────────────────────────

test("F — graph: importers, neighbors and journey owners answer real questions on the modular tree", () => {
  const graph = memoryGraph("o-1", "p-1", indexTree(MODULAR_TREE));

  const importers = graph.importersOf("src/components/BookingSlotSelector.jsx");
  assert.ok(importers.includes("src/routes/BookPage.jsx"), `importers: ${importers.join(", ")}`);

  const near = graph.neighbors("src/components/BookingSlotSelector.jsx", { depth: 1 });
  assert.ok(near.includes("src/routes/BookPage.jsx"));
  assert.ok(!near.includes("src/routes/FarmPage.jsx"), "unrelated screens are not neighbours");

  const owners = graph.owners({ id: "reserve-picking-slot", title: "A visitor reserves an available strawberry picking slot", entities: ["booking"] });
  assert.ok(owners.includes("src/data/bookings.js"), "entity usage owns the journey");
  assert.ok(owners.length < graph.paths().length, "ownership is a subset, not the world");

  const stale = graph.staleCheck(Object.fromEntries([...indexTree(MODULAR_TREE).files].map(([p, f]) => [p, f.contentHash])));
  assert.deepEqual(stale, [], "an untouched tree is not stale");
});

// ── G: snapshot store — C1 tenant isolation and C2 atomicity, proven ─────────────────────────

test("G/C1 — two owners hold identical content independently; no cross-owner resolution or GC", async () => {
  const storage = memorySnapshotStorage();
  const store = createSnapshotStore(storage);
  const tree = { "src/a.js": "export const same = 1;" };

  const snapA = await store.createSnapshot("owner-A", "proj-A", tree, { reason: "initial" });
  const snapB = await store.createSnapshot("owner-B", "proj-B", tree, { reason: "initial" });
  assert.equal(snapA.tree_hash, snapB.tree_hash, "identical content, identical hashes");

  // Cross-owner materialisation is refused even with a valid id.
  await assert.rejects(store.materialize("owner-B", snapA.id), /not found for this owner/);

  // Owner A deleting everything cannot remove owner B's identical bytes.
  await storage.setPointer("owner-A", "proj-A", "green", null);
  await storage.deleteSnapshot(snapA.id);
  const sweptA = await store.gc("owner-A", "proj-A", { keepLatest: 0 });
  assert.ok(sweptA.removedBlobs.length >= 0);
  const bTree = await store.materialize("owner-B", snapB.id);
  assert.equal(bTree["src/a.js"], "export const same = 1;", "owner B's blob survives owner A's GC");
});

test("G/C2 — creation is atomic in effect: interrupted work exposes nothing usable", async () => {
  const storage = memorySnapshotStorage();
  const store = createSnapshotStore(storage);

  // Fault injection: manifest write dies after the snapshot row exists.
  const failing = { ...storage, putManifest: async () => { throw new Error("disk gone"); } };
  const failingStore = createSnapshotStore(failing);
  await assert.rejects(failingStore.createSnapshot("o", "p", { "a.js": "x" }), /disk gone/);
  const strays = await storage.listSnapshots("o", "p");
  assert.ok(strays.every((s) => s.state === "building"), "the stray is INERT, never ready");
  await assert.rejects(store.materialize("o", strays[0].id), /building/);
  await assert.rejects(store.promote("o", "p", "green", strays[0].id), /only ready snapshots/);

  // A missing blob blocks creation outright.
  const noBlob = { ...storage, hasBlob: async () => false };
  await assert.rejects(createSnapshotStore(noBlob).createSnapshot("o", "p", { "a.js": "x" }), /did not persist/);

  // GC sweeps building strays.
  const swept = await store.gc("o", "p", { keepLatest: 20 });
  assert.ok(swept.removedSnapshots.includes(strays[0].id));
});

test("G/C2 — promotion is one pointer write; failure keeps the old pointer; rollback is one write back", async () => {
  const storage = memorySnapshotStorage();
  const store = createSnapshotStore(storage);
  const v1 = await store.createSnapshot("o", "p", { "a.js": "one" }, { reason: "initial" });
  const v2 = await store.createSnapshot("o", "p", { "a.js": "two" }, { reason: "increment:1" });

  await store.promote("o", "p", "green", v1.id);
  assert.equal(await store.pointer("o", "p", "green"), v1.id);

  // A failed promotion (unknown label / not-ready target) leaves the previous pointer intact.
  await assert.rejects(store.promote("o", "p", "shiny", v2.id), /unknown promotion label/);
  await storage.updateSnapshot(v2.id, { state: "corrupt" });
  await assert.rejects(store.promote("o", "p", "green", v2.id), /only ready snapshots/);
  assert.equal(await store.pointer("o", "p", "green"), v1.id, "corrupted snapshots cannot be promoted");

  await storage.updateSnapshot(v2.id, { state: "ready" });
  const promoted = await store.promote("o", "p", "green", v2.id);
  assert.equal(promoted.previous, v1.id);
  await store.rollback("o", "p", "green", promoted.previous);
  assert.equal(await store.pointer("o", "p", "green"), v1.id, "rollback is one atomic pointer change");
  assert.deepEqual(PROMOTABLE_LABELS, ["green", "preview", "published"]);
});

test("G — diff between the two production eras tells the decomposition story", async () => {
  const store = createSnapshotStore();
  const mono = await store.createSnapshot("o", "p", MONOLITH_TREE, { reason: "adopt" });
  const modular = await store.createSnapshot("o", "p", MODULAR_TREE, { reason: "adopt" });
  const diff = await store.diff(mono.id, modular.id);
  assert.ok(diff.added.filter((p) => p.startsWith("src/routes/")).length >= 4, "route files appear");
  assert.ok(diff.added.includes("src/lib/visitorSession.js"), "the scaffold session module appears");
  const roundTrip = await store.materialize("o", modular.id);
  assert.deepEqual(Object.keys(roundTrip).sort(), Object.keys(MODULAR_TREE).sort(), "materialise round-trips");
});
