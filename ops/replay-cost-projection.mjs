// Zero-model-credit projection: what the 24.26-credit Codex booking build (run cf130c23, build
// 94ad0b0f) would cost under recommendations R1–R3, computed from that run's own recorded turns.
//
// The per-turn table below is the run's job log, transcribed verbatim (in/out/reasoning/cached
// per model turn, with what each turn actually did). It is DATA about a finished run — nothing
// here invokes a model.
//
// Conservative rules, stated where applied:
//   - a turn is "eliminated" only if it produced NO file mutation and only discovered files the
//     new stage-opening context now supplies (prior-stage outputs);
//   - files pre-opened by R1 are charged IN FULL as fresh input on the stage's first turn;
//   - R2 pruning is credited at the CACHED token rate (the stale bytes mostly rode cached);
//   - R3 is credited only for the measured shared-prefix tokens on the stage-opening turns of
//     the stages AFTER the first post-foundation one, and only as a fresh→cached conversion —
//     never as free. No cross-request provider caching is assumed beyond byte-identical prefixes.
//
//   node ops/replay-cost-projection.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { creditsForUsage } from "../src/billing/costModel.mjs";
import { tokensOf } from "../shell/server/lib/appBuild/projectManifest.mjs";
import { STAGE_RUNTIME_CONTRACT, STAGE_GLOBAL_INVARIANTS } from "../shell/server/lib/appBuild/stagePlan.mjs";
import { contractBrief } from "../shell/shared/implementationContract.mjs";
import { systemPromptForEdit } from "../src/prompts/builder.mjs";

const MODEL = "gpt-5.5";
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "test", "code-agent", "fixtures", "cf130c23");
const contract = JSON.parse(readFileSync(path.join(FIXTURES, "contract.json"), "utf8"));

// ── run cf130c23, verbatim ────────────────────────────────────────────────────────────────────
// kind: work = produced mutations or the final summary; discovery = read/list only, of files the
// pipeline had already identified (prior-stage outputs); expansion-ask = a read_file re-issued
// with `reason` for a file R1 now pre-opens.
const TURNS = [
  { stage: "contract", t: 1, in: 961, out: 1055, reason: 43, cached: 0, kind: "work" },
  { stage: "planner", t: 1, in: 1505, out: 4283, reason: 250, cached: 0, kind: "work" },

  { stage: "foundation", t: 1, in: 13456, out: 6423, reason: 89, cached: 0, kind: "work" },
  { stage: "foundation", t: 2, in: 19876, out: 133, reason: 23, cached: 12800, kind: "work" },

  { stage: "data", t: 1, in: 11395, out: 59, reason: 37, cached: 0, kind: "discovery" },      // read_file App.jsx (summary)
  { stage: "data", t: 2, in: 11552, out: 34, reason: 18, cached: 0, kind: "discovery" },      // list_files
  { stage: "data", t: 3, in: 11738, out: 218, reason: 166, cached: 10752, kind: "expansion-ask" }, // expand App.jsx (+4508)
  { stage: "data", t: 4, in: 16905, out: 2625, reason: 516, cached: 10752, kind: "work" },
  { stage: "data", t: 5, in: 19045, out: 271, reason: 0, cached: 15872, kind: "work" },
  { stage: "data", t: 6, in: 19349, out: 506, reason: 316, cached: 10752, kind: "work" },
  { stage: "data", t: 7, in: 19573, out: 342, reason: 205, cached: 18944, kind: "work" },

  { stage: "primary_journey", t: 1, in: 15142, out: 42, reason: 18, cached: 0, kind: "discovery" }, // read booking.js (summary)
  { stage: "primary_journey", t: 2, in: 15334, out: 75, reason: 21, cached: 14848, kind: "expansion-ask" }, // expand booking.js (+1738)
  { stage: "primary_journey", t: 3, in: 17482, out: 981, reason: 411, cached: 14848, kind: "work" },
  { stage: "primary_journey", t: 4, in: 18073, out: 248, reason: 0, cached: 16896, kind: "work" },
  { stage: "primary_journey", t: 5, in: 18344, out: 4817, reason: 122, cached: 0, kind: "work" },
  { stage: "primary_journey", t: 6, in: 23060, out: 145, reason: 123, cached: 17920, kind: "work" },
  { stage: "primary_journey", t: 7, in: 32719, out: 662, reason: 516, cached: 17920, kind: "work" },

  { stage: "supporting", t: 1, in: 11247, out: 110, reason: 19, cached: 0, kind: "discovery" }, // read App.jsx, booking.js, index.css, newsletterSignup.js
  { stage: "supporting", t: 2, in: 12005, out: 137, reason: 7, cached: 10752, kind: "expansion-ask" }, // expand all three (+10916)
  { stage: "supporting", t: 3, in: 24924, out: 1072, reason: 205, cached: 11776, kind: "work" },
  { stage: "supporting", t: 4, in: 25825, out: 313, reason: 76, cached: 0, kind: "work" },
  { stage: "supporting", t: 5, in: 26083, out: 954, reason: 55, cached: 25088, kind: "work" },
  { stage: "supporting", t: 6, in: 27003, out: 1307, reason: 100, cached: 24064, kind: "work" },
  { stage: "supporting", t: 7, in: 28231, out: 1574, reason: 30, cached: 25088, kind: "work" },
  { stage: "supporting", t: 8, in: 29796, out: 2091, reason: 24, cached: 28160, kind: "work" },
];

