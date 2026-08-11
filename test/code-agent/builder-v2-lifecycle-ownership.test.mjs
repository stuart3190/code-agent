// Durable ownership is a LIFECYCLE question, not a field-overlap question.
//
// A journey either creates a durable record, or it acts on one that already exists. The generic
// matrix below is the whole space, on a lifecycle that is neither a booking nor an order so no
// domain vocabulary can be doing the work:
//
//   A  collect draft → CREATE → reload                        PRODUCER
//   B  recover existing                                       CONSUMER
//   C  cancel existing                                        CONSUMER
//   D  update/archive existing                                CONSUMER
//   E  collect draft → CREATE → later UPDATE → reload          PRODUCER
//   F  independent validation                                 INDEPENDENT
//   G  existing reference only                                CONSUMER
//   H  existing record + substantive edited fields + UPDATE    CONSUMER
//
// H is why this file exists. An update journey references an existing record AND supplies edited
// values for the entity's own declared fields, so by field overlap alone it is indistinguishable
// from a creation — and it was being classified as the record's PRODUCER, then driven as a fresh
// visitor with no record to edit. The decisive fact is the lifecycle operation (CREATE vs UPDATE
// vs CANCEL/ARCHIVE), read from the contract's declared operations, and structurally from whether
// the journey locates a record before committing. Neither reading consults a natural-language verb.
//
// Every case is asserted twice: once on a contract that DECLARES its operations (the canonical
// path) and once on the same journeys with no operations at all (the data-flow fallback). Both
// must agree, or the two layers disagree in production the first time a contract omits one.

import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import {
  canonicalOperationKind, declaredLifecycleRole, journeyLifecycleKinds,
} from "../../shell/server/lib/builderV2/lifecycleOperations.mjs";

