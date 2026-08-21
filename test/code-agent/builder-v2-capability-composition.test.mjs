import { test } from "node:test";
import assert from "node:assert/strict";

import { CAPABILITIES } from "../../shell/server/lib/builderV2/capabilityRegistry.mjs";
import { deriveBuildSpec, scopeBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import {
  composeCapabilityFoundation, validateCapabilityComposition,
} from "../../shell/server/lib/builderV2/capabilityComposer.mjs";
import { validateCapabilityGraph } from "../../shell/server/lib/builderV2/capabilityGraph.mjs";
import { validateModuleConformance, moduleCorrectionScope } from "../../shell/server/lib/builderV2/moduleContracts.mjs";
import { renderPatchPrompt } from "../../shell/server/lib/builderV2/modelLanes.mjs";
import { applyPatches } from "../../shell/server/lib/builderV2/patchEngine.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";
import { makeEntityStore } from "../../src/scaffolds/reactVite/lib/capabilities/crud.js";

const base = (summary, entities, operations, journeys, extra = {}) => ({
  summary, entities, operations, journeys,
  routes: [{ path: "/", name: "Workspace" }], auth: { required: false },
  deferred: [], imageIntents: [], integrations: [], ...extra,
});

const CRUD = base("generic record workflow", [{ name: "workItem", fields: [
  { name: "title", type: "string", required: true },
  { name: "status", type: "string", required: true },
] }], [
  { id: "create-item", entity: "workItem", kind: "create", journey: "manage-items" },
  { id: "update-item", entity: "workItem", kind: "update", journey: "manage-items" },
  { id: "delete-item", entity: "workItem", kind: "delete", journey: "manage-items" },
], [{ id: "manage-items", title: "Manage records", priority: "primary", steps: [
  { action: "enter a title", target: "editor", operates: ["title"], primitive: "textbox", expect: "the title is visible" },
  { action: "create the item", target: "save", operates: ["create-item"], expect: "the record is saved" },
  { action: "change its status", target: "status", operates: ["status"], primitive: "selection", expect: "the new status is visible" },
  { action: "delete the item", target: "delete", operates: ["delete-item"], expect: "the record is removed" },
] }]);

const TRANSACTION = base("generic multi-step transaction", [{ name: "transaction", fields: [
  { name: "method", type: "string", required: true },
  { name: "amount", type: "number", required: true },
] }], [{ id: "create-transaction", entity: "transaction", kind: "create", journey: "transaction-wizard" }], [
  { id: "transaction-wizard", title: "Transaction wizard", priority: "primary", steps: [
    { action: "select a method", target: "method", operates: ["method"], primitive: "selection", expect: "the method is selected" },
    { action: "continue to the amount", target: "continue", expect: "the amount step opens" },
    { action: "enter an amount", target: "amount", operates: ["amount"], primitive: "textbox", expect: "the amount is visible" },
    { action: "review the transaction", target: "review", expect: "the selected values are shown" },
    { action: "confirm the transaction", target: "confirm", operates: ["create-transaction"], expect: "the transaction is confirmed" },
    { action: "reload the page", target: "/", expect: "the confirmed transaction is restored" },
  ] },
]);

const INTERACTIVE = base("interactive calculation workspace", [{ name: "project", fields: [
  { name: "width", type: "number", required: true },
  { name: "height", type: "number", required: true },
] }], [
  { id: "calculate-result", entity: "project", kind: "calculate", journey: "interactive-workspace" },
  { id: "move-object", entity: "project", kind: "transform", journey: "interactive-workspace" },
  { id: "save-project", entity: "project", kind: "create", journey: "interactive-workspace" },
], [{ id: "interactive-workspace", title: "Interactive calculation canvas", priority: "primary", steps: [
  { action: "enter the width and height", target: "numeric editor", operates: ["width", "height"], primitive: "textbox", expect: "the dimensions are visible" },
  { action: "calculate the result", target: "calculate", operates: ["calculate-result"], expect: "the derived result is visible" },
  { action: "move the selected object", target: "canvas", operates: ["move-object"], expect: "the object position changes" },
  { action: "save the project", target: "save", operates: ["save-project"], expect: "the project is saved" },
] }]);

test("the authoritative registry is total only for capabilities that actually ship", () => {
  assert.deepEqual(Object.keys(CAPABILITIES).sort(), [
    "booking", "contact", "crud", "interaction-primitives", "newsletter", "roles", "session", "wizard",
  ]);
  for (const capability of Object.values(CAPABILITIES)) {
    for (const key of [
      "id", "supportedOperations", "requiredInputs", "outputs", "stateOwnership",
      "persistenceSemantics", "dependencies", "compatibleUiInteractionPrimitives",
      "verificationSemantics", "responsibilitySemantics", "version", "implementation", "testContract",
    ]) assert.ok(Object.hasOwn(capability, key), `${capability.name}.${key}`);
    assert.ok(Array.isArray(capability.responsibilitySemantics.persistence));
    assert.ok(Array.isArray(capability.responsibilitySemantics.functional));
    assert.equal(capability.implementation.mode, "deterministic");
    assert.equal(capability.implementation.proven, true);
    assert.ok(capability.testContract.length, `${capability.name} needs a reusable test contract`);
  }
  assert.equal(Object.hasOwn(CAPABILITIES, "canvas"), false, "desired behavior is not invented as a proven capability");
  assert.equal(Object.hasOwn(CAPABILITIES, "calculation"), false);
  assert.equal(Object.hasOwn(CAPABILITIES, "export"), false);
});

test("three structurally different contracts map every journey before generation", () => {
  const [crud, transaction, interactive] = [CRUD, TRANSACTION, INTERACTIVE].map(deriveBuildSpec);
  for (const spec of [crud, transaction, interactive]) {
    assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));
    assert.equal(validateCapabilityGraph(spec.capabilityGraph, spec.contract, spec.interactionContract).ok, true);
    assert.equal(spec.capabilityGraph.journeys.length, spec.contract.journeys.length);
    assert.ok(spec.capabilityGraph.journeys.every((journey) => journey.requiredNodeIds.length));
    assert.ok(spec.capabilityGraph.nodes.some((node) => node.id === "capability:crud"));
    assert.ok(spec.capabilityGraph.nodes.some((node) => node.id === "capability:interaction-primitives"));
  }
  assert.ok(transaction.capabilityGraph.nodes.some((node) => node.id === "capability:wizard"));
  const custom = interactive.capabilityGraph.nodes.find((node) => node.type === "custom_behavior");
  assert.ok(custom, "unsupported calculation/canvas behavior is explicit, not rejected");
  assert.equal(custom.extension.module, "src/extensions/custom/interactive-workspace.js");
  assert.ok(custom.supportedOperations.includes("calculate"));
});

