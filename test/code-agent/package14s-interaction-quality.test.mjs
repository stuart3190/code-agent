import test from "node:test";
import assert from "node:assert/strict";

import {
  buildInteractionContract, collectInteractionControls, interactionContractBrief, interactionFailureDiagnostics,
  lintInteractiveWorkflow, validateInteractionContract,
} from "../../shell/server/lib/builderV2/interactionContract.mjs";
import { bindCapabilities, bookingModulePlan, tierContract } from "../../shell/server/lib/builderV2/contractTiering.mjs";
import { createOrchestrator } from "../../shell/server/lib/builderV2/orchestrator.mjs";
import { renderPatchPrompt } from "../../shell/server/lib/builderV2/modelLanes.mjs";
import { makeBookingSystem } from "../../src/scaffolds/reactVite/lib/capabilities/booking.js";
import { makeWizardMachine } from "../../src/scaffolds/reactVite/lib/capabilities/wizard.js";
import { fromScaffold } from "../../src/engine/fileTree.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";

const CONTRACT = {
  summary: "A multi-step booking workflow with durable recovery and cancellation",
  entities: [{ name: "booking", fields: [
    { name: "date", type: "string", required: true },
    { name: "slot", type: "string", required: true },
    { name: "partySize", type: "number", required: true },
    { name: "name", type: "string", required: true },
    { name: "email", type: "string", required: true },
    { name: "phone", type: "string", required: true },
  ] }],
  operations: [{ id: "create-booking", entity: "booking", kind: "create", journey: "book",
    description: "persist a booking" }],
  routes: [{ path: "/", name: "Booking" }],
  auth: { required: false, rules: [] },
  journeys: [{ id: "book", title: "Complete and manage a multi-step booking", priority: "primary",
    steps: [
      { action: "select a date", target: "date options", expect: "the selected date becomes active" },
      { action: "select a slot and party size", target: "slot and party controls", expect: "the selected slot and party size are visible" },
      { action: "enter name, email and phone", target: "contact details", expect: "the entered contact values are accepted" },
      { action: "review the exact selections and contact values", target: "booking review", expect: "the review displays the exact values" },
      { action: "confirm booking", target: "confirm booking", expect: "confirmation displays a durable booking reference" },
      { action: "reload and recover the booking", target: "booking status", expect: "the confirmed booking is restored" },
      { action: "cancel the booking", target: "cancel booking", expect: "cancelled status is durable after reload" },
    ] }],
};

const TREE = {
  "src/App.jsx": `import { BookingFlow } from "./components/booking/BookingFlow";
export default function App(){ return <BookingFlow />; }`,
  "src/data/bookingSystem.js": `const booking = makeBookingSystem({ entity: "booking" });
export const create = (draft) => booking.createBooking(draft);
export const lookup = (id) => booking.getBooking(id);
export const cancel = (id) => booking.cancelBooking(id);`,
  "src/data/bookingWizard.js": `const wizard = makeWizardMachine({ id: "booking", steps: ["date","slot","contact","review","confirm"] });
wizard.getState(); wizard.subscribe(() => {}); wizard.restore(); wizard.select("date", "2026-08-10");
wizard.next(); wizard.confirm(); wizard.cancel(); export { wizard };`,
  "src/components/booking/BookingFlow.jsx": `export function BookingFlow(){ const draft = { date: "", slot: "", partySize: 1, name: "", email: "", phone: "" };
return <main>
  <button aria-label="date option" aria-pressed={draft.date === "2026-08-10"}>Select date</button>
  <button aria-label="slot option" aria-pressed={draft.slot === "10:00"}>Select slot</button>
  <button aria-label="party size" aria-pressed={draft.partySize === 2}>Party size</button>
  <label>Name<input name="name" aria-label="name" /></label>
  <label>Email<input type="email" name="email" aria-label="email" /></label>
  <label>Phone<input name="phone" aria-label="phone" /></label>
  <button>Confirm booking</button><button>Cancel booking</button>
</main> }`,
  "src/components/booking/BookingReview.jsx": `export function BookingReview({ draft }){ return <dl>{draft.date}{draft.slot}{draft.partySize}{draft.name}{draft.email}{draft.phone}</dl> }`,
  "src/components/booking/BookingConfirmation.jsx": `export function BookingConfirmation({ booking }){ return <p>Booking reference {booking.reference}</p> }`,
  "src/components/booking/BookingStatus.jsx": `export function BookingStatus({ booking }){ return <p>{booking.status}</p> }`,
};

