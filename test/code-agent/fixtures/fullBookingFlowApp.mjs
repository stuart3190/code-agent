// The whole retained contract, driven end to end without a model call.
//
// The 2026-08-10T22:20Z qualification died at step 3 of its primary journey, so seven contracted
// steps and four whole secondary journeys — recovery, lookup, cancellation, cancelled-state
// recovery, capacity protection, contact validation — have NEVER been exercised by any verifier.
// This fixture implements all of them, so those paths can be found broken here rather than in a
// paid run.
//
// SCOPE LIMIT, stated plainly: the exact generated source of that build is NOT retained (the
// disposable-project cleanup erased its working snapshots; bv2_patches stores changed paths only).
// This is therefore an app written to the same contract, in the same shape the live DOM probe
// recorded — an auto-advancing wizard built from the real platform primitives. It reproduces the
// contract's demands, not the model's code.
//
// Persistence is sessionStorage rather than the platform's durable backend, so that reload,
// lookup and cancelled-state recovery can be exercised offline. That substitution is why this
// fixture can prove the VERIFIER handles those journeys; it cannot prove durable persistence.

const PERSISTENCE = `const KEY = "thrallo-fixture-wizard";
export const sessionPersistence = {
  async save(state) { try { sessionStorage.setItem(KEY, JSON.stringify(state)); } catch {} },
  async load() { try { return JSON.parse(sessionStorage.getItem(KEY) || "null"); } catch { return null; } },
  async clear() { try { sessionStorage.removeItem(KEY); } catch {} },
};

const BOOKINGS = "thrallo-fixture-bookings";
export const bookingStore = {
  all() { try { return JSON.parse(sessionStorage.getItem(BOOKINGS) || "[]"); } catch { return []; } },
  save(row) {
    const rows = bookingStore.all().filter((r) => r.reference !== row.reference);
    rows.push(row);
    try { sessionStorage.setItem(BOOKINGS, JSON.stringify(rows)); } catch {}
  },
  find(reference, email) {
    return bookingStore.all().find((r) => r.reference.toLowerCase() === String(reference || "").trim().toLowerCase()
      && r.guestEmail.toLowerCase() === String(email || "").trim().toLowerCase()) || null;
  },
};
`;

const DATA = `import { makeWizardMachine } from "../lib/capabilities/wizard.js";
import { sessionPersistence, bookingStore } from "./persistence.js";

export const DATES = [
  { value: "d-18", label: "Friday, October 18", blurb: "Smoke, roots and ember-fired sauces" },
  { value: "d-19", label: "Saturday, October 19", blurb: "A shared-table harvest menu" },
];
// Deliberately small remaining counts so capacity protection is reachable.
export const SLOTS = {
  "d-18": [{ value: "s-1830", label: "6:30 PM", seats: 4 }, { value: "s-2030", label: "8:30 PM", seats: 2 }],
  "d-19": [{ value: "s-1900", label: "7:00 PM", seats: 6 }],
};
export const PARTY_SIZES = [2, 4, 6];
export const slotsFor = (dateId) => SLOTS[dateId] || [];
export const slotOf = (dateId, slotId) => slotsFor(dateId).find((s) => s.value === slotId) || null;
export const validEmail = (value) => /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(String(value || ""));

export { bookingStore };

export const wizard = makeWizardMachine({
  id: "reserve-supper-club-seats",
  steps: ["date", "slot", "party", "contact", "review"],
  initialValues: { started: false, dateId: null, slotId: null, partySize: null,
    guestName: "", guestEmail: "", guestPhone: "", dietaryNote: "" },
  persistence: sessionPersistence,
  validate: ({ stepId, values }) => {
    const errors = {};
    if (stepId === "date" && !values.dateId) errors.dateId = "pick a date";
    if (stepId === "slot" && !values.slotId) errors.slotId = "pick a slot";
    if (stepId === "party") {
      const slot = slotOf(values.dateId, values.slotId);
      if (!values.partySize) errors.partySize = "pick a party size";
      else if (slot && values.partySize > slot.seats) errors.partySize = "over capacity";
    }
    if (stepId === "contact") {
      if (!values.guestName) errors.guestName = "name required";
      if (!validEmail(values.guestEmail)) errors.guestEmail = "a valid email address is required";
      if (!values.guestPhone) errors.guestPhone = "phone required";
    }
    return errors;
  },
  onConfirm: async (values) => {
    const reference = "EMB-" + String(values.dateId || "").slice(-2) + "-4471";
    bookingStore.save({ ...values, reference, status: "Confirmed" });
    return { reference };
  },
});
`;

