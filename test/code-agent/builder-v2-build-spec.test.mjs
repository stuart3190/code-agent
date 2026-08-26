// The canonical derived build specification.
//
// One contract used to be re-interpreted independently by the orchestrator, the interaction
// contract, the persistence plan and the prompt builder — four regex passes over the same
// model-written prose, free to drift from one another. This proves there is now one derivation,
// computed once and projected downward.

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSpecSummary, deriveBuildSpec, journeysInMountedScreenUnit, scopeBuildSpec,
} from "../../shell/server/lib/builderV2/buildSpec.mjs";
import { scopeCapabilityGraph } from "../../shell/server/lib/builderV2/capabilityGraph.mjs";
import { deriveModulePlan, journeyStepKinds } from "../../shell/server/lib/builderV2/contractTiering.mjs";
import {
  bindInteractionModulePlan, validateInteractionContract,
} from "../../shell/server/lib/builderV2/interactionContract.mjs";
import { scaffoldModulePlan } from "../../shell/server/lib/builderV2/scaffoldGraph.mjs";
import { lintJourneyControllerMounts } from "../../shell/server/lib/builderV2/staticApplicationGate.mjs";

const CONTRACT = {
  summary: "A workshop booking system with review, recovery and cancellation",
  entities: [{ name: "booking", fields: [{ name: "date" }, { name: "slot" }, { name: "email" }] }],
  operations: [{ id: "create-booking", entity: "booking", action: "create" }],
  routes: [{ path: "/", name: "Booking" }, { path: "/manage", name: "Manage" }],
  auth: { required: false },
  journeys: [
    { id: "book", title: "Complete a booking", priority: "primary", steps: [
      { action: "select a date", target: "date", expect: "date becomes active" },
      { action: "select a slot", target: "slot", expect: "slot becomes active" },
      { action: "enter your email", target: "email", expect: "email accepted" },
      { action: "review the booking", target: "review", expect: "review shows the values" },
      { action: "confirm booking", target: "confirm", expect: "booking reference" },
      { action: "cancel booking", target: "cancel", expect: "cancelled status" },
    ] },
    { id: "newsletter", title: "Join the newsletter", priority: "secondary", steps: [
      { action: "submit the newsletter form", target: "/manage", expect: "subscribed confirmation" },
    ] },
  ],
};

test("one derivation produces every downstream view of the contract", () => {
  const spec = deriveBuildSpec(CONTRACT);
  for (const key of ["tiers", "bindings", "modulePlan", "interactionContract", "moduleContracts",
    "persistencePlan", "imageIntents", "verdict"]) {
    assert.ok(spec[key], `the spec carries ${key}`);
  }
  assert.equal(spec.verdict.ok, true, spec.verdict.problems?.join("; "));
  // The contract handed downward already carries its interaction contract, so no consumer has
  // to rebuild one — which is how the two used to diverge.
  assert.equal(spec.contract.interactionContract, spec.interactionContract);
});

test("deriving twice is identical — the derivation has no hidden state", () => {
  const a = buildSpecSummary(deriveBuildSpec(CONTRACT));
  const b = buildSpecSummary(deriveBuildSpec(CONTRACT));
  assert.deepEqual(a, b);
});

test("every view agrees about ownership: module plan, interactions and persistence", () => {
  const spec = deriveBuildSpec(CONTRACT);
  const plannedPaths = new Set(spec.modulePlan.map((module) => module.path));

  // Interaction ownership only ever names modules the plan actually contains.
  for (const flow of spec.interactionContract.flows) {
    for (const owner of flow.responsibleModules || []) {
      assert.ok(plannedPaths.has(owner), `${flow.id} owner ${owner} is not in the module plan`);
    }
  }
  // Persistence ownership names the same adapters, by the same paths.
  for (const module of spec.persistencePlan.modules) {
    assert.ok(plannedPaths.has(module.path), `${module.path} is not in the module plan`);
  }
  // Per-module contracts are generated for exactly the planned modules.
  assert.deepEqual(
    spec.moduleContracts.specifications.map((row) => row.path).sort(),
    [...plannedPaths].sort(),
  );
});

