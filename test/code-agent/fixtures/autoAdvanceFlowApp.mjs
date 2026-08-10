// Auto-advancing selection fixtures — the shape the 2026-08-10T22:20Z paid qualification hit.
//
// The live generated app (proved by a zero-model DOM probe against its own preview, recorded in
// live-booking-2026-08-10T2220Z-run5.json) behaved like this:
//
//   BEFORE CLICK  3 × <button name="date Id" aria-pressed="false">
//   AFTER CLICK   0 date buttons — unmounted; 2 × <button name="slot Id"> for the chosen date
//
// The application satisfied its contracted expectation ("available slots for that date are
// displayed"). The verifier failed it anyway, because selectionTransition required the clicked
// option to still be mounted. These fixtures reproduce that, and the adversarial variants below
// exist so the fix cannot become "the DOM changed, therefore pass".
//
// Everything uses the real platform primitives: makeWizardMachine, useCapabilityState,
// useSemanticSelection, useSemanticField. No test ids, no verifier-specific affordances.

const PERSISTENCE = `let saved = null;
export const memoryPersistence = {
  async save(state) { saved = JSON.parse(JSON.stringify(state)); },
  async load() { return saved ? JSON.parse(JSON.stringify(saved)) : null; },
  async clear() { saved = null; },
};
`;

/**
 * @param {object} options
 * @param {string[]} options.steps            wizard step ids
 * @param {string} options.body               the flow component body
 * @param {string} [options.extra]            extra module source
 */
const dataModule = (steps, initialValues) => `import { makeWizardMachine } from "../lib/capabilities/wizard.js";
import { memoryPersistence } from "./persistence.js";

export const wizard = makeWizardMachine({
  id: "auto-advance-fixture",
  steps: ${JSON.stringify(steps)},
  initialValues: ${JSON.stringify(initialValues)},
  persistence: memoryPersistence,
  validate: () => ({}),
  onConfirm: async () => ({ reference: "REF-2210" }),
});
`;

// ── booking: date → slots for THAT date ───────────────────────────────────────────────────────

const BOOKING_DATA = `export const DATES = [
  { value: "d-18", label: "Friday, October 18", blurb: "Smoke, roots and ember-fired sauces" },
  { value: "d-19", label: "Saturday, October 19", blurb: "A shared-table harvest menu" },
  { value: "d-20", label: "Sunday, October 20", blurb: "Late supper with live-fire desserts" },
];
export const SLOTS = {
  "d-18": [{ value: "s-1830", label: "6:30 PM", seats: 8 }, { value: "s-2030", label: "8:30 PM", seats: 4 }],
  "d-19": [{ value: "s-1900", label: "7:00 PM", seats: 6 }],
  "d-20": [{ value: "s-2100", label: "9:00 PM", seats: 2 }],
};
`;

/**
 * @param {"auto-advance"|"unrelated-content"|"wrong-next-state"|"rerender-only"} variant
 */
