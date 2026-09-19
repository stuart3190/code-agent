// Subscription lifecycle — the server half of WP12.
//
// Pure ESM over a storage seam, like the account and platform-state services, so the same logic
// runs in the Edge Function and in tests. Two properties matter more than everything else here,
// and generated billing code had neither:
//
//   1. IDEMPOTENT. Payment providers retry. The same webhook arrives twice, or twenty times after
//      an outage. Applying it twice must change nothing: the event id is the key, and a repeat is
//      recorded as a repeat rather than re-applied.
//
//   2. ORDER-SAFE. Providers do not guarantee delivery order. A `cancelled` webhook emitted at
//      10:00 can arrive after an `active` one emitted at 10:05, and applying whichever landed last
//      downgrades a customer who has just paid. Every event carries the provider's own timestamp
//      and sequence; an event older than the state it would overwrite is recorded and IGNORED.
//
// Nothing here decides what someone owes. It records what the provider said, in the order the
// provider said it, exactly once.

import { evaluate } from "./policy.js";

export const BILLING_SERVICE_VERSION = 1;

export class BillingServiceError extends Error {
  constructor(code, message, status = 400, details = null) {
    super(message);
    this.code = code;
    this.status = status;
    if (details) this.details = details;
  }
}

/** The provider event types this service understands, mapped to the status they assert. */
export const EVENT_STATUS = Object.freeze({
  "checkout.completed": "active",
  "subscription.created": "active",
  "subscription.trialing": "trialing",
  "subscription.updated": null,      // carries its own status
  "subscription.past_due": "past_due",
  "subscription.cancelled": "cancelled",
  "subscription.expired": "expired",
  "payment.succeeded": "active",
  "payment.failed": "past_due",
});

const STATUSES = new Set(["none", "trialing", "active", "past_due", "cancelled", "expired"]);
const at = (value) => {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
};

/** In-memory storage twin (tests, shell previews). */
export function memoryBillingStorage({ subscriptions = [], events = [] } = {}) {
  const state = { subscriptions: [...subscriptions], events: [...events] };
  return {
    state,
    async getSubscription(appId, subject) {
      return state.subscriptions.find((row) => row.appId === appId && row.subject === subject) || null;
    },
    async putSubscription(row) {
      const index = state.subscriptions.findIndex((candidate) => candidate.appId === row.appId && candidate.subject === row.subject);
      if (index >= 0) state.subscriptions[index] = { ...row };
      else state.subscriptions.push({ ...row });
      return { ...row };
    },
    async getEvent(appId, eventId) {
      return state.events.find((row) => row.appId === appId && row.eventId === eventId) || null;
    },
    async putEvent(row) {
      state.events.push({ ...row, sequence: state.events.length + 1 });
      return { ...state.events.at(-1) };
    },
    async listEvents(appId, subject) {
      return state.events.filter((row) => row.appId === appId && (!subject || row.subject === subject));
    },
  };
}

/**
 * @param {object} options
 * @param {object} options.storage the storage seam
 * @param {object} [options.policy] the application's account policy, for authorised reads
 * @param {object} [options.catalogue] compilePlans() output, so a plan the build never declared
 *   cannot be written into a subscription by a webhook
 */