test("composition is byte-stable, protected, and preserves the model-owned configuration seam", () => {
  const spec = deriveBuildSpec(TRANSACTION);
  const first = composeCapabilityFoundation(REACT_VITE, spec.capabilityGraph);
  const second = composeCapabilityFoundation(REACT_VITE, spec.capabilityGraph);
  assert.deepEqual(first, second);
  assert.ok(first.tree["src/lib/capabilities/composed/crud.js"].includes("makeEntityStore"));
  assert.ok(first.tree["src/lib/capabilities/composed/wizard.js"].includes("makeWizardMachine"));
  assert.equal(validateCapabilityComposition(first.tree, spec.capabilityGraph, first.plan).ok, true);

  const config = "export const capabilityConfiguration = { wizard: { x: {} } };";
  const refreshed = composeCapabilityFoundation({ ...first.tree,
    "src/extensions/capabilityConfiguration.js": config,
  }, spec.capabilityGraph);
  assert.equal(refreshed.tree["src/extensions/capabilityConfiguration.js"], config,
    "a deterministic refresh must not overwrite model-owned domain configuration");

  const rejected = applyPatches(first.tree, [{
    file: "src/lib/capabilities/composed/wizard.js", newFile: null, content: null,
    deleteFile: null, replaceFile: null,
    ops: [{ op: "append", symbol: null, content: "// rewrite" }],
  }]);
  assert.match(rejected.rejected[0].reason, /protected platform infrastructure/);
});