function plan() {
  return buildInteractionContract(CONTRACT, {
    modulePlan: bookingModulePlan(CONTRACT, CONTRACT.journeys), bindings: bindCapabilities(CONTRACT),
  });
}

test("14S interaction contract owns every input and traces review through durable cancellation", () => {
  const interaction = plan();
  assert.equal(validateInteractionContract(interaction).ok, true, interaction.problems?.join("; "));
  const kinds = new Set(interaction.flows.map((flow) => flow.kind));
  for (const kind of ["selection", "input", "review", "mutation", "recovery", "cancellation"]) assert.ok(kinds.has(kind), kind);
  assert.ok(interaction.flows.filter((flow) => ["selection", "input"].includes(flow.kind)).every((flow) => flow.stateOwner));
  const review = interaction.flows.find((flow) => flow.kind === "review");
  assert.ok(review.reads.some((path) => path.endsWith("date")));
  assert.ok(review.reads.some((path) => path.endsWith("email")));
  const mutation = interaction.flows.find((flow) => flow.kind === "mutation");
  assert.ok(mutation.writes.some((path) => path.endsWith("durable.reference")));
  const cancellation = interaction.flows.find((flow) => flow.kind === "cancellation");
  assert.equal(cancellation.capability, "makeBookingSystem");
  assert.ok(cancellation.reads.some((path) => path.endsWith("durable.record")));
});

test("14S interaction planning rejects broken state ownership and data-flow before generation", () => {
  const missingOwner = structuredClone(plan());
  missingOwner.flows.find((flow) => flow.writes.length).stateOwner = null;
  assert.match(validateInteractionContract(missingOwner).problems.join("\n"), /without an owner/);
  const brokenReview = structuredClone(plan());
  brokenReview.flows.find((flow) => flow.kind === "review").reads = [];
  assert.match(validateInteractionContract(brokenReview).problems.join("\n"), /review has no source values/);
});

test("14S one semantic control is not multiplied by entity id/label compatibility fields", () => {
  const contract = { entities: [{ fields: [
    { name: "dateId" }, { name: "dateLabel" }, { name: "date" },
    { name: "slotId" }, { name: "slotLabel" }, { name: "slot" },
    { name: "guestName" }, { name: "name" }, { name: "guestEmail" }, { name: "email" },
    { name: "guestPhone" }, { name: "phone" },
  ] }], journeys: [{ id: "retained", steps: [
    { action: "select an available date", expect: "date selected" },
    { action: "select an available slot", expect: "slot selected" },
    { action: "enter a valid name, email and phone number", expect: "review visible" },
  ] }] };
  const interaction = buildInteractionContract(contract, { modulePlan: [], bindings: [] });
  assert.deepEqual(interaction.flows.filter((flow) => flow.stepIndex === 0).map((flow) => flow.valueWritten), ["dateId"]);
  assert.deepEqual(interaction.flows.filter((flow) => flow.stepIndex === 1).map((flow) => flow.valueWritten), ["slotId"]);
  assert.deepEqual(interaction.flows.filter((flow) => flow.stepIndex === 2).map((flow) => flow.valueWritten),
    ["guestName", "guestEmail", "guestPhone"]);
  assert.ok(interaction.flows.find((flow) => flow.valueWritten === "guestName").control.accessibleNames.includes("name"));
});

