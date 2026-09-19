import test from "node:test";
import assert from "node:assert/strict";

import { makeWizardMachine, WIZARD_STATUS } from "../../src/scaffolds/reactVite/lib/capabilities/wizard.js";
import {
  bindCapabilities, contractUsesExplicitTransientState, durablePersistenceJourneys,
} from "../../shell/server/lib/builderV2/contractTiering.mjs";

test("wizard navigation, validation, progress and confirmation are deterministic", async () => {
  const confirmed = [];
  const machine = makeWizardMachine({
    persistence: null,
    steps: ["service", "details", "confirm"],
    validate: ({ stepId, values }) => stepId === "service" && !values.service ? { service: "Choose a service" }
      : stepId === "details" && !values.email ? { email: "Email is required" } : {},
    onConfirm: async (values) => { confirmed.push(values); return { reference: "BK-TEST" }; },
  });
  assert.deepEqual(
    (({ stepId, step, currentStep, current }) => ({ stepId, step, currentStep, current }))(machine.getState()),
    { stepId: "service", step: "service", currentStep: "service", current: "service" },
  );
  assert.equal(machine.getState().progress, 1 / 3);
  assert.equal((await machine.next()).ok, false);
  assert.equal(machine.getState().status, WIZARD_STATUS.INVALID);
  await machine.select("service", "consultation");
  assert.equal((await machine.next()).ok, true);
  assert.equal(machine.getState().stepId, "details");
  assert.equal(machine.getState().step, "details", "generated step fallbacks must follow navigation");
  await machine.setValue("email", "user@example.test");
  await machine.next();
  const result = await machine.confirm();
  assert.equal(result.ok, true);
  assert.equal(result.state.status, WIZARD_STATUS.CONFIRMED);
  assert.equal(result.confirmation.reference, "BK-TEST");
  assert.deepEqual(confirmed[0], { service: "consultation", email: "user@example.test" });
});

test("wizard persistence restores state and cancellation is idempotent", async () => {
  let saved = null;
  let clears = 0;
  const persistence = {
    save: async (value) => { saved = value; }, load: async () => saved, clear: async () => { clears += 1; },
  };
  const first = makeWizardMachine({ steps: ["one", "two"], persistence });
  await first.setValue("choice", "A");
  await first.next();
  const resumed = makeWizardMachine({ steps: ["one", "two"], persistence });
  await resumed.restore();
  assert.equal(resumed.getState().stepId, "two");
  assert.equal(resumed.getState().values.choice, "A");
  const cancelled = await resumed.cancel();
  assert.equal(cancelled.status, WIZARD_STATUS.CANCELLED);
  assert.equal((await resumed.cancel()).status, WIZARD_STATUS.CANCELLED);
  assert.equal(clears, 0, "cancelled state remains durable until an explicit reset");
});

test("wizard controlled values emit before durable persistence settles", async () => {
  let releaseSave;
  let saveStarted;
  const started = new Promise((resolve) => { saveStarted = resolve; });
  const persistence = {
    async save() {
      saveStarted();
      await new Promise((resolve) => { releaseSave = resolve; });
    },
  };
  const machine = makeWizardMachine({ steps: ["details", "review"], persistence });
  const snapshots = [];
  machine.subscribe((snapshot) => snapshots.push(snapshot));

  const pending = machine.setValue("email", "user@example.test");
  await started;
  assert.equal(snapshots.at(-1).values.email, "user@example.test",
    "a controlled input must not revert while its durable write is in flight");
  releaseSave();
  await pending;
});

test("wizard snapshots obey React's external-store identity contract", async () => {
  const machine = makeWizardMachine({ steps: ["details", "review"], persistence: null });
  const initial = machine.getState();
  assert.strictEqual(machine.getState(), initial,
    "repeated getState reads must be identity-stable until the store emits");
  assert.equal(Object.isFrozen(initial), true);
  assert.equal(Object.isFrozen(initial.values), true, "cached nested state is immutable too");

  const emissions = [];
  machine.subscribe((value) => emissions.push(value));
  assert.strictEqual(emissions.at(-1), initial, "subscription and getState share one snapshot object");

  await machine.select("email", "user@example.test");
  const changed = machine.getState();
  assert.notStrictEqual(changed, initial, "a real state emission advances snapshot identity");
  assert.strictEqual(machine.getState(), changed, "the new identity remains stable after the emission");
  assert.strictEqual(emissions.at(-1), changed);
});