test("journey modules and their generation contracts do not absorb same-role flows from other journeys", () => {
  const spec = deriveBuildSpec(CONTRACT);
  const bookOwner = spec.scaffoldGraph.journeyOwnership.find((owner) => owner.journeyId === "book");
  const newsletterOwner = spec.scaffoldGraph.journeyOwnership.find((owner) => owner.journeyId === "newsletter");
  const bookFlow = spec.modulePlan.find((module) => module.path === bookOwner.mountedModule);
  const newsletterFlow = spec.modulePlan.find((module) => module.path === newsletterOwner.mountedModule);
  assert.deepEqual(bookFlow.journeyIds, ["book"]);
  assert.deepEqual(newsletterFlow.journeyIds, ["newsletter"]);

  const bookContract = spec.moduleContracts.specifications.find((row) => row.path === bookFlow.path);
  const newsletterContract = spec.moduleContracts.specifications.find((row) => row.path === newsletterFlow.path);
  assert.deepEqual(bookContract.ownedJourneys, ["book"]);
  assert.ok(bookContract.semanticInteractions.every((flow) => flow.journeyId === "book"));
  assert.deepEqual(newsletterContract.ownedJourneys, ["newsletter"]);
  assert.ok(newsletterContract.semanticInteractions.every((flow) => flow.journeyId === "newsletter"));
});

test("scoped capability graphs remove unrelated shared-node interactions and data-flow edges", () => {
  const spec = deriveBuildSpec(CONTRACT);
  const scoped = scopeCapabilityGraph(spec.capabilityGraph, [CONTRACT.journeys[0]]);
  const interactionIds = new Set(scoped.journeys.flatMap((journey) => (
    journey.dataFlows || []
  )).map((flow) => flow.interactionId));
  const nodeIds = new Set(scoped.nodes.map((node) => node.id));

  assert.deepEqual(scoped.journeys.map((journey) => journey.journeyId), ["book"]);
  assert.ok(scoped.nodes.every((node) => (node.journeys || []).every((id) => id === "book")));
  assert.ok(scoped.nodes.every((node) => (node.interactions || []).every((id) => interactionIds.has(id))));
  assert.ok(scoped.edges.every((edge) => (
    (nodeIds.has(edge.from) || interactionIds.has(edge.from))
      && (nodeIds.has(edge.to) || interactionIds.has(edge.to))
  )));
  assert.doesNotMatch(JSON.stringify(scoped), /newsletter:/);
});

test("scoping an increment narrows the same object rather than recomputing it", () => {
  const spec = deriveBuildSpec(CONTRACT);
  const essential = CONTRACT.journeys.filter((journey) => journey.priority === "primary");
  const scoped = scopeBuildSpec(spec, essential);

  assert.deepEqual(scoped.scopedJourneyIds, ["book"]);
  assert.equal(scoped.contract, spec.contract, "the contract identity is preserved");
  assert.ok(scoped.interactionContract.flows.every((flow) => flow.journeyId === "book"));
  assert.ok(scoped.interactionContract.flows.length < spec.interactionContract.flows.length
    || spec.interactionContract.flows.every((flow) => flow.journeyId === "book"));
  // Every scoped view stays mutually consistent.
  const scopedPaths = new Set(scoped.modulePlan.map((module) => module.path));
  assert.deepEqual(scoped.moduleContracts.specifications.map((row) => row.path).sort(), [...scopedPaths].sort());
});

