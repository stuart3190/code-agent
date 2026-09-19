// A CRM lead lifecycle — the third domain, and the first with a real EDIT in the middle of it.
//
// Booking proved the architecture on a reservation; checkout proved it carried to an order. Both
// end their durable story at cancellation. A CRM does the thing neither does: it CREATES a record,
// then RE-OPENS it and rewrites the record's own declared fields, then archives it. That update is
// generic case H in a running application rather than in a derivation unit test — the journey
// references an existing lead AND supplies substantive edited values, which is exactly the shape
// that used to classify as the lead's producer and get driven as a fresh visitor with no lead.
//
// Same platform primitives as every other fixture — makeWizardMachine, useCapabilityState,
// useSemanticSelection, useSemanticField — and neither makeBookingSystem nor any checkout
// vocabulary. Persistence is sessionStorage so the whole lifecycle (create → recover → update →
// archive → recover the archived state) runs offline. That substitution is stated plainly: it
// proves the VERIFIER drives these journeys; it does not prove durable backend persistence.

const PERSISTENCE = `const KEY = "thrallo-crm-capture";
export const sessionPersistence = {
  async save(state) { try { sessionStorage.setItem(KEY, JSON.stringify(state)); } catch {} },
  async load() { try { return JSON.parse(sessionStorage.getItem(KEY) || "null"); } catch { return null; } },
  async clear() { try { sessionStorage.removeItem(KEY); } catch {} },
};

const LEADS = "thrallo-crm-leads";
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
import { wizard, SOURCES, PRIORITIES, sourceOf, priorityOf, validEmail, leadStore } from "../data/crm.js";

const sourceText = (value) => "Source " + (sourceOf(value) ? sourceOf(value).label : "");
const priorityText = (value) => "Priority " + (priorityOf(value) ? priorityOf(value).label : "");

export function Flow() {
  const state = useCapabilityState(wizard);
  const values = state.values || {};
  const manage = typeof window !== "undefined" && window.location.pathname.startsWith("/manage");
  if (manage) return <Manage />;

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
  const continueDisabled = state.stepId === "contact" && !emailValid;
  const anyContact = Boolean(values.contactName || values.contactEmail || values.notes);

  const advance = useFlowAdvance({ label: "Continue", disabled: continueDisabled, onActivate: () => { wizard.next(); } });

  if (state.status === "confirmed") {
    const reference = state.confirmation ? state.confirmation.reference : "";
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
      <div {...priority.groupProps}>
        {PRIORITIES.map((p) => (
          <button key={p.value} {...priority.optionProps(p.value, "priority " + p.label)}>
            <span style={{ display: "block" }}>Priority {p.label}</span>
            {values.priority === p.value ? <span style={{ display: "block" }}>selected priority highlighted</span> : null}
          </button>
        ))}
      </div>
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

    <div><button {...advance.buttonProps}>Continue</button></div>
    <div><a href="/manage">Open lead records</a></div>
  </main>;
}

const REMEMBERED = "thrallo-crm-open-lead";

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
  // The edit is recorded ON THE RECORD, not announced in a banner that a reload would wipe: a
  // lead that has been edited says so whenever it is opened again.
  const save = () => {
    if (!found) return;
    remember(leadStore.save({ ...found, ...draft, status: "Updated" }));
  };
  const archive = () => {
    if (!found) return;
    remember(leadStore.save({ ...found, status: "Archived" }));
    setPrompt(false);
  };

  return <main>
    <h1>Lead records</h1>
    <p>A lead reference lookup form is visible.</p>
    <div><label {...referenceField.labelProps} /><input {...referenceField.inputProps} /></div>
    <div><button type="button" onClick={lookup}>Look up lead</button></div>
    {found ? <section>
      <p>The saved lead details are displayed. Status {found.status}. Reference {found.reference}.</p>
      <p>{sourceText(found.source)} · {priorityText(found.priority)}</p>
      <p>{found.contactName} · {found.contactEmail} · {found.notes}</p>
      {found.status === "Updated" || found.status === "Archived"
        ? <p>The saved lead details show the edited contact name {found.contactName} and the same lead reference {found.reference}.</p> : null}
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

export function crmScenarioApp() {
  return {
    "src/data/persistence.js": PERSISTENCE,
    "src/data/crm.js": DATA,
    "src/components/Flow.jsx": FLOW,
    "src/App.jsx": APP,
  };
}

/** The contract, authored as prose and derived by the production deriveBuildSpec. */
export const CRM_CONTRACT = {
  summary: "Harbrook Advisory lead desk", projectType: "web app", version: 1,
  auth: { required: false },
  routes: [{ path: "/", name: "Lead desk" }, { path: "/manage", name: "Lead records" }],
  entities: [{ name: "lead", fields: [
    { name: "source", type: "string" }, { name: "priority", type: "string" },
    { name: "contactName", type: "string" }, { name: "contactEmail", type: "string" },
    { name: "notes", type: "string" }, { name: "reference", type: "string" },
    { name: "status", type: "string" }] }],
  operations: [
    { id: "create-lead", entity: "lead", kind: "create", journey: "capture-new-lead" },
    { id: "read-lead-by-reference", entity: "lead", kind: "read", journey: "recover-existing-lead" },
    { id: "update-lead", entity: "lead", kind: "update", journey: "update-existing-lead" },
    { id: "archive-lead", entity: "lead", kind: "update", journey: "archive-existing-lead" }],
  journeys: [
    { id: "capture-new-lead", title: "An advisor captures and recovers a new lead", priority: "primary", steps: [
      { action: "open the lead desk page", target: "/",
        expect: "the Harbrook Advisory lead desk headline and pipeline summary are shown" },
      { action: "begin lead capture", target: "lead capture control",
        expect: "the current capture step indicator and the lead source options are shown" },
      { action: "select a lead source", target: "lead source picker",
        expect: "the priority options for that source are shown" },
      { action: "select a priority", target: "priority picker",
        expect: "the selected priority is highlighted" },
      { action: "enter the contact name, email and notes", target: "contact fields",
        expect: "the entered contact name, email and notes are visible" },
      { action: "review the lead", target: "review step",
        expect: "the exact selected source, priority, contact name, email and notes are visible before saving" },
      { action: "confirm the new lead", target: "confirm lead control",
        expect: "a saved lead screen appears with status New and a durable lead reference" },
      { action: "reload the page", target: "browser reload",
        expect: "the saved lead state is recovered and the same lead reference remains visible" },
    ] },
    { id: "recover-existing-lead", title: "An advisor recovers an existing lead", priority: "secondary", steps: [
      { action: "open the lead records area", target: "/manage",
        expect: "a lead reference lookup form is visible" },
      { action: "enter a valid saved lead reference", target: "lookup form",
        expect: "the saved lead details are displayed with status New" },
      { action: "reload the page", target: "browser reload",
        expect: "the recovered lead remains displayed with the same status and reference" },
    ] },
    { id: "update-existing-lead", title: "An advisor updates an existing lead", priority: "secondary", steps: [
      { action: "open the lead records area", target: "/manage",
        expect: "a lead reference lookup form is visible" },
      { action: "look up the saved lead by reference", target: "lookup form",
        expect: "the saved lead details and a lead edit form are visible" },
      { action: "edit the contact name, email and notes", target: "lead edit form",
        expect: "the edited contact name, email and notes are visible in the lead edit form" },
      { action: "update the lead", target: "save lead control",
        expect: "the saved lead details show the edited contact name and the same lead reference" },
      { action: "reload the page", target: "browser reload",
        expect: "the updated lead is recovered with the edited details and the same reference" },
    ] },
    { id: "archive-existing-lead", title: "An advisor archives an existing lead", priority: "secondary", steps: [
      { action: "open a saved lead", target: "/manage",
        expect: "the saved lead details and an archive lead control are visible" },
      { action: "choose to archive the lead", target: "archive lead control",
        expect: "an archive confirmation prompt is displayed" },
      { action: "confirm the archive", target: "confirm archive control",
        expect: "the lead status changes to Archived and the lead reference remains visible" },
      { action: "reload the page", target: "browser reload",
        expect: "the lead reloads into an explicit Archived state with no active archive control" },
    ] },
    { id: "contact-validation", title: "Lead email validation", priority: "secondary", steps: [
      { action: "advance to the contact step", target: "lead capture flow",
        expect: "the contact fields are shown" },
      { action: "enter an invalid contact email", target: "contact email field",
        expect: "an email validation message is shown and the continue control remains disabled" },
      { action: "enter a valid contact email and required details", target: "contact fields",
        expect: "validation messages clear and the continue control becomes enabled" },
    ] },
  ],
  acceptance: [], states: [], deferred: [], imageIntents: [], integrations: [],
};
