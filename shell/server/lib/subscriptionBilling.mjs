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

// Plans are ordered so a change can be classified as an upgrade or a downgrade.
const PLAN_RANK = Object.freeze({ starter: 1, pro: 2 });

// Statuses that mean "this subscription still owns the customer's billing relationship". past_due
// and unpaid are included deliberately: a lapsed subscription must be REPAIRED, never duplicated,
// or the customer ends up paying twice while one of the two silently fails.
const LIVE_STATUSES = Object.freeze(["active", "trialing", "past_due", "unpaid", "incomplete"]);

// Serialises plan changes per owner within this process. Stripe idempotency keys already make a
// repeated identical request a no-op, but two DIFFERENT requests racing (Pro then Starter, double
// click on separate buttons) would both read the pre-change state and both act. This makes the
// read-decide-write sequence atomic; the idempotency keys cover retries and multiple instances.
const ownerLocks = new Map();
function withOwnerLock(owner, fn) {
  const previous = ownerLocks.get(owner) || Promise.resolve();
  const next = previous.catch(() => {}).then(fn);
  ownerLocks.set(owner, next);
  next.catch(() => {}).finally(() => {
    if (ownerLocks.get(owner) === next) ownerLocks.delete(owner);
  });
  return next;
}

async function ensureCustomer(client, store, owner, subscription) {
  if (subscription.stripe_customer_id) return subscription.stripe_customer_id;
  const customer = await client.customers.create(
    { metadata: { thrallo_owner: owner } },
    // Two concurrent first-time checkouts must not create two Stripe customers for one owner.
    { idempotencyKey: `thrallo:customer:${owner}` },
  );
  await store.upsertSubscription(owner, { stripe_customer_id: customer.id });
  return customer.id;
}

// Every subscription Stripe still considers live for this customer, newest first.
async function liveSubscriptions(client, customerId) {
  const list = await client.subscriptions.list({ customer: customerId, status: "all", limit: 100 });
  return list.data
    .filter((s) => LIVE_STATUSES.includes(s.status))
    .sort((a, b) => (b.created || 0) - (a.created || 0));
}

// Defensive backstop. The change path below cannot create a second subscription, but a customer
// could still acquire one through the Stripe dashboard or a legacy payment link. Keeping the
// newest and cancelling the rest stops an owner being billed twice; doing nothing would let the
// duplicate renew forever with no surface in Thrallo showing it.
async function cancelDuplicates(client, subscriptions, owner) {
  for (const extra of subscriptions.slice(1)) {
    try {
      await client.subscriptions.cancel(extra.id, { prorate: true });
      console.error(`[thrallo-billing] cancelled duplicate subscription ${extra.id} for owner ${owner}`);
    } catch (error) {
      console.error(`[thrallo-billing] could not cancel duplicate ${extra.id}: ${error?.message}`);
    }
  }
}

/**
 * Move an owner onto a paid plan.
 *
 * With no live subscription this returns `{ url }` for Stripe Checkout, exactly as before.
 * With one, it MODIFIES that subscription instead of buying a second — the difference between
 * an upgrade and two concurrent bills — and returns `{ planChange }` describing what happened.
 */
export async function startPlanCheckout(owner, planId, {
  store = codeAgentStore(),
  stripe = null,
} = {}) {
  if (!["starter", "pro"].includes(planId)) {
    throw billingError("Choose the Starter or Pro plan", 400, "invalid_plan");
  }
  if (!thralloStripeConfigured()) throw notConfigured();
  const client = stripe || stripeClient();

  return withOwnerLock(owner, async () => {
    const record = await ownerSubscription(owner, { store });
    const customerId = await ensureCustomer(client, store, owner, record);
    const live = await liveSubscriptions(client, customerId);
    if (live.length > 1) await cancelDuplicates(client, live, owner);

    const current = live[0];
    if (!current) return { url: await createCheckoutSession(client, owner, planId, customerId) };
    return { planChange: await changeExistingPlan({ client, store, owner, planId, subscription: current }) };
  });
}

async function createCheckoutSession(client, owner, planId, customerId) {
  const price = planPrice(planId);
  const session = await client.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    client_reference_id: owner,
    line_items: [{ price, quantity: 1 }],
    subscription_data: { metadata: { thrallo_owner: owner, thrallo_plan: planId } },
    success_url: `${appOrigin()}/?billing=success`,
    cancel_url: `${appOrigin()}/?billing=cancelled`,
  }, {
    // A double click, or the same page open in two tabs, returns the SAME session rather than two.
    // Without this, paying in both tabs buys two subscriptions.
    idempotencyKey: `thrallo:checkout:${owner}:${customerId}:${price}`,
  });
  return session.url;
}

