// PR2 + PR3 acceptance, proved against real builds.
//
// PR2 — every import resolves before a compile is spent on it.
// PR3 — every patch is verified, and an unchanged failure escalates instead of ending the run.
//
// Faults are INJECTED and each is asserted to be caught at the earliest stage capable of catching
// it: an invalid import must fail preflight, not `npm run build`. Where a real compile is the only
// honest evidence, a real compile is run.
//
//   node ops/prove-pipeline-reliability.mjs

import { buildTree } from "../harness/workspace.mjs";
import { depsNodeModules } from "../harness/workspace.mjs";
import { preflightImports, preflightSummary } from "../shell/server/lib/appBuild/importPreflight.mjs";
import { verifyPatch, escalate, strategy, STRATEGIES } from "../shell/server/lib/appBuild/patchVerification.mjs";
import { planEndAction } from "../shell/server/lib/appBuild/appBuildService.mjs";

const nodeModules = depsNodeModules();
let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
  return ok;
};

const BASE = {
  "package.json": JSON.stringify({
    name: "booking-site", private: true, version: "0.0.0", type: "module",
    scripts: { build: "vite build" },
    dependencies: { react: "18.3.1", "react-dom": "18.3.1", "lucide-react": "1.28.0" },
  }, null, 2),
  "vite.config.js": `import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\nexport default defineConfig({ plugins: [react()] });\n`,
  "index.html": `<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>\n`,
  "src/main.jsx": `import React from "react";\nimport { createRoot } from "react-dom/client";\nimport App from "./App.jsx";\ncreateRoot(document.getElementById("root")).render(<App />);\n`,
  "src/App.jsx": `import React from "react";\nimport { Calendar } from "lucide-react";\nexport default function App() { return <main><Calendar /><h1>Book an appointment</h1></main>; }\n`,
};

console.log("PR2 — imports resolve before a build is spent\n");

// ── the control: a clean project passes preflight and compiles ────────────────────────────────
console.log("0. control");
const clean = await preflightImports(BASE, { nodeModules });
check("a clean project reports clean", clean.ok, preflightSummary(clean));
check("and compiles", (await buildTree(BASE, "prel_control", () => {})).ok === true);

// ── FAULT 1: an invalid lucide icon ───────────────────────────────────────────────────────────
console.log("\n1. invalid icon import (the production failure)");
const withBadIcon = {
  ...BASE,
  "src/App.jsx": `import React from "react";\nimport { Instagram, Facebook, Calendar } from "lucide-react";\nexport default function App() { return <main><Instagram /><Facebook /><Calendar /></main>; }\n`,
};

// Proof that this is genuinely a build-breaking fault, not a hypothetical one.
const uncorrected = await buildTree(withBadIcon, "prel_bad_icon", () => {});
check("without preflight this fails the compiler", uncorrected.ok === false);

const started = Date.now();
const corrected = await preflightImports(withBadIcon, { nodeModules });
const elapsed = Date.now() - started;
check("preflight catches it BEFORE npm run build", corrected.corrections.length === 2,
  corrected.corrections.map((c) => `${c.from}→${c.to}`).join(", "));
check("in milliseconds, with no model call", elapsed < 2_000, `${elapsed}ms`);
check("the correction records the version it checked against",
  corrected.corrections.every((c) => /^\d+\./.test(c.version || "")));
check("and the corrected project compiles",
  (await buildTree(corrected.tree, "prel_bad_icon_fixed", () => {})).ok === true);

// ── FAULT 2: a missing local module ───────────────────────────────────────────────────────────
console.log("\n2. missing local module");
const missingModule = await preflightImports({
  ...BASE,
  "src/App.jsx": `import { formatDate } from "./lib/format";\nexport default () => <p>{formatDate()}</p>;\n`,
}, { nodeModules });
check("caught before the build", missingModule.problems.some((p) => p.kind === "missing_local_module"),
  missingModule.problems[0]?.message || "not caught");
check("and it names the file and line", /src\/App\.jsx:1/.test(missingModule.problems[0]?.message || ""));

// ── FAULT 3: a non-existent named export ──────────────────────────────────────────────────────
console.log("\n3. non-existent named export");
const badExport = await preflightImports({
  ...BASE,
  "src/App.jsx": `import { NotARealExportAnywhere } from "lucide-react";\nexport default () => null;\n`,
}, { nodeModules });
check("caught before the build", badExport.problems.some((p) => p.kind === "missing_export"),
  badExport.problems[0]?.message || "not caught");
check("nothing is invented when no safe substitute exists", badExport.corrections.length === 0);

// ── FAULT 4: an undeclared dependency ─────────────────────────────────────────────────────────
console.log("\n4. undeclared dependency");
const undeclared = await preflightImports({
  ...BASE, "src/App.jsx": `import { debounce } from "lodash";\nexport default () => null;\n`,
}, { nodeModules });
check("caught before the build", undeclared.problems.some((p) => p.kind === "missing_dependency"));

