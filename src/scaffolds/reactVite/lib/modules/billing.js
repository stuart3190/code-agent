// Billing/entitlements module v1 — platform infrastructure, do not edit or reimplement.
//
// The audit's requirement for this package is "idempotent webhook lifecycle and entitlement
// enforcement; remove generated billing state logic" (WP12). The generated version of billing was
// wrong in ways that cost real money in both directions:
//
//   - ENTITLEMENT FROM THE CLIENT. A screen read a `plan` field off the signed-in user and
//     decided what to show. Anyone could edit it, and more commonly it was simply stale: a
//     cancelled customer kept full access until they reloaded.
//   - LIMITS AS UI. "3 projects on the free plan" was enforced by disabling a button. The create
//     call underneath had no idea, so anything that reached it another way went through.
//   - LIFECYCLE AS A BOOLEAN. `isSubscribed` collapsed trialing, active, past_due, cancelled-but-
//     paid-until and cancelled into one bit, so a customer in their grace period was locked out
//     and a cancelled one kept access.
//
// This module owns the reading half: a declared plan catalogue, and entitlement decisions made
// from the SERVER's subscription state with an explicit reason. It never decides what someone
// paid; it decides what the state it was given permits, and says why.
//
// Headless: state and functions only.

export const BILLING_MODULE_VERSION = "1.0.0";

/** The lifecycle a subscription actually has. Collapsing these to a boolean is the defect. */
export const SUBSCRIPTION_STATUS = Object.freeze({
  NONE: "none", TRIALING: "trialing", ACTIVE: "active", PAST_DUE: "past_due",
  CANCELLED: "cancelled", EXPIRED: "expired",
});
/** Statuses that still grant what the plan promises. past_due is deliberately included: a failed
 *  card is a payment problem, not a reason to lock someone out of their own data that hour. */
const ENTITLING = new Set([SUBSCRIPTION_STATUS.TRIALING, SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.PAST_DUE]);

export const BILLING_ERROR = Object.freeze({
  UNKNOWN_PLAN: "billing_plan_unknown",
  UNKNOWN_FEATURE: "billing_feature_unknown",
  NOT_ENTITLED: "billing_not_entitled",
  LIMIT_REACHED: "billing_limit_reached",
  UNAVAILABLE: "billing_unavailable",
});

export const DENIED = Object.freeze({
  NO_SUBSCRIPTION: "no_subscription",
  PLAN_LACKS_FEATURE: "plan_lacks_feature",
  SUBSCRIPTION_EXPIRED: "subscription_expired",
  SUBSCRIPTION_CANCELLED: "subscription_cancelled",
  LIMIT_REACHED: "limit_reached",
});

export class BillingError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.code = code;
    if (details) this.details = details;
  }
}

const freeze = (value) => Object.freeze(value);
const listOf = (value) => (Array.isArray(value) ? value : []);

/**
 * Compile the declared plan catalogue.
 *   plans: [{ id, productId?, features: ["export"], limits: { projects: 3 }, default?: true }]
 * Every feature any plan mentions becomes a known feature, so asking about one nobody declared is
 * a wiring error rather than a silent false — the difference between "you cannot" and "I have
 * never heard of that", which is exactly the confusion that made generated gating untestable.
 */
export function compilePlans(plans = []) {
  const definitions = {};
  const features = new Set();
  const limits = new Set();
  let fallback = null;
  for (const row of listOf(plans)) {
    const id = String(row?.id || "").trim();
    if (!id) continue;
    for (const feature of listOf(row?.features)) features.add(String(feature));
    for (const limit of Object.keys(row?.limits || {})) limits.add(limit);
    definitions[id] = freeze({
      id,
      productId: row?.productId ? String(row.productId) : null,
      title: String(row?.title || id),
      features: freeze(listOf(row?.features).map(String)),
      limits: freeze({ ...(row?.limits || {}) }),
      default: row?.default === true,
    });
    if (row?.default === true && !fallback) fallback = id;
  }
  return freeze({
    version: BILLING_MODULE_VERSION,
    definitions: freeze(definitions),
    ids: freeze(Object.keys(definitions)),
    features: freeze([...features].sort()),
    limits: freeze([...limits].sort()),
    // The plan someone has before they pay for anything. Declared, never guessed: an application
    // with no free tier says so, and then nothing is entitled until a subscription exists.
    defaultPlan: fallback,
  });
}

