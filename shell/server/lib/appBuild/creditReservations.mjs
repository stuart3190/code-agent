// Atomic credit reservations: no provider call begins without one.
//
// The ceiling used to be a projection check — spent + estimate, compared at dispatch. Two dispatches
// racing through that check could both pass and jointly cross the ceiling, and a process restart
// forgot everything in flight. A reservation makes the projected cost REAL before the call: it is
// held against the ceiling, reconciled to actual cost afterwards, and the unused remainder released.
//
// The store is pluggable. In production it persists (so restart-recovery can see holds that were in
// flight); in tests it is a Map. All mutation goes through one synchronous section per store, which
// is what makes the concurrency proof meaningful rather than decorative.

import { randomUUID } from "node:crypto";

/** In-memory store — the test double, and the seed of the persisted one. */
export function memoryReservationStore() {
  const holds = new Map(); // id -> { buildId, credits, state }
  return {
    async list(buildId) { return [...holds.values()].filter((h) => h.buildId === buildId && h.state === "held"); },
    async put(hold) { holds.set(hold.id, { ...hold }); return hold; },
    async get(id) { return holds.get(id) || null; },
    async update(id, patch) {
      const hold = holds.get(id);
      if (!hold) return null;
      Object.assign(hold, patch);
      return hold;
    },
    dump() { return [...holds.values()]; },
  };
}

export function createReservations({ store = memoryReservationStore(), spentOf }) {
  // One in-process queue serialises reserve() per build, so two concurrent dispatches cannot both
  // read the same "remaining" and both pass. Restart safety comes from the store: held rows survive
  // and count against the ceiling until reconciled or released.
  const queues = new Map();
  const serialise = (key, task) => {
    const tail = (queues.get(key) || Promise.resolve()).then(task, task);
    queues.set(key, tail.catch(() => {}));
    return tail;
  };

  return {
    /**
     * Reserve `credits` against `ceiling` for one imminent call.
     * Refuses when spent + active holds + this hold would exceed the ceiling.
     */
    async reserve({ buildId, credits, ceiling }) {
      return serialise(buildId, async () => {
        const spent = await spentOf(buildId);
        const active = (await store.list(buildId)).reduce((s, h) => s + h.credits, 0);
        const projected = spent + active + credits;
        if (ceiling && projected > ceiling) {
          return {
            ok: false, reason: "ceiling",
            detail: `spent ${spent.toFixed(2)} + reserved ${active.toFixed(2)} + requested ${credits.toFixed(2)} exceeds ${ceiling}`,
            spent, reserved: active, ceiling,
          };
        }
        const hold = { id: randomUUID(), buildId, credits, state: "held", at: Date.now() };
        await store.put(hold);
        return { ok: true, hold };
      });
    },

    /**
     * Reconcile a hold to what the call actually cost.
     * `actual` may exceed the hold (a call that ran long still really happened and is still owed);
     * the unused remainder is released either way. A failed call that consumed provider tokens
     * reconciles with its real usage — the tokens were incurred whether or not the call succeeded.
     */
    async reconcile(holdId, { actual = 0 } = {}) {
      const hold = await store.get(holdId);
      if (!hold || hold.state !== "held") return { ok: false, reason: "not_held" };
      await store.update(holdId, { state: "settled", actual, settledAt: Date.now() });
      return { ok: true, reserved: hold.credits, actual, released: Math.max(0, hold.credits - actual) };
    },

    /** Release a hold for a call that never reached the provider. Nothing is owed. */
    async release(holdId) {
      const hold = await store.get(holdId);
      if (!hold || hold.state !== "held") return { ok: false, reason: "not_held" };
      await store.update(holdId, { state: "released", releasedAt: Date.now() });
      return { ok: true, released: hold.credits };
    },

    /** What a customer display needs: spent and reserved are different numbers. */
    async status(buildId, ceiling = null) {
      const spent = await spentOf(buildId);
      const reserved = (await store.list(buildId)).reduce((s, h) => s + h.credits, 0);
      return { spent, reserved, available: ceiling === null ? null : Math.max(0, ceiling - spent - reserved) };
    },
  };
}