test("generation receives graph, composed interfaces, extension points, and protected ownership", () => {
  const spec = deriveBuildSpec(INTERACTIVE);
  const prompt = renderPatchPrompt({
    step: "core", contract: spec.contract, tiers: spec.tiers, tree: REACT_VITE,
    journey: spec.contract.journeys[0], modulePlan: spec.modulePlan,
    moduleContracts: spec.moduleContracts, capabilityGraph: spec.capabilityGraph,
    compositionPlan: spec.compositionPlan,
  });
  assert.match(prompt, /CAPABILITY GRAPH \(authoritative behavior\/state\/data-flow ownership/);
  assert.match(prompt, /DETERMINISTIC CAPABILITY COMPOSITION/);
  assert.match(prompt, /src\/lib\/capabilities\/composed\/crud\.js/);
  assert.match(prompt, /src\/extensions\/custom\/interactive-workspace\.js/);
  assert.match(prompt, /PROVIDED AND PROTECTED/);
  assert.match(prompt, /custom_behavior/);
});

test("one custom module can be corrected without replacing composed capability modules", () => {
  const spec = deriveBuildSpec(INTERACTIVE);
  const composed = composeCapabilityFoundation(REACT_VITE, spec.capabilityGraph);
  const extension = spec.compositionPlan.extensionPoints[0];
  const missing = validateModuleConformance(composed.tree, {
    contract: spec.contract, modulePlan: spec.modulePlan, moduleContracts: spec.moduleContracts,
    interactionContract: spec.interactionContract, bindings: spec.bindings,
    capabilityGraph: spec.capabilityGraph,
  });
  assert.ok(missing.blocking.some((finding) => finding.code === "capability_composition_invalid"
    && finding.module === extension.module), "new composed builds require the bounded custom module");
  const tree = {
    ...composed.tree,
    [extension.module]: "export const wrongInterface = () => null;",
    "src/routes/HomePage.jsx": "export default function HomePage() { return <main>Interactive workspace</main>; }",
  };
  const report = validateModuleConformance(tree, {
    contract: spec.contract, modulePlan: spec.modulePlan, moduleContracts: spec.moduleContracts,
    interactionContract: spec.interactionContract, bindings: spec.bindings,
    capabilityGraph: spec.capabilityGraph,
  });
  assert.equal(report.ok, false);
  assert.ok(report.blocking.some((finding) => finding.code === "capability_composition_invalid"
    && finding.module === extension.module));
  const scope = moduleCorrectionScope(report, spec.moduleContracts);
  assert.deepEqual(scope.allowedFiles, [extension.module]);
  assert.ok(scope.allowedFiles.every((path) => !path.startsWith("src/lib/capabilities/composed/")));
});

test("scoping a failed journey leaves later capability/custom modules independently addressable", () => {
  const contract = { ...INTERACTIVE, journeys: [
    INTERACTIVE.journeys[0],
    { id: "second-workspace", title: "Second independent workspace", priority: "secondary", steps: [
      { action: "calculate another result", target: "calculate", operates: ["calculate-second"], expect: "another result is visible" },
    ] },
  ], operations: [...INTERACTIVE.operations,
    { id: "calculate-second", entity: "project", kind: "calculate", journey: "second-workspace" }],
  };
  const spec = deriveBuildSpec(contract);
  const first = scopeBuildSpec(spec, [contract.journeys[0]]);
  const second = scopeBuildSpec(spec, [contract.journeys[1]]);
  assert.ok(first.capabilityGraph.customBehavior.includes("custom_behavior:interactive-workspace"));
  assert.equal(first.capabilityGraph.customBehavior.includes("custom_behavior:second-workspace"), false);
  assert.ok(second.capabilityGraph.customBehavior.includes("custom_behavior:second-workspace"));
  assert.equal(second.capabilityGraph.customBehavior.includes("custom_behavior:interactive-workspace"), false);
});

test("CRUD capability reusable test contract executes create, read, update, delete", async () => {
  const rows = new Map();
  let id = 0;
  const db = { entity: () => ({
    async create(data) { const row = { id: `row-${++id}`, created_at: "now", data: { ...data } }; rows.set(row.id, row); return row; },
    async get(key) { return rows.get(key) || null; },
    async list() { return [...rows.values()]; },
    async update(key, data) { const row = rows.get(key); row.data = { ...data }; return row; },
    async delete(key) { rows.delete(key); },
    async count() { return rows.size; },
    subscribe() { return () => {}; },
  }) };
  const store = makeEntityStore("record", { db });
  const created = await store.create({ title: "First", status: "open" });
  assert.equal((await store.get(created.id)).title, "First");
  const updated = await store.update(created.id, { status: "closed" });
  assert.deepEqual({ title: updated.title, status: updated.status }, { title: "First", status: "closed" });
  await store.remove(created.id);
  assert.equal(await store.get(created.id), null);
});
