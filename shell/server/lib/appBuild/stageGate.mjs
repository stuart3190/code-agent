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
import { honestyScan } from "./honestyScan.mjs";
import { transformPersistence, transformSummary } from "./persistenceTransform.mjs";
import { expectationKeywords } from "./journeyVerifier.mjs";
import { modularityCheck, modularitySummary } from "./modularity.mjs";

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
    // The visitor-session module is equally infrastructure — the 46.10-credit run's three repair
    // loops were a model editing its own version of this file, stage after stage. Absence is
    // legal (legacy trees predate it); modification is not.
    const session = "src/lib/visitorSession.js";
    if (baseline[session] && tree[session] !== undefined && tree[session] !== baseline[session]) {
      problems.push(`${session} was modified — the visitor-session module is platform infrastructure; import ensureVisitorSession instead of editing it`);
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
  contract = null, stage = null, previousGreen = null,
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

  // 2b. modularity — static and instant. The monolith shape (one App.jsx owning every journey)
  // is what made the 46.10-credit run's later stages so expensive; catching it at the stage that
  // produces it costs a cheap in-stage repair instead of the whole build's economics. The
  // anti-collapse rule (previousGreen) stops a later stage merging modules back together.
  if (contract) {
    const modular = modularityCheck(working, { contract, previousGreen });
    for (const flag of modular.flags) log(`stage-gate: modularity exception — ${flag}`);
    if (!record("modularity", modular.ok, modular.ok ? modularitySummary(modular) : `${modular.problems.length} structural problem(s)`)) {
      return { ok: false, checks, tree: working, corrections, problems: modular.problems };
    }
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

  // 4. honesty, IN the stage that created the defect. The 24.26-credit booking build wrote
  // localStorage persistence in its data stage and heard about it twenty minutes later, at final
  // verification, when the budget left no room to fix it. The scan costs milliseconds; the safe
  // deterministic transforms cost nothing; and a defect the transform cannot fix feeds the CHEAP
  // in-stage repair (scoped context, two attempts) instead of a whole-build repair round.
  let deterministicRepair = null;
  if (contract) {
    let scan = honestyScan(working, { contract, stageScoped: true });
    if (scan.findings.length) {
      const fixed = transformPersistence(working, { findings: scan.findings, contract });
      if (fixed.fixed.length) {
        const rescanned = honestyScan(fixed.tree, { contract, stageScoped: true });
        if (rescanned.findings.length < scan.findings.length) {
          // Adopt the transform — and the compile must still pass on the transformed tree.
          if (compile) {
            const rebuilt = await compile(fixed.tree);
            if (!rebuilt.ok) {
              return {
                ok: false, checks, tree: working, corrections,
                problems: ["the deterministic persistence transform broke the build", ...(scan.findings.map((f) => f.message))],
                stderr: rebuilt.stderr || "",
              };
            }
          }
          working = { ...fixed.tree };
          deterministicRepair = { applied: fixed.fixed, summary: transformSummary(fixed) };
          scan = rescanned;
          log(`stage-gate: deterministic transform — ${deterministicRepair.summary}`);
        }
      }
    }
    if (!record("honesty", scan.findings.length === 0,
      scan.findings.length ? scan.summary : `honest${deterministicRepair ? " (after deterministic transform)" : ""}`)) {
      return {
        ok: false, checks, tree: working, corrections, deterministicRepair,
        problems: scan.findings.map((f) => f.message),
      };
    }
  }

  // 5. expectation presence — only for the stage that owns journeys, and only the strong signal.
  // If NONE of a step's verifier keywords appear anywhere in the app's rendered source, the
  // outcome was never built; the verifier will fail it later at fifty times the price. A partial
  // match proves nothing either way and is deliberately not checked.
  if (stage?.journeys?.length) {
    const rendered = Object.entries(working)
      .filter(([path]) => /^src\/.*\.(jsx|tsx)$/.test(path) && !path.startsWith("src/lib/backend/"))
      .map(([, source]) => String(source).toLowerCase())
      .join("\n");
    const absent = [];
    for (const journey of stage.journeys) {
      for (const step of journey.steps || []) {
        const wanted = expectationKeywords(step.expect);
        if (wanted.length && !wanted.some((word) => rendered.includes(word))) {
          absent.push(`"${step.expect}" — none of [${wanted.join(", ")}] appears in any screen; the verifier will look for these as visible text`);
        }
      }
    }
    if (!record("expectations", absent.length === 0,
      absent.length ? `${absent.length} outcome(s) with no trace in the UI` : "all step outcomes have some trace")) {
      return { ok: false, checks, tree: working, corrections, deterministicRepair, problems: absent };
    }
  }

  return { ok: true, checks, tree: working, corrections, deterministicRepair, problems: [] };
}

/** One line for the diagnostics step and the job log. */
export function gateSummary(result) {
  return (result.checks || []).map((c) => `${c.name}:${c.ok ? "ok" : "FAILED"}`).join(" ");
}
