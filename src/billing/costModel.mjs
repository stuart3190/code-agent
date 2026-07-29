// Phase 4 — billing COST MODEL (pure logic + math, no Stripe, no live ledger).
//
// Everything here is derived from REAL measured numbers (baseline/ANTHROPIC.{md,json},
// baseline/PHASE-2.4.md, baseline/RUNTIME.md) plus a small number of clearly-flagged ASSUMPTIONS.
// The module is pure: plug numbers in, get cost-per-credit, tiers, floor checks and breakevens out.
// `scripts/billing-model.mjs` is the runnable front-end; `harness/_billing-tests.mjs` asserts the
// invariants (floor never breached, effective £/credit strictly decreasing, weights bound Opus).
//
// Credit unit: 1 credit = 10_000 BLENDED tokens (TOKENS_PER_CREDIT, locked in src/cost.mjs and the
// build plan). NOT "1 credit = 1 turn" — turns vary wildly in tokens; a fixed token bucket keeps
// cost-per-credit flat regardless of routing or app complexity.

import { ANTHROPIC_RATES, GPT55_ASSUMED_RATES, TOKENS_PER_CREDIT, USD_GBP } from "../cost.mjs";

// ----------------------------------------------------------------------------------------------
// 0. Measured token blend (the shape of a real building turn)
// ----------------------------------------------------------------------------------------------
// From ANTHROPIC.json --ctx: input 37469, output 7671, total 45140 -> output is 17% of blended.
// This blend, fed through the published rates below, REPRODUCES the recorded £0.0398/credit for
// uncached Sonnet exactly (see test) — so the formula is validated against real spend, not guessed.
export const OUTPUT_FRACTION = 0.17; // MEASURED (ANTHROPIC.json --ctx blend)
export const INPUT_FRACTION = 1 - OUTPUT_FRACTION;

// ----------------------------------------------------------------------------------------------
// 1. Inference cost-per-credit, derived from published $/MTok rates
// ----------------------------------------------------------------------------------------------
// Uncached blended £ for 10k tokens at a given rate table. Caching only ever LOWERS this (cache
// reads are 0.1× input), so the uncached figure is the conservative worst case we price the floor
// against. Real blended spend (with caching/routing) sits BELOW it — that gap is margin cushion.
export function costPerCreditFromRates(rates, { usdGbp = USD_GBP } = {}) {
  const usdPerToken =
    INPUT_FRACTION * (rates.usdPerMInput / 1_000_000) +
    OUTPUT_FRACTION * (rates.usdPerMOutput / 1_000_000);
  return usdPerToken * TOKENS_PER_CREDIT * usdGbp;
}

// The authoritative RECORDED cost-per-credit anchors (REAL spend), kept alongside the formula so
// the write-up cites measured numbers, not only derivations. Codex is ASSUMED + FREE on the sub.
export const RECORDED_COST_PER_CREDIT = {
  sonnetUncached: { gbp: 0.0398, basis: "REAL spend — ANTHROPIC.json --ctx" },
  sonnetCached: { gbp: 0.0312, basis: "REAL spend — ANTHROPIC.json --cache (caching cuts ~22%)" },
  routerCheapEdits: { gbp: 0.0106, basis: "REAL spend — PHASE-2.4 routed (£0.1096 / 10.33 credits)" },
  codex: { gbp: 0.0257, basis: "ASSUMED gpt-5.5 rates, FREE on the ChatGPT sub" },
};

// ----------------------------------------------------------------------------------------------
// 2. Model weights — make true cost-per-DEBITED-credit constant across models
// ----------------------------------------------------------------------------------------------
// THE KEY MOVE. "1 credit = 10k raw tokens" breaks the floor on Opus: 10k Opus tokens cost
// ~£0.066, which EXCEEDS a high-tier price of £0.06. Fix: debit credits = (tokens/10k) × weight,
// where weight normalizes a model's blended $/token to Sonnet = 1.0. Then 1 debited credit always
// costs us ~the Sonnet anchor (£0.0398) no matter which model served it.
//   Sonnet 1.000 · Haiku 0.333 · Opus 1.667  (computed from the published rates below)
const blendedUsdPerToken = (rates) =>
  INPUT_FRACTION * rates.usdPerMInput + OUTPUT_FRACTION * rates.usdPerMOutput; // $/MTok, ratio use only

export const WEIGHT_ANCHOR_MODEL = "claude-sonnet-4-6";

