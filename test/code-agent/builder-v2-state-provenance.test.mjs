// STATE PROVENANCE — a record a journey consumes must have exactly one proven source.
//
// Naming a path under durableState says a record exists before the journey starts; it does not say
// where it comes from. The retained Alder Medium contract (a5396ba2) showed both halves of the
// problem: its administrator journey edits MEMBERS but was classified on the project lifecycle,
// and a consumer of a record nothing produces could be made "valid" by relabelling the state.
// These tests pin the rule: producer journey, loader step, seed rows, or an explicitly external
// source - and an explicit dependsOn where two journeys could each be the producer.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import {
  PROVENANCE_AMBIGUOUS_ISSUE, PROVENANCE_CYCLE_ISSUE, PROVENANCE_MISSING_ISSUE, stateProvenanceIssues,
} from "../../shell/server/lib/builderV2/interactionContract.mjs";
import { validateContract } from "../../shell/shared/implementationContract.mjs";
import {
  contractDependencyRepairScope, PROVENANCE_REPAIR_INSTRUCTION,
} from "../../shell/server/lib/appBuild/contractAgent.mjs";
import { journeyPrerequisites } from "../../shell/server/lib/appBuild/journeyVerifier.mjs";
import { CHECKOUT_CONTRACT } from "./fixtures/checkoutScenarioApp.mjs";

const retained = JSON.parse(await readFile(new URL("./fixtures/bv2-retained-medium-a5396ba2.json", import.meta.url)));

const issuesOf = (contract) => {
  const spec = deriveBuildSpec(contract);
  return { spec, issues: stateProvenanceIssues(spec.interactionContract, spec.contract), verdict: spec.verdict };
};

// A two-journey shape: the primary creates projects; a secondary edits an existing project.
const twoJourneys = ({ producerCreates = true, secondaryDependsOn = null, sampleData = null, externalState = null, memberStorage = "durable", extra = {} } = {}) => ({
  summary: "Team operations", projectType: "web app", version: 1, auth: { required: true },
  routes: [{ path: "/", name: "Home" }, { path: "/projects", name: "Projects" }, { path: "/admin", name: "Admin" }],
  entities: [
    { name: "project", fields: [{ name: "projectId", type: "string" }, { name: "title", type: "string" }, { name: "status", type: "string" }] },
    { name: "member", storage: memberStorage, fields: [{ name: "userId", type: "string" }, { name: "role", type: "string" }] },
  ],
  operations: [
    ...(producerCreates ? [{ id: "create-project", entity: "project", kind: "create", journey: "make-project",
      responsibilities: [{ type: "persistence", capability: "crud", capabilityMethod: "create", reads: ["title"], writes: ["projectId", "title"] }] }] : []),
    { id: "update-project-status", entity: "project", kind: "update", journey: "edit-project",
      responsibilities: [{ type: "persistence", capability: "crud", capabilityMethod: "update", reads: ["projectId", "status"], writes: ["status"] }] },
    { id: "update-member-role", entity: "member", kind: "update", journey: "manage-roles",
      responsibilities: [{ type: "persistence", capability: "crud", capabilityMethod: "update", reads: ["userId", "role"], writes: ["role"] }] },
  ],
  journeys: [
    { id: "make-project", title: "Make a project", priority: "primary", steps: [
      { action: "open the projects route", target: "/projects", expect: "the projects list is shown" },
      { action: "create a project", target: "new project form", operates: ["title", "create-project"], primitive: "textbox",
        expect: "the new project appears in the list" },
    ] },
    { id: "edit-project", title: "Edit an existing project", priority: "secondary",
      ...(secondaryDependsOn ? { dependsOn: secondaryDependsOn } : {}), steps: [
      { action: "open the projects route", target: "/projects", expect: "the projects list is shown" },
      { action: "select a project row", target: "projects table", operates: ["projectId"], primitive: "selection",
        expect: "the selected project is highlighted" },
      { action: "change the project status", target: "status control", operates: ["status", "update-project-status"],
        reads: ["projectId"], primitive: "selection", expect: "the updated status is shown" },
    ] },
    { id: "manage-roles", title: "Manage member roles", priority: "secondary", steps: [
      { action: "open the admin route", target: "/admin", expect: "the members table is shown" },
      { action: "select a member row", target: "members table", operates: ["userId"], primitive: "selection",
        expect: "the selected member is highlighted" },
      { action: "change the member role", target: "role selector", operates: ["role", "update-member-role"],
        reads: ["userId"], primitive: "selection", expect: "the updated role is shown" },
    ] },
  ],
  ...(sampleData ? { sampleData } : {}),
  ...(externalState ? { externalState } : {}),
  acceptance: [], states: [], deferred: [], imageIntents: [], integrations: [],
  ...extra,
});