const JOURNEYS = [
  // A — collect a draft, create the record, prove it survived.
  { id: "capture-new-lead", title: "An advisor captures a new lead", priority: "primary", steps: [
    { action: "open the lead capture page", target: "/", expect: "the lead capture form is visible" },
    { action: "start a new lead", target: "new lead control", expect: "the first step of the capture flow is shown" },
    { action: "select a lead source", target: "lead source picker", expect: "the chosen source is highlighted" },
    { action: "enter the contact name, email and notes", target: "lead details form",
      expect: "the entered name, email and notes are visible" },
    { action: "review the lead", target: "review step",
      expect: "the entered name, email and notes are visible before saving" },
    { action: "confirm the new lead", target: "confirm lead control",
      expect: "a durable lead reference and status New are shown" },
    { action: "reload the page", target: "browser reload",
      expect: "the stored lead is recovered and the same lead reference remains visible" },
  ] },
  // B — recover a record this journey did not create.
  { id: "recover-existing-lead", title: "An advisor recovers an existing lead", priority: "secondary", steps: [
    { action: "open the lead lookup area", target: "/leads", expect: "a lead reference lookup form is visible" },
    { action: "enter an existing lead reference", target: "lookup form", expect: "the lead details are displayed" },
    { action: "reload the page", target: "browser reload", expect: "the recovered lead remains displayed" },
  ] },
  // C — cancel a record that already exists.
  { id: "cancel-existing-lead", title: "An advisor cancels an existing lead", priority: "secondary", steps: [
    { action: "open an existing lead", target: "/leads", expect: "the lead details and a cancel control are visible" },
    { action: "choose to cancel the lead", target: "cancel lead control", expect: "a cancellation prompt is displayed" },
    { action: "confirm cancellation", target: "confirm cancellation control",
      expect: "the lead status becomes Cancelled and the reference remains visible" },
    { action: "reload the page", target: "browser reload", expect: "the lead reloads in the Cancelled state" },
  ] },
  // D — archive a record that already exists.
  { id: "archive-existing-lead", title: "An advisor archives an existing lead", priority: "secondary", steps: [
    { action: "open the lead lookup area", target: "/leads", expect: "a lead reference lookup form is visible" },
    { action: "look up the lead by reference", target: "lookup form", expect: "the matching lead is displayed" },
    { action: "archive the lead", target: "archive lead control", expect: "the lead is shown as Archived" },
    { action: "reload the page", target: "browser reload", expect: "the archived lead remains Archived" },
  ] },
  // E — create the record, then edit the record it just created.
  { id: "capture-then-correct-lead", title: "An advisor captures then corrects a lead", priority: "secondary", steps: [
    { action: "start a new lead", target: "new lead control", expect: "the first step of the capture flow is shown" },
    { action: "enter the contact name and email", target: "lead details form",
      expect: "the entered name and email are visible" },
    { action: "confirm the new lead", target: "confirm lead control", expect: "a durable lead reference is shown" },
    { action: "edit the contact name and notes", target: "lead details form", expect: "the edited values are visible" },
    { action: "update the lead", target: "save lead control", expect: "the lead shows the corrected name and notes" },
    { action: "reload the page", target: "browser reload",
      expect: "the corrected lead is recovered with the same reference" },
  ] },
  // F — validation with no durable record anywhere in it.
  { id: "lead-email-validation", title: "Contact email validation", priority: "secondary", steps: [
    { action: "advance to the contact details step", target: "lead capture wizard",
      expect: "the contact email field is visible" },
    { action: "enter an invalid email address", target: "email field",
      expect: "a validation message is shown and the continue control remains disabled" },
    { action: "enter a valid email address", target: "email field",
      expect: "the validation message clears and the continue control becomes enabled" },
  ] },
  // G — a reference to an existing record and nothing else.
  { id: "view-existing-lead", title: "An advisor views an existing lead", priority: "secondary", steps: [
    { action: "open the lead lookup area", target: "/leads", expect: "a lead reference lookup form is visible" },
    { action: "look up an existing lead by reference", target: "lookup form",
      expect: "the lead details and status are displayed" },
  ] },
  // H — an existing record, substantively edited, then UPDATED. The one that was wrong.
  { id: "update-existing-lead", title: "An advisor updates an existing lead", priority: "secondary", steps: [
    { action: "open the lead lookup area", target: "/leads", expect: "a lead reference lookup form is visible" },
    { action: "look up an existing lead by reference", target: "lookup form", expect: "the lead details are displayed" },
    { action: "edit the contact name, notes and status", target: "lead details form",
      expect: "the edited name, notes and status are visible" },
    { action: "update the lead", target: "save lead control",
      expect: "the lead shows the edited name, notes and status" },
    { action: "reload the page", target: "browser reload",
      expect: "the edited lead is recovered with the same reference" },
  ] },
];

const BASE = {
  summary: "Northfield Advisory lead desk", projectType: "web app", version: 1,
  auth: { required: false },
  routes: [{ path: "/", name: "Capture" }, { path: "/leads", name: "Leads" }],
  entities: [{ name: "lead", fields: [
    { name: "source", type: "string" }, { name: "name", type: "string" }, { name: "email", type: "string" },
    { name: "notes", type: "string" }, { name: "reference", type: "string" }, { name: "status", type: "string" },
    { name: "leadId", type: "string" }] }],
  journeys: JOURNEYS,
  acceptance: [], states: [], deferred: [], imageIntents: [], integrations: [],
};

// The canonical path: the contract states which lifecycle operation each journey invokes.
const DECLARED = {
  ...BASE,
  operations: [
    { id: "create-lead", entity: "lead", kind: "create", journey: "capture-new-lead" },
    { id: "read-lead-by-reference", entity: "lead", kind: "read", journey: "recover-existing-lead" },
    { id: "cancel-lead", entity: "lead", kind: "update", journey: "cancel-existing-lead" },
    { id: "archive-lead", entity: "lead", kind: "update", journey: "archive-existing-lead" },
    { id: "create-then-correct-lead", entity: "lead", kind: "create", journey: "capture-then-correct-lead" },
    { id: "correct-lead", entity: "lead", kind: "update", journey: "capture-then-correct-lead" },
    { id: "read-lead", entity: "lead", kind: "read", journey: "view-existing-lead" },
    { id: "update-lead", entity: "lead", kind: "update", journey: "update-existing-lead" },
  ],
};

