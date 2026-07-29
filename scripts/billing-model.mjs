// Runnable Phase 4 billing model — plug the measured numbers in, get cost-per-credit, tiers, the
// floor check and breakevens out. Pure math, no Stripe, no live ledger, no network.
//
//   node scripts/billing-model.mjs
//
// All figures trace to baseline/ANTHROPIC.{md,json}, baseline/PHASE-2.4.md, baseline/RUNTIME.md.
// The only ASSUMED inputs are flagged inline (the £/month box price and preview-hours-per-credit).

import {
  buildModel,
  modelWeight,
  creditsForTurn,
  costPerCreditFromRates,
  RECORDED_COST_PER_CREDIT,
  WEIGHT_ANCHOR_MODEL,
} from "../src/billing/costModel.mjs";
import { ANTHROPIC_RATES } from "../src/cost.mjs";

const gbp = (n) => `£${n.toFixed(4)}`;
const pct = (n) => `${(n * 100).toFixed(1)}%`;
const x = (n) => `${n.toFixed(2)}×`;
const hr = (s) => console.log(`\n${"─".repeat(78)}\n${s}\n${"─".repeat(78)}`);

const m = buildModel();

hr("1 · CREDIT UNIT");
console.log(`  1 credit = ${m.creditUnitTokens.toLocaleString()} blended tokens  (output fraction ${pct(m.blend.outputFraction)})`);
console.log("  Fixed token bucket, NOT 1 turn = 1 credit — keeps cost-per-credit flat across routing.");

hr("2 · COST-PER-CREDIT BY PATH");
console.log(`  BYOK (user's key)              ${gbp(m.costPerCredit.byok)}   ~£0 inference to us`);
console.log(`  Managed Sonnet, UNCACHED       ${gbp(m.costPerCredit.managedSonnetUncached)}   formula (validates to REAL £0.0398)`);
console.log(`  Managed Sonnet, cached         ${gbp(m.costPerCredit.managedSonnetCachedRecorded)}   ${RECORDED_COST_PER_CREDIT.sonnetCached.basis}`);
console.log(`  Router cheap-edits (Haiku)     ${gbp(m.costPerCredit.routerCheapEditsRecorded)}   ${RECORDED_COST_PER_CREDIT.routerCheapEdits.basis}`);
console.log(`  Codex gpt-5.5                  ${gbp(m.costPerCredit.codexAssumed)}   ${RECORDED_COST_PER_CREDIT.codex.basis}`);

hr("3 · MODEL WEIGHTS — bound true cost-per-credit across models");
for (const model of Object.keys(m.weights)) {
  const raw = costPerCreditFromRates(ANTHROPIC_RATES[model]);
  console.log(`  ${model.padEnd(20)} weight ${x(m.weights[model])}   raw 10k-token cost ${gbp(raw)} -> per DEBITED credit ${gbp(raw / m.weights[model])}`);
}
console.log(`  Anchor = ${WEIGHT_ANCHOR_MODEL} (weight 1.00). Every debited credit costs ~${gbp(m.costPerCredit.managedSonnetUncached)} regardless of model.`);
console.log(`  WITHOUT weighting, 10k Opus tokens = 1 raw credit costing ${gbp(costPerCreditFromRates(ANTHROPIC_RATES["claude-opus-4-8"]))} — would BREACH the £0.06 tier. Weighting fixes it.`);

hr("4 · RUNTIME COST (RUNTIME.md: 118 MiB/container, 55 concurrent, RAM-bound)");
console.log(`  Box ${gbp(m.runtime.vpsGbpPerMonth)}/mo [ASSUMED] ÷ ${m.runtime.concurrentPreviews} slots = ${gbp(m.runtime.costPerSlotMonth)}/always-on-slot-month`);
console.log(`  Per preview-hour (reaped): ${gbp(m.runtime.costPerPreviewHour)}   ·   folded per credit (@${m.runtime.previewHoursPerCredit}h/credit [ASSUMED]): ${gbp(m.runtime.costPerCredit)}`);
console.log("  Runtime is rounding-error per credit; it matters as a per-active-app fixed cost the `docker stop` reaper gates.");

