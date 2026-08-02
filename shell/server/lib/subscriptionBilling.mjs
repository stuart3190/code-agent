// Stripe subscription wiring for Thrallo plans.
//
// Deliberately dormant until Stuart approves pricing: every entry point checks
// THRALLO_STRIPE_* configuration and returns a clear "not live yet" error without it.
// Uses its own env names so Buildr101's Stripe account can never be reused by accident.

import Stripe from "stripe";
import { optionalEnv } from "./env.mjs";
import { codeAgentStore } from "./codeAgentStore.mjs";
import { ownerSubscription } from "./usageBudgets.mjs";

let cachedClient = null;

// Thrallo sells exactly three plans: free, starter, pro. Only these two live prices exist.
// Any other price arriving on a webhook is refused rather than guessed at (see applySubscription).
const PRICE_ENV = Object.freeze({
  // Both spellings are accepted because both are THRALLO-prefixed and therefore cannot collide
  // with the legacy Buildr101 variables. A correct-looking variable that silently does nothing
  // is a worse failure than a duplicated name.
  starter: ["THRALLO_STRIPE_PRICE_STARTER", "THRALLO_STARTER_PRICE_ID"],
  pro: ["THRALLO_STRIPE_PRICE_PRO", "THRALLO_PRO_PRICE_ID"],
});

function priceEnv(planId) {
  for (const name of PRICE_ENV[planId] || []) {
    const value = optionalEnv(name);
    if (value) return value.trim();
  }
  return "";
}

// The un-prefixed STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET belong to the RETIRED Buildr101
// billing code (services.mjs, routes/stripeWebhook.mjs). They are deliberately NOT accepted here:
// silently inheriting a Buildr101 credential would breach the isolation rule that has kept the
// two products apart. Setting only those is a misconfiguration, so say so loudly rather than
// appearing unconfigured for no visible reason.
export function stripeConfigMistake() {
  const usingLegacyKey = !optionalEnv("THRALLO_STRIPE_SECRET_KEY") && optionalEnv("STRIPE_SECRET_KEY");
  const usingLegacyHook = !optionalEnv("THRALLO_STRIPE_WEBHOOK_SECRET") && optionalEnv("STRIPE_WEBHOOK_SECRET");
  if (usingLegacyKey || usingLegacyHook) {
    return "Stripe is configured under the legacy Buildr101 variable names. Thrallo reads "
      + "THRALLO_STRIPE_SECRET_KEY and THRALLO_STRIPE_WEBHOOK_SECRET; the un-prefixed names are "
      + "deliberately ignored so a Buildr101 credential can never be inherited.";
  }
  return null;
}

export function thralloStripeConfigured() {
  const mistake = stripeConfigMistake();
  if (mistake) console.error(`[thrallo-billing] ${mistake}`);
  return !!(optionalEnv("THRALLO_STRIPE_SECRET_KEY") && priceEnv("starter") && priceEnv("pro"));
}

export function thralloWebhookConfigured() {
  return !!(optionalEnv("THRALLO_STRIPE_SECRET_KEY") && optionalEnv("THRALLO_STRIPE_WEBHOOK_SECRET"));
}

function stripeClient() {
  if (cachedClient) return cachedClient;
  const key = optionalEnv("THRALLO_STRIPE_SECRET_KEY");
  if (!key) throw notConfigured();
  cachedClient = new Stripe(key);
  return cachedClient;
}

function planPrice(planId) {
  return priceEnv(planId);
}

function priceToPlan(priceId) {
  if (!priceId) return null;
  for (const planId of ["starter", "pro"]) {
    if (priceId === priceEnv(planId)) return planId;
  }
  return null;
}

function appOrigin() {
  return optionalEnv("THRALLO_APP_ORIGIN", "https://app.thrallo.com").replace(/\/$/, "");
}

export async function startPlanCheckout(owner, planId, {
  store = codeAgentStore(),
  stripe = null,
} = {}) {
  if (!["starter", "pro"].includes(planId)) {
    throw billingError("Choose the Starter or Pro plan", 400, "invalid_plan");
  }
  if (!thralloStripeConfigured()) throw notConfigured();
  const client = stripe || stripeClient();
  const subscription = await ownerSubscription(owner, { store });
  let customerId = subscription.stripe_customer_id;
  if (!customerId) {
    const customer = await client.customers.create({ metadata: { thrallo_owner: owner } });
    customerId = customer.id;
    await store.upsertSubscription(owner, { stripe_customer_id: customerId });
  }
  const session = await client.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    client_reference_id: owner,
    line_items: [{ price: planPrice(planId), quantity: 1 }],
    subscription_data: { metadata: { thrallo_owner: owner, thrallo_plan: planId } },
    success_url: `${appOrigin()}/?billing=success`,
    cancel_url: `${appOrigin()}/?billing=cancelled`,
  });
  return { url: session.url };
}

