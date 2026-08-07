import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { indexTree } from "../../shell/server/lib/builderV2/indexer.mjs";
import { compareGraphIndexes, manifestOf } from "../../shell/server/lib/builderV2/graphParity.mjs";
import {
  beginShadowRun,
  loadIndex,
  persistIndex,
  supabaseGraph,
} from "../../shell/server/lib/builderV2/supabaseTwins.mjs";
import { memoryGraph } from "../../shell/server/lib/builderV2/graphStore.mjs";
import { runShadowDriftCheck } from "../../ops/bv2-shadow-drift.mjs";
import { createFakeBv2Supabase } from "./helpers/fake-bv2-supabase.mjs";

const OWNER_A = "00000000-0000-4000-8000-000000000001";
const OWNER_B = "00000000-0000-4000-8000-000000000002";
const PROJECT = "10000000-0000-4000-8000-000000000001";
const TREE = {
  "src/a.js": 'import { target } from "./b.js";\nexport function first() { return target(); }\nexport function second() { return first(); }\n',
  "src/b.js": "export function target() { return 1; }\n",
  "assets/logo.svg": "<svg></svg>\n",
};
const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const PRODUCTION_TREE = JSON.parse(readFileSync(path.join(FIXTURE_DIR, "run17b6513f-tree.json"), "utf8"));

function cloneIndex(index) {
  return {
    files: new Map([...index.files].map(([key, value]) => [key, structuredClone(value)])),
    edges: structuredClone(index.edges),
    refs: structuredClone(index.refs),
    treeHash: index.treeHash,
    missing: structuredClone(index.missing || []),
    incomplete: structuredClone(index.incomplete || []),
    integrity: structuredClone(index.integrity || []),
  };
}

async function roundTrip(tree = TREE, owner = OWNER_A, project = PROJECT) {
  const client = createFakeBv2Supabase();
  const memory = indexTree(tree);
  await persistIndex(owner, project, memory, { client });
  const persisted = await loadIndex(owner, project, manifestOf(memory), { client });
  return { client, memory, persisted };
}

for (const [point, label] of [
  ["after_revision", "failure immediately after revision creation"],
  ["halfway_symbols", "failure halfway through symbol persistence"],
  ["refs", "failure during reference persistence"],
  ["edges", "failure during dependency-edge persistence"],
]) {
  test(`C4 — ${label} rolls back the parent and every child`, async () => {
    const client = createFakeBv2Supabase();
    client.failNext(point);
    await assert.rejects(persistIndex(OWNER_A, PROJECT, indexTree(TREE), { client }), /injected/);
    for (const table of ["bv2_file_revisions", "bv2_symbols", "bv2_symbol_refs", "bv2_dependency_edges"]) {
      assert.equal(client.table(table).length, 0, `${table} must expose no partial attempt`);
    }
  });
}

test("C4 — retry repairs every injected partial-failure point", async () => {
  for (const point of ["after_revision", "halfway_symbols", "refs", "edges"]) {
    const client = createFakeBv2Supabase();
    client.failNext(point);
    await assert.rejects(persistIndex(OWNER_A, PROJECT, indexTree(TREE), { client }));
    const retry = await persistIndex(OWNER_A, PROJECT, indexTree(TREE), { client });
    assert.equal(retry.written.length, 3, point);
    const loaded = await loadIndex(OWNER_A, PROJECT, retry.manifest, { client });
    assert.deepEqual(loaded.missing, []);
    assert.deepEqual(loaded.integrity, []);
  }
});

test("C4 — persisting the same immutable revision twice writes one graph", async () => {
  const client = createFakeBv2Supabase();
  const index = indexTree(TREE);
  const first = await persistIndex(OWNER_A, PROJECT, index, { client });
  const second = await persistIndex(OWNER_A, PROJECT, index, { client });
  assert.equal(first.written.length, 3);
  assert.deepEqual(second.written, []);
  assert.equal(client.table("bv2_file_revisions").length, 3);
});

