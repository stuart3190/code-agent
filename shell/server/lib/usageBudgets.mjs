// Managed usage budgets: metering the current billing period against the effective plan
// allowance and refusing work once it is spent.
//
// Semantics: run-count and sandbox-compute budgets apply to every run because Thrallo pays
// for the sandbox either way. The managed-token budget applies only to runs executed with
// Thrallo's managed model keys — Codex and BYOK runs spend the user's own tokens.

import { codeAgentStore } from "./codeAgentStore.mjs";
import { optionalEnv } from "./env.mjs";
import { isOwnerAccount } from "./ownerAccounts.mjs";
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
  const ownerAccount = await isOwnerAccount(owner);
  // Owner accounts (Thrallo staff): a preview plan changes ONLY how budgets are presented —
  // enforcement stays bypassed via `unlimited` so staff can experience Free/Starter/Pro
  // views without ever being blocked by them.
  const previewPlan = ownerAccount ? subscription.preview_plan : null;
  // A past-due paid subscription meters at free-plan limits until payment recovers.
  const metered = previewPlan
    ? { ...subscription, plan: previewPlan, run_limit_override: null, managed_token_limit_override: null, compute_seconds_limit_override: null }
    : subscription.status === "past_due"
      ? { ...subscription, plan: "free" }
      : subscription;
  const period = currentPeriod(metered, now);
  const budget = effectiveBudget(metered);
  const [usage, runs] = await Promise.all([
    store.usageTotalsSince(owner, period.start),
    store.countRunsSince(owner, period.start),
  ]);
  return {
    subscription: publicSubscription(subscription),
    plan: getPlan(metered.plan) || getPlan("free"),
    pastDue: !previewPlan && subscription.status === "past_due",
    ownerAccount,
    previewPlan,
    unlimited: ownerAccount,
    period,
    budgets: {
      runs: meter(runs, budget.runs),
      managedTokens: meter(usage.managedTokens, budget.managedTokens),
      computeSeconds: meter(Math.round(usage.computeSeconds), budget.computeSeconds),
    },
  };
}

// Burst protection independent of the monthly budget: bounded concurrent execution and a
// rolling one-hour admission cap per owner.
export async function assertWithinRateLimits(owner, { store = codeAgentStore(), now = new Date() } = {}) {
  if (await isOwnerAccount(owner)) return; // staff are never rate-blocked from their own product
  const maxActive = boundedEnv("CODE_AGENT_MAX_ACTIVE_RUNS", 3);
  const perHour = boundedEnv("CODE_AGENT_RUNS_PER_HOUR", 30);
  const [active, lastHour] = await Promise.all([
    store.countActiveRuns(owner),
    store.countRunsSince(owner, new Date(now.getTime() - 60 * 60_000).toISOString()),
  ]);
  if (active >= maxActive) {
    throw rateError(`You already have ${active} active runs. Wait for one to finish or cancel it.`);
  }
  if (lastHour >= perHour) {
    throw rateError(`You have started ${lastHour} runs in the last hour. Please wait before starting another.`);
  }
}

function boundedEnv(name, fallback) {
  const value = Number(optionalEnv(name, ""));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function rateError(message) {
  const error = new Error(message);
  error.code = "rate_limited";
  error.status = 429;
  return error;
}

// Throws a status-carrying error when the owner cannot start another run. The managed-token
// budget only blocks runs that would spend managed tokens.
export async function assertRunWithinBudget(owner, {
  credentialProvider = "managed",
  store = codeAgentStore(),
  now = new Date(),
} = {}) {
  const overview = await budgetOverview(owner, { store, now });
  if (overview.unlimited) return overview; // owner accounts: metered, never blocked
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
  if (overview.unlimited) return Number.MAX_SAFE_INTEGER; // owners: mid-run guards never trip
  return overview.budgets.managedTokens.remaining;
}

// Owner-only: view the product as another plan. Presentation only — enforcement stays off.
export async function setPreviewPlan(owner, plan, { store = codeAgentStore() } = {}) {
  if (!(await isOwnerAccount(owner))) {
    const error = new Error("Plan preview is available to Thrallo owner accounts only.");
    error.status = 403;
    error.code = "owner_only";
    throw error;
  }
  const normalized = plan === null || plan === "" || plan === "actual" ? null : String(plan);
  if (normalized && !["free", "starter", "pro"].includes(normalized)) {
    throw inputError("plan must be free, starter, pro, or null");
  }
  await store.upsertSubscription(owner, { preview_plan: normalized });
  return budgetOverview(owner, { store });
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
    // Nothing is on its way to another paid plan once the paid relationship is gone.
    pending_plan: null,
    pending_plan_at: null,
    stripe_schedule_id: null,
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
