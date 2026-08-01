// Cost-if-this-were-metered, now rate-aware so a real BYOK provider can report REAL prices.
//
// The Codex/ChatGPT-sub path is FREE; its £ uses clearly-labelled ASSUMED gpt-5.5 rates (no public
// price exists). The Anthropic BYOK adapter spends real money and reports REAL published Messages
// API rates. Both flow through the same `costForUsage(usage, rates)` — only the rate table differs.
// Credits use the plan's "1 credit = 10k blended tokens".

export const USD_GBP = 0.79; // assumption
export const TOKENS_PER_CREDIT = 10_000; // from the build plan's credit definition

// ---- default rate model: ASSUMED gpt-5.5 (Codex path; no public price) ----
// Kept as standalone exports for back-compat with existing offline tests.
export const ASSUMED_USD_PER_M_INPUT = 1.25; // assumption (GPT-5-class), not a quoted price
export const ASSUMED_USD_PER_M_OUTPUT = 10.0; // assumption (GPT-5-class), not a quoted price
// Cached input is billed at a fraction of the input rate; ASSUMED 10% here for the Codex model.
export const ASSUMED_CACHED_INPUT_MULTIPLIER = 0.1;

export const GPT55_ASSUMED_RATES = {
  label: "gpt-5.5 (ASSUMED rates; FREE on the ChatGPT sub)",
  usdPerMInput: ASSUMED_USD_PER_M_INPUT,
  usdPerMOutput: ASSUMED_USD_PER_M_OUTPUT,
  cachedInputMultiplier: ASSUMED_CACHED_INPUT_MULTIPLIER,
  // The reverse-engineered Codex transport did not separately bill cache *writes*, so writes are
  // priced at the full input rate (1.0×) under this model — i.e. no write premium.
  cacheWriteMultiplier: 1.0,
};

// ---- real, published Anthropic Messages API rates ($/MTok) ----
// Cache read ≈ 0.1× input; cache write = 1.25× input (5-minute TTL). Published rates, not assumed.
export const ANTHROPIC_RATES = {
  "claude-sonnet-4-6": { label: "claude-sonnet-4-6 (REAL Anthropic rates)", usdPerMInput: 3.0, usdPerMOutput: 15.0, cachedInputMultiplier: 0.1, cacheWriteMultiplier: 1.25 },
  "claude-opus-4-8": { label: "claude-opus-4-8 (REAL Anthropic rates)", usdPerMInput: 5.0, usdPerMOutput: 25.0, cachedInputMultiplier: 0.1, cacheWriteMultiplier: 1.25 },
  "claude-haiku-4-5": { label: "claude-haiku-4-5 (REAL Anthropic rates)", usdPerMInput: 1.0, usdPerMOutput: 5.0, cachedInputMultiplier: 0.1, cacheWriteMultiplier: 1.25 },
};

export function anthropicRatesFor(model) {
  return ANTHROPIC_RATES[model] || ANTHROPIC_RATES["claude-sonnet-4-6"];
}

// xAI/Grok published rates (standard tier — long-context pricing is handled by the xAI
// adapter's exact-cost calculator; these blended rates feed the credit WEIGHT system).
export const XAI_RATES = {
  "grok-4.5": { label: "grok-4.5 (xAI published rates)", usdPerMInput: 3.0, usdPerMOutput: 15.0, cachedInputMultiplier: 0.25, cacheWriteMultiplier: 1 },
  "grok-4.5-fast": { label: "grok-4.5-fast (xAI published rates)", usdPerMInput: 0.6, usdPerMOutput: 2.4, cachedInputMultiplier: 0.25, cacheWriteMultiplier: 1 },
  "grok-build-0.1": { label: "grok-build-0.1 (xAI published rates)", usdPerMInput: 1.2, usdPerMOutput: 6.0, cachedInputMultiplier: 0.25, cacheWriteMultiplier: 1 },
};

// Active rate table used by telemetry's live per-turn log + summary (which create their cost inside
// runAgent with no rate argument). The harness sets this ONCE before a run when it selects a
// provider; default is the gpt-5.5 assumed model, so the Codex path is byte-identical to before.
let ACTIVE_RATES = GPT55_ASSUMED_RATES;
export function setActiveRates(rates) { ACTIVE_RATES = rates || GPT55_ASSUMED_RATES; }
export function getActiveRates() { return ACTIVE_RATES; }

// usage = neutral { input, output, reasoning, cached, cacheWrite?, total }.
//   `cached`     = input tokens served from the prompt cache (billed at cachedInputMultiplier×).
//   `cacheWrite` = input tokens WRITTEN to the cache this turn (billed at cacheWriteMultiplier×).
// Both are subsets of `input`; the remainder is full-price input. Back-compatible: when `cacheWrite`
// is absent and rates use multiplier 1.0 (the gpt-5.5 default), this reduces to the pre-BYOK formula.
export function costForUsage(usage, rates = ACTIVE_RATES) {
  const input = usage.input ?? 0;
  const cached = Math.min(usage.cached ?? 0, input);
  const cacheWrite = Math.min(usage.cacheWrite ?? 0, Math.max(0, input - cached));
  const uncachedInput = input - cached - cacheWrite;
  const usd =
    (uncachedInput / 1_000_000) * rates.usdPerMInput +
    (cached / 1_000_000) * rates.usdPerMInput * rates.cachedInputMultiplier +
    (cacheWrite / 1_000_000) * rates.usdPerMInput * rates.cacheWriteMultiplier +
    ((usage.output ?? 0) / 1_000_000) * rates.usdPerMOutput;
  return {
    usd,
    gbp: usd * USD_GBP,
    credits: (usage.total ?? 0) / TOKENS_PER_CREDIT,
  };
}

export function fmtGBP(n) {
  return `£${n.toFixed(4)}`;
}
