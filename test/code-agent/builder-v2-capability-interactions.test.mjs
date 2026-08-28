import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import { actionIdFor, deriveVerificationManifest } from "../../shell/server/lib/builderV2/verificationManifest.mjs";

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

test("an operation step's declared outputs satisfy later operation dependencies", () => {
  const spec = deriveBuildSpec(makeContract({
    fields: ["recordName", "recordCreatedById", "recordId", "childTitle", "childId"],
    operations: [
      {
        id: "create-record", entity: "record", kind: "create", journey: "primary-flow",
        responsibilities: [
          { type: "functional", reads: ["recordName"], writes: ["recordCreatedById"] },
          { type: "persistence", reads: ["recordName", "recordCreatedById"],
            writes: ["recordId", "recordName", "recordCreatedById"] },
        ],
      },
      {
        id: "create-child", entity: "record", kind: "create", journey: "primary-flow",
        responsibilities: [
          { type: "functional", reads: ["recordId", "childTitle"], writes: ["childTitle"] },
          { type: "persistence", reads: ["recordId", "childTitle"],
            writes: ["childId", "recordId", "childTitle"] },
        ],
      },
    ],
    steps: [
      { action: "enter a record name", target: "record name", operates: ["recordName"],
        expect: "the record name is visible" },
      { action: "create the record", target: "create record", operates: ["create-record"],
        reads: ["recordName"], produces: ["recordId"], expect: "the created record is visible" },
      { action: "enter a child title", target: "child title", operates: ["childTitle"],
        expect: "the child title is visible" },
      { action: "create the child", target: "create child", operates: ["create-child"],
        reads: ["recordId", "childTitle"], produces: ["childId"], expect: "the child is visible" },
      { action: "review the child", target: "child", reads: ["childId"],
        expect: "the child remains visible" },
    ],
  }));

  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));
  assert.ok(interactionFor(spec, "create-record").writes.includes("primary-flow.custom.recordId"));
  assert.ok(interactionFor(spec, "create-child").reads.includes("primary-flow.custom.recordId"));
  assert.ok(interactionFor(spec, "create-child").writes.includes("primary-flow.custom.childId"));
  assert.ok(!spec.verdict.problems.some((problem) => problem.includes("reads state before it is produced")));
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

test("registered auth surface resolves to session ownership with explicit session output", () => {
  const spec = deriveBuildSpec(makeContract({
    entity: "accountView", fields: ["ownerEmail"],
    operations: [{
      id: "sign-in", entity: "accountView", kind: "auth", journey: "primary-flow",
      responsibilities: [{
        type: "persistence", capability: "auth", capabilityMethod: "signIn",
        reads: ["ownerEmail"], writes: [],
      }],
    }],
    steps: [
      { action: "enter an email", target: "email", operates: ["ownerEmail"], expect: "the email is visible" },
      { action: "sign in", target: "sign-in form", operates: ["sign-in"], expect: "the workspace is visible" },
    ],
  }));

  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));
  const responsibility = spec.capabilityGraph.operationResponsibilities
    .find((candidate) => candidate.operationId === "sign-in").responsibilities[0];
  assert.equal(responsibility.type, "persistence");
  assert.equal(responsibility.capabilityId, "session");
  assert.equal(responsibility.capabilityMethod, "signIn");
  assert.equal(responsibility.owner, "capability:session");
  assert.ok(responsibility.reads.includes("primary-flow.draft.ownerEmail"));
  assert.ok(responsibility.reads.includes("primary-flow.input.email"));
  assert.ok(responsibility.reads.includes("primary-flow.input.password"));
  assert.deepEqual(responsibility.writes, ["primary-flow.capability.session.session"]);
  assert.ok(spec.capabilityGraph.nodes.some((node) => node.id === "capability:session"));
  assert.ok(!spec.capabilityGraph.nodes.some((node) => node.id === "capability:auth"));
  assert.deepEqual(spec.bindings.find((binding) => binding.name === "session").requiredMethods, ["signIn"]);

  const flow = interactionFor(spec, "sign-in");
  assertCommonSemantics(flow, "sign-in");
  assert.equal(flow.stateOwner, "src/lib/capabilities/composed/session.js");
  assert.equal(flow.capabilityId, "session");
  assert.equal(flow.capabilityMethod, "signIn");
  assert.deepEqual(flow.writes, ["primary-flow.capability.session.session"]);
  assert.ok(spec.compositionPlan.interfaces.find((entry) => entry.module.endsWith("/session.js"))
    .exports.includes("signIn"));
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