export function modelWeight(model) {
  const rates = ANTHROPIC_RATES[model];
  if (!rates) return 1; // unknown model -> neutral weight (anchor)
  const anchor = blendedUsdPerToken(ANTHROPIC_RATES[WEIGHT_ANCHOR_MODEL]);
  return blendedUsdPerToken(rates) / anchor;
}

// Credits a generation turn DEBITS, given raw blended tokens + the model that served them.
export function creditsForTurn({ tokens, model }) {
  return (tokens / TOKENS_PER_CREDIT) * modelWeight(model);
}

// Convert provider telemetry into the token quantity credits should meter. Prompt-cache reads are
// repeated context that the provider serves at a fraction of the normal input cost, so charging
// them as brand-new full-price tokens makes long, multi-file redesigns look several times larger
// than they really are. Output stays one blended token per token, matching the existing credit
// definition; cache writes stay at their provider multiplier.
export function billableTokensForUsage({ usage, model }) {
  const u = usage || {};
  const hasBreakdown = ["input", "output", "cached", "cacheWrite"]
    .some((key) => Number.isFinite(Number(u[key])));
  if (!hasBreakdown) return Math.max(0, Number(u.total || 0));

  const input = Math.max(0, Number(u.input || 0));
  const output = Math.max(0, Number(u.output || 0));
  const cached = Math.min(input, Math.max(0, Number(u.cached || 0)));
  const cacheWrite = Math.min(input - cached, Math.max(0, Number(u.cacheWrite || 0)));
  const rates = ANTHROPIC_RATES[model] || GPT55_ASSUMED_RATES;
  const cacheReadMultiplier = Number(rates.cachedInputMultiplier ?? 1);
  const cacheWriteMultiplier = Number(rates.cacheWriteMultiplier ?? 1);
  return (input - cached - cacheWrite) +
    (cached * cacheReadMultiplier) +
    (cacheWrite * cacheWriteMultiplier) +
    output;
}

export function creditsForUsage({ usage, model }) {
  return (billableTokensForUsage({ usage, model }) / TOKENS_PER_CREDIT) * modelWeight(model);
}

// ----------------------------------------------------------------------------------------------
// 3. Runtime cost (baseline/RUNTIME.md — measured capacity, ASSUMED box price)
// ----------------------------------------------------------------------------------------------
// RUNTIME.md MEASURED: 118.1 MiB idle RSS/container, RAM-bound, 55 concurrent previews on
// 4 vCPU / 7.6 GB, CPU negligible (0.57% peak). Idle strategy: `docker stop` after ~10 min idle
// frees the full RSS — so only ACTIVELY-previewing apps hold a slot. The ONE number RUNTIME.md
// does NOT state is the box's £/month; default below is ASSUMED (realistic for the spec).
export const RUNTIME = {
  vpsGbpPerMonth: 13, // ASSUMED — RUNTIME.md gives no price; ~£13 is realistic for 4 vCPU / 7.6 GB
  concurrentPreviews: 55, // MEASURED (RAM-bound ceiling)
  idleRssMiB: 118.1, // MEASURED
  hoursPerMonth: 730,
  // ASSUMED: live-preview hours consumed per credit of building. Most preview time is idle and
  // reaped, so this is generous. Used only to fold runtime into a per-credit figure.
  previewHoursPerCredit: 0.25,
};

export function runtimeCostPerSlotMonth(rt = RUNTIME) {
  return rt.vpsGbpPerMonth / rt.concurrentPreviews; // an always-on (un-reaped) preview slot
}
export function runtimeCostPerPreviewHour(rt = RUNTIME) {
  return rt.vpsGbpPerMonth / rt.hoursPerMonth / rt.concurrentPreviews;
}
export function runtimeCostPerCredit(rt = RUNTIME) {
  return runtimeCostPerPreviewHour(rt) * rt.previewHoursPerCredit;
}

// ----------------------------------------------------------------------------------------------
// 4. The floor — true cost of one DEBITED credit on the managed path
// ----------------------------------------------------------------------------------------------
// Inference (weighted -> bounded at the Sonnet uncached anchor) + folded runtime. This is the line
// no retail £/credit may fall below. Caching/routing put REAL cost below it -> conservative.
export function trueCostPerCredit({ rt = RUNTIME, inferenceGbpPerCredit } = {}) {
  const inference = inferenceGbpPerCredit ?? RECORDED_COST_PER_CREDIT.sonnetUncached.gbp;
  return inference + runtimeCostPerCredit(rt);
}