// Modify the subscription the customer already has.
//
//   Upgrade   (Starter → Pro): immediate. Stripe invoices the prorated difference straight away,
//                              so the customer pays only for the part of the period they gain.
//   Downgrade (Pro → Starter): at the end of the paid period. They keep what they have already
//                              paid for, and no confusing credit balance is created.
//
// Both are reversible before they take effect, and both reach Thrallo through the webhook.
async function changeExistingPlan({ client, store, owner, planId, subscription }) {
  const item = subscription.items?.data?.[0];
  const currentPlan = priceToPlan(item?.price?.id);
  const targetPrice = planPrice(planId);

  // A subscription on a price Thrallo does not sell is not something to silently rewrite.
  if (!currentPlan) {
    throw billingError(
      "Your subscription is on a plan Thrallo cannot change automatically. Contact support and we will sort it out.",
      409, "unrecognised_subscription",
    );
  }

  const scheduleId = typeof subscription.schedule === "string"
    ? subscription.schedule : subscription.schedule?.id;

  if (currentPlan === planId) {
    // Already on this plan. If a downgrade was pending, asking for the current plan again is the
    // natural way to cancel it, so release the schedule and stay put.
    if (scheduleId) {
      await client.subscriptionSchedules.release(scheduleId);
      await store.upsertSubscription(owner, { pending_plan: null, pending_plan_at: null, stripe_schedule_id: null });
      return {
        plan: planId, applied: "pending_change_cancelled",
        message: `Your scheduled change was cancelled. You stay on ${planName(planId)}.`,
      };
    }
    return { plan: planId, applied: "unchanged", message: `You are already on ${planName(planId)}.` };
  }

  // Any pending change is superseded by an explicit new choice.
  if (scheduleId) {
    await client.subscriptionSchedules.release(scheduleId);
    await store.upsertSubscription(owner, { pending_plan: null, pending_plan_at: null, stripe_schedule_id: null });
  }

  const isUpgrade = PLAN_RANK[planId] > PLAN_RANK[currentPlan];
  // Same intent twice (a double click) is one Stripe operation, not two invoices.
  const idempotencyKey = `thrallo:plan:${owner}:${subscription.id}:${item.price.id}->${targetPrice}`;

  if (isUpgrade) {
    const updated = await client.subscriptions.update(subscription.id, {
      items: [{ id: item.id, price: targetPrice }],
      // Bill the difference now rather than letting it accumulate silently to the next invoice.
      proration_behavior: "always_invoice",
      payment_behavior: "error_if_incomplete",
      metadata: { ...(subscription.metadata || {}), thrallo_owner: owner, thrallo_plan: planId },
    }, { idempotencyKey });
    await applySubscription(store, owner, updated);
    return {
      plan: planId, applied: "immediately", effectiveAt: null,
      message: `You are on ${planName(planId)} now. We have charged only the difference for the rest of this billing period.`,
    };
  }

  // Downgrade: hold the current plan until the period ends, then switch.
  const periodEnd = subscription.current_period_end;
  const schedule = await client.subscriptionSchedules.create(
    { from_subscription: subscription.id },
    { idempotencyKey: `${idempotencyKey}:schedule` },
  );
  await client.subscriptionSchedules.update(schedule.id, {
    end_behavior: "release",
    phases: [
      {
        items: [{ price: item.price.id, quantity: 1 }],
        start_date: schedule.phases[0].start_date,
        end_date: periodEnd,
        proration_behavior: "none",
      },
      {
        items: [{ price: targetPrice, quantity: 1 }],
        start_date: periodEnd,
        proration_behavior: "none",
      },
    ],
  });
  const effectiveAt = unixIso(periodEnd);
  await store.upsertSubscription(owner, {
    pending_plan: planId, pending_plan_at: effectiveAt, stripe_schedule_id: schedule.id,
  });
  return {
    plan: currentPlan, pendingPlan: planId, applied: "at_period_end", effectiveAt,
    message: `You will move to ${planName(planId)} on ${formatDate(effectiveAt)}. `
      + `Until then you keep ${planName(currentPlan)}, which you have already paid for.`,
  };
}

function planName(planId) {
  return planId === "pro" ? "Pro" : planId === "starter" ? "Starter" : "Free";
}

function formatDate(iso) {
  return iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) : "your next billing date";
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
        // A cancelled subscription cannot still be on its way to another plan.
        pending_plan: null,
        pending_plan_at: null,
        stripe_schedule_id: null,
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

  // Stripe is the authority on what plan the subscription is actually on. When a scheduled
  // downgrade reaches its phase boundary, Stripe changes the price and sends this event — so the
  // arrival of the target plan is exactly what proves the pending change is no longer pending.
  const scheduleId = typeof subscription.schedule === "string"
    ? subscription.schedule : subscription.schedule?.id || null;
  const existing = await store.getSubscription(owner).catch(() => null);
  const pendingSatisfied = existing?.pending_plan && existing.pending_plan === plan;
  const clearPending = pendingSatisfied || !scheduleId;

  await store.upsertSubscription(owner, {
    plan: status === "cancelled" ? "free" : plan,
    status: status === "cancelled" ? "active" : status,
    stripe_customer_id: String(subscription.customer),
    stripe_subscription_id: status === "cancelled" ? null : subscription.id,
    current_period_start: unixIso(subscription.current_period_start),
    current_period_end: unixIso(subscription.current_period_end),
    ...(clearPending
      ? { pending_plan: null, pending_plan_at: null, stripe_schedule_id: null }
      : { stripe_schedule_id: scheduleId }),
  });
  return { received: true, owner, plan, status, ...(clearPending ? {} : { pendingPlan: existing?.pending_plan }) };
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
