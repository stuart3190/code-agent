// Offline router tests — NO model, NO spend. De-risks the Phase 2.4 routing POLICY (the pure
// `chooseModel` + cost-aware `expectedEditCost`) before any live Anthropic run.
// Run: node harness/_router-tests.mjs   (exit 0 = all pass)

import { chooseModel, expectedEditCost, ratesForModel, MODEL_CAPS } from "../src/router/router.mjs";
import { ANTHROPIC_RATES, GPT55_ASSUMED_RATES } from "../src/cost.mjs";

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

const ANTH = { provider: "anthropic", strong: "claude-sonnet-4-6", cheap: "claude-haiku-4-5" };
const CODEX = { provider: "codex", strong: "gpt-5.5", cheap: null };

// ---- generation -> strong (quality, not a cost decision) -----------------------------
console.log("intent=generate -> strong:");
{
  const g = chooseModel({ intent: "generate" }, { ...ANTH, strategy: "auto" });
  check("anthropic generation routes to strong (Sonnet)", g.model === "claude-sonnet-4-6");
  check("decision carries a reason", typeof g.reason === "string" && g.reason.length > 0);
  check("decision carries the chosen model's rates", g.rates === ANTHROPIC_RATES["claude-sonnet-4-6"]);
}

// ---- Codex single-model -> thin pass-through -----------------------------------------
console.log("codex single-model -> pass-through:");
{
  const e = chooseModel({ intent: "edit" }, { ...CODEX, strategy: "auto" });
  const g = chooseModel({ intent: "generate" }, { ...CODEX, strategy: "auto" });
  check("edit on codex -> gpt-5.5 (nothing to route)", e.model === "gpt-5.5");
  check("generate on codex -> gpt-5.5", g.model === "gpt-5.5");
  check("codex rates come from the assumed gpt-5.5 table", e.rates === GPT55_ASSUMED_RATES);
  check("pass-through reason names the single model", e.reason.includes("pass-through"));
}

// ---- edit with default catalogue priors -> cost-aware choice -------------------------
console.log("intent=edit, auto, default priors:");
{
  // With seeded priors (Haiku 0.45 vs Sonnet 0.70) and the default profile, Haiku's 1/3 rate wins
  // even with weaker adherence — auto routes the edit to Haiku. (The live run tests this for real.)
  const e = chooseModel({ intent: "edit" }, { ...ANTH, strategy: "auto" });
  check("edit auto routes to cheap (Haiku) under default priors", e.model === "claude-haiku-4-5");
  check("edit decision reason explains the cost comparison", e.reason.includes("E[$]"));
}

// ---- the encoded finding: weak-enough adherence flips the edit back to STRONG --------
console.log("intent=edit, auto, fallbacks eat the saving -> strong:");
{
  // Isolate the OUTPUT-side fallback dynamic (inputTokens:0) and give the cheap model adherence so
  // low (0.05) that it nearly always falls back to a full rewrite, while the strong model patches
  // clean (0.95). Now the cheap rewrite's inflated output outweighs its lower rate -> route STRONG.
  const profile = { inputTokens: 0, editOutTokens: 600, rewriteOutTokens: 3000 };
  const cfg = { ...ANTH, strategy: "auto", editProfile: profile, adherence: { "claude-haiku-4-5": 0.05, "claude-sonnet-4-6": 0.95 } };
  const e = chooseModel({ intent: "edit" }, cfg);
  check("edit routes to STRONG when cheap adherence is too low", e.model === "claude-sonnet-4-6");
  check("reason states fallbacks eat the saving", e.reason.includes("eat the saving"));

  // Sanity: same numbers but a competent cheap model (0.9) flips it back to cheap.
  const cfg2 = { ...cfg, adherence: { "claude-haiku-4-5": 0.9, "claude-sonnet-4-6": 0.95 } };
  check("competent cheap model (adh 0.9) routes back to cheap", chooseModel({ intent: "edit" }, cfg2).model === "claude-haiku-4-5");
}

// ---- forced strategies (used to hold one variable fixed in the live A/B) -------------
console.log("forced strategies:");
{
  const s = chooseModel({ intent: "edit" }, { ...ANTH, strategy: "strong" });
  check("strategy=strong forces edits to Sonnet", s.model === "claude-sonnet-4-6");

  const ce = chooseModel({ intent: "edit" }, { ...ANTH, strategy: "cheap-edits" });
  const cg = chooseModel({ intent: "generate" }, { ...ANTH, strategy: "cheap-edits" });
  check("strategy=cheap-edits forces edits to Haiku", ce.model === "claude-haiku-4-5");
  check("strategy=cheap-edits keeps generation on strong", cg.model === "claude-sonnet-4-6");
}

// ---- expectedEditCost: monotonic in adherence (the cost model is well-formed) --------
console.log("expectedEditCost cost model:");
{
  const lo = expectedEditCost("claude-haiku-4-5", undefined, { "claude-haiku-4-5": 0.2 });
  const hi = expectedEditCost("claude-haiku-4-5", undefined, { "claude-haiku-4-5": 0.9 });
  check("higher adherence => fewer expected output tokens", hi.expectedOut < lo.expectedOut);
  check("higher adherence => lower expected $", hi.usd < lo.usd);
  check("expectedOut bounded by [editOut, rewriteOut]", hi.expectedOut >= 600 && lo.expectedOut <= 3000);
}

// ---- rates resolver is the single source of truth (cost.mjs) -------------------------
console.log("ratesForModel wiring:");
{
  check("haiku rates from ANTHROPIC_RATES", ratesForModel("claude-haiku-4-5") === ANTHROPIC_RATES["claude-haiku-4-5"]);
  check("gpt-5.5 rates from the assumed table", ratesForModel("gpt-5.5") === GPT55_ASSUMED_RATES);
  // The catalogue's apply_patch adherence is a real probability per model (Haiku's is the PHASE-2.4
  // measured 0.73, which superseded the 0.45 prior — measurement disproved "cheap = weakest patcher").
  check("catalogue adherence values are valid probabilities",
    Object.values(MODEL_CAPS).every((m) => m.patchAdherence > 0 && m.patchAdherence <= 1));
  check("gpt-5.5 is the strongest patcher (Codex-tuned)",
    MODEL_CAPS["gpt-5.5"].patchAdherence >= MODEL_CAPS["claude-haiku-4-5"].patchAdherence);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
