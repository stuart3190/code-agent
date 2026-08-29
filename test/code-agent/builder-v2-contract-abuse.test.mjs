// WHAT DOES THE PLATFORM DO WITH A CONTRACT THAT IS LEGAL BUT LETHAL?
//
// Six paid qualifications died on six different defects, and every one of them was found the same
// expensive way: run a build, watch it fail, read the evidence. That method finds defects one at a
// time, in the order the model happens to produce them, at roughly six credits each.
//
// They were also, every one, the same mistake — the platform trusting a STRING where it should
// have trusted a STRUCTURE. An alias dictionary, a verb list, step prose, a list of English words
// for "next", adjectives in an expectation, and finally an operand whose TYPE was never declared:
//
//   { "action": "confirm the booking", "target": "confirm booking button",
//     "operates": ["create-booking"] }
//
// `create-booking` is an OPERATION id. The contract brief expressly permitted it. Derivation
// treated every operand as a field, built a text box called "create-booking", and the driver spent
// its attempt trying to type into it while the confirm button sat there unpressed.
//
// So this suite asks the question offline, for the whole family at once. Each case is a contract
// the model is entitled to write. The invariants are the two things that must be true of any plan
// before a browser is asked to execute it:
//
//   1. anything the browser must FILL or SELECT is a declared entity field — an operation, an
//      entity or a target phrase cannot hold a value
//   2. no value control is derived for a step that navigates or reloads — those type nothing
//
// A new derivation rule that breaks either one fails here, in seconds, for free.

import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import { deriveVerificationManifest } from "../../shell/server/lib/builderV2/verificationManifest.mjs";

// Contract validation is a HOST responsibility and `shell/shared` is not copied into the sandbox
// image, so it loads lazily and those assertions skip in-image.
const validation = await import("../../shell/shared/implementationContract.mjs").catch(() => null);
const hostOnly = { skip: validation ? false : "contract validation runs on the host, not in the sandbox" };

const BASE = {
  summary: "A booking application for a supper club", projectType: "booking", version: 1,
  auth: { required: false }, routes: [{ path: "/", name: "Booking" }],
  entities: [{ name: "booking", fields: [
    { name: "dateId", type: "string" }, { name: "slotId", type: "string" },
    { name: "slotCapacity", type: "number" }, { name: "partySize", type: "number" },
    { name: "guestName", type: "string" }, { name: "reference", type: "string" }] }],
  operations: [
    { id: "create-booking", entity: "booking", kind: "create", journey: "j" },
    { id: "load-availability", entity: "booking", kind: "read", journey: "j" }],
  acceptance: [
    { id: "a1", statement: "a submitted booking is readable after a page reload", kind: "persistence" },
    { id: "a2", statement: "the booking page renders its available slots", kind: "render" },
    { id: "a3", statement: "an invalid contact detail is rejected before submission", kind: "validation" }],
  states: [], deferred: [], imageIntents: [], integrations: [],
};

const FIELDS = new Set(BASE.entities[0].fields.map((field) => field.name));

const contractWith = (...steps) => ({ ...BASE, journeys: [{ id: "j", title: "A guest books a seat",
  priority: "primary", steps: [
    { action: "open the booking page", target: "/", expect: "the booking page is visible" },
    ...steps] }] });

/** Every control the plan asks the browser to hold a value in, with the step that asked. */
const valueControls = (contract) => (deriveBuildSpec(contract).interactionContract?.flows || [])
  .filter((flow) => flow.control && (flow.control.editable === true || flow.control.selectedState === true))
  .map((flow) => ({ stepIndex: flow.stepIndex, kind: flow.kind,
    field: flow.control.logicalField || flow.control.purpose }));

// ── the invariants, over every shape ───────────────────────────────────────────────────────────

