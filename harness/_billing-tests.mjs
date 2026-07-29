// Offline billing-model tests — NO model, NO spend, NO network. Asserts the Phase 4 cost model's
// invariants: the formula reproduces REAL recorded spend, model weights bound true cost-per-credit,
// no retail price breaches the floor, and effective £/credit is strictly decreasing across tiers.
// Run: node harness/_billing-tests.mjs   (exit 0 = all pass)

import {
  costPerCreditFromRates,
  modelWeight,
  creditsForTurn,
  creditsForUsage,
  trueCostPerCredit,
  effectiveGbpPerCredit,
  tierEconomics,
  breakeven,
  buildModel,
  bundleRolloverCapCredits,
  byokWorstCaseRuntimeLossPerMonth,
  runtimeCostPerSlotMonth,
  TIERS,
  TOPUP_GBP_PER_CREDIT,
  BYOK_FREE_PREVIEW_SLOTS,
  RECORDED_COST_PER_CREDIT,
} from "../src/billing/costModel.mjs";
import { ANTHROPIC_RATES } from "../src/cost.mjs";

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}
const near = (a, b, eps = 0.0005) => Math.abs(a - b) <= eps;

console.log("formula validates against REAL recorded spend:");
{
  const sonnet = costPerCreditFromRates(ANTHROPIC_RATES["claude-sonnet-4-6"]);
  check(`uncached Sonnet £/credit reproduces recorded £0.0398 (got ${sonnet.toFixed(4)})`,
    near(sonnet, RECORDED_COST_PER_CREDIT.sonnetUncached.gbp));
}

console.log("model weights bound true cost-per-credit:");
{
  check("Sonnet (anchor) weight == 1.00", near(modelWeight("claude-sonnet-4-6"), 1.0));
  check("Haiku weight ≈ 0.333 (cheaper -> burns fewer credits)", near(modelWeight("claude-haiku-4-5"), 0.333, 0.005));
  check("Opus weight ≈ 1.667 (pricier -> burns more credits)", near(modelWeight("claude-opus-4-8"), 1.667, 0.005));
  // The whole point: cost per DEBITED credit is ~constant across models once weighted.
  for (const model of ["claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-8"]) {
    const perDebited = costPerCreditFromRates(ANTHROPIC_RATES[model]) / modelWeight(model);
    check(`per-debited-credit cost for ${model} ≈ Sonnet anchor £0.0398 (got ${perDebited.toFixed(4)})`,
      near(perDebited, RECORDED_COST_PER_CREDIT.sonnetUncached.gbp));
  }
}

console.log("weighting is what keeps Opus from breaching the lowest tier price:");
{
  const opusRaw = costPerCreditFromRates(ANTHROPIC_RATES["claude-opus-4-8"]); // unweighted 10k-token cost
  const studioEff = effectiveGbpPerCredit(TIERS.find((t) => t.id === "studio")); // £0.06
  check(`UNWEIGHTED Opus credit (${opusRaw.toFixed(4)}) WOULD breach Studio price (${studioEff.toFixed(4)})`, opusRaw > studioEff);
  const opusWeighted = opusRaw / modelWeight("claude-opus-4-8");
  check(`WEIGHTED Opus credit (${opusWeighted.toFixed(4)}) stays under Studio price`, opusWeighted < studioEff);
}

console.log("floor is never breached by any managed tier:");
{
  const floor = trueCostPerCredit();
  for (const t of TIERS.filter((t) => t.managed)) {
    const e = tierEconomics(t);
    check(`${t.name}: effective £/credit ${e.effectiveGbpPerCredit.toFixed(4)} > floor ${floor.toFixed(4)}`, e.floorOk);
  }
  check(`top-up ${TOPUP_GBP_PER_CREDIT} is above the floor ${floor.toFixed(4)}`, TOPUP_GBP_PER_CREDIT > floor);
}

console.log("effective £/credit strictly DECREASES as tiers rise (volume discount):");
{
  const managed = TIERS.filter((t) => t.managed);
  let prev = Infinity, ok = true;
  for (const t of managed) {
    const eff = effectiveGbpPerCredit(t);
    if (eff >= prev) ok = false;
    prev = eff;
  }
  check("Starter > Pro > Studio in £/credit", ok);
  check("top-up is priced ABOVE every bundle (margin valve)", managed.every((t) => TOPUP_GBP_PER_CREDIT > effectiveGbpPerCredit(t)));
}

