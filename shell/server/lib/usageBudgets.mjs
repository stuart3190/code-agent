// Managed usage budgets: metering the current billing period against the effective plan
// allowance and refusing work once it is spent.
//
// Semantics: run-count and sandbox-compute budgets apply to every run because Thrallo pays
// for the sandbox either way. The managed-token budget applies only to runs executed with
// Thrallo's managed model keys — Codex and BYOK runs spend the user's own tokens.

import { codeAgentStore } from "./codeAgentStore.mjs";
import {
  currentPeriod,
  effectiveBudget,
  getPlan,
  normalizeSubscription,
  planCatalog,
  publicSubscription,
} from "./subscriptionPlans.mjs";

export async function ownerSubscription(owner, { store = codeAgentStore() } = {}) {
  return normalizeSubscription(owner, await store.getSubscription(owner));
}

export async function budgetOverview(owner, { store = codeAgentStore(), now = new Date() } = {}) {
  const subscription = await ownerSubscription(owner, { store });
  const period = currentPeriod(subscription, now);
  const budget = effectiveBudget(subscription);
  const [usage, runs] = await Promise.all([
    store.usageTotalsSince(owner, period.start),
    store.countRunsSince(owner, period.start),
  ]);
  return {
    subscription: publicSubscription(subscription),
    plan: getPlan(subscription.plan) || getPlan("free"),
    period,
    budgets: {
      runs: meter(runs, budget.runs),
      managedTokens: meter(usage.managedTokens, budget.managedTokens),
      computeSeconds: meter(Math.round(usage.computeSeconds), budget.computeSeconds),
    },
  };
}

// Throws a status-carrying error when the owner cannot start another run. The managed-token
// budget only blocks runs that would spend managed tokens.
export async function assertRunWithinBudget(owner, {
  credentialProvider = "managed",
  store = codeAgentStore(),
  now = new Date(),
} = {}) {
  const overview = await budgetOverview(owner, { store, now });
  const { runs, managedTokens, computeSeconds } = overview.budgets;
  if (runs.remaining <= 0) {
    throw budgetError(`Your ${overview.plan.name} plan's monthly run allowance (${runs.limit}) is used up.`);
  }
  if (computeSeconds.remaining <= 0) {
    throw budgetError(`Your ${overview.plan.name} plan's monthly sandbox compute allowance is used up.`);
  }
  if (credentialProvider === "managed" && managedTokens.remaining <= 0) {
    throw budgetError(
      `Your ${overview.plan.name} plan's monthly managed-model token allowance is used up. `
      + "Connect your own provider key in Settings to keep running.",
    );
  }
  return overview;
}

export async function remainingManagedTokens(owner, { store = codeAgentStore(), now = new Date() } = {}) {
  const overview = await budgetOverview(owner, { store, now });
  return overview.budgets.managedTokens.remaining;
}

const OVERRIDE_FIELDS = Object.freeze({
  runs: "run_limit_override",
  managedTokens: "managed_token_limit_override",
  computeSeconds: "compute_seconds_limit_override",
});

// Owners may set personal spend guards below their plan's allowance, never above it.
export async function setBudgetOverrides(owner, input = {}, { store = codeAgentStore() } = {}) {
  const subscription = await ownerSubscription(owner, { store });
  const plan = getPlan(subscription.plan) || getPlan("free");
  const patch = {};
  for (const [name, column] of Object.entries(OVERRIDE_FIELDS)) {
    if (!(name in input)) continue;
    const raw = input[name];
    if (raw === null || raw === "") {
      patch[column] = null;
      continue;
    }
    const value = Math.floor(Number(raw));
    if (!Number.isFinite(value) || value <= 0) {
      throw inputError(`${name} must be a positive number or null`);
    }
    if (value > plan.monthly[name]) {
      throw inputError(
        `${name} cannot exceed your ${plan.name} plan's included ${plan.monthly[name].toLocaleString("en-GB")}`,
      );
    }
    patch[column] = value;
  }
  if (!Object.keys(patch).length) throw inputError("Provide runs, managedTokens, or computeSeconds");
  await store.upsertSubscription(owner, patch);
  return budgetOverview(owner, { store });
}

export async function selectFreePlan(owner, { store = codeAgentStore() } = {}) {
  const subscription = await ownerSubscription(owner, { store });
  if (subscription.stripe_subscription_id && subscription.status === "active") {
    throw inputError(
      "Cancel your paid subscription from the billing portal first; it downgrades automatically at period end.",
      409,
      "active_paid_subscription",
    );
  }
  await store.upsertSubscription(owner, {
    plan: "free",
    status: "active",
    stripe_subscription_id: null,
    current_period_start: null,
    current_period_end: null,
  });
  return budgetOverview(owner, { store });
}

export function planCatalogPublic() {
  return planCatalog().map((plan) => ({
    id: plan.id,
    name: plan.name,
    description: plan.description,
    priceGbp: plan.priceApproved ? plan.priceGbp : null,
    priceApproved: plan.priceApproved,
    monthly: plan.monthly,
  }));
}

function meter(used, limit) {
  return { used, limit, remaining: Math.max(limit - used, 0) };
}

function budgetError(message) {
  const error = new Error(message);
  error.code = "budget_exceeded";
  error.status = 402;
  return error;
}

function inputError(message, status = 400, code = "invalid_budget") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}