const SHAPES = [
  ["an OPERATION id as an operand — the 2026-08-12 paid failure",
    { action: "confirm the booking", target: "confirm booking button", operates: ["create-booking"],
      expect: "a confirmation with status Confirmed and a reference" }],
  ["a READ operation as an operand",
    { action: "load availability", target: "availability", operates: ["load-availability"],
      expect: "availability is listed" }],
  ["a dotted entity.field operand",
    { action: "select a slot", target: "slots", operates: ["booking.slotId"], expect: "the slot is selected" }],
  ["no operands at all — the legacy prose path",
    { action: "select a date", target: "date picker", expect: "the date is highlighted" }],
  ["an EMPTY operand list, which means the same as none",
    { action: "select a date", target: "date picker", operates: [], expect: "the date is highlighted" }],
  ["six operands on one step",
    { action: "fill everything", target: "form",
      operates: ["dateId", "slotId", "partySize", "guestName", "reference", "slotCapacity"],
      expect: "the values are shown" }],
  ["a declared primitive that disagrees with the verb",
    { action: "enter the guest name", target: "form", operates: ["guestName"], primitive: "selection",
      expect: "the name is shown" }],
  ["the same field operated by two different steps",
    { action: "select a date", target: "picker", operates: ["dateId"], expect: "the date is highlighted" },
    { action: "change the date", target: "picker", operates: ["dateId"], expect: "the new date is highlighted" }],
  ["an operand on a step that NAVIGATES",
    { action: "open the review page", target: "/review", operates: ["reference"],
      expect: "the review page is visible" }],
  ["an operand on a step that RELOADS",
    { action: "reload the page", target: "/", operates: ["reference"],
      expect: "the booking reference is visible again" }],
  ["an operand on a step that LOOKS A RECORD UP — which really does type",
    { action: "enter a booking reference and look it up", target: "lookup form", operates: ["reference"],
      expect: "the saved booking is displayed" }],
];

for (const [name, ...steps] of SHAPES) {
  test(`a browser can execute the plan — ${name}`, () => {
    const contract = contractWith(...steps);
    for (const control of valueControls(contract)) {
      // INVARIANT 1. Operations, entities and target phrases cannot hold a value.
      assert.equal(FIELDS.has(String(control.field || "").split(".").pop()), true,
        `step ${control.stepIndex} asks the browser to hold a value in "${control.field}" (${control.kind}), `
        + "which is not a declared entity field");
      // INVARIANT 2. A step that goes somewhere, or comes back to it, types nothing.
      const step = contract.journeys[0].steps[control.stepIndex];
      assert.equal(/^\s*\//.test(String(step?.target || "")), false,
        `step ${control.stepIndex} navigates to ${step?.target} and was still given a value control`);
    }
  });
}

// ── the live failure, exactly ──────────────────────────────────────────────────────────────────

test("LIVE REGRESSION — a step that performs an operation drives the operation's control", () => {
  const contract = contractWith({ action: "confirm the booking", target: "confirm booking button",
    operates: ["create-booking"], reads: ["dateId", "slotId", "partySize", "guestName"],
    expect: "a confirmation with status Confirmed and a reference" });
  const flows = (deriveBuildSpec(contract).interactionContract?.flows || [])
    .filter((flow) => flow.stepIndex === 1 && flow.control);
  assert.deepEqual(flows.map((flow) => flow.kind), ["mutation"],
    `the confirm step derived ${JSON.stringify(flows.map((f) => `${f.kind}:${f.control.logicalField || f.control.purpose}`))}`);
  assert.equal(flows[0].control.editable, undefined, "the commit control was made fillable");
  // …and nothing named after the operation reaches the browser plan.
  const manifest = deriveVerificationManifest(deriveBuildSpec(contract));
  for (const row of [...manifest.controls, ...manifest.actions]) {
    assert.notEqual(String(row.id), "ctl_" + "createbooking", "an operation became a control id");
  }
  assert.equal(manifest.controls.some((row) => row.stepIndex === 1), false,
    "the operation was still contracted as a value control");
});

