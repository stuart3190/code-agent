// Harness build infrastructure. Proves "the app still builds" by actually running
// `npm run build` on the resulting tree — the same bar iterate.mjs used.
//
// Deps are installed ONCE into harness/.deps (all cases share the fixed scaffold
// deps), then junctioned into each case's working copy — the proven trick from
// iterate.mjs:80-83 (Windows `mklink /J`).

import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { REACT_VITE } from "../src/scaffolds/reactVite.mjs";
import { flushDir } from "../src/engine/fileTree.mjs";
import { runProcess } from "../build-worker/processTree.mjs";

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

// The shared scaffold's installed packages — the surface an import preflight must resolve against.
// It is the same node_modules every built project is linked to, so what preflight reads is exactly
// what the compiler will read.
export const depsNodeModules = () => process.env.THRALLO_SCAFFOLD_NODE_MODULES || DEPS_NM;

// Install scaffold deps into harness/.deps. Refresh when the scaffold manifest changes so newly
// approved packages (for example a font family) cannot pass prompts but fail the actual build.
async function installScaffoldDeps(log = console.log, options = {}) {
  const manifest = REACT_VITE["package.json"];
  const manifestPath = path.join(DEPS_DIR, "package.json");
  const incompletePath = path.join(DEPS_DIR, ".install-incomplete");
  const current = existsSync(manifestPath) ? await readFile(manifestPath, "utf8").catch(() => "") : "";
  if (existsSync(DEPS_NM) && current === manifest && !existsSync(incompletePath)) return;
  log(`[deps] ${existsSync(DEPS_NM) ? "refreshing" : "installing"} shared scaffold dependencies...`);
  await mkdir(DEPS_DIR, { recursive: true });
  // npm can create node_modules and then fail. The manifest is an install input,
  // not proof of success; keep this marker across failure/abort/process death.
  await writeFile(incompletePath, "Scaffold dependency installation has not completed.\n", "utf8");
  await writeFile(manifestPath, manifest, "utf8");
  const install = await runProcess(NPM, [...NPM_PREFIX, "install", "--no-audit", "--no-fund"], {
    // Inside the lock holder, npm must stay in the outer command's process group
    // so cancellation cannot release the lock while an orphan install continues.
    spawnImpl: options.inheritProcessGroup
      ? (command, args, spawnOptions) => spawn(command, args, { ...spawnOptions, detached: false })
      : undefined,
    cwd: DEPS_DIR,
    env: options.env || process.env,
    signal: options.signal || null,
    wallMs: options.wallMs || 10 * 60_000,
    outputBytes: options.outputBytes || 8 * 1024 * 1024,
    onStdout: (line) => { options.onStdout?.(line); if (!options.onStdout) log(line.trimEnd()); },
    onStderr: (line) => { options.onStderr?.(line); if (!options.onStderr) log(line.trimEnd()); },
  });
  if (!install.ok) {
    const error = new Error(`npm install failed (${install.classification || `exit ${install.exitCode}`})`);
    Object.assign(error, install);
    throw error;
  }
  await rm(incompletePath, { force: true });
  log("[deps] done.");
}

let depsRefresh = null;
export async function ensureDeps(log = console.log, options = {}) {
  if (depsRefresh) return depsRefresh;
  depsRefresh = (async () => {
    // Production Linux workers share this cache across processes. Hold an OS lock
    // through the readiness check, manifest write and install; process death releases
    // the lock, while the incomplete marker forces the next owner to repair the cache.
    // Other platforms retain the existing process-local serialization.
    if (process.platform !== "linux") return installScaffoldDeps(log, options);
    await mkdir(DEPS_DIR, { recursive: true });
    const result = await runProcess("flock", ["--exclusive", path.join(DEPS_DIR, ".install.lock"),
      process.execPath, fileURLToPath(import.meta.url), "--install-scaffold-deps-locked"], {
      cwd: DEPS_DIR, env: options.env || process.env, signal: options.signal || null,
      wallMs: options.wallMs || 10 * 60_000, outputBytes: options.outputBytes || 8 * 1024 * 1024,
      onStdout: options.onStdout || ((line) => log(line.trimEnd())),
      onStderr: options.onStderr || ((line) => log(line.trimEnd())),
    });
    if (!result.ok) {
      const error = new Error(`npm install failed (${result.classification || `exit ${result.exitCode}`})`);
      Object.assign(error, result);
      throw error;
    }
  })();
  try { return await depsRefresh; }
  finally { depsRefresh = null; }
}

// The lock holder executes the same implementation, without recursively acquiring it.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
    && process.argv[2] === "--install-scaffold-deps-locked") {
  try { await installScaffoldDeps(console.log, { inheritProcessGroup: true }); }
  catch (error) { console.error(error.message); process.exitCode = error.exitCode || 1; }
}

// Flush a tree to a fresh working copy, junction in the shared node_modules, and run
// the production build. Returns { ok, stderr }.
export async function buildTree(tree, caseName, log = console.log, options = {}) {
  const dir = path.join(WORK_DIR, caseName);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await flushDir(tree, dir);

  const nm = path.join(dir, "node_modules");
  if (!existsSync(nm)) {
    await symlink(DEPS_NM, nm, process.platform === "win32" ? "junction" : "dir");
  }

  const result = await runProcess(NPM, [...NPM_PREFIX, "run", "build"], {
    cwd: dir,
    env: options.env || process.env,
    signal: options.signal || null,
    wallMs: options.wallMs || 5 * 60_000,
    outputBytes: options.outputBytes || 8 * 1024 * 1024,
    onStdout: options.onStdout || null,
    onStderr: options.onStderr || null,
  });
  const stderr = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (!result.ok) log("  build stderr (tail):\n" + stderr.split("\n").slice(-8).join("\n"));
  return {
    ok: result.ok,
    stderr: result.ok ? "" : stderr,
    stdout: result.stdout,
    exitCode: result.exitCode,
    classification: result.classification,
    durationMs: result.durationMs,
  };
}