// R1: what each stage's opening context must now ADD (charged fresh, in full — conservative),
// measured from the run's own expansion telemetry.
const PREOPEN_FRESH = { data: 4508, primary_journey: 1738, supporting: 10916 };

// R2: stale-read bytes that rode in history after the model patched the same file, measured from
// the run's reads × the turns that followed the superseding patch (tokens ≈ bytes/4):
//   data: App.jsx (4508) stale for turn 7 only (patched at t6)                =  4,508
//   supporting: App.jsx (8537) + booking.js (1738) + newsletterSignup (~220)
//               patched at t3, stale for t4–t8                                = 52,475
const STALE_PRUNED = { data: 4508, supporting: (8537 + 1738 + 220) * 5 };

// R3: the measured byte-stable shared prefix (design brief EXCLUDED — its size for this run is
// not recorded, so it earns nothing here).
const sharedPrefixTokens = tokensOf([
  systemPromptForEdit("apply_patch"), STAGE_RUNTIME_CONTRACT, contractBrief(contract), STAGE_GLOBAL_INVARIANTS,
].join("\n\n"));

const credits = (u) => creditsForUsage({ usage: u, model: MODEL });
const sum = (rows) => rows.reduce((acc, r) => {
  acc.input += r.in; acc.cached += r.cached; acc.output += r.out + r.reason; return acc;
}, { input: 0, cached: 0, output: 0 });

// ── observed ──────────────────────────────────────────────────────────────────────────────────
const observed = sum(TURNS);
const observedCredits = TURNS.reduce((t, r) => t + credits({ input: r.in, cached: r.cached, output: r.out + r.reason }), 0);

// ── projected ─────────────────────────────────────────────────────────────────────────────────
let projectedCredits = 0;
const projected = { input: 0, cached: 0, output: 0 };
const eliminated = [];
let firstSharedSeen = false;

const stagesSeen = new Set();
for (const row of TURNS) {
  if (row.kind === "discovery" || row.kind === "expansion-ask") {
    eliminated.push(row);
    continue; // R1: the stage opens with these files; the turn does not happen.
  }
  let { in: input, cached, out, reason } = row;

  const isStageOpener = !stagesSeen.has(row.stage);
  stagesSeen.add(row.stage);

  if (isStageOpener && PREOPEN_FRESH[row.stage]) {
    input += PREOPEN_FRESH[row.stage]; // R1 cost: pre-opened files, charged fresh in full
  }

  // R3: post-foundation stage openers after the FIRST share a byte-identical prefix. Converted
  // fresh→cached, never free. (data's opener is the first use of the shared prefix — no credit.)
  if (isStageOpener && ["primary_journey", "supporting"].includes(row.stage)) {
    if (firstSharedSeen) {
      const shareable = Math.min(sharedPrefixTokens, input - cached);
      cached += shareable;
    }
  }
  if (isStageOpener && row.stage === "data") firstSharedSeen = true;

  projected.input += input; projected.cached += cached; projected.output += out + reason;
  projectedCredits += credits({ input, cached, output: out + reason });
}