test("naming an operation in READS stays legal — it is context, not a control", () => {
  const contract = contractWith({ action: "choose a party size", target: "party size control",
    operates: ["partySize"], reads: ["load-availability", "slotCapacity"],
    expect: "the chosen party size is displayed" });
  assert.deepEqual(valueControls(contract).map((row) => row.field), ["partySize"]);
});

// ── refused before a token is spent ────────────────────────────────────────────────────────────

test("operating an ENTITY is refused before generation", hostOnly, () => {
  const verdict = validation.validateContract(contractWith({ action: "save the booking", target: "form",
    operates: ["booking"], expect: "the booking is saved" }));
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((problem) => /operates "booking", which is an entity/.test(problem)),
    `the entity operand is named and explained: ${JSON.stringify(verdict.problems)}`);
});

test("operating something undeclared is refused before generation", hostOnly, () => {
  const verdict = validation.validateContract(contractWith({ action: "enter the invoice number",
    target: "form", operates: ["invoice.number"], expect: "the number is shown" }));
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((problem) => /invoice\.number/.test(problem)));
});

test("operating an operation is ALLOWED — it says what the step does", hostOnly, () => {
  const verdict = validation.validateContract(contractWith({ action: "confirm the booking",
    target: "confirm booking button", operates: ["create-booking"],
    expect: "a confirmation with status Confirmed and a reference" }));
  assert.deepEqual(verdict.problems.filter((problem) => /operates/.test(problem)), []);
});

// ── JOURNEY ARRANGEMENT — the second unbounded input ───────────────────────────────────────────
//
// A secondary journey routinely starts mid-flow ("cancel the confirmed booking") while browser
// verification always starts from a clean load, so the way in is derived from the PRIMARY
// journey's ordered controls. The model is not bound by the assumptions in that derivation.

const PRIMARY = { id: "book", title: "A guest books a seat", priority: "primary", steps: [
  { action: "open the booking page", target: "/", expect: "the booking page is visible" },
  { action: "select a date", target: "date picker", operates: ["dateId"], expect: "the date is highlighted" },
  { action: "select a slot", target: "slot picker", operates: ["slotId"], expect: "the slot is highlighted" },
  { action: "choose a party size", target: "party size", operates: ["partySize"], expect: "the size is shown" },
  { action: "enter the guest name", target: "form", operates: ["guestName"], expect: "the name is shown" },
  { action: "confirm the booking", target: "confirm booking control", expect: "a booking reference is shown" },
] };

const withJourneys = (journeys, operations = [{ id: "create-booking", entity: "booking", kind: "create", journey: "book" }]) =>
  ({ ...BASE, operations, journeys: [PRIMARY, ...journeys] });

const prerequisitesFor = async (contract, journeyId, options = undefined) => {
  const { journeyPrerequisites } = await import("../../shell/server/lib/appBuild/journeyVerifier.mjs");
  const flows = deriveBuildSpec(contract).interactionContract?.flows || [];
  return journeyPrerequisites(flows, journeyId, "book", options).controls
    .map((flow) => flow.control?.logicalField || flow.control?.accessibleName);
};

test("a secondary that starts mid-flow is driven to its own starting point", async () => {
  const contract = withJourneys([{ id: "capacity", title: "Capacity is enforced", priority: "secondary", steps: [
    { action: "choose a party size above the remaining seats", target: "party size",
      operates: ["partySize"], expect: "the oversized party size is refused" },
    { action: "choose a party size that fits", target: "party size", operates: ["partySize"],
      expect: "the chosen size is shown" }] }]);
  assert.deepEqual(await prerequisitesFor(contract, "capacity"), ["dateId", "slotId"]);
});

test("LIVE-SHAPED REGRESSION — an out-of-order secondary still gets the WHOLE way in", async () => {
  // "amend the guest name, then change the date" enters at the guest name, so the date and slot
  // before it are required to get there. Subtracting every control the journey drives ANYWHERE
  // dropped the date — leaving the setup to select a slot on a screen that has no date yet, and
  // the journey NOT_REACHED for a reason that was nothing to do with the application.
  const contract = withJourneys([{ id: "amend", title: "A guest amends the booking", priority: "secondary", steps: [
    { action: "enter the guest name", target: "form", operates: ["guestName"], expect: "the new name is shown" },
    { action: "select a date", target: "date picker", operates: ["dateId"], expect: "the new date is highlighted" }] }]);
  assert.deepEqual(await prerequisitesFor(contract, "amend"), ["dateId", "slotId", "partySize"],
    "the setup skipped a control the journey needs before it can start");
});

