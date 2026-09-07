// The sandbox image copies a fixed set of directories (build-worker/Dockerfile). Every module the
// sandbox entrypoint can reach through static relative imports must live inside that set, or the
// container fails at import time - which is exactly how a verifier change that reached into
// shell/shared took the browser_verify job down on 2026-09-07 while every host-side test passed.
// This walks the import closure from the entrypoint and checks each file against the COPY lines.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ENTRYPOINT = "build-worker/sandbox.mjs";

async function copiedRoots() {
  const dockerfile = await readFile(path.join(ROOT, "build-worker/Dockerfile"), "utf8");
  const roots = [];
  for (const line of dockerfile.split(/\r?\n/)) {
    const match = /^COPY\s+(.+?)\s+\S+\s*$/.exec(line.trim());
    if (!match) continue;
    for (const source of match[1].split(/\s+/)) roots.push(source.replace(/^\.\//, "").replace(/\/$/, ""));
  }
  return roots;
}

// Static relative imports only: bare specifiers resolve inside node_modules, which the image
// installs from the same lockfile, and dynamic imports with computed paths are out of scope.
const IMPORT_PATTERN = /(?:import|export)\s+(?:[^"'`;]*?\s+from\s+)?["'](\.{1,2}\/[^"'`]+)["']|import\(\s*["'](\.{1,2}\/[^"'`]+)["']\s*\)/g;

async function importClosure(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = await readFile(path.join(ROOT, file), "utf8").catch(() => null);
    if (source === null) continue; // reported by the caller as a missing file
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1] || match[2];
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      queue.push(resolved);
    }
  }
  return [...seen];
}

test("every module the sandbox entrypoint can import is copied into the sandbox image", async () => {
  const roots = await copiedRoots();
  assert.ok(roots.includes("build-worker"), "the Dockerfile must copy build-worker itself");
  const files = await importClosure(ENTRYPOINT);
  assert.ok(files.length > 5, "the import walk found the sandbox's dependencies");
  const outside = files.filter((file) => !roots.some((root) => file === root || file.startsWith(`${root}/`)));
  assert.deepEqual(outside, [],
    `these modules are reachable from ${ENTRYPOINT} but not copied by build-worker/Dockerfile:\n${outside.join("\n")}`);
  const missing = [];
  for (const file of files) {
    await readFile(path.join(ROOT, file)).catch(() => missing.push(file));
  }
  assert.deepEqual(missing, [], `these imports do not resolve to a file:\n${missing.join("\n")}`);
});

test("the walk sees the shared contract vocabulary the verifier depends on", async () => {
  const files = await importClosure(ENTRYPOINT);
  assert.ok(files.includes("shell/server/lib/appBuild/journeyVerifier.mjs"), "verifier is reachable");
  assert.ok(files.includes("shell/shared/implementationContract.mjs"),
    "the shared contract module is part of the closure, so the image must copy shell/shared");
});
