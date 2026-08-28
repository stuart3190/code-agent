import test from "node:test";
import assert from "node:assert/strict";

import {
  contractDependencyRepairScope, DEPENDENCY_REPAIR_INSTRUCTION, mergeContractDependencyRepair,
} from "../../shell/server/lib/appBuild/contractAgent.mjs";
import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import { validateContract } from "../../shell/shared/implementationContract.mjs";

const field = (name, type = "string") => ({ name, type, required: false });

const CONTRACT = {
  summary: "A local software catalogue",
  auth: { required: false, rules: [] },
  entities: [{
    name: "catalogueState",
    storage: "session-only",
    fields: [field("query"), field("visibleItems", "string[]"), field("detailPanel")],
  }],
  journeys: [{
    id: "filter-catalogue",
    steps: [
      { action: "open the catalogue", target: "/", expect: "catalogue items are visible" },
      { action: "enter a query", operates: ["query"], expect: "matching items are visible" },
    ],
  }, {
    id: "view-item-detail",
    steps: [
      { action: "open the catalogue", target: "/", expect: "catalogue items are visible" },
      { action: "select an item", reads: ["detailPanel"], expect: "the detail panel is visible" },
    ],
  }],
  operations: [{
    id: "apply-catalogue-filter",
    entity: "catalogueState",
    kind: "search",
    journey: "filter-catalogue",
    responsibilities: [{ type: "functional", reads: ["query"], writes: ["visibleItems"] }],
  }, {
    id: "show-item-detail",
    entity: "catalogueState",
    kind: "read",
    journey: "view-item-detail",
    responsibilities: [{ type: "functional", reads: ["visibleItems"], writes: ["detailPanel"] }],
  }],
};

test("scoped semantic repair includes its operation and preserves unlisted shared-entity fields", () => {
  const issues = [{
    code: "interaction_contract_semantics_incomplete",
    operationId: "apply-catalogue-filter",
    interactionId: "filter-catalogue:2:action",
    missingFields: ["writes"],
  }];
  const scope = contractDependencyRepairScope(CONTRACT, issues);
  assert.equal(scope.mode, "interaction_contract_repair");
  assert.deepEqual(scope.operations.map((operation) => operation.id), ["apply-catalogue-filter"]);
  assert.deepEqual(scope.invalidSemantics, [{
    operationId: "apply-catalogue-filter",
    interactionId: "filter-catalogue:2:action",
    journeyId: null,
    missingFields: ["writes"],
  }]);
  assert.deepEqual(scope.entities[0].fields.map((entry) => entry.name), ["query", "visibleItems"]);

  const merged = mergeContractDependencyRepair(CONTRACT, {
    contractPatch: {
      journeys: scope.journeys,
      operations: scope.operations,
      entities: [{
        name: "catalogueState",
        storage: "session-only",
        fields: [field("query", "search"), field("visibleItems", "string[]"), field("resultCount", "number")],
      }],
    },
  }, scope);

  assert.deepEqual(merged.entities[0].fields.map((entry) => entry.name),
    ["query", "visibleItems", "detailPanel", "resultCount"]);
  assert.equal(merged.entities[0].fields.find((entry) => entry.name === "query").type, "search");
  assert.deepEqual(merged.operations.find((operation) => operation.id === "show-item-detail"),
    CONTRACT.operations[1]);
  assert.deepEqual(merged.journeys.find((journey) => journey.id === "view-item-detail"),
    CONTRACT.journeys[1]);
});

test("contract validation rejects functional writes outside the operation entity", () => {
  const contract = structuredClone(CONTRACT);
  contract.entities = [{
    name: "catalogueState",
    storage: "session-only",
    fields: [field("query"), field("visibleItems", "string[]")],
  }, {
    name: "detailState",
    storage: "session-only",
    fields: [field("detailPanel")],
  }];
  contract.operations[0].responsibilities[0].writes = ["detailPanel"];

  const verdict = validateContract(contract);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((problem) => (
    problem.includes('writes "detailPanel" outside its operation entity "catalogueState"')
  )));
});

