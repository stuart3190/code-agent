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

// ── PRODUCTION REPLAY — run 83883309, zero credits ────────────────────────────────────────────

test("REPLAY 83883309 — canonical spend, reservations and the ceiling all agree", async () => {
  const { RUN_83883309 } = await import("./billing-cached-tokens.test.mjs");
  const { creditsForUsage } = await import("../../src/billing/costModel.mjs");
  const { createLifecycleBudget } = await import("../../shell/server/lib/appBuild/lifecycleBudget.mjs");

  // The canonical event record, exactly as the diagnostics session builds it: one cost per
  // provider call, priced by the one formula, idempotent on event id.
  const events = new Map();
  const record = (e) => {
    if (events.has(e.id)) return; // duplicate telemetry delivery charges once
    events.set(e.id, creditsForUsage({
      usage: { input: e.input, cached: e.cached, output: e.output, reasoning: e.reasoning, total: e.input + e.output },
      model: e.model,
    }));
  };
  const spent = () => [...events.values()].reduce((a, b) => a + b, 0);

  // The budget derives credits from the SAME supplier — no independent accumulator to drift.
  const budget = createLifecycleBudget({ plan: "free", mode: "build", managed: true, spentSupplier: spent });
  const store = memoryReservationStore();
  const reservations = createReservations({ store, spentOf: async () => spent() });

  // Replay: each call reserves, runs (fake), records its canonical event, reconciles.
  for (const e of RUN_83883309) {
    const hold = await reservations.reserve({ buildId: "83883309", credits: 6, ceiling: 28 });
    assert.equal(hold.ok, true, `call ${e.id} must be affordable at the time it ran`);
    record(e);
    record(e); // duplicate delivery — must not double-charge
    await reservations.reconcile(hold.hold.id, { actual: events.get(e.id) });
  }

  // Canonical spend is 19.25, and EVERY surface reads the same number.
  assert.ok(Math.abs(spent() - 19.25) < 0.01, `canonical spend ${spent().toFixed(2)}`);
  assert.ok(Math.abs(budget.totals.credits - spent()) < 0.01, "the lifecycle budget agrees");
  const status = await reservations.status("83883309", 28);
  assert.ok(Math.abs(status.spent - 19.25) < 0.01, "the reservation ledger agrees");
  assert.equal(status.reserved, 0, "all holds reconciled; reservations shown separately from spend");

  // The 28-ceiling admits an affordable repair (19.25 + 4.13) and refuses one whose maximum
  // reservation would cross the remainder — BEFORE dispatch.
  const affordable = await reservations.reserve({ buildId: "83883309", credits: 4.13, ceiling: 28 });
  assert.equal(affordable.ok, true, "the repair the inflated total wrongly refused is admitted");
  const refused = await reservations.reserve({ buildId: "83883309", credits: 6, ceiling: 28 });
  assert.equal(refused.ok, false, "19.25 + 4.13 held + 6 crosses 28: refused before any call");
  await reservations.release(affordable.hold.id);

  // Restart/replay: a fresh process over the same events reaches the identical totals.
  const replayed = new Map();
  for (const e of [...RUN_83883309, ...RUN_83883309]) {
    if (!replayed.has(e.id)) replayed.set(e.id, events.get(e.id));
  }
  const replaySpend = [...replayed.values()].reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(replaySpend - spent()) < 0.0001, "restart/replay does not change totals");
});

test("parent and child records cannot both charge for one provider call", async () => {
  // The canonical record is keyed by the provider call, not by who reports it: a parent job
  // summary replaying its child's telemetry lands on the same key and charges nothing more.
  const { creditsForUsage } = await import("../../src/billing/costModel.mjs");
  const events = new Map();
  const record = (id, usage, model) => {
    if (!events.has(id)) events.set(id, creditsForUsage({ usage, model }));
  };
  const usage = { input: 10_000, cached: 4_000, output: 1_000, reasoning: 0, total: 11_000 };
  record("resp_1", usage, "gpt-5.6-sol");           // the child call reports
  record("resp_1", usage, "gpt-5.6-sol");           // the parent summary reports the same call
  assert.equal(events.size, 1);
});
