// Zero-model-credit projection: the 46.10-credit booking build, decomposed to the modular shape
// the pipeline now enforces, replayed against the REAL stage-context machinery.
//
// The decomposition is deterministic — the run's own stored App.jsx is split at its top-level
// blocks (the same block extraction the slicer uses): *Page components become route files, large
// components become component files, and the shell keeps only routing/helpers. Then every
// stage's opening context is measured with the actual buildStageContext on the modular tree, and
// the cost model is re-run over the same work-turn structure as the recorded run (repair loops
// removed by the scaffold-session fix, as proven separately).
//
// ASSUMPTIONS, stated: output tokens per stage are the RECORDED ones (decomposition changes what
// is read, not what must be written); within-stage history growth is prior outputs plus a
// 400-token tool-echo allowance per turn; the within-stage cache ratio is the run's own measured
// per-stage ratio, applied to nothing that is not byte-repeatable. No cross-stage cache credit
// is claimed beyond the measured 3,509-token shared prefix, fresh on its first use.
//
//   node ops/replay-modular-projection.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { creditsForUsage } from "../src/billing/costModel.mjs";
import { buildManifest, tokensOf } from "../shell/server/lib/appBuild/projectManifest.mjs";
import { buildStageContext } from "../shell/server/lib/appBuild/contextBuilder.mjs";
import { fileMetrics, modularityCheck } from "../shell/server/lib/appBuild/modularity.mjs";
import { REACT_VITE } from "../src/scaffolds/reactVite.mjs";

const MODEL = "gpt-5.5";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = (p) => path.join(HERE, "..", "test", "code-agent", "fixtures", p);
const contract = JSON.parse(readFileSync(FIX("cf130c23/contract.json"), "utf8"));
const monolith = readFileSync(FIX("run178f7fc8/App.jsx"), "utf8");
const treeJson = JSON.parse(readFileSync(
  path.join(process.env.TREE46 || "C:/Users/ADMINI~1/AppData/Local/Temp/claude/C--Users-Administrator/04e2390f-2e92-42be-ad65-437249ee7a58/scratchpad", "tree-46run.json"), "utf8"));

// ── deterministic decomposition ───────────────────────────────────────────────────────────────
const header = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|const|class)\s+([\w$]+)/gm;
const marks = [];
let m;
while ((m = header.exec(monolith)) !== null) marks.push({ name: m[1], start: m.index });
const blocks = marks.map((mark, i) => ({
  name: mark.name,
  text: monolith.slice(mark.start, marks[i + 1] ? marks[i + 1].start : monolith.length),
}));
const preamble = monolith.slice(0, marks[0].start);

const isPage = (b) => /Page$/.test(b.name);
const isComponent = (b) => /^[A-Z]/.test(b.name) && !isPage(b.name) && b.name !== "App" && tokensOf(b.text) >= 100;

const modular = { ...treeJson };
delete modular["src/data/visitorSession.js"]; // the scaffold ships the maintained one
modular["src/lib/visitorSession.js"] = REACT_VITE["src/lib/visitorSession.js"];
const created = [];
let shellParts = [preamble];
for (const block of blocks) {
  if (isPage(block)) {
    modular[`src/routes/${block.name}.jsx`] = `${preamble}\n${block.text}`;
    created.push(`src/routes/${block.name}.jsx`);
  } else if (isComponent(block)) {
    modular[`src/components/${block.name}.jsx`] = `${preamble}\n${block.text}`;
    created.push(`src/components/${block.name}.jsx`);
  } else {
    shellParts.push(block.text);
  }
}
modular["src/App.jsx"] = shellParts.join("\n");

const oldApp = { tokens: tokensOf(monolith), lines: monolith.split("\n").length };
const newApp = { tokens: tokensOf(modular["src/App.jsx"]), lines: modular["src/App.jsx"].split("\n").length };

// ── the gate agrees, and journey ownership is measurable per file ─────────────────────────────
const gate = modularityCheck(modular, { contract });
const metrics = fileMetrics(modular, { contract }).filter((f) => created.includes(f.path) || f.path === "src/App.jsx");