// The fallback: identical journeys, no declared operations at all.
const UNDECLARED = { ...BASE, operations: [] };

const EXPECTED = {
  "capture-new-lead": "produces",
  "recover-existing-lead": "consumes",
  "cancel-existing-lead": "consumes",
  "archive-existing-lead": "consumes",
  "capture-then-correct-lead": "produces",
  "lead-email-validation": "independent",
  "view-existing-lead": "consumes",
  "update-existing-lead": "consumes",
};

const CASE_LABELS = {
  "capture-new-lead": "A collect draft → CREATE → reload",
  "recover-existing-lead": "B recover existing",
  "cancel-existing-lead": "C cancel existing",
  "archive-existing-lead": "D update/archive existing",
  "capture-then-correct-lead": "E CREATE → later UPDATE → reload",
  "lead-email-validation": "F independent validation",
  "view-existing-lead": "G existing reference only",
  "update-existing-lead": "H existing record + edited fields + UPDATE",
};

const specOf = (contract) => deriveBuildSpec(contract);

test("A–H — declared lifecycle operations classify every generic journey", () => {
  const spec = specOf(DECLARED);
  assert.equal(spec.verdict.ok, true, JSON.stringify(spec.verdict.problems));
  const scenarios = spec.interactionContract.scenarios;
  for (const [journeyId, role] of Object.entries(EXPECTED)) {
    assert.equal(scenarios[journeyId].role, role,
      `${CASE_LABELS[journeyId]} — expected ${role}, got ${scenarios[journeyId].role}`);
  }
  // Every durable journey resolved through the CONTRACT's operations, not the graph fallback.
  for (const journeyId of Object.keys(EXPECTED)) {
    if (EXPECTED[journeyId] === "independent") continue;
    assert.equal(scenarios[journeyId].basis, "declared-operation", journeyId);
  }
});

test("A–H — the data-flow fallback agrees when the contract declares no operations", () => {
  const spec = specOf(UNDECLARED);
  assert.equal(spec.verdict.ok, true, JSON.stringify(spec.verdict.problems));
  const scenarios = spec.interactionContract.scenarios;
  for (const [journeyId, role] of Object.entries(EXPECTED)) {
    assert.equal(scenarios[journeyId].role, role,
      `${CASE_LABELS[journeyId]} (no declared operations) — expected ${role}, got ${scenarios[journeyId].role}`);
  }
  assert.equal(scenarios["update-existing-lead"].basis, "data-flow");
});

test("CASE H — field overlap alone would have called the update journey a producer", () => {
  // The trap, stated as an assertion rather than as a comment: this journey's committing mutation
  // really is fed by draft values naming the entity's OWN declared, non-identity fields — exactly
  // what a creation looks like — and it is still a consumer.
  const spec = specOf(UNDECLARED);
  const flows = spec.interactionContract.flows.filter((flow) => flow.journeyId === "update-existing-lead");
  const declaredFields = new Set(spec.entities.flatMap((entity) => entity.fields.map((field) => field.name)));
  const commit = flows.find((flow) => flow.kind === "mutation");
  assert.ok(commit, `an update journey must derive a durable commit: ${flows.map((f) => f.kind).join(", ")}`);
  const suppliedFields = (commit.reads || [])
    .map((path) => path.split(".draft.")[1])
    .filter((field) => field && declaredFields.has(field) && !/^(reference|status|leadId)$/.test(field));
  assert.ok(suppliedFields.length >= 2,
    `the update must supply substantive record contents, got ${JSON.stringify(commit.reads)}`);
  // And it locates the record first, which is what makes it an edit.
  const locates = flows.find((flow) => ["lookup", "recovery"].includes(flow.kind));
  assert.ok(locates && locates.stepIndex < commit.stepIndex,
    "the existing record is located before the update commits");
  assert.equal(spec.interactionContract.scenarios["update-existing-lead"].role, "consumes");
});

