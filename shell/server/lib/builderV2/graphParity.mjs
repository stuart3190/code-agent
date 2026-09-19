import crypto from "node:crypto";

import { memoryGraph } from "./graphStore.mjs";

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stable(item)]));
  }
  return value;
}

const ordered = (rows) => rows.map(stable)
  .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

export function manifestOf(treeIndex) {
  return Object.fromEntries([...treeIndex.files]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, file]) => [path, file.contentHash]));
}

export function fileGraphPayload(treeIndex, path) {
  const file = treeIndex.files.get(path);
  if (!file) throw new Error(`file is absent from index: ${path}`);
  const symbolOrdinal = new Map(file.symbols.map((symbol, ordinal) => [symbol, ordinal]));
  const ordinalsByName = new Map();
  for (const [symbol, ordinal] of symbolOrdinal) {
    if (!ordinalsByName.has(symbol.name)) ordinalsByName.set(symbol.name, []);
    ordinalsByName.get(symbol.name).push(ordinal);
  }
  const symbols = file.symbols.map((symbol) => ({
    name: symbol.name,
    kind: symbol.kind,
    exported: !!symbol.exported,
    is_default: !!symbol.isDefault,
    start_offset: symbol.start,
    end_offset: symbol.end,
    block_hash: symbol.blockHash,
    meta: symbol.meta || {},
  }));
  const refs = treeIndex.refs.filter((ref) => ref.fromPath === path).map((ref) => {
    const candidates = ordinalsByName.get(ref.fromSymbol) || [];
    if (candidates.length !== 1) {
      throw new Error(`${path}: reference source symbol ${ref.fromSymbol} is not unique`);
    }
    return {
      from_symbol_ordinal: candidates[0],
      ref_name: ref.refName,
      resolved_path: ref.resolvedPath ?? null,
      count: 1,
    };
  });
  const edges = treeIndex.edges.filter((edge) => edge.fromPath === path).map((edge) => ({
    to_path: edge.toPath ?? null,
    specifier: edge.specifier,
  }));
  return {
    file: {
      path,
      content_hash: file.contentHash,
      size_bytes: file.sizeBytes,
      tokens: file.tokens,
      opaque: !!file.opaque,
    },
    symbols,
    refs,
    edges,
  };
}

export function fileGraphHash(treeIndex, path) {
  return sha256(JSON.stringify(stable(fileGraphPayload(treeIndex, path))));
}

function comparableSymbols(file) {
  return ordered((file?.symbols || []).map((symbol) => ({
    name: symbol.name,
    kind: symbol.kind,
    exported: !!symbol.exported,
    isDefault: !!symbol.isDefault,
    start: symbol.start,
    end: symbol.end,
    blockHash: symbol.blockHash,
    meta: symbol.meta || {},
  })));
}

function comparableRefs(index, path) {
  return ordered(index.refs.filter((ref) => ref.fromPath === path).map((ref) => ({
    fromPath: ref.fromPath,
    fromSymbol: ref.fromSymbol,
    refName: ref.refName,
    resolvedPath: ref.resolvedPath ?? null,
  })));
}

function comparableEdges(index, path) {
  return ordered(index.edges.filter((edge) => edge.fromPath === path).map((edge) => ({
    fromPath: edge.fromPath,
    toPath: edge.toPath ?? null,
    specifier: edge.specifier,
  })));
}

