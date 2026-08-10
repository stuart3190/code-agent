// Zero-model wizard lifecycle fixture.
//
// The 2026-08-10 live qualification produced exactly one browser console error —
// `wizard is cancelled` — and its slot step then reported "no clickable option was identified".
// Slot options render only while the wizard is on that step, so once the machine is cancelled
// the panel never populates and every later step collapses behind it.
//
// This fixture drives makeWizardMachine through the whole lifecycle deterministically, with a
// real durable-persistence adapter backed by an in-memory entity store. It documents the exact
// state transitions rather than asserting a preferred design: where behaviour is a live hazard
// it is pinned so a change is a deliberate decision, not an accident.
//
// No provider call, no browser, no platform behaviour changed by this file.

import test from "node:test";
import assert from "node:assert/strict";

import {
  makeWizardMachine, makeWizardPersistence, WIZARD_STATUS,
} from "../../src/scaffolds/reactVite/lib/capabilities/wizard.js";

/** An in-memory stand-in for the platform entity store, with a real session prerequisite. */
function memoryDeps() {
  const rows = [];
  let sessions = 0;
  let serial = 0;
  const db = {
    entity() {
      return {
        async list({ filters = {}, limit = 100 } = {}) {
          return rows
            .filter((row) => Object.entries(filters).every(([k, v]) => row.data[k] === v))
            .slice(0, limit)
            .map((row) => ({ ...row }));
        },
        async create(data) { const row = { id: `row-${++serial}`, data: { ...data } }; rows.push(row); return { ...row }; },
        async update(id, data) {
          const row = rows.find((r) => r.id === id);
          row.data = { ...data };
          return { ...row };
        },
        async delete(id) { const i = rows.findIndex((r) => r.id === id); if (i >= 0) rows.splice(i, 1); },
      };
    },
  };
  return { deps: { db, ensureSession: async () => { sessions += 1; return { id: "visitor" }; } }, rows, sessions: () => sessions };
}

const STEPS = ["date", "slot", "review"];
const makeMachine = (deps, overrides = {}) => makeWizardMachine({
  id: "lifecycle-fixture",
  steps: STEPS,
  persistence: makeWizardPersistence({ key: "lifecycle-fixture", deps }),
  onConfirm: async (values) => ({ reference: `REF-${values.date || "x"}` }),
  deps,
  ...overrides,
});

// ── the happy path ────────────────────────────────────────────────────────────────────────────

test("select → next → confirm walks the whole flow and lands CONFIRMED", async () => {
  const { deps } = memoryDeps();
  const wizard = makeMachine(deps);

  assert.equal(wizard.getState().status, WIZARD_STATUS.ACTIVE);
  await wizard.select("date", "2026-06-14");
  assert.equal(wizard.getState().values.date, "2026-06-14");

  assert.equal((await wizard.next()).ok, true);
  await wizard.select("slot", "19:30");
  assert.equal((await wizard.next()).ok, true);
  assert.equal(wizard.getState().stepId, "review");

  const confirmed = await wizard.confirm();
  assert.equal(confirmed.ok, true);
  assert.equal(wizard.getState().status, WIZARD_STATUS.CONFIRMED);
  assert.equal(wizard.getState().confirmation.reference, "REF-2026-06-14");
});

test("subscribe/getState report every transition to a consumer", async () => {
  const { deps } = memoryDeps();
  const wizard = makeMachine(deps);
  const seen = [];
  const unsubscribe = wizard.subscribe((state) => seen.push(state.status));
  await wizard.select("date", "2026-06-14");
  await wizard.next();
  await wizard.cancel();
  unsubscribe();
  assert.ok(seen.length >= 3, `expected transitions, saw ${seen.join(",")}`);
  assert.equal(seen.at(-1), WIZARD_STATUS.CANCELLED);
});

// ── the terminal states ───────────────────────────────────────────────────────────────────────

test("a CONFIRMED wizard refuses further edits and refuses cancellation", async () => {
  const { deps } = memoryDeps();
  const wizard = makeMachine(deps);
  await wizard.select("date", "d"); await wizard.next();
  await wizard.select("slot", "s"); await wizard.next();
  await wizard.confirm();

  await assert.rejects(() => wizard.select("date", "other"), /wizard is confirmed/);
  await assert.rejects(() => wizard.next(), /wizard is confirmed/);
  await assert.rejects(() => wizard.cancel(), /a confirmed wizard cannot be cancelled/);
});

test("a CANCELLED wizard refuses further edits — this is the live `wizard is cancelled` error", async () => {
  const { deps } = memoryDeps();
  const wizard = makeMachine(deps);
  await wizard.select("date", "d");
  await wizard.cancel();

  assert.equal(wizard.getState().status, WIZARD_STATUS.CANCELLED);
  assert.ok(wizard.getState().cancelledAt, "cancellation is timestamped");
  await assert.rejects(() => wizard.select("slot", "s"), /wizard is cancelled/);
  await assert.rejects(() => wizard.next(), /wizard is cancelled/);
  await assert.rejects(() => wizard.confirm(), /wizard is cancelled/);
  // Cancelling twice is idempotent rather than an error.
  assert.equal((await wizard.cancel()).status, WIZARD_STATUS.CANCELLED);
});

// ── durability: the live hazard ───────────────────────────────────────────────────────────────

