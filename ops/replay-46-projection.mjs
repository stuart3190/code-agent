// Zero-model-credit replay of the 46.10-credit run (178f7fc8 / build 30782000) under the four
// fixes: per-turn ceiling, scaffold visitorSession, sliced prior context, transition-based
// expectations.
//
// The per-turn table is that run's job log, transcribed verbatim. Conservative rules:
//   - only the three in-stage HONESTY REPAIR calls and the one turn whose sole output was
//     writing visitorSession.js are removed (the scaffold ships the module; the scan cannot
//     flag it; the gate protects it — the loop that consumed them cannot occur);
//   - the supporting/data context reduction uses the MEASURED slice of this run's own App.jsx,
//     charged as fresh on the stage opener and at the cached rate on every later ride;
//   - the ceiling walk uses canonical creditsForUsage after every turn plus the guard's own
//     pre-emptive floor — exactly the shipped stop rule;
//   - R4's transition prompts are counted at ZERO.
//
//   node ops/replay-46-projection.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { creditsForUsage } from "../src/billing/costModel.mjs";
import { tokensOf } from "../shell/server/lib/appBuild/projectManifest.mjs";
import { sliceSource, stageSliceKeywordSets } from "../shell/server/lib/appBuild/contextBuilder.mjs";

const MODEL = "gpt-5.5";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = (p) => path.join(HERE, "..", "test", "code-agent", "fixtures", p);
const contract = JSON.parse(readFileSync(FIX("cf130c23/contract.json"), "utf8")); // same product domain
const appJsx = readFileSync(FIX("run178f7fc8/App.jsx"), "utf8");

// ── run 178f7fc8, verbatim (in/out+reason/cached) ─────────────────────────────────────────────
const T = (stage, i, o, c, kind = "work") => ({ stage, in: i, out: o, cached: c, kind });
const TURNS = [
  T("contract", 961, 1265, 0), T("planner", 1505, 5175, 0),
  T("foundation", 13506, 7608, 0), T("foundation", 20722, 1082, 0),
  T("data", 19343, 464, 0), T("data", 19529, 1528, 18944, "writes_visitor_session"),
  T("data", 20057, 3697, 0), T("data", 22753, 360, 19968),
  T("data", 23147, 413, 22016), T("data", 29072, 578, 23040), T("data", 23462, 736, 23040),
  T("data-repair", 23019, 71, 2560, "honesty_repair"), T("data-repair", 23525, 725, 22016, "honesty_repair"), T("data-repair", 23641, 70, 2560, "honesty_repair"),
  T("primary_journey", 21721, 1439, 0), T("primary_journey", 22224, 100, 2560),
  T("primary_journey", 28062, 10269, 20992), T("primary_journey", 31990, 875, 22016),
  T("primary-repair", 25861, 870, 2560, "honesty_repair"), T("primary-repair", 26371, 48, 25088, "honesty_repair"),
  T("supporting", 28269, 9427, 2560), T("supporting", 37277, 230, 2560),
  T("supporting", 48463, 5141, 36352), T("supporting", 41515, 458, 28160),
  T("supporting", 52786, 2145, 36352), T("supporting", 42773, 275, 40448),
  T("supporting-repair", 28971, 109, 2560, "honesty_repair"), T("supporting-repair", 29526, 711, 2560, "honesty_repair"), T("supporting-repair", 29608, 69, 28160, "honesty_repair"),
];

const credits = (u) => creditsForUsage({ usage: u, model: MODEL });
const observedCredits = TURNS.reduce((t, r) => t + credits({ input: r.in, cached: r.cached, output: r.out }), 0);
const observedTokens = TURNS.reduce((a, r) => ({ in: a.in + r.in, cached: a.cached + r.cached, out: a.out + r.out }), { in: 0, cached: 0, out: 0 });

// ── the measured slice ────────────────────────────────────────────────────────────────────────
const fullAppTokens = tokensOf(appJsx);
const sets = (stage) => stageSliceKeywordSets(stage, contract);
const supportSlice = sliceSource(appJsx, { keywords: sets("supporting").own, foreignKeywords: sets("supporting").foreign, path: "src/App.jsx" });
const dataSlice = sliceSource(appJsx, { keywords: sets("data").own, foreignKeywords: sets("data").foreign, path: "src/App.jsx" });
const supportDelta = Math.max(0, fullAppTokens - tokensOf(supportSlice.text));
const dataDelta = Math.max(0, fullAppTokens - tokensOf(dataSlice.text));

