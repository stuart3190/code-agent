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
  let cached = 0; // Phase 2.3: input tokens served from the prompt cache (a subset of `input`)
  let cacheWrite = 0;
  const providerRequestIds = []; // BYOK adapter: input tokens WRITTEN to the cache (billed at a write premium)
  let total = 0;
  let usd = 0;

  return {
    // Record one turn's usage; returns the per-turn cost for logging.
    // `usd` uses the cost model's ACTIVE rate table (set by the harness per provider) — so the live
    // £ is REAL on the Anthropic BYOK path and ASSUMED-gpt-5.5 on the FREE Codex path.
    record(usage) {
      const c = costForUsage(usage);
      turns += 1;
      input += usage.input;
      output += usage.output;
      reasoning += usage.reasoning;
      cached += usage.cached ?? 0;
      // Deduplicated: a retried delivery of the same response must not double-record its id.
      if (usage.providerRequestId && !providerRequestIds.includes(usage.providerRequestId)) {
        providerRequestIds.push(usage.providerRequestId);
      }
      cacheWrite += usage.cacheWrite ?? 0;
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
        cached,
        providerRequestIds: [...providerRequestIds],
        cacheWrite,
        cacheHitRate: input ? cached / input : 0, // fraction of input billed at the cached rate
        total,
        usd,
        gbp: usd * 0.79, // ASSUMED USD->GBP, matches cost.mjs (already cache-discounted via costForUsage)
        credits: total / TOKENS_PER_CREDIT,
        gbpPerTurn: turns ? (usd * 0.79) / turns : 0,
      };
    },
  };
}