const bookingFlow = (variant) => `import { useCapabilityState, useSemanticSelection, useSemanticField } from "../lib/capabilities/react.js";
import { wizard } from "../data/flow.js";
import { DATES, SLOTS } from "../data/catalogue.js";

export function Flow() {
  const state = useCapabilityState(wizard);
  const values = state.values || {};
  const date = useSemanticSelection({ name: "dateId", value: values.dateId,
    onSelect: async (v) => { await wizard.select("dateId", v); ${variant === "rerender-only" ? "" : "await wizard.next();"} } });
  const slot = useSemanticSelection({ name: "slotId", value: values.slotId,
    onSelect: (v) => wizard.select("slotId", v) });
  const partySize = useSemanticSelection({ name: "partySize", value: values.partySize,
    onSelect: (v) => wizard.select("partySize", v) });
  const guestName = useSemanticField({ name: "guestName", value: values.guestName, onChange: (v) => wizard.setValue("guestName", v) });
  const guestEmail = useSemanticField({ name: "guestEmail", type: "email", value: values.guestEmail, onChange: (v) => wizard.setValue("guestEmail", v) });
  const guestPhone = useSemanticField({ name: "guestPhone", type: "tel", value: values.guestPhone, onChange: (v) => wizard.setValue("guestPhone", v) });
  const dietaryNote = useSemanticField({ name: "dietaryNote", value: values.dietaryNote, onChange: (v) => wizard.setValue("dietaryNote", v) });
  const chosenDate = DATES.find((d) => d.value === values.dateId);
  const chosenSlot = (SLOTS[values.dateId] || []).find((s) => s.value === values.slotId);

  if (state.status === "confirmed") return <main>
    <h1>Booking Confirmed</h1>
    <p>Confirmation screen. Status: Confirmed. Durable booking reference {state.confirmation ? state.confirmation.reference : ""}.</p>
    <p>{chosenDate ? chosenDate.label : ""} · {chosenSlot ? chosenSlot.label : ""} · party of {String(values.partySize)}</p>
    <p>{values.guestName} · {values.guestEmail} · {values.guestPhone}</p>
  </main>;

  if (!values.started) return <main>
    <h1>Ember Table</h1>
    <p>The Ember Table editorial hero and supper club description.</p>
    <div><button type="button" onClick={() => wizard.setValue("started", true)}>Start booking</button></div>
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

${variant === "unrelated-content" ? `
    {state.stepId === "slot" ? <section>
      <h2>Newsletter</h2>
      <p>Thanks for your interest — our seasonal newsletter keeps you posted about future menus.</p>
    </section> : null}
` : variant === "wrong-next-state" ? `
    {state.stepId === "slot" ? <div {...partySize.groupProps}>
      <p>Available seats for that date are displayed with remaining seat counts.</p>
      {[2, 4, 6].map((n) => (
        <button key={n} {...partySize.optionProps(n, "party Size " + n)}>
          <span style={{ display: "block" }}>Party Size {n}</span>
        </button>
      ))}
    </div> : null}
` : `
    {state.stepId === "slot" ? <>
      <p>Available slots for {chosenDate ? chosenDate.label : ""} are displayed with remaining seat counts.</p>
      <div {...slot.groupProps}>
        {(SLOTS[values.dateId] || []).map((s) => (
          <button key={s.value} {...slot.optionProps(s.value, "slot Id " + s.label)}>
            <span style={{ display: "block" }}>Slot Id {s.label}</span>
            <span style={{ display: "block" }}>{s.seats} remaining seats</span>
          </button>
        ))}
      </div>
    </> : null}
`}

    {state.stepId === "party" ? <>
      <p>Party size controls.</p>
      <div {...partySize.groupProps}>
        {[2, 4, 6].map((n) => (
          <button key={n} {...partySize.optionProps(n, "party Size " + n)}>
            <span style={{ display: "block" }}>Party Size {n}</span>
          </button>
        ))}
      </div>
    </> : null}

    {state.stepId === "contact" ? <>
      <p>Contact details.</p>
      <div><label {...guestName.labelProps} /><input {...guestName.inputProps} /></div>
      <div><label {...guestEmail.labelProps} /><input {...guestEmail.inputProps} /></div>
      <div><label {...guestPhone.labelProps} /><input {...guestPhone.inputProps} /></div>
      <div><label {...dietaryNote.labelProps} /><input {...dietaryNote.inputProps} /></div>
    </> : null}

    {state.stepId === "review" ? <section>
      <h3>Review</h3>
      <p>The exact selected date {chosenDate ? chosenDate.label : ""}, slot time {chosenSlot ? chosenSlot.label : ""}, party size {String(values.partySize)}, guest name {values.guestName}, email {values.guestEmail}, phone {values.guestPhone} and note {values.dietaryNote} are visible before confirmation.</p>
      <div><button type="button" onClick={() => { wizard.confirm().catch(() => {}); }}>Confirm booking</button></div>
    </section> : null}

    <div><button type="button" onClick={() => { wizard.next(); }}>Continue</button></div>
  </main>;
}
`;

// ── non-booking domains, all auto-advancing ───────────────────────────────────────────────────

