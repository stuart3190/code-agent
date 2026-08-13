import test from "node:test";
import assert from "node:assert/strict";

import { makeWizardMachine, WIZARD_STATUS } from "../../src/scaffolds/reactVite/lib/capabilities/wizard.js";
import { bindCapabilities } from "../../shell/server/lib/builderV2/contractTiering.mjs";

test("wizard navigation, validation, progress and confirmation are deterministic", async () => {
  const confirmed = [];
  const machine = makeWizardMachine({
    persistence: null,
    steps: ["service", "details", "confirm"],
    validate: ({ stepId, values }) => stepId === "service" && !values.service ? { service: "Choose a service" }
      : stepId === "details" && !values.email ? { email: "Email is required" } : {},
    onConfirm: async (values) => { confirmed.push(values); return { reference: "BK-TEST" }; },
  });
  assert.equal(machine.getState().progress, 1 / 3);
  assert.equal((await machine.next()).ok, false);
  assert.equal(machine.getState().status, WIZARD_STATUS.INVALID);
  await machine.select("service", "consultation");
  assert.equal((await machine.next()).ok, true);
  assert.equal(machine.getState().stepId, "details");
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

test("booking-only contracts bind booking without imposing a wizard", () => {
  const booking = bindCapabilities({
    entities: [{ name: "booking" }], journeys: [{ id: "book", title: "Book a visit",
      steps: [{ action: "submit booking", expect: "confirmed" }] }], routes: [], auth: {},
  });
  assert.ok(booking.some((binding) => binding.name === "booking"));
  assert.ok(!booking.some((binding) => binding.name === "wizard"));
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