// R2: credited at the CACHED rate only (conservative — the stale bytes mostly rode cached).
const cachedRateCredit = (tokens) => credits({ input: tokens, cached: tokens, output: 0 });
const stalePrunedTokens = Object.values(STALE_PRUNED).reduce((a, b) => a + b, 0);
const r2Credits = cachedRateCredit(stalePrunedTokens);
projectedCredits -= r2Credits;
projected.input -= stalePrunedTokens;
projected.cached -= stalePrunedTokens;

// Wall time: the run took 12.4 min over 26 turns; an eliminated turn saves its share.
const observedWallMin = 12.4;
const perTurnMin = observedWallMin / TURNS.length;
const projectedWallMin = observedWallMin - eliminated.length * perTurnMin;

// ── by recommendation ─────────────────────────────────────────────────────────────────────────
const r1Credits = eliminated.reduce((t, r) => t + credits({ input: r.in, cached: r.cached, output: r.out + r.reason }), 0)
  - Object.entries(PREOPEN_FRESH).reduce((t, [, tok]) => t + credits({ input: tok, cached: 0, output: 0 }), 0);
const r3Credits = observedCredits - projectedCredits - r1Credits - r2Credits > 0
  ? observedCredits - (projectedCredits + r2Credits) - r1Credits
  : 0;

console.log("COST PROJECTION — run cf130c23 replayed under R1–R5 (zero model calls)");
console.log("──────────────────────────────────────────────────────────────────────");
console.log(`observed   ${observed.input.toLocaleString()} in (${observed.cached.toLocaleString()} cached) · ${observed.output.toLocaleString()} out · ${observedCredits.toFixed(2)} credits · ${observedWallMin} min · ${TURNS.length} turns`);
console.log(`projected  ${projected.input.toLocaleString()} in (${projected.cached.toLocaleString()} cached) · ${projected.output.toLocaleString()} out · ${projectedCredits.toFixed(2)} credits · ~${projectedWallMin.toFixed(1)} min · ${TURNS.length - eliminated.length} turns`);
console.log("");
console.log(`R1 discovery turns eliminated   ${eliminated.length} (${eliminated.map((r) => `${r.stage}#${r.t}`).join(", ")})`);
console.log(`   minus pre-opened context     ${Object.entries(PREOPEN_FRESH).map(([s, t]) => `${s}+${t}`).join(" ")} charged fresh`);
console.log(`   net                          ${r1Credits.toFixed(2)} credits`);
console.log(`R2 stale history pruned         ${stalePrunedTokens.toLocaleString()} tok (credited at the cached rate only) = ${r2Credits.toFixed(2)} credits`);
console.log(`R3 shared prefix                ${sharedPrefixTokens.toLocaleString()} tok byte-stable; fresh→cached on 2 stage openers = ${r3Credits.toFixed(2)} credits`);
console.log(`R4/R5                           counted at ZERO here. Their value is the round that`);
console.log(`                                does not happen: this run's verification failure and its`);
console.log(`                                blocked repair (the whole 24.26 ended in "blocked") were`);
console.log(`                                a localStorage defect R5 now catches in-stage for free`);
console.log(`                                and journey expectations R4 now supplies before generation.`);
console.log("");
console.log(`projected saving                ${(observedCredits - projectedCredits).toFixed(2)} credits (${(100 * (observedCredits - projectedCredits) / observedCredits).toFixed(0)}%)`);
console.log(`ceiling headroom at 25          ${(25 - projectedCredits).toFixed(2)} credits (was ${(25 - observedCredits).toFixed(2)})`);