const CHECKOUT = `import { useCapabilityState, useSemanticSelection } from "../lib/capabilities/react.js";
import { wizard } from "../data/flow.js";

const SPEEDS = [{ value: "standard", label: "Standard" }, { value: "express", label: "Express" }];
const CARDS = [{ value: "visa", label: "Visa" }, { value: "amex", label: "Amex" }];

export function Flow() {
  const state = useCapabilityState(wizard);
  const values = state.values || {};
  const speed = useSemanticSelection({ name: "deliverySpeed", value: values.deliverySpeed,
    onSelect: async (v) => { await wizard.select("deliverySpeed", v); await wizard.next(); } });
  const card = useSemanticSelection({ name: "cardBrand", value: values.cardBrand,
    onSelect: (v) => wizard.select("cardBrand", v) });
  if (!values.started) return <main><h1>Northwind Supply</h1>
    <p>The storefront headline for a supply company.</p>
    <div><button type="button" onClick={() => wizard.setValue("started", true)}>Start checkout</button></div></main>;
  return <main>
    <p>Checkout: choose delivery, the shipping options are listed with a step title.</p>
    {state.stepId === "delivery" ? <div {...speed.groupProps}>
      {SPEEDS.map((s) => (<button key={s.value} {...speed.optionProps(s.value, "delivery Speed " + s.label)}>
        <span style={{ display: "block" }}>{s.label} delivery</span></button>))}
    </div> : null}
    {state.stepId === "card" ? <>
      <p>The payment step is shown for the selected delivery speed.</p>
      <div {...card.groupProps}>
        {CARDS.map((c) => (<button key={c.value} {...card.optionProps(c.value, "card Brand " + c.label)}>
          <span style={{ display: "block" }}>{c.label}</span></button>))}
      </div>
    </> : null}
    <div><button type="button" onClick={() => { wizard.next(); }}>Continue</button></div>
  </main>;
}
`;

const ONBOARDING = `import { useCapabilityState, useSemanticSelection, useSemanticField } from "../lib/capabilities/react.js";
import { wizard } from "../data/flow.js";

const TYPES = [{ value: "personal", label: "Personal" }, { value: "business", label: "Business" }];

export function Flow() {
  const state = useCapabilityState(wizard);
  const values = state.values || {};
  const accountType = useSemanticSelection({ name: "accountType", value: values.accountType,
    onSelect: async (v) => { await wizard.select("accountType", v); await wizard.next(); } });
  const workspaceName = useSemanticField({ name: "workspaceName", value: values.workspaceName,
    onChange: (v) => wizard.setValue("workspaceName", v) });
  if (!values.started) return <main><h1>Northwind Onboarding</h1>
    <p>The onboarding welcome headline for new members.</p>
    <div><button type="button" onClick={() => wizard.setValue("started", true)}>Start onboarding</button></div></main>;
  return <main>
    <p>Onboarding: choose an account type, the options are listed with a step title.</p>
    {state.stepId === "type" ? <div {...accountType.groupProps}>
      {TYPES.map((t) => (<button key={t.value} {...accountType.optionProps(t.value, "account Type " + t.label)}>
        <span style={{ display: "block" }}>{t.label} account</span></button>))}
    </div> : null}
    {state.stepId === "details" ? <>
      <p>The account details step is shown for the selected account type.</p>
      <div><label {...workspaceName.labelProps} /><input {...workspaceName.inputProps} /></div>
    </> : null}
    <div><button type="button" onClick={() => { wizard.next(); }}>Continue</button></div>
  </main>;
}
`;