test("a journey that works from an existing record walks no wizard", async () => {
  const contract = withJourneys([{ id: "cancel", title: "A guest cancels", priority: "secondary", steps: [
    { action: "look the booking up by reference", target: "lookup", operates: ["reference"],
      expect: "the saved booking is displayed" },
    { action: "cancel the booking", target: "cancel booking control", expect: "the status is Cancelled" }] }]);
  assert.deepEqual(await prerequisitesFor(contract, "cancel"), []);
});

test("an isolated saved-record journey can reconstruct the primary durable state", async () => {
  const contract = withJourneys([{ id: "history", title: "Saved history", priority: "secondary", steps: [
    { action: "open an existing saved record", target: "history item", expect: "the saved record is visible" },
  ] }]);
  const controls = await prerequisitesFor(contract, "history", {
    requiresPrimaryRecord: true, reconstructIsolated: true,
  });
  assert.ok(controls.includes("guestName"), JSON.stringify(controls));
  assert.match(controls.at(-1), /confirm booking/i,
    "setup includes the durable primary mutation rather than authentication alone");
});

test("an isolated durable read reconstructs its producer even when the first action omits saved-record prose", async () => {
  const { journeyPrerequisites } = await import("../../shell/server/lib/appBuild/journeyVerifier.mjs");
  const control = (name) => ({ logicalField: name, accessibleName: name });
  const flows = [
    { journeyId: "primary", stepIndex: 0, kind: "input", control: control("prompt") },
    { journeyId: "primary", stepIndex: 1, kind: "mutation", control: control("Generate"),
      durableLifecycle: "crud:item" },
    { journeyId: "history", stepIndex: 0, kind: "recovery", control: null,
      reads: ["history.durable.reference"], durableLifecycle: "crud:item" },
    { journeyId: "history", stepIndex: 1, kind: "input", control: control("assetName") },
  ];
  assert.deepEqual(journeyPrerequisites(flows, "history", "primary", {
    reconstructIsolated: true,
  }).controls.map((flow) => flow.control.logicalField), ["prompt", "Generate"]);
});

test("read-only fields from one object selection do not become several invented choices", async () => {
  const { interactionFlowsFor } = await import("../../shell/server/lib/appBuild/journeyVerifier.mjs");
  const contract = { journeys: [{ id: "inspect", steps: [{ action: "select an object", reads: ["objectId"] }] }],
    interactionContract: { flows: ["modelSpec", "objectGraph", "objectId", "parentObjectId"].map((field) => ({
      journeyId: "inspect", stepIndex: 0, kind: "selection",
      control: { logicalField: field, accessibleName: field, machineId: `id-${field}` },
    })) } };
  assert.deepEqual(interactionFlowsFor(contract, "inspect", 0).map((flow) => flow.control.logicalField), ["objectId"]);
});

test("a stale object-selection contract reconstructs the one structured read identity", async () => {
  const { interactionFlowsFor } = await import("../../shell/server/lib/appBuild/journeyVerifier.mjs");
  const contract = { journeys: [{ id: "validate", steps: [{ action: "select a part", reads: ["objectId"] }] }],
    interactionContract: { flows: ["assetName", "partCount"].map((field) => ({
      journeyId: "validate", stepIndex: 0, kind: "selection",
      control: { logicalField: field, accessibleName: field, machineId: `id-${field}` },
    })) } };
  const [flow] = interactionFlowsFor(contract, "validate", 0);
  assert.equal(flow.control.logicalField, "objectId");
  assert.equal(flow.control.machineId, "ctl_bafe0937");
});