test("14S generation prompt receives the exact machine-readable interaction contract", () => {
  const contract = { ...CONTRACT, interactionContract: plan() };
  const prompt = renderPatchPrompt({ step: "core", contract, tiers: tierContract(contract), tree: {},
    modulePlan: bookingModulePlan(contract, contract.journeys) });
  assert.match(prompt, /INTERACTION CONTRACT \(machine-enforced JSON/);
  assert.match(prompt, /"stateOwner"/);
  assert.match(prompt, /"selectedState": true/);
  assert.match(prompt, /durable\.reference/);
  assert.match(prompt, /Visual design remains unrestricted/);
});

test("14S retained booking fixture is driveable and structurally traces review, confirmation and cancellation", () => {
  const interaction = plan();
  const verdict = lintInteractiveWorkflow(TREE, { interactionContract: interaction,
    modulePlan: bookingModulePlan(CONTRACT, CONTRACT.journeys), bindings: bindCapabilities(CONTRACT) });
  assert.equal(verdict.ok, true, verdict.problems.join("\n"));

  const undriveable = { ...TREE,
    "src/components/booking/BookingFlow.jsx": `export function BookingFlow(){ return <div onClick={() => {}}>contact booking controls</div> }` };
  const driven = lintInteractiveWorkflow(undriveable, { interactionContract: interaction,
    modulePlan: bookingModulePlan(CONTRACT, CONTRACT.journeys), bindings: bindCapabilities(CONTRACT) });
  assert.equal(driven.ok, false);
  assert.ok(driven.findings.some((row) => row.code === "interaction_control_undriveable"));

  const noReviewFlow = { ...TREE,
    "src/components/booking/BookingReview.jsx": `export function BookingReview(){ return <p>Review</p> }` };
  assert.ok(lintInteractiveWorkflow(noReviewFlow, { interactionContract: interaction,
    modulePlan: bookingModulePlan(CONTRACT, CONTRACT.journeys), bindings: bindCapabilities(CONTRACT) })
    .findings.some((row) => row.code === "review_data_flow_missing"));

  const fakeReference = { ...TREE,
    "src/components/booking/BookingConfirmation.jsx": `export function BookingConfirmation(){ return <p>Reference {Date.now()}</p> }` };
  assert.ok(lintInteractiveWorkflow(fakeReference, { interactionContract: interaction,
    modulePlan: bookingModulePlan(CONTRACT, CONTRACT.journeys), bindings: bindCapabilities(CONTRACT) })
    .findings.some((row) => row.code === "fabricated_confirmation_reference"));
});

test("14S contracted fields require accessible, editable controls connected to owned state", () => {
  const emailFlow = plan().flows.find((flow) => flow.kind === "input" && flow.valueWritten === "email");
  const interactionContract = { version: 1, flows: [emailFlow] };
  const lint = (source) => lintInteractiveWorkflow({ "src/Contact.jsx": source }, { interactionContract });

  for (const source of [
    `export function Contact(){ return <><label htmlFor="email">Email</label><input type="email" id="email" name="email" /></> }`,
    `export function Contact(){ return <label>Email<input type="email" name="email" /></label> }`,
    `export function Contact(){ return <input type="email" aria-label="Email" name="email" /> }`,
  ]) assert.equal(lint(source).ok, true, source);

  const missingName = lint(`export function Contact({draft,setDraft}){ return <input type="email" value={draft.email}
    onChange={(event) => setDraft({...draft,email:event.target.value})} /> }`);
  assert.equal(missingName.ok, false);
  assert.equal(missingName.findings[0].reason, "missing_accessible_identity");

  for (const [source, reason] of [
    [`export function Contact(){ return <input type="number" aria-label="Email" name="email" /> }`, "invalid_control_type"],
    [`export function Contact(){ return <input type="email" aria-label="Email" name="email" disabled /> }`, "disabled"],
    [`export function Contact(){ return <input type="email" aria-label="Email" name="email" readOnly /> }`, "readonly"],
    [`export function Contact({draft}){ return <input type="email" aria-label="Email" name="email" value={draft.email} /> }`, "controlled_without_change_handler"],
    [`export function Contact({draft,setDraft}){ return <input type="email" aria-label="Email" name="email" value={draft.phone}
      onChange={(event) => setDraft({...draft,phone:event.target.value})} /> }`, "state_owner_not_connected"],
  ]) {
    const verdict = lint(source);
    assert.equal(verdict.ok, false, source);
    assert.ok(verdict.findings.some((finding) => finding.reason === reason), JSON.stringify(verdict));
  }
});

test("14S source control facts retain locator, editability and state provenance for repair", () => {
  const controls = collectInteractionControls({
    "src/Contact.jsx": `export function Contact({contact,setContact}){ return <><label htmlFor="guest-email">Email</label>
      <input id="guest-email" name="email" type="email" value={contact.email}
        onChange={(event) => setContact({...contact,email:event.target.value})} /></> }`,
  });
  assert.equal(controls.length, 1);
  assert.equal(controls[0].accessibleName, "Email");
  assert.equal(controls[0].inputType, "email");
  assert.equal(controls[0].controlled, true);
  assert.equal(controls[0].hasChangeHandler, true);
  assert.match(controls[0].valueSource, /contact\.email/);
  assert.equal(controls[0].line, 2);
});

test("14S retained zero-model workflow propagates input through durable confirmation, recovery and cancellation", async () => {
  const rows = [];
  const deps = { ensureSession: async () => ({ id: "visitor" }), db: { entity: () => ({
    async list({ filters = {} } = {}) { return rows.filter((row) => Object.entries(filters).every(([key, value]) => row.data[key] === value)); },
    async create(data) { const row = { id: `row-${rows.length + 1}`, created_at: new Date().toISOString(), data }; rows.push(row); return row; },
    async update(id, data) { const row = rows.find((entry) => entry.id === id); row.data = data; return row; },
    async delete(id) { const index = rows.findIndex((entry) => entry.id === id); if (index >= 0) rows.splice(index, 1); },
  }) } };
  const booking = makeBookingSystem({ slots: [{ id: "10:00", capacity: 4 }], deps });
  let durable = null;
  const persistence = { async save(state) { durable = structuredClone(state); },
    async load() { return structuredClone(durable); }, async clear() { durable = null; } };
  const machine = makeWizardMachine({ id: "fixture", steps: ["date", "slot", "contact", "review", "confirm"],
    persistence, onConfirm: async (values) => booking.createBooking(values) });
  await machine.select("date", "2026-08-10");
  await machine.select("slotId", "10:00");
  await machine.select("partySize", 2);
  await machine.select("name", "Ada Lovelace");
  await machine.select("email", "ada@example.com");
  await machine.select("phone", "555-0100");
  for (let index = 0; index < 4; index += 1) assert.equal((await machine.next()).ok, true);
  const review = machine.getState().values;
  assert.deepEqual(review, { date: "2026-08-10", slotId: "10:00", partySize: 2,
    name: "Ada Lovelace", email: "ada@example.com", phone: "555-0100" });
  const confirmed = await machine.confirm();
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.confirmation.result, "ok");
  assert.match(confirmed.confirmation.booking.reference, /^BK-/);

  const restored = makeWizardMachine({ id: "fixture", steps: ["date", "slot", "contact", "review", "confirm"], persistence });
  await restored.restore();
  assert.equal(restored.getState().status, "confirmed");
  assert.equal(restored.getState().confirmation.booking.reference, confirmed.confirmation.booking.reference);
  const lookup = await booking.getBooking(confirmed.confirmation.booking.reference, "ada@example.com");
  assert.equal(lookup.partySize, 2);
  assert.equal((await booking.remaining("2026-08-10", "10:00")), 2, "capacity reflects the durable mutation");
  const cancelled = await booking.cancelBooking(lookup.reference, lookup.email);
  assert.equal(cancelled.ok, true);
  assert.equal((await booking.getBooking(lookup.reference, lookup.email)).status, "Cancelled");
  assert.equal((await booking.getBooking(lookup.reference, lookup.email)).status, "Cancelled", "cancelled state survives a fresh lookup");
});