test("read-like custom operations own an explicit transient result instead of inventing an entity write", () => {
  const spec = deriveBuildSpec(makeContract({
    entity: "document", fields: ["sourceContent"],
    operations: [{
      id: "render-output", entity: "document", kind: "read", journey: "primary-flow",
      responsibilities: [{
        type: "functional", behavior: "render the stored source into a browser-delivered artifact",
        reads: ["sourceContent"], writes: [],
      }],
    }],
    steps: [
      { action: "enter source content", target: "source", operates: ["sourceContent"], expect: "the source is visible" },
      { action: "render the output", target: "render control", reads: ["render-output"], expect: "the rendered artifact is offered" },
    ],
  }));

  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));
  const operation = spec.capabilityGraph.operationResponsibilities
    .find((candidate) => candidate.operationId === "render-output");
  const functional = operation.responsibilities.find((responsibility) => responsibility.requiresTransformation);
  assert.deepEqual(functional.outputEffect, {
    type: "transient_result", effect: "read_result", operationKind: "read", durable: false,
    statePath: "primary-flow.effect.render-output",
  });
  assert.deepEqual(functional.writes, ["primary-flow.effect.render-output"]);
  assert.equal(functional.persistenceHandoff, null);
  assert.equal(functional.persistenceSource.capabilityId, "crud");
  assert.equal(functional.persistenceSource.capabilityMethod, "get");

  const flow = interactionFor(spec, "render-output");
  assertCommonSemantics(flow, "render-output");
  assert.deepEqual(flow.writes, ["primary-flow.effect.render-output"]);
  assert.equal(flow.outputEffect.effect, "read_result");
  assert.equal(flow.persistenceHandoff, null);
  assert.equal(flow.persistenceSource.capabilityMethod, "get");
  assert.match(String(flow.verificationObservation), /artifact/i);
  assert.ok(spec.capabilityGraph.edges.some((edge) => edge.type === "persistence_source"
    && edge.from === "capability:crud" && edge.to === functional.customBehavior));
});

test("terminal export operations produce a bounded transient artifact with no fake CRUD handoff", () => {
  const spec = deriveBuildSpec(makeContract({
    entity: "report", fields: ["rows"],
    operations: [{
      id: "deliver-report", entity: "report", kind: "export", journey: "primary-flow",
      responsibilities: [{
        type: "functional", behavior: "encode report rows and deliver the result",
        reads: ["rows"], writes: [],
      }],
    }],
    steps: [
      { action: "enter report rows", target: "rows", operates: ["rows"], expect: "the rows are visible" },
      { action: "deliver the report", target: "delivery control", reads: ["deliver-report"], expect: "a downloadable report is offered" },
    ],
  }));

  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));
  const flow = interactionFor(spec, "deliver-report");
  assertCommonSemantics(flow, "deliver-report");
  assert.equal(flow.outputEffect.effect, "artifact");
  assert.deepEqual(flow.writes, ["primary-flow.effect.deliver-report"]);
  assert.equal(flow.persistenceHandoff, null);
  assert.equal(flow.persistenceSource, null);
  assert.ok(flow.customBehaviorModule);
  assert.ok(flow.customBehaviorExports.length);
});

