// Plan changes for customers who already pay.
//
// Before this, every plan selection created a NEW Stripe subscription. A Starter customer clicking
// Pro ended up with two live subscriptions and two monthly charges, while Thrallo recorded only the
// newer one and silently forgot the first. These tests exist to make that specific outcome
// impossible, and to pin the upgrade/downgrade semantics that were chosen.
//
// The fake below models the parts of Stripe this path depends on, including idempotency keys and
// subscription schedules, so the behaviour is exercised rather than mocked away.

import assert from "node:assert/strict";
import test from "node:test";

import { MemoryCodeAgentStore } from "../../shell/server/lib/codeAgentStore.mjs";
import { startPlanCheckout, handleSubscriptionEvent } from "../../shell/server/lib/subscriptionBilling.mjs";

const OWNER = "33333333-3333-4333-8333-333333333333";
const STARTER = "price_starter_live";
const PRO = "price_pro_live";
const PERIOD_END = 1_760_000_000;               // fixed, so assertions never depend on the clock

async function withBilling(run) {
  const names = [
    "THRALLO_STRIPE_SECRET_KEY", "THRALLO_STRIPE_WEBHOOK_SECRET",
    "THRALLO_STRIPE_PRICE_STARTER", "THRALLO_STRIPE_PRICE_PRO",
    "THRALLO_STARTER_PRICE_ID", "THRALLO_PRO_PRICE_ID",
  ];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  try {
    for (const n of names) delete process.env[n];
    process.env.THRALLO_STRIPE_SECRET_KEY = "sk_test_x";
    process.env.THRALLO_STRIPE_WEBHOOK_SECRET = "whsec_x";
    process.env.THRALLO_STRIPE_PRICE_STARTER = STARTER;
    process.env.THRALLO_STRIPE_PRICE_PRO = PRO;
    return await run();
  } finally {
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  }
}

function subscription({ id = "sub_1", price = STARTER, status = "active", schedule = null } = {}) {
  return {
    id, status, customer: "cus_1", created: 1_000, schedule, metadata: {},
    current_period_start: PERIOD_END - 2_592_000, current_period_end: PERIOD_END,
    items: { data: [{ id: "si_1", price: { id: price } }] },
  };
}

// Models Stripe closely enough that duplicate work is observable: every call is recorded, and
// idempotency keys collapse repeats exactly as the real API does.
function fakeStripe({ subs = [] } = {}) {
  const calls = [];
  const idempotent = new Map();
  const once = (key, produce) => {
    if (key && idempotent.has(key)) return idempotent.get(key);
    const value = produce();
    if (key) idempotent.set(key, value);
    return value;
  };
  const api = {
    calls,
    subs,
    schedules: [],
    customers: {
      create: async (params, opts = {}) => once(opts.idempotencyKey, () => {
        calls.push("customers.create");
        return { id: "cus_1", metadata: params.metadata };
      }),
    },
    subscriptions: {
      list: async () => ({ data: api.subs }),
      retrieve: async (id) => api.subs.find((s) => s.id === id),
      cancel: async (id) => {
        calls.push(`subscriptions.cancel:${id}`);
        api.subs = api.subs.filter((s) => s.id !== id);
        return { id, status: "canceled" };
      },
      update: async (id, params, opts = {}) => once(opts.idempotencyKey, () => {
        calls.push(`subscriptions.update:${id}:${params.items[0].price}:${params.proration_behavior}`);
        const target = api.subs.find((s) => s.id === id);
        target.items.data[0].price = { id: params.items[0].price };
        return target;
      }),
    },
    subscriptionSchedules: {
      create: async (params, opts = {}) => once(opts.idempotencyKey, () => {
        calls.push(`schedules.create:${params.from_subscription}`);
        const schedule = { id: `sched_${api.schedules.length + 1}`, phases: [{ start_date: 1_000 }] };
        api.schedules.push(schedule);
        const target = api.subs.find((s) => s.id === params.from_subscription);
        if (target) target.schedule = schedule.id;
        return schedule;
      }),
      update: async (id, params) => {
        calls.push(`schedules.update:${id}:${params.phases.map((p) => p.items[0].price).join(">")}`);
        return { id, ...params };
      },
      release: async (id) => {
        calls.push(`schedules.release:${id}`);
        for (const s of api.subs) if (s.schedule === id) s.schedule = null;
        return { id, status: "released" };
      },
    },
    checkout: {
      sessions: {
        create: async (params, opts = {}) => once(opts.idempotencyKey, () => {
          calls.push(`checkout:${params.line_items[0].price}`);
          return { url: `https://checkout/${params.line_items[0].price}/${calls.length}` };
        }),
      },
    },
    webhooks: { constructEvent: () => api.event },
  };
  return api;
}

async function seed(store, patch) {
  await store.upsertSubscription(OWNER, {
    plan: "starter", status: "active", stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", ...patch,
  });
}