test("14S repair context identifies state before/after, owner, modules and downstream failures", () => {
  const diagnostics = interactionFailureDiagnostics({ contract: CONTRACT, interactionContract: plan(), journeyResults: {
    journeys: [{ id: "book", owners: ["src/components/booking/BookingFlow.jsx"], steps: [
      { action: "select a date", expect: "the selected date becomes active", status: "fail", detail: "date did not highlight",
        controlEvidence: { attemptedLocators: ["date:role=button name=date"], renderedControls: [{ role: "button", accessibleName: "Date" }] } },
      { action: "select a slot", status: "not_reached", detail: "blocked by date" },
    ] }],
  } });
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].actualObservedState, "date did not highlight");
  assert.match(diagnostics[0].expectedStateAfter, /selected date/);
  assert.ok(diagnostics[0].stateOwners.length);
  assert.ok(diagnostics[0].responsibleModules.includes("src/components/booking/BookingFlow.jsx"));
  assert.deepEqual(diagnostics[0].dataOperations, ["create-booking"]);
  assert.ok(diagnostics[0].downstreamDependencies.length, "review/mutation dependencies are named for one causal repair");
  assert.deepEqual(diagnostics[0].attemptedLocators, ["date:role=button name=date"]);
  assert.equal(diagnostics[0].renderedControlFacts[0].accessibleName, "Date");
  assert.equal(diagnostics.length, 1, "downstream NOT REACHED steps do not become independent repair defects");
});

