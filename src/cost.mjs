// Cost-if-this-were-metered. All FREE on the ChatGPT sub — these numbers are hypothetical,
// using clearly-labelled ASSUMED rates (no public price exists for gpt-5.5). Swap when a
// real metered rate is locked. Credits use the plan's "1 credit = 10k blended tokens".

export const ASSUMED_USD_PER_M_INPUT = 1.25; // assumption (GPT-5-class), not a quoted price
export const ASSUMED_USD_PER_M_OUTPUT = 10.0; // assumption (GPT-5-class), not a quoted price
// Cached input is billed at a fraction of the input rate. GPT-5-class prompt caching is
// ~10% of the input price (some docs quote a generic 50%); ASSUMED here, swap with the real
// rate when locked. Phase 2.3: cache hits are reported in usage.cached (a SUBSET of input).
export const ASSUMED_CACHED_INPUT_MULTIPLIER = 0.1; // assumption — cached input at 10% of input rate
export const USD_GBP = 0.79; // assumption
export const TOKENS_PER_CREDIT = 10_000; // from the build plan's credit definition

// usage = neutral { input, output, reasoning, cached, total }. `cached` is a subset of `input`
// that hit the prompt cache and is billed at the discounted rate; the rest of input is full price.
// Back-compatible: cached==0 (or absent) reduces to the pre-2.3 full-input formula exactly.
export function costForUsage(usage) {
  const cached = Math.min(usage.cached ?? 0, usage.input ?? 0);
  const uncachedInput = (usage.input ?? 0) - cached;
  const usd =
    (uncachedInput / 1_000_000) * ASSUMED_USD_PER_M_INPUT +
    (cached / 1_000_000) * ASSUMED_USD_PER_M_INPUT * ASSUMED_CACHED_INPUT_MULTIPLIER +
    (usage.output / 1_000_000) * ASSUMED_USD_PER_M_OUTPUT;
  return {
    usd,
    gbp: usd * USD_GBP,
    credits: usage.total / TOKENS_PER_CREDIT,
  };
}

export function fmtGBP(n) {
  return `£${n.toFixed(4)}`;
}
