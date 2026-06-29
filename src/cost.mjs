// Cost-if-this-were-metered. All FREE on the ChatGPT sub — these numbers are hypothetical,
// using clearly-labelled ASSUMED rates (no public price exists for gpt-5.5). Swap when a
// real metered rate is locked. Credits use the plan's "1 credit = 10k blended tokens".

export const ASSUMED_USD_PER_M_INPUT = 1.25; // assumption (GPT-5-class), not a quoted price
export const ASSUMED_USD_PER_M_OUTPUT = 10.0; // assumption (GPT-5-class), not a quoted price
export const USD_GBP = 0.79; // assumption
export const TOKENS_PER_CREDIT = 10_000; // from the build plan's credit definition

// usage = neutral { input, output, reasoning, cached, total }
export function costForUsage(usage) {
  const usd =
    (usage.input / 1_000_000) * ASSUMED_USD_PER_M_INPUT +
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
