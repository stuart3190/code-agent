// Builder v2 foundation replay — zero model credits, zero network.
//
// Runs the v2 foundations end-to-end over BOTH stored production trees (the 46.10-credit
// monolith-era build and the 32.65-credit modular build), asserting the properties the
// master plan claims: deterministic indexing (two runs byte-identical), graph answers,
// atomic snapshotting with owner isolation, and the monolith→modular diff story.
//
//   node ops/bv2-replay.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { indexTree, treeHashOf } from "../shell/server/lib/builderV2/indexerV0.mjs";
import { memoryGraph } from "../shell/server/lib/builderV2/graphStore.mjs";
import { createSnapshotStore } from "../shell/server/lib/builderV2/snapshotStore.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = (name) => JSON.parse(readFileSync(path.join(HERE, "..", "test", "code-agent", "fixtures", name), "utf8"));

const trees = {
  "run178f7fc8 (46.10cr, monolith era)": FIX("run178f7fc8-tree.json"),
  "run17b6513f (32.65cr, modular)": FIX("run17b6513f-tree.json"),
};

const fail = (msg) => { console.error(`REPLAY FAILED — ${msg}`); process.exit(1); };

console.log("BV2 FOUNDATION REPLAY");
console.log("─────────────────────");

const indexes = {};
for (const [label, tree] of Object.entries(trees)) {
  const first = indexTree(tree);
  const second = indexTree(tree);
  if (first.treeHash !== second.treeHash) fail(`${label}: nondeterministic tree hash`);
  const hashesA = JSON.stringify([...first.files.values()].map((f) => f.symbols.map((s) => s.blockHash)));
  const hashesB = JSON.stringify([...second.files.values()].map((f) => f.symbols.map((s) => s.blockHash)));
  if (hashesA !== hashesB) fail(`${label}: nondeterministic symbol hashes`);
  indexes[label] = first;

  const files = [...first.files.values()];
  const symbols = files.reduce((t, f) => t + f.symbols.length, 0);
  const opaque = files.filter((f) => f.opaque).map((f) => f.path);
  const resolvedEdges = first.edges.filter((e) => e.toPath).length;
  const resolvedRefs = first.refs.filter((r) => r.resolvedPath).length;
  console.log(`\n${label}`);
  console.log(`  files ${files.length} · symbols ${symbols} · import edges ${resolvedEdges} (of ${first.edges.length}) · resolved refs ${resolvedRefs} (of ${first.refs.length})`);
  console.log(`  opaque: ${opaque.join(", ") || "none among code files"} `);
  console.log(`  tree hash ${first.treeHash.slice(0, 16)} — DETERMINISTIC (two runs identical)`);
}

// Graph answers on the modular tree.
const modularLabel = Object.keys(trees)[1];
const graph = memoryGraph("replay-owner", "replay-project", indexes[modularLabel]);
const importers = graph.importersOf("src/components/BookingSlotSelector.jsx");
if (!importers.includes("src/routes/BookPage.jsx")) fail("graph: BookPage should import BookingSlotSelector");
const owners = graph.owners({ id: "reserve-picking-slot", title: "A visitor reserves an available strawberry picking slot", entities: ["booking"] });
console.log(`\ngraph: importersOf(BookingSlotSelector) = ${importers.join(", ")}`);
console.log(`graph: owners(reserve-picking-slot) = ${owners.length} files (${owners.slice(0, 5).join(", ")}…)`);