// ── the asymmetry that makes it safe ──────────────────────────────────────────────────────────
console.log("\n5. never confidently wrong");
const cjs = await preflightImports({
  ...BASE, "src/App.jsx": `import { useState, useMemo } from "react";\nexport default () => null;\n`,
}, { nodeModules });
check("a package whose surface cannot be read produces NO problems", cjs.problems.length === 0,
  "an unreadable surface must never fail a build that would have worked");

// ── PR3 ───────────────────────────────────────────────────────────────────────────────────────
console.log("\n\nPR3 — patches are verified, and an unchanged failure escalates\n");

const OUTPUT = String(uncorrected.stderr || "");
const BEFORE = { "src/App.jsx": withBadIcon["src/App.jsx"] };

console.log("1. the two real production patches, replayed");
// baa3e8fc step 9: removed the unused Clock/Users/Phone imports.
const replayOne = verifyPatch({
  before: { "src/App.jsx": `import { Instagram, Clock, Users, Phone } from "lucide-react";\nexport default () => <Instagram />;\n` },
  after: { "src/App.jsx": `import { Instagram } from "lucide-react";\nexport default () => <Instagram />;\n` },
  output: OUTPUT, fingerprint: "ac60a9b42a79f171", previousFingerprint: "ac60a9b42a79f171",
});
check("repair 1 (deleting unused imports) is judged irrelevant", replayOne.verdict === "irrelevant", replayOne.summary);
check("and costs no attempt", replayOne.countsAsAttempt === false);

// f00c7950 step 7: restored an unrelated window.confirm.
const replayTwo = verifyPatch({
  before: { ...BEFORE, "src/Booking.jsx": "export function cancel() { return true; }\n" },
  after: { ...BEFORE, "src/Booking.jsx": `export function cancel() { return window.confirm("Cancel?"); }\n` },
  output: OUTPUT, fingerprint: "ac60a9b42a79f171", previousFingerprint: "ac60a9b42a79f171",
});
check("repair 2 (an unrelated file) is judged irrelevant", replayTwo.verdict === "irrelevant", replayTwo.summary);
check("and costs no attempt", replayTwo.countsAsAttempt === false);

console.log("\n2. the real fix is recognised as real");
const real = verifyPatch({
  before: BEFORE,
  after: { "src/App.jsx": corrected.tree["src/App.jsx"] },
  output: OUTPUT, resolved: true,
});
check("the correcting patch is judged effective", real.verdict === "effective", real.summary);
check("and does count as an attempt", real.countsAsAttempt === true);

console.log("\n3. escalation, not surrender");
const failed = { status: "complete", result: { buildOk: false, tree: BEFORE, qualityWarnings: [] } };
const round1 = planEndAction(failed, { attempt: 1, diagnostics: { command: "npm run build", output: OUTPUT } });
check("the first round starts on a targeted fix", round1.strategy === "targeted_fix");

let current = round1.strategy;
const climbed = [current];
for (let i = 0; i < 4; i += 1) {
  const next = planEndAction(failed, {
    attempt: 2, previousFingerprints: [round1.fingerprint], strategyId: current,
    diagnostics: { command: "npm run build", output: OUTPUT },
  });
  if (next.kind === "blocked") {
    check("the run stops ONLY after every strategy is exhausted", next.exhausted === true, next.message?.slice(0, 90));
    break;
  }
  current = next.strategy;
  climbed.push(current);
}
check("all four strategies are climbed in order",
  climbed.join(" → ") === STRATEGIES.map((s) => s.id).join(" → "), climbed.join(" → "));
check("the last rung restores the last green checkpoint",
  planEndAction(failed, {
    attempt: 2, previousFingerprints: [round1.fingerprint], strategyId: "regenerate_module",
    diagnostics: { command: "npm run build", output: OUTPUT },
  }).restoreCheckpoint === true);

console.log("\n4. the escalated brief tells the agent what changed and why");
const escalatedBrief = planEndAction(failed, {
  attempt: 2, previousFingerprints: [round1.fingerprint], strategyId: "targeted_fix",
  diagnostics: { command: "npm run build", output: OUTPUT, patchVerdict: replayOne },
}).brief;
check("it states the last repair did not work", /THE LAST REPAIR DID NOT WORK/.test(escalatedBrief));
check("it quotes the verifier's conclusion", /VERIFIED ABOUT YOUR LAST PATCH/.test(escalatedBrief));
check("it names the new approach", /APPROACH FOR THIS ATTEMPT — inspecting the dependency/.test(escalatedBrief));
check("and it still carries the real error", /is not exported by/.test(escalatedBrief));

console.log(`\n${failures ? `FAILED — ${failures} check(s)` : "PASSED — every check"}`);
process.exit(failures ? 1 : 0);
