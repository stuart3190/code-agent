// A screen built to defeat prose-based targeting.
//
// Same contract, four hostile presentations, switched by `window.__PRESENTATION__`:
//
//   plain        labels a human would recognise
//   renamed      every visible label replaced with something else entirely
//   translated   every visible label in another language
//   reordered    the DOM order of the controls reversed, icon-only action buttons
//
// Every variant is the SAME application by machine identity, and the verifier must drive all four
// identically. It must also never confuse guestName with guestCount, leadName with leadCount, or
// orderCount with customerCount — six controls whose business names are one token apart and whose
// labels, in three of the four variants, say nothing useful at all.

const FLOW = `import { useState } from "react";
import { useSemanticField, useSemanticSelection, useSemanticAction } from "../lib/capabilities/react.js";

const PRESENTATION = (typeof window !== "undefined" && window.__PRESENTATION__) || "plain";

// The contracted fields, and what each variant calls them on screen.
const LABELS = {
  plain:      { guestName: "Guest name", guestCount: "Guest count", leadName: "Lead name",
                leadCount: "Lead count", orderCount: "Order count", customerCount: "Customer count",
                tier: "Tier", submit: "Save record" },
  renamed:    { guestName: "Field A", guestCount: "Field B", leadName: "Field C",
                leadCount: "Field D", orderCount: "Field E", customerCount: "Field F",
                tier: "Choice", submit: "Proceed" },
  translated: { guestName: "Nom du client", guestCount: "Nombre de clients", leadName: "Nom du prospect",
                leadCount: "Nombre de prospects", orderCount: "Nombre de commandes",
                customerCount: "Nombre de clients enregistrés", tier: "Niveau", submit: "Enregistrer" },
  reordered:  { guestName: "…", guestCount: "…", leadName: "…", leadCount: "…",
                orderCount: "…", customerCount: "…", tier: "…", submit: "✓" },
};
const label = (key) => (LABELS[PRESENTATION] || LABELS.plain)[key];

const TEXT_FIELDS = ["guestName", "leadName"];
const COUNT_FIELDS = ["guestCount", "leadCount", "orderCount", "customerCount"];
const TIERS = [{ value: "standard", label: "Standard" }, { value: "premium", label: "Premium" }];

export function Flow() {
  const [values, setValues] = useState(() => Object.fromEntries(
    [...TEXT_FIELDS, ...COUNT_FIELDS].map((name) => [name, ""])));
  const [tier, setTier] = useState(null);
  const [saved, setSaved] = useState(false);

  const set = (name) => (value) => setValues((current) => ({ ...current, [name]: value }));
  const fields = Object.fromEntries([...TEXT_FIELDS, ...COUNT_FIELDS].map((name) => [name,
    useSemanticField({ name, label: label(name), type: COUNT_FIELDS.includes(name) ? "number" : "text",
      value: values[name], onChange: set(name) })]));
  const tierGroup = useSemanticSelection({ name: "tier", label: label("tier"), value: tier, onSelect: setTier });
  const save = useSemanticAction({ name: "save record control", label: label("submit"),
    onActivate: () => setSaved(true) });

  const order = PRESENTATION === "reordered"
    ? [...COUNT_FIELDS].reverse().concat([...TEXT_FIELDS].reverse())
    : [...TEXT_FIELDS, ...COUNT_FIELDS];

  return <main>
    <h1>Record desk</h1>
    <p>The record desk headline and summary are shown.</p>

    <div {...tierGroup.groupProps}>
      {TIERS.map((option) => (
        <button key={option.value} {...tierGroup.optionProps(option.value, PRESENTATION === "plain"
          ? "tier " + option.label : label("tier") + " " + option.value)}>
          <span style={{ display: "block" }}>{PRESENTATION === "reordered" ? "◆" : label("tier")} {option.label}</span>
        </button>
      ))}
    </div>

    {order.map((name) => (
      <div key={name}>
        {/* "stripped": the same controls with NO machine identity and no meaningful label — the
            case where the platform must say it cannot find the control rather than guess. */}
        {PRESENTATION === "stripped"
          ? <input aria-label={"Field " + name.length} value={values[name]}
              onChange={(event) => set(name)(event.target.value)} />
          : <>
            <label {...fields[name].labelProps} />
            <input {...fields[name].inputProps} />
          </>}
      </div>
    ))}

    <div><button {...save.buttonProps}>{label("submit")}</button></div>
    {saved ? <p>The record is saved and the entered values remain visible.</p> : null}
    {TEXT_FIELDS.some((n) => values[n])
      ? <p>The entered values remain visible: {TEXT_FIELDS.map((n) => values[n]).join(" ")}</p> : null}
    {COUNT_FIELDS.some((n) => values[n])
      ? <p>The recorded counts are shown: {COUNT_FIELDS.map((n) => values[n]).join(" ")}</p> : null}
  </main>;
}
`;

const APP = `import { Flow } from "./components/Flow.jsx";
export default function App() { return <Flow />; }
`;

export function opaqueIdentityApp() {
  return { "src/components/Flow.jsx": FLOW, "src/App.jsx": APP };
}

export const IDENTITY_CONTRACT = {
  summary: "Record desk control identity", projectType: "web app", version: 1,
  auth: { required: false }, routes: [{ path: "/", name: "Records" }],
  entities: [{ name: "record", fields: [
    { name: "guestName", type: "string" }, { name: "guestCount", type: "number" },
    { name: "leadName", type: "string" }, { name: "leadCount", type: "number" },
    { name: "orderCount", type: "number" }, { name: "customerCount", type: "number" },
    { name: "tier", type: "string" }] }],
  operations: [],
  journeys: [
    { id: "identity", title: "Every contracted control is driven by machine identity", priority: "primary", steps: [
      { action: "open the record desk", target: "/", expect: "the record desk headline and summary are shown" },
      { action: "select a tier", target: "tier picker", expect: "the chosen tier is highlighted" },
      // One step naming every contracted control: the six business names are one token apart, so
      // this is the step where prose-based targeting would cross-match. Identity does not.
      { action: "enter the guest name, guest count, lead name, lead count, order count and customer count",
        target: "record form", expect: "the entered values remain visible and the recorded counts are shown" },
    ] },
  ],
  acceptance: [], states: [], deferred: [], imageIntents: [], integrations: [],
};