// ── stage opening contexts, measured with the real machinery ──────────────────────────────────
const OBSERVED_CONTEXT = { data: 23_993, primary_journey: 26_497, supporting: 32_689 }; // run log
const SHARED_PREFIX = 3_509; // run log: byte-stable across post-foundation stages
const manifest = buildManifest(modular, { contract });
const priorsFor = {
  data: ["src/App.jsx", "src/index.css", "src/main.jsx", ...created.filter((p) => p.startsWith("src/routes/")), "src/components/Header.jsx"],
  primary_journey: ["src/App.jsx", "src/data/booking.js", "src/data/newsletterSignup.js"],
  supporting: ["src/App.jsx", "src/data/booking.js", "src/data/newsletterSignup.js",
    ...created.filter((p) => /BookingPage|DateSelector|SlotSelector|HeroBookingPanel|BookingSummary/.test(p))],
};
const contexts = {};
for (const stage of ["data", "primary_journey", "supporting"]) {
  const c = buildStageContext({
    tree: modular, manifest, stageId: stage, contract,
    priorFiles: priorsFor[stage].filter((p) => p in modular), budgetTokens: 40_000,
  });
  contexts[stage] = c;
}

// ── cost projection over the recorded work-turn structure ─────────────────────────────────────
// Work turns from the 46 run, repair loops removed (proven separately). Two output scenarios:
//
//   CONSERVATIVE — the run's own recorded outputs, unchanged.
//   STRUCTURAL   — outputs bounded by the decomposed file sizes where the log PROVES the
//                  monolith forced rewriting unchanged code: primary turn 3 was a single 34KB
//                  write_file of App.jsx (10,269 output tokens) whose journey-owned content is
//                  the 3,347-token BookingPage; supporting's three patch turns rewrote monolith
//                  regions whose supporting-owned content totals ~3.7k tokens. Everything else
//                  keeps its recorded output.
//
// Cache: the run's own per-ordinal cached fractions per stage — no invented rates. The contract
// is counted ONCE (it rides in the byte-stable shared prefix, so it is REMOVED from the
// per-stage context figure where buildStageContext also counted it).
const supportingOwned = created.filter((p) => /ManagePage|VisitPage|FarmPage|NewsletterSection|Footer/.test(p))
  .reduce((t, p) => t + tokensOf(modular[p]), 0);
const bookingPageTokens = tokensOf(modular["src/routes/BookingPage.jsx"] || "");
const SCENARIOS = {
  conservative: {
    primary_journey: [1439, 100, 10269, 875],
    supporting: [9427, 230, 5141, 458, 2145, 275],
  },
  structural: {
    primary_journey: [1439, 100, Math.round(bookingPageTokens * 1.05), 875],
    supporting: (() => {
      // The three mutation turns share the supporting-owned content plus a 30% edit allowance.
      const budgeted = Math.round(supportingOwned * 1.3);
      return [Math.round(budgeted * 0.55), 230, Math.round(budgeted * 0.3), 458, Math.round(budgeted * 0.15), 275];
    })(),
  },
};
const STAGE_TURNS = {
  contract: { turns: 1, outputs: [1265], context: 1_000 },
  planner: { turns: 1, outputs: [5175], context: 1_500 },
  foundation: { turns: 2, outputs: [7608, 1082], context: 18_138 },      // run log (authoring; unchanged by decomposition)
  data: { turns: 6, outputs: [464, 3697, 360, 413, 578, 736], context: null },
  primary_journey: { turns: 4, outputs: null, context: null },
  supporting: { turns: 6, outputs: null, context: null },
};
// Observed cached fraction by turn ordinal, per stage (run log).
const CACHE_SEQ = {
  contract: [0], planner: [0], foundation: [0, 0],
  data: [0, 0, 0.88, 0.95, 0.79, 0.98],
  primary_journey: [0, 0.12, 0.75, 0.69],
  supporting: [0.09, 0.07, 0.75, 0.68, 0.69, 0.95],
};

