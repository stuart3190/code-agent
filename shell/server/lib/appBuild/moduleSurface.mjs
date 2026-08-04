// What a package actually exports, read without running it.
//
// The pinned lucide-react exports 6 014 names. `Instagram` is not one of them — it is a brand icon
// that was removed — and nothing checked before the whole project had been generated and a full
// build spent. The export surface is enumerable in milliseconds, which is the entire argument for
// PR2.
//
// Read STATICALLY. Dynamic import would be simpler and gives a perfect answer, but it executes
// third-party code inside the build server to answer a question about a customer's typo. Every ESM
// barrel worth checking declares its exports in syntax, so parse the syntax:
//
//   export { default as Camera, default as CameraIcon } from './icons/camera.mjs';
//   export { a, b as c } from './x.mjs';
//   export const Foo = ...   export function Bar() {}   export class Baz {}
//   export * from './y.mjs'  ← followed, to a bounded depth
//
// When a package cannot be read this way the answer is "unknown", never "missing" — a preflight
// that guesses wrong is worse than no preflight, because it fails builds that would have worked.

import { readFile } from "node:fs/promises";
import path from "node:path";

const MAX_STAR_DEPTH = 3;
const cache = new Map(); // "<dir>::<specifier>" -> Set | null

// export { a, b as c, default as d }  — with or without a `from` clause.
const NAMED_BLOCK = /export\s*\{([^}]*)\}/g;
// export const/let/var/function/async function/class Name
const DECLARED = /export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g;
// export * from './x'   (export * as ns from is a NAMED export of ns)
const STAR = /export\s*\*\s*from\s*["']([^"']+)["']/g;
const STAR_AS = /export\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from/g;

function namesFromBlock(block) {
  const names = [];
  for (const clause of block.split(",")) {
    const parts = clause.trim().split(/\s+as\s+/);
    if (!parts.length || !parts[0]) continue;
    // `default as Camera` exports Camera; `Camera` exports Camera.
    const exported = (parts.length > 1 ? parts[1] : parts[0]).trim().replace(/^["']|["']$/g, "");
    if (/^[A-Za-z_$][\w$]*$/.test(exported)) names.push(exported);
  }
  return names;
}

async function readSurface(file, depth, seen) {
  if (depth > MAX_STAR_DEPTH || seen.has(file)) return new Set();
  seen.add(file);

  let source;
  try {
    source = await readFile(file, "utf8");
  } catch {
    return new Set();
  }

  const names = new Set();
  for (const match of source.matchAll(NAMED_BLOCK)) namesFromBlock(match[1]).forEach((n) => names.add(n));
  for (const match of source.matchAll(DECLARED)) names.add(match[1]);
  for (const match of source.matchAll(STAR_AS)) names.add(match[1]);

  // `export * from './x'` re-exports everything x exports — follow it, or a barrel-of-barrels
  // package reads as empty and every named import from it looks invalid.
  const dir = path.dirname(file);
  for (const match of source.matchAll(STAR)) {
    const target = match[1];
    if (!target.startsWith(".")) continue; // a star re-export of a THIRD-party package: give up honestly
    for (const candidate of candidatesFor(path.resolve(dir, target))) {
      const nested = await readSurface(candidate, depth + 1, seen);
      if (nested.size) { nested.forEach((n) => names.add(n)); break; }
    }
  }
  return names;
}

function candidatesFor(base) {
  return [base, `${base}.mjs`, `${base}.js`, `${base}.jsx`, `${base}.ts`, `${base}.tsx`,
    path.join(base, "index.mjs"), path.join(base, "index.js")];
}

/**
 * The ESM entry of an installed package, from its manifest.
 *
 * Prefers the `exports` map's import condition, then `module`, then `main`. A package with no ESM
 * entry at all returns null and is treated as unknown rather than empty.
 */
async function esmEntry(packageDir) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
  } catch {
    return null;
  }
  const root = manifest.exports?.["."] ?? manifest.exports;
  const fromExports = typeof root === "string" ? root
    : root?.import?.default || root?.import || root?.default || null;
  const relative = (typeof fromExports === "string" ? fromExports : null)
    || manifest.module || manifest.main || "index.js";
  return path.join(packageDir, relative);
}

/**
 * The set of names `specifier` exports, or null when it cannot be determined.
 *
 * null is a real answer and callers must respect it: "I could not read this package" must never be
 * reported to a customer as "your import is wrong".
 */
export async function exportSurface(specifier, { nodeModules }) {
  const key = `${nodeModules}::${specifier}`;
  if (cache.has(key)) return cache.get(key);

  // Only the package root is resolved: a deep import (`lodash/get`) has its own entry and its own
  // default-only surface, which this deliberately does not try to reason about.
  const packageDir = path.join(nodeModules, ...specifier.split("/"));
  const entry = await esmEntry(packageDir);
  let surface = null;
  if (entry) {
    const names = await readSurface(entry, 0, new Set());
    // An empty result means "parsed nothing", not "exports nothing" — most likely CJS. Unknown.
    surface = names.size ? names : null;
  }
  cache.set(key, surface);
  return surface;
}

/** The installed version, for the brief and for the diagnostics record. */
export async function installedVersion(specifier, { nodeModules }) {
  try {
    const manifest = JSON.parse(await readFile(path.join(nodeModules, ...specifier.split("/"), "package.json"), "utf8"));
    return manifest.version || null;
  } catch {
    return null;
  }
}

export function resetSurfaceCache() {
  cache.clear();
}
