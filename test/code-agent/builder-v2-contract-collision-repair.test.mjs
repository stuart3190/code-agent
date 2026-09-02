// A control-identity collision must be REPAIRABLE by the contract lane, not just named by the gate.
//
// Retained defect (bv2 medium qualification, build 018625f3 on 3e06e82): the gate reported that
// create-update-and-recover-work operated dueDate/priority/ownerId for both the project and the task
// under one control identity. The repair lane knew only missing-producer and semantics issues, so it
// built no scope, fell back to an unscoped rewrite, and the model returned the same contract. Two
// paid contract calls, the same three problems, no generation.
//
// The scope now carries the collision (journey, operations, entities, the colliding fields), the
// instruction says how to close it (rename on the non-primary entity, everywhere), the merge drops
// the field the reply renamed away, and every repair attempt is judged by the canonical derivation.

import test from "node:test";
import assert from "node:assert/strict";

import {
  COLLISION_REPAIR_INSTRUCTION, contractDependencyRepairScope, generateContract, mergeContractDependencyRepair,
} from "../../shell/server/lib/appBuild/contractAgent.mjs";
import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";

const field = (name, type = "string", required = true) => ({ name, type, required });
const persistence = (fields, method) => ({
  type: "persistence", reads: fields, writes: fields, capability: "crud", capabilityMethod: method,
});

/** The live journey's shape: a project and a task created in one journey with shared field names. */
const collidingContract = () => ({
  summary: "Alder Studio: create a project, then add a task to it", projectType: "dashboard", version: 1,
  auth: { required: false },
  routes: [{ path: "/projects", name: "Projects", auth: false, purpose: "projects and their tasks" }],
  entities: [
    { name: "project", owned: false, fields: ["projectId", "name", "clientName", "dueDate", "priority", "ownerId"].map((name) => field(name, name === "dueDate" ? "date" : "string")) },
    { name: "task", owned: false, fields: ["taskId", "projectId", "title", "dueDate", "priority", "ownerId"].map((name) => field(name, name === "dueDate" ? "date" : "string")) },
  ],
  operations: [
    { id: "create-project", kind: "create", entity: "project", journey: "create-work",
      description: "persist a new project", responsibilities: [persistence(["projectId", "name", "clientName", "dueDate", "priority", "ownerId"], "create")] },
    { id: "create-task", kind: "create", entity: "task", journey: "create-work",
      description: "persist a new task", responsibilities: [persistence(["taskId", "projectId", "title", "dueDate", "priority", "ownerId"], "create")] },
  ],
  journeys: [{ id: "create-work", title: "create a project and a task", priority: "primary", steps: [
    { action: "open the projects page", target: "/projects", expect: "the projects page shows a create project form" },
    { action: "enter project details and create the project", target: "new project form",
      operates: ["name", "clientName", "dueDate", "priority", "ownerId", "create-project"],
      expect: "the new project appears in the projects list with its name, client and priority" },
    { action: "enter task details and create the task", target: "task creation form", reads: ["projectId"],
      operates: ["title", "dueDate", "priority", "ownerId", "create-task"],
      expect: "the new task appears under the project in the task list with its title and priority" },
  ] }],
  acceptance: [
    { id: "a1", kind: "persistence", journey: "create-work", statement: "after creating a project and reloading, the project name, client and priority remain visible" },
    { id: "a2", kind: "persistence", journey: "create-work", statement: "after creating a task and reloading, the task title and priority remain visible under its project" },
    { id: "a3", kind: "functional", journey: "create-work", statement: "the task creation form is visible only after a project exists" },
  ],
  states: [], deferred: [], imageIntents: [], integrations: [],
});

const rename = (value) => ({ dueDate: "taskDueDate", priority: "taskPriority", ownerId: "taskOwnerId" })[value] || value;

/** What a correct model reply looks like: the task's colliding fields renamed, everywhere. */
const renamedReply = (scope) => ({ contractPatch: {
  journeys: scope.journeys.map((journey) => ({ ...journey, steps: journey.steps.map((step, index) => (index === 2
    ? { ...step, operates: step.operates.map(rename) } : step)) })),
  operations: scope.operations.map((operation) => (operation.id === "create-task"
    ? { ...operation, responsibilities: operation.responsibilities.map((responsibility) => ({
      ...responsibility, reads: responsibility.reads.map(rename), writes: responsibility.writes.map(rename) })) }
    : operation)),
  entities: scope.entities.map((entity) => (entity.name === "task"
    ? { ...entity, fields: entity.fields.map((entry) => ({ ...entry, name: rename(entry.name) })) } : entity)),
} });

