// WHAT A STEP OPERATES, VERSUS WHAT IT MERELY READS.
//
// The 2026-08-12 qualification died on this step, verbatim:
//
//   "select a party size that does not exceed the slot's remaining capacity"
//
// `fieldCandidates` read the prose and contracted TWO controls — partySize and slotId — because
// the sentence mentions the slot in a subordinate clause. The step operates the party size; it
// merely reads the slot. By the time it ran, the slot control had been consumed and unmounted by
// an earlier step, so the manifest asked the browser to operate a control that was correctly gone,
// and the essential journey failed on it.
//
// English cannot reliably separate a verb's object from its context, and nothing downstream should
// have to. The contract now says so structurally: `operates` are the controls a step manipulates,
// `reads` are the facts it depends on, and only `operates` becomes a browser action.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildInteractionContract } from "../../shell/server/lib/builderV2/interactionContract.mjs";
import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import { browserPlan, controlIdFor, deriveVerificationManifest } from "../../shell/server/lib/builderV2/verificationManifest.mjs";

// Contract validation is a HOST responsibility: the shell validates a contract before a build is
// dispatched, and `shell/shared` is deliberately not copied into the sandbox image. Loading it
// lazily lets this same file run in both places, asserting derivation everywhere and validation
// where validation actually happens.
const validation = await import("../../shell/shared/implementationContract.mjs").catch(() => null);
const hostOnly = { skip: validation ? false : "contract validation runs on the host, not in the sandbox" };

// The paid contract's entity and the two steps that mattered, unchanged.
const PAID = {
  summary: "Ember Table supper club booking", projectType: "booking", version: 1,
  auth: { required: false }, routes: [{ path: "/", name: "Booking" }],
  entities: [{ name: "booking", fields: [
    { name: "dateId", type: "string" }, { name: "slotId", type: "string" },
    { name: "slotCapacity", type: "number" }, { name: "partySize", type: "number" },
    { name: "guestName", type: "string" }, { name: "guestEmail", type: "string" }] }],
  operations: [{ id: "create-booking", entity: "booking", kind: "create", journey: "complete-booking-lifecycle" }],
  journeys: [{ id: "complete-booking-lifecycle", title: "A guest books a supper club seat",
    priority: "primary", steps: [
      { action: "open the booking application", target: "/", expect: "the booking page is visible" },
      { action: "select an available date", target: "date picker", operates: ["dateId"],
        expect: "the selected date is highlighted" },
      { action: "select an available slot", target: "slot picker", operates: ["slotId"], reads: ["dateId"],
        expect: "the selected slot is highlighted and its remaining capacity is shown" },
      // THE STEP THAT FAILED.
      { action: "select a party size that does not exceed the slot's remaining capacity",
        target: "party size control", operates: ["partySize"], reads: ["slotId", "slotCapacity"],
        expect: "the selected party size is displayed and the continue control becomes enabled" },
    ] }],
  acceptance: [], states: [], deferred: [], imageIntents: [], integrations: [],
};

// The VALUE-WRITING controls a step operates — a commit button is an action, not an operand.
const flowsFor = (contract, stepIndex) => buildInteractionContract(contract).flows
  .filter((flow) => flow.stepIndex === stepIndex && flow.control
    && ["selection", "input"].includes(flow.kind));

test("LIVE REGRESSION — the party-size step operates the party size and nothing else", () => {
  const controls = flowsFor(PAID, 3);
  assert.deepEqual(controls.map((flow) => flow.control.logicalField), ["partySize"],
    `the step operates exactly one control: ${JSON.stringify(controls.map((f) => f.control.logicalField))}`);
  assert.equal(controls[0].kind, "selection");
  assert.equal(controls[0].control.machineId, controlIdFor("partySize"));
});

