import test from "node:test";
import assert from "node:assert/strict";

import {
  contractDependencyRepairScope, mergeContractDependencyRepair,
} from "../../shell/server/lib/appBuild/contractAgent.mjs";

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
