// The live-shaped fixture application for the Package 14S reproduction harness.
//
// This is NOT a simplification of the live build. Every observable choice below is FORCED by
// retained evidence from the 2026-08-10T09:07Z live qualification
// (test/code-agent/fixtures/live-booking-2026-08-10T0910Z.json), read back through the verifier
// that actually graded it (fixtures/live-journeyVerifier-b45a327.mjs):
//
//  1. Step 3 ("select a dinner date") returned a TEXT verdict — "found: selected, date, visually,
//     highlighted, slot (new: selected, visually, highlighted, slot)". driveSelection returns a
//     "selection created/moved" verdict when it matches a group, so a text verdict proves it
//     matched NO group. Its scorer reads the option container's innerText, therefore the date
//     options' TEXT must not contain "date"/"picker"/"dinner".
//  2. The same step nevertheless SELECTED a date (steps 4-5 then observe a selected date). The
//     generic click path locates by ACCESSIBLE NAME before prose, so the date option's accessible
//     name must contain "date" while its text does not — i.e. an aria-label, which is exactly what
//     useSemanticSelection emits.
//  3. "date" was found but NOT fresh at step 3, so the word was already visible somewhere outside
//     the option container. Hence the "Available dates" heading, which the group scorer does not
//     read (it only looks inside the container's own section/fieldset/[role=group]).
//  4. The captured option text — "Saturday 19 October\n10 seats remain\nselected date visually
//     highlighted" — is verbatim from the live driver. The app echoed the contract's expectation
//     prose inside the selected option; that echo is what later makes the DATE group outscore the
//     slot and party groups. Removing it would destroy the behaviour under test.
//  5. Contact inputs existed in the generated source (CompleteBookingFlow.jsx:259-261 in the
//     retained renderedControlFacts) yet were reported "could not drive" — they were VALUE-GATED
//     behind the party step, not absent.
//  6. "Review the booking" (:267) and "Confirm booking" (:269) were real rendered buttons. They
//     are wrapped individually here because two sibling buttons would themselves form a
//     selectable "group" for the scorer, which the live trace shows did not happen.
//
// Only real platform primitives are used: makeWizardMachine, useCapabilityState,
// useSemanticSelection, useSemanticField. No test ids, no verifier-friendly affordances, and no
// booking-specific logic in the platform.

/** In-memory wizard persistence, so the fixture needs no backend and no provider call. */
const PERSISTENCE = `let saved = null;
export const memoryPersistence = {
  async save(state) { saved = JSON.parse(JSON.stringify(state)); },
  async load() { return saved ? JSON.parse(JSON.stringify(saved)) : null; },
  async clear() { saved = null; },
};
`;

const DATA = `import { makeWizardMachine } from "../lib/capabilities/wizard.js";
import { memoryPersistence } from "./persistence.js";

export const DATES = [
  { value: "d-2026-10-18", label: "Friday 18 October", seats: 10 },
  { value: "d-2026-10-19", label: "Saturday 19 October", seats: 10 },
];
export const SLOTS = [
  { value: "s-1830", label: "18:30", seats: 6 },
  { value: "s-2015", label: "20:15", seats: 4 },
];
export const PARTY_SIZES = [2, 4, 6];

export const wizard = makeWizardMachine({
  id: "complete-booking",
  steps: ["date", "slot", "party", "contact", "review"],
  initialValues: { started: false, dateId: null, slotId: null, partySize: null,
    guestName: "", guestEmail: "", guestPhone: "" },
  persistence: memoryPersistence,
  validate: ({ stepId, values }) => {
    const errors = {};
    if (stepId === "date" && !values.dateId) errors.dateId = "pick a date";
    if (stepId === "slot" && !values.slotId) errors.slotId = "pick a slot";
    if (stepId === "party" && !values.partySize) errors.partySize = "pick a party size";
    if (stepId === "contact") {
      if (!values.guestName) errors.guestName = "name required";
      if (!values.guestEmail) errors.guestEmail = "email required";
      if (!values.guestPhone) errors.guestPhone = "phone required";
    }
    return errors;
  },
  onConfirm: async (values) => ({ reference: "EMB-" + String(values.dateId || "").slice(-4).toUpperCase() }),
});
`;