test("dependency repair includes a prior operation whose visible result owns a missing row identity", () => {
  const contract = {
    summary: "A software catalogue editor",
    projectType: "tool",
    buildProfile: {
      version: 1,
      requestedBuildType: "application",
      resolvedBuildType: "application",
      applicationSubtype: "auto",
      requirementSignals: ["saved_data"],
      inferenceSource: "explicit",
      confidence: 1,
    },
    entities: [{
      name: "catalogueItem",
      storage: "durable",
      owned: false,
      fields: [field("itemId"), field("title"), field("status")],
    }, {
      name: "catalogueFilter",
      storage: "transient",
      owned: false,
      fields: [field("query")],
    }],
    operations: [{
      id: "find-catalogue-items",
      entity: "catalogueFilter",
      kind: "search",
      journey: "browse-catalogue",
      responsibilities: [{
        type: "functional",
        reads: ["query", "title", "status"],
        writes: [],
        outputEffect: {
          type: "transient_result", effect: "read_result", operationKind: "search", durable: false,
        },
      }],
    }, {
      id: "update-catalogue-status",
      entity: "catalogueItem",
      kind: "update",
      journey: "maintain-catalogue",
      responsibilities: [{
        type: "persistence",
        capability: "crud",
        capabilityMethod: "update",
        reads: ["itemId", "status"],
        writes: ["status"],
      }],
    }],
    journeys: [{
      id: "filter-catalogue",
      title: "Filter and update the software catalogue",
      priority: "primary",
      stage: "primary_journey",
      steps: [
        { action: "open the catalogue", target: "/", expect: "catalogue items are visible" },
        { action: "enter a query", target: "catalogue search", operates: ["query"],
          primitive: "textbox", expect: "the query is visible" },
        { action: "show matching catalogue items", target: "search results",
          operates: ["find-catalogue-items"], reads: ["query"],
          expect: "matching catalogue items are visible" },
        { action: "change a visible item status", target: "visible item row",
          operates: ["status", "update-catalogue-status"], reads: ["itemId"],
          expect: "the edited item shows the new status" },
      ],
      acceptance: ["the edited item shows the new status"],
    }],
    routes: [{ path: "/", name: "Catalogue" }],
    auth: { required: false, rules: [] },
    integrations: [],
    states: [],
    acceptance: [{
      id: "catalogue-status",
      statement: "the edited item shows the new status",
      journey: "filter-catalogue",
      kind: "persistence",
    }],
    deferred: [],
  };

  const rejected = deriveBuildSpec(contract);
  assert.equal(rejected.verdict.ok, false);
  const issue = rejected.verdict.interaction.issues.find((candidate) => (
    candidate.code === "interaction_state_dependency_missing"
  ));
  assert.ok(issue);

  const scope = contractDependencyRepairScope(contract, [issue]);
  assert.deepEqual(scope.operations.map((operation) => operation.id), [
    "find-catalogue-items", "update-catalogue-status",
  ]);
  assert.deepEqual(scope.invalidDependencies[0].priorOperationCandidates, [{
    operationId: "find-catalogue-items", stepIndex: 2,
  }]);
  assert.match(DEPENDENCY_REPAIR_INSTRUCTION, /existing observable result already exposes that field/);

  const correctedJourney = structuredClone(scope.journeys[0]);
  correctedJourney.steps[2].produces = ["itemId"];
  const repaired = mergeContractDependencyRepair(contract, {
    contractPatch: {
      journeys: [correctedJourney],
      operations: scope.operations,
      entities: scope.entities,
    },
  }, scope);
  const accepted = deriveBuildSpec(repaired);
  assert.equal(accepted.verdict.ok, true, accepted.verdict.problems.join("; "));
  const updateFlow = accepted.interactionContract.flows.find((flow) => (
    flow.operationId === "update-catalogue-status"
  ));
  assert.ok(updateFlow.reads.includes("filter-catalogue.custom.itemId"));
});