// Snapshots: atomic creation, owner isolation, the decomposition diff.
const store = createSnapshotStore();
const snapMono = await store.createSnapshot("owner-A", "proj", trees[Object.keys(trees)[0]], { reason: "adopt" });
const snapMod = await store.createSnapshot("owner-A", "proj", trees[modularLabel], { reason: "adopt" });
const snapOther = await store.createSnapshot("owner-B", "proj", { "src/a.js": "export const same = 1;" }, { reason: "initial" });
if (snapMono.state !== "ready" || snapMod.state !== "ready") fail("snapshots must be ready");
await store.promote("owner-A", "proj", "green", snapMod.id);
const diff = await store.diff(snapMono.id, snapMod.id);
console.log(`\nsnapshots: mono ${snapMono.tree_hash.slice(0, 12)} → modular ${snapMod.tree_hash.slice(0, 12)}`);
console.log(`  diff: +${diff.added.length} files (routes: ${diff.added.filter((p) => p.startsWith("src/routes/")).length}), -${diff.removed.length}, ~${diff.changed.length}`);
const roundTrip = await store.materialize("owner-A", snapMod.id);
if (Object.keys(roundTrip).length !== Object.keys(trees[modularLabel]).length) fail("materialise round-trip lost files");
let crossOwnerBlocked = false;
try { await store.materialize("owner-B", snapMod.id); } catch { crossOwnerBlocked = true; }
if (!crossOwnerBlocked) fail("C1: cross-owner materialisation must be refused");
console.log(`  round-trip OK · cross-owner materialisation refused (C1) · green pointer -> ${await store.pointer("owner-A", "proj", "green") === snapMod.id ? "modular" : "WRONG"}`);
if (!snapOther.id) fail("owner-B snapshot missing");

console.log("\nREPLAY PASSED — indexing deterministic, graph sound, snapshots atomic and tenant-isolated.");

// ── --supabase: the SAME proofs against the real production tables, under a test owner ────────
if (process.argv.includes("--supabase")) {
  const { serviceClient } = await import("../shell/server/lib/supabase.mjs");
  const { persistIndex, supabaseGraph, supabaseSnapshotStorage, purgeOwnerForTests } =
    await import("../shell/server/lib/builderV2/supabaseTwins.mjs");
  const client = serviceClient();
  const TEST_OWNER = "00000000-b0b2-4000-8000-00000000b072"; // bv2 replay test tenant, purged below
  const PROJECT = "00000000-b0b2-4000-8000-000000000001";

  console.log("\nSUPABASE MODE (real tables, test owner, purged after)");
  try {
    const modularTree = trees[modularLabel];
    const treeIndex = indexes[modularLabel];
    const manifest = Object.fromEntries([...treeIndex.files].map(([p, f]) => [p, f.contentHash]));

    const wrote = await persistIndex(TEST_OWNER, PROJECT, treeIndex, { client });
    const again = await persistIndex(TEST_OWNER, PROJECT, treeIndex, { client });
    if (again.written.length !== 0) fail("supabase persistIndex is not idempotent");
    const persisted = await supabaseGraph(TEST_OWNER, PROJECT, manifest, { client });
    const memory = memoryGraph(TEST_OWNER, PROJECT, treeIndex);
    if (persisted.treeHash !== memory.treeHash) fail("supabase graph tree hash diverges");
    const probe = "src/components/BookingSlotSelector.jsx";
    if (JSON.stringify(persisted.importersOf(probe)) !== JSON.stringify(memory.importersOf(probe))) {
      fail("supabase graph importersOf diverges");
    }
    console.log(`  graph: ${wrote.written.length} revisions persisted · idempotent re-run wrote 0 · answers match memory`);

    const store = createSnapshotStore(supabaseSnapshotStorage({ client }));
    const snap = await store.createSnapshot(TEST_OWNER, PROJECT, modularTree, { reason: "replay" });
    if (snap.state !== "ready") fail("supabase snapshot not ready");
    await store.promote(TEST_OWNER, PROJECT, "green", snap.id);
    const back = await store.materialize(TEST_OWNER, snap.id);
    if (Object.keys(back).length !== Object.keys(modularTree).length) fail("supabase materialise lost files");
    for (const [p, content] of Object.entries(modularTree)) {
      if (back[p] !== String(content)) fail(`supabase blob round-trip differs at ${p}`);
    }
    console.log(`  snapshot: ${snap.id.slice(0, 8)} ready · green pointer set · ${Object.keys(back).length} files byte-identical`);
    console.log("SUPABASE MODE PASSED");
  } finally {
    await purgeOwnerForTests(TEST_OWNER, { client });
    console.log("  test owner purged");
  }
}
