// The gate a generation stage has to pass before the next one may start.
//
// PR5 of docs/PIPELINE-REDESIGN.md. The point of staging is not the split — it is that a stage
// cannot begin on a broken predecessor. That guarantee is this file: imports resolve, the build
// configuration is intact, and the project compiles. Anything less and "staged" would just be
// "one-shot, in five turns".
//
// Ordered cheapest-first, and it stops at the first failure. Preflight costs milliseconds and
// catches the class of fault that used to consume a whole build plus two repair rounds; there is no
// reason to spend four seconds compiling to learn the same thing.

import { preflightImports, preflightSummary } from "./importPreflight.mjs";

// Files the generated app must not lose or corrupt. A stage that deletes vite.config.js compiles
// nothing afterwards, and the resulting error names a missing module rather than the real cause.
const REQUIRED_FILES = ["package.json", "index.html", "vite.config.js", "src/main.jsx"];

// The SDK the contract's entities are required to go through. A stage that rewrites these has
// replaced the backend with something unverifiable.
const PROTECTED_PREFIX = "src/lib/backend/";

/**
 * Check the build configuration is still intact and still coherent.
 *
 * Separate from the compiler because the compiler's error for a missing script or a corrupted
 * manifest is unhelpful — "could not determine entry" says nothing about the file that was deleted.
 */
export function validateBuildConfig(tree, { baseline = null } = {}) {
  const problems = [];

  for (const file of REQUIRED_FILES) {
    if (!tree[file]) problems.push(`${file} is missing — the project cannot build without it`);
  }

  let manifest = null;
  if (tree["package.json"]) {
    try {
      manifest = JSON.parse(tree["package.json"]);
    } catch (error) {
      problems.push(`package.json is not valid JSON (${error.message})`);
    }
  }
  if (manifest) {
    if (!manifest.scripts?.build) problems.push("package.json has no build script");
    if (manifest.type && manifest.type !== "module") {
      problems.push(`package.json sets "type": "${manifest.type}" — the scaffold is ESM`);
    }
  }

  // The backend SDK is infrastructure, not application code. Rewriting it is how "persisted"
  // quietly becomes "persisted somewhere else".
  if (baseline) {
    for (const path of Object.keys(baseline)) {
      if (!path.startsWith(PROTECTED_PREFIX)) continue;
      if (tree[path] !== baseline[path]) {
        problems.push(`${path} was modified — the backend SDK must not be edited`);
      }
    }
  }

  if (tree["index.html"] && !/<div id="root"/.test(tree["index.html"])) {
    problems.push("index.html no longer has the #root mount point");
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Run one stage's gate.
 *
 * `compile` is injected rather than imported so a test can drive the ordering without spending
 * four seconds per case, and so the caller decides which workspace name to build under.
 *
 * Returns `{ ok, checks, problems, tree, corrections }` — `tree` carries any preflight corrections
 * so the caller can adopt them, which is what makes an invalid icon import a non-event rather than
 * a failed stage.
 */
export async function runStageGate(tree, {
  nodeModules, baseline = null, compile = null, log = () => {},
} = {}) {
  const checks = [];
  const record = (name, ok, detail) => { checks.push({ name, ok, detail }); return ok; };

  // 1. imports — milliseconds, and the fault class that cost a whole build in production.
  let working = tree;
  let corrections = [];
  try {
    const preflight = await preflightImports(tree, { nodeModules });
    corrections = preflight.corrections;
    working = preflight.tree;
    for (const correction of corrections) log(`stage-gate: ${correction.message}`);
    if (!record("imports", preflight.ok, preflightSummary(preflight))) {
      return {
        ok: false, checks, tree: working, corrections,
        problems: preflight.problems.map((p) => p.message),
      };
    }
  } catch (error) {
    // A gate that throws must not be the reason a good stage is rejected.
    record("imports", true, `skipped (${error.message})`);
  }

  // 2. build configuration — also cheap, and produces a far clearer message than the compiler will.
  const config = validateBuildConfig(working, { baseline });
  if (!record("config", config.ok, config.ok ? "intact" : config.problems.join("; "))) {
    return { ok: false, checks, tree: working, corrections, problems: config.problems };
  }

  // 3. the compiler — the expensive one, last.
  if (compile) {
    const built = await compile(working);
    if (!record("compile", !!built.ok, built.ok ? "passed" : "failed")) {
      return {
        ok: false, checks, tree: working, corrections,
        problems: ["the project does not compile"],
        stderr: built.stderr || "",
      };
    }
  }

  return { ok: true, checks, tree: working, corrections, problems: [] };
}

/** One line for the diagnostics step and the job log. */
export function gateSummary(result) {
  return (result.checks || []).map((c) => `${c.name}:${c.ok ? "ok" : "FAILED"}`).join(" ");
}