test("an operation identity in structured reads remains linked when the same step operates fields", () => {
  const spec = deriveBuildSpec(makeContract({
    entity: "preset", fields: ["sourceSpecification", "presetName", "appliedSpecification"],
    operations: [
      {
        id: "create-preset", entity: "preset", kind: "create", journey: "primary-flow",
        responsibilities: [{
          type: "functional", behavior: "create a reusable preset from the supplied specification",
          reads: ["sourceSpecification"], writes: ["presetName"],
        }],
      },
      {
        id: "apply-preset", entity: "preset", kind: "update", journey: "primary-flow",
        responsibilities: [{
          type: "functional", behavior: "apply the selected preset to the working specification",
          reads: ["presetName"], writes: ["appliedSpecification"],
        }],
      },
    ],
    steps: [
      { action: "enter a source specification", target: "specification", operates: ["sourceSpecification"], expect: "the specification is visible" },
      { action: "create a named preset", target: "preset form", operates: ["presetName"], reads: ["create-preset", "sourceSpecification"], expect: "the preset name is visible" },
      { action: "apply the named preset", target: "preset selector", operates: ["appliedSpecification"], reads: ["apply-preset", "presetName"], expect: "the applied specification is visible" },
    ],
  }));

  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));
  const create = spec.capabilityGraph.operationResponsibilities
    .find((operation) => operation.operationId === "create-preset");
  const apply = spec.capabilityGraph.operationResponsibilities
    .find((operation) => operation.operationId === "apply-preset");
  assert.equal(create.stepIndex, 1);
  assert.equal(apply.stepIndex, 2);
  assert.ok(interactionFor(spec, "create-preset").reads.includes("primary-flow.draft.sourceSpecification"));
  assert.ok(interactionFor(spec, "apply-preset").reads.includes("primary-flow.draft.presetName"));
  assert.ok(!spec.verdict.problems.some((problem) => problem.includes("reads state before it is produced")));
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
    "interaction_contract_semantics_incomplete operation=unowned-transform interaction=primary-flow:2:operation:unownedtransform missing=reads,writes",
  ));
  assert.deepEqual(spec.verdict.interaction.issues, [{
    code: "interaction_contract_semantics_incomplete",
    operationId: "unowned-transform",
    interactionId: "primary-flow:2:operation:unownedtransform",
    missingFields: ["reads", "writes"],
  }]);
});

test("an operation no step names claims the interaction the journey already derived", () => {
  // The journey's prose derives the commit; nothing links the operation to it by identity. A
  // second, parallel interaction used to be fabricated for the operation — the generator was
  // briefed to build two commits for one transition, and the fabricated one read the capability's
  // parameter names while the contracted field values stayed on the flow nobody had bound.
  const spec = deriveBuildSpec(makeContract({
    fields: ["contactName", "notes"],
    operations: [{ id: "update-record", entity: "record", kind: "update", journey: "primary-flow" }],
    steps: [
      { action: "edit the contact name and notes", target: "edit form", expect: "the edited contact name and notes are visible" },
      { action: "update the record", target: "save control", expect: "the saved record shows the edited contact name" },
    ],
  }));
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));

  const mutations = spec.interactionContract.flows.filter((flow) => flow.kind === "mutation");
  assert.equal(mutations.length, 1, `one durable commit, got ${mutations.map((flow) => flow.id).join(", ")}`);
  assert.equal(mutations[0].operationId, "update-record");
  assert.ok(mutations[0].reads.some((path) => path.includes(".draft.contactName")),
    `the commit lost the contracted field values: ${JSON.stringify(mutations[0].reads)}`);
});

test("an operation identified by name binds exactly like one identified by id", () => {
  // `id` and `name` are both accepted as an operation reference by the shared contract layer. The
  // graph read `id` alone, so a name-only operation had identity undefined — and matched EVERY
  // flow whose operationId was also unset, stamping capability semantics onto navigation, input
  // and review interactions that perform nothing.
  const spec = deriveBuildSpec(makeContract({
    fields: ["title"],
    operations: [{ name: "save-record", entity: "record", kind: "create", journey: "primary-flow" }],
    steps: [
      { action: "open the workspace", target: "/", expect: "the workspace is visible" },
      { action: "enter a title", target: "title", operates: ["title"], expect: "the title is visible" },
      { action: "review the entry", target: "review panel", expect: "the entered title is visible before saving" },
      { action: "save the record", target: "save control", expect: "a saved status message is visible" },
    ],
  }));
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));

  const commit = spec.interactionContract.flows.find((flow) => flow.kind === "mutation");
  assert.equal(commit.operationId, "save-record", "the operation's own identity never reached the graph");
  for (const kind of ["navigation", "input", "review"]) {
    for (const flow of spec.interactionContract.flows.filter((flow) => flow.kind === kind)) {
      assert.equal(flow.operationId ?? null, null,
        `a ${kind} interaction was claimed by an operation it does not perform (${flow.id})`);
    }
  }
});