// ── project ───────────────────────────────────────────────────────────────────────────────────
let removedRepairCredits = 0;
let removedSessionCredits = 0;
const kept = [];
for (const row of TURNS) {
  if (row.kind === "honesty_repair") { removedRepairCredits += credits({ input: row.in, cached: row.cached, output: row.out }); continue; }
  if (row.kind === "writes_visitor_session") { removedSessionCredits += credits({ input: row.in, cached: row.cached, output: row.out }); continue; }
  kept.push({ ...row });
}

// Context reduction: the App.jsx delta leaves each stage's turns — fresh on the opener, cached
// on every later ride of that stage.
const openedFor = new Set();
let sliceSavedCredits = 0;
for (const row of kept) {
  const delta = row.stage === "supporting" ? supportDelta : (row.stage === "data" ? dataDelta : 0);
  if (!delta) continue;
  const first = !openedFor.has(row.stage);
  openedFor.add(row.stage);
  const cut = Math.min(delta, first ? row.in - row.cached : row.cached);
  if (first) { row.in -= cut; sliceSavedCredits += credits({ input: cut, cached: 0, output: 0 }); }
  else { row.in -= cut; row.cached -= cut; sliceSavedCredits += credits({ input: cut, cached: cut, output: 0 }); }
}

// The ceiling walk — the shipped rule: stop when spent + cheapest-possible-next-turn > 25.
let spent = 0;
let stoppedAt = null;
for (const [index, row] of kept.entries()) {
  spent += credits({ input: row.in, cached: row.cached, output: row.out });
  const minNext = credits({ input: row.in, cached: row.in, output: 0 });
  if (spent + minNext > 25 && index < kept.length - 1) { stoppedAt = { index, spent }; break; }
}
const projectedCredits = kept.reduce((t, r) => t + credits({ input: r.in, cached: r.cached, output: r.out }), 0);
const projectedTokens = kept.reduce((a, r) => ({ in: a.in + r.in, cached: a.cached + r.cached, out: a.out + r.out }), { in: 0, cached: 0, out: 0 });
const stages = [...new Set(kept.map((r) => r.stage))];

console.log("PROJECTION — run 178f7fc8 (46.10 credits observed) under the four fixes");
console.log("──────────────────────────────────────────────────────────────────────");
console.log(`observed   ${TURNS.length} turns · ${observedTokens.in.toLocaleString()} in (${observedTokens.cached.toLocaleString()} cached) · ${observedTokens.out.toLocaleString()} out · ${observedCredits.toFixed(2)} credits`);
console.log(`projected  ${kept.length} turns · ${projectedTokens.in.toLocaleString()} in (${projectedTokens.cached.toLocaleString()} cached) · ${projectedTokens.out.toLocaleString()} out · ${projectedCredits.toFixed(2)} credits`);
console.log("");
console.log(`scaffold visitorSession   removes 8 honesty-repair turns (${removedRepairCredits.toFixed(2)} cr) + 1 module-write turn (${removedSessionCredits.toFixed(2)} cr)`);
console.log(`sliced prior App.jsx      full ${fullAppTokens} tok → supporting slice ${tokensOf(supportSlice.text)} (kept ${supportSlice.kept.length}, elided ${supportSlice.elided.length}) · data slice ${tokensOf(dataSlice.text)}`);
console.log(`                          saves ${sliceSavedCredits.toFixed(2)} cr at conservative rates`);
console.log(`per-turn ceiling at 25    ${stoppedAt ? `WOULD STOP at turn ${stoppedAt.index + 1} (${stoppedAt.spent.toFixed(2)} cr spent)` : `never triggers — the projected build ends at ${projectedCredits.toFixed(2)}, under 25`}`);
console.log(`transition expectations   0 credits; targets the five journeys that failed on freshness`);
console.log("");
console.log(`stages ${stages.join(" → ")}`);
console.log(`saving ${(observedCredits - projectedCredits).toFixed(2)} credits (${(100 * (observedCredits - projectedCredits) / observedCredits).toFixed(0)}%) · headroom at 25: ${(25 - projectedCredits).toFixed(2)}`);