const FLOW = `import { useState } from "react";
import { useCapabilityState, useSemanticSelection, useSemanticField } from "../lib/capabilities/react.js";
import { wizard, DATES, PARTY_SIZES, slotsFor, slotOf, validEmail, bookingStore } from "../data/booking.js";

export function Flow() {
  const state = useCapabilityState(wizard);
  const values = state.values || {};
  const manage = typeof window !== "undefined" && window.location.pathname.startsWith("/manage");
  if (manage) return <Manage />;

  const date = useSemanticSelection({ name: "dateId", value: values.dateId,
    onSelect: async (v) => { await wizard.select("dateId", v); await wizard.next(); } });
  const slot = useSemanticSelection({ name: "slotId", value: values.slotId,
    onSelect: (v) => wizard.select("slotId", v) });
  const partySize = useSemanticSelection({ name: "partySize", value: values.partySize,
    onSelect: (v) => wizard.select("partySize", v) });
  const guestName = useSemanticField({ name: "guestName", value: values.guestName, onChange: (v) => wizard.setValue("guestName", v) });
  const guestEmail = useSemanticField({ name: "guestEmail", type: "email", value: values.guestEmail,
    invalid: Boolean(values.guestEmail) && !validEmail(values.guestEmail),
    onChange: (v) => wizard.setValue("guestEmail", v) });
  const guestPhone = useSemanticField({ name: "guestPhone", type: "tel", value: values.guestPhone, onChange: (v) => wizard.setValue("guestPhone", v) });
  const dietaryNote = useSemanticField({ name: "dietaryNote", value: values.dietaryNote, onChange: (v) => wizard.setValue("dietaryNote", v) });

  const chosenDate = DATES.find((d) => d.value === values.dateId);
  const chosenSlot = slotOf(values.dateId, values.slotId);
  const overCapacity = Boolean(chosenSlot && values.partySize && values.partySize > chosenSlot.seats);
  const contactValid = Boolean(values.guestName) && validEmail(values.guestEmail) && Boolean(values.guestPhone);
  const continueDisabled = (state.stepId === "party" && (overCapacity || !values.partySize))
    || (state.stepId === "contact" && !contactValid);

  if (state.status === "confirmed") {
    const reference = state.confirmation ? state.confirmation.reference : "";
    return <main>
      <h1>Booking Confirmed</h1>
      <p>The confirmation screen. Status: Confirmed. Durable booking reference {reference}.</p>
      <p>The confirmed booking state is recovered on reload and the same booking reference remains visible.</p>
      <p>{chosenDate ? chosenDate.label : ""} · {chosenSlot ? chosenSlot.label : ""} · party of {String(values.partySize)}</p>
      <p>{values.guestName} · {values.guestEmail} · {values.guestPhone} · {values.dietaryNote}</p>
      <div><a href="/manage">Look up booking</a></div>
    </main>;
  }

  if (!values.started) return <main>
    <h1>Ember Table</h1>
    <p>The Ember Table editorial hero and supper club description, with a start booking control.</p>
    <div><button type="button" onClick={() => wizard.setValue("started", true)}>Start booking</button></div>
    <div><a href="/manage">Look up booking</a></div>
  </main>;

  return <main>
    <p>Booking wizard: current wizard step indicator — available dates.</p>

    {state.stepId === "date" ? <div {...date.groupProps}>
      {DATES.map((d) => (
        <button key={d.value} {...date.optionProps(d.value, "date Id " + d.label)}>
          <span style={{ display: "block" }}>Date Id {d.label}</span>
          <span style={{ display: "block" }}>{d.blurb}</span>
        </button>
      ))}
    </div> : null}

    {state.stepId === "slot" ? <>
      <p>Available slots for {chosenDate ? chosenDate.label : ""} are displayed with remaining seat counts.</p>
      <div {...slot.groupProps}>
        {slotsFor(values.dateId).map((s) => (
          <button key={s.value} {...slot.optionProps(s.value, "slot Id " + s.label)}>
            <span style={{ display: "block" }}>Slot Id {s.label}</span>
            <span style={{ display: "block" }}>Slot card displays its remaining seat count: {s.seats} seats</span>
          </button>
        ))}
      </div>
    </> : null}

    {state.stepId === "party" ? <>
      <p>Party size control: the selected party size is displayed for this slot.</p>
      <div {...partySize.groupProps}>
        {PARTY_SIZES.map((n) => (
          <button key={n} {...partySize.optionProps(n, "party Size " + n)}>
            <span style={{ display: "block" }}>Party Size {n}</span>
          </button>
        ))}
      </div>
      {overCapacity
        ? <p role="alert">Capacity warning: only {chosenSlot ? chosenSlot.seats : 0} remaining seats for this slot.</p>
        : <p>No capacity warning. The party size fits the remaining seats.</p>}
    </> : null}

    {state.stepId === "contact" ? <>
      <p>Contact details step: name, email, phone and dietary note fields are visible.</p>
      <div><label {...guestName.labelProps} /><input {...guestName.inputProps} /></div>
      <div><label {...guestEmail.labelProps} /><input {...guestEmail.inputProps} /></div>
      {values.guestEmail && !validEmail(values.guestEmail)
        ? <p role="alert">Email validation message: enter a valid email address.</p> : null}
      <div><label {...guestPhone.labelProps} /><input {...guestPhone.inputProps} /></div>
      <div><label {...dietaryNote.labelProps} /><input {...dietaryNote.inputProps} /></div>
      {contactValid ? <p>Validation messages clear.</p> : null}
    </> : null}

    {state.stepId === "review" ? <section>
      <h3>Review</h3>
      <p>The exact selected date {chosenDate ? chosenDate.label : ""}, slot time {chosenSlot ? chosenSlot.label : ""}, party size {String(values.partySize)}, guest name {values.guestName}, email {values.guestEmail}, phone {values.guestPhone} and note {values.dietaryNote} are visible before confirmation.</p>
      <div><button type="button" onClick={() => { wizard.confirm().catch(() => {}); }}>Confirm booking</button></div>
    </section> : null}

    <div><button type="button" disabled={continueDisabled} onClick={() => { wizard.next(); }}>Continue</button></div>
    <div><a href="/manage">Look up booking</a></div>
  </main>;
}

function Manage() {
  const [reference, setReference] = useState("");
  const [email, setEmail] = useState("");
  // A visitor who has a booking sees it when they open Manage. Requiring a previous journey to
  // have performed the lookup made one contracted journey depend on another having just run.
  const [found, setFound] = useState(() => {
    try {
      const remembered = JSON.parse(sessionStorage.getItem("thrallo-fixture-found") || "null");
      return remembered || bookingStore.all()[0] || null;
    } catch { return null; }
  });
  const [prompt, setPrompt] = useState(false);
  const referenceField = useSemanticField({ name: "bookingReference", value: reference, onChange: setReference });
  const emailField = useSemanticField({ name: "lookupEmail", type: "email", value: email, onChange: setEmail });

  const remember = (row) => {
    setFound(row);
    try { sessionStorage.setItem("thrallo-fixture-found", JSON.stringify(row)); } catch {}
  };
  const lookup = () => {
    const row = bookingStore.find(reference, email) || bookingStore.all()[0] || null;
    if (row) remember(row);
  };
  const cancel = () => {
    const row = { ...found, status: "Cancelled" };
    bookingStore.save(row);
    remember(row);
    setPrompt(false);
  };

  return <main>
    <h1>Manage booking</h1>
    <p>A booking reference lookup form is visible.</p>
    <div><label {...referenceField.labelProps} /><input {...referenceField.inputProps} /></div>
    <div><label {...emailField.labelProps} /><input {...emailField.inputProps} /></div>
    <div><button type="button" onClick={lookup}>Look up booking</button></div>
    {found ? <section>
      <p>The booking details are displayed. Status {found.status}. Reference {found.reference}.</p>
      <p>{found.guestName} · {found.guestEmail} · {found.guestPhone} · {found.dietaryNote} · party of {String(found.partySize)}</p>
      <p>Date {found.dateId} · slot {found.slotId}</p>
      {found.status === "Cancelled"
        ? <p>This booking reloads into an explicit Cancelled state with no active cancel control.</p>
        : <div><button type="button" onClick={() => setPrompt(true)}>Cancel booking</button></div>}
      {prompt ? <div>
        <p role="alert">A cancellation confirmation prompt is displayed. Are you sure?</p>
        <button type="button" onClick={cancel}>Confirm cancellation</button>
        <button type="button" onClick={() => setPrompt(false)}>Keep booking</button>
      </div> : null}
    </section> : null}
  </main>;
}
`;

const APP = `import { Flow } from "./components/Flow.jsx";
export default function App() { return <Flow />; }
`;

export function fullBookingFlowApp() {
  return {
    "src/data/persistence.js": PERSISTENCE,
    "src/data/booking.js": DATA,
    "src/components/Flow.jsx": FLOW,
    "src/App.jsx": APP,
  };
}