function same(a, b) {
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

function addMismatch(mismatches, kind, details = {}) {
  mismatches.push({ kind, ...details });
}

/**
 * Compare every persisted graph primitive and every derived graph answer used by Builder V2.
 * The returned evidence is storage-safe JSON and deliberately contains exact expected/actual
 * values only for mismatches, rather than a lossy count-only summary.
 */
export function compareGraphIndexes(expected, actual, {
  owner,
  projectId,
  buildId = null,
  shadowRunId = null,
  shadowAt = null,
  maxAgeMs = 36 * 60 * 60 * 1000,
  now = Date.now(),
} = {}) {
  const mismatches = [];
  const expectedPaths = [...expected.files.keys()].sort();
  const actualPaths = [...actual.files.keys()].sort();
  const expectedSet = new Set(expectedPaths);
  const actualSet = new Set(actualPaths);

  for (const path of expectedPaths) if (!actualSet.has(path)) addMismatch(mismatches, "missing_path", { path });
  for (const path of actualPaths) if (!expectedSet.has(path)) addMismatch(mismatches, "extra_path", { path });
  for (const path of actual.missing || []) addMismatch(mismatches, "missing_revision", { path });
  for (const row of actual.incomplete || []) addMismatch(mismatches, "incomplete_revision", row);
  for (const row of actual.integrity || []) addMismatch(mismatches, "persisted_integrity", row);

  if (shadowAt) {
    const ageMs = now - new Date(shadowAt).getTime();
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > maxAgeMs) {
      addMismatch(mismatches, "stale_shadow_run", { shadowAt, ageMs, maxAgeMs });
    }
  }

  for (const path of expectedPaths.filter((candidate) => actualSet.has(candidate))) {
    const want = expected.files.get(path);
    const have = actual.files.get(path);
    for (const [field, expectedValue, actualValue] of [
      ["content_hash", want.contentHash, have.contentHash],
      ["opaque", !!want.opaque, !!have.opaque],
      ["size_bytes", want.sizeBytes, have.sizeBytes],
      ["tokens", want.tokens, have.tokens],
    ]) {
      if (!same(expectedValue, actualValue)) {
        addMismatch(mismatches, `wrong_${field}`, { path, expected: expectedValue, actual: actualValue });
      }
    }
    const wantSymbols = comparableSymbols(want);
    const haveSymbols = comparableSymbols(have);
    if (!same(wantSymbols, haveSymbols)) {
      addMismatch(mismatches, "symbols", { path, expected: wantSymbols, actual: haveSymbols });
    }
    const wantRefs = comparableRefs(expected, path);
    const haveRefs = comparableRefs(actual, path);
    if (!same(wantRefs, haveRefs)) {
      addMismatch(mismatches, "references", { path, expected: wantRefs, actual: haveRefs });
    }
    const wantEdges = comparableEdges(expected, path);
    const haveEdges = comparableEdges(actual, path);
    if (!same(wantEdges, haveEdges)) {
      addMismatch(mismatches, "dependency_edges", { path, expected: wantEdges, actual: haveEdges });
    }
  }

  const memory = memoryGraph(owner, projectId, expected);
  const persisted = memoryGraph(owner, projectId, actual);
  for (const path of [...new Set([...expectedPaths, ...actualPaths])].sort()) {
    const expectedImporters = memory.importersOf(path);
    const actualImporters = persisted.importersOf(path);
    if (!same(expectedImporters, actualImporters)) {
      addMismatch(mismatches, "importers_of", { path, expected: expectedImporters, actual: actualImporters });
    }
    const expectedImports = memory.importsOf(path);
    const actualImports = persisted.importsOf(path);
    if (!same(expectedImports, actualImports)) {
      addMismatch(mismatches, "imports_of", { path, expected: expectedImports, actual: actualImports });
    }
  }
  const symbolNames = [...new Set([
    ...[...expected.files.values()].flatMap((file) => file.symbols.map((symbol) => symbol.name)),
    ...[...actual.files.values()].flatMap((file) => file.symbols.map((symbol) => symbol.name)),
  ])].sort();
  for (const symbolName of symbolNames) {
    const expectedCallers = memory.callersOf(symbolName);
    const actualCallers = persisted.callersOf(symbolName);
    if (!same(expectedCallers, actualCallers)) {
      addMismatch(mismatches, "callers_of", { symbolName, expected: expectedCallers, actual: actualCallers });
    }
  }

  const entityNames = [...new Set([...expected.files.values()]
    .flatMap((file) => file.symbols.flatMap((symbol) => symbol.meta?.entities || [])))].sort();
  const ownershipProbes = [
    ...expectedPaths.map((path) => ({ id: path, title: path, entities: [] })),
    ...entityNames.map((entity) => ({ id: `entity-${entity}`, title: entity, entities: [entity] })),
  ];
  for (const probe of ownershipProbes) {
    const expectedOwners = memory.owners(probe);
    const actualOwners = persisted.owners(probe);
    if (!same(expectedOwners, actualOwners)) {
      addMismatch(mismatches, "ownership", { probe, expected: expectedOwners, actual: actualOwners });
    }
  }

  return {
    clean: mismatches.length === 0,
    owner,
    projectId,
    buildId,
    shadowRunId,
    checkedAt: new Date(now).toISOString(),
    shadowAt,
    expectedTreeHash: expected.treeHash,
    actualTreeHash: actual.treeHash,
    expectedCounts: {
      paths: expectedPaths.length,
      symbols: [...expected.files.values()].reduce((sum, file) => sum + file.symbols.length, 0),
      refs: expected.refs.length,
      edges: expected.edges.length,
    },
    actualCounts: {
      paths: actualPaths.length,
      symbols: [...actual.files.values()].reduce((sum, file) => sum + file.symbols.length, 0),
      refs: actual.refs.length,
      edges: actual.edges.length,
    },
    mismatches,
  };
}