test("one declared operation keeps one action identity across journey-specific wording", () => {
  const contract = {
    summary: "A software catalogue with local browsing controls",
    projectType: "tool", auth: { required: false, rules: [] }, integrations: [], states: [],
    acceptance: [], deferred: [],
    entities: [{ name: "catalogueItem", fields: [{ name: "title", type: "string" }] }],
    operations: [{ id: "filter-catalogue", entity: "catalogueItem", kind: "read",
      journey: "browse-catalogue" }],
    routes: [{ path: "/", name: "Catalogue" }],
    journeys: [
      { id: "browse-catalogue", title: "Browse catalogue", priority: "primary", steps: [{
        action: "search catalogue entries", target: "catalogue search and filter controls",
        operates: ["filter-catalogue"], expect: "matching entries are visible",
      }] },
      { id: "empty-catalogue-result", title: "See an empty result", priority: "secondary", steps: [{
        action: "search for an absent entry", target: "catalogue search control",
        operates: ["filter-catalogue"], expect: "an empty result is visible",
      }] },
    ],
  };
  const spec = deriveBuildSpec(contract);
  const flows = spec.interactionContract.flows
    .filter((flow) => flow.operationId === "filter-catalogue" && flow.control);
  const expectedId = actionIdFor("filter-catalogue");

  assert.equal(flows.length, 2, JSON.stringify(flows));
  assert.deepEqual([...new Set(flows.map((flow) => flow.control.machineId))], [expectedId]);
  const actions = deriveVerificationManifest(spec).actions
    .filter((action) => flows.some((flow) => flow.journeyId === action.journeyId));
  assert.ok(actions.length >= 2, JSON.stringify(actions));
  assert.ok(actions.every((action) => action.id === expectedId), JSON.stringify(actions));
});

test("shared transient controls provide defaults to an independent catalogue journey", () => {
  const contract = {
    summary: "A software catalogue with shared local filter controls",
    projectType: "tool", auth: { required: false, rules: [] }, integrations: [], states: [],
    acceptance: [], deferred: [],
    entities: [{
      name: "catalogueViewState",
      storage: "client-only transient state; not persisted",
      fields: [
        { name: "searchQuery", type: "string", required: true },
        { name: "categoryFilter", type: "string", required: true },
        { name: "pricingFilter", type: "string", required: true },
        { name: "filteredSoftwareIds", type: "string[]", required: true },
      ],
    }],
    operations: [{
      id: "filter-catalogue", entity: "catalogueViewState", kind: "update", journey: "empty-search",
      responsibilities: [{ type: "functional",
        reads: ["searchQuery", "categoryFilter", "pricingFilter"], writes: ["filteredSoftwareIds"],
        behavior: "filter in-code catalogue items using the current local controls" }],
    }],
    routes: [{ path: "/", name: "Catalogue" }],
    journeys: [
      { id: "browse-controls", title: "Browse with filters", priority: "primary", steps: [
        { action: "choose a category", target: "category filter", operates: ["categoryFilter"],
          expect: "the category selection is visible", verificationValues: { categoryFilter: "Editors" } },
        { action: "choose a pricing band", target: "pricing filter", operates: ["pricingFilter"],
          expect: "the pricing selection is visible", verificationValues: { pricingFilter: "Team" } },
      ] },
      { id: "empty-search", title: "See an empty search", priority: "secondary", steps: [
        { action: "enter a missing catalogue term", target: "catalogue search", operates: ["searchQuery"],
          expect: "the search value is visible", verificationValues: { searchQuery: "missing-entry" } },
        { action: "apply the catalogue search", target: "catalogue search action",
          operates: ["filter-catalogue"], expect: "the empty catalogue state is visible" },
      ] },
    ],
  };
  const spec = deriveBuildSpec(contract);
  const dependencyProblems = spec.verdict.problems
    .filter((problem) => problem.includes("reads state before it is produced"));

  assert.deepEqual(dependencyProblems, [], spec.verdict.problems.join("; "));
  assert.equal(spec.interactionContract.scenarios["empty-search"].initialState.categoryFilter, "");
  assert.equal(spec.interactionContract.scenarios["empty-search"].initialState.pricingFilter, "");
});

