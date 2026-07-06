// Harness build infrastructure. Proves "the app still builds" by actually running
// `npm run build` on the resulting tree — the same bar iterate.mjs used.
//
// Deps are installed ONCE into harness/.deps (all cases share the fixed scaffold
// deps), then junctioned into each case's working copy — the proven trick from
// iterate.mjs:80-83 (Windows `mklink /J`).

import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REACT_VITE } from "../src/scaffolds/reactVite.mjs";
import { flushDir } from "../src/engine/fileTree.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEPS_DIR = path.join(HERE, ".deps");
const DEPS_NM = path.join(DEPS_DIR, "node_modules");
const WORK_DIR = path.join(HERE, ".work");

// Where buildTree materialized a given case — callers that consume build ARTIFACTS (e.g. the
// shell's publish route reading dist/) resolve the workspace through this, not a copied path.
export const workDirFor = (caseName) => path.join(WORK_DIR, caseName);

// Install scaffold deps once into harness/.deps. Idempotent: skips if present.
export async function ensureDeps(log = console.log) {
  if (existsSync(DEPS_NM)) return;
  log("[deps] installing shared scaffold deps into harness/.deps (first run only)...");
  await mkdir(DEPS_DIR, { recursive: true });
  await writeFile(path.join(DEPS_DIR, "package.json"), REACT_VITE["package.json"], "utf8");
  execFileSync("npm", ["install", "--no-audit", "--no-fund"], {
    cwd: DEPS_DIR,
    stdio: "inherit",
    shell: true,
  });
  log("[deps] done.");
}

// Flush a tree to a fresh working copy, junction in the shared node_modules, and run
// the production build. Returns { ok, stderr }.
export async function buildTree(tree, caseName, log = console.log) {
  const dir = path.join(WORK_DIR, caseName);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await flushDir(tree, dir);

  const nm = path.join(dir, "node_modules");
  if (!existsSync(nm)) {
    execFileSync("cmd", ["/c", "mklink", "/J", nm, DEPS_NM], { stdio: "ignore" });
  }

  try {
    execFileSync("npm", ["run", "build"], { cwd: dir, stdio: "pipe", shell: true });
    return { ok: true, stderr: "" };
  } catch (e) {
    const stderr = (e.stderr || e.stdout || e.message).toString();
    log("  build stderr (tail):\n" + stderr.split("\n").slice(-8).join("\n"));
    return { ok: false, stderr };
  }
}