test("the repair scope carries a control-identity collision with its journey, operations and entities", () => {
  const contract = collidingContract();
  const rejected = deriveBuildSpec(contract);
  assert.equal(rejected.verdict.ok, false, JSON.stringify(rejected.verdict.problems));
  const issues = rejected.verdict.interaction.issues.filter((issue) => issue.code === "interaction_control_identity_collision");
  assert.equal(issues.length, 3, JSON.stringify(issues));
  const scope = contractDependencyRepairScope(contract, issues);
  assert.ok(scope, "a collision alone must produce a scoped repair");
  assert.equal(scope.mode, "interaction_contract_repair");
  assert.deepEqual(scope.journeys.map((journey) => journey.id), ["create-work"]);
  assert.deepEqual(scope.operations.map((operation) => operation.id).sort(), ["create-project", "create-task"]);
  assert.deepEqual(scope.entities.map((entity) => entity.name).sort(), ["project", "task"]);
  assert.deepEqual(scope.invalidControlIdentities.map((row) => row.field).sort(), ["dueDate", "ownerId", "priority"]);
  assert.deepEqual(scope.invalidControlIdentities[0].uses.map((use) => use.entity), ["project", "task"]);
  assert.match(COLLISION_REPAIR_INSTRUCTION, /Rename that field on the entity that is not the journey's primary subject/);
});

test("merging a reply that renamed the task's fields closes the collision and drops the old names", () => {
  const contract = collidingContract();
  const issues = deriveBuildSpec(contract).verdict.interaction.issues;
  const scope = contractDependencyRepairScope(contract, issues);
  const merged = mergeContractDependencyRepair(contract, renamedReply(scope), scope);
  const task = merged.entities.find((entity) => entity.name === "task");
  const project = merged.entities.find((entity) => entity.name === "project");
  assert.deepEqual(task.fields.map((entry) => entry.name), ["taskId", "projectId", "title", "taskDueDate", "taskPriority", "taskOwnerId"]);
  assert.deepEqual(project.fields.map((entry) => entry.name), ["projectId", "name", "clientName", "dueDate", "priority", "ownerId"],
    "the primary entity keeps its names");
  assert.deepEqual(merged.journeys[0].steps[2].operates, ["title", "taskDueDate", "taskPriority", "taskOwnerId", "create-task"]);
  const verdict = deriveBuildSpec(merged).verdict;
  assert.equal(verdict.ok, true, JSON.stringify(verdict.problems));
});

test("the repair lane closes a collision in one call and re-judges an unchanged reply by the derived gate", async () => {
  const contract = collidingContract();
  const rejected = deriveBuildSpec(contract);
  const issues = rejected.verdict.interaction.issues;
  const scope = contractDependencyRepairScope(contract, issues);
  const asks = [];
  const outcome = await generateContract({
    prompt: "Build a project operations dashboard where members create projects and tasks.",
    buildProfile: contract.buildProfile,
    priorContract: contract, priorProblems: rejected.verdict.problems, priorIssues: issues,
    provider: { model: "zero-model-collision-repair", async runTurn(options) {
      asks.push(JSON.stringify(options));
      return { text: JSON.stringify(renamedReply(scope)), toolCalls: [], usage: { input: 0, output: 0, total: 0 } };
    } },
  });
  assert.equal(asks.length, 1, "one corrected reply closes the gate");
  assert.match(asks[0], /SCOPED INTERACTION CONTRACT REPAIR MODE/);
  assert.match(asks[0], /invalidControlIdentities/);
  assert.match(asks[0], /Rename that field on the entity that is not the journey's primary subject/);
  assert.equal(outcome.problems.length, 0, outcome.problems.join("; "));
  assert.equal(outcome.degraded, undefined);
  assert.equal(deriveBuildSpec(outcome.contract).verdict.ok, true);

  // An unchanged reply must not be accepted as a repair on structural validity alone.
  let dispatches = 0;
  const unchanged = await generateContract({
    prompt: "Build a project operations dashboard where members create projects and tasks.",
    buildProfile: contract.buildProfile,
    priorContract: contract, priorProblems: rejected.verdict.problems, priorIssues: issues,
    provider: { model: "zero-model-collision-noop", async runTurn() {
      dispatches += 1;
      return { text: JSON.stringify({ contractPatch: { journeys: scope.journeys, operations: scope.operations, entities: scope.entities } }),
        toolCalls: [], usage: { input: 0, output: 0, total: 0 } };
    } },
  });
  assert.equal(dispatches, 2, "the derived gate rejects the unchanged reply and the lane retries once");
  assert.equal(unchanged.degraded, true);
  assert.ok(unchanged.problems.some((problem) => /operates field "dueDate" for more than one entity/.test(problem)), unchanged.problems.join("; "));
});
