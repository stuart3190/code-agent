// THE PAID FAILURE, REPRODUCED AS A FIXTURE.
//
// The 2026-08-11 live qualification passed five contracted steps and then reported the contact
// step undriveable. The application was not at fault. `semanticAliases("guestName")` included
// "party size", so the guest's name, email and phone all resolved to the one control on screen
// that answered to it: an `<input type="number">` for the party size. `valueFor` compounded it by
// matching `/guests?/` and generating "2" for the name.
//
// No offline fixture could catch that, because booking and checkout both render party size as
// BUTTONS — a selection, not a spinbutton — and the CRM has no count at all. Nothing in the suite
// had ever put a numeric count on the same screen as guest-prefixed contact fields.
//
// This one does, and then goes further: it renders three families of near-collision at once
// (guest/customer/attendee × name/count), so a field may only ever drive the control that bears
// its own name.

const DATA = `export const SLOTS = [
  { value: "1830", label: "6:30 PM" },
  { value: "2030", label: "8:30 PM" },
];
export const slotOf = (v) => SLOTS.find((s) => s.value === v) || null;
export const validEmail = (value) => /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(String(value || ""));
`;

// Every field is a plain, correctly-labelled control. If a contracted field lands on the wrong one
// the platform is wrong, not the page.
const FLOW = `import { useState } from "react";
import { useSemanticSelection } from "../lib/capabilities/react.js";
import { SLOTS, slotOf, validEmail } from "../data/booking.js";

const FIELDS = [
  { name: "guestName", label: "Guest name", type: "text" },
  { name: "guestEmail", label: "Guest email", type: "email" },
  { name: "guestPhone", label: "Guest phone", type: "tel" },
  { name: "guestCount", label: "Guest count", type: "number" },
  { name: "customerName", label: "Customer name", type: "text" },
  { name: "customerCount", label: "Customer count", type: "number" },
  { name: "attendeeName", label: "Attendee name", type: "text" },
  { name: "attendeeCount", label: "Attendee count", type: "number" },
];

export function Flow() {
  const [started, setStarted] = useState(false);
  const [slotId, setSlotId] = useState(null);
  const [partySize, setPartySize] = useState("");
  const [values, setValues] = useState(() => Object.fromEntries(FIELDS.map((f) => [f.name, ""])));
  const slot = useSemanticSelection({ name: "slotId", value: slotId, onSelect: setSlotId });
  const set = (name) => (event) => setValues({ ...values, [name]: event.target.value });
  const chosen = slotOf(slotId);
  const emailValid = validEmail(values.guestEmail);

  if (!started) return <main>
    <h1>Ember Table</h1>
    <p>The Ember Table supper club headline and booking summary are shown.</p>
    <div><button type="button" onClick={() => setStarted(true)}>Start booking</button></div>
  </main>;

  return <main>
    <p>Booking flow: the current step indicator and the available slots are shown.</p>

    <h3>Available slots</h3>
    <div {...slot.groupProps}>
      {SLOTS.map((s) => (
        <button key={s.value} {...slot.optionProps(s.value, "slot Id " + s.label)}>
          <span style={{ display: "block" }}>Slot Id {s.label}</span>
        </button>
      ))}
    </div>

    {/* The control that swallowed three contact fields in production. */}
    <h3>Party size</h3>
    <div>
      <label htmlFor="party-size-direct">Party size</label>
      <input id="party-size-direct" name="partySize" type="number" aria-label="Party size"
        value={partySize} onChange={(event) => setPartySize(event.target.value)} />
    </div>
    {partySize ? <p>The party size for {chosen ? chosen.label : "this slot"} is {partySize}.</p> : null}

    <h3>Contact details</h3>
    {FIELDS.map((field) => (
      <div key={field.name}>
        <label htmlFor={"field-" + field.name}>{field.label}</label>
        <input id={"field-" + field.name} name={field.name} type={field.type}
          aria-label={field.label} value={values[field.name]} onChange={set(field.name)} />
      </div>
    ))}
    {values.guestName || values.guestEmail || values.guestPhone
      ? <p>Each completed field remains visible: {values.guestName} · {values.guestEmail} · {values.guestPhone}</p>
      : null}
    {values.guestEmail && !emailValid
      ? <p role="alert">Email validation message: enter a valid guest email address.</p> : null}
    {values.guestCount || values.customerCount || values.attendeeCount
      ? <p>The recorded counts are {values.guestCount} guests, {values.customerCount} customers and {values.attendeeCount} attendees.</p>
      : null}
    {values.customerName || values.attendeeName
      ? <p>The recorded names are {values.customerName} and {values.attendeeName}.</p> : null}
  </main>;
}
`;

const APP = `import { Flow } from "./components/Flow.jsx";
export default function App() { return <Flow />; }
`;

export function controlCollisionApp() {
  return {
    "src/data/booking.js": DATA,
    "src/components/Flow.jsx": FLOW,
    "src/App.jsx": APP,
  };
}

/** The contract, authored as prose and derived by the production deriveBuildSpec. */
export const COLLISION_CONTRACT = {
  summary: "Ember Table control identity", projectType: "web app", version: 1,
  auth: { required: false }, routes: [{ path: "/", name: "Booking" }],
  // guestCount, customerName, customerCount, attendeeName and attendeeCount are deliberately NOT
  // contracted. They are rendered on the same screen as traps: no contracted field may touch them,
  // so any cross-match shows up as a value where there should be none.
  entities: [{ name: "booking", fields: [
    { name: "slotId", type: "string" }, { name: "partySize", type: "number" },
    { name: "guestName", type: "string" }, { name: "guestEmail", type: "string" },
    { name: "guestPhone", type: "string" }] }],
  operations: [],
  journeys: [
    { id: "identity", title: "Every contracted field drives its own control", priority: "primary", steps: [
      { action: "open the booking application", target: "/",
        expect: "the Ember Table supper club headline and booking summary are shown" },
      { action: "start the booking flow", target: "start booking control",
        expect: "the current step indicator and the available slots are shown" },
      { action: "select an available slot", target: "slot picker",
        expect: "the party size for that slot is shown" },
      // The exact step pairing that failed live: a numeric party size, then guest contact details.
      { action: "enter the party size", target: "party size field",
        expect: "the party size for this slot is shown" },
      { action: "enter valid guest name, email and phone details", target: "contact details form",
        expect: "each completed field remains visible without validation errors" },
    ] },
  ],
  acceptance: [], states: [], deferred: [], imageIntents: [], integrations: [],
};