/**
 * Decide one entitlement from a subscription state. Pure, so the same answer is available on the
 * server, in a test, and on screen.
 *
 * @param {object} catalogue compilePlans() output
 * @param {object} subscription { planId, status, currentPeriodEnd, cancelAt }
 * @param {string} feature
 * @param {object} [options] { at: Date } — the moment the decision is about
 */
export function evaluateEntitlement(catalogue, subscription, feature, { at = new Date() } = {}) {
  const key = String(feature);
  if (!catalogue.features.includes(key)) {
    throw new BillingError(BILLING_ERROR.UNKNOWN_FEATURE,
      `no feature "${key}" is declared by any plan`, { features: [...catalogue.features] });
  }
  const status = subscription?.status || SUBSCRIPTION_STATUS.NONE;
  const planId = subscription?.planId || (status === SUBSCRIPTION_STATUS.NONE ? catalogue.defaultPlan : null);
  const plan = planId ? catalogue.definitions[planId] : null;
  if (!plan) return freeze({ allowed: false, reason: DENIED.NO_SUBSCRIPTION, plan: null, feature: key });
  // A cancelled subscription keeps what it paid for until the period it paid for ends. Locking
  // someone out the moment they cancel is taking money for time not served.
  const periodEnd = subscription?.currentPeriodEnd ? new Date(subscription.currentPeriodEnd) : null;
  const withinPaidPeriod = periodEnd ? periodEnd.getTime() > at.getTime() : false;
  if (status === SUBSCRIPTION_STATUS.CANCELLED && !withinPaidPeriod) {
    return freeze({ allowed: false, reason: DENIED.SUBSCRIPTION_CANCELLED, plan: plan.id, feature: key });
  }
  if (status === SUBSCRIPTION_STATUS.EXPIRED) {
    return freeze({ allowed: false, reason: DENIED.SUBSCRIPTION_EXPIRED, plan: plan.id, feature: key });
  }
  if (!ENTITLING.has(status) && !(status === SUBSCRIPTION_STATUS.CANCELLED && withinPaidPeriod)
    && !(status === SUBSCRIPTION_STATUS.NONE && plan.id === catalogue.defaultPlan)) {
    return freeze({ allowed: false, reason: DENIED.NO_SUBSCRIPTION, plan: plan.id, feature: key });
  }
  if (!plan.features.includes(key)) {
    return freeze({ allowed: false, reason: DENIED.PLAN_LACKS_FEATURE, plan: plan.id, feature: key,
      // Which plans DO have it, so an upgrade prompt names something real.
      availableOn: freeze(catalogue.ids.filter((id) => catalogue.definitions[id].features.includes(key))) });
  }
  return freeze({ allowed: true, reason: null, plan: plan.id, feature: key, status });
}

/** How much of a declared limit remains. `null` means the plan does not cap it. */
export function evaluateLimit(catalogue, subscription, limit, used = 0, { at = new Date() } = {}) {
  const key = String(limit);
  const status = subscription?.status || SUBSCRIPTION_STATUS.NONE;
  const planId = subscription?.planId || (status === SUBSCRIPTION_STATUS.NONE ? catalogue.defaultPlan : null);
  const plan = planId ? catalogue.definitions[planId] : null;
  if (!plan) return freeze({ allowed: false, reason: DENIED.NO_SUBSCRIPTION, limit: key, used, cap: 0, remaining: 0 });
  const cap = plan.limits[key];
  if (cap === undefined || cap === null) {
    return freeze({ allowed: true, reason: null, limit: key, used, cap: null, remaining: null, plan: plan.id });
  }
  const remaining = Math.max(0, Number(cap) - Number(used || 0));
  void at;
  return freeze({
    allowed: remaining > 0, reason: remaining > 0 ? null : DENIED.LIMIT_REACHED,
    limit: key, used: Number(used || 0), cap: Number(cap), remaining, plan: plan.id,
    availableOn: remaining > 0 ? undefined
      : freeze(catalogue.ids.filter((id) => {
        const other = catalogue.definitions[id].limits[key];
        return other === undefined || other === null || Number(other) > Number(cap);
      })),
  });
}