// ── Free → Starter ──────────────────────────────────────────────────────────────────────

test("Free to Starter still uses Checkout, and repeated clicks yield ONE session", async () => {
  await withBilling(async () => {
    const store = new MemoryCodeAgentStore();
    const stripe = fakeStripe();                     // no live subscription

    const first = await startPlanCheckout(OWNER, "starter", { store, stripe });
    const second = await startPlanCheckout(OWNER, "starter", { store, stripe });

    assert.ok(first.url, "a first-time subscriber goes to Stripe Checkout");
    assert.equal(second.url, first.url, "a double click must not open two payable sessions");
    assert.equal(stripe.calls.filter((c) => c.startsWith("checkout:")).length, 1);
    assert.equal(stripe.calls.filter((c) => c === "customers.create").length, 1,
      "one Stripe customer per owner, even under concurrent first-time checkouts");
  });
});

// ── Starter → Pro (the defect this PR exists for) ───────────────────────────────────────

test("Starter to Pro updates the existing subscription instead of buying a second", async () => {
  await withBilling(async () => {
    const store = new MemoryCodeAgentStore();
    await seed(store);
    const stripe = fakeStripe({ subs: [subscription({ price: STARTER })] });

    const result = await startPlanCheckout(OWNER, "pro", { store, stripe });

    assert.equal(result.url, undefined, "an existing subscriber must NOT be sent to Checkout");
    assert.equal(result.planChange.applied, "immediately");
    assert.equal(result.planChange.plan, "pro");
    assert.equal(stripe.calls.filter((c) => c.startsWith("checkout:")).length, 0,
      "creating a checkout session here is what caused double billing");
    assert.ok(stripe.calls.includes(`subscriptions.update:sub_1:${PRO}:always_invoice`),
      "the upgrade must be a modification, billed pro rata immediately");
    assert.equal(stripe.subs.length, 1, "exactly one subscription may exist for the owner");

    const row = await store.getSubscription(OWNER);
    assert.equal(row.plan, "pro", "Thrallo reflects the upgrade without waiting for the webhook");
    assert.equal(row.stripe_subscription_id, "sub_1", "it is the SAME subscription");
  });
});

test("clicking Upgrade repeatedly charges once", async () => {
  await withBilling(async () => {
    const store = new MemoryCodeAgentStore();
    await seed(store);
    const stripe = fakeStripe({ subs: [subscription({ price: STARTER })] });

    await Promise.all([
      startPlanCheckout(OWNER, "pro", { store, stripe }),
      startPlanCheckout(OWNER, "pro", { store, stripe }),
      startPlanCheckout(OWNER, "pro", { store, stripe }),
    ]);

    const updates = stripe.calls.filter((c) => c.startsWith("subscriptions.update:"));
    assert.equal(updates.length, 1, `concurrent identical upgrades must produce one invoice, got ${updates.length}`);
  });
});

// ── Pro → Starter ───────────────────────────────────────────────────────────────────────

test("Pro to Starter is scheduled for the end of the paid period, not applied immediately", async () => {
  await withBilling(async () => {
    const store = new MemoryCodeAgentStore();
    await seed(store, { plan: "pro" });
    const stripe = fakeStripe({ subs: [subscription({ price: PRO })] });

    const result = await startPlanCheckout(OWNER, "starter", { store, stripe });

    assert.equal(result.planChange.applied, "at_period_end");
    assert.equal(result.planChange.plan, "pro", "they keep Pro for now");
    assert.equal(result.planChange.pendingPlan, "starter");
    assert.equal(result.planChange.effectiveAt, new Date(PERIOD_END * 1000).toISOString());
    assert.match(result.planChange.message, /keep Pro/i, "the message must state what they keep");

    assert.ok(stripe.calls.includes("schedules.create:sub_1"));
    assert.ok(stripe.calls.includes(`schedules.update:sched_1:${PRO}>${STARTER}`),
      "phase one holds Pro, phase two starts Starter");
    assert.equal(stripe.calls.filter((c) => c.startsWith("subscriptions.update:")).length, 0,
      "the live subscription must not change price today");

    const row = await store.getSubscription(OWNER);
    assert.equal(row.plan, "pro", "still Pro until the period ends");
    assert.equal(row.pending_plan, "starter");
    assert.equal(row.stripe_schedule_id, "sched_1");
  });
});

test("a pending downgrade is cancelled by choosing the current plan again", async () => {
  await withBilling(async () => {
    const store = new MemoryCodeAgentStore();
    await seed(store, { plan: "pro", pending_plan: "starter", stripe_schedule_id: "sched_1" });
    const stripe = fakeStripe({ subs: [subscription({ price: PRO, schedule: "sched_1" })] });

    const result = await startPlanCheckout(OWNER, "pro", { store, stripe });

    assert.equal(result.planChange.applied, "pending_change_cancelled");
    assert.ok(stripe.calls.includes("schedules.release:sched_1"));
    const row = await store.getSubscription(OWNER);
    assert.equal(row.pending_plan, null);
    assert.equal(row.stripe_schedule_id, null);
  });
});