test("a reset step binds its owned state to the declared clear operation", () => {
  const contract = {
    summary: "A software catalogue with resettable local filters",
    projectType: "tool", auth: { required: false, rules: [] }, integrations: [], states: [],
    acceptance: [], deferred: [],
    entities: [{
      name: "catalogueViewState",
      storage: "client-only transient state; not persisted",
      fields: [
        { name: "searchQuery", type: "string", required: true },
        { name: "clearFilters", type: "boolean", required: true },
        { name: "visibleSoftwareIds", type: "string[]", required: true },
        { name: "resultCount", type: "number", required: true },
        { name: "emptyStateMessage", type: "string", required: true },
      ],
    }],
    operations: [{
      id: "clear-catalogue-filters", entity: "catalogueViewState", kind: "update",
      journey: "empty-search", responsibilities: [{
        type: "functional", reads: ["clearFilters"],
        writes: ["searchQuery", "visibleSoftwareIds", "resultCount", "emptyStateMessage", "clearFilters"],
        behavior: "clear local filters and restore the full software catalogue",
      }],
    }],
    routes: [{ path: "/", name: "Catalogue" }],
    journeys: [{ id: "empty-search", title: "Recover from an empty search", priority: "primary", steps: [
      { action: "enter a missing software term", target: "catalogue search", operates: ["searchQuery"],
        expect: "the empty catalogue state is visible", verificationValues: { searchQuery: "missing-entry" } },
      { action: "clear the search and filters", target: "clear filters control", operates: ["clearFilters"],
        expect: "the full software catalogue is visible again" },
    ] }],
  };
  const spec = deriveBuildSpec(contract);
  const reset = interactionFor(spec, "clear-catalogue-filters");

  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));
  assert.equal(reset.stepIndex, 1);
  assert.equal(reset.kind, "action");
  assert.equal(reset.control.machineId, actionIdFor("clear-catalogue-filters"));
  assert.equal(spec.interactionContract.flows.some((flow) => flow.valueWritten === "clearFilters"), false);
});

test("distinct declared operations retain distinct action identities", () => {
  const contract = {
    summary: "A software catalogue with two local actions",
    projectType: "tool", auth: { required: false, rules: [] }, integrations: [], states: [],
    acceptance: [], deferred: [], entities: [], routes: [{ path: "/", name: "Catalogue" }],
    operations: [
      { id: "refresh-list", kind: "read", journey: "refresh" },
      { id: "clear-view", kind: "update", journey: "clear" },
    ],
    journeys: [
      { id: "refresh", title: "Refresh entries", priority: "primary", steps: [{
        action: "apply the catalogue control", target: "catalogue control",
        operates: ["refresh-list"], expect: "entries are refreshed",
      }] },
      { id: "clear", title: "Clear the current view", priority: "secondary", steps: [{
        action: "apply the catalogue control", target: "catalogue control",
        operates: ["clear-view"], expect: "the current view is empty",
      }] },
    ],
  };
  const flows = deriveBuildSpec(contract).interactionContract.flows
    .filter((flow) => ["refresh-list", "clear-view"].includes(flow.operationId) && flow.control);

  assert.deepEqual(new Set(flows.map((flow) => flow.control.machineId)),
    new Set([actionIdFor("refresh-list"), actionIdFor("clear-view")]));
});
