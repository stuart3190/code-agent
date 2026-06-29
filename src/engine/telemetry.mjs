// Per-turn token/cost telemetry. Wraps cost.mjs so the engine accumulates usage
// across a run and can report a summary. Kept ON throughout, per the build plan:
// every optimisation's effect must be visible in real numbers.
//
// Costs are "if-this-were-metered" using clearly-labelled ASSUMED gpt-5.5 rates
// (no public price exists). All actually FREE on the ChatGPT sub.

import { costForUsage, TOKENS_PER_CREDIT } from "../cost.mjs";

export function createTelemetry() {
  let turns = 0;
  let input = 0;
  let output = 0;
  let reasoning = 0;
  let total = 0;
  let usd = 0;

  return {
    // Record one turn's usage; returns the per-turn cost for logging.
    record(usage) {
      const c = costForUsage(usage);
      turns += 1;
      input += usage.input;
      output += usage.output;
      reasoning += usage.reasoning;
      total += usage.total;
      usd += c.usd;
      return c;
    },

    summary() {
      return {
        turns,
        input,
        output,
        reasoning,
        total,
        usd,
        gbp: usd * 0.79, // ASSUMED USD->GBP, matches cost.mjs
        credits: total / TOKENS_PER_CREDIT,
        gbpPerTurn: turns ? (usd * 0.79) / turns : 0,
      };
    },
  };
}
