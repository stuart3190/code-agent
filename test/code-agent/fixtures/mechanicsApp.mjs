// CONTROLS THAT LOOK RIGHT AND HOLD NOTHING — and controls that look odd and work fine.
//
// Run #7 (2026-08-12) drove a booking four steps by machine identity and then stopped: guestName,
// guestEmail and guestPhone were present, visible, enabled and not read-only, and typing into them
// left them empty. The retained candidate was erased by the stand-down before the source could be
// recovered, so the exact JSX is RECONSTRUCTED here from the runtime evidence that survived:
//
//   input | guest Name  | id guestName | type text  | readOnly false | disabled false
//   fill "Journey 358502" → observed ""
//   matchedBy role=textbox name=guest Name          (no machine identity matched)
//
// Two shapes produce exactly that, and this fixture renders both rather than guessing between
// them: a controlled input whose setter never lands, and a controlled input with no handler at all.
//
// The second half of the fixture matters more. These are LEGITIMATE shapes that no diagnostic may
// condemn — an uncontrolled input with no onChange is perfectly driveable, and so is defaultValue,
// and so is a reducer-backed field, and so is a custom wrapper component. Requiring one React
// idiom would be a worse defect than the one being fixed.

const shared = `import { useReducer, useState } from "react";
import { useSemanticField, useSemanticSelection, useSemanticAction, useFlowAdvance }
  from "../lib/capabilities/react.js";

const MODE = (typeof window !== "undefined" && window.__MECHANICS__) || "broken";
const DATES = ["2026-09-01", "2026-09-02"];

// A custom wrapper: the platform cannot see through it statically, and it works.
function WrappedField({ id, label, value, onValue, type = "text" }) {
  return <label>
    {label}
    <input id={id} data-thrallo-control={id} aria-label={label} type={type}
      value={value} onChange={(event) => onValue(event.target.value)} />
  </label>;
}

const reducer = (state, action) => ({ ...state, [action.field]: action.value });
`;

const FLOW = `${shared}
export function Flow() {
  const [dateId, setDateId] = useState(null);
  const [draft, setDraft] = useState({ guestName: "", guestEmail: "", guestPhone: "" });
  const [store, dispatch] = useReducer(reducer, { reduced: "" });
  const [uncontrolled] = useState("");

  const dates = useSemanticSelection({ name: "dateId", label: "Date", value: dateId, onSelect: setDateId });
  const advance = useFlowAdvance({ label: "Continue", onActivate: () => {} });

  // ── THE RUN #7 SHAPES ────────────────────────────────────────────────────────────────────────
  // A. controlled, with a handler that writes to a DIFFERENT object than the one it renders from.
  //    Statically indistinguishable from a working field: value bound, onChange present.
  const brokenSetter = (field) => (event) => { draft[field] = event.target.value; };
  // B. controlled with no change transition at all — provable from structure alone.
  return <main>
    <h1>Supper club</h1>
    <p>The supper club booking page is visible.</p>

    <div {...dates.groupProps}>
      {DATES.map((value) => (
        <button key={value} {...dates.optionProps(value, "Date " + value)}>{value}</button>
      ))}
    </div>
    {dateId ? <p>The selected date {dateId} is highlighted.</p> : null}

    <section>
      <h2>Who is coming?</h2>
      {MODE === "broken" ? <>
        {/* A: a setter that mutates and never re-renders. */}
        <label htmlFor="guestName">Guest name</label>
        <input id="guestName" data-thrallo-control="\${ID.guestName}" type="text"
          value={draft.guestName} onChange={brokenSetter("guestName")} />
        {/* B: controlled with a fixed value and no handler — statically provable. */}
        <label htmlFor="guestEmail">Guest email</label>
        <input id="guestEmail" data-thrallo-control="\${ID.guestEmail}" type="email" value="" />
        {/* C: read-only, which is also statically provable. */}
        <label htmlFor="guestPhone">Guest phone</label>
        <input id="guestPhone" data-thrallo-control="\${ID.guestPhone}" type="tel"
          value={draft.guestPhone} readOnly />
      </> : <>
        {/* CORRECTED: the same three fields, wired so the value lands. */}
        <label htmlFor="guestName">Guest name</label>
        <input id="guestName" data-thrallo-control="\${ID.guestName}" type="text"
          value={draft.guestName}
          onChange={(event) => setDraft((current) => ({ ...current, guestName: event.target.value }))} />
        {/* defaultValue — uncontrolled by design, and driveable. */}
        <label htmlFor="guestEmail">Guest email</label>
        <input id="guestEmail" data-thrallo-control="\${ID.guestEmail}" type="email"
          defaultValue={uncontrolled} />
        {/* a custom wrapper the static scan cannot read through. */}
        <WrappedField id="\${ID.guestPhone}" label="Guest phone" type="tel"
          value={store.reduced} onValue={(value) => dispatch({ field: "reduced", value })} />
      </>}
      {draft.guestName ? <p>The guest name {draft.guestName} is shown for review.</p> : null}
    </section>

    <div><button {...advance.buttonProps}>Continue</button></div>
  </main>;
}
`;

const APP = `import { Flow } from "./components/Flow.jsx";
export default function App() { return <Flow />; }
`;

/**
 * The scaffold computes control identities from field names at runtime; the fixture needs the same
 * ids as literals because two of its inputs are deliberately hand-wired rather than bound through
 * the capability helper. They are injected, never hardcoded, so the fixture cannot drift from the
 * platform's own identity function.
 */
export function mechanicsApp(controlIdFor) {
  const ids = { guestName: controlIdFor("guestName"), guestEmail: controlIdFor("guestEmail"),
    guestPhone: controlIdFor("guestPhone") };
  const flow = FLOW.replace(/\$\{ID\.(\w+)\}/g, (_, key) => ids[key]);
  return { "src/components/Flow.jsx": flow, "src/App.jsx": APP };
}

export const MECHANICS_CONTRACT = {
  summary: "Supper club booking contact details", projectType: "booking", version: 1,
  auth: { required: false }, routes: [{ path: "/", name: "Booking" }],
  entities: [{ name: "booking", fields: [
    { name: "dateId", type: "string" }, { name: "guestName", type: "string" },
    { name: "guestEmail", type: "string" }, { name: "guestPhone", type: "string" }] }],
  operations: [],
  journeys: [{ id: "contact", title: "A guest gives contact details", priority: "primary", steps: [
    { action: "open the booking page", target: "/", expect: "the supper club booking page is visible" },
    { action: "select an available date", target: "date picker", operates: ["dateId"],
      expect: "the selected date is highlighted" },
    { action: "enter the guest name, email and phone", target: "contact form",
      operates: ["guestName", "guestEmail", "guestPhone"],
      expect: "the guest name is shown for review" },
  ] }],
  acceptance: [
    { id: "a1", statement: "the entered contact details remain visible on the page", kind: "render" },
    { id: "a2", statement: "the booking page renders its available dates", kind: "render" },
    { id: "a3", statement: "an invalid contact detail is rejected before submission", kind: "validation" }],
  states: [], deferred: [], imageIntents: [], integrations: [],
};
