// DELIBERATELY BROKEN APPLICATIONS — the false-pass matrix.
//
// Every other fixture asks "can the platform drive a correct application?". This one asks the
// question that actually protects a paid run: "can a BROKEN application be graded green?". Each
// variant below breaks exactly one thing and must be caught for that reason — not for a second,
// accidental reason, which is why they share one compiled bundle and differ only by an injected
// `window.__DEFECT__`. Identical code, one lie each.
//
// The contract is the CRM contract, unchanged (see crmScenarioApp.mjs). Reusing it is deliberate:
// no new positive domain is being introduced here, and the create → recover → UPDATE → archive
// lifecycle is the one whose driving code changed most recently (df921a4).
//
// The "none" variant is the control: identical structure, no lie, and it must stay green — an
// adversarial matrix where the honest app also fails proves nothing at all.

const PERSISTENCE = `const KEY = "thrallo-adv-capture";
export const sessionPersistence = {
  async save(state) { try { sessionStorage.setItem(KEY, JSON.stringify(state)); } catch {} },
  async load() { try { return JSON.parse(sessionStorage.getItem(KEY) || "null"); } catch { return null; } },
  async clear() { try { sessionStorage.removeItem(KEY); } catch {} },
};

const LEADS = "thrallo-adv-leads";
export const leadStore = {
  all() { try { return JSON.parse(sessionStorage.getItem(LEADS) || "[]"); } catch { return []; } },
  save(row) {
    const rows = leadStore.all().filter((r) => r.reference !== row.reference);
    rows.push(row);
    try { sessionStorage.setItem(LEADS, JSON.stringify(rows)); } catch {}
    return row;
  },
  find(reference) {
    const wanted = String(reference || "").trim().toLowerCase();
    return leadStore.all().find((r) => r.reference.toLowerCase() === wanted) || null;
  },
};
`;

const DATA = `import { makeWizardMachine } from "../lib/capabilities/wizard.js";
import { sessionPersistence, leadStore } from "./persistence.js";

export const DEFECT = (typeof window !== "undefined" && window.__DEFECT__) || "none";

export const SOURCES = [
  { value: "referral", label: "Referral" },
  { value: "webinar", label: "Webinar" },
];
export const PRIORITIES = [
  { value: "standard", label: "Standard" },
  { value: "urgent", label: "Urgent" },
];
export const sourceOf = (v) => SOURCES.find((s) => s.value === v) || null;
export const priorityOf = (v) => PRIORITIES.find((p) => p.value === v) || null;
export const validEmail = (value) => /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(String(value || ""));

export { leadStore };

export const wizard = makeWizardMachine({
  id: "capture-lead",
  steps: ["source", "priority", "contact", "review"],
  initialValues: { started: false, source: null, priority: null, contactName: "", contactEmail: "", notes: "" },
  persistence: sessionPersistence,
  validate: ({ stepId, values }) => {
    // DEFECT accepts-invalid: the app still COMPLAINS about a bad address (the message renders),
    // it simply does not enforce anything. Passing this on the message alone is the exact false
    // green the blocked-progression proof exists to stop.
    if (DEFECT === "accepts-invalid") return {};
    const errors = {};
    if (stepId === "source" && !values.source) errors.source = "required";
    if (stepId === "priority" && !values.priority) errors.priority = "required";
    if (stepId === "contact" && !validEmail(values.contactEmail)) errors.contactEmail = "a valid email is required";
    return errors;
  },
  onConfirm: async (values) => {
    const reference = "LEAD-" + String(values.source || "").slice(0, 3).toUpperCase() + "-4417";
    leadStore.save({ ...values, reference, status: "New" });
    return { reference };
  },
});
`;

