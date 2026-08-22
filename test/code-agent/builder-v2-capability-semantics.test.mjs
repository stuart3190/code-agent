import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";

const contract = ({ entity = "record", fields, operations, steps, title = "Semantic operation" }) => ({
  summary: `${title} application contract`,
  projectType: "tool",
  entities: [{ name: entity, fields: fields.map((name) => ({ name, type: "string", required: true })) }],
  operations,
  journeys: [{ id: "primary-flow", title, priority: "primary", stage: "primary_journey", steps }],
  routes: [{ path: "/", name: "Workspace" }],
  auth: { required: false, rules: [] },
  integrations: [], states: [], acceptance: [], deferred: [],
});

const operation = (spec, id) => spec.capabilityGraph.operationResponsibilities
  .find((candidate) => candidate.operationId === id);
const types = (spec, id) => operation(spec, id).responsibilities.map((responsibility) => responsibility.type);

test("renaming one entity field is CRUD persistence only", () => {
  const source = contract({
    fields: ["name"],
    operations: [{
      id: "rename-record", entity: "record", kind: "update", journey: "primary-flow",
      description: "persist the supplied name",
      responsibilities: [{ type: "persistence", capability: "crud", capabilityMethod: "update", reads: ["name"], writes: ["name"] }],
    }],
    steps: [
      { action: "enter the new name", target: "name", operates: ["name"], expect: "the new name is visible" },
      { action: "save the name", target: "save", operates: ["rename-record"], expect: "the saved name is visible" },
    ],
  });
  const spec = deriveBuildSpec(source);
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));
  assert.deepEqual(types(spec, "rename-record"), ["persistence"]);
  assert.deepEqual(spec.capabilityGraph.customBehavior, []);
});

test("calculating derived totals then saving is custom behavior plus CRUD", () => {
  const source = contract({
    entity: "invoice", fields: ["lineAmounts", "subtotal", "tax", "total"],
    operations: [{
      id: "calculate-and-save", entity: "invoice", kind: "update", journey: "primary-flow",
      description: "derive invoice totals and persist them",
      responsibilities: [{
        type: "functional", behavior: "derive subtotal, tax and total from line amounts",
        capability: "crud", capabilityMethod: "update",
        reads: ["lineAmounts"], writes: ["subtotal", "tax", "total"],
      }],
    }],
    steps: [
      { action: "enter line amounts", target: "amounts", operates: ["lineAmounts"], expect: "the line amounts are visible" },
      { action: "calculate totals", target: "calculate", operates: ["calculate-and-save"], expect: "the derived total is visible" },
      { action: "review the saved total", target: "summary", reads: ["total"], expect: "the saved total is visible" },
    ],
  });
  const spec = deriveBuildSpec(source);
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));
  assert.deepEqual(types(spec, "calculate-and-save"), ["persistence", "custom_functional"]);
  const custom = operation(spec, "calculate-and-save").responsibilities[1];
  assert.ok(custom.reads.length);
  assert.equal(custom.writes.length, 3);
  assert.equal(custom.capabilityMethod, null, "CRUD update must not claim the calculation");
  assert.equal(custom.requestedCapability, "crud");
  assert.ok(custom.downstreamDependencies.length);
  assert.equal(custom.persistenceHandoff.capabilityId, "crud");
  assert.equal(custom.persistenceHandoff.capabilityMethod, "update");
});

test("generating transformed data then persisting is custom behavior plus CRUD", () => {
  const source = contract({
    entity: "schedule", fields: ["requests", "constraints", "assignments"],
    operations: [{
      id: "generate-and-save", entity: "schedule", kind: "create", journey: "primary-flow",
      description: "generate assignments and persist the schedule",
      responsibilities: [{
        type: "functional", behavior: "generate assignments from requests and constraints",
        reads: ["requests", "constraints"], writes: ["assignments"],
      }],
    }],
    steps: [
      { action: "enter requests and constraints", target: "inputs", operates: ["requests", "constraints"], expect: "the inputs are visible" },
      { action: "generate assignments", target: "generate", operates: ["generate-and-save"], expect: "the assignments are visible" },
    ],
  });
  const spec = deriveBuildSpec(source);
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));
  assert.deepEqual(types(spec, "generate-and-save"), ["persistence", "custom_functional"]);
  assert.equal(operation(spec, "generate-and-save").responsibilities[1].persistenceHandoff.capabilityMethod, "create");
});

