import { CodeAgentInputError } from "../lib/codeAgentContracts.mjs";
import {
  budgetOverview,
  planCatalogPublic,
  selectFreePlan,
  setBudgetOverrides,
} from "../lib/usageBudgets.mjs";
import {
  handleSubscriptionEvent,
  startBillingPortal,
  startPlanCheckout,
  thralloStripeConfigured,
  thralloWebhookConfigured,
} from "../lib/subscriptionBilling.mjs";
import { opsTelemetrySnapshot } from "../lib/opsTelemetry.mjs";
import { isAdmin } from "../lib/admin.mjs";

export async function handleBillingOverview(_req, res, owner) {
  return wrap(async () => {
    sendJson(res, 200, {
      ...(await budgetOverview(owner.id)),
      plans: planCatalogPublic(),
      stripeConfigured: thralloStripeConfigured(),
    });
  });
}

export async function handlePlanSelect(_req, res, owner, body = {}) {
  return wrap(async () => {
    const plan = String(body.plan || "").toLowerCase();
    if (plan === "free") {
      return sendJson(res, 200, {
        ...(await selectFreePlan(owner.id)),
        plans: planCatalogPublic(),
        stripeConfigured: thralloStripeConfigured(),
      });
    }
    const result = await startPlanCheckout(owner.id, plan);
    // A first-time subscriber goes to Stripe Checkout. An existing subscriber's plan was changed
    // in place, so return the refreshed billing state with it — there is nowhere to redirect to,
    // and the screen must show the new plan immediately rather than the plan they just left.
    if (result.url) return sendJson(res, 200, result);
    return sendJson(res, 200, {
      ...(await budgetOverview(owner.id)),
      plans: planCatalogPublic(),
      stripeConfigured: thralloStripeConfigured(),
      planChange: result.planChange,
    });
  });
}

export async function handleBudgetUpdate(_req, res, owner, body = {}) {
  return wrap(async () => {
    sendJson(res, 200, {
      ...(await setBudgetOverrides(owner.id, body)),
      plans: planCatalogPublic(),
      stripeConfigured: thralloStripeConfigured(),
    });
  });
}

export async function handleBillingPortal(_req, res, owner) {
  return wrap(async () => {
    sendJson(res, 200, await startBillingPortal(owner.id));
  });
}

// Unauthenticated Stripe webhook; the signature check inside handleSubscriptionEvent is the
// authentication. Returns 501 while billing stays unconfigured so Stripe never retries.
export async function handleBillingWebhook(req, res, rawBody) {
  if (!thralloWebhookConfigured()) {
    return sendJson(res, 501, { error: "Thrallo billing webhook is not configured" });
  }
  try {
    const result = await handleSubscriptionEvent(rawBody, req.headers["stripe-signature"]);
    return sendJson(res, 200, result);
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }
}

export async function handleOpsTelemetry(_req, res, owner) {
  if (!isAdmin(owner)) {
    throw new CodeAgentInputError("Operator access required", 403, "operator_only");
  }
  return sendJson(res, 200, await opsTelemetrySnapshot());
}

async function wrap(fn) {
  try {
    return await fn();
  } catch (error) {
    if (error.status || error.code) {
      throw new CodeAgentInputError(error.message, error.status || 400, error.code || "billing_failed");
    }
    throw error;
  }
}

function sendJson(res, code, value) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}