/**
 * @param {object} options
 * @param {object} options.catalogue compilePlans() output
 * @param {object} options.transport { status(), checkout({ planId }), portal() } — the app's
 *   billing surface. `status()` returns the SERVER's subscription record.
 * @param {(limit: string) => Promise<number>} [options.usage] counts what a limit measures
 */
export function createBilling({ catalogue, transport, usage = null, now = () => new Date() } = {}) {
  if (!catalogue?.definitions) throw new BillingError(BILLING_ERROR.UNAVAILABLE, "createBilling needs a compiled plan catalogue");
  if (typeof transport?.status !== "function") throw new BillingError(BILLING_ERROR.UNAVAILABLE, "createBilling needs a billing transport");
  const listeners = new Set();
  let state = {
    status: "idle", subscription: null, plan: null, error: null, loadedAt: null,
  };
  let snapshot = null;
  const emit = () => { for (const listener of [...listeners]) listener(getState()); };
  const commit = (patch) => { state = { ...state, ...patch }; snapshot = null; emit(); return getState(); };
  const getState = () => {
    if (!snapshot) {
      snapshot = freeze({
        ...state,
        catalogue,
        // Every declared feature, decided once, so a screen never re-derives gating per element.
        entitlements: freeze(Object.fromEntries(catalogue.features.map((feature) =>
          [feature, evaluateEntitlement(catalogue, state.subscription, feature, { at: now() })]))),
      });
    }
    return snapshot;
  };

  return {
    catalogue,
    getState,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },

    /** Read the SERVER's subscription state. Nothing here is decided from a client-held field. */
    async load() {
      commit({ status: "loading", error: null });
      try {
        const subscription = await transport.status();
        const planId = subscription?.planId || catalogue.defaultPlan;
        return commit({
          status: "ready", subscription: subscription || null,
          plan: planId ? catalogue.definitions[planId] || null : null, loadedAt: now().toISOString(), error: null,
        });
      } catch (error) {
        // An unreachable billing service must not silently grant everything, and must not silently
        // deny everything either: it reports, and entitlement falls back to the declared default
        // plan — which is what someone has before they pay, and therefore the safe answer.
        return commit({
          status: "error", subscription: null, plan: catalogue.defaultPlan ? catalogue.definitions[catalogue.defaultPlan] : null,
          error: { code: BILLING_ERROR.UNAVAILABLE, message: String(error?.message || error) },
        });
      }
    },

    /** Is this feature permitted by the state the server reported? Always with a reason. */
    can(feature) { return evaluateEntitlement(catalogue, state.subscription, feature, { at: now() }); },

    /** How much of a limit remains, counting what is actually stored rather than a UI guess. */
    async remaining(limit) {
      const used = usage ? await usage(String(limit)) : 0;
      return evaluateLimit(catalogue, state.subscription, limit, used, { at: now() });
    },

    /**
     * Assert an entitlement before doing the thing. This is the call a mutation makes, so a limit
     * is enforced where the work happens rather than by a disabled button.
     */
    async require(feature) {
      const decision = evaluateEntitlement(catalogue, state.subscription, feature, { at: now() });
      if (!decision.allowed) {
        throw new BillingError(BILLING_ERROR.NOT_ENTITLED, `${feature} is not included in this plan`, { ...decision });
      }
      return decision;
    },

    async requireWithin(limit) {
      const decision = await this.remaining(limit);
      if (!decision.allowed) {
        throw new BillingError(BILLING_ERROR.LIMIT_REACHED, `the ${limit} limit for this plan has been reached`, { ...decision });
      }
      return decision;
    },

    /** Start checkout for a declared plan. An undeclared plan cannot be bought. */
    async checkout(planId, options = {}) {
      const plan = catalogue.definitions[String(planId)];
      if (!plan) {
        throw new BillingError(BILLING_ERROR.UNKNOWN_PLAN, `no plan "${planId}" is declared`, { plans: [...catalogue.ids] });
      }
      if (!plan.productId) {
        throw new BillingError(BILLING_ERROR.UNAVAILABLE, `plan "${plan.id}" has no product configured for this deployment`);
      }
      return transport.checkout({ planId: plan.id, productId: plan.productId, ...options });
    },

    /** The provider's own management surface, where one is configured. */
    async portal(options = {}) {
      if (typeof transport.portal !== "function") {
        throw new BillingError(BILLING_ERROR.UNAVAILABLE, "no billing portal is configured for this application");
      }
      return transport.portal(options);
    },
  };
}