console.log("breakeven sits above the bundle (can't go underwater on bundled credits):");
{
  for (const t of TIERS.filter((t) => t.managed)) {
    const b = breakeven(t);
    check(`${t.name}: breakeven ${Math.round(b.breakevenCredits)} cr > bundle ${b.bundledCredits} cr (headroom ${b.bundleHeadroomMultiple.toFixed(2)}×)`,
      b.bundleHeadroomMultiple > 1);
  }
}

console.log("rollover cap enforces breakeven (grant + carry can't exceed breakeven):");
{
  for (const t of TIERS.filter((t) => t.managed)) {
    const b = breakeven(t);
    const cap = bundleRolloverCapCredits(t);
    check(`${t.name}: rollover cap ${Math.round(cap)} = breakeven ${Math.round(b.breakevenCredits)} − bundle ${t.bundledCredits}`,
      near(cap, Math.max(0, b.breakevenCredits - t.bundledCredits), 0.01));
    check(`${t.name}: bundle + cap (${Math.round(t.bundledCredits + cap)}) ≤ breakeven (${Math.round(b.breakevenCredits)})`,
      t.bundledCredits + cap <= b.breakevenCredits + 1e-6);
    check(`${t.name}: model flags cap as enforcing breakeven`, b.capEnforcesBreakeven);
  }
  // The bug the cap fixes: a fixed 1× allotment rollover would push Studio to 4000 > 3009 breakeven.
  const studio = TIERS.find((t) => t.id === "studio");
  const studioBe = breakeven(studio).breakevenCredits;
  check(`a naive 1× allotment rollover (bundle ${studio.bundledCredits}+${studio.bundledCredits}=4000) WOULD exceed Studio breakeven ${Math.round(studioBe)}`,
    studio.bundledCredits * 2 > studioBe);
}

console.log("BYOK loss-leader is bounded by the slot cap (eyes-open, finite):");
{
  check(`BYOK free preview slots is a small cap (${BYOK_FREE_PREVIEW_SLOTS})`, BYOK_FREE_PREVIEW_SLOTS >= 1 && BYOK_FREE_PREVIEW_SLOTS <= 5);
  const loss = byokWorstCaseRuntimeLossPerMonth();
  check(`BYOK worst-case loss = slots × slot-month (${loss.toFixed(4)})`, near(loss, BYOK_FREE_PREVIEW_SLOTS * runtimeCostPerSlotMonth(), 0.0001));
  check(`BYOK worst-case loss stays under £1/user/mo (got ${loss.toFixed(4)})`, loss < 1.0);
  const byokEcon = tierEconomics(TIERS.find((t) => t.id === "byok-dev"));
  check("BYOK tierEconomics surfaces the worst-case loss", byokEcon.byok && byokEcon.worstCaseRuntimeLossPerMonth > 0);
}

console.log("credit debit math:");
{
  check("10k Sonnet tokens debit exactly 1.000 credit", near(creditsForTurn({ tokens: 10000, model: "claude-sonnet-4-6" }), 1.0));
  check("10k Haiku tokens debit ~0.333 credit", near(creditsForTurn({ tokens: 10000, model: "claude-haiku-4-5" }), 0.333, 0.005));
  check("cached managed input is charged at the cache-read multiplier", near(creditsForUsage({
    usage: { input: 9000, output: 1000, cached: 8000, cacheWrite: 0, total: 10000 },
    model: "gpt-5.5",
  }), 0.28));
  check("usage without a token breakdown retains legacy raw-token pricing", near(creditsForUsage({
    usage: { total: 10000 }, model: "gpt-5.5",
  }), 1.0));
  check("buildModel() snapshot is well-formed", (() => {
    const m = buildModel();
    return m.floorGbpPerCredit > 0 && m.tiers.length === TIERS.length && m.runtime.costPerSlotMonth > 0;
  })());
}

console.log(`\n${fail === 0 ? "ALL GREEN" : "RED"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