const SHARED_PIECES = `
function labelOf(rows, value) {
  const row = rows.find((r) => r.value === value);
  return row ? row.label : "";
}

function Home() {
  return <main>
    <h1>Ember Table</h1>
    <p>An editorial hero for a supper club. Ember Table is a monthly editorial supper club.</p>
    <div><button type="button" onClick={() => wizard.setValue("started", true)}>Book a seat</button></div>
  </main>;
}

function Confirmed({ state, values }) {
  const reference = state.confirmation ? state.confirmation.reference : "";
  return <main>
    <h1>Booking Confirmed</h1>
    <p>The same confirmation screen, restored. Status: Confirmed. Durable reference {reference}.</p>
    <p>{labelOf(DATES, values.dateId)} · {labelOf(SLOTS, values.slotId)} · party of {String(values.partySize)}</p>
    <p>{values.guestName} · {values.guestEmail} · {values.guestPhone}</p>
  </main>;
}
`;

// Value-gated composition — the live shape. Each group appears once the PREVIOUS contracted value
// exists; the selected option echoes the expectation prose exactly as the live build rendered it.
const VALUE_GATED_FLOW = `import { useCapabilityState, useSemanticSelection, useSemanticField } from "../lib/capabilities/react.js";
import { wizard, DATES, SLOTS, PARTY_SIZES } from "../data/booking.js";

export function BookingFlow() {
  const state = useCapabilityState(wizard);
  const values = state.values || {};

  const date = useSemanticSelection({ name: "dateId", value: values.dateId, onSelect: (v) => wizard.select("dateId", v) });
  const slot = useSemanticSelection({ name: "slotId", value: values.slotId, onSelect: (v) => wizard.select("slotId", v) });
  const party = useSemanticSelection({ name: "partySize", value: values.partySize, onSelect: (v) => wizard.select("partySize", v) });

  const guestName = useSemanticField({ name: "guestName", value: values.guestName, onChange: (v) => wizard.setValue("guestName", v) });
  const guestEmail = useSemanticField({ name: "guestEmail", type: "email", value: values.guestEmail, onChange: (v) => wizard.setValue("guestEmail", v) });
  const guestPhone = useSemanticField({ name: "guestPhone", type: "tel", value: values.guestPhone, onChange: (v) => wizard.setValue("guestPhone", v) });

  if (state.status === "confirmed") return <Confirmed state={state} values={values} />;
  if (!values.started) return <Home />;

  return <main>
    <h2>Choose your evening</h2>
    <p>Step 1 title: Choose your evening — a list of available seatings.</p>
    <h3>Available dates</h3>

    <div {...date.groupProps}>
      {DATES.map((d) => (
        <button key={d.value} {...date.optionProps(d.value, "Choose date " + d.label)}>
          <span style={{ display: "block" }}>{d.label}</span>
          <span style={{ display: "block" }}>{d.seats} seats remain</span>
          {values.dateId === d.value ? <span style={{ display: "block" }}>selected date visually highlighted</span> : null}
        </button>
      ))}
    </div>

    {values.dateId ? <>
      <p>The slot selection step becomes available.</p>
      <div {...slot.groupProps}>
        {SLOTS.map((s) => (
          <button key={s.value} {...slot.optionProps(s.value, "Choose slot " + s.label)}>
            <span style={{ display: "block" }}>{s.label}</span>
            <span style={{ display: "block" }}>{s.seats} remaining</span>
            {values.slotId === s.value ? <span style={{ display: "block" }}>highlighted</span> : null}
          </button>
        ))}
      </div>
    </> : null}

    {values.slotId ? <>
      <p>Party size controls are shown.</p>
      <div {...party.groupProps}>
        {PARTY_SIZES.map((n) => (
          <button key={n} {...party.optionProps(n, "Choose party size " + n)}>
            <span style={{ display: "block" }}>{n} guests</span>
            {values.partySize === n ? <span style={{ display: "block" }}>displayed</span> : null}
          </button>
        ))}
      </div>
    </> : null}

    {values.partySize ? <>
      <p>Contact details step.</p>
      <div><label {...guestName.labelProps} /><input {...guestName.inputProps} /></div>
      <div><label {...guestEmail.labelProps} /><input {...guestEmail.inputProps} /></div>
      <div><label {...guestPhone.labelProps} /><input {...guestPhone.inputProps} /></div>
    </> : null}

    {values.guestName && values.guestEmail && values.guestPhone ? <section>
      <h4>Review</h4>
      <p>The exact selection: {labelOf(DATES, values.dateId)} at slot time {labelOf(SLOTS, values.slotId)}, party size {String(values.partySize)}, {values.guestName}, {values.guestEmail}, {values.guestPhone}.</p>
    </section> : null}

    <div><button type="button" onClick={() => { wizard.goTo("review").catch(() => {}); }}>Review the booking</button></div>
    <div><button type="button" onClick={() => { wizard.confirm().catch(() => {}); }}>Confirm booking</button></div>
  </main>;
}
${SHARED_PIECES}`;

