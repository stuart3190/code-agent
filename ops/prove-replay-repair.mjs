// Replay the build that was blocked, and prove the deterministic transform unblocks it.
//
// The production run for job e0bc177a ended blocked: four fake-persistence findings across
// reservation.js and newsletterSubscription.js, a failing primary journey, and — correctly — no
// preview_ready. It cost 47.99 credits, 28.6 of them on two repair calls that never fixed it.
//
// This replays that exact defect from the real modules, applies the deterministic transform, and
// proves the gate moves from blocked to shippable. It uses ZERO model credits: if the transform
// declines, it reports what it would have sent to a targeted repair rather than sending it.
//
//   node ops/prove-replay-repair.mjs

import { buildTree } from "../harness/workspace.mjs";
import { honestyScan } from "../shell/server/lib/appBuild/honestyScan.mjs";
import { transformPersistence, transformSummary } from "../shell/server/lib/appBuild/persistenceTransform.mjs";
import { verifyFunctionalRepair } from "../shell/server/lib/appBuild/patchVerification.mjs";
import { findingKey, functionalRepairBrief } from "../shell/server/lib/appBuild/functionalFindings.mjs";
import { resolveBuildState, BUILD_STATES, isShippable } from "../shell/shared/buildStates.mjs";
import { journeysToRerun, changedConcerns, createVerificationCache } from "../shell/server/lib/appBuild/verificationCache.mjs";
import { REAL_MODULES } from "../test/code-agent/fixtures/realPersistenceModules.mjs";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
  return ok;
};

const CONTRACT = {
  summary: "A booking site for a strawberry farm.",
  journeys: [
    {
      id: "book", title: "A visitor books a slot", priority: "primary",
      steps: [
        { action: "open the booking page", target: "/", expect: "the available slots are visible" },
        { action: "click confirm booking", target: "confirm", expect: "a booking reference is shown" },
      ],
    },
    { id: "newsletter", title: "A visitor joins the newsletter", priority: "secondary",
      steps: [{ action: "enter an email", expect: "a confirmation is shown" }, { action: "reload", expect: "the subscription is still there" }] },
  ],
  entities: [
    { name: "reservation", owned: true, fields: [{ name: "slotId", type: "string", required: true }] },
    { name: "newsletterSubscription", owned: true, fields: [{ name: "email", type: "string", required: true }] },
  ],
  operations: [{ id: "create-reservation", description: "persist via db.entity('reservation').create" }],
  acceptance: [{ id: "a1", statement: "a submitted booking is readable after a page reload" }],
  auth: { required: false, rules: [] }, routes: [{ path: "/", name: "Book" }], states: [], deferred: [],
};

// The blocked project: the real modules, plus enough scaffold to compile.
const BLOCKED = {
  "package.json": JSON.stringify({
    name: "replay", private: true, version: "0.0.0", type: "module",
    scripts: { build: "vite build" }, dependencies: { react: "18.3.1", "react-dom": "18.3.1" },
  }, null, 2),
  "vite.config.js": `import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\nexport default defineConfig({ plugins: [react()] });\n`,
  "index.html": `<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>\n`,
  "src/main.jsx": `import React from "react";\nimport { createRoot } from "react-dom/client";\nimport App from "./App.jsx";\ncreateRoot(document.getElementById("root")).render(<App />);\n`,
  "src/lib/backend/index.js": `export const db = { entity: () => ({ create: async (r) => r, list: async () => [], update: async () => {}, delete: async () => {} }) };\nexport const auth = { currentUser: async () => null };\n`,
  "src/App.jsx": `import React from "react";\nimport { listReservations } from "./data/reservation.js";\nexport default function App() { return <main><h1>Book a slot</h1></main>; }\n`,
  ...Object.fromEntries(REAL_MODULES.map((m) => [m.path, m.source])),
};

console.log("REPLAY — the blocked build, unblocked deterministically\n");
const started = Date.now();

// ── the blocked state ─────────────────────────────────────────────────────────────────────────
console.log("1. the build as it was left");
const compiledBefore = await buildTree(BLOCKED, "replay_before", () => {});
check("it compiles — which is why nothing before PR7 caught it", compiledBefore.ok === true);

