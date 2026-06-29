// Phase 2.4 — the model router. A SELECTION LAYER that sits ABOVE the provider seam:
// given turn metadata (intent + which models a config makes available) it returns which
// provider+model to call. It is a PURE function — no I/O, no engine state — so it can be
// unit-tested offline for free (harness/_router-tests.mjs). The engine (runAgent), the seam,
// the tools and the prompts are untouched; a routing PROVIDER (src/providers/routingProvider.mjs)
// wraps the chosen model behind the same runTurn interface so runAgent never learns it exists.
//
//   chooseModel(turnMeta, config) -> { provider, model, rates, reason }
//
// The policy: STRONG model for new generation (quality), and for an EDIT, a COST-AWARE choice
// between strong and cheap — NOT a blind "edit -> cheap". This encodes the recorded Anthropic
// finding (baseline/ANTHROPIC.md): a cheaper model with weaker apply_patch adherence falls back
// to full write_file REWRITES, and a rewrite emits far more output than a patch. So routing an
// edit to a cheap model only pays if the cheap model still applies patches cleanly enough that
// its (lower rate × inflated-by-fallbacks output) still beats the strong model's clean patch.

import { ANTHROPIC_RATES, GPT55_ASSUMED_RATES } from "../cost.mjs";

// ---- per-model capability catalogue ------------------------------------------------------
// `patchAdherence` = the probability the model emits an apply_patch that applies on exact match
// (vs failing and falling back to a full write_file rewrite). These are PRIORS, clearly labelled:
// gpt-5.5 is Codex-tuned for apply_patch (PHASE-2.1 measured 5/5 clean); Claude is less so, and the
// recorded finding saw Sonnet fall back on 2/3 cases. Haiku's value is the one this session MEASURES
// live and feeds back here (the loop: prior -> measure -> calibrate). Rates come from cost.mjs — this
// catalogue adds only the capability the cost model can't express.
export const MODEL_CAPS = {
  "gpt-5.5": { patchAdherence: 0.95, note: "Codex-tuned for apply_patch (PHASE-2.1: 5/5 clean applies)" },
  "claude-opus-4-8": { patchAdherence: 0.85, note: "prior — strongest Claude, not Codex-tuned" },
  "claude-sonnet-4-6": { patchAdherence: 0.70, note: "prior — recorded finding: fell back on 2/3 cases (live n=2 too small to recalibrate)" },
  // MEASURED single-pass on the 2.4 A/B (2026-06-29, PHASE-2.4): 11/15 clean applies = 0.73 — better
  // than the 0.45 guess (and, surprisingly, better than Sonnet's tiny live sample). One run, n=15,
  // nondeterministic: treat as one calibrated sample, not a settled constant.
  "claude-haiku-4-5": { patchAdherence: 0.73, note: "MEASURED 0.73 (PHASE-2.4, 11/15, single-pass) — was a 0.45 prior" },
};
const DEFAULT_ADHERENCE = 0.6; // unknown model: a neutral prior, neither trusted nor distrusted

// Representative edit-turn token profile, used by the cost-aware comparison. These describe the
// SHAPE of an edit (a small patch vs a whole-file fallback rewrite + the context read in), not any
// one case; they're config-overridable so the policy can be tuned per workload. Defaults are drawn
// from the recorded Anthropic/Codex edit runs (PHASE-2.1 sumEditOut≈3063/suite; App.jsx rewrite≈1.5k).
export const DEFAULT_EDIT_PROFILE = {
  inputTokens: 9000, // typical edit-turn input (context block + history); model-independent in COUNT
  editOutTokens: 600, // output to emit one clean patch
  rewriteOutTokens: 3000, // output to emit a full write_file fallback rewrite (~5× a patch)
};

// Resolve a model name to its billing rates (single source of truth = cost.mjs).
export function ratesForModel(model) {
  if (model in ANTHROPIC_RATES) return ANTHROPIC_RATES[model];
  return GPT55_ASSUMED_RATES; // gpt-5.5 / unknown -> the assumed Codex table
}

