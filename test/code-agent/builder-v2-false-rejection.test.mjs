// FALSE-REJECTION RATE — the metric Builder V2 never had.
//
// Four consecutive live qualifications died before compilation because the gate stack rejected
// implementation SHAPE. Nothing measured how often it rejected code that actually worked, so
// each live run bought exactly one linter bug at roughly 4.4 credits.
//
// This suite is that measurement. Every fixture below is a CORRECT implementation written in a
// form the platform did not happen to expect. The pass condition is absolute: zero blocking
// findings across all of them. A working application must never be rejected for its shape.

import test from "node:test";
import assert from "node:assert/strict";

import { deriveBuildSpec, scopeBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import { validateModuleConformance } from "../../shell/server/lib/builderV2/moduleContracts.mjs";
import { lintDurablePersistence } from "../../shell/server/lib/builderV2/persistenceLint.mjs";
import { partitionFindings } from "../../shell/server/lib/builderV2/validationSeverity.mjs";
import { durableOperationOwner } from "../../shell/server/lib/builderV2/interactionContract.mjs";
import { bindCapabilities } from "../../shell/server/lib/builderV2/contractTiering.mjs";
import { aggregateCapabilityFacts } from "../../shell/server/lib/builderV2/capabilityLint.mjs";

const BOOKING = {
  summary: "A multi-step booking workflow with review, durable recovery and cancellation",
  entities: [{ name: "booking", fields: [
    { name: "date", type: "string", required: true },
    { name: "slot", type: "string", required: true },
    { name: "partySize", type: "number", required: true },
    { name: "name", type: "string", required: true },
    { name: "email", type: "string", required: true },
  ] }],
  operations: [{ id: "create-booking", entity: "booking", action: "create" }],
  routes: [{ path: "/", name: "Booking" }], auth: { required: false },
  journeys: [{ id: "book", title: "Complete and manage a multi-step booking", priority: "primary", steps: [
    { action: "select a date", target: "date", expect: "selected date becomes active" },
    { action: "select a slot", target: "slot", expect: "selected slot becomes active" },
    { action: "enter name and email", target: "contact", expect: "contact values are accepted" },
    { action: "review the exact date slot name email", target: "review", expect: "review displays exact values" },
    { action: "confirm booking", target: "confirm booking", expect: "durable booking reference" },
    { action: "reload and look up the booking", target: "booking status", expect: "booking is restored" },
    { action: "cancel booking", target: "cancel booking", expect: "cancelled status survives reload" },
  ] }],
};

/** Run the complete pre-compile gate stack exactly as the orchestrator does. */
function gate(tree, contract = BOOKING) {
  const spec = scopeBuildSpec(deriveBuildSpec(contract), contract.journeys);
  const conformance = validateModuleConformance(tree, {
    contract: spec.contract, modulePlan: spec.modulePlan, moduleContracts: spec.moduleContracts,
    interactionContract: spec.interactionContract, bindings: spec.bindings,
  });
  const persistence = lintDurablePersistence(tree, {
    contract: spec.contract, journeys: contract.journeys, modulePlan: spec.modulePlan,
  });
  const persistenceVerdict = partitionFindings(persistence.findings || []);
  return {
    blocking: [...conformance.blocking, ...persistenceVerdict.blocking],
    advisory: [...conformance.advisory, ...persistenceVerdict.advisory],
  };
}

// ── the idiomatic forms that previously failed ────────────────────────────────────────────────

const IDIOMATIC = {
  "useSyncExternalStore with methods passed as references": {
    "src/data/wizard.js": `import { makeWizardMachine } from "../lib/capabilities";
export const wizard = makeWizardMachine({ id: "book", steps: ["date", "slot", "contact", "review", "confirm"] });`,
    "src/data/booking.js": `import { makeBookingSystem } from "../lib/capabilities";
export const bookings = makeBookingSystem({ entity: "booking" });`,
    "src/components/book/BookFlow.jsx": `import { useSyncExternalStore } from "react";
import { wizard } from "../../data/wizard.js";
import { bookings } from "../../data/booking.js";
export function BookFlow() {
  const state = useSyncExternalStore(wizard.subscribe, wizard.getState);
  return <main>
    <label htmlFor="date">Date</label>
    <input id="date" name="date" value={state.values.date || ""} onChange={(e) => wizard.select("date", e.target.value)} />
    <button onClick={() => wizard.restore()}>Restore</button>
    <button onClick={() => wizard.next()}>Next</button>
    <button onClick={async () => { const r = await bookings.createBooking(state.values); await wizard.confirm(r); }}>Confirm booking</button>
    <button onClick={async () => { await bookings.cancelBooking(state.confirmation.reference); await wizard.cancel(); }}>Cancel booking</button>
    <button onClick={() => bookings.getBooking(state.confirmation.reference)}>Look up booking</button>
  </main>;
}`,
  },

  "the platform React binding (useCapabilityState)": {
    "src/data/wizard.js": `import { makeWizardMachine } from "../lib/capabilities";
export const wizard = makeWizardMachine({ id: "book", steps: ["date", "slot", "review"] });`,
    "src/data/booking.js": `import { makeBookingSystem } from "../lib/capabilities";
export const bookings = makeBookingSystem({ entity: "booking" });`,
    "src/components/book/BookFlow.jsx": `import { useCapabilityState, useSemanticField } from "../../lib/capabilities";
import { wizard } from "../../data/wizard.js";
import { bookings } from "../../data/booking.js";
export function BookFlow() {
  const state = useCapabilityState(wizard);
  const date = useSemanticField({ name: "date", value: state.values.date, onChange: (v) => wizard.select("date", v) });
  return <main>
    <label {...date.labelProps} />
    <input {...date.inputProps} />
    <button onClick={() => { wizard.restore(); wizard.next(); }}>Next</button>
    <button onClick={async () => { const r = await bookings.createBooking(state.values); wizard.confirm(r); }}>Confirm</button>
    <button onClick={async () => { await bookings.cancelBooking("BK-1"); wizard.cancel(); }}>Cancel</button>
    <button onClick={() => bookings.getBooking("BK-1")}>Look up</button>
    <span>{String(wizard.subscribe && wizard.getState)}</span>
  </main>;
}`,
  },

  "destructured capability methods, exported and imported across modules": {
    "src/data/booking.js": `import { makeBookingSystem } from "../lib/capabilities";
export const { createBooking, cancelBooking, getBooking } = makeBookingSystem({ entity: "booking" });`,
    "src/data/wizard.js": `import { makeWizardMachine } from "../lib/capabilities";
const machine = makeWizardMachine({ id: "book", steps: ["date", "review"] });
export const { getState, subscribe, restore, select, next, confirm, cancel } = machine;`,
    "src/components/book/BookFlow.jsx": `import { getState, subscribe, restore, select, next, confirm, cancel } from "../../data/wizard.js";
import { createBooking, cancelBooking, getBooking } from "../../data/booking.js";
import { useSyncExternalStore } from "react";
export function BookFlow() {
  const state = useSyncExternalStore(subscribe, getState);
  return <main>
    <button onClick={() => { restore(); select("date", "2026-08-12"); next(); }}>Pick</button>
    <button onClick={async () => confirm(await createBooking(state.values))}>Confirm</button>
    <button onClick={async () => { await cancelBooking("BK-1"); cancel(); }}>Cancel</button>
    <button onClick={() => getBooking("BK-1")}>Find</button>
  </main>;
}`,
  },

  "a configuration object held in a variable": {
    "src/data/booking.js": `import { makeBookingSystem } from "../lib/capabilities";
const configuration = {
  entity: "booking",
  capacityPerSlot: 12,
  openingHours: { from: "09:00", to: "21:00" },
  notes: "configuration deliberately long enough to fall outside a proximity window",
};
export const bookings = makeBookingSystem(configuration);
export const { createBooking, cancelBooking, getBooking } = bookings;`,
    "src/data/wizard.js": `import { makeWizardMachine } from "../lib/capabilities";
const options = { id: "book", steps: ["date", "review", "confirm"], persistence: "platform" };
export const wizard = makeWizardMachine(options);`,
    "src/components/book/BookFlow.jsx": `import { wizard } from "../../data/wizard.js";
import { createBooking, cancelBooking, getBooking } from "../../data/booking.js";
export function BookFlow() {
  wizard.subscribe(() => {});
  const state = wizard.getState();
  return <main>
    <button onClick={() => { wizard.restore(); wizard.select("date", "x"); wizard.next(); }}>Pick</button>
    <button onClick={async () => wizard.confirm(await createBooking(state.values))}>Confirm</button>
    <button onClick={async () => { await cancelBooking("BK-1"); wizard.cancel(); }}>Cancel</button>
    <button onClick={() => getBooking("BK-1")}>Find</button>
  </main>;
}`,
  },

  "an adapter module that exports without ceremonially invoking every method": {
    "src/data/booking.js": `import { makeBookingSystem } from "../lib/capabilities";
export const bookings = makeBookingSystem({ entity: "booking" });`,
    "src/data/wizard.js": `import { makeWizardMachine } from "../lib/capabilities";
export const wizard = makeWizardMachine({ id: "book", steps: ["date", "review"] });`,
    "src/components/book/BookFlow.jsx": `import { wizard } from "../../data/wizard.js";
import { bookings } from "../../data/booking.js";
export function BookFlow() {
  wizard.subscribe(() => {});
  wizard.restore();
  const state = wizard.getState();
  return <main>
    <button onClick={() => { wizard.select("date", "x"); wizard.next(); }}>Pick</button>
    <button onClick={async () => wizard.confirm(await bookings.createBooking(state.values))}>Confirm</button>
    <button onClick={async () => { await bookings.cancelBooking("BK-1"); wizard.cancel(); }}>Cancel</button>
    <button onClick={() => bookings.getBooking("BK-1")}>Find</button>
  </main>;
}`,
  },

  "ordinary accessible React controls in one moderately sized route module": {
    "src/data/booking.js": `import { makeBookingSystem } from "../lib/capabilities";
export const bookings = makeBookingSystem({ entity: "booking" });`,
    "src/data/wizard.js": `import { makeWizardMachine } from "../lib/capabilities";
export const wizard = makeWizardMachine({ id: "book", steps: ["date", "review"] });`,
    "src/routes/BookingPage.jsx": `import { useState } from "react";
import { wizard } from "../data/wizard.js";
import { bookings } from "../data/booking.js";
${"// a realistic route module carries real content\n".repeat(60)}
export default function BookingPage() {
  const [draft, setDraft] = useState({ date: "", slot: "", name: "", email: "" });
  wizard.subscribe(() => {}); wizard.restore(); wizard.getState();
  return <main>
    <label htmlFor="name">Name</label>
    <input id="name" name="name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
    <label htmlFor="email">Email</label>
    <input id="email" type="email" name="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
    <button aria-pressed={Boolean(draft.date)} onClick={() => { setDraft({ ...draft, date: "2026-08-12" }); wizard.select("date", "2026-08-12"); wizard.next(); }}>Date</button>
    <p>{draft.date} {draft.slot} {draft.name} {draft.email}</p>
    <button onClick={async () => wizard.confirm(await bookings.createBooking(draft))}>Confirm booking</button>
    <button onClick={async () => { await bookings.cancelBooking("BK-1"); wizard.cancel(); }}>Cancel booking</button>
    <button onClick={() => bookings.getBooking("BK-1")}>Look up booking</button>
  </main>;
}`,
  },

  "an ephemeral subscriber registry inside a component module": {
    "src/data/booking.js": `import { makeBookingSystem } from "../lib/capabilities";
export const bookings = makeBookingSystem({ entity: "booking" });`,
    "src/data/wizard.js": `import { makeWizardMachine } from "../lib/capabilities";
export const wizard = makeWizardMachine({ id: "book", steps: ["date"] });`,
    "src/components/book/BookFlow.jsx": `import { wizard } from "../../data/wizard.js";
import { bookings } from "../../data/booking.js";
// Ephemeral in-memory fan-out for this browser tab. Not persistence: it holds no records.
const stateListeners = new Set();
export function onStateChange(listener) { stateListeners.add(listener); return () => stateListeners.delete(listener); }
export function BookFlow() {
  wizard.subscribe(() => stateListeners.forEach((fn) => fn()));
  wizard.restore(); wizard.getState();
  return <main>
    <button onClick={() => { wizard.select("date", "x"); wizard.next(); }}>Pick</button>
    <button onClick={async () => wizard.confirm(await bookings.createBooking({}))}>Confirm</button>
    <button onClick={async () => { await bookings.cancelBooking("BK-1"); wizard.cancel(); }}>Cancel</button>
    <button onClick={() => bookings.getBooking("BK-1")}>Find</button>
  </main>;
}`,
  },
};

test("FALSE-REJECTION RATE over known-working implementations is zero", () => {
  const rejected = [];
  for (const [name, tree] of Object.entries(IDIOMATIC)) {
    const verdict = gate(tree);
    if (verdict.blocking.length) {
      rejected.push({ name, blocking: verdict.blocking.map((f) => `${f.code}@${f.module || f.file}`) });
    }
  }
  const total = Object.keys(IDIOMATIC).length;
  const rate = rejected.length / total;
  assert.equal(rate, 0,
    `false-rejection rate ${rejected.length}/${total}: ${JSON.stringify(rejected, null, 2)}`);
});

test("useSyncExternalStore(store.subscribe, store.getState) counts as real capability usage", () => {
  const facts = aggregateCapabilityFacts({
    "src/app.jsx": `import { makeWizardMachine } from "./lib/capabilities";
const wizard = makeWizardMachine({ id: "w", steps: ["a"] });
export default function App() { return useSyncExternalStore(wizard.subscribe, wizard.getState); }`,
  }, []).get("makeWizardMachine");

  assert.ok(facts.bound.has("subscribe"), "the method is bound");
  assert.ok(facts.bound.has("getState"), "the method is bound");
  assert.ok(facts.referenced.has("subscribe"), "passing it to a consumer is a reference");
  assert.ok(facts.used.has("subscribe"), "a reference IS use");
  assert.ok(facts.used.has("getState"), "a reference IS use");
  assert.equal(facts.invoked.has("subscribe"), false, "it is genuinely not called here, and that is fine");
});

test("the destructured form of the same idiom also counts as usage", () => {
  const facts = aggregateCapabilityFacts({
    "src/app.jsx": `import { makeWizardMachine } from "./lib/capabilities";
const wizard = makeWizardMachine({ id: "w", steps: ["a"] });
const { subscribe, getState } = wizard;
export default function App() { return useSyncExternalStore(subscribe, getState); }`,
  }, []).get("makeWizardMachine");
  assert.ok(facts.used.has("subscribe"));
  assert.ok(facts.used.has("getState"));
});

test("genuinely unreachable capability methods are still observed — as advice", () => {
  const facts = aggregateCapabilityFacts({
    "src/app.jsx": `import { makeWizardMachine } from "./lib/capabilities";
const wizard = makeWizardMachine({ id: "w", steps: ["a"] });
const { subscribe } = wizard;
export default function App() { return null; }`,
  }, []).get("makeWizardMachine");
  assert.ok(facts.bound.has("subscribe"), "it is bound");
  assert.equal(facts.used.has("subscribe"), false, "but never reached");
});

// ── the generic cancellation bug ──────────────────────────────────────────────────────────────

const CRM = {
  summary: "A CRM for tracking customer subscriptions",
  entities: [{ name: "subscription", fields: [{ name: "plan" }, { name: "customerEmail" }] }],
  operations: [{ id: "cancel-subscription", entity: "subscription", action: "update" }],
  routes: [{ path: "/", name: "Subscriptions" }], auth: { required: false },
  journeys: [{ id: "manage-subscription", title: "Manage a subscription", priority: "primary", steps: [
    { action: "select a plan", target: "plan", expect: "selected plan becomes active" },
    { action: "enter the customer email", target: "customerEmail", expect: "email accepted" },
    { action: "review the subscription", target: "review", expect: "review shows the plan" },
    { action: "create the subscription", target: "create", expect: "subscription reference shown" },
    { action: "cancel the subscription", target: "cancel subscription", expect: "status shows cancelled" },
  ] }],
};

test("\"cancel the subscription\" does NOT require the booking capability", () => {
  const bindings = bindCapabilities(CRM);
  assert.equal(bindings.some((binding) => binding.name === "booking"), false,
    "a CRM contract must never bind a booking capability");

  const owner = durableOperationOwner(bindings);
  assert.equal(owner.factory, "makeEntityStore",
    "cancellation resolves to the contract's own durable owner");
  assert.deepEqual(owner.methods, ["update", "remove"]);

  const tree = {
    "src/data/crud.js": `import { makeEntityStore } from "../lib/capabilities";
export const subscriptions = makeEntityStore("subscription");`,
    "src/components/manage-subscription/ManageSubscriptionFlow.jsx": `import { subscriptions } from "../../data/crud.js";
export function ManageSubscriptionFlow() {
  return <main>
    <label htmlFor="plan">Plan</label>
    <input id="plan" name="plan" value="" onChange={() => {}} />
    <label htmlFor="customerEmail">Customer email</label>
    <input id="customerEmail" type="email" name="customerEmail" value="" onChange={() => {}} />
    <button onClick={() => subscriptions.create({})}>Create subscription</button>
    <button onClick={() => subscriptions.update("s-1", { status: "cancelled" })}>Cancel subscription</button>
  </main>;
}`,
  };
  const verdict = gate(tree, CRM);
  assert.equal(verdict.blocking.length, 0, JSON.stringify(verdict.blocking, null, 2));
  assert.equal(verdict.advisory.some((f) => f.code === "durable_cancellation_missing"), false,
    "durable cancellation is satisfied by the contract's OWN capability");
  assert.equal(JSON.stringify(verdict).includes("makeBookingSystem"), false,
    "no booking factory may appear anywhere in a CRM verdict");
});

test("cancellation across arbitrary domains resolves to each contract's own owner", () => {
  const domains = [
    { name: "order", verb: "cancel the order", entity: "order" },
    { name: "invitation", verb: "cancel the invitation", entity: "invitation" },
    { name: "shipment", verb: "cancel the shipment", entity: "shipment" },
  ];
  for (const domain of domains) {
    const contract = {
      ...CRM,
      summary: `A ${domain.name} system`,
      entities: [{ name: domain.entity, fields: [{ name: "reference" }] }],
      journeys: [{ ...CRM.journeys[0], steps: [
        ...CRM.journeys[0].steps.slice(0, 4),
        { action: domain.verb, target: domain.verb, expect: "status shows cancelled" },
      ] }],
    };
    const owner = durableOperationOwner(bindCapabilities(contract));
    assert.equal(owner.factory, "makeEntityStore", `${domain.name} must not resolve to a booking capability`);
  }
});

test("a booking contract still resolves cancellation to its booking capability", () => {
  const owner = durableOperationOwner(bindCapabilities(BOOKING));
  assert.equal(owner.factory, "makeBookingSystem");
  assert.deepEqual(owner.methods, ["cancelBooking"]);
});