test("mount restore shares hydration and cannot overwrite a live selection", async () => {
  let releaseLoad;
  let loadStarted;
  let loadCalls = 0;
  const started = new Promise((resolve) => { loadStarted = resolve; });
  const persistence = {
    async load() {
      loadCalls += 1;
      loadStarted();
      await new Promise((resolve) => { releaseLoad = resolve; });
      return { stepId: "date", values: { slotId: "" }, status: WIZARD_STATUS.ACTIVE, revision: 0 };
    },
    async save() {},
  };
  const machine = makeWizardMachine({ steps: ["date", "slot"], persistence });
  machine.subscribe(() => {}); // useCapabilityState starts hydration
  await started;
  const mountRestore = machine.restore(); // generated useEffect(() => restore(), [])
  assert.equal(loadCalls, 1, "subscribe and generated restore share one durable read");

  await machine.select("slotId", "evening");
  releaseLoad();
  await mountRestore;
  assert.equal(machine.getState().values.slotId, "evening",
    "a stale mount load cannot revert the option the visitor selected while hydration was pending");
});

test("unawaited generated wizard calls persist in invocation order", async () => {
  let durable = null;
  const persistence = {
    async save(value) {
      if (value.revision === 1) await new Promise((resolve) => setTimeout(resolve, 30));
      durable = value;
    },
  };
  const machine = makeWizardMachine({ steps: ["date", "slot"], persistence });
  const first = machine.select("dateId", "friday");
  const second = machine.select("slotId", "late");
  const third = machine.next();
  await Promise.all([first, second, third]);
  assert.equal(durable.revision, machine.getState().revision);
  assert.equal(durable.values.dateId, "friday");
  assert.equal(durable.values.slotId, "late");
  assert.equal(durable.stepId, "slot");
});

test("reset is ordered after unawaited durable writes", async () => {
  let durable = null;
  const persistence = {
    async save(value) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      durable = value;
    },
    async clear() { durable = null; },
  };
  const machine = makeWizardMachine({ steps: ["date", "slot"], persistence });
  const selection = machine.select("dateId", "friday");
  const reset = machine.reset();
  await Promise.all([selection, reset]);
  assert.equal(durable, null, "a slow older save cannot resurrect state after reset clears it");
  assert.equal(machine.getState().values.dateId, undefined);
});

test("booking-only contracts bind booking without imposing a wizard", () => {
  const booking = bindCapabilities({
    entities: [{ name: "booking" }], journeys: [{ id: "book", title: "Book a visit",
      steps: [{ action: "submit booking", expect: "confirmed" }] }], routes: [], auth: {},
  });
  assert.ok(booking.some((binding) => binding.name === "booking"));
  assert.ok(!booking.some((binding) => binding.name === "wizard"));
});

test("explicitly transient simulated reservations do not acquire durable booking or wizard bindings", () => {
  const contract = {
    entities: [{
      name: "reservation", owned: false,
      storage: "client-only transient state for the simulated journey; not persisted to backend",
    }],
    operations: [{
      id: "complete-mock-entry", entity: "reservation", kind: "create", journey: "reserve-low-cost-entry",
      responsibilities: [{
        type: "functional", behavior: "produce a simulated confirmation",
        reads: ["competitionId", "ticketQuantity"], writes: ["confirmationId"],
      }],
    }],
    journeys: [{
      id: "reserve-low-cost-entry", title: "Reserve a simulated competition entry", steps: [
        { action: "choose a competition", expect: "the competition is selected" },
        { action: "enter a ticket quantity", expect: "the quantity is shown" },
        { action: "complete mock entry", expect: "a local confirmation is shown" },
      ],
    }],
    routes: [{ path: "/competitions", name: "Competitions" }], auth: {},
  };
  const bindings = bindCapabilities(contract);
  assert.equal(contractUsesExplicitTransientState(contract), true);
  assert.equal(bindings.some((binding) => binding.name === "booking"), false);
  assert.equal(bindings.some((binding) => binding.name === "wizard"), false);
  assert.deepEqual(durablePersistenceJourneys(contract), []);
});

test("true multi-step booking and explicit checkout bind the headless wizard", () => {
  const booking = bindCapabilities({
    entities: [{ name: "booking" }], journeys: [{ id: "book", title: "Booking flow", steps: [
      { action: "choose date", expect: "date selected" }, { action: "select slot", expect: "slot selected" },
      { action: "enter guest details", expect: "details saved" }, { action: "review", expect: "summary" },
      { action: "confirm", expect: "confirmation reference" },
    ] }], routes: [], auth: {},
  });
  assert.ok(booking.some((binding) => binding.name === "booking"));
  assert.ok(booking.some((binding) => binding.name === "wizard"));
  const checkout = bindCapabilities({
    entities: [], journeys: [{ id: "checkout", title: "Checkout" }], routes: [], auth: {},
  });
  assert.ok(checkout.some((binding) => binding.name === "wizard"));
});
