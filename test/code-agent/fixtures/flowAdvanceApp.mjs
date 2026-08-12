// A PAGINATED FLOW WHOSE FORWARD BUTTON IS CALLED SOMETHING DIFFERENT EVERY TIME.
//
// The 2026-08-12 qualification built exactly this shape — pick a date, then a party size, then
// give a name — and labelled its forward button "Next to party size". Verification looked that
// label up in a list of English advance words, did not find it, and reported the party-size
// control missing. The control was fine. It was two screens away behind a button nobody could
// recognise.
//
// Eleven presentations, switched by `window.__PRESENTATION__`, all the same application by
// machine identity:
//
//   live          the exact paid label, "Next to party size"
//   next/continue the wordings the old list did happen to contain
//   arrow/icon    no words at all
//   french        no English at all
//   renamed       a word with no relationship to advancing
//   decoy         real control labelled "Bananas"; a DERAILING button labelled "Next" beside it
//   reordered     the forward control rendered before everything else, decoy after
//   wrongIdentity a forward button carrying a DIFFERENT machine action id
//   missing       no forward control at all
//
// The decoy is not a distraction, it is a trap: clicking it moves the app to a dead end it can
// never leave, so the party-size control never mounts again. A passing journey on that variant is
// itself proof the decoy was never clicked.

const FLOW = `import { useState } from "react";
import { useFlowAdvance, useSemanticAction, useSemanticField, useSemanticSelection }
  from "../lib/capabilities/react.js";

const PRESENTATION = (typeof window !== "undefined" && window.__PRESENTATION__) || "live";

// What each variant calls the control that moves the flow FORWARD. None of this reaches the
// verifier: it is the application's own copy, which is the entire point.
const ADVANCE_LABEL = {
  live: "Next to party size",
  next: "Next",
  continue: "Continue",
  arrow: "\\u2192",
  icon: "\\u25b8",
  french: "Passer \\u00e0 la taille du groupe",
  renamed: "Bananas",
  decoy: "Bananas",
  reordered: "Bananas",
  wrongIdentity: "Next to party size",
  missing: "Next to party size",
};

const DATES = ["2026-09-01", "2026-09-02"];
const SIZES = ["2", "4", "6"];

export function Flow() {
  const [screen, setScreen] = useState(0);
  const [derailed, setDerailed] = useState(false);
  const [dateId, setDateId] = useState(null);
  const [partySize, setPartySize] = useState(null);
  const [guestName, setGuestName] = useState("");
  const [reference, setReference] = useState(null);

  const dates = useSemanticSelection({ name: "dateId", label: "Date", value: dateId, onSelect: setDateId });
  const sizes = useSemanticSelection({ name: "partySize", label: "Party size", value: partySize, onSelect: setPartySize });
  const name = useSemanticField({ name: "guestName", label: "Guest name", value: guestName, onChange: setGuestName });

  const label = ADVANCE_LABEL[PRESENTATION] || ADVANCE_LABEL.live;
  const onward = () => setScreen((current) => current + 1);
  // The declared forward control. Every variant except the last two emits it.
  const advance = useFlowAdvance({ label, onActivate: onward });
  // A forward button that is NOT the declared advance control: right shape, right label, wrong
  // identity. Nothing may accept it as the transition.
  const impostor = useSemanticAction({ name: "step onward control", label, onActivate: onward });
  const commit = useSemanticAction({ name: "confirm booking control", label: "Confirm booking",
    onActivate: () => setReference("BK-" + (partySize || "") + "-" + guestName.length) });

  const forward = PRESENTATION === "missing" ? null
    : PRESENTATION === "wrongIdentity"
      ? <button {...impostor.buttonProps}>{label}</button>
      : <button {...advance.buttonProps}>{label}</button>;

  // Visible, plausible, and a dead end. If wording could steer navigation, this would win.
  const decoy = ["decoy", "reordered"].includes(PRESENTATION)
    ? <button type="button" onClick={() => setDerailed(true)}>Next</button>
    : null;

  if (derailed) {
    return <main>
      <h1>Nothing here</h1>
      <p>This page is a dead end and the booking flow cannot be resumed from it.</p>
    </main>;
  }

  return <main>
    <h1>Supper club</h1>
    <p>The supper club booking page is visible.</p>

    {PRESENTATION === "reordered" ? <div>{forward}</div> : null}

    {screen === 0 ? <section>
      <h2>Choose a date</h2>
      <div {...dates.groupProps}>
        {DATES.map((value) => (
          <button key={value} {...dates.optionProps(value, "Date " + value)}>{value}</button>
        ))}
      </div>
      {dateId ? <p>The selected date {dateId} is highlighted.</p> : null}
    </section> : null}

    {screen === 1 ? <section>
      <h2>How many people?</h2>
      <div {...sizes.groupProps}>
        {SIZES.map((value) => (
          <button key={value} {...sizes.optionProps(value, "Party size " + value)}>{value}</button>
        ))}
      </div>
      {partySize ? <p>The chosen party size {partySize} is displayed.</p> : null}
    </section> : null}

    {screen >= 2 ? <section>
      <h2>Who is coming?</h2>
      <label {...name.labelProps} />
      <input {...name.inputProps} />
      {guestName ? <p>The guest name {guestName} is shown for review.</p> : null}
      <button {...commit.buttonProps}>Confirm booking</button>
      {reference ? <p>The booking is confirmed with reference {reference}.</p> : null}
    </section> : null}

    {PRESENTATION === "reordered" ? null : <div>{forward}</div>}
    <div>{decoy}</div>
  </main>;
}
`;

const APP = `import { Flow } from "./components/Flow.jsx";
export default function App() { return <Flow />; }
`;

export function flowAdvanceApp() {
  return { "src/components/Flow.jsx": FLOW, "src/App.jsx": APP };
}

// The paid contract's shape: three value-writing steps, each on its own screen, and not one word
// about how to get between them. Reaching step two is the platform's job.
export const ADVANCE_CONTRACT = {
  summary: "Supper club booking", projectType: "booking", version: 1,
  auth: { required: false }, routes: [{ path: "/", name: "Booking" }],
  entities: [{ name: "booking", fields: [
    { name: "dateId", type: "string" }, { name: "partySize", type: "number" },
    { name: "guestName", type: "string" }] }],
  operations: [{ id: "create-booking", entity: "booking", kind: "create", journey: "book-a-seat" }],
  journeys: [
    { id: "book-a-seat", title: "A guest books a supper club seat", priority: "primary", steps: [
      { action: "open the booking page", target: "/", expect: "the supper club booking page is visible" },
      { action: "select an available date", target: "date picker", operates: ["dateId"],
        expect: "the selected date is highlighted" },
      // THE STEP THAT DIED LIVE. Two screens in, behind a button called something unhelpful.
      { action: "choose a party size that fits the slot", target: "party size control",
        operates: ["partySize"], reads: ["dateId"], primitive: "selection",
        expect: "the chosen party size is displayed" },
      { action: "enter the guest name", target: "guest form", operates: ["guestName"],
        expect: "the guest name is shown for review" },
      { action: "confirm the booking", target: "Confirm booking control",
        expect: "the booking is confirmed with reference" },
    ] },
  ],
  acceptance: [], states: [], deferred: [], imageIntents: [], integrations: [],
};