test("the retained Alder Medium contract is valid and its administrator journey lives on the member lifecycle", () => {
  const { spec, issues, verdict } = issuesOf(retained);
  assert.equal(verdict.ok, true, verdict.problems.join("; "));
  assert.deepEqual(issues, []);
  const scenarios = spec.interactionContract.scenarios;
  assert.equal(scenarios["administrator-manages-member-roles"].lifecycle, "crud:member");
  assert.equal(scenarios["administrator-manages-member-roles"].basis, "declared-operation");
  assert.equal(scenarios["create-and-update-project-work"].lifecycle, "crud:project");
  assert.equal(scenarios["view-analytics-summary"].startState, "inherits", "analytics consumes what the primary produced");
});

test("a dependent journey whose record no journey produces and nothing seeds is a provenance defect", () => {
  const { issues, verdict } = issuesOf(twoJourneys({ producerCreates: false }));
  const missing = issues.filter((issue) => issue.code === PROVENANCE_MISSING_ISSUE);
  assert.ok(missing.some((issue) => issue.journeyId === "edit-project" && issue.entity === "project"), JSON.stringify(issues));
  assert.ok(missing.some((issue) => issue.journeyId === "manage-roles" && issue.entity === "member"), "members with no seed rows are unproven too");
  assert.equal(verdict.ok, false);
  assert.match(verdict.problems.join("\n"), /no proven source/);
});

test("a producer journey, seed rows, or an external entity storage each prove the source", () => {
  const produced = issuesOf(twoJourneys({ sampleData: { members: [{ userId: "u1", role: "member" }] } }));
  assert.deepEqual(produced.issues, [], JSON.stringify(produced.issues));
  assert.equal(produced.verdict.ok, true, produced.verdict.problems.join("; "));
  const external = issuesOf(twoJourneys({ memberStorage: "durable; provisioned by platform authentication (external)" }));
  assert.deepEqual(external.issues.filter((issue) => issue.entity === "member"), []);
  const declaredExternal = issuesOf(twoJourneys({ externalState: ["manage-roles.member"] }));
  assert.deepEqual(declaredExternal.issues.filter((issue) => issue.entity === "member"), []);
});

test("declaring the path in durableState alone does not prove a source", () => {
  const contract = twoJourneys({ producerCreates: false, sampleData: { members: [{ userId: "u1", role: "member" }] } });
  contract.journeys[1].durableState = ["edit-project.durable.record"];
  const { issues, verdict } = issuesOf(contract);
  const missing = issues.filter((issue) => issue.code === PROVENANCE_MISSING_ISSUE && issue.entity === "project");
  assert.ok(missing.length, JSON.stringify(issues));
  assert.ok(missing.some((issue) => issue.declaredPath === "edit-project.durable.record" || issue.consumerStepId));
  assert.equal(verdict.ok, false);
});