// Strictly step-gated composition — ONLY the current wizard step's controls exist in the DOM,
// with a real Continue that calls wizard.next(). Same primitives, same prose.
const STEP_GATED_FLOW = `import { useCapabilityState, useSemanticSelection, useSemanticField } from "../lib/capabilities/react.js";
import { wizard, DATES, SLOTS, PARTY_SIZES } from "../data/booking.js";

export function BookingFlow() {
  const state = useCapabilityState(wizard);
  const values = state.values || {};

  const date = useSemanticSelection({ name: "dateId", value: values.dateId, onSelect: (v) => wizard.select("dateId", v) });
  const slot = useSemanticSelection({ name: "slotId", value: values.slotId, onSelect: (v) => wizard.select("slotId", v) });
  const party = useSemanticSelection({ name: "partySize", value: values.partySize, onSelect: (v) => wizard.select("partySize", v) });

  const guestName = useSemanticField({ name: "guestName", value: values.guestName, onChange: (v) => wizard.setValue("guestName", v) });
  const guestEmail = useSemanticField({ name: "guestEmail", type: "email", value: values.guestEmail, onChange: (v) => wizard.setValue("guestEmail", v) });
  const guestPhone = useSemanticField({ name: "guestPhone", type: "tel", value: values.guestPhone, onChange: (v) => wizard.setValue("guestPhone", v) });

  if (state.status === "confirmed") return <Confirmed state={state} values={values} />;
  if (!values.started) return <Home />;

  return <main>
    <h2>Choose your evening</h2>
    <p>Step 1 title: Choose your evening — a list of available seatings.</p>

    {state.stepId === "date" ? <>
      <h3>Available dates</h3>
      <div {...date.groupProps}>
        {DATES.map((d) => (
          <button key={d.value} {...date.optionProps(d.value, "Choose date " + d.label)}>
            <span style={{ display: "block" }}>{d.label}</span>
            <span style={{ display: "block" }}>{d.seats} seats remain</span>
            {values.dateId === d.value ? <span style={{ display: "block" }}>selected date visually highlighted</span> : null}
          </button>
        ))}
      </div>
    </> : null}

    {state.stepId === "slot" ? <>
      <p>The slot selection step becomes available.</p>
      <div {...slot.groupProps}>
        {SLOTS.map((s) => (
          <button key={s.value} {...slot.optionProps(s.value, "Choose slot " + s.label)}>
            <span style={{ display: "block" }}>{s.label}</span>
            <span style={{ display: "block" }}>{s.seats} remaining</span>
            {values.slotId === s.value ? <span style={{ display: "block" }}>highlighted</span> : null}
          </button>
        ))}
      </div>
    </> : null}

    {state.stepId === "party" ? <>
      <p>Party size controls are shown.</p>
      <div {...party.groupProps}>
        {PARTY_SIZES.map((n) => (
          <button key={n} {...party.optionProps(n, "Choose party size " + n)}>
            <span style={{ display: "block" }}>{n} guests</span>
            {values.partySize === n ? <span style={{ display: "block" }}>displayed</span> : null}
          </button>
        ))}
      </div>
    </> : null}

    {state.stepId === "contact" ? <>
      <p>Contact details step.</p>
      <div><label {...guestName.labelProps} /><input {...guestName.inputProps} /></div>
      <div><label {...guestEmail.labelProps} /><input {...guestEmail.inputProps} /></div>
      <div><label {...guestPhone.labelProps} /><input {...guestPhone.inputProps} /></div>
    </> : null}

    {state.stepId === "review" ? <section>
      <h4>Review</h4>
      <p>The exact selection: {labelOf(DATES, values.dateId)} at slot time {labelOf(SLOTS, values.slotId)}, party size {String(values.partySize)}, {values.guestName}, {values.guestEmail}, {values.guestPhone}.</p>
      <div><button type="button" onClick={() => { wizard.confirm().catch(() => {}); }}>Confirm booking</button></div>
    </section> : null}

    <div><button type="button" onClick={() => { wizard.next(); }}>Continue</button></div>
  </main>;
}
${SHARED_PIECES}`;

const APP = `import { BookingFlow } from "./components/BookingFlow.jsx";
export default function App() { return <BookingFlow />; }
`;

/** @param {"value-gated"|"step-gated"} shape */
export function liveShapedBookingApp(shape) {
  return {
    "src/data/persistence.js": PERSISTENCE,
    "src/data/booking.js": DATA,
    "src/components/BookingFlow.jsx": shape === "step-gated" ? STEP_GATED_FLOW : VALUE_GATED_FLOW,
    "src/App.jsx": APP,
  };
}
