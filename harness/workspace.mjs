// Harness build infrastructure. Proves "the app still builds" by actually running
// `npm run build` on the resulting tree — the same bar iterate.mjs used.
//
// Deps are installed ONCE into harness/.deps (all cases share the fixed scaffold
// deps), then junctioned into each case's working copy — the proven trick from
// iterate.mjs:80-83 (Windows `mklink /J`).

import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REACT_VITE } from "../src/scaffolds/reactVite.mjs";
import { flushDir } from "../src/engine/fileTree.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEPS_DIR = path.join(HERE, ".deps");
const DEPS_NM = path.join(DEPS_DIR, "node_modules");
const WORK_DIR = path.join(HERE, ".work");
const NPM = process.platform === "win32" ? process.execPath : "npm";
const NPM_PREFIX = process.platform === "win32"
  ? [path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")]
  : [];

// Where buildTree materialized a given case — callers that consume build ARTIFACTS (e.g. the
// shell's publish route reading dist/) resolve the workspace through this, not a copied path.
export const workDirFor = (caseName) => path.join(WORK_DIR, caseName);

// Install scaffold deps into harness/.deps. Refresh when the scaffold manifest changes so newly
// approved packages (for example a font family) cannot pass prompts but fail the actual build.
let depsRefresh = null;
export async function ensureDeps(log = console.log) {
  if (depsRefresh) return depsRefresh;
  depsRefresh = (async () => {
    const manifest = REACT_VITE["package.json"];
    const manifestPath = path.join(DEPS_DIR, "package.json");
    const current = existsSync(manifestPath) ? await readFile(manifestPath, "utf8").catch(() => "") : "";
    if (existsSync(DEPS_NM) && current === manifest) return;
    log(`[deps] ${existsSync(DEPS_NM) ? "refreshing" : "installing"} shared scaffold dependencies...`);
    await mkdir(DEPS_DIR, { recursive: true });
    await writeFile(manifestPath, manifest, "utf8");
    execFileSync(NPM, [...NPM_PREFIX, "install", "--no-audit", "--no-fund"], {
      cwd: DEPS_DIR,
      stdio: "inherit",
    });
    log("[deps] done.");
  })();
  try { return await depsRefresh; }
  finally { depsRefresh = null; }
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
    if (process.platform === "win32") {
      execFileSync("cmd", ["/c", "mklink", "/J", nm, DEPS_NM], { stdio: "ignore" });
    } else {
      const { symlinkSync } = await import("node:fs");
      symlinkSync(DEPS_NM, nm, "dir");
    }
  }

  try {
    execFileSync(NPM, [...NPM_PREFIX, "run", "build"], { cwd: dir, stdio: "pipe" });
    return { ok: true, stderr: "" };
  } catch (e) {
    const stderr = (e.stderr || e.stdout || e.message).toString();
    log("  build stderr (tail):\n" + stderr.split("\n").slice(-8).join("\n"));
    return { ok: false, stderr };
  }
}