// ----------------------------------------------------------------------------------------------
// 5. Tiers + top-up
// ----------------------------------------------------------------------------------------------
// BYOK is the cheap on-ramp: the user's key pays inference (~£0 to us), so its only variable cost
// is runtime, gated by the reaper + a concurrency cap. Managed tiers bundle credits priced cheaper
// per-credit as they rise (volume discount) but never below the floor. Top-up is the margin valve:
// priced ABOVE every bundle, rolls over freely; bundles reset each cycle (capped rollover).
// BYOK Dev is a DELIBERATE £0 loss-leader: a developer acquisition on-ramp that feeds the managed
// tier. Inference is on the user's key (~£0 to us), so the only loss is runtime. We bound it with a
// concurrent-preview-slot cap: a box holds 55 slots, so capping free BYOK at 3 slots lets one box
// back ~18 free developers at full concurrency — enough to BUILD (one app live + a reference), not
// enough to run a FARM of always-on apps. Worst-case loss per BYOK user is surfaced in the model.
export const BYOK_FREE_PREVIEW_SLOTS = 3; // 55 box slots ÷ 3 ≈ 18 free devs/box at full concurrency

export const TIERS = [
  {
    id: "byok-dev",
    name: "BYOK Dev",
    gbpPerMonth: 0,
    bundledCredits: 0, // inference is on the user's key; "credits" here would meter platform only
    managed: false,
    freePreviewSlots: BYOK_FREE_PREVIEW_SLOTS,
    note: "Deliberate £0 loss-leader. Inference on the user's key (~£0); runtime loss bounded by a slot cap.",
  },
  { id: "starter", name: "Starter", gbpPerMonth: 12, bundledCredits: 120, managed: true },
  { id: "pro", name: "Pro", gbpPerMonth: 40, bundledCredits: 500, managed: true },
  { id: "studio", name: "Studio", gbpPerMonth: 120, bundledCredits: 2000, managed: true },
];

export const TOPUP_GBP_PER_CREDIT = 0.12; // on-demand; above every bundle; rolls over freely

// One-time signup gift: enough for a real trial (~7-12 builds at observed 2.3-4.3 cr/build),
// bounded worst-case cost ≈ WELCOME_CREDITS × trueCostPerCredit (~£1.20 at real API rates; ~£0 on
// the Codex lane). Granted idempotently per account (ledger ref welcome:<owner>).
export const WELCOME_CREDITS = 30;

// Worst-case monthly runtime loss for a free BYOK user = every free slot pinned always-on (no
// reaping). This is the eyes-open ceiling on the loss-leader; reaping makes the real figure far lower.
export function byokWorstCaseRuntimeLossPerMonth(slots = BYOK_FREE_PREVIEW_SLOTS, rt = RUNTIME) {
  return slots * runtimeCostPerSlotMonth(rt);
}

// FLOOR-PROTECTION: unused bundle may roll over, but the carried amount PLUS the next cycle's grant
// must never exceed the tier's breakeven credit count — otherwise a user could bank rollover and
// spend past breakeven on bundled credits before top-ups kick in, putting the tier underwater.
// So the per-tier rollover cap is breakeven − bundle (clamped at ≥ 0). This makes the cap ENFORCE
// the breakeven rather than a fixed multiple of the allotment.
export function bundleRolloverCapCredits(tier, opts = {}) {
  if (!tier.managed) return 0;
  const be = breakeven(tier, opts);
  return Math.max(0, be.breakevenCredits - tier.bundledCredits);
}

export function effectiveGbpPerCredit(tier) {
  if (!tier.managed || tier.bundledCredits === 0) return null; // BYOK has no managed £/credit
  return tier.gbpPerMonth / tier.bundledCredits;
}

// Per-tier economics at FULL bundle burn (all credits at the floor cost).
export function tierEconomics(tier, opts = {}) {
  const floor = trueCostPerCredit(opts);
  const eff = effectiveGbpPerCredit(tier);
  if (eff == null)
    return {
      tier,
      byok: true,
      floor,
      freePreviewSlots: tier.freePreviewSlots ?? 0,
      worstCaseRuntimeLossPerMonth: byokWorstCaseRuntimeLossPerMonth(tier.freePreviewSlots ?? 0, opts.rt),
    };
  const bundleCost = tier.bundledCredits * floor;
  const profitAtFullBurn = tier.gbpPerMonth - bundleCost;
  return {
    tier,
    byok: false,
    floor,
    effectiveGbpPerCredit: eff,
    markupOverFloor: eff / floor,
    grossMarginPct: (eff - floor) / eff,
    bundleCostAtFloor: bundleCost,
    profitAtFullBurn,
    floorOk: eff > floor, // INVARIANT: retail price strictly above true cost
  };
}