const CRM = `import { useCapabilityState, useSemanticSelection } from "../lib/capabilities/react.js";
import { wizard } from "../data/flow.js";

const STAGES = [{ value: "lead", label: "Lead" }, { value: "qualified", label: "Qualified" }];
const OWNERS = [{ value: "amara", label: "Amara" }, { value: "ben", label: "Ben" }];

export function Flow() {
  const state = useCapabilityState(wizard);
  const values = state.values || {};
  const pipelineStage = useSemanticSelection({ name: "pipelineStage", value: values.pipelineStage,
    onSelect: async (v) => { await wizard.select("pipelineStage", v); await wizard.next(); } });
  const dealOwner = useSemanticSelection({ name: "dealOwner", value: values.dealOwner,
    onSelect: (v) => wizard.select("dealOwner", v) });
  if (!values.started) return <main><h1>Northwind CRM</h1>
    <p>The deal pipeline headline for the sales team.</p>
    <div><button type="button" onClick={() => wizard.setValue("started", true)}>Start deal</button></div></main>;
  return <main>
    <p>Deal setup: choose a pipeline stage, the stages are listed with a step title.</p>
    {state.stepId === "stage" ? <div {...pipelineStage.groupProps}>
      {STAGES.map((s) => (<button key={s.value} {...pipelineStage.optionProps(s.value, "pipeline Stage " + s.label)}>
        <span style={{ display: "block" }}>{s.label} stage</span></button>))}
    </div> : null}
    {state.stepId === "owner" ? <>
      <p>The deal owner configuration is shown for the selected pipeline stage.</p>
      <div {...dealOwner.groupProps}>
        {OWNERS.map((o) => (<button key={o.value} {...dealOwner.optionProps(o.value, "deal Owner " + o.label)}>
          <span style={{ display: "block" }}>{o.label}</span></button>))}
      </div>
    </> : null}
    <div><button type="button" onClick={() => { wizard.next(); }}>Continue</button></div>
  </main>;
}
`;

const APP = `import { Flow } from "./components/Flow.jsx";
export default function App() { return <Flow />; }
`;

const SHAPES = {
  // The live shape, and the three adversarial variants of it.
  "booking-auto-advance": { flow: bookingFlow("auto-advance"), catalogue: BOOKING_DATA,
    steps: ["date", "slot", "party", "contact", "review"],
    values: { started: false, dateId: null, slotId: null, partySize: null, guestName: "", guestEmail: "", guestPhone: "", dietaryNote: "" } },
  "booking-unrelated-content": { flow: bookingFlow("unrelated-content"), catalogue: BOOKING_DATA,
    steps: ["date", "slot", "party", "contact", "review"],
    values: { started: false, dateId: null, slotId: null, partySize: null, guestName: "", guestEmail: "", guestPhone: "", dietaryNote: "" } },
  "booking-wrong-next-state": { flow: bookingFlow("wrong-next-state"), catalogue: BOOKING_DATA,
    steps: ["date", "slot", "party", "contact", "review"],
    values: { started: false, dateId: null, slotId: null, partySize: null, guestName: "", guestEmail: "", guestPhone: "", dietaryNote: "" } },
  "booking-rerender-only": { flow: bookingFlow("rerender-only"), catalogue: BOOKING_DATA,
    steps: ["date", "slot", "party", "contact", "review"],
    values: { started: false, dateId: null, slotId: null, partySize: null, guestName: "", guestEmail: "", guestPhone: "", dietaryNote: "" } },
  "checkout-auto-advance": { flow: CHECKOUT, catalogue: "export const NONE = true;\n",
    steps: ["delivery", "card"], values: { started: false, deliverySpeed: null, cardBrand: null } },
  "onboarding-auto-advance": { flow: ONBOARDING, catalogue: "export const NONE = true;\n",
    steps: ["type", "details"], values: { started: false, accountType: null, workspaceName: "" } },
  "crm-auto-advance": { flow: CRM, catalogue: "export const NONE = true;\n",
    steps: ["stage", "owner"], values: { started: false, pipelineStage: null, dealOwner: null } },
};

export const AUTO_ADVANCE_SHAPES = Object.freeze(Object.keys(SHAPES));

export function autoAdvanceApp(shape) {
  const spec = SHAPES[shape];
  if (!spec) throw new Error(`unknown auto-advance shape ${shape}`);
  return {
    "src/data/persistence.js": PERSISTENCE,
    "src/data/flow.js": dataModule(spec.steps, spec.values),
    "src/data/catalogue.js": spec.catalogue,
    "src/components/Flow.jsx": spec.flow,
    "src/App.jsx": APP,
  };
}
