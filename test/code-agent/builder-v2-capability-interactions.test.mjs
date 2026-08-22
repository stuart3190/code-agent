import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";

const makeContract = ({ entity = "record", fields, operations, steps, title = "Capability interaction" }) => ({
  summary: `${title} contract`, projectType: "tool",
  entities: [{ name: entity, fields: fields.map((name) => ({ name, type: "string", required: true })) }],
  operations,
  journeys: [{ id: "primary-flow", title, priority: "primary", stage: "primary_journey", steps }],
  routes: [{ path: "/", name: "Workspace" }],
  auth: { required: false, rules: [] }, integrations: [], states: [], acceptance: [], deferred: [],
});

const interactionFor = (spec, operationId) => spec.interactionContract.flows
  .find((flow) => flow.operationId === operationId);

const assertCommonSemantics = (flow, operationId) => {
  assert.ok(flow, `missing interaction for ${operationId}`);
  assert.equal(flow.actionIdentity.operationId, operationId);
  assert.equal(flow.actionIdentity.interactionId, flow.id);
  assert.ok(flow.stateOwner);
  assert.ok(flow.expectedStateTransition);
  assert.ok(Array.isArray(flow.downstreamConsumers));
  assert.ok(flow.verificationObservation);
  assert.ok(flow.responsibilityIds.length);
};

test("plain CRUD update produces a complete capability-backed interaction contract", () => {
  const spec = deriveBuildSpec(makeContract({
    fields: ["name"],
    operations: [{
      id: "rename-record", entity: "record", kind: "update", journey: "primary-flow",
      responsibilities: [{
        type: "persistence", capability: "crud", capabilityMethod: "update",
        reads: ["name"], writes: ["name"],
      }],
    }],
    steps: [
      { action: "enter a name", target: "name", operates: ["name"], expect: "the name is visible" },
      { action: "save the name", target: "save", operates: ["rename-record"], expect: "the saved name is visible" },
    ],
  }));
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));
  const flow = interactionFor(spec, "rename-record");
  assertCommonSemantics(flow, "rename-record");
  assert.deepEqual(flow.semanticResponsibilityTypes, ["persistence"]);
  assert.equal(flow.capabilityId, "crud");
  assert.equal(flow.capabilityMethod, "update");
  assert.ok(flow.reads.length);
  assert.ok(flow.writes.length);
  assert.equal(flow.customBehavior, null);

  // Provider contracts historically used CRUD verb aliases. They are canonicalized against the
  // registered interface before the structural gate, rather than rejected or passed through.
  const aliases = deriveBuildSpec(makeContract({
    fields: ["name"],
    operations: [
      { id: "read-records", entity: "record", kind: "read", journey: "primary-flow",
        responsibilities: [{ type: "persistence", capability: "crud", capabilityMethod: "read" }] },
      { id: "read-record", entity: "record", kind: "read", journey: "primary-flow",
        responsibilities: [{ type: "persistence", capability: "crud", capabilityMethod: "read", reads: ["name"] }] },
      { id: "delete-record", entity: "record", kind: "delete", journey: "primary-flow",
        responsibilities: [{ type: "persistence", capability: "crud", capabilityMethod: "delete", reads: ["name"] }] },
    ],
    steps: [
      { action: "list records", target: "records", operates: ["read-records"], expect: "records are visible" },
      { action: "read one record", target: "record", operates: ["read-record"], expect: "one record is visible" },
      { action: "delete one record", target: "delete", operates: ["delete-record"], expect: "the record is removed" },
    ],
  }));
  assert.equal(aliases.verdict.ok, true, aliases.verdict.problems.join("; "));
  assert.deepEqual(["read-records", "read-record", "delete-record"].map((id) => (
    interactionFor(aliases, id).capabilityMethod
  )), ["list", "get", "remove"]);
});

test("custom calculation plus CRUD persistence produces a complete custom interaction contract", () => {
  const spec = deriveBuildSpec(makeContract({
    entity: "invoice", fields: ["lineAmounts", "subtotal", "tax", "total"],
    operations: [{
      id: "derive-totals", entity: "invoice", kind: "update", journey: "primary-flow",
      responsibilities: [{
        type: "functional", behavior: "derive subtotal, tax and total from line amounts",
        capability: "crud", capabilityMethod: "update", reads: ["lineAmounts"],
        writes: ["subtotal", "tax", "total"],
      }],
    }],
    steps: [
      { action: "enter line amounts", target: "line amounts", operates: ["lineAmounts"], expect: "line amounts are visible" },
      // Deliberately no `operates`: the prose-derived interaction pass cannot own this action.
      { action: "run derive totals", target: "derive totals", reads: ["lineAmounts"], expect: "the total is visible" },
      { action: "review totals", target: "totals", reads: ["subtotal", "tax", "total"], expect: "all totals are visible" },
    ],
  }));
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));
  const flow = interactionFor(spec, "derive-totals");
  assertCommonSemantics(flow, "derive-totals");
  assert.deepEqual(flow.semanticResponsibilityTypes, ["persistence", "custom_functional"]);
  assert.ok(flow.id.includes(":operation:"), "the graph must supply a missing semantic interaction");
  assert.ok(flow.reads.length);
  assert.equal(flow.writes.length, 3);
  assert.ok(flow.customBehavior);
  assert.ok(flow.customBehaviorModule);
  assert.ok(flow.customBehaviorExports.length);
  assert.equal(flow.persistenceHandoff.capabilityId, "crud");
  assert.equal(flow.persistenceHandoff.capabilityMethod, "update");
  assert.ok(flow.downstreamConsumers.length);
});

