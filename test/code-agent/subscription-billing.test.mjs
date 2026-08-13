import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { MemoryCodeAgentStore } from "../../shell/server/lib/codeAgentStore.mjs";
import {
  handleSubscriptionEvent, startPlanCheckout, startTopupCheckout, thralloStripeConfigured,
  thralloTopupConfigured, stripeConfigMistake,
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
  delete process.env.THRALLO_STRIPE_TOPUP_PRICE_ID;
  delete process.env.THRALLO_STRIPE_TOPUP_CREDITS;
}

function fakeStripe(event, subscription) {
  const stripe = {
    webhooks: { constructEvent: () => event },
    // No live subscription by default, so plan selection takes the first-time Checkout path.
    subscriptions: { retrieve: async () => subscription, list: async () => ({ data: [] }) },
    // Models the customer surface the code actually uses. A fake that only implemented `create`
    // let a stale email survive unnoticed: the real code returns an existing customer, and the
    // whole point of the reconciliation is what it does to THAT one.
    customers: {
      store: new Map(),
      create: async (params) => {
        const customer = { id: "cus_new", email: params?.email ?? null, metadata: params?.metadata || {} };
        stripe.customers.store.set(customer.id, customer);
        return customer;
      },
      retrieve: async (id) => stripe.customers.store.get(id) || { id, email: null, deleted: false },
      update: async (id, params) => {
        const current = stripe.customers.store.get(id) || { id };
        const next = { ...current, ...params };
        stripe.customers.store.set(id, next);
        return next;
      },
    },
    checkout: { sessions: {
      create: async (params) => ({ url: `https://checkout/${params.customer}` }),
      listLineItems: async () => ({ data: [{ price: { id: "price_topup" }, quantity: 1 }] }),
    } },
  };
  return stripe;
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

test("top-up checkout is config-gated and never accepts a browser-supplied quantity", async () => {
  clearStripeEnv();
  const store = new MemoryCodeAgentStore();
  await assert.rejects(startTopupCheckout(OWNER, { store }), (error) => error.code === "topup_not_configured");
  configureStripeEnv();
  process.env.THRALLO_STRIPE_TOPUP_PRICE_ID = "price_topup";
  process.env.THRALLO_STRIPE_TOPUP_CREDITS = "25";
  assert.equal(thralloTopupConfigured(), true);
  const stripe = fakeStripe();
  let checkout = null;
  const options = [];
  stripe.checkout.sessions.create = async (params, requestOptions) => {
    checkout = params; options.push(requestOptions); return { url: "https://checkout/topup" };
  };
  assert.deepEqual(await startTopupCheckout(OWNER, {
    store, stripe, requestKey: "11111111-1111-4111-8111-111111111111",
  }), { url: "https://checkout/topup" });
  await startTopupCheckout(OWNER, {
    store, stripe, requestKey: "22222222-2222-4222-8222-222222222222",
  });
  assert.deepEqual(checkout.line_items, [{ price: "price_topup", quantity: 1 }]);
  assert.equal(checkout.metadata.thrallo_purchase, "build_credits");
  assert.notEqual(options[0].idempotencyKey, options[1].idempotencyKey);
  delete process.env.THRALLO_STRIPE_WEBHOOK_SECRET;
  assert.equal(thralloTopupConfigured(), false, "payment cannot open without its fulfilment webhook");
  clearStripeEnv();
});

test("a paid top-up webhook grants configured credits exactly once through the append-only ledger", async () => {
  configureStripeEnv();
  process.env.THRALLO_STRIPE_TOPUP_PRICE_ID = "price_topup";
  process.env.THRALLO_STRIPE_TOPUP_CREDITS = "25";
  const grants = [];
  const store = new MemoryCodeAgentStore();
  const setupStripe = fakeStripe();
  let checkout = null;
  setupStripe.checkout.sessions.create = async (params) => {
    checkout = params;
    return { url: "https://checkout/topup" };
  };
  await startTopupCheckout(OWNER, {
    store, stripe: setupStripe, requestKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  });
  const event = { id: "evt_topup", type: "checkout.session.completed", data: { object: {
    id: "cs_topup", mode: "payment", payment_status: "paid", client_reference_id: OWNER,
    customer: checkout.customer, metadata: checkout.metadata,
  } } };
  const result = await handleSubscriptionEvent("raw", "sig", {
    store, stripe: fakeStripe(event),
    ledger: { grant: async (input) => { grants.push(input); return { ok: true }; } },
  });
  assert.equal(result.creditsGranted, 25);
  assert.deepEqual(grants, [{ owner: OWNER, credits: 25, bucket: "topup", ref: "stripe-checkout:cs_topup" }]);
  clearStripeEnv();
});

test("delayed top-up fulfilment uses its signed checkout-time credit contract after config rotation", async () => {
  configureStripeEnv();
  process.env.THRALLO_STRIPE_TOPUP_PRICE_ID = "price_topup";
  process.env.THRALLO_STRIPE_TOPUP_CREDITS = "25";
  const store = new MemoryCodeAgentStore();
  const setupStripe = fakeStripe();
  let checkout = null;
  setupStripe.checkout.sessions.create = async (params) => {
    checkout = params;
    return { url: "https://checkout/topup" };
  };
  await startTopupCheckout(OWNER, {
    store, stripe: setupStripe, requestKey: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  });
  process.env.THRALLO_STRIPE_TOPUP_PRICE_ID = "price_rotated";
  process.env.THRALLO_STRIPE_TOPUP_CREDITS = "40";
  const event = { type: "checkout.session.async_payment_succeeded", data: { object: {
    id: "cs_delayed", mode: "payment", payment_status: "paid", client_reference_id: OWNER,
    customer: checkout.customer, metadata: checkout.metadata,
  } } };
  const stripe = fakeStripe(event);
  stripe.checkout.sessions.listLineItems = async () => ({ data: [{ price: { id: "price_topup" }, quantity: 1 }] });
  const grants = [];
  const result = await handleSubscriptionEvent("raw", "sig", {
    store, stripe, ledger: { grant: async (input) => grants.push(input) },
  });
  assert.equal(result.creditsGranted, 25);
  assert.equal(grants[0].credits, 25);
  clearStripeEnv();
});

test("top-up refunds and disputes adjust credits only from settled outcomes", async () => {
  configureStripeEnv();
  process.env.THRALLO_STRIPE_TOPUP_PRICE_ID = "price_topup";
  process.env.THRALLO_STRIPE_TOPUP_CREDITS = "25";
  const store = new MemoryCodeAgentStore();
  const setupStripe = fakeStripe();
  let checkout = null;
  setupStripe.checkout.sessions.create = async (params) => {
    checkout = params;
    return { url: "https://checkout/topup" };
  };
  await startTopupCheckout(OWNER, {
    store, stripe: setupStripe, requestKey: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  });
  const adjustments = [];
  const deliver = async (event) => {
    const stripe = fakeStripe(event);
    stripe.paymentIntents = { retrieve: async () => ({
      id: "pi_topup", customer: checkout.customer, metadata: checkout.metadata,
      amount_received: 1_000,
    }) };
    return handleSubscriptionEvent("raw", "sig", {
      store, stripe, ledger: { adjust: async (input) => { adjustments.push(input); return { ok: true }; } },
    });
  };

  await deliver({ type: "refund.created", data: { object: {
    id: "re_1", status: "pending", payment_intent: "pi_topup", amount: 500,
  } } });
  await deliver({ type: "refund.updated", data: { object: {
    id: "re_1", status: "failed", payment_intent: "pi_topup", amount: 500,
  } } });
  assert.equal(adjustments.length, 0);
  await deliver({ type: "refund.updated", data: { object: {
    id: "re_1", status: "succeeded", payment_intent: "pi_topup", amount: 500,
  } } });
  await deliver({ type: "refund.created", data: { object: {
    id: "re_1", status: "succeeded", payment_intent: "pi_topup", amount: 500,
  } } });
  assert.deepEqual(adjustments.slice(0, 2), [
    { owner: OWNER, credits: -12.5, bucket: "topup", ref: "stripe-refund:re_1" },
    { owner: OWNER, credits: -12.5, bucket: "topup", ref: "stripe-refund:re_1" },
  ], "duplicate deliveries use one stable append-only ledger identity");

  await deliver({ type: "charge.dispute.created", data: { object: {
    id: "dp_1", status: "needs_response", payment_intent: "pi_topup", amount: 1_000,
  } } });
  await deliver({ type: "charge.dispute.closed", data: { object: {
    id: "dp_1", status: "lost", payment_intent: "pi_topup", amount: 1_000,
  } } });
  await deliver({ type: "charge.dispute.closed", data: { object: {
    id: "dp_2", status: "won", payment_intent: "pi_topup", amount: 1_000,
  } } });
  assert.deepEqual(adjustments.slice(2), [
    { owner: OWNER, credits: -25, bucket: "topup", ref: "stripe-dispute:dp_1" },
    { owner: OWNER, credits: -25, bucket: "topup", ref: "stripe-dispute:dp_2" },
    { owner: OWNER, credits: 25, bucket: "topup", ref: "stripe-dispute-won:dp_2" },
  ]);
  clearStripeEnv();
});

test("completed checkout applies the plan, period, and Stripe identifiers", async () => {
  configureStripeEnv();
  const store = new MemoryCodeAgentStore();
  await store.upsertSubscription(OWNER, { stripe_customer_id: "cus_9" });
  const subscription = {
    id: "sub_9", customer: "cus_9", status: "active",
    current_period_start: 1_753_000_000, current_period_end: 1_755_600_000,
    items: { data: [{ price: { id: "price_starter" } }] },
  };
  const event = {
    type: "checkout.session.completed",
    data: { object: { client_reference_id: OWNER, customer: "cus_9", subscription: "sub_9" } },
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
  // The owner keeps the plan they were already on. An unsold price never grants an entitlement,
  // and it must never silently downgrade a paying customer either.
  assert.equal((await store.getSubscription(OWNER)).plan, "pro");
  clearStripeEnv();
});

// ── Live configuration ─────────────────────────────────────────────────────────────────
//
// These tests own and restore every variable they touch, so they behave identically with and
// without an ambient shell/.env. (main sat red for three runs once because two tests silently
// borrowed a key from the developer's .env that CI did not have.)

async function withEnv(vars, run) {
  const names = [
    "THRALLO_STRIPE_SECRET_KEY", "THRALLO_STRIPE_WEBHOOK_SECRET",
    "THRALLO_STRIPE_PRICE_STARTER", "THRALLO_STRIPE_PRICE_PRO",
    "THRALLO_STARTER_PRICE_ID", "THRALLO_PRO_PRICE_ID",
    "THRALLO_STRIPE_TOPUP_PRICE_ID", "THRALLO_STRIPE_TOPUP_CREDITS",
    "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET",
  ];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  try {
    for (const n of names) delete process.env[n];
    Object.assign(process.env, vars);
    // Awaited, not returned: a bare `return run()` would restore the environment as soon as the
    // promise was created, leaving the body to run against the real environment.
    return await run();
  } finally {
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  }
}

test("either spelling of the price variables configures a plan", async () => {
  // The release notes and the code disagreed on these names once. A correct-looking variable that
  // silently does nothing is the failure mode being prevented here.
  for (const [starter, pro] of [
    ["THRALLO_STRIPE_PRICE_STARTER", "THRALLO_STRIPE_PRICE_PRO"],
    ["THRALLO_STARTER_PRICE_ID", "THRALLO_PRO_PRICE_ID"],
  ]) {
    await withEnv({
      THRALLO_STRIPE_SECRET_KEY: "sk_test_x", THRALLO_STRIPE_WEBHOOK_SECRET: "whsec_x",
      [starter]: "price_s", [pro]: "price_p",
    }, async () => {
      assert.equal(thralloStripeConfigured(), true, `${starter}/${pro} must configure billing`);
      const store = new MemoryCodeAgentStore();
      const stripe = fakeStripe();
      let charged = null;
      stripe.checkout.sessions.create = async (params) => {
        charged = params.line_items[0].price;
        return { url: "https://checkout/x" };
      };
      await startPlanCheckout(OWNER, "starter", { store, stripe });
      assert.equal(charged, "price_s", `${starter} must reach the checkout line item`);
    });
  }
});

test("legacy Buildr101 Stripe variables are refused, not inherited", async () => {
  // Thrallo and Buildr101 share a machine. Silently accepting an un-prefixed key would let
  // Buildr101's Stripe account bill Thrallo's customers.
  await withEnv({ STRIPE_SECRET_KEY: "sk_live_buildr", STRIPE_WEBHOOK_SECRET: "whsec_buildr" }, () => {
    assert.equal(thralloStripeConfigured(), false, "a Buildr101 key must never configure Thrallo");
    assert.match(stripeConfigMistake(), /legacy Buildr101 variable names/,
      "the misconfiguration must be reported rather than looking merely unconfigured");
  });

  // Correctly configured, there is nothing to report.
  await withEnv({
    THRALLO_STRIPE_SECRET_KEY: "sk_live_thrallo", THRALLO_STRIPE_WEBHOOK_SECRET: "whsec_thrallo",
  }, () => assert.equal(stripeConfigMistake(), null));
});

test("only Starter and Pro can be purchased", async () => {
  await withEnv({
    THRALLO_STRIPE_SECRET_KEY: "sk_test_x",
    THRALLO_STRIPE_PRICE_STARTER: "price_s", THRALLO_STRIPE_PRICE_PRO: "price_p",
  }, async () => {
    const store = new MemoryCodeAgentStore();
    for (const plan of ["business", "enterprise", "free", ""]) {
      await assert.rejects(
        () => startPlanCheckout(OWNER, plan, { store, stripe: fakeStripe() }),
        (e) => e.code === "invalid_plan",
        `${plan || "(empty)"} must not be purchasable`,
      );
    }
  });
});

test("no Stripe price identifier is hardcoded anywhere in the shipped app", async () => {
  // Prices come from configuration only. This is what keeps unsold prices — the Business price and
  // the archived Starter price — from being referenced by the app, and it holds for any future one
  // without needing a denylist that would itself name them.
  const roots = ["../../shell/server", "../../shell/web/src", "../../src", "../../scripts"];
  const offenders = [];
  async function walk(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (["node_modules", "dist", "build", ".vite"].includes(entry.name)) continue;
        await walk(path);
      } else if (/\.(mjs|js|jsx|ts|tsx)$/.test(entry.name)) {
        const source = await readFile(path, "utf8");
        // A real Stripe price id: price_ followed by a long opaque token. Deliberately does not
        // match readable test fixtures such as price_starter or price_mystery.
        const found = source.match(/\bprice_1[A-Za-z0-9]{20,}/g);
        if (found) offenders.push(`${path}: ${[...new Set(found)].join(", ")}`);
      }
    }
  }
  await Promise.all(roots.map((r) => walk(fileURLToPath(new URL(r, import.meta.url)))));
  assert.deepEqual(offenders, [], `Stripe price IDs must come from the environment:\n${offenders.join("\n")}`);
});