test("14S repair exhaustion remains metadata while contracted red journeys remain the terminal cause", async () => {
  let calls = 0;
  let browserContract = null;
  const scaffold = fromScaffold(REACT_VITE);
  const patches = Object.entries(TREE).map(([path, content]) => scaffold[path] === undefined
    ? { newFile: path, content } : { replaceFile: path, content });
  const orchestrator = createOrchestrator({
    contractFn: async () => CONTRACT,
    patchesFn: async ({ step }) => {
      calls += 1;
      if (step === "repair") throw Object.assign(new Error("repair_limit_reached"), {
        code: "repair_limit_reached", repairsDispatched: 1, maxRepairs: 1,
      });
      return patches;
    },
    assetService: { async resolveIntents() { return { resolved: [], providerCalls: 0 }; }, async assetManifestFor() { return []; } },
    baseTree: () => fromScaffold(REACT_VITE),
    baseline: REACT_VITE,
    compile: async (tree) => ({ ok: true, tree }),
    journeysFn: async ({ journeys, contract }) => {
      browserContract = contract;
      return { journeys: journeys.map((journey) => ({ ...journey, status: "fail",
        steps: journey.steps.map((step) => ({ ...step, status: "fail", detail: "transition stayed red" })) })) };
    },
    maxCoreAttempts: 1,
  });
  const result = await orchestrator.runBuild({ owner: "owner", projectId: "project", request: "booking", maxRepairs: 1 });
  assert.equal(result.state, "blocked");
  assert.equal(result.failureClassification, "contracted_journeys_red", JSON.stringify(result));
  assert.equal(result.repair_exhausted, true);
  assert.equal(result.repairLimit.code, "repair_limit_reached");
  assert.match(result.error, /required contracted journeys remain red/);
  assert.doesNotMatch(result.error, /^repair_limit_reached$/);
  assert.equal(result.finalJourneyVerdicts[0].status, "fail");
  assert.ok(result.finalVerificationDiagnostics.length);
  assert.equal(calls, 2, "one core and one blocked repair dispatch attempt; no hidden second repair");
  assert.ok(browserContract?.interactionContract?.flows?.length,
    "the machine-readable interaction contract reaches the browser verifier");
});