test("two creators and no declaration are ambiguous; dependsOn decides", () => {
  const ambiguous = twoJourneys({ sampleData: { members: [{ userId: "u1", role: "member" }] } });
  ambiguous.operations.push({ id: "clone-project", entity: "project", kind: "create", journey: "clone-project",
    responsibilities: [{ type: "persistence", capability: "crud", capabilityMethod: "create", reads: ["title"], writes: ["projectId", "title"] }] });
  ambiguous.journeys.push({ id: "clone-project", title: "Clone a project", priority: "secondary", steps: [
    { action: "open the projects route", target: "/projects", expect: "the projects list is shown" },
    { action: "clone a project", target: "clone form", operates: ["title", "clone-project"], primitive: "textbox", expect: "the clone appears" },
  ] });
  const undeclared = issuesOf(ambiguous);
  const issue = undeclared.issues.find((row) => row.code === PROVENANCE_AMBIGUOUS_ISSUE && row.journeyId === "edit-project");
  assert.ok(issue, JSON.stringify(undeclared.issues));
  assert.deepEqual(issue.candidateProducers.sort(), ["clone-project", "make-project"]);
  assert.equal(issue.primaryJourneyId, "make-project");
  assert.equal(undeclared.verdict.ok, false);
  const declared = structuredClone(ambiguous);
  declared.journeys[1].dependsOn = ["make-project"];
  const resolved = issuesOf(declared);
  assert.deepEqual(resolved.issues, [], JSON.stringify(resolved.issues));
  assert.equal(resolved.verdict.ok, true, resolved.verdict.problems.join("; "));
});

test("a cyclic producer chain fails closed", () => {
  const plan = {
    flows: [
      { id: "a:1", journeyId: "a", stepIndex: 1, kind: "mutation", entity: "alpha", durableOperation: "create", requiredProducerEntities: ["beta"] },
      { id: "b:1", journeyId: "b", stepIndex: 1, kind: "mutation", entity: "beta", durableOperation: "create", requiredProducerEntities: ["alpha"] },
    ],
    scenarios: {},
  };
  const contract = {
    entities: [{ name: "alpha", fields: [{ name: "x" }] }, { name: "beta", fields: [{ name: "y" }] }],
    operations: [
      { id: "make-alpha", entity: "alpha", kind: "create", journey: "a", responsibilities: [{ type: "persistence", capability: "crud", capabilityMethod: "create" }] },
      { id: "make-beta", entity: "beta", kind: "create", journey: "b", responsibilities: [{ type: "persistence", capability: "crud", capabilityMethod: "create" }] },
    ],
    journeys: [{ id: "a", priority: "primary", steps: [] }, { id: "b", priority: "secondary", steps: [] }],
  };
  const issues = stateProvenanceIssues(plan, contract);
  const cycle = issues.find((issue) => issue.code === PROVENANCE_CYCLE_ISSUE);
  assert.ok(cycle, JSON.stringify(issues));
  assert.match(cycle.message, /producer chain loops/);
});

test("validateContract accepts a declared dependsOn and refuses undeclared or self references", () => {
  const ok = twoJourneys({ secondaryDependsOn: ["make-project"], sampleData: { members: [{ userId: "u1", role: "member" }] } });
  assert.deepEqual(validateContract(ok).problems.filter((problem) => /dependsOn|depend on itself/.test(problem)), []);
  const bad = twoJourneys({ secondaryDependsOn: ["no-such-journey", "edit-project"] });
  const problems = validateContract(bad).problems.join("\n");
  assert.match(problems, /dependsOn names an undeclared journey "no-such-journey"/);
  assert.match(problems, /cannot depend on itself/);
});

test("contract repair is scoped to the SOURCE, with the provenance instruction, not a durableState relabel", () => {
  const { spec, issues } = issuesOf(twoJourneys({ producerCreates: false }));
  const scope = contractDependencyRepairScope(spec.contract, issues);
  assert.ok(scope, "provenance issues open a contract repair scope");
  assert.equal(scope.mode, "interaction_contract_repair");
  assert.ok(scope.invalidProvenance.some((row) => row.entity === "project" && row.journeyId === "edit-project"));
  assert.ok(scope.journeys.some((journey) => journey.id === "edit-project"));
  assert.ok(scope.entities.some((entity) => entity.name === "project"));
  assert.match(PROVENANCE_REPAIR_INSTRUCTION, /Never satisfy a dependency by listing a path in durableState alone/);
  assert.match(PROVENANCE_REPAIR_INSTRUCTION, /sampleData|externalState|earlier journey already declares/);
});