export function createBillingService({ storage, policy = null, catalogue = null, now = () => new Date().toISOString() } = {}) {
  if (!storage) throw new Error("createBillingService: storage is required");

  const planFor = (planId, productId) => {
    if (!catalogue?.definitions) return planId ? String(planId) : null;
    if (planId && catalogue.definitions[planId]) return planId;
    // Providers speak in product ids. Mapping back through the declared catalogue means a product
    // nobody declared cannot become a plan nobody can reason about.
    const byProduct = catalogue.ids.find((id) => catalogue.definitions[id].productId === productId);
    return byProduct || null;
  };

  return {
    version: BILLING_SERVICE_VERSION,

    /**
     * Apply one provider event. Returns what happened, so the caller can tell applied from
     * duplicate from out-of-order rather than assuming success.
     */
    async apply(appId, event = {}) {
      const eventId = String(event?.id || "").trim();
      const subject = String(event?.subject || event?.customerId || "").trim();
      if (!eventId) throw new BillingServiceError("billing_event_id_required", "a provider event needs its own id", 400);
      if (!subject) throw new BillingServiceError("billing_subject_required", "a provider event needs the subject it is about", 400);
      const type = String(event?.type || "");
      if (!Object.hasOwn(EVENT_STATUS, type)) {
        // An event type this service does not understand is RECORDED and ignored, never guessed
        // at: writing a status from an event whose meaning is unknown is how billing state rots.
        await storage.putEvent({ appId, eventId, subject, type, occurredAt: event?.occurredAt || now(), receivedAt: now(), outcome: "ignored_unknown_type" });
        return { ok: true, outcome: "ignored_unknown_type", type };
      }

      // 1. Idempotence. The same event twice changes nothing.
      const seen = await storage.getEvent(appId, eventId);
      if (seen) return { ok: true, outcome: "duplicate", eventId, appliedAt: seen.receivedAt };

      const current = await storage.getSubscription(appId, subject);
      const occurredAt = event?.occurredAt || now();

      // 2. Order safety. An event older than the state it would overwrite is not applied.
      if (current && at(occurredAt) < at(current.occurredAt)) {
        await storage.putEvent({ appId, eventId, subject, type, occurredAt, receivedAt: now(), outcome: "ignored_out_of_order" });
        return { ok: true, outcome: "ignored_out_of_order", eventId, currentStatus: current.status };
      }

      const asserted = EVENT_STATUS[type] ?? String(event?.status || "");
      if (!STATUSES.has(asserted)) {
        await storage.putEvent({ appId, eventId, subject, type, occurredAt, receivedAt: now(), outcome: "ignored_unknown_status" });
        return { ok: true, outcome: "ignored_unknown_status", type, status: asserted };
      }
      const planId = planFor(event?.planId, event?.productId) ?? current?.planId ?? null;
      if (catalogue?.definitions && !planId) {
        await storage.putEvent({ appId, eventId, subject, type, occurredAt, receivedAt: now(), outcome: "ignored_unknown_plan" });
        return { ok: true, outcome: "ignored_unknown_plan", productId: event?.productId || null };
      }

      const next = {
        appId, subject, planId,
        status: asserted,
        providerSubscriptionId: event?.providerSubscriptionId || current?.providerSubscriptionId || null,
        currentPeriodEnd: event?.currentPeriodEnd || current?.currentPeriodEnd || null,
        cancelAt: type === "subscription.cancelled" ? (event?.cancelAt || occurredAt) : (event?.cancelAt ?? null),
        occurredAt,
        updatedAt: now(),
      };
      await storage.putSubscription(next);
      await storage.putEvent({ appId, eventId, subject, type, occurredAt, receivedAt: now(), outcome: "applied", status: asserted });
      return { ok: true, outcome: "applied", eventId, subscription: { ...next }, previousStatus: current?.status || "none" };
    },

    /**
     * The subscription state an application may read. A member reads their OWN; reading another
     * subject's is administration, and the policy decides it.
     */
    async status(appId, actor, { subject = null } = {}) {
      if (actor && appId && actor.appId !== appId) {
        throw new BillingServiceError("unauthenticated", "Sign in to this application first.", 401);
      }
      const target = subject && subject !== actor?.userId ? String(subject) : actor?.userId;
      if (subject && subject !== actor?.userId) {
        const decision = policy ? evaluate(policy, actor, "members.read") : { allowed: false, reason: "forbidden" };
        if (!decision.allowed) {
          throw new BillingServiceError(decision.reason || "forbidden", "Not allowed to read another member's subscription.", 403);
        }
      }
      const row = await storage.getSubscription(appId, target);
      if (!row) return { subject: target, planId: null, status: "none" };
      return {
        subject: row.subject, planId: row.planId, status: row.status,
        currentPeriodEnd: row.currentPeriodEnd || null, cancelAt: row.cancelAt || null,
        updatedAt: row.updatedAt || null,
      };
    },

    /** The event trail for one subject, so a billing dispute has something to read. */
    async history(appId, actor, { subject = null } = {}) {
      const target = subject || actor?.userId;
      if (subject && subject !== actor?.userId) {
        const decision = policy ? evaluate(policy, actor, "history.read") : { allowed: false, reason: "forbidden" };
        if (!decision.allowed) throw new BillingServiceError(decision.reason || "forbidden", "Not allowed to read this history.", 403);
      }
      const rows = await storage.listEvents(appId, target);
      return rows
        .slice()
        // Newest first by the provider's own clock, then by arrival. Two events can share a
        // timestamp — a cancellation and a creation emitted in the same second — and without the
        // second key the order of a billing trail would differ between two reads of it.
        .sort((a, b) => at(b.occurredAt) - at(a.occurredAt)
          || Number(b.sequence || 0) - Number(a.sequence || 0)
          || at(b.receivedAt) - at(a.receivedAt))
        .map((row) => ({ eventId: row.eventId, type: row.type, outcome: row.outcome, occurredAt: row.occurredAt, status: row.status || null }));
    },
  };
}