test("a mounted screen is one generation unit across its contracted journeys", () => {
  const contract = {
    summary: "A software catalogue with a separate preferences screen",
    entities: [], operations: [], auth: { required: false },
    routes: [{ path: "/", name: "Catalogue" }, { path: "/preferences", name: "Preferences" }],
    journeys: [
      { id: "browse-catalogue", title: "Browse catalogue", priority: "primary",
        steps: [{ action: "open the catalogue", target: "/", expect: "catalogue entries are visible" }] },
      { id: "empty-catalogue-result", title: "See an empty result", priority: "secondary",
        steps: [{ action: "filter the catalogue", target: "/", expect: "an empty result is visible" }] },
      { id: "open-preferences", title: "Open preferences", priority: "secondary",
        steps: [{ action: "open preferences", target: "/preferences", expect: "preferences are visible" }] },
    ],
  };
  const spec = deriveBuildSpec(contract);
  const unit = journeysInMountedScreenUnit(spec, [contract.journeys[0]]);

  assert.deepEqual(unit.map((journey) => journey.id), ["browse-catalogue", "empty-catalogue-result"]);
  assert.equal(spec.scaffoldGraph.journeyOwnership[0].mountedModule,
    spec.scaffoldGraph.journeyOwnership[1].mountedModule);
  assert.notEqual(spec.scaffoldGraph.journeyOwnership[0].mountedModule,
    spec.scaffoldGraph.journeyOwnership[2].mountedModule);
});

test("a crowded mounted screen has one bounded shared journey controller", () => {
  const contract = {
    summary: "A public software catalogue with transient search, filters, selection, and favourites",
    entities: [], operations: [], auth: { required: false },
    routes: [{ path: "/", name: "Software Catalogue" }],
    journeys: [
      { id: "browse-filter", title: "Browse and filter software", priority: "primary", steps: [
        { action: "enter a catalogue search", target: "search", expect: "matching software is visible" },
        { action: "select a category filter", target: "category", expect: "the matching category remains visible" },
        { action: "select a software item", target: "software card", expect: "item details are visible" },
      ] },
      { id: "clear-results", title: "Clear an empty result", priority: "secondary", steps: [
        { action: "enter an unmatched search", target: "search", expect: "an empty result is visible" },
        { action: "clear the catalogue search", target: "clear", expect: "software cards are visible again" },
      ] },
      { id: "manage-favourites", title: "Manage transient favourites", priority: "secondary", steps: [
        { action: "select a software item", target: "software card", expect: "item details are visible" },
        { action: "add the selected item", target: "favourites", expect: "the item is visible in favourites" },
        { action: "remove the selected item", target: "favourites", expect: "the favourites area is empty" },
      ] },
    ],
  };
  const spec = deriveBuildSpec(contract);
  const screen = spec.modulePlan.find((module) => module.providedBy === "scaffold_screen_slot");
  const childFlows = spec.modulePlan.filter((module) => /flow composition/i.test(module.role || ""));
  const plannedPaths = new Set(spec.modulePlan.map((module) => module.path));

  assert.deepEqual(screen.journeyIds, contract.journeys.map((journey) => journey.id));
  assert.equal(childFlows.length, 1);
  assert.deepEqual(childFlows[0].journeyIds, contract.journeys.map((journey) => journey.id));
  assert.ok(childFlows[0].path.startsWith("src/components/"));
  assert.equal(childFlows[0].sharedControllerFor, screen.scaffoldScreenId);
  assert.equal(screen.journeyController, childFlows[0].path);
  const expectedChildImports = [`../../${childFlows[0].path.replace(/^src\//, "")}`];
  assert.deepEqual(screen.requiredImports, expectedChildImports,
    "the mounted coordinator is explicitly contracted to integrate one shared controller");
  for (const flow of spec.interactionContract.flows) {
    if (String(flow.stateOwner || "").startsWith("src/components/")) {
      assert.ok(plannedPaths.has(flow.stateOwner), `${flow.id} state owner was removed from the canonical plan`);
    }
  }
  assert.deepEqual(spec.moduleContracts.specifications.map((row) => row.path).sort(),
    [...plannedPaths].sort());
  assert.deepEqual(spec.moduleContracts.specifications
    .find((row) => row.path === screen.path).requiredImports, expectedChildImports);
  assert.equal(spec.moduleContracts.specifications
    .find((row) => row.path === screen.path).semanticInteractions.length, 0,
  "the mounted screen composes the controller instead of duplicating its controls");
  assert.ok(spec.moduleContracts.specifications
    .find((row) => row.path === childFlows[0].path).semanticInteractions.length > 0);
});