hr("5 · THE FLOOR — true cost of one debited credit (managed)");
console.log(`  inference ${gbp(m.costPerCredit.managedSonnetUncached)} + runtime ${gbp(m.runtime.costPerCredit)} = FLOOR ${gbp(m.floorGbpPerCredit)}`);
console.log("  No retail £/credit may fall below this. Caching/routing put REAL cost below it -> margin cushion.");

hr("6 · TIERS — effective £/credit must DROP as tiers rise, never below floor");
console.log("  tier        £/mo   bundle   eff £/cr   markup   gross margin   profit@fullburn   floor ok");
let prevEff = Infinity;
let monotonic = true;
for (const { tier, economics: e } of m.tiers) {
  if (e.byok) {
    console.log(`  ${tier.name.padEnd(10)} ${("£" + tier.gbpPerMonth).padStart(5)}   ${"—".padStart(6)}   ${"—".padStart(8)}   ${"—".padStart(6)}   ${"—".padStart(12)}   ${"—".padStart(15)}   loss-leader, ${e.freePreviewSlots} preview slots`);
    continue;
  }
  if (e.effectiveGbpPerCredit >= prevEff) monotonic = false;
  prevEff = e.effectiveGbpPerCredit;
  console.log(
    `  ${tier.name.padEnd(10)} ${("£" + tier.gbpPerMonth).padStart(5)}   ${String(tier.bundledCredits).padStart(6)}   ${gbp(e.effectiveGbpPerCredit).padStart(8)}   ${x(e.markupOverFloor).padStart(6)}   ${pct(e.grossMarginPct).padStart(12)}   ${("£" + e.profitAtFullBurn.toFixed(2)).padStart(15)}   ${e.floorOk ? "✅" : "❌ BREACH"}`,
  );
}
console.log(`  Top-up: ${gbp(m.topup.gbpPerCredit)}/credit (above every bundle; rolls over freely). Bundles reset; rollover capped per-tier (see §7).`);
console.log(`  Effective £/credit strictly decreasing across managed tiers: ${monotonic ? "✅ yes" : "❌ NO"}`);
console.log(`  BYOK loss-leader: ${m.byok.freePreviewSlots} free preview slots -> worst-case runtime loss ${gbp(m.byok.worstCaseRuntimeLossPerMonth)}/user/mo (all slots pinned, no reaping); ~${m.byok.freeDevsPerBox.toFixed(0)} free devs/box.`);

hr("7 · BREAKEVEN + ROLLOVER CAP — floor-protection on bundled credits");
console.log("  tier        breakeven   bundle   rollover cap   max balance   ≤ breakeven?   headroom");
let capsOk = true;
for (const { breakeven: b } of m.tiers) {
  if (!b) continue;
  if (!b.capEnforcesBreakeven) capsOk = false;
  console.log(
    `  ${b.tier.name.padEnd(10)} ${String(Math.round(b.breakevenCredits)).padStart(9)}   ${String(b.bundledCredits).padStart(6)}   ${String(Math.round(b.rolloverCapCredits)).padStart(12)}   ${String(Math.round(b.maxBundleBalance)).padStart(11)}   ${(b.capEnforcesBreakeven ? "✅" : "❌").padStart(12)}   ${x(b.bundleHeadroomMultiple)}`,
  );
}
console.log(`  Rollover cap = breakeven − bundle, so grant + carry can NEVER exceed breakeven: ${capsOk ? "✅ enforced on every tier" : "❌ BREACH"}`);
console.log(`  Past the bundle the user buys top-ups (${pct(m.tiers.find((t) => t.breakeven).breakeven.topupMarginPct)} margin @ ${gbp(m.topup.gbpPerCredit)}/cr) — heavier usage ADDS margin instead of eroding it.`);

hr("8 · WORKED DEBIT EXAMPLES (model-weighted)");
for (const [model, tokens] of [["claude-sonnet-4-6", 10000], ["claude-haiku-4-5", 10000], ["claude-opus-4-8", 10000]]) {
  console.log(`  ${tokens.toLocaleString()} ${model} tokens -> debits ${creditsForTurn({ tokens, model }).toFixed(3)} credits (weight ${x(modelWeight(model))})`);
}

console.log("\nDone. Pure model — no Stripe, no ledger writes. Adjust knobs in src/billing/costModel.mjs (RUNTIME, TIERS, TOPUP).\n");