// Breakeven: how many credits a flat-fee tier must serve before revenue = cost. Because bundles are
// HARD caps and top-ups (above floor) are the only way past them, a tier can't go underwater on the
// bundle — the breakeven count sits ABOVE the bundle by exactly the markup multiple.
export function breakeven(tier, opts = {}) {
  const floor = trueCostPerCredit(opts);
  const eff = effectiveGbpPerCredit(tier);
  if (eff == null) return null;
  const breakevenCredits = tier.gbpPerMonth / floor; // revenue == cost here
  const rolloverCapCredits = Math.max(0, breakevenCredits - tier.bundledCredits); // enforce breakeven
  return {
    tier,
    floor,
    breakevenCredits,
    bundledCredits: tier.bundledCredits,
    bundleHeadroomMultiple: breakevenCredits / tier.bundledCredits, // > 1 => safe on bundle alone
    rolloverCapCredits, // max unused bundle that may carry; bundle + cap == breakeven by construction
    maxBundleBalance: tier.bundledCredits + rolloverCapCredits, // grant + carry; must == breakeven
    capEnforcesBreakeven: tier.bundledCredits + rolloverCapCredits <= breakevenCredits + 1e-6,
    topupGbpPerCredit: TOPUP_GBP_PER_CREDIT,
    topupMarginPct: (TOPUP_GBP_PER_CREDIT - floor) / TOPUP_GBP_PER_CREDIT, // valve margin past bundle
  };
}

// Per-user HARD CEILING (the runaway-account guardrail from the build plan, §8). DERIVED, not
// invented: a user's monthly debited credits may not exceed their own tier's BREAKEVEN. Below the
// breakeven the tier is profitable by construction (§7), so a normal user never trips this; only a
// runaway loop (or a compromised account burning a bought balance) does. Top-ups raise the spend
// VALVE, not the ceiling — heavy users past breakeven buy top-ups, which is where margin is made, so
// the ceiling guards cost runaway, not legitimate paid usage. BYOK has no managed ceiling (inference
// is on the user's key); callers gate BYOK with the preview-slot cap instead.
export function userHardCeilCredits(tier, opts = {}) {
  if (!tier || !tier.managed) return Infinity; // BYOK / unmetered: no managed-credit ceiling
  return breakeven(tier, opts).breakevenCredits;
}

// Whole-model snapshot — what the runnable script and the write-up consume.
export function buildModel(opts = {}) {
  const rt = opts.rt ?? RUNTIME;
  const floor = trueCostPerCredit({ rt });
  return {
    creditUnitTokens: TOKENS_PER_CREDIT,
    blend: { outputFraction: OUTPUT_FRACTION },
    costPerCredit: {
      byok: 0, // inference on the user's key
      managedSonnetUncached: costPerCreditFromRates(ANTHROPIC_RATES[WEIGHT_ANCHOR_MODEL]),
      managedSonnetCachedRecorded: RECORDED_COST_PER_CREDIT.sonnetCached.gbp,
      routerCheapEditsRecorded: RECORDED_COST_PER_CREDIT.routerCheapEdits.gbp,
      codexAssumed: RECORDED_COST_PER_CREDIT.codex.gbp,
    },
    weights: {
      "claude-sonnet-4-6": modelWeight("claude-sonnet-4-6"),
      "claude-haiku-4-5": modelWeight("claude-haiku-4-5"),
      "claude-opus-4-8": modelWeight("claude-opus-4-8"),
    },
    runtime: {
      ...rt,
      costPerSlotMonth: runtimeCostPerSlotMonth(rt),
      costPerPreviewHour: runtimeCostPerPreviewHour(rt),
      costPerCredit: runtimeCostPerCredit(rt),
    },
    floorGbpPerCredit: floor,
    byok: {
      freePreviewSlots: BYOK_FREE_PREVIEW_SLOTS,
      worstCaseRuntimeLossPerMonth: byokWorstCaseRuntimeLossPerMonth(BYOK_FREE_PREVIEW_SLOTS, rt),
      slotsPerBox: rt.concurrentPreviews,
      freeDevsPerBox: rt.concurrentPreviews / BYOK_FREE_PREVIEW_SLOTS,
    },
    topup: { gbpPerCredit: TOPUP_GBP_PER_CREDIT },
    tiers: TIERS.map((t) => ({ tier: t, economics: tierEconomics(t, { rt }), breakeven: breakeven(t, { rt }) })),
  };
}