test("LIVE REGRESSION — slotId is NOT re-contracted by the party-size step", () => {
  // The exact defect: a control an earlier step consumed, contracted again because the prose
  // mentioned it. Proven at every layer it could have leaked through.
  const spec = deriveBuildSpec(PAID);
  const stepFlows = spec.interactionContract.flows.filter((flow) => flow.stepIndex === 3);
  for (const flow of stepFlows) {
    assert.notEqual(flow.control?.logicalField, "slotId", `slotId re-contracted: ${flow.id}`);
    assert.notEqual(flow.control?.machineId, controlIdFor("slotId"), `slot identity re-contracted: ${flow.id}`);
  }
  const manifest = deriveVerificationManifest(spec);
  const partyStep = manifest.controls.filter((row) => row.stepIndex === 3);
  assert.deepEqual(partyStep.map((row) => row.id), [controlIdFor("partySize")]);
  const plan = browserPlan(manifest);
  const planned = plan.controls.filter((row) => row.stepIndex === 3).map((row) => row.id);
  assert.equal(planned.includes(controlIdFor("slotId")), false,
    `the browser plan still asks for the slot: ${JSON.stringify(planned)}`);
  // …and the slot IS still operated by the step that owns it.
  assert.deepEqual(flowsFor(PAID, 2).map((flow) => flow.control.logicalField), ["slotId"]);
});

test("what a step READS never becomes a browser action", () => {
  const manifest = deriveVerificationManifest(deriveBuildSpec(PAID));
  const ids = [...manifest.controls, ...manifest.actions].map((row) => row.id);
  // slotCapacity is read by the party-size step and operated by nothing: it is context.
  assert.equal(ids.includes(controlIdFor("slotCapacity")), false,
    "a read-only dependency became a control");
});

test("explicit route navigation remains structured for secondary prerequisite replay", () => {
  const contract = {
    summary: "Software catalogue", projectType: "website", version: 1,
    auth: { required: false }, routes: [{ path: "/", name: "Home" },
      { path: "/catalogue", name: "Catalogue" }],
    entities: [{ name: "selection", fields: [{ name: "categoryId", type: "string" }] }],
    operations: [],
    journeys: [{ id: "browse", title: "Browse software", priority: "primary", steps: [
      { action: "open the catalogue", target: "/catalogue", expect: "software entries are visible" },
      { action: "select a software category", target: "category filter",
        operates: ["categoryId"], expect: "matching software is visible" },
    ] }],
    acceptance: [], states: [], deferred: [], imageIntents: [], integrations: [],
  };
  const navigation = buildInteractionContract(contract).flows.find((flow) => flow.kind === "navigation");
  assert.equal(navigation?.target, "/catalogue");
  assert.equal(navigation?.control, null);
});

test("one declared selection can produce metadata without inventing more controls", () => {
  const contract = JSON.parse(JSON.stringify(PAID));
  contract.entities[0].fields.push(
    { name: "dateLabel", type: "string" },
    { name: "slotCapacityLabel", type: "string" },
  );
  contract.journeys[0].steps[1] = {
    ...contract.journeys[0].steps[1],
    operates: ["dateId"],
    produces: ["dateLabel", "slotCapacityLabel"],
    primitive: "selection",
  };
  contract.acceptance = [
    { id: "a1", statement: "the selected date label is visible" },
    { id: "a2", statement: "the selected slot capacity is visible" },
    { id: "a3", statement: "the booking controls remain usable" },
  ];
  const controls = flowsFor(contract, 1);
  assert.deepEqual(controls.map((flow) => flow.control.logicalField), ["dateId"]);
  assert.deepEqual(controls[0].producedValues, ["dateLabel", "slotCapacityLabel"]);
  assert.ok(controls[0].writes.includes("complete-booking-lifecycle.draft.dateLabel"));
  assert.ok(controls[0].writes.includes("complete-booking-lifecycle.draft.slotCapacityLabel"));
  assert.equal(validation.validateContract(contract).ok, true);
});

test("declared field types drive the generated control contract", () => {
  const contract = {
    summary: "generic typed editor", projectType: "web app", version: 1,
    auth: { required: false }, routes: [{ path: "/", name: "Editor" }],
    entities: [{ name: "project", fields: [
      { name: "projectName", type: "string", required: true },
      { name: "lengthM", type: "number", required: true },
      { name: "targetLux", type: "integer", required: true },
      { name: "targetLuxOverride", type: "boolean", required: false },
    ] }],
    operations: [],
    journeys: [{ id: "create-project", title: "Create a project", priority: "primary", steps: [
      { action: "open the editor", target: "/", expect: "the editor is visible" },
      { action: "enter project and room details", target: "project form",
        operates: ["projectName", "lengthM", "targetLux", "targetLuxOverride"], primitive: "textbox",
        expect: "the entered project and room details are visible" },
    ] }],
    acceptance: [], states: [], deferred: [], imageIntents: [], integrations: [],
  };
  const controls = new Map(flowsFor(contract, 1)
    .map((flow) => [flow.control.logicalField, flow.control]));

  assert.deepEqual(controls.get("projectName").inputTypes, ["text"]);
  assert.equal(controls.get("projectName").valueType, "string");
  assert.deepEqual(controls.get("lengthM").inputTypes, ["number"]);
  assert.ok(controls.get("lengthM").roles.includes("spinbutton"));
  assert.equal(controls.get("lengthM").valueType, "number");
  assert.deepEqual(controls.get("targetLux").inputTypes, ["number"]);
  assert.equal(controls.get("targetLux").valueType, "integer");
  assert.deepEqual(controls.get("targetLuxOverride").inputTypes, ["checkbox"]);
  assert.deepEqual(controls.get("targetLuxOverride").roles, ["checkbox"]);
  assert.equal(controls.get("targetLuxOverride").valueType, "boolean");
});

