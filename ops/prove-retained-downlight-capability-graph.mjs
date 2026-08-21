// Deterministic regression for the retained production contract from failed/blocked build
// 6956e591-cdc6-40aa-93a8-bd9de236a33e. No provider, customer build, queue, or database is used.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { deriveBuildSpec } from "../shell/server/lib/builderV2/buildSpec.mjs";
import { validateCapabilityComposition } from "../shell/server/lib/builderV2/capabilityComposer.mjs";
import { composeCapabilityFoundation } from "../shell/server/lib/builderV2/capabilityComposer.mjs";
import { fromScaffold } from "../src/engine/fileTree.mjs";
import { REACT_VITE } from "../src/scaffolds/reactVite.mjs";

const fixture = JSON.parse(await readFile(new URL(
  "../test/fixtures/downlight-capability-contract-6956e591.json", import.meta.url,
), "utf8"));
assert.equal(fixture.retainedBuildId, "6956e591-cdc6-40aa-93a8-bd9de236a33e");

const spec = deriveBuildSpec(fixture.contract);
assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));
const composed = composeCapabilityFoundation(fromScaffold(REACT_VITE), spec.capabilityGraph);
assert.equal(validateCapabilityComposition(composed.tree, spec.capabilityGraph, composed.plan).ok, false,
  "the retained contract must require its bounded custom extension before model generation");

const autoLayout = spec.capabilityGraph.operationResponsibilities
  .find((operation) => operation.operationId === "auto-layout-project");
assert.ok(autoLayout);
const persistence = autoLayout.responsibilities.find((responsibility) => responsibility.type === "persistence");
const functional = autoLayout.responsibilities.find((responsibility) => responsibility.type === "custom_functional");
assert.equal(persistence.capabilityId, "crud");
assert.equal(persistence.capabilityMethod, "update");
assert.ok(functional.customBehavior);
assert.ok(functional.owner);
assert.ok(functional.reads.length);
assert.ok(functional.writes.length);
assert.ok(functional.downstreamDependencies.length);
assert.equal(functional.persistenceHandoff.capabilityId, "crud");
assert.equal(functional.persistenceHandoff.capabilityMethod, "update");
assert.deepEqual(functional.declaredWrites.sort(), ["calculationResults", "fittings", "layoutExplanation"]);

const extension = spec.compositionPlan.extensionPoints
  .find((candidate) => candidate.id === functional.customBehavior);
assert.ok(extension?.module);
assert.ok(extension.requiredExports.length);
assert.ok(extension.inputs.length);
assert.ok(extension.outputs.length);
const customNode = spec.capabilityGraph.nodes.find((candidate) => candidate.id === functional.customBehavior);
assert.deepEqual(customNode.stateOwnership.owns.sort(), functional.writes.slice().sort());
assert.ok(customNode.verificationSemantics.actions.length);
assert.deepEqual(customNode.verificationSemantics.stateChange.sort(), functional.writes.slice().sort());
assert.ok(customNode.verificationSemantics.observe.length);
assert.equal(customNode.verificationSemantics.persistenceHandoff[0].capabilityId, "crud");

for (const id of ["create-project", "update-project", "load-project"]) {
  const operation = spec.capabilityGraph.operationResponsibilities.find((candidate) => candidate.operationId === id);
  assert.deepEqual(operation.responsibilities.map((responsibility) => responsibility.type), ["persistence"], id);
  assert.equal(operation.responsibilities[0].capabilityId, "crud", id);
}

const journey = spec.capabilityGraph.journeys
  .find((candidate) => candidate.journeyId === "create-auto-layout-project");
const action = journey.dataFlows
  .find((flow) => flow.interactionId === "create-auto-layout-project:7:action");
assert.equal(action.capabilityMethod, null);
assert.equal(action.customBehavior, functional.customBehavior);
assert.ok(action.reads.length);
assert.ok(action.writes.length);
assert.ok(action.downstreamDependencies.length);

process.stdout.write(`${JSON.stringify({
  ok: true,
  retainedBuildId: fixture.retainedBuildId,
  providerCalls: 0,
  customerBuilds: 0,
  operation: autoLayout.operationId,
  responsibilities: autoLayout.responsibilities.map((responsibility) => ({
    type: responsibility.type,
    owner: responsibility.owner,
    capabilityMethod: responsibility.capabilityMethod,
    reads: responsibility.reads,
    writes: responsibility.writes,
    downstreamDependencies: responsibility.downstreamDependencies,
    persistenceHandoff: responsibility.persistenceHandoff,
  })),
  extension: { id: extension.id, module: extension.module, requiredExports: extension.requiredExports },
  persistenceOperations: ["create-project", "update-project", "load-project"],
}, null, 2)}\n`);