const credits = (u) => creditsForUsage({ usage: u, model: MODEL });

function project(scenario) {
  let total = 0;
  let totalIn = 0;
  let totalOut = 0;
  const perStage = {};
  for (const [stage, plan] of Object.entries(STAGE_TURNS)) {
    const outputs = plan.outputs || SCENARIOS[scenario][stage];
    const context = plan.context
      ?? (contexts[stage].tokens - contexts[stage].breakdown.contract + SHARED_PREFIX);
    let history = 0;
    let stageCredits = 0;
    for (let t = 0; t < plan.turns; t += 1) {
      const input = context + history;
      const cached = Math.round(input * (CACHE_SEQ[stage][t] ?? 0.7));
      const output = outputs[t] || 300;
      stageCredits += credits({ input, cached, output });
      totalIn += input; totalOut += output;
      history += output + 400; // the turn's output + tool echoes ride in later history
    }
    perStage[stage] = stageCredits;
    total += stageCredits;
  }
  return { total, totalIn, totalOut, perStage };
}
const conservative = project("conservative");
const structural = project("structural");
const { total, totalIn, totalOut, perStage } = structural;

// ── report ────────────────────────────────────────────────────────────────────────────────────
console.log("MODULAR PROJECTION — the 46.10-credit booking build, decomposed");
console.log("──────────────────────────────────────────────────────────────");
console.log(`old App.jsx          ${oldApp.tokens.toLocaleString()} tok / ${oldApp.lines} lines — owned journeys: ${fileMetrics({ "src/App.jsx": monolith }, { contract })[0].journeys.join(", ")}`);
console.log(`new App.jsx (shell)  ${newApp.tokens.toLocaleString()} tok / ${newApp.lines} lines`);
console.log(`files created        ${created.length}`);
for (const f of metrics.filter((x) => x.path !== "src/App.jsx")) {
  console.log(`  ${f.path.padEnd(44)} ${String(f.tokens).padStart(5)} tok · journeys: ${f.journeys.join(", ") || "(shared)"}`);
}
console.log(`modularity gate      ${gate.ok ? "PASSES on the decomposed tree" : `FAILS: ${gate.problems.join(" | ")}`}`);
console.log("");
console.log("stage opening context (observed → modular, incl. shared prefix):");
for (const stage of ["data", "primary_journey", "supporting"]) {
  const now = contexts[stage].tokens + SHARED_PREFIX;
  console.log(`  ${stage.padEnd(16)} ${OBSERVED_CONTEXT[stage].toLocaleString()} → ${now.toLocaleString()} tok  (full ${contexts[stage].full.length} · sliced ${contexts[stage].slices.length} · interfaces ${(contexts[stage].interfaces||[]).length} · summaries ${contexts[stage].summaries.length})`);
}
console.log("");
console.log("projected credits by stage (structural scenario):");
for (const [stage, c] of Object.entries(perStage)) console.log(`  ${stage.padEnd(16)} ${c.toFixed(2)}`);
console.log("");
const turns = Object.values(STAGE_TURNS).reduce((t, s) => t + s.turns, 0);
console.log(`CONSERVATIVE (recorded outputs kept)          ${turns} turns · ${conservative.total.toFixed(2)} credits`);
console.log(`STRUCTURAL (outputs bounded by owned modules) ${turns} turns · ${totalIn.toLocaleString()} in · ${totalOut.toLocaleString()} out · ${total.toFixed(2)} credits`);
console.log(`versus               46.10 observed · 32.12 under the four fixes alone`);
const verdict = (v) => (v <= 22 ? `UNDER 25 with ${(25 - v).toFixed(2)} headroom (target ≥ 3)` : v <= 25 ? `under 25, only ${(25 - v).toFixed(2)} headroom` : "STILL OVER 25");
console.log(`ceiling verdict      conservative: ${verdict(conservative.total)} · structural: ${verdict(total)}`);
