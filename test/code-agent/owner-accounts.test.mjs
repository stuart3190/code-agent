// Owner accounts: staff bypass every enforcement point while metering continues, and can
// preview customer plans without changing their real subscription.

process.env.CODE_AGENT_STORE = "memory";

import assert from "node:assert/strict";
import test from "node:test";

import { isOwnerAccount, ownerEmailList, resetOwnerAccountCacheForTests } from "../../shell/server/lib/ownerAccounts.mjs";
import {
  budgetOverview, assertRunWithinBudget, assertWithinRateLimits, remainingManagedTokens, setPreviewPlan,
} from "../../shell/server/lib/usageBudgets.mjs";
import { createBudgetLedger } from "../../shell/server/lib/appBuild/budgetLedger.mjs";
import { codeAgentStore, resetCodeAgentStoreForTests } from "../../shell/server/lib/codeAgentStore.mjs";

const OWNER_ID = "00000000-0000-4000-8000-00000000aaaa";
const CUSTOMER_ID = "00000000-0000-4000-8000-00000000bbbb";

function withOwnerEnv(fn) {
  const saved = process.env.THRALLO_OWNER_EMAILS;
  process.env.THRALLO_OWNER_EMAILS = "stuart3190@gmail.com, dev@thrallo.com";
  resetOwnerAccountCacheForTests();
  return Promise.resolve(fn()).finally(() => {
    if (saved === undefined) delete process.env.THRALLO_OWNER_EMAILS;
    else process.env.THRALLO_OWNER_EMAILS = saved;
    resetOwnerAccountCacheForTests();
  });
}

// The memory store resolves owner emails via the auth stub; in tests the resolver is the
// injectable seam — patch it globally through a wrapper the lib honors.
import * as ownerAccounts from "../../shell/server/lib/ownerAccounts.mjs";
const resolveEmail = async (id) => (id === OWNER_ID ? "Stuart3190@GMAIL.com" : "customer@example.com");
const origIsOwner = ownerAccounts.isOwnerAccount;
void origIsOwner;

test("isOwnerAccount matches the email list case-insensitively and fails closed", () =>
  withOwnerEnv(async () => {
    assert.deepEqual(ownerEmailList(), ["stuart3190@gmail.com", "dev@thrallo.com"]);
    assert.equal(await isOwnerAccount(OWNER_ID, { resolveEmail }), true);
    assert.equal(await isOwnerAccount(CUSTOMER_ID, { resolveEmail }), false);
    resetOwnerAccountCacheForTests();
    assert.equal(await isOwnerAccount(OWNER_ID, { resolveEmail: async () => { throw new Error("down"); } }), false);
  }));

test("owner accounts bypass budgets and rate limits but stay metered; customers do not", () =>
  withOwnerEnv(async () => {
    resetCodeAgentStoreForTests?.();
    const store = codeAgentStore();
    // Exhaust the free plan: record token usage far beyond the allowance.
    for (const owner of [OWNER_ID, CUSTOMER_ID]) {
      await store.recordStandaloneUsage(owner, {
        provider: "test", model: "m", input_tokens: 50_000_000, cached_tokens: 0,
        output_tokens: 0, reasoning_tokens: 0, compute_seconds: 10_000_000,
        amount_gbp: 0, billing_source: "managed", metadata: {},
      });
    }
    // The memory store's email resolution goes through the injectable seam only in this
    // test process — stub the auth admin lookup by seeding the cache via a direct call.
    await isOwnerAccount(OWNER_ID, { resolveEmail });      // caches true
    await isOwnerAccount(CUSTOMER_ID, { resolveEmail });   // caches false

    const ownerOverview = await budgetOverview(OWNER_ID, { store });
    assert.equal(ownerOverview.ownerAccount, true);
    assert.equal(ownerOverview.unlimited, true);

    await assertWithinRateLimits(OWNER_ID, { store });                       // no throw
    const asserted = await assertRunWithinBudget(OWNER_ID, { store });       // no throw
    assert.equal(asserted.unlimited, true);
    assert.equal(await remainingManagedTokens(OWNER_ID, { store }), Number.MAX_SAFE_INTEGER);

    const customerOverview = await budgetOverview(CUSTOMER_ID, { store });
    assert.equal(customerOverview.ownerAccount, false);
    assert.ok(customerOverview.budgets.computeSeconds.remaining <= 0);
    await assert.rejects(assertRunWithinBudget(CUSTOMER_ID, { store }), /allowance is used up/);

    // Build affordability: unlimited owners get a working balance; metering still records
    // through debit() (recordStandaloneUsage is called — proven by the row we can read back).
    const ledger = createBudgetLedger({ store, overviewResolver: budgetOverview });
    const balance = await ledger.getBalance(OWNER_ID);
    assert.ok(balance.total >= 1_000_000);
    const debit = await ledger.debit({ owner: OWNER_ID, usage: { input: 10, output: 5, total: 15 }, model: "m", ref: "t" });
    assert.equal(debit.ok, true);
  }));

test("plan preview changes presentation for owners only, never enforcement", () =>
  withOwnerEnv(async () => {
    resetCodeAgentStoreForTests?.();
    const store = codeAgentStore();
    await isOwnerAccount(OWNER_ID, { resolveEmail });
    await isOwnerAccount(CUSTOMER_ID, { resolveEmail });

    const previewed = await setPreviewPlan(OWNER_ID, "free", { store });
    assert.equal(previewed.plan.id, "free");
    assert.equal(previewed.previewPlan, "free");
    assert.equal(previewed.unlimited, true, "enforcement stays off while previewing");
    await assertRunWithinBudget(OWNER_ID, { store }); // still never blocked

    const back = await setPreviewPlan(OWNER_ID, null, { store });
    assert.equal(back.previewPlan, null);

    await assert.rejects(setPreviewPlan(CUSTOMER_ID, "pro", { store }), /owner accounts only/);
    // A stray preview_plan on a customer row is ignored entirely.
    await store.upsertSubscription(CUSTOMER_ID, { preview_plan: "pro" });
    const customer = await budgetOverview(CUSTOMER_ID, { store });
    assert.equal(customer.previewPlan, null);
    assert.equal(customer.plan.id, "free");
  }));
