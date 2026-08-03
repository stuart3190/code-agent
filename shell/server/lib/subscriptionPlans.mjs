// Thrallo subscription plans and managed usage budgets.
//
// The catalog is code-defined so tiers and included usage are reviewable in one place.
// Limits are env-overridable, and paid prices appear only once THRALLO_<PLAN>_PRICE_GBP is
// set — Stuart has not approved public pricing yet, so upgrades stay disabled until then.

import { optionalEnv } from "./env.mjs";

export const PLAN_IDS = Object.freeze(["free", "starter", "pro"]);

const HOUR = 3_600;

function limit(name, fallback) {
  const value = Number(optionalEnv(name, ""));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function price(name) {
  const value = Number(optionalEnv(name, ""));
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function planCatalog() {
  return [
    {
      id: "free",
      name: "Free",
      description: "Evaluate Thrallo on real repositories with a bounded monthly allowance.",
      priceGbp: 0,
      priceApproved: true,
      monthly: {
        runs: limit("THRALLO_PLAN_FREE_RUNS", 20),
        managedTokens: limit("THRALLO_PLAN_FREE_MANAGED_TOKENS", 1_500_000),
        computeSeconds: limit("THRALLO_PLAN_FREE_COMPUTE_SECONDS", 3 * HOUR),
      },
    },
    {
      id: "starter",
      name: "Starter",
      description: "Daily agent work for an individual engineer.",
      priceGbp: price("THRALLO_STARTER_PRICE_GBP"),
      priceApproved: price("THRALLO_STARTER_PRICE_GBP") !== null,
      monthly: {
        runs: limit("THRALLO_PLAN_STARTER_RUNS", 200),
        managedTokens: limit("THRALLO_PLAN_STARTER_MANAGED_TOKENS", 20_000_000),
        computeSeconds: limit("THRALLO_PLAN_STARTER_COMPUTE_SECONDS", 30 * HOUR),
      },
    },
    {
      id: "pro",
      name: "Pro",
      description: "Heavy multi-repository automation and model comparisons.",
      priceGbp: price("THRALLO_PRO_PRICE_GBP"),
      priceApproved: price("THRALLO_PRO_PRICE_GBP") !== null,
      monthly: {
        runs: limit("THRALLO_PLAN_PRO_RUNS", 1_000),
        managedTokens: limit("THRALLO_PLAN_PRO_MANAGED_TOKENS", 100_000_000),
        computeSeconds: limit("THRALLO_PLAN_PRO_COMPUTE_SECONDS", 120 * HOUR),
      },
    },
  ];
}

export function getPlan(id) {
  return planCatalog().find((plan) => plan.id === id) || null;
}

// A missing subscription row means the free plan; the row is created lazily on first write.
export function normalizeSubscription(owner, row) {
  return {
    owner,
    plan: PLAN_IDS.includes(row?.plan) ? row.plan : "free",
    status: row?.status || "active",
    stripe_customer_id: row?.stripe_customer_id || null,
    stripe_subscription_id: row?.stripe_subscription_id || null,
    current_period_start: row?.current_period_start || null,
    current_period_end: row?.current_period_end || null,
    // Set to stop at the end of the paid period. Distinct from status 'cancelled', which means it
    // has ALREADY stopped — telling the two apart is the difference between "renews on the 12th"
    // and "ends on the 12th".
    cancel_at_period_end: !!row?.cancel_at_period_end,
    run_limit_override: row?.run_limit_override || null,
    managed_token_limit_override: row?.managed_token_limit_override || null,
    compute_seconds_limit_override: row?.compute_seconds_limit_override || null,
    preview_plan: PLAN_IDS.includes(row?.preview_plan) ? row.preview_plan : null,
    // A downgrade that has been chosen but does not take effect until the paid period ends.
    pending_plan: PLAN_IDS.includes(row?.pending_plan) ? row.pending_plan : null,
    pending_plan_at: row?.pending_plan_at || null,
  };
}

// Personal overrides are spend guards: they can only tighten the plan's included budget.
export function effectiveBudget(subscription) {
  const plan = getPlan(subscription.plan) || getPlan("free");
  const clamp = (planLimit, override) =>
    override ? Math.min(planLimit, Number(override)) : planLimit;
  return {
    runs: clamp(plan.monthly.runs, subscription.run_limit_override),
    managedTokens: clamp(plan.monthly.managedTokens, subscription.managed_token_limit_override),
    computeSeconds: clamp(plan.monthly.computeSeconds, subscription.compute_seconds_limit_override),
  };
}

// Stripe-managed subscriptions meter against the billing period; everyone else uses the
// current UTC calendar month so the allowance resets on a predictable date.
export function currentPeriod(subscription, now = new Date()) {
  const start = subscription.current_period_start && new Date(subscription.current_period_start);
  const end = subscription.current_period_end && new Date(subscription.current_period_end);
  if (start && end && start <= now && now < end) {
    return { start: start.toISOString(), end: end.toISOString() };
  }
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start: monthStart.toISOString(), end: monthEnd.toISOString() };
}

export function publicSubscription(subscription) {
  const plan = getPlan(subscription.plan) || getPlan("free");
  const pending = subscription.pending_plan ? getPlan(subscription.pending_plan) : null;
  return {
    plan: subscription.plan,
    planName: plan.name,
    status: subscription.status,
    stripeManaged: !!subscription.stripe_subscription_id,
    currentPeriodEnd: subscription.current_period_end,
    // What the period end MEANS, so no surface has to work it out and none can get it wrong.
    cancelAtPeriodEnd: !!subscription.cancel_at_period_end,
    periodEndMeans: !subscription.stripe_subscription_id ? "resets"
      : subscription.cancel_at_period_end ? "ends"
        : subscription.pending_plan ? "changes" : "renews",
    priceGbp: plan.priceGbp,
    // Shown so a scheduled downgrade is never a surprise on the day it lands.
    pendingPlan: subscription.pending_plan || null,
    pendingPlanName: pending?.name || null,
    pendingPlanAt: subscription.pending_plan_at || null,
    overrides: {
      runs: subscription.run_limit_override,
      managedTokens: subscription.managed_token_limit_override,
      computeSeconds: subscription.compute_seconds_limit_override,
    },
  };
}
