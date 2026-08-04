// PR1 acceptance: the repair agent is shown the failure it is repairing.
//
// Recreates the exact production failure from diagnostics baa3e8fc / f00c7950 — a lucide-react
// `Instagram` import that the pinned version does not export — and proves four things:
//
//   1. the failure reproduces for real (a genuine `npm run build`, not a fixture string)
//   2. the repair brief contains the exact line "Instagram is not exported by lucide-react"
//   3. a real repair agent, given that brief, edits the invalid import and nothing else
//   4. the rebuilt project compiles
//
// Steps 1, 2 and 4 are free and deterministic. Step 3 SPENDS REAL TOKENS and is opt-in:
//
//   node ops/prove-repair-brief.mjs              # steps 1, 2, 4 — no model call
//   node ops/prove-repair-brief.mjs --with-agent # all four, spends credits
//
// Run on the VPS, against the deployed tree, like every other proof here.

import { buildTree } from "../harness/workspace.mjs";
import { buildRepairBrief, headlineError, referencesDiagnosticsOnly } from "../shell/server/lib/appBuild/repairContext.mjs";

const WITH_AGENT = process.argv.includes("--with-agent");

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
  return ok;
};

// ── the project, reproducing the production failure exactly ──────────────────────────────────
// `Instagram` is a brand icon removed from the pinned lucide-react. The other three imports are
// UNUSED, and are here on purpose: they are precisely what the first production repair deleted
// while believing it was fixing a lint problem. A correct repair leaves them alone or, at most,
// tidies them — what it must NOT do is treat them as the fault.
const APP_JSX = `import React from "react";
import { Instagram, Clock, Users, Phone } from "lucide-react";

export default function App() {
  return (
    <main>
      <h1>Bright Smile Dental — Book an appointment</h1>
      <a href="https://instagram.com/brightsmile" aria-label="Instagram"><Instagram /></a>
    </main>
  );
}
`;

const PROJECT = {
  "package.json": JSON.stringify({
    name: "booking-site", private: true, version: "0.0.0", type: "module",
    scripts: { build: "vite build" },
    dependencies: { react: "18.3.1", "react-dom": "18.3.1", "lucide-react": "0.263.1" },
  }, null, 2),
  "vite.config.js": `import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\nexport default defineConfig({ plugins: [react()] });\n`,
  "index.html": `<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>\n`,
  "src/main.jsx": `import React from "react";\nimport { createRoot } from "react-dom/client";\nimport App from "./App.jsx";\ncreateRoot(document.getElementById("root")).render(<App />);\n`,
  "src/App.jsx": APP_JSX,
};

console.log("PR1 — the repair brief carries the real diagnostics\n");

// ── 1. reproduce the failure for real ────────────────────────────────────────────────────────
console.log("1. reproducing the production failure");
const first = await buildTree(PROJECT, "prove_repair_brief", () => {});
check("npm run build fails, as it did in production", first.ok === false,
  first.ok ? "the build PASSED — the fixture no longer reproduces the failure" : "");

const output = String(first.stderr || "");
check("the compiler names the missing export", /Instagram/.test(output) && /not exported/.test(output),
  output.split("\n").find((l) => /not exported/.test(l))?.trim().slice(0, 120) || "no such line");

// ── 2. the brief contains it ─────────────────────────────────────────────────────────────────
console.log("\n2. the repair brief");
const brief = buildRepairBrief({
  command: "npm run build",
  output,
  manifest: PROJECT["package.json"],
  tree: PROJECT,
  fingerprint: "ac60a9b42a79f171",
  attempt: 1,
  maxAttempts: 3,
});

// The acceptance criterion, checked against the REAL compiler output rather than a fixture.
check('the brief contains "Instagram" and "is not exported by lucide-react"',
  brief.includes("Instagram") && /is not exported by[^\n]*lucide-react/.test(brief));
check("the brief names the failing command", brief.includes("COMMAND THAT FAILED: npm run build"));
check("the brief names the file and position", /src\/App\.jsx \(\d+:\d+\)/.test(brief));
check("the brief carries the dependency manifest", brief.includes("lucide-react") && brief.includes("0.263.1"));
check("the brief does NOT merely reference a diagnostics id", !referencesDiagnosticsOnly(brief));
check("the headline is the export error, not the compiler banner",
  /is not exported by/.test(headlineError(output)), headlineError(output).slice(0, 100));

// The old brief, for the record — this is what the production repair agent actually received.
const oldBrief = `AUTONOMOUS REPAIR — the previous round failed these checks. Diagnose the root cause and\n`
  + `apply the smallest safe fix for each; change nothing else:\n- the build's quality checks failed`;
check("the previous brief genuinely could not have worked", !oldBrief.includes("Instagram"),
  "it named neither the symbol, the module, nor the file");

console.log(`\n  brief: ${brief.length} characters; the old one: ${oldBrief.length}`);

// ── 3. a real repair agent, given the brief ──────────────────────────────────────────────────
if (WITH_AGENT) {
  console.log("\n3. dispatching a real repair agent (spending credits)");
  const { runRepairForProof } = await import("./lib/repairProbe.mjs");
  const result = await runRepairForProof({ tree: PROJECT, brief });

  const touched = result.changedPaths || [];
  check("the repair edited src/App.jsx", touched.includes("src/App.jsx"), `touched: ${touched.join(", ") || "nothing"}`);
  check("the repair edited ONLY the file the error named", touched.every((p) => p === "src/App.jsx"),
    `touched: ${touched.join(", ")}`);

  const after = result.tree?.["src/App.jsx"] || "";
  check("the invalid import is gone", !/\bInstagram\b/.test(after) || !/from ["']lucide-react["']/.test(
    after.split("\n").find((l) => /\bInstagram\b/.test(l)) || ""));

  // ── 4. and it compiles ─────────────────────────────────────────────────────────────────────
  console.log("\n4. rebuilding");
  const second = await buildTree(result.tree, "prove_repair_brief_fixed", () => {});
  check("the rebuilt project compiles", second.ok === true,
    second.ok ? "" : String(second.stderr || "").split("\n").filter(Boolean).slice(-3).join(" | "));
} else {
  console.log("\n3-4. skipped — pass --with-agent to dispatch a real repair agent and rebuild");
}

console.log(`\n${failures ? `FAILED — ${failures} check(s)` : "PASSED — every check"}`);
process.exit(failures ? 1 : 0);
