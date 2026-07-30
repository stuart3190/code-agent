import assert from "node:assert/strict";
import test from "node:test";

import { MemoryCodeAgentStore } from "../../shell/server/lib/codeAgentStore.mjs";
import {
  assertRunWithinBudget, budgetOverview, selectFreePlan, setBudgetOverrides,
} from "../../shell/server/lib/usageBudgets.mjs";
import { runCodingAgent } from "../../shell/server/lib/codingAgent.mjs";

const OWNER = "11111111-1111-4111-8111-111111111111";

async function seededStore() {
  const store = new MemoryCodeAgentStore();
  const repository = await store.createRepository(OWNER, {
    full_name: "owner/repo", clone_url: "https://github.com/owner/repo.git",
    default_branch: "main", private: true, provider: "github",
  });
  const agent = await store.createAgent(OWNER, { repository_id: repository.id, name: "a", mode: "agent" });
  return { store, repository, agent };
}

async function seedRun(store, agent, repository, usage = {}) {
  const run = await store.createRun(OWNER, agent, repository, { prompt: "p", mode: "agent", model: "auto" });
  await store.updateRun(run, { started_at: new Date().toISOString() });
  if (Object.keys(usage).length) await store.recordUsage(run, usage);
  return run;
}

test("budget overview meters runs, managed tokens, and compute for the period", async () => {
  const { store, repository, agent } = await seededStore();
  await seedRun(store, agent, repository, {
    billing_source: "managed", input_tokens: 600, output_tokens: 400, compute_seconds: 120,
  });
  await seedRun(store, agent, repository, {
    billing_source: "byok", input_tokens: 5_000, output_tokens: 5_000, compute_seconds: 60,
  });
  const overview = await budgetOverview(OWNER, { store });
  assert.equal(overview.subscription.plan, "free");
  assert.equal(overview.budgets.runs.used, 2);
  assert.equal(overview.budgets.managedTokens.used, 1_000);
  assert.equal(overview.budgets.computeSeconds.used, 180);
  assert.ok(overview.budgets.runs.remaining > 0);
});

test("an exhausted run allowance blocks every new run", async () => {
  const { store, repository, agent } = await seededStore();
  await store.upsertSubscription(OWNER, { run_limit_override: 1 });
  await seedRun(store, agent, repository);
  await assert.rejects(
    assertRunWithinBudget(OWNER, { credentialProvider: "byok", store }),
    (error) => error.code === "budget_exceeded" && error.status === 402,
  );
});

test("exhausted managed tokens block managed runs but not BYOK runs", async () => {
  const { store, repository, agent } = await seededStore();
  await store.upsertSubscription(OWNER, { managed_token_limit_override: 100 });
  await seedRun(store, agent, repository, {
    billing_source: "managed", input_tokens: 90, output_tokens: 20, compute_seconds: 1,
  });
  await assert.rejects(
    assertRunWithinBudget(OWNER, { credentialProvider: "managed", store }),
    /token allowance/,
  );
  await assert.doesNotReject(assertRunWithinBudget(OWNER, { credentialProvider: "openai", store }));
});

test("exhausted sandbox compute blocks BYOK runs too", async () => {
  const { store, repository, agent } = await seededStore();
  await store.upsertSubscription(OWNER, { compute_seconds_limit_override: 100 });
  await seedRun(store, agent, repository, { billing_source: "byok", compute_seconds: 150 });
  await assert.rejects(
    assertRunWithinBudget(OWNER, { credentialProvider: "openai", store }),
    /compute allowance/,
  );
});

test("spend guards validate and can only tighten the plan allowance", async () => {
  const { store } = await seededStore();
  const overview = await setBudgetOverrides(OWNER, { runs: 3 }, { store });
  assert.equal(overview.budgets.runs.limit, 3);
  await assert.rejects(setBudgetOverrides(OWNER, { runs: 10_000_000 }, { store }), /cannot exceed/);
  await assert.rejects(setBudgetOverrides(OWNER, { managedTokens: -5 }, { store }), /positive/);
  await assert.rejects(setBudgetOverrides(OWNER, {}, { store }), /Provide/);
  const cleared = await setBudgetOverrides(OWNER, { runs: null }, { store });
  assert.ok(cleared.budgets.runs.limit > 3);
});

test("free-plan switch is refused while a paid Stripe subscription is active", async () => {
  const { store } = await seededStore();
  await store.upsertSubscription(OWNER, {
    plan: "pro", status: "active", stripe_subscription_id: "sub_1",
  });
  await assert.rejects(selectFreePlan(OWNER, { store }), /billing portal/);
  await store.upsertSubscription(OWNER, { stripe_subscription_id: null });
  const overview = await selectFreePlan(OWNER, { store });
  assert.equal(overview.subscription.plan, "free");
});

test("the coding loop stops when the managed token budget runs out mid-run", async () => {
  const events = [];
  const provider = {
    model: "fake",
    async turn() {
      return {
        text: "", usage: { inputTokens: 800, outputTokens: 300, totalTokens: 1_100 },
        output: [{ type: "function_call", call_id: "c1", name: "git_status", arguments: "{}" }],
      };
    },
  };
  await assert.rejects(
    runCodingAgent({
      run: { prompt: "big", owner: OWNER, model: "auto" },
      runner: { status: async () => ({ output: "" }) },
      provider,
      emit: async (type) => events.push(type),
      isCancelled: async () => false,
      tokenBudget: 1_000,
    }),
    (error) => {
      assert.equal(error.code, "budget_exhausted");
      assert.equal(error.usage.totalTokens, 1_100);
      return true;
    },
  );
  assert.ok(events.includes("run.budget_exhausted"));
});
