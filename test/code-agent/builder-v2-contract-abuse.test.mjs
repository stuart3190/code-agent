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

// ── the brief the model is given must say the same thing the code enforces ─────────────────────

test("the contract brief tells the model operands are fields", async () => {
  const { SYSTEM_PROMPT: brief } = await import("../../shell/server/lib/appBuild/contractAgent.mjs");
  assert.match(brief, /"operates" names FIELDS ONLY/,
    "the brief still invites the operand type confusion the code now refuses");
});