test("same-step base and qualified fields retain their distinct contracted identities", async () => {
  const { interactionFlowsFor } = await import("../../shell/server/lib/appBuild/journeyVerifier.mjs");
  const contract = { journeys: [{ id: "create", steps: [{ action: "enter record details" }] }],
    interactionContract: { flows: ["name", "clientName"].map((field) => ({
      journeyId: "create", stepIndex: 0, kind: "input",
      control: { logicalField: field, accessibleName: field, machineId: `id-${field}`,
        statePath: `create.draft.${field}` },
    })) } };
  assert.deepEqual(interactionFlowsFor(contract, "create", 0)
    .map((flow) => flow.control.logicalField), ["name", "clientName"]);
});

test("isolated existing-record reconstruction stops at the durable commit", async () => {
  const { journeyPrerequisites } = await import("../../shell/server/lib/appBuild/journeyVerifier.mjs");
  const control = (name) => ({ logicalField: name, accessibleName: name });
  const flows = [
    { journeyId: "primary", stepIndex: 0, kind: "input", control: control("prompt") },
    { journeyId: "primary", stepIndex: 1, kind: "mutation", control: control("Generate"), durableLifecycle: "crud:item" },
    { journeyId: "primary", stepIndex: 2, kind: "selection", control: control("modelSpec") },
    { journeyId: "secondary", stepIndex: 0, kind: "selection", control: control("modelSpec") },
  ];
  assert.deepEqual(journeyPrerequisites(flows, "secondary", "primary", {
    requiresPrimaryRecord: true, reconstructIsolated: true,
  }).controls.map((flow) => flow.control.logicalField), ["prompt", "Generate"]);
});

test("same-step durable setup fills contracted inputs before it commits", async () => {
  const { journeyPrerequisites } = await import("../../shell/server/lib/appBuild/journeyVerifier.mjs");
  const control = (name) => ({ logicalField: name, accessibleName: name });
  const flows = [
    { journeyId: "primary", stepIndex: 0, kind: "flow_start", control: control("Create account") },
    // This is the historical/live ordering: derivation emitted mutation before input.
    { journeyId: "primary", stepIndex: 1, kind: "mutation", control: control("Generate"),
      durableLifecycle: "crud:item" },
    { journeyId: "primary", stepIndex: 1, kind: "input", control: control("prompt") },
    { journeyId: "secondary", stepIndex: 0, kind: "selection", control: control("history item") },
  ];
  assert.deepEqual(journeyPrerequisites(flows, "secondary", "primary", {
    requiresPrimaryRecord: true, reconstructIsolated: true,
  }).controls.map((flow) => flow.control.logicalField), ["Create account", "prompt", "Generate"]);
});

test("an operation naming a journey that does not exist is refused before generation", hostOnly, () => {
  const verdict = validation.validateContract(withJourneys([], [
    { id: "create-booking", entity: "booking", kind: "create", journey: "book" },
    { id: "cancel-booking", entity: "booking", kind: "update", journey: "a-journey-nobody-declared" }]));
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((problem) => /names journey "a-journey-nobody-declared"/.test(problem)),
    `the dangling journey reference is named: ${JSON.stringify(verdict.problems)}`);
});

test("an operation writing an entity that does not exist is refused before generation", hostOnly, () => {
  const verdict = validation.validateContract(withJourneys([], [
    { id: "create-invoice", entity: "invoice", kind: "create", journey: "book" }]));
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((problem) => /writes entity "invoice"/.test(problem)));
});

// ── the brief the model is given must say the same thing the code enforces ─────────────────────

test("the contract brief distinguishes field operands from operation identities", async () => {
  const { SYSTEM_PROMPT: brief } = await import("../../shell/server/lib/appBuild/contractAgent.mjs");
  assert.match(brief, /"operates" may also name the declared OPERATION id/);
  assert.match(brief, /operation id binds the action control and never becomes a textbox/,
    "the brief must preserve the field/action distinction enforced by interaction derivation");
});