test("custom data transformation plus persistence produces a complete custom interaction contract", () => {
  const spec = deriveBuildSpec(makeContract({
    entity: "schedule", fields: ["requests", "constraints", "assignments"],
    operations: [{
      id: "generate-assignments", entity: "schedule", kind: "create", journey: "primary-flow",
      responsibilities: [{
        type: "functional", behavior: "generate assignments from requests and constraints",
        reads: ["requests", "constraints"], writes: ["assignments"],
      }],
    }],
    steps: [
      { action: "enter requests and constraints", target: "inputs", operates: ["requests", "constraints"], expect: "inputs are visible" },
      { action: "run generate assignments", target: "generate", reads: ["requests", "constraints"], expect: "assignments are visible" },
    ],
  }));
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));
  const flow = interactionFor(spec, "generate-assignments");
  assertCommonSemantics(flow, "generate-assignments");
  assert.ok(flow.reads.length);
  assert.equal(flow.writes.length, 1);
  assert.ok(flow.customBehaviorModule);
  assert.equal(flow.persistenceHandoff.capabilityMethod, "create");
});

test("cross-entity transformation preserves source reads and output-entity writes", () => {
  const source = makeContract({
    entity: "artifact", fields: ["format", "content", "generatedAt"],
    operations: [{
      id: "render-artifact", entity: "artifact", kind: "transform", journey: "primary-flow",
      responsibilities: [{
        type: "functional", behavior: "render a source record into an artifact",
        reads: ["sourceName", "sourceRows"], writes: ["format", "content", "generatedAt"],
      }],
    }],
    steps: [
      { action: "open the source record", target: "source", reads: ["sourceName", "sourceRows"], expect: "the source is visible" },
      { action: "run render artifact", target: "render", operates: ["render-artifact"], expect: "the artifact is available" },
    ],
  });
  source.entities.unshift({
    name: "sourceRecord",
    fields: ["sourceName", "sourceRows"].map((name) => ({ name, type: "string", required: true })),
    owned: true,
  });

  const spec = deriveBuildSpec(source);
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));
  const responsibility = spec.capabilityGraph.operationResponsibilities
    .find((candidate) => candidate.operationId === "render-artifact").responsibilities[0];
  assert.deepEqual(responsibility.declaredReads, ["sourceName", "sourceRows"]);
  assert.deepEqual(responsibility.declaredWrites, ["format", "content", "generatedAt"]);
  assert.equal(responsibility.type, "custom_functional");

  const flow = interactionFor(spec, "render-artifact");
  assertCommonSemantics(flow, "render-artifact");
  assert.deepEqual(flow.semanticResponsibilityTypes, ["custom_functional"]);
  assert.deepEqual(flow.reads, [
    "primary-flow.input.sourceName",
    "primary-flow.input.sourceRows",
  ]);
  assert.deepEqual(flow.writes, [
    "primary-flow.custom.format",
    "primary-flow.custom.content",
    "primary-flow.custom.generatedAt",
  ]);
  assert.ok(flow.customBehaviorModule);
  assert.equal(flow.persistenceHandoff, null);
});

test("registered functional capability produces a capability-backed interaction contract", () => {
  const spec = deriveBuildSpec(makeContract({
    entity: "booking", fields: ["date", "slotId", "name", "email", "reference", "status"],
    operations: [{
      id: "admit-booking", entity: "booking", kind: "create", journey: "primary-flow",
      responsibilities: [{
        type: "functional", behavior: "admit against capacity and issue a stable reference",
        capability: "booking", capabilityMethod: "createBooking",
        reads: ["date", "slotId", "name", "email"], writes: ["reference", "status"],
      }],
    }],
    steps: [
      { action: "enter booking details", target: "details", operates: ["date", "slotId", "name", "email"], expect: "details are visible" },
      { action: "confirm booking", target: "confirm", operates: ["admit-booking"], expect: "the reference is visible" },
    ],
  }));
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));
  const flow = interactionFor(spec, "admit-booking");
  assertCommonSemantics(flow, "admit-booking");
  assert.deepEqual(flow.semanticResponsibilityTypes, ["persistence", "capability_functional"]);
  assert.equal(flow.capabilityId, "booking");
  assert.equal(flow.capabilityMethod, "createBooking");
  assert.equal(flow.capability, "makeBookingSystem");
  assert.equal(flow.customBehavior, null);
  assert.equal(flow.persistenceHandoff.capabilityId, "crud");
});

test("truly underspecified transformation is rejected with exact missing semantic fields", () => {
  const spec = deriveBuildSpec(makeContract({
    fields: ["source", "result"],
    operations: [{
      id: "unowned-transform", entity: "record", kind: "update", journey: "primary-flow",
      responsibilities: [{ type: "functional", behavior: "produce a result", reads: [], writes: [] }],
    }],
    steps: [
      { action: "enter source", target: "source", operates: ["source"], expect: "source is visible" },
      { action: "run transformation", target: "run", operates: ["unowned-transform"], expect: "result is visible" },
    ],
  }));
  assert.equal(spec.verdict.ok, false);
  assert.ok(spec.verdict.problems.includes(
    "capability_graph_semantics_incomplete operation=unowned-transform responsibility=unowned-transform:functional-1 missing=reads,writes",
  ));
  assert.ok(spec.verdict.problems.includes(
    "interaction_contract_semantics_incomplete operation=unowned-transform interaction=primary-flow:operation:unownedtransform missing=reads,writes",
  ));
  assert.deepEqual(spec.verdict.interaction.issues, [{
    code: "interaction_contract_semantics_incomplete",
    operationId: "unowned-transform",
    interactionId: "primary-flow:operation:unownedtransform",
    missingFields: ["reads", "writes"],
  }]);
});