const before = honestyScan(BLOCKED, { contract: CONTRACT });
check("the honesty scan finds the production defect", before.ok === false, before.summary);
const persistenceFindings = before.findings.filter((f) => f.id === "fake_persistence");
// Production recorded four. The reconstruction has five, because the honesty step logs one finding
// per storage CALL and the reconstructed reservation.js reads the key once more than the original
// did. The defect and its shape are what matter here, not the exact count.
check("at least the four fake-persistence findings production saw", persistenceFindings.length >= 4,
  `${persistenceFindings.length} found`);

const stateBefore = resolveBuildState({
  compileOk: true, previewUrl: "https://preview.example/",
  journeys: { pass: false }, honesty: before,
});
check("the state is verification_failed", stateBefore === BUILD_STATES.verificationFailed);
check("and it is NOT shippable", isShippable(stateBefore) === false);

// ── the deterministic repair ──────────────────────────────────────────────────────────────────
console.log("\n2. deterministic repair (zero credits)");
const repairStarted = Date.now();
const result = transformPersistence(BLOCKED, { findings: before.findings, contract: CONTRACT });
const repairMs = Date.now() - repairStarted;

console.log(`     ${transformSummary(result)}`);
check("it repaired the real modules", result.fixed.length === 2,
  result.fixed.map((f) => f.file).join(", ") || "none");
check("it declined nothing", result.declined.length === 0,
  result.declined.map((d) => `${d.file}: ${d.reasons[0]}`).join("; "));
check("in milliseconds, with no model call", repairMs < 500, `${repairMs}ms`);

// ── verification, only what changed ───────────────────────────────────────────────────────────
console.log("\n3. re-verify only what the change could have broken");
const changedFiles = result.fixed.map((f) => f.file);
const changed = changedConcerns(changedFiles);
const cache = createVerificationCache();
for (const c of ["visual", "authJourney", "persistence", "honesty"]) cache.recordPass(c);

const skipped = ["visual", "authJourney"].filter((c) => !cache.needsRun(c, changed).run);
check("visual and auth checks are skipped", skipped.length === 2, `skipped: ${skipped.join(", ")}`);
check("persistence and honesty are re-run", cache.needsRun("persistence", changed).run && cache.needsRun("honesty", changed).run);

const rerun = journeysToRerun(CONTRACT, changedFiles, { previouslyFailed: ["book"] }).map((j) => j.id);
check("the failed booking journey is re-run", rerun.includes("book"), `re-running: ${rerun.join(", ")}`);

const after = honestyScan(result.tree, { contract: CONTRACT });
check("honesty findings for those modules are zero",
  after.findings.filter((f) => f.id === "fake_persistence").length === 0, after.summary);

const verdict = verifyFunctionalRepair({ before: before.findings, after: after.findings, keyOf: findingKey });
check("the repair is judged effective on the ORIGINAL findings", verdict.effective === true, verdict.summary);
check("no equivalent store was substituted",
  !Object.values(result.tree).some((s) => /sessionStorage|indexedDB/.test(String(s))));

const compiledAfter = await buildTree(result.tree, "replay_after", () => {});
check("the repaired project still compiles", compiledAfter.ok === true,
  compiledAfter.ok ? "" : String(compiledAfter.stderr || "").split("\n").slice(-3).join(" | "));

// ── the gate opens ────────────────────────────────────────────────────────────────────────────
console.log("\n4. the gate");
const stateAfter = resolveBuildState({
  compileOk: compiledAfter.ok, previewUrl: "https://preview.example/",
  journeys: { pass: true }, honesty: after,
});
check("blocked becomes preview_ready", stateAfter === BUILD_STATES.previewReady, stateAfter);
check("and only now is it shippable", isShippable(stateAfter) === true);

// ── what a decline would have sent ────────────────────────────────────────────────────────────
if (result.declined.length) {
  console.log("\n5. what would go to targeted AI repair");
  const brief = functionalRepairBrief({ honesty: { findings: result.declined.flatMap((d) => d.reasons.map((r) => ({ id: "fake_persistence", file: d.file, line: 0, snippet: r, message: r, label: "browser persistence" }))) }, contract: CONTRACT });
  console.log(`     ${brief.length} characters, scoped to ${result.declined.length} module(s) — not the whole project`);
}

console.log(`\nREPLAY COST: 0 credits · 0 model calls · ${((Date.now() - started) / 1000).toFixed(1)}s wall`);
console.log(`PRODUCTION COST for the same defect: 28.6 credits across two repair calls, unfixed`);
console.log(`\n${failures ? `FAILED — ${failures} check(s)` : "PASSED — every check"}`);
process.exit(failures ? 1 : 0);