test("a shared software-catalogue controller retains every planned custom behaviour module", () => {
  const journeyIds = ["browse-catalogue", "empty-result", "session-favourites"];
  const graph = {
    screens: [{ screenId: "catalogue-screen", module: "src/screens/scaffold/CatalogueScreen.jsx",
      routePath: "/" }],
    journeyOwnership: journeyIds.map((journeyId) => ({ journeyId, screenId: "catalogue-screen" })),
    extensions: journeyIds.map((journeyId) => ({
      extensionId: `custom_behavior:${journeyId}`,
      module: `src/extensions/custom/${journeyId}.js`,
      owningJourneys: [journeyId],
      requiredExports: [`run${journeyId.split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join("")}CustomBehavior`],
      writes: [`${journeyId}.custom.result`],
    })),
  };
  const existingPlan = journeyIds.map((journeyId) => ({
    path: `src/components/${journeyId}/${journeyId}Flow.jsx`,
    role: "step navigation and flow composition",
    journeyIds: [journeyId],
  }));
  const plan = scaffoldModulePlan(graph, existingPlan);
  const children = plan.filter((module) => /flow composition/i.test(module.role || ""));
  assert.equal(children.length, 1);
  assert.deepEqual(children[0].journeyIds, journeyIds);
  assert.deepEqual(children[0].requiredImports,
    journeyIds.map((journeyId) => `../../extensions/custom/${journeyId}.js`));
});

test("a mounted screen must render its shared journey controller exactly once", () => {
  const modulePlan = [{
    path: "src/screens/scaffold/SoftwareCatalogueScreen.jsx",
    providedBy: "scaffold_screen_slot", journeyIds: ["browse", "clear", "favourites"],
    journeyController: "src/components/browse/BrowseFlow.jsx",
  }];
  const screen = (body) => `import BrowseFlow from "../../components/browse/BrowseFlow.jsx";\n`
    + `export default function SoftwareCatalogueScreen(){ return (${body}); }`;
  assert.deepEqual(lintJourneyControllerMounts({
    [modulePlan[0].path]: screen("<BrowseFlow />"),
  }, modulePlan), []);
  assert.equal(lintJourneyControllerMounts({
    [modulePlan[0].path]: screen("<main />"),
  }, modulePlan)[0].mounts, 0);
  assert.equal(lintJourneyControllerMounts({
    [modulePlan[0].path]: screen("<><BrowseFlow /><BrowseFlow /></>"),
  }, modulePlan)[0].mounts, 2);
});

test("shared controllers retain only the journeys from their own mounted screen", () => {
  const plan = { version: 2, flows: [
    { id: "browse:1", journeyId: "browse", stateOwner: "src/components/old/BrowseFlow.jsx",
      responsibleModules: ["src/components/old/BrowseFlow.jsx"], control: {
        stateOwner: "src/components/old/BrowseFlow.jsx", validationOwner: "src/components/old/BrowseFlow.jsx",
      } },
    { id: "preferences:1", journeyId: "preferences", stateOwner: "src/components/old/PreferencesFlow.jsx",
      responsibleModules: ["src/components/old/PreferencesFlow.jsx"], control: {
        stateOwner: "src/components/old/PreferencesFlow.jsx", validationOwner: "src/components/old/PreferencesFlow.jsx",
      } },
  ] };
  const modules = [
    { path: "src/components/catalogue/CatalogueFlow.jsx", role: "shared step navigation and flow composition",
      journeyIds: ["browse", "clear", "favourites"] },
    { path: "src/components/preferences/PreferencesFlow.jsx", role: "shared step navigation and flow composition",
      journeyIds: ["preferences", "reset", "preview"] },
  ];
  const rebound = bindInteractionModulePlan(plan, modules);
  assert.equal(rebound.flows[0].stateOwner, modules[0].path);
  assert.deepEqual(rebound.flows[0].responsibleModules, [modules[0].path]);
  assert.equal(rebound.flows[1].stateOwner, modules[1].path);
  assert.deepEqual(rebound.flows[1].responsibleModules, [modules[1].path]);
});