test("prerequisite replay honours dependsOn and otherwise refuses to guess between creators", () => {
  const producer = (journeyId, entity = "project") => ({
    id: `${journeyId}:1`, entity, journeyId, stepIndex: 1, kind: "mutation", durableOperation: "create",
    control: { machineId: `${journeyId}-create`, logicalField: `${entity} create` }, requiredProducerEntities: [],
  });
  const consumer = { id: "consumer:1", journeyId: "consumer", stepIndex: 1, kind: "action",
    control: { logicalField: "status" }, requiredProducerEntities: ["project"] };
  const flows = [producer("first"), producer("second"), consumer];
  const undeclared = journeyPrerequisites(flows, "consumer", "first", { reconstructIsolated: true });
  assert.deepEqual(undeclared.planningIssues.map((issue) => issue.code), ["prerequisite_producer_ambiguous"]);
  const declared = journeyPrerequisites(flows, "consumer", "first", { reconstructIsolated: true, dependsOn: ["second"] });
  assert.equal(declared.planningIssues, undefined);
  assert.deepEqual(declared.controls.map((flow) => flow.journeyId), ["second"]);
});

// ── producers and consumptions the first provenance pass got wrong ─────────────────────────────

test("a data-flow contract's producing mutation supplies the records its dependent journeys consume", () => {
  // The retained checkout shape declares operations without responsibilities; its journeys are
  // derived from data flow. place-order's mutation IS the order producer; cancel-order's "confirm
  // cancellation" mutation inside a consuming journey is not.
  const { issues, verdict } = issuesOf(CHECKOUT_CONTRACT);
  assert.deepEqual(issues, [], JSON.stringify(issues));
  assert.equal(verdict.ok, true, verdict.problems.join("; "));
  const orphaned = structuredClone(CHECKOUT_CONTRACT);
  orphaned.journeys = orphaned.journeys.filter((journey) => journey.id !== "place-order");
  orphaned.journeys.find((journey) => journey.id === "recover-existing-order").priority = "primary";
  const missing = issuesOf(orphaned).issues.filter((issue) => issue.code === PROVENANCE_MISSING_ISSUE);
  assert.ok(missing.some((issue) => issue.journeyId === "recover-existing-order" && issue.entity === "order"),
    "without the producing journey the recovery has no source: " + JSON.stringify(missing));
});

test("one journey that creates, reloads and cancels its own record is self-sufficient whatever its scenario label", () => {
  const booking = {
    summary: "A durable multi-step table booking application",
    entities: [{ name: "booking" }],
    operations: [{ id: "create-booking", entity: "booking", action: "create" }],
    routes: [{ path: "/", name: "Booking" }], auth: { required: false },
    journeys: [{ id: "recover-booking", title: "Create, review, recover and cancel a booking", priority: "primary", steps: [
      { action: "select date, slot, party and contact", expect: "Booking review" },
      { action: "confirm booking", expect: "Booking confirmed with reference" },
      { action: "reload", expect: "Confirmed booking restored" },
      { action: "cancel", expect: "Booking cancelled" },
    ] }],
  };
  const { issues, verdict } = issuesOf(booking);
  assert.deepEqual(issues, [], JSON.stringify(issues));
  assert.equal(verdict.ok, true, verdict.problems.join("; "));
  // Drop the creating step: the reload now reads a record nothing in the journey produced.
  const noCreate = structuredClone(booking);
  noCreate.journeys[0].steps = noCreate.journeys[0].steps.filter((step) => step.action !== "confirm booking");
  assert.equal(issuesOf(noCreate).verdict.ok, false, "a reload with no earlier creation has no proven source");
});

