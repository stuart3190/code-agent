import assert from "node:assert/strict";
import test from "node:test";

const {
  planCatalog, getPlan, normalizeSubscription, effectiveBudget, currentPeriod,
} = await import("../../shell/server/lib/subscriptionPlans.mjs");

test("catalog exposes free, starter, and pro with positive allowances", () => {
  const plans = planCatalog();
  assert.deepEqual(plans.map((plan) => plan.id), ["free", "starter", "pro"]);
  for (const plan of plans) {
    assert.ok(plan.monthly.runs > 0);
    assert.ok(plan.monthly.managedTokens > 0);
    assert.ok(plan.monthly.computeSeconds > 0);
  }
  assert.equal(plans[0].priceGbp, 0);
  assert.equal(plans[0].priceApproved, true);
});

test("paid prices stay hidden until the env approves them", () => {
  delete process.env.THRALLO_STARTER_PRICE_GBP;
  assert.equal(getPlan("starter").priceApproved, false);
  assert.equal(getPlan("starter").priceGbp, null);
  process.env.THRALLO_STARTER_PRICE_GBP = "15";
  assert.equal(getPlan("starter").priceApproved, true);
  assert.equal(getPlan("starter").priceGbp, 15);
  delete process.env.THRALLO_STARTER_PRICE_GBP;
});

test("plan limits accept env overrides", () => {
  process.env.THRALLO_PLAN_FREE_RUNS = "5";
  assert.equal(getPlan("free").monthly.runs, 5);
  delete process.env.THRALLO_PLAN_FREE_RUNS;
  assert.equal(getPlan("free").monthly.runs, 20);
});

test("a missing subscription row normalizes to an active free plan", () => {
  const subscription = normalizeSubscription("owner-1", null);
  assert.equal(subscription.plan, "free");
  assert.equal(subscription.status, "active");
  assert.equal(subscription.run_limit_override, null);
});

test("overrides only tighten the plan allowance", () => {
  const subscription = normalizeSubscription("owner-1", {
    plan: "free",
    run_limit_override: 5,
    managed_token_limit_override: 999_999_999_999,
  });
  const budget = effectiveBudget(subscription);
  assert.equal(budget.runs, 5);
  assert.equal(budget.managedTokens, getPlan("free").monthly.managedTokens);
  assert.equal(budget.computeSeconds, getPlan("free").monthly.computeSeconds);
});

test("period uses the Stripe billing window when current, else the UTC month", () => {
  const now = new Date("2026-07-30T12:00:00Z");
  const calendar = currentPeriod(normalizeSubscription("o", null), now);
  assert.equal(calendar.start, "2026-07-01T00:00:00.000Z");
  assert.equal(calendar.end, "2026-08-01T00:00:00.000Z");

  const stripeManaged = currentPeriod(normalizeSubscription("o", {
    plan: "starter",
    current_period_start: "2026-07-15T00:00:00.000Z",
    current_period_end: "2026-08-15T00:00:00.000Z",
  }), now);
  assert.equal(stripeManaged.start, "2026-07-15T00:00:00.000Z");

  const expired = currentPeriod(normalizeSubscription("o", {
    plan: "starter",
    current_period_start: "2026-05-01T00:00:00.000Z",
    current_period_end: "2026-06-01T00:00:00.000Z",
  }), now);
  assert.equal(expired.start, "2026-07-01T00:00:00.000Z");
});
