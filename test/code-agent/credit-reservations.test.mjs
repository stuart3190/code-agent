// The reservation system: no provider call without a hold, and holds cannot cross the ceiling.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createReservations, memoryReservationStore } from "../../shell/server/lib/appBuild/creditReservations.mjs";

const make = (spent = 0) => {
  let s = spent;
  const store = memoryReservationStore();
  const r = createReservations({ store, spentOf: async () => s });
  return { r, store, addSpent: (n) => { s += n; } };
};

test("a reservation is refused when it would cross the ceiling, before any call", async () => {
  const { r } = make(19.25);
  const ok = await r.reserve({ buildId: "b1", credits: 4.13, ceiling: 28 });
  assert.equal(ok.ok, true, "19.25 + 4.13 = 23.38 is affordable");
  const refused = await r.reserve({ buildId: "b1", credits: 6, ceiling: 28 });
  assert.equal(refused.ok, false, "23.38 held + 6 = 29.38 crosses 28");
  assert.match(refused.detail, /exceeds 28/);
});

test("CONCURRENCY — racing dispatches cannot jointly cross the ceiling", async () => {
  const { r } = make(20);
  // Both would individually pass a naive spent-only check (20 + 5 <= 28). Together they must not.
  const [a, b] = await Promise.all([
    r.reserve({ buildId: "b1", credits: 5, ceiling: 28 }),
    r.reserve({ buildId: "b1", credits: 5, ceiling: 28 }),
  ]);
  const granted = [a, b].filter((x) => x.ok);
  assert.equal(granted.length, 1, "exactly one may win the race");
});

test("RESTART — held reservations survive and still count against the ceiling", async () => {
  const { r, store } = make(10);
  await r.reserve({ buildId: "b1", credits: 10, ceiling: 28 });
  // A new process over the same store: the in-flight hold is still visible and still counts.
  const restarted = createReservations({ store, spentOf: async () => 10 });
  const refused = await restarted.reserve({ buildId: "b1", credits: 9, ceiling: 28 });
  assert.equal(refused.ok, false, "10 spent + 10 held + 9 = 29 crosses 28 across a restart");
});

test("reconcile releases the unused remainder; release frees an unused hold entirely", async () => {
  const { r, addSpent } = make(0);
  const { hold } = await r.reserve({ buildId: "b1", credits: 6, ceiling: 28 });
  const settled = await r.reconcile(hold.id, { actual: 4.13 });
  assert.equal(settled.ok, true);
  assert.equal(settled.released, 6 - 4.13);
  addSpent(4.13);
  const status = await r.status("b1", 28);
  assert.equal(status.reserved, 0, "a settled hold no longer reserves anything");
  assert.equal(status.spent, 4.13);

  const { hold: h2 } = await r.reserve({ buildId: "b1", credits: 3, ceiling: 28 });
  const freed = await r.release(h2.id);
  assert.equal(freed.released, 3, "a call that never reached the provider owes nothing");
  assert.equal((await r.status("b1", 28)).reserved, 0);
});

test("a failed call that consumed provider tokens is still charged its real usage", async () => {
  const { r } = make(0);
  const { hold } = await r.reserve({ buildId: "b1", credits: 5, ceiling: 28 });
  // The call errored AFTER the provider metered usage: reconcile with actual, not with zero.
  const settled = await r.reconcile(hold.id, { actual: 2.2 });
  assert.equal(settled.actual, 2.2);
  assert.equal(settled.released, 2.8);
});

test("spent and reserved are reported as different numbers, never conflated", async () => {
  const { r } = make(12);
  await r.reserve({ buildId: "b1", credits: 4, ceiling: 28 });
  const status = await r.status("b1", 28);
  assert.equal(status.spent, 12);
  assert.equal(status.reserved, 4);
  assert.equal(status.available, 12);
});

test("double-reconcile and double-release are no-ops", async () => {
  const { r } = make(0);
  const { hold } = await r.reserve({ buildId: "b1", credits: 5, ceiling: 28 });
  await r.reconcile(hold.id, { actual: 1 });
  assert.equal((await r.reconcile(hold.id, { actual: 1 })).ok, false);
  assert.equal((await r.release(hold.id)).ok, false);
});