test("C4 — two concurrent attempts converge on one immutable revision set", async () => {
  const client = createFakeBv2Supabase();
  const index = indexTree(TREE);
  const [a, b] = await Promise.all([
    persistIndex(OWNER_A, PROJECT, index, { client }),
    persistIndex(OWNER_A, PROJECT, index, { client }),
  ]);
  assert.equal(a.written.length + b.written.length, 3);
  assert.equal(client.table("bv2_file_revisions").length, 3);
  assert.equal(new Set(client.table("bv2_file_revisions").map((row) => `${row.owner}:${row.project_id}:${row.path}:${row.content_hash}`)).size, 3);
});

test("C4 — identical code for two owners remains physically and logically isolated", async () => {
  const client = createFakeBv2Supabase();
  const index = indexTree(TREE);
  await persistIndex(OWNER_A, PROJECT, index, { client });
  await persistIndex(OWNER_B, PROJECT, index, { client });
  assert.equal(client.table("bv2_file_revisions").filter((row) => row.owner === OWNER_A).length, 3);
  assert.equal(client.table("bv2_file_revisions").filter((row) => row.owner === OWNER_B).length, 3);
});

test("C4 — cross-owner graph reads fail closed", async () => {
  const client = createFakeBv2Supabase();
  const index = indexTree(TREE);
  await persistIndex(OWNER_A, PROJECT, index, { client });
  await assert.rejects(supabaseGraph(OWNER_B, PROJECT, manifestOf(index), { client }), /stale/i);
});

const mutationCases = [
  ["missing symbol row", "symbols", (actual) => { actual.files.get("src/a.js").symbols.pop(); }],
  ["extra symbol row", "symbols", (actual) => { actual.files.get("src/a.js").symbols.push({ ...actual.files.get("src/a.js").symbols[0], name: "invented" }); }],
  ["missing reference row", "references", (actual) => { actual.refs.shift(); }],
  ["extra dependency edge", "dependency_edges", (actual) => { actual.edges.push({ fromPath: "src/a.js", toPath: "src/b.js", specifier: "./invented.js" }); }],
  ["wrong opaque state", "wrong_opaque", (actual) => { actual.files.get("src/a.js").opaque = true; }],
  ["wrong content hash", "wrong_content_hash", (actual) => { actual.files.get("src/a.js").contentHash = "0".repeat(64); }],
  ["missing path", "missing_path", (actual) => { actual.files.delete("src/b.js"); actual.edges = actual.edges.filter((edge) => edge.fromPath !== "src/b.js"); actual.refs = actual.refs.filter((ref) => ref.fromPath !== "src/b.js"); }],
  ["extra path", "extra_path", (actual) => { actual.files.set("src/extra.js", { ...structuredClone(actual.files.get("src/b.js")), path: "src/extra.js" }); }],
];

for (const [label, expectedKind, mutate] of mutationCases) {
  test(`H3 — full shadow validation detects ${label}`, async () => {
    const { memory, persisted } = await roundTrip();
    const actual = cloneIndex(persisted);
    mutate(actual);
    const proof = compareGraphIndexes(memory, actual, { owner: OWNER_A, projectId: PROJECT });
    assert.equal(proof.clean, false);
    assert.ok(proof.mismatches.some((mismatch) => mismatch.kind === expectedKind), JSON.stringify(proof.mismatches));
  });
}

test("H3 — stale shadow age is blocking evidence", async () => {
  const { memory, persisted } = await roundTrip();
  const now = Date.parse("2026-08-06T22:00:00.000Z");
  const proof = compareGraphIndexes(memory, persisted, {
    owner: OWNER_A,
    projectId: PROJECT,
    shadowAt: "2026-08-04T00:00:00.000Z",
    maxAgeMs: 36 * 60 * 60 * 1000,
    now,
  });
  assert.equal(proof.clean, false);
  assert.ok(proof.mismatches.some((mismatch) => mismatch.kind === "stale_shadow_run"));
});

test("H3 — a missing shadow run is persisted as exact gap evidence and fails ops", async () => {
  const client = createFakeBv2Supabase();
  client.table("bv2_migration_state").push({
    owner: OWNER_A,
    project_id: PROJECT,
    state: "shadow",
    last_shadow_at: "2026-08-06T00:00:00.000Z",
    notes: { buildId: "missing-build" },
  });
  const result = await runShadowDriftCheck({
    client,
    windowStart: "2026-08-06T00:00:00.000Z",
    now: Date.parse("2026-08-06T22:00:00.000Z"),
    log: () => {},
  });
  assert.equal(result.clean, false);
  assert.equal(result.drift, 1);
  const check = client.table("bv2_shadow_checks")[0];
  assert.equal(check.shadow_run_id, null);
  assert.equal(check.evidence.mismatches[0].kind, "missing_shadow_run");
});