test("a registered capability method genuinely owning behavior avoids a custom node", () => {
  const source = contract({
    entity: "booking", fields: ["date", "slotId", "name", "email", "reference", "status"],
    operations: [{
      id: "admit-booking", entity: "booking", kind: "create", journey: "primary-flow",
      description: "admit a booking through the registered booking capability",
      responsibilities: [{
        type: "functional", behavior: "admit against capacity and issue a stable reference",
        capability: "booking", capabilityMethod: "createBooking",
        reads: ["date", "slotId", "name", "email"], writes: ["reference", "status"],
      }],
    }],
    steps: [
      { action: "enter booking details", target: "details", operates: ["date", "slotId", "name", "email"], expect: "the details are visible" },
      { action: "confirm the booking", target: "confirm", operates: ["admit-booking"], expect: "the reference is visible" },
    ],
  });
  const spec = deriveBuildSpec(source);
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));
  assert.deepEqual(types(spec, "admit-booking"), ["persistence", "capability_functional"]);
  assert.equal(spec.capabilityGraph.customBehavior.length, 0);
  assert.ok(spec.capabilityGraph.journeys[0].requiredNodeIds.includes("capability:booking"));
});

test("pure create, read, and delete remain composed without custom behavior", () => {
  const source = contract({
    fields: ["name"],
    operations: [
      { id: "create-record", entity: "record", kind: "create", journey: "primary-flow" },
      { id: "read-record", entity: "record", kind: "read", journey: "primary-flow" },
      { id: "delete-record", entity: "record", kind: "delete", journey: "primary-flow" },
    ],
    steps: [
      { action: "enter a name", target: "name", operates: ["name"], expect: "the name is visible" },
      { action: "create the record", target: "create", operates: ["create-record"], expect: "the record is visible" },
      { action: "read the record", target: "read", operates: ["read-record"], expect: "the stored record is visible" },
      { action: "delete the record", target: "delete", operates: ["delete-record"], expect: "the record is removed" },
    ],
  });
  const spec = deriveBuildSpec(source);
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));
  assert.deepEqual(spec.capabilityGraph.customBehavior, []);
  for (const id of ["create-record", "read-record", "delete-record"]) assert.deepEqual(types(spec, id), ["persistence"]);
});

test("novel transformations cannot disappear behind update or create kinds", () => {
  for (const kind of ["update", "create"]) {
    const source = contract({
      fields: ["source", "result"],
      operations: [{
        id: `novel-${kind}`, entity: "record", kind, journey: "primary-flow",
        responsibilities: [{ type: "functional", behavior: "produce result from source", reads: ["source"], writes: ["result"] }],
      }],
      steps: [
        { action: "enter source", target: "source", operates: ["source"], expect: "the source is visible" },
        { action: "produce result", target: "run", operates: [`novel-${kind}`], expect: "the result is visible" },
      ],
    });
    const spec = deriveBuildSpec(source);
    assert.equal(spec.verdict.ok, true, `${kind}: ${spec.verdict.problems.join("; ")}`);
    assert.deepEqual(types(spec, `novel-${kind}`), ["persistence", "custom_functional"]);
  }

  const invalid = contract({
    fields: ["source", "result"],
    operations: [{
      id: "unowned-transform", entity: "record", kind: "update", journey: "primary-flow",
      responsibilities: [{ type: "functional", behavior: "produce a result", reads: [], writes: [] }],
    }],
    steps: [
      { action: "enter source", target: "source", operates: ["source"], expect: "the source is visible" },
      { action: "produce result", target: "run", operates: ["unowned-transform"], expect: "the result is visible" },
    ],
  });
  const invalidSpec = deriveBuildSpec(invalid);
  assert.equal(invalidSpec.verdict.ok, false);
  assert.ok(invalidSpec.verdict.problems.includes(
    "capability_graph_semantics_incomplete operation=unowned-transform responsibility=unowned-transform:functional-1 missing=reads,writes",
  ));
});