export async function startBillingPortal(owner, { store = codeAgentStore(), stripe = null } = {}) {
  if (!optionalEnv("THRALLO_STRIPE_SECRET_KEY")) throw notConfigured();
  const subscription = await ownerSubscription(owner, { store });
  if (!subscription.stripe_customer_id) {
    throw billingError("No billing account exists yet", 409, "no_billing_account");
  }
  const client = stripe || stripeClient();
  const session = await client.billingPortal.sessions.create({
    customer: subscription.stripe_customer_id,
    return_url: `${appOrigin()}/`,
  });
  return { url: session.url };
}

// Signature-verified Stripe webhook. Synchronizes plan, status, and billing period from the
// authoritative Stripe subscription object; unknown prices and owners are acknowledged and
// logged rather than retried forever.
export async function handleSubscriptionEvent(rawBody, signature, {
  store = codeAgentStore(),
  stripe = null,
} = {}) {
  const secret = optionalEnv("THRALLO_STRIPE_WEBHOOK_SECRET");
  if (!secret) throw notConfigured();
  const client = stripe || stripeClient();
  const event = client.webhooks.constructEvent(rawBody, signature, secret);

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const owner = session.client_reference_id;
    if (!owner || !session.subscription) return { received: true, ignored: "no owner or subscription" };
    const subscription = await client.subscriptions.retrieve(session.subscription);
    return applySubscription(store, owner, subscription);
  }

  if (["customer.subscription.updated", "customer.subscription.deleted"].includes(event.type)) {
    const subscription = event.data.object;
    const existing = await store.findSubscriptionByStripeCustomer(String(subscription.customer));
    const owner = existing?.owner || subscription.metadata?.thrallo_owner;
    if (!owner) return { received: true, ignored: "unknown customer" };
    if (event.type === "customer.subscription.deleted") {
      await store.upsertSubscription(owner, {
        plan: "free",
        status: "active",
        stripe_subscription_id: null,
        current_period_start: null,
        current_period_end: null,
      });
      return { received: true, owner, plan: "free" };
    }
    return applySubscription(store, owner, subscription);
  }

  return { received: true, ignored: event.type };
}

async function applySubscription(store, owner, subscription) {
  const priceId = subscription.items?.data?.[0]?.price?.id;
  const plan = priceToPlan(priceId);
  if (!plan) {
    // Thrallo sells only Starter and Pro, so a price we do not recognise is never granted — the
    // alternative (guessing a plan) would hand out entitlements nobody bought. But this state means
    // money may be moving with nothing delivered, so it is logged as ACTION REQUIRED with the ids
    // needed to cancel and refund. Acknowledged (not thrown) so Stripe stops redelivering.
    console.error(
      `[thrallo-billing] ACTION REQUIRED: subscription ${subscription.id} for owner ${owner} uses `
      + `unsold price ${priceId} (customer ${subscription.customer}). No plan granted. `
      + `Cancel and refund it in Stripe, or add the price to Thrallo's catalogue.`,
    );
    return { received: true, ignored: "unknown price" };
  }
  const status = ["active", "trialing"].includes(subscription.status) ? "active"
    : ["past_due", "unpaid", "incomplete"].includes(subscription.status) ? "past_due"
      : "cancelled";
  await store.upsertSubscription(owner, {
    plan: status === "cancelled" ? "free" : plan,
    status: status === "cancelled" ? "active" : status,
    stripe_customer_id: String(subscription.customer),
    stripe_subscription_id: status === "cancelled" ? null : subscription.id,
    current_period_start: unixIso(subscription.current_period_start),
    current_period_end: unixIso(subscription.current_period_end),
  });
  return { received: true, owner, plan, status };
}

function unixIso(seconds) {
  return seconds ? new Date(Number(seconds) * 1000).toISOString() : null;
}

function notConfigured() {
  return billingError(
    "Paid Thrallo plans are not live yet. The free plan remains fully usable.",
    409,
    "billing_not_configured",
  );
}

function billingError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}