test("bounded custom behaviour keeps its helper responsibility but binds visible state to the mounted controller", () => {
  const extension = "src/extensions/custom/clear-filters.js";
  const controller = "src/components/catalogue/CatalogueFlow.jsx";
  const plan = { version: 2, flows: [{
    id: "clear:1", journeyId: "clear", stateOwner: extension,
    responsibleModules: [extension], control: {
      stateOwner: extension, validationOwner: extension,
    },
  }] };
  const rebound = bindInteractionModulePlan(plan, [
    { path: extension, role: "bounded custom behaviour", journeyIds: ["clear"] },
    { path: controller, role: "shared step navigation and flow composition", journeyIds: ["clear"] },
  ]);
  assert.equal(rebound.flows[0].stateOwner, controller);
  assert.equal(rebound.flows[0].control.stateOwner, controller);
  assert.equal(rebound.flows[0].control.validationOwner, controller);
  assert.deepEqual(rebound.flows[0].responsibleModules, [extension, controller]);
});

test("the module plan derives its vocabulary from the contract, never from a domain", () => {
  const inventory = {
    summary: "An inventory system for stock levels",
    entities: [{ name: "stockItem", fields: [{ name: "sku" }, { name: "quantity" }] }],
    operations: [{ id: "adjust-stock", entity: "stockItem", action: "update" }],
    routes: [{ path: "/", name: "Stock" }], auth: { required: false },
    journeys: [{ id: "adjust-stock", title: "Adjust stock", priority: "primary", steps: [
      { action: "select an item", target: "sku", expect: "item becomes active" },
      { action: "enter the new quantity", target: "quantity", expect: "quantity accepted" },
      { action: "review the adjustment", target: "review", expect: "review shows the quantity" },
      { action: "create the adjustment", target: "create", expect: "adjustment reference" },
    ] }],
  };
  const plan = deriveModulePlan(inventory, inventory.journeys);
  assert.ok(plan.length, "an inventory workflow earns a module plan too");
  assert.equal(plan.some((module) => /booking|reservation|wizard/i.test(module.path)), false,
    `no foreign domain vocabulary: ${plan.map((m) => m.path).join(", ")}`);
  assert.ok(plan.some((module) => module.path === "src/components/adjust-stock/AdjustStockFlow.jsx"));
  assert.ok(plan.some((module) => module.path === "src/data/crud.js"));
});

test("step kinds are read once and shared by the plan and the interaction contract", () => {
  assert.deepEqual(journeyStepKinds(CONTRACT.journeys[0]),
    ["selection", "input", "review", "mutation", "cancellation"]);
  const spec = deriveBuildSpec(CONTRACT);
  const flowKinds = new Set(spec.interactionContract.flows
    .filter((flow) => flow.journeyId === "book").map((flow) => flow.kind));
  for (const kind of journeyStepKinds(CONTRACT.journeys[0])) {
    assert.ok(flowKinds.has(kind), `the interaction contract agrees about ${kind}`);
  }
});

test("a structurally impossible data flow is still refused before generation", () => {
  // The pre-generation guard is unchanged by this correction: an interaction graph that cannot
  // be implemented is still rejected before a single token is spent.
  const broken = validateInteractionContract({ version: 1, flows: [
    { id: "x:1:review", journeyId: "x", kind: "review", stateOwner: "src/x.jsx", reads: [], writes: [] },
    { id: "x:2:mutation", journeyId: "x", kind: "mutation", stateOwner: "src/x.jsx", reads: [], writes: ["x.durable.record"] },
    { id: "x:3:cancellation", journeyId: "x", kind: "cancellation", stateOwner: "src/x.jsx",
      capability: null, reads: ["x.durable.record"], writes: ["x.durable.status"] },
  ] });
  assert.equal(broken.ok, false);
  const problems = broken.problems.join("; ");
  assert.match(problems, /review has no source values/);
  assert.match(problems, /mutation consumes no contracted input state/);
  assert.match(problems, /cancellation has no durable operation owner/);

  // And a well-formed contract passes it.
  assert.equal(deriveBuildSpec(CONTRACT).verdict.ok, true);
});