test("H3 — a completed V1 build with no shadow callback is blocking daily evidence", async () => {
  const client = createFakeBv2Supabase();
  client.table("build_jobs").push({
    id: "20000000-0000-4000-8000-000000000001",
    owner: OWNER_A,
    project_id: PROJECT,
    status: "complete",
    updated_at: "2026-08-06T01:00:00.000Z",
  });
  const lines = [];
  const result = await runShadowDriftCheck({
    client,
    windowStart: "2026-08-06T00:00:00.000Z",
    now: Date.parse("2026-08-06T22:00:00.000Z"),
    log: (line) => lines.push(line),
  });
  assert.equal(result.clean, false);
  assert.equal(result.summary.projectsExpected, 1);
  assert.equal(result.summary.missingCount, 1);
  assert.equal(result.evidence[0].mismatches[0].kind, "missing_shadow_for_completed_build");
  assert.ok(lines.some((line) => line.includes('"type":"daily_shadow_summary"')));
});

test("H3 — an unconfigured shadow window is unhealthy instead of silently green", async () => {
  const client = createFakeBv2Supabase();
  const result = await runShadowDriftCheck({ client, log: () => {} });
  assert.equal(result.clean, false);
  assert.deepEqual(result.summary.errors, ["shadow_window_not_configured"]);
});

test("C4/H3 — complete persisted production fixture reload equals every memory graph answer", async () => {
  const { memory, persisted } = await roundTrip(PRODUCTION_TREE);
  const proof = compareGraphIndexes(memory, persisted, { owner: OWNER_A, projectId: PROJECT });
  assert.equal(proof.clean, true, JSON.stringify(proof.mismatches));
  const inMemory = memoryGraph(OWNER_A, PROJECT, memory);
  const fromDatabase = memoryGraph(OWNER_A, PROJECT, persisted);
  for (const path of inMemory.paths()) {
    assert.deepEqual(fromDatabase.importersOf(path), inMemory.importersOf(path));
    assert.deepEqual(fromDatabase.importsOf(path), inMemory.importsOf(path));
  }
});

test("C4 — garbage collection preserves revisions pinned by valid shadow and snapshot state", async () => {
  const client = createFakeBv2Supabase();
  const shadowIndex = indexTree({ "src/a.js": "export function a() { return 1; }\n" });
  await persistIndex(OWNER_A, PROJECT, shadowIndex, { client });
  const shadowRunId = await beginShadowRun(OWNER_A, PROJECT, "build-1", shadowIndex, { client });
  assert.ok(shadowRunId);
  const snapshotIndex = indexTree({ "src/a.js": "export function a() { return 2; }\n" });
  await persistIndex(OWNER_A, PROJECT, snapshotIndex, { client });
  const snapshotRevision = client.table("bv2_file_revisions").find((row) => row.content_hash === manifestOf(snapshotIndex)["src/a.js"]);
  client.table("bv2_snapshots").push({ id: "snapshot-1", owner: OWNER_A, project_id: PROJECT, state: "ready" });
  client.table("bv2_snapshot_files").push({ snapshot_id: "snapshot-1", path: "src/a.js", content_hash: snapshotRevision.content_hash });
  const latestIndex = indexTree({ "src/a.js": "export function a() { return 3; }\n" });
  await persistIndex(OWNER_A, PROJECT, latestIndex, { client });
  client.table("bv2_file_revisions").forEach((row, index) => { row.indexed_at = `2026-08-0${index + 1}T00:00:00.000Z`; });
  const { data: deleted, error } = await client.rpc("bv2_gc_file_revisions", {
    p_owner: OWNER_A,
    p_project_id: PROJECT,
    p_before: "2026-08-06T00:00:00.000Z",
  });
  assert.equal(error, null);
  assert.equal(deleted, 0);
  assert.equal(client.table("bv2_file_revisions").length, 3);
});