const FLOW = `import { useState } from "react";
import { useCapabilityState, useFlowAdvance, useSemanticSelection, useSemanticField } from "../lib/capabilities/react.js";
import { wizard, SOURCES, PRIORITIES, sourceOf, priorityOf, validEmail, leadStore, DEFECT } from "../data/crm.js";

const sourceText = (value) => "Source " + (sourceOf(value) ? sourceOf(value).label : "");
const priorityText = (value) => "Priority " + (priorityOf(value) ? priorityOf(value).label : "");

export function Flow() {
  const state = useCapabilityState(wizard);
  const values = state.values || {};
  const manage = typeof window !== "undefined" && window.location.pathname.startsWith("/manage");
  if (manage) return <Manage />;

  const [cosmetic, setCosmetic] = useState(0);
  const source = useSemanticSelection({ name: "source", value: values.source,
    onSelect: async (v) => { await wizard.select("source", v); await wizard.next(); } });
  const priority = useSemanticSelection({ name: "priority", value: values.priority,
    onSelect: (v) => wizard.select("priority", v) });
  const contactName = useSemanticField({ name: "contactName", value: values.contactName,
    onChange: (v) => wizard.setValue("contactName", v) });
  const contactEmail = useSemanticField({ name: "contactEmail", type: "email", value: values.contactEmail,
    invalid: Boolean(values.contactEmail) && !validEmail(values.contactEmail),
    onChange: (v) => wizard.setValue("contactEmail", v) });
  const notes = useSemanticField({ name: "notes", value: values.notes,
    onChange: (v) => wizard.setValue("notes", v) });

  const emailValid = validEmail(values.contactEmail);
  // DEFECT accepts-invalid: never disabled, and (see validate) advancing is not blocked either.
  const continueDisabled = DEFECT === "accepts-invalid"
    ? false : state.stepId === "contact" && !emailValid;
  const advance = useFlowAdvance({ label: "Continue", disabled: continueDisabled,
    onActivate: () => { if (DEFECT === "dom-only-advance") setCosmetic(cosmetic + 1); else wizard.next(); } });
  const anyContact = Boolean(values.contactName || values.contactEmail || values.notes);

  // DEFECT server-terminal: the flow is restored from state the SERVER holds, so every visitor —
  // including a brand-new one — lands in the finished state. Nothing a fresh browser context can
  // do will reach the capture steps.
  if (state.status === "confirmed" || DEFECT === "server-terminal") {
    const reference = state.confirmation ? state.confirmation.reference : "LEAD-REF-4417";
    return <main>
      <h1>Lead Saved</h1>
      <p>The saved lead screen. Status: New. Durable lead reference {reference}.</p>
      <p>The saved lead state is recovered on reload and the same lead reference remains visible.</p>
      <p>{sourceText(values.source)} · {priorityText(values.priority)}</p>
      <p>{values.contactName} · {values.contactEmail} · {values.notes}</p>
      <div><a href="/manage">Open lead records</a></div>
    </main>;
  }

  if (!values.started) return <main>
    <h1>Harbrook Advisory</h1>
    <p>The Harbrook Advisory lead desk headline and pipeline summary, with a lead capture control.</p>
    <div><button type="button" onClick={() => wizard.setValue("started", true)}>Start lead capture</button></div>
    <div><a href="/manage">Open lead records</a></div>
  </main>;

  return <main>
    <p>Lead capture: the current capture step indicator — lead source options.</p>

    {state.stepId === "source" ? <>
      <h3>Lead sources</h3>
      <div {...source.groupProps}>
        {SOURCES.map((s) => (
          <button key={s.value} {...source.optionProps(s.value, "source " + s.label)}>
            <span style={{ display: "block" }}>Source {s.label}</span>
          </button>
        ))}
      </div>
    </> : null}

    {state.stepId === "priority" ? <>
      <p>The priority options for that source are shown.</p>
      {DEFECT === "decoy-only"
        // A group that READS like the contracted one and announces nothing a driver can identify:
        // no accessible name, no selected state. Prose is not identity.
        ? <div>
          <p>The selected priority is highlighted in the priority options for that source.</p>
          {PRIORITIES.map((p) => (
            <button key={p.value} type="button" onClick={() => {}}>
              <span style={{ display: "block" }}>Option {p.label}</span>
            </button>
          ))}
        </div>
        : <div {...priority.groupProps}>
          {PRIORITIES.map((p) => (
            <button key={p.value} {...priority.optionProps(p.value, "priority " + p.label)}>
              <span style={{ display: "block" }}>Priority {p.label}</span>
              {values.priority === p.value ? <span style={{ display: "block" }}>selected priority highlighted</span> : null}
            </button>
          ))}
        </div>}
    </> : null}

    {state.stepId === "contact" ? <>
      <p>Contact step: the contact fields are shown.</p>
      <div><label {...contactName.labelProps} /><input {...contactName.inputProps} /></div>
      <div><label {...contactEmail.labelProps} /><input {...contactEmail.inputProps} /></div>
      <div><label {...notes.labelProps} /><input {...notes.inputProps} /></div>
      {anyContact ? <p>The entered contact name, email and notes are visible: {values.contactName} · {values.contactEmail} · {values.notes}</p> : null}
      {values.contactEmail && !emailValid
        ? <p role="alert">Email validation message: enter a valid contact email address.</p> : null}
      {emailValid ? <p>Validation messages clear.</p> : null}
    </> : null}

    {state.stepId === "review" ? <section>
      <h3>Review</h3>
      <p>The exact selected {sourceText(values.source)}, {priorityText(values.priority)}, contact name {values.contactName}, email {values.contactEmail} and notes {values.notes} are visible before saving.</p>
      <div><button type="button" onClick={() => { wizard.confirm().catch(() => {}); }}>Confirm lead</button></div>
    </section> : null}

    {/* DEFECT dom-only-advance: the control reacts — a counter moves, the page text changes — and
        the flow does not go anywhere. A driver that accepted "something changed" as progress would
        walk the rest of the journey in the wrong state. */}
    <div><button {...advance.buttonProps}>Continue</button></div>
    {DEFECT === "dom-only-advance" ? <p>Interaction counter {cosmetic}.</p> : null}
    <div><a href="/manage">Open lead records</a></div>
  </main>;
}

const REMEMBERED = "thrallo-adv-open-lead";

const openLead = () => {
  try {
    const remembered = JSON.parse(sessionStorage.getItem(REMEMBERED) || "null");
    return (remembered ? leadStore.find(remembered) : null) || leadStore.all()[0] || null;
  } catch { return null; }
};
const draftOf = (row) => ({
  contactName: (row && row.contactName) || "", contactEmail: (row && row.contactEmail) || "",
  notes: (row && row.notes) || "",
});

function Manage() {
  const [reference, setReference] = useState("");
  const [found, setFound] = useState(openLead);
  const [draft, setDraft] = useState(() => draftOf(openLead()));
  const [dirty, setDirty] = useState(false);
  const [banner, setBanner] = useState("");
  const [prompt, setPrompt] = useState(false);

  const referenceField = useSemanticField({ name: "reference", value: reference, onChange: setReference });
  const edit = (key) => (v) => { setDraft({ ...draft, [key]: v }); setDirty(true); };
  const editName = useSemanticField({ name: "contactName", value: draft.contactName, onChange: edit("contactName") });
  const editEmail = useSemanticField({ name: "contactEmail", type: "email", value: draft.contactEmail, onChange: edit("contactEmail") });
  const editNotes = useSemanticField({ name: "notes", value: draft.notes, onChange: edit("notes") });

  const remember = (row) => {
    setFound(row);
    setDraft(draftOf(row));
    setDirty(false);
    try { sessionStorage.setItem(REMEMBERED, JSON.stringify(row.reference)); } catch {}
  };
  const lookup = () => {
    const row = leadStore.find(reference) || leadStore.all()[0] || null;
    if (row) remember(row);
  };
  // DEFECT stale-update: the screen shows the edit and announces success; the record does not
  // change. Everything a human would look at says it worked.
  const save = () => {
    if (!found) return;
    if (DEFECT === "stale-update") {
      setFound({ ...found, ...draft, status: "Updated" });
      setDirty(false);
      setBanner("Lead updated: the saved lead details show the edited contact name and the same lead reference.");
      return;
    }
    remember(leadStore.save({ ...found, ...draft, status: "Updated" }));
  };
  // DEFECT never-archives: the status word appears, the record keeps its old status.
  const archive = () => {
    if (!found) return;
    if (DEFECT === "never-archives") {
      setBanner("The lead status changes to Archived and the lead reference remains visible.");
      setPrompt(false);
      return;
    }
    remember(leadStore.save({ ...found, status: "Archived" }));
    setPrompt(false);
  };

  // DEFECT wrong-reference: a plausible reference of exactly the right shape, belonging to no
  // record this run created. Every other word on the screen is correct.
  const shownReference = found && DEFECT === "wrong-reference" ? "LEAD-REF-9999" : found && found.reference;

  return <main>
    <h1>Lead records</h1>
    <p>A lead reference lookup form is visible.</p>
    <div><label {...referenceField.labelProps} /><input {...referenceField.inputProps} /></div>
    <div><button type="button" onClick={lookup}>Look up lead</button></div>
    {found ? <section>
      <p>The saved lead details are displayed. Status {found.status}. Reference {shownReference}.</p>
      <p>{sourceText(found.source)} · {priorityText(found.priority)}</p>
      <p>{found.contactName} · {found.contactEmail} · {found.notes}</p>
      {banner ? <p>{banner}</p> : null}
      {found.status === "Updated" || found.status === "Archived"
        ? <p>The saved lead details show the edited contact name {found.contactName} and the same lead reference {shownReference}.</p> : null}
      {found.status === "Archived"
        ? <p>This lead reloads into an explicit Archived state with no active archive control.</p>
        : <>
          <h3>Lead edit form</h3>
          <div><label {...editName.labelProps} /><input {...editName.inputProps} /></div>
          <div><label {...editEmail.labelProps} /><input {...editEmail.inputProps} /></div>
          <div><label {...editNotes.labelProps} /><input {...editNotes.inputProps} /></div>
          {dirty ? <p>The edited contact name, email and notes are visible in the lead edit form.</p> : null}
          <div><button type="button" onClick={save}>Save lead</button></div>
          <div><button type="button" onClick={() => setPrompt(true)}>Archive lead</button></div>
        </>}
      {prompt ? <div>
        <p role="alert">An archive confirmation prompt is displayed. Are you sure?</p>
        <button type="button" onClick={archive}>Confirm archive</button>
        <button type="button" onClick={() => setPrompt(false)}>Keep lead active</button>
      </div> : null}
    </section> : null}
  </main>;
}
`;

const APP = `import { Flow } from "./components/Flow.jsx";
export default function App() { return <Flow />; }
`;

export function adversarialApp() {
  return {
    "src/data/persistence.js": PERSISTENCE,
    "src/data/crm.js": DATA,
    "src/components/Flow.jsx": FLOW,
    "src/App.jsx": APP,
  };
}

/** What each variant lies about, and which contracted claim must therefore not be gradeable. */
export const DEFECTS = Object.freeze({
  none: "the control case — no lie, and it must stay green",
  "wrong-reference": "recovery shows a right-shaped reference belonging to no record",
  "stale-update": "the edit is shown and announced; the durable record never changes",
  "accepts-invalid": "the validation message renders and the flow advances anyway",
  "decoy-only": "a prose-shaped option group with no identity a driver can name",
  "dom-only-advance": "the advance control changes the page without advancing the flow",
  "never-archives": "the status word appears; the record keeps its old status",
  "server-terminal": "every visitor, however fresh, lands in the finished state",
});
