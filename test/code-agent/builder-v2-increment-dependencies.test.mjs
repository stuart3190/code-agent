import test from "node:test";
import assert from "node:assert/strict";
import { entitiesForOperations } from "../../shell/server/lib/builderV2/entityScope.mjs";
import { deriveBuildSpec, journeysInMountedScreenUnit, scopeBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";

const contract = {
  summary: "Project and task analytics", auth: { required: false },
  routes: [{ path: "/analytics", name: "Analytics" }, { path: "/tasks", name: "Task List" }],
  entities: [
    { name: "project", fields: [{ name: "projectStatus" }], relationships: ["projects have tasks"] },
    { name: "task", fields: [{ name: "taskStatus" }, { name: "dueDate" }], relationships: ["task owner references member"] },
    { name: "member", fields: [{ name: "displayName" }] },
    { name: "analyticsSummary", storage: "transient", fields: [{ name: "total" }] },
    { name: "unrelated", fields: [{ name: "secretNote" }] },
  ],
  operations: [{ id: "calculate-summary", entity: "analyticsSummary", kind: "read", journey: "analytics",
    responsibilities: [{ type: "functional", reads: ["projectStatus", "taskStatus", "dueDate"], writes: ["total"] }] }],
  journeys: [{ id: "analytics", title: "View analytics", priority: "primary", steps: [
    { action: "open analytics", target: "/analytics", expect: "metrics are visible" },
    { action: "open the status breakdown section", target: "status breakdown",
      expect: "a visible breakdown lists counts for To Do, In Progress, Review, Blocked, and Done" },
  ] }],
};

test("generation units include transitive shared-screen writers without absorbing independent screens", () => {
  const journeys = ["a", "bridge", "c", "independent"].map((id) => ({ id }));
  const spec = { journeys, scaffoldGraph: { journeyRouteOwnership: [
    { journeyId: "c", mountedModule: "second" },
    { journeyId: "bridge", mountedModule: "second" },
    { journeyId: "bridge", mountedModule: "first" },
    { journeyId: "a", mountedModule: "first" },
    { journeyId: "independent", mountedModule: "other" },
  ] } };
  assert.deepEqual(journeysInMountedScreenUnit(spec, [journeys[0]]).map((journey) => journey.id),
    ["a", "bridge", "c"]);
});

test("observation vocabulary cannot relocate an analytics controller to Task List", () => {
  const spec = deriveBuildSpec(contract);
  assert.deepEqual(spec.scaffoldGraph.journeyRouteOwnership.map((owner) => owner.routePath), ["/analytics"]);
  const changed = structuredClone(contract);
  changed.journeys[0].steps[1].expect = "task list project counts are visible";
  assert.deepEqual(deriveBuildSpec(changed).scaffoldGraph.journeyRouteOwnership,
    spec.scaffoldGraph.journeyRouteOwnership);
});

test("increment schema scope includes cross-entity reads and transitive relationships, not unrelated schemas", () => {
  const expected = ["project", "task", "member", "analyticsSummary"];
  assert.deepEqual(entitiesForOperations(contract, contract.operations).map((entity) => entity.name), expected);
  const scoped = scopeBuildSpec(deriveBuildSpec(contract), contract.journeys);
  assert.deepEqual(scoped.entities.map((entity) => entity.name), expected);
  assert.deepEqual(scoped.operations, contract.operations, "schema dependencies must not expand feature ownership");
});

test("qualified reads disambiguate shared fields and relationship cycles terminate", () => {
  const source = { entities: [
    { name: "a", fields: [{ name: "status" }], relationships: ["references b"] },
    { name: "b", fields: [{ name: "status" }], relationships: ["references a"] },
    { name: "c", fields: [{ name: "status" }] },
  ] };
  assert.deepEqual(entitiesForOperations(source, [{ entity: "a", reads: ["b.status"] }])
    .map((entity) => entity.name), ["a", "b"]);
  assert.deepEqual(entitiesForOperations(source, [{ entity: "a", reads: ["status"] }])
    .map((entity) => entity.name), ["a", "b", "c"], "ambiguous legacy reads retain every candidate schema");
});