test("choosing the current plan with nothing pending is a no-op, not a charge", async () => {
  await withBilling(async () => {
    const store = new MemoryCodeAgentStore();
    await seed(store, { plan: "pro" });
    const stripe = fakeStripe({ subs: [subscription({ price: PRO })] });

    const result = await startPlanCheckout(OWNER, "pro", { store, stripe });

    assert.equal(result.planChange.applied, "unchanged");
    assert.deepEqual(stripe.calls, [], "no Stripe write of any kind");
  });
});

test("the scheduled downgrade lands via the webhook and clears the pending state", async () => {
  await withBilling(async () => {
    const store = new MemoryCodeAgentStore();
    await seed(store, { plan: "pro", pending_plan: "starter", pending_plan_at: "2026-10-09T00:00:00.000Z", stripe_schedule_id: "sched_1" });
    const stripe = fakeStripe();
    // Stripe switches the price at the phase boundary and tells us about it.
    stripe.event = {
      type: "customer.subscription.updated",
      data: { object: subscription({ price: STARTER, schedule: "sched_1" }) },
    };

    const result = await handleSubscriptionEvent("raw", "sig", { store, stripe });

    assert.equal(result.plan, "starter");
    const row = await store.getSubscription(OWNER);
    assert.equal(row.plan, "starter");
    assert.equal(row.pending_plan, null, "the change has happened, so it is no longer pending");
    assert.equal(row.stripe_schedule_id, null);
  });
});

// ── Duplicates, cancellation, resubscription ────────────────────────────────────────────

test("a duplicate subscription acquired outside Thrallo is cancelled, keeping the newest", async () => {
  await withBilling(async () => {
    const store = new MemoryCodeAgentStore();
    await seed(store);
    const stripe = fakeStripe({ subs: [
      { ...subscription({ id: "sub_old", price: STARTER }), created: 100 },
      { ...subscription({ id: "sub_new", price: STARTER }), created: 900 },
    ] });

    await startPlanCheckout(OWNER, "pro", { store, stripe });

    assert.ok(stripe.calls.includes("subscriptions.cancel:sub_old"), "the older duplicate is cancelled");
    assert.ok(stripe.calls.some((c) => c.startsWith("subscriptions.update:sub_new")), "the newest is upgraded");
    assert.equal(stripe.subs.length, 1, "the owner is left paying for exactly one subscription");
  });
});

test("cancellation returns the owner to Free and resubscribing opens a fresh Checkout", async () => {
  await withBilling(async () => {
    const store = new MemoryCodeAgentStore();
    await seed(store, { plan: "pro", pending_plan: "starter", stripe_schedule_id: "sched_1" });

    const cancelling = fakeStripe();
    cancelling.event = {
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_1", customer: "cus_1", metadata: {} } },
    };
    await handleSubscriptionEvent("raw", "sig", { store, stripe: cancelling });

    let row = await store.getSubscription(OWNER);
    assert.equal(row.plan, "free");
    assert.equal(row.stripe_subscription_id, null);
    assert.equal(row.pending_plan, null, "a cancelled subscription cannot still be moving to another plan");
    assert.equal(row.stripe_customer_id, "cus_1", "the customer is retained so resubscribing reuses it");

    // Resubscribe: no live subscription remains, so this is the Checkout path again.
    const resub = fakeStripe();
    const result = await startPlanCheckout(OWNER, "starter", { store, stripe: resub });
    assert.ok(result.url);
    assert.equal(resub.calls.filter((c) => c === "customers.create").length, 0,
      "the existing Stripe customer is reused rather than duplicated");
  });
});

test("a subscription on a price Thrallo does not sell is never silently rewritten", async () => {
  await withBilling(async () => {
    const store = new MemoryCodeAgentStore();
    await seed(store);
    const stripe = fakeStripe({ subs: [subscription({ price: "price_something_else" })] });

    await assert.rejects(
      () => startPlanCheckout(OWNER, "pro", { store, stripe }),
      (e) => e.code === "unrecognised_subscription" && e.status === 409,
    );
    assert.deepEqual(stripe.calls, [], "no write happens against a subscription we do not understand");
  });
});

test("past_due subscriptions are repaired, never duplicated", async () => {
  await withBilling(async () => {
    const store = new MemoryCodeAgentStore();
    await seed(store, { status: "past_due" });
    const stripe = fakeStripe({ subs: [subscription({ price: STARTER, status: "past_due" })] });

    const result = await startPlanCheckout(OWNER, "pro", { store, stripe });

    assert.equal(result.url, undefined,
      "sending a lapsed customer to Checkout would leave them paying two subscriptions");
    assert.ok(stripe.calls.some((c) => c.startsWith("subscriptions.update:sub_1")));
  });
});