// `overrides` lets a caller supply a freshly-MEASURED adherence (keyed by model) without editing the
// catalogue — this is how the live run feeds Haiku's real adherence back into `auto` to show what it
// would then decide (prior -> measure -> calibrate), and how the unit tests probe the strong↔cheap
// boundary deterministically.
function adherenceOf(model, overrides) {
  if (overrides && model in overrides) return overrides[model];
  return MODEL_CAPS[model]?.patchAdherence ?? DEFAULT_ADHERENCE;
}

// Expected $ cost of asking `model` to perform ONE edit turn, accounting for the chance it falls
// back from a patch to a full rewrite. Output is the term the fallback dynamic lives in; input is
// included at the model's rate too (a cheaper model is cheaper on input as well — a real, if
// secondary, factor). Pure arithmetic over the model's rates + adherence.
export function expectedEditCost(model, profile = DEFAULT_EDIT_PROFILE, overrides) {
  const rates = ratesForModel(model);
  const adh = adherenceOf(model, overrides);
  const expectedOut = adh * profile.editOutTokens + (1 - adh) * profile.rewriteOutTokens;
  const usd =
    (profile.inputTokens / 1_000_000) * rates.usdPerMInput +
    (expectedOut / 1_000_000) * rates.usdPerMOutput;
  return { usd, expectedOut, adherence: adh };
}

// ---- the policy --------------------------------------------------------------------------
//
// turnMeta = { intent: "generate" | "edit", turnIndex? }
// config   = {
//   provider: "anthropic" | "codex",
//   strong:   model name (required),
//   cheap:    model name | null (multi-model providers only),
//   strategy: "auto" | "cheap-edits" | "strong",   // default "auto"
//   editProfile?: { inputTokens, editOutTokens, rewriteOutTokens },
//   adherence?: { [model]: number },   // measured-adherence override for the cost-aware "auto" path
// }
//
// Returns { provider, model, rates, reason }.
export function chooseModel(turnMeta, config) {
  const { intent } = turnMeta || {};
  const { provider, strong, cheap = null, strategy = "auto", editProfile = DEFAULT_EDIT_PROFILE, adherence } = config || {};

  const decide = (model, reason) => ({ provider, model, rates: ratesForModel(model), reason });

  // Single-model provider (Codex / gpt-5.5): nothing to route — thin pass-through.
  if (!cheap) {
    return decide(strong, `single-model provider (${provider}): only ${strong} available — pass-through`);
  }

  // Forced strategies (used by the live A/B to hold one variable fixed).
  if (strategy === "strong") return decide(strong, `strategy=strong: ${strong} for all turns`);
  if (strategy === "cheap-edits") {
    return intent === "edit"
      ? decide(cheap, `strategy=cheap-edits: edit forced to cheap ${cheap} (measuring its real adherence)`)
      : decide(strong, `strategy=cheap-edits: generation stays on strong ${strong}`);
  }

  // strategy === "auto":
  // New generation -> strong. Quality of a whole-app build matters most, and there is no
  // patch/fallback dynamic to optimise (generation is all write_file). Not a cost decision.
  if (intent !== "edit") {
    return decide(strong, `auto: new generation -> strong ${strong} (quality; no patch-vs-rewrite tradeoff)`);
  }

  // Edit -> cost-aware choice. Compare the EXPECTED cost of each candidate, where the cheap model's
  // expected output is inflated by its lower apply_patch adherence (more fallback rewrites). Route to
  // cheap ONLY if that expected cost actually beats the strong model's. This is the encoded finding:
  // cheap != automatically cheaper once weak-adherence fallbacks are priced in.
  const eCheap = expectedEditCost(cheap, editProfile, adherence);
  const eStrong = expectedEditCost(strong, editProfile, adherence);
  if (eCheap.usd < eStrong.usd) {
    return decide(
      cheap,
      `auto: edit -> cheap ${cheap} (E[$]=${eCheap.usd.toFixed(5)} < strong ${strong} ${eStrong.usd.toFixed(5)}; ` +
        `cheap adherence ${eCheap.adherence}, expected out ${Math.round(eCheap.expectedOut)} tok incl. fallbacks)`
    );
  }
  return decide(
    strong,
    `auto: edit -> strong ${strong} (cheap ${cheap} would cost MORE: E[$]=${eCheap.usd.toFixed(5)} >= ${eStrong.usd.toFixed(5)}; ` +
      `cheap adherence ${eCheap.adherence} too low — fallback rewrites eat the saving)`
  );
}
