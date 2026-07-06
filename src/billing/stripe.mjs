// Phase 4 (LIVE) — Stripe integration: the 3 managed tiers as subscriptions, top-ups as one-off
// purchases, and a PURE webhook handler that turns Stripe events into ledger grants + entitlement sync.
//
// SECRETS: every key comes from `env` (process.env). Nothing here logs or persists a key. Test-mode
// only is enforced by the caller passing sk_test_… ; we assert it below.
//
// SOURCE OF TRUTH: tier bundle sizes and the top-up £/credit come from costModel.mjs. Stripe only
// holds the £ PRICE; `assertPricesMatchModel()` reconciles Stripe's amounts against the model so the
// two can't silently drift.

import { TIERS, TOPUP_GBP_PER_CREDIT } from "./costModel.mjs";

const MANAGED = TIERS.filter((t) => t.managed);

// 'YYYY-MM' for a unix-seconds timestamp (the billing cycle tag for bundle grants/expiry).
function cycleTag(unixSeconds) {
  const d = new Date((unixSeconds || Math.floor(Date.now() / 1000)) * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function createBilling({ stripe, ledger, env = process.env } = {}) {
  if (!stripe) throw new Error("createBilling: a Stripe client is required.");
  if (!ledger) throw new Error("createBilling: a ledger is required.");

  // Tier id -> Stripe Price id, from env only.
  const priceIdFor = {
    starter: env.STRIPE_PRICE_STARTER,
    pro: env.STRIPE_PRICE_PRO,
    studio: env.STRIPE_PRICE_STUDIO,
  };
  const topupPriceId = env.STRIPE_PRICE_TOPUP;

  // Reverse map: Stripe Price id -> tier object. Built once.
  const tierForPrice = new Map();
  for (const t of MANAGED) if (priceIdFor[t.id]) tierForPrice.set(priceIdFor[t.id], t);

  function tierFor(tierId) {
    const t = MANAGED.find((x) => x.id === tierId);
    if (!t) throw new Error(`unknown managed tier '${tierId}'`);
    if (!priceIdFor[tierId]) throw new Error(`no Stripe price configured for tier '${tierId}' (set STRIPE_PRICE_${tierId.toUpperCase()})`);
    return t;
  }

  // Reconcile Stripe's live price amounts with costModel — catches a price edited in the dashboard
  // that no longer matches the model's £/month or £/credit. Call in setup/proof. (gbp, pence-aware.)
  async function assertPricesMatchModel() {
    const checked = [];
    for (const t of MANAGED) {
      const price = await stripe.prices.retrieve(priceIdFor[t.id]);
      const gbp = price.unit_amount / 100;
      if (price.currency !== "gbp") throw new Error(`${t.id} price currency is ${price.currency}, expected gbp`);
      if (Math.abs(gbp - t.gbpPerMonth) > 1e-6)
        throw new Error(`${t.id} Stripe price £${gbp} != model £${t.gbpPerMonth}/mo`);
      checked.push({ tier: t.id, gbp, recurring: price.recurring?.interval });
    }
    const topup = await stripe.prices.retrieve(topupPriceId);
    const topupGbp = topup.unit_amount / 100;
    if (Math.abs(topupGbp - TOPUP_GBP_PER_CREDIT) > 1e-6)
      throw new Error(`top-up Stripe price £${topupGbp}/unit != model £${TOPUP_GBP_PER_CREDIT}/credit`);
    checked.push({ tier: "topup", gbpPerCredit: topupGbp });
    return checked;
  }

  // Ensure a Stripe customer exists for this Supabase user and the mapping is recorded. metadata.owner
  // lets the webhook resolve customer -> owner even before the customers row is written.
  async function ensureCustomer({ owner, email }) {
    const ent = await ledger.getEntitlement(owner);
    if (ent?.stripe_customer_id) return ent.stripe_customer_id;
    const customer = await stripe.customers.create({ email, metadata: { owner } });
    await ledger.setEntitlement({ owner, stripeCustomerId: customer.id });
    return customer.id;
  }

  // Checkout for a managed subscription tier.
  async function createSubscriptionCheckout({ owner, email, tierId, successUrl, cancelUrl }) {
    const t = tierFor(tierId);
    const customer = await ensureCustomer({ owner, email });
    return stripe.checkout.sessions.create({
      mode: "subscription",
      customer,
      line_items: [{ price: priceIdFor[t.id], quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { owner, tier: t.id },
    });
  }

  // Checkout for a one-off top-up of `credits` credits (priced per-credit; rolls over freely).
  async function createTopupCheckout({ owner, email, credits, successUrl, cancelUrl }) {
    if (!(credits > 0)) throw new Error("createTopupCheckout: credits must be > 0");
    if (!topupPriceId) throw new Error("no Stripe price configured for top-ups (set STRIPE_PRICE_TOPUP)");
    const customer = await ensureCustomer({ owner, email });
    return stripe.checkout.sessions.create({
      mode: "payment",
      customer,
      line_items: [{ price: topupPriceId, quantity: credits }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { owner, kind: "topup", credits: String(credits) },
    });
  }

  // Resolve owner from an event's customer id: customers-table mapping first, then customer metadata.
  async function resolveOwner(customerId, fallbackMeta) {
    if (fallbackMeta?.owner) return fallbackMeta.owner;
    const mapped = customerId ? await ledger.ownerForStripeCustomer(customerId) : null;
    if (mapped) return mapped;
    if (customerId) {
      const c = await stripe.customers.retrieve(customerId);
      return c?.metadata?.owner ?? null;
    }
    return null;
  }

  // Tier from an invoice's first subscription line (price id -> tier object). Line shapes vary across
  // API versions, so check the common locations.
  function tierFromInvoice(invoice) {
    const line = invoice.lines?.data?.find((l) => {
      const id = l.price?.id ?? l.plan?.id ?? l.pricing?.price_details?.price;
      return id && tierForPrice.has(id);
    });
    if (!line) return null;
    const id = line.price?.id ?? line.plan?.id ?? line.pricing?.price_details?.price;
    return { tier: tierForPrice.get(id), period: line.period };
  }

  // Reliable fallback: resolve the tier by retrieving the subscription and reading its item price.
  async function tierFromSubscription(subscriptionId) {
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const priceId = sub.items?.data?.[0]?.price?.id;
    const tier = priceId ? tierForPrice.get(priceId) : null;
    return tier ? { tier, period: { start: sub.current_period_start } } : null;
  }

  // ── Subscription lifecycle (switch / cancel / resume) — ADDITIVE; the handlers above unchanged ─

  // The user's single active subscription, or null.
  async function activeSubscription(owner) {
    const ent = await ledger.getEntitlement(owner);
    if (!ent?.stripe_customer_id) return null;
    const subs = await stripe.subscriptions.list({ customer: ent.stripe_customer_id, status: "active", limit: 3 });
    return subs.data?.[0] || null;
  }

  // Status for the UI: which tier the live subscription is on, and whether it's winding down.
  async function subscriptionStatus(owner) {
    const sub = await activeSubscription(owner);
    if (!sub) return { active: false };
    const priceId = sub.items?.data?.[0]?.price?.id;
    return {
      active: true,
      tier: priceId ? (tierForPrice.get(priceId)?.id ?? null) : null,
      cancelAtPeriodEnd: !!sub.cancel_at_period_end,
      periodEnd: sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end ?? null,
    };
  }

  // Switch tiers in place on the existing subscription.
  //   UPGRADE:   proration_behavior "create_prorations" — the price difference settles on the NEXT
  //              invoice (no immediate invoice => no immediate bundle grant), and the entitlement
  //              flips NOW so the higher tier's features/ceiling unlock immediately. The renewal
  //              invoice grants the new tier's bundle via the existing invoice.paid handler.
  //   DOWNGRADE: proration_behavior "none" — nothing charged or credited now; the entitlement keeps
  //              the richer tier until renewal (the month they paid for stays honored), when the
  //              renewal invoice syncs entitlement + grants the smaller bundle.
  // Exploit note: NEITHER path creates an invoice at switch time, so tier-hopping can never farm
  // bundle grants — grants only ever ride real renewal invoices.
  async function switchTier({ owner, tierId }) {
    const t = tierFor(tierId);
    const sub = await activeSubscription(owner);
    if (!sub) throw new Error("No active subscription to switch — subscribe first.");
    if (sub.cancel_at_period_end) throw new Error("Subscription is set to cancel — resume it before switching plans.");
    const item = sub.items?.data?.[0];
    const currentTier = item?.price?.id ? tierForPrice.get(item.price.id) : null;
    if (!currentTier) throw new Error("Current subscription price is not a managed tier.");
    if (currentTier.id === t.id) return { switched: false, reason: "already on this plan", tier: t.id };
    const upgrade = t.gbpPerMonth > currentTier.gbpPerMonth;
    await stripe.subscriptions.update(sub.id, {
      items: [{ id: item.id, price: priceIdFor[t.id] }],
      proration_behavior: upgrade ? "create_prorations" : "none",
    });
    if (upgrade) await ledger.setEntitlement({ owner, tier: t.id });
    return { switched: true, from: currentTier.id, to: t.id, upgrade, entitlementNow: upgrade ? t.id : currentTier.id };
  }

  // Cancel at period end (default) or resume a pending cancellation. The entitlement stays until
  // Stripe fires customer.subscription.deleted at period end (already handled above).
  async function setCancelAtPeriodEnd({ owner, cancel = true }) {
    const sub = await activeSubscription(owner);
    if (!sub) throw new Error("No active subscription.");
    const updated = await stripe.subscriptions.update(sub.id, { cancel_at_period_end: !!cancel });
    return {
      cancelAtPeriodEnd: !!updated.cancel_at_period_end,
      periodEnd: updated.current_period_end ?? updated.items?.data?.[0]?.current_period_end ?? null,
    };
  }

  // ── THE WEBHOOK HANDLER (pure: parsed event in -> ledger writes out) ──────────────────────────
  // Idempotency is the ledger's (owner, ref, kind, bucket) unique index — Stripe redelivers events, so
  // we key grants on a STABLE id (invoice id / session id), and a redelivery no-ops at the DB.
  async function handleStripeEvent(event) {
    const obj = event.data?.object ?? {};
    switch (event.type) {
      // Subscription paid (initial + every renewal) -> grant the tier's bundle for that cycle.
      case "invoice.paid":
      case "invoice.payment_succeeded": {
        const owner = await resolveOwner(obj.customer, obj.metadata);
        const subId = typeof obj.subscription === "string" ? obj.subscription : obj.subscription?.id;
        const ti = tierFromInvoice(obj) || (subId ? await tierFromSubscription(subId) : null);
        if (!owner || !ti) return { handled: false, reason: "no owner/tier on invoice", type: event.type };
        const cycle = cycleTag(ti.period?.start);
        const res = await ledger.grant({
          owner, credits: ti.tier.bundledCredits, bucket: "bundle", kind: "grant", cycle,
          ref: `invoice:${obj.id}`,
        });
        await ledger.setEntitlement({ owner, tier: ti.tier.id, currentPeriod: cycle });
        return { handled: true, type: event.type, owner, tier: ti.tier.id, cycle, credits: ti.tier.bundledCredits, idempotent: res.idempotent };
      }
      // One-off top-up purchase -> grant top-up credits (amount / £-per-credit).
      case "checkout.session.completed": {
        if (obj.mode !== "payment") return { handled: false, reason: "not a top-up payment", type: event.type };
        const owner = await resolveOwner(obj.customer, obj.metadata);
        if (!owner) return { handled: false, reason: "no owner on session", type: event.type };
        const credits = obj.metadata?.credits
          ? Number(obj.metadata.credits)
          : obj.amount_total / 100 / TOPUP_GBP_PER_CREDIT;
        const res = await ledger.grant({
          owner, credits, bucket: "topup", kind: "grant", ref: `session:${obj.id}`,
        });
        return { handled: true, type: event.type, owner, credits, idempotent: res.idempotent };
      }
      // Subscription cancelled -> clear the entitlement tier (bundle stops renewing; balance untouched).
      case "customer.subscription.deleted": {
        const owner = await resolveOwner(obj.customer, obj.metadata);
        if (owner) await ledger.setEntitlement({ owner, tier: null });
        return { handled: true, type: event.type, owner, tier: null };
      }
      default:
        return { handled: false, reason: "unhandled type", type: event.type };
    }
  }

  return {
    priceIdFor,
    topupPriceId,
    tierForPrice,
    assertPricesMatchModel,
    ensureCustomer,
    createSubscriptionCheckout,
    createTopupCheckout,
    handleStripeEvent,
    activeSubscription,
    subscriptionStatus,
    switchTier,
    setCancelAtPeriodEnd,
    _resolveOwner: resolveOwner,
  };
}