test("a declared create on the journey's lifecycle entity produces the durable reference its later reload reads", async () => {
  const model = JSON.parse(await readFile(new URL("./fixtures/bv2-medium-create-step-contract.json", import.meta.url), "utf8"));
  const { spec, verdict } = issuesOf(model);
  assert.equal(verdict.ok, true, verdict.problems.join("; "));
  const flows = spec.interactionContract.flows.filter((flow) => flow.journeyId === "create-and-update-work");
  const create = flows.find((flow) => flow.operationId === "create-project");
  const reload = flows.find((flow) => flow.kind === "recovery");
  assert.ok(create && reload, JSON.stringify(flows.map((flow) => flow.id)));
  assert.ok(create.writes.includes("create-and-update-work.durable.reference"), JSON.stringify(create.writes));
  assert.ok(reload.reads.includes("create-and-update-work.durable.reference"));
  // A create on a DIFFERENT entity than the lifecycle does not produce the lifecycle's record.
  const stranger = structuredClone(model);
  stranger.operations = stranger.operations.filter((operation) => operation.id !== "create-project");
  const strangerFlows = deriveBuildSpec(stranger).interactionContract.flows.filter((flow) => flow.journeyId === "create-and-update-work");
  assert.ok(!strangerFlows.some((flow) => flow.operationId === "create-task" && flow.writes.includes("create-and-update-work.durable.reference")),
    "a task create does not fabricate the project lifecycle's durable reference");
});

test("an entity only ever computed by functional operations is never a durable consumption", () => {
  const model = (reportResponsibility) => ({
    summary: "Analytics over tasks", projectType: "dashboard", version: 1, auth: { required: false },
    routes: [{ path: "/analytics", name: "Analytics" }],
    entities: [
      { name: "task", fields: [{ name: "taskId", type: "string" }, { name: "taskStatus", type: "string" }] },
      { name: "analyticsReport", fields: [{ name: "completedTaskCount", type: "number" }] },
    ],
    sampleData: { task: [{ taskId: "t1", taskStatus: "Done" }] },
    operations: [
      { id: "update-task-status", kind: "update", entity: "task", journey: "view-analytics",
        responsibilities: [{ type: "persistence", capability: "crud", capabilityMethod: "update", reads: ["taskStatus"], writes: ["taskStatus"] }] },
      { id: "calculate-analytics", kind: "read", entity: "analyticsReport", journey: "view-analytics",
        responsibilities: [reportResponsibility] },
    ],
    journeys: [{ id: "view-analytics", title: "analytics", priority: "primary", steps: [
      { action: "open the analytics page", target: "/analytics", expect: "analytics cards are visible" },
      { action: "refresh the analytics summary", target: "refresh analytics control", operates: ["calculate-analytics"],
        expect: "the completed count is visible" },
      { action: "mark a visible task as Done", target: "task status", operates: ["taskStatus", "update-task-status"], primitive: "selection",
        expect: "the task shows Done" },
    ] }],
    acceptance: [], states: [], deferred: [], imageIntents: [], integrations: [],
  });
  const computed = issuesOf(model({ type: "functional", reads: ["taskStatus"], writes: ["completedTaskCount"], behavior: "count done tasks" }));
  assert.deepEqual(computed.issues.filter((issue) => issue.entity === "analyticsReport"), [], JSON.stringify(computed.issues));
  assert.equal(computed.verdict.ok, true, computed.verdict.problems.join("; "));
  // Declare the report as PERSISTED and it becomes durable state that needs a source like any other.
  const stored = issuesOf(model({ type: "persistence", capability: "crud", capabilityMethod: "read", reads: ["completedTaskCount"], writes: [] }));
  assert.ok(stored.issues.some((issue) => issue.entity === "analyticsReport" && issue.code === PROVENANCE_MISSING_ISSUE),
    JSON.stringify(stored.issues));
});
