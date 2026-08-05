// Thrallo budget accounting exposed through the legacy ledger interface, so the entire
// battle-tested affordability logic in buildJobs.runJob (pre-spend gate, per-job affordable
// credit limit, mid-run usage guard, post-metered settle) keeps working unchanged while the
// credit ledger itself is retired.
//
// Mapping: 1 legacy "credit" = TOKENS_PER_CREDIT managed tokens. getBalance() reports the
// owner's REMAINING monthly managed-token budget as credits; debit() records the actual token
// usage as a standalone Thrallo usage row (billing_source managed, kind app_build) and always
// succeeds — the budget maths that decide whether a job may start/continue run off getBalance,
// exactly like the prepaid balance did.

import { codeAgentStore } from "../codeAgentStore.mjs";
import { budgetOverview } from "../usageBudgets.mjs";
import { TOKENS_PER_CREDIT } from "../../../../src/cost.mjs";
// The ONE pricing function. The 2026-08-05 incident happened because this module priced debits
// with its own flat rule while every reporting surface used costModel — right in the report,
// wrong on the debit.
import { creditsForUsage } from "../../../../src/billing/costModel.mjs";

const r4 = (n) => Math.round(n * 10_000) / 10_000;

export function createBudgetLedger({
  store = codeAgentStore(),
  overviewResolver = budgetOverview,
} = {}) {
  async function getBalance(owner) {
    const overview = await overviewResolver(owner, { store });
    // Owner accounts are never blocked from building; spend still records via debit().
    const credits = overview.unlimited
      ? 1_000_000
      : r4(Math.max(0, overview.budgets.managedTokens.remaining) / TOKENS_PER_CREDIT);
    return { bundle: credits, topup: 0, total: credits };
  }

  async function debit({ owner, usage, model, ref, allowPartial = false }) {
    const tokens = {
      input: Number(usage?.input || 0),
      cached: Number(usage?.cached || 0),
      output: Number(usage?.output || 0),
      reasoning: Number(usage?.reasoning || 0),
      total: Number(usage?.total || 0),
    };
    await store.recordStandaloneUsage(owner, {
      provider: "app-build",
      model: String(model || "unknown").slice(0, 200),
      input_tokens: tokens.input,
      cached_tokens: tokens.cached,
      output_tokens: tokens.output,
      reasoning_tokens: tokens.reasoning,
      compute_seconds: 0,
      amount_gbp: 0,
      billing_source: "managed",
      metadata: { kind: "app_build", ref: String(ref || "").slice(0, 200), total_tokens: tokens.total },
    });
    // THE 2026-08-05 BILLING DEFECT LIVED ON THIS LINE. It read:
    //
    //   const need = r4(tokens.total / TOKENS_PER_CREDIT);
    //
    // — a flat tokens-per-credit rule that priced every cached input token as a fresh one and
    // ignored model weighting entirely. Run 83883309: 356,455 of 518,992 tokens were cached, the
    // real cost was 19.25 credits, and this line debited 51.33. Diagnostics, ai_requests and the
    // profiler all used the cache-aware costModel and agreed with each other; the one formula that
    // took the money was the one that disagreed.
    //
    // There is now exactly one pricing function. If the price is wrong, it is wrong everywhere at
    // once, visibly — never right in the report and wrong on the debit.
    const need = r4(creditsForUsage({ usage: tokens, model }));
    const balance = await getBalance(owner);
    void allowPartial;
    return { ok: true, debited: need, need, partial: false, balance };
  }

  return { getBalance, debit };
}

// Welcome grants were a credit-ledger concept; Thrallo's free plan IS the grant.
export async function ensureBudgetGrant() {
  return { ok: true };
}