test("CASE E — creating a record and later editing it keeps the journey its producer", () => {
  for (const contract of [DECLARED, UNDECLARED]) {
    const spec = specOf(contract);
    const flows = spec.interactionContract.flows.filter((flow) => flow.journeyId === "capture-then-correct-lead");
    const commits = flows.filter((flow) => flow.kind === "mutation");
    assert.ok(commits.length >= 2, `create and update both commit: ${flows.map((f) => f.kind).join(", ")}`);
    assert.equal(spec.interactionContract.scenarios["capture-then-correct-lead"].role, "produces");
  }
});

test("a declared create operation outranks a declared update on the same journey", () => {
  // Case E declares both. Creating the record is what makes the journey its producer; a later edit
  // of the record it created cannot demote it.
  const kinds = journeyLifecycleKinds(DECLARED, { id: "capture-then-correct-lead" }, { entity: "lead" });
  assert.deepEqual([...kinds].sort(), ["create", "update"]);
  assert.equal(declaredLifecycleRole(DECLARED, { id: "capture-then-correct-lead" }, { entity: "lead" }), "creates");
  assert.equal(declaredLifecycleRole(DECLARED, { id: "update-existing-lead" }, { entity: "lead" }), "existing");
  // A journey the contract says nothing about declares nothing — the graph decides.
  assert.equal(declaredLifecycleRole(DECLARED, { id: "lead-email-validation" }, { entity: "lead" }), null);
});

test("operation kinds are canonicalised, and unrecognised kinds decide nothing", () => {
  assert.equal(canonicalOperationKind("create"), "create");
  assert.equal(canonicalOperationKind("insert"), "create");
  assert.equal(canonicalOperationKind("update"), "update");
  assert.equal(canonicalOperationKind("archive"), "update");
  assert.equal(canonicalOperationKind("cancel"), "update");
  assert.equal(canonicalOperationKind("delete"), "delete");
  assert.equal(canonicalOperationKind("read"), "read");
  assert.equal(canonicalOperationKind("list"), "read");
  assert.equal(canonicalOperationKind("frobnicate"), null);
  assert.equal(canonicalOperationKind(undefined), null);
});

test("an operation for a DIFFERENT entity never speaks for this lifecycle", () => {
  const contract = {
    ...BASE,
    entities: [...BASE.entities, { name: "note", fields: [{ name: "body", type: "string" }] }],
    operations: [{ id: "create-note", entity: "note", kind: "create", journey: "update-existing-lead" }],
  };
  const spec = specOf(contract);
  // The lead lifecycle is untouched by a note operation, so case H stays a consumer on the graph.
  assert.equal(spec.interactionContract.scenarios["update-existing-lead"].role, "consumes");
  assert.equal(spec.interactionContract.scenarios["update-existing-lead"].basis, "data-flow");
});

test("one durable lifecycle identity is shared across producer and consumers", () => {
  const spec = specOf(DECLARED);
  const lifecycles = new Set(spec.interactionContract.flows
    .filter((flow) => flow.durableLifecycle).map((flow) => flow.durableLifecycle));
  assert.equal(lifecycles.size, 1, `one lifecycle, got ${[...lifecycles].join(", ")}`);
  assert.equal([...lifecycles][0].includes("booking"), false, "no booking vocabulary in a lead contract");
  const scenarios = spec.interactionContract.scenarios;
  assert.equal(scenarios["capture-new-lead"].lifecycle, scenarios["update-existing-lead"].lifecycle);
  assert.equal(scenarios["lead-email-validation"].lifecycle, null);
  // Independent journeys start fresh; consumers inherit the record's state.
  assert.equal(scenarios["lead-email-validation"].startState, "fresh");
  assert.equal(scenarios["capture-new-lead"].startState, "fresh");
  assert.equal(scenarios["update-existing-lead"].startState, "inherits");
});
