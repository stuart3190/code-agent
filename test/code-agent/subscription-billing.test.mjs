import assert from "node:assert/strict";
import test from "node:test";

import { MemoryCodeAgentStore } from "../../shell/server/lib/codeAgentStore.mjs";
import {
  handleSubscriptionEvent, startPlanCheckout, thralloStripeConfigured,
} from "../../shell/server/lib/subscriptionBilling.mjs";

const OWNER = "22222222-2222-4222-8222-222222222222";

function configureStripeEnv() {
  process.env.THRALLO_STRIPE_SECRET_KEY = "sk_test_thrallo";
  process.env.THRALLO_STRIPE_WEBHOOK_SECRET = "whsec_thrallo";
  process.env.THRALLO_STRIPE_PRICE_STARTER = "price_starter";
  process.env.THRALLO_STRIPE_PRICE_PRO = "price_pro";
}

function clearStripeEnv() {
  delete process.env.THRALLO_STRIPE_SECRET_KEY;
  delete process.env.THRALLO_STRIPE_WEBHOOK_SECRET;
  delete process.env.THRALLO_STRIPE_PRICE_STARTER;
  delete process.env.THRALLO_STRIPE_PRICE_PRO;
}

function fakeStripe(event, subscription) {
  return {
    webhooks: { constructEvent: () => event },
    subscriptions: { retrieve: async () => subscription },
    customers: { create: async () => ({ id: "cus_new" }) },
    checkout: { sessions: { create: async (params) => ({ url: `https://checkout/${params.customer}` }) } },
  };
}

test("paid checkout is refused while pricing is not live", async () => {
  clearStripeEnv();
  assert.equal(thralloStripeConfigured(), false);
  const store = new MemoryCodeAgentStore();
  await assert.rejects(
    startPlanCheckout(OWNER, "starter", { store }),
    (error) => error.code === "billing_not_configured" && error.status === 409,
  );
});

test("checkout creates a customer once and returns the session URL", async () => {
  configureStripeEnv();
  const store = new MemoryCodeAgentStore();
  const stripe = fakeStripe();
  const first = await startPlanCheckout(OWNER, "pro", { store, stripe });
  assert.equal(first.url, "https://checkout/cus_new");
  assert.equal((await store.getSubscription(OWNER)).stripe_customer_id, "cus_new");
  stripe.customers.create = async () => { throw new Error("must reuse the stored customer"); };
  await startPlanCheckout(OWNER, "starter", { store, stripe });
  clearStripeEnv();
});

test("completed checkout applies the plan, period, and Stripe identifiers", async () => {
  configureStripeEnv();
  const store = new MemoryCodeAgentStore();
  const subscription = {
    id: "sub_9", customer: "cus_9", status: "active",
    current_period_start: 1_753_000_000, current_period_end: 1_755_600_000,
    items: { data: [{ price: { id: "price_starter" } }] },
  };
  const event = {
    type: "checkout.session.completed",
    data: { object: { client_reference_id: OWNER, subscription: "sub_9" } },
  };
  const result = await handleSubscriptionEvent("raw", "sig", {
    store, stripe: fakeStripe(event, subscription),
  });
  assert.equal(result.plan, "starter");
  const row = await store.getSubscription(OWNER);
  assert.equal(row.plan, "starter");
  assert.equal(row.status, "active");
  assert.equal(row.stripe_subscription_id, "sub_9");
  assert.ok(row.current_period_end.startsWith("2025") || row.current_period_end.startsWith("2026"));
  clearStripeEnv();
});

test("subscription deletion downgrades the owner to the free plan", async () => {
  configureStripeEnv();
  const store = new MemoryCodeAgentStore();
  await store.upsertSubscription(OWNER, {
    plan: "pro", status: "active", stripe_customer_id: "cus_9", stripe_subscription_id: "sub_9",
    current_period_end: new Date().toISOString(),
  });
  const event = {
    type: "customer.subscription.deleted",
    data: { object: { id: "sub_9", customer: "cus_9", metadata: {} } },
  };
  const result = await handleSubscriptionEvent("raw", "sig", { store, stripe: fakeStripe(event) });
  assert.equal(result.plan, "free");
  const row = await store.getSubscription(OWNER);
  assert.equal(row.plan, "free");
  assert.equal(row.stripe_subscription_id, null);
  assert.equal(row.current_period_end, null);
  clearStripeEnv();
});

test("past-due status is synchronized and unknown prices are acknowledged", async () => {
  configureStripeEnv();
  const store = new MemoryCodeAgentStore();
  await store.upsertSubscription(OWNER, { plan: "pro", stripe_customer_id: "cus_9" });
  const pastDue = {
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_9", customer: "cus_9", status: "past_due", metadata: {},
        current_period_start: 1_753_000_000, current_period_end: 1_755_600_000,
        items: { data: [{ price: { id: "price_pro" } }] },
      },
    },
  };
  await handleSubscriptionEvent("raw", "sig", { store, stripe: fakeStripe(pastDue) });
  assert.equal((await store.getSubscription(OWNER)).status, "past_due");

  const unknownPrice = {
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_9", customer: "cus_9", status: "active", metadata: {},
        items: { data: [{ price: { id: "price_mystery" } }] },
      },
    },
  };
  const result = await handleSubscriptionEvent("raw", "sig", { store, stripe: fakeStripe(unknownPrice) });
  assert.equal(result.ignored, "unknown price");
  clearStripeEnv();
});