// ── the same distinction, with the nouns changed ───────────────────────────────────────────────

const GENERIC = [
  { action: "enter the billing email using the selected account", target: "billing form",
    operates: ["billingEmail"], reads: ["accountId"], kind: "input" },
  { action: "choose a shipping method based on the delivery address", target: "shipping options",
    operates: ["shippingMethod"], reads: ["deliveryAddress"], kind: "selection" },
  { action: "set the reorder quantity based on current stock", target: "reorder form",
    operates: ["reorderQuantity"], reads: ["currentStock"], kind: "input" },
  { action: "update the lead status while preserving the owner", target: "status picker",
    operates: ["leadStatus"], reads: ["ownerId"], primitive: "selection", kind: "selection" },
  { action: "select a subscription tier within the user's credit limit", target: "tier picker",
    operates: ["tier"], reads: ["creditLimit"], kind: "selection" },
];

for (const row of GENERIC) {
  test(`operand vs dependency — "${row.action.slice(0, 46)}…"`, () => {
    // Nothing in the platform knows what a shipping method or a credit limit is, and nothing needs
    // to: changing the nouns changes no code.
    const contract = {
      summary: "generic", projectType: "web app", version: 1, auth: { required: false },
      routes: [{ path: "/", name: "Home" }],
      entities: [{ name: "record", fields: [...row.operates, ...row.reads].map((name) => ({ name, type: "string" })) }],
      operations: [],
      journeys: [{ id: "journey", title: "journey", priority: "primary", steps: [
        { action: "open the page", target: "/", expect: "the page is visible" },
        { ...row, expect: "the change is visible on the page" },
      ] }],
      acceptance: [], states: [], deferred: [], imageIntents: [], integrations: [],
    };
    const controls = flowsFor(contract, 1);
    assert.deepEqual(controls.map((flow) => flow.control.logicalField), row.operates,
      `operates: ${JSON.stringify(controls.map((f) => f.control.logicalField))}`);
    assert.equal(controls[0].kind, row.kind);
    for (const dependency of row.reads) {
      assert.equal(controls.some((flow) => flow.control.logicalField === dependency), false,
        `${dependency} is read, not operated`);
    }
  });
}

// ── the contract must mean something ───────────────────────────────────────────────────────────

test("a step may only name controls the contract declares", hostOnly, () => {
  const base = JSON.parse(JSON.stringify(PAID));
  base.journeys[0].steps[3].operates = ["partySize", "somethingNobodyDeclared"];
  const verdict = validation.validateContract(base);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((problem) => /somethingNobodyDeclared/.test(problem)),
    `the unknown reference is named: ${JSON.stringify(verdict.problems)}`);
});

test("a valid structured contract passes validation", hostOnly, () => {
  const verdict = validation.validateContract({ ...PAID,
    acceptance: [{ id: "a1", statement: "a submitted booking is readable after a page reload", kind: "persistence" }] });
  assert.deepEqual(verdict.problems.filter((problem) => /operates|reads/.test(problem)), []);
});

test("a contract WITHOUT operands still derives — V1 and legacy are untouched", () => {
  const legacy = JSON.parse(JSON.stringify(PAID));
  for (const step of legacy.journeys[0].steps) { delete step.operates; delete step.reads; }
  const controls = flowsFor(legacy, 3);
  // The prose reader is still there for contracts that predate the schema; this is exactly the
  // behaviour that failed live, retained deliberately for compatibility and no longer authoritative.
  assert.ok(controls.length >= 1, "legacy contracts still derive controls");
  assert.ok(controls.some((flow) => flow.control.logicalField === "partySize"));
});
