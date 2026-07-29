// In-memory file tree helpers. A tree is a plain { [relPath]: contents } map.
// Graduated from the inline tree handling in generate.mjs / iterate.mjs.

import { mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import path from "node:path";

const SKIP_DIRS = new Set(["node_modules", "dist", ".vite"]);

// Build a fresh tree from a scaffold (+ optional overlay of starting files).
export function fromScaffold(scaffold, overlay = {}) {
  return { ...scaffold, ...overlay };
}

// Independent copy — so a harness case never mutates the shared scaffold/case data.
export function clone(tree) {
  return { ...tree };
}

// Concatenate every file's contents (newline-joined) — used by marker assertions so
// a feature can be detected wherever it lives, not just in App.jsx.
export function concatSource(tree) {
  return Object.values(tree).join("\n");
}

// Write the whole tree to disk under outDir.
export async function flushDir(tree, outDir) {
  for (const [rel, contents] of Object.entries(tree)) {
    const full = path.join(outDir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, contents, "utf8");
  }
}

// Load a directory into a tree, skipping deps/build output. (Not used by the harness,
// which authors trees directly, but kept for parity with the spike's loadTree.)
export async function loadDir(root) {
  const tree = {};
  async function walk(dir, rel) {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(ent.name)) continue;
      const abs = path.join(dir, ent.name);
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) await walk(abs, r);
      else tree[r] = await readFile(abs, "utf8");
    }
  }
  await walk(root, "");
  return tree;
}