test("CANCELLED is persisted and restored, and the restored machine is unusable until reset", async () => {
  const { deps } = memoryDeps();
  const first = makeMachine(deps);
  await first.select("date", "2026-06-14");
  await first.cancel();

  // A fresh page load: a new machine over the SAME durable key.
  const reloaded = makeMachine(deps);
  assert.equal(reloaded.getState().status, WIZARD_STATUS.ACTIVE, "a new machine starts active before restore()");
  await reloaded.restore();
  assert.equal(reloaded.getState().status, WIZARD_STATUS.CANCELLED, "restore brings the cancelled state back");

  // THE LIVE HAZARD, pinned: after restoring a cancelled wizard, the flow cannot be driven.
  // A visitor returning to start a NEW booking hits this, and so does the journey verifier on
  // its second pass — which is exactly what stalled the slot step in the 2026-08-10 run.
  await assert.rejects(() => reloaded.select("date", "2026-06-21"), /wizard is cancelled/);
  await assert.rejects(() => reloaded.next(), /wizard is cancelled/);

  // reset() is the only supported recovery, and it clears the durable record too.
  await reloaded.reset();
  assert.equal(reloaded.getState().status, WIZARD_STATUS.ACTIVE);
  assert.deepEqual(reloaded.getState().values, {});
  await reloaded.select("date", "2026-06-21");
  assert.equal(reloaded.getState().values.date, "2026-06-21");

  const afterReset = makeMachine(deps);
  await afterReset.restore();
  assert.equal(afterReset.getState().status, WIZARD_STATUS.ACTIVE,
    "reset cleared the durable cancelled record, so a later load starts clean");
});

test("CONFIRMED is persisted and restored with its reference intact", async () => {
  const { deps } = memoryDeps();
  const first = makeMachine(deps);
  await first.select("date", "2026-06-14"); await first.next();
  await first.select("slot", "19:30"); await first.next();
  await first.confirm();

  const reloaded = makeMachine(deps);
  await reloaded.restore();
  assert.equal(reloaded.getState().status, WIZARD_STATUS.CONFIRMED);
  assert.equal(reloaded.getState().confirmation.reference, "REF-2026-06-14");
  assert.equal(reloaded.getState().values.slot, "19:30", "the selections survive the reload");
});

test("an in-progress wizard restores mid-flow with its step and values", async () => {
  const { deps } = memoryDeps();
  const first = makeMachine(deps);
  await first.select("date", "2026-06-14");
  await first.next();
  await first.select("slot", "19:30");

  const reloaded = makeMachine(deps);
  await reloaded.restore();
  assert.equal(reloaded.getState().status, WIZARD_STATUS.ACTIVE);
  assert.equal(reloaded.getState().stepId, "slot");
  assert.equal(reloaded.getState().values.slot, "19:30");
  assert.equal((await reloaded.next()).ok, true, "a restored in-progress wizard keeps moving");
});

// ── persistence hygiene ───────────────────────────────────────────────────────────────────────

test("every durable wizard operation establishes a session and keeps one row per key", async () => {
  const { deps, rows, sessions } = memoryDeps();
  const wizard = makeMachine(deps);
  await wizard.select("date", "d");
  await wizard.next();
  await wizard.select("slot", "s");
  await wizard.cancel();

  assert.equal(rows.length, 1, "repeated saves update one durable row rather than accumulating");
  assert.ok(sessions() > 0, "the persistence adapter establishes a session before touching entities");
  assert.equal(rows[0].data.key, "lifecycle-fixture");
  assert.equal(rows[0].data.state.status, WIZARD_STATUS.CANCELLED);
});

test("restore tolerates absent, corrupt and unknown-status durable records", async () => {
  const { deps } = memoryDeps();

  // Nothing saved yet.
  const fresh = makeMachine(deps);
  assert.equal((await fresh.restore()).status, WIZARD_STATUS.ACTIVE);

  // A record naming a step this wizard does not have is ignored rather than trusted.
  const persistence = makeWizardPersistence({ key: "lifecycle-fixture", deps });
  await persistence.save({ stepId: "nonexistent", stepIndex: 9, status: "active", values: { date: "x" } });
  const mismatched = makeMachine(deps);
  await mismatched.restore();
  assert.equal(mismatched.getState().stepId, "date", "an unknown step falls back to the start");

  // An unrecognised status resolves to ACTIVE rather than bricking the flow.
  await persistence.save({ stepId: "slot", stepIndex: 1, status: "not-a-real-status", values: { slot: "s" } });
  const oddStatus = makeMachine(deps);
  await oddStatus.restore();
  assert.equal(oddStatus.getState().status, WIZARD_STATUS.ACTIVE);
  assert.equal(oddStatus.getState().stepId, "slot");
});

// ── what generated code must do on mount ──────────────────────────────────────────────────────

test("the supported mount sequence: restore, then reset only when the flow is terminal", async () => {
  const { deps } = memoryDeps();
  const seeded = makeMachine(deps);
  await seeded.select("date", "d");
  await seeded.cancel();

  // The shape a generated app needs on mount if it wants a usable flow after a cancellation.
  const onMount = async (wizard) => {
    const state = await wizard.restore();
    if ([WIZARD_STATUS.CANCELLED, WIZARD_STATUS.CONFIRMED].includes(state.status)) return state; // show the terminal state
    return state;
  };

  const mounted = makeMachine(deps);
  const restored = await onMount(mounted);
  assert.equal(restored.status, WIZARD_STATUS.CANCELLED, "the terminal state is what the screen should render");

  // Starting over is an explicit action, never implicit — reset is the only way back.
  await mounted.reset();
  assert.equal(mounted.getState().status, WIZARD_STATUS.ACTIVE);
  await mounted.select("date", "again");
  assert.equal(mounted.getState().values.date, "again");
});
