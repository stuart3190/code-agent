// One control identity must mean one control.
//
// Retained defect (bv2 medium qualification, build d6a2ab65 on bb8092d): the contract's primary
// journey operated `description`, `status`, `ownerMemberId` and `dueDate` for the PROJECT it creates
// (step 4, create-project) and again for the TASK it then adds (step 6, create-task). Machine
// identities derive from the field name, so both forms carried the same data-thrallo-control ids
// and the same draft state path; the gate accepted the contract; the browser then found each field
// twice ("ambiguous_identity"), matched the task's contracted "To Do" against the project's status
// select, and the build stopped as a VERIFIER fixture defect with zero repair.
//
// Two rules pin that. A field name BOTH entities declare now derives two QUALIFIED identities
// (project.status / task.status - the runtime's { name, scope }), so both forms are addressable and
// the contract passes the gate. A field operated for an entity that never declared it still shares
// one identity with the entity that did, and that residual clash is rejected at the gate (the
// contract repair round names it for free). And a fixture the CONTRACT supplied that a located
// control does not offer is an application failure — the verifier only answers for fixtures it
// generated itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import { controlIdFor } from "../../shell/server/lib/builderV2/verificationManifest.mjs";
import { applyMinimalStepClassification } from "../../shell/server/lib/appBuild/journeyVerifier.mjs";
import { VERIFICATION_RESULT_CLASS } from "../../shell/server/lib/appBuild/verifierPolicy.mjs";

const field = (name, type = "string", required = true) => ({ name, type, required });
const persistence = (entity, fields, method) => ({
  type: "persistence", reads: fields, writes: fields, capability: "crud", capabilityMethod: method,
});

/** The live journey's shape: a project and a task created in one journey. */
const workModel = ({ taskFields }) => ({
  summary: "Alder Studio: create a project, then add a task to it", projectType: "dashboard", version: 1,
  auth: { required: false },
  routes: [{ path: "/projects", name: "Projects", auth: false, purpose: "projects and their tasks" }],
  entities: [
    { name: "project", fields: ["projectId", "name", "clientName", "description", "status", "dueDate"].map((name) => field(name, name === "dueDate" ? "date" : "string")) },
    { name: "task", fields: ["taskId", "projectId", "title", ...taskFields].map((name) => field(name, /dueDate/i.test(name) ? "date" : "string")) },
  ],
  operations: [
    { id: "create-project", kind: "create", entity: "project", journey: "create-work",
      description: "persist a new project", responsibilities: [persistence("project", ["projectId", "name", "clientName", "description", "status", "dueDate"], "create")] },
    { id: "create-task", kind: "create", entity: "task", journey: "create-work",
      description: "persist a new task", responsibilities: [persistence("task", ["taskId", "projectId", "title", ...taskFields], "create")] },
    { id: "update-task-status", kind: "update", entity: "task", journey: "create-work",
      description: "persist a changed task status", responsibilities: [persistence("task", [taskFields.find((name) => /status/i.test(name))], "update")] },
  ],
  journeys: [{ id: "create-work", title: "create a project and a task", priority: "primary", steps: [
    { action: "open the projects page", target: "/projects", expect: "the projects page shows a create project form" },
    { action: "enter project details and create the project", target: "Create Project form",
      operates: ["name", "clientName", "description", "status", "dueDate", "create-project"],
      expect: "the new project appears in the projects list with its name, client and status" },
    { action: "enter task details and create the task", target: "Add Task form", reads: ["projectId"],
      operates: ["title", ...taskFields, "create-task"],
      expect: "the new task appears under the project in the task list with its title and status" },
    { action: "change the task status", target: "task status selector", reads: ["taskId"],
      operates: [taskFields.find((name) => /status/i.test(name)), "update-task-status"], primitive: "selection",
      expect: "the task row shows In Progress status" },
  ] }],
  acceptance: [], states: [], deferred: [], imageIntents: [], integrations: [],
});

test("a field name two entities declare derives two qualified identities and passes the gate", () => {
  const spec = deriveBuildSpec(workModel({ taskFields: ["description", "status", "dueDate"] }));
  const { valid, problems, flows } = spec.contract.interactionContract;
  assert.equal(valid, true, JSON.stringify(problems));
  const statusControls = flows.filter((flow) => flow.journeyId === "create-work" && flow.control?.logicalField === "status"
    && ["input", "selection"].includes(flow.kind));
  const project = statusControls.find((flow) => flow.stepIndex === 1);
  const task = statusControls.find((flow) => flow.stepIndex === 2);
  const again = statusControls.find((flow) => flow.stepIndex === 3);
  assert.ok(project && task && again, JSON.stringify(statusControls.map((flow) => flow.id)));
  assert.deepEqual([project.control.scope, project.control.qualifiedName, project.control.machineId],
    ["project", "project.status", controlIdFor("project.status")]);
  assert.deepEqual([task.control.scope, task.control.qualifiedName, task.control.machineId],
    ["task", "task.status", controlIdFor("task.status")]);
  assert.equal(again.control.machineId, task.control.machineId, "re-driving the task's status is the same control");
  assert.notEqual(project.control.machineId, task.control.machineId);
  // A field only one entity declares is not qualified: existing applications keep their identities.
  const client = flows.find((flow) => flow.journeyId === "create-work" && flow.control?.logicalField === "clientName");
  assert.equal(client.control.scope, undefined);
  assert.equal(client.control.machineId, controlIdFor("clientName"));
});

test("a field operated for an entity that never declared it still collides, and the gate rejects it", () => {
  const model = workModel({ taskFields: ["taskDescription", "taskStatus", "taskDueDate"] });
  // The task step operates `description`, which only the PROJECT declares: one identity, two entities.
  model.journeys[0].steps[2].operates = ["title", "description", "taskStatus", "taskDueDate", "create-task"];
  const { valid, problems, issues } = deriveBuildSpec(model).contract.interactionContract;
  assert.equal(valid, false, JSON.stringify(problems));
  const collision = issues.find((issue) => issue.code === "interaction_control_identity_collision" && issue.field === "description");
  assert.ok(collision, JSON.stringify(issues));
  assert.deepEqual(collision.uses.map((use) => use.entity), ["project", "task"]);
  assert.ok(problems.some((problem) => problem.includes('operates field "description" for more than one entity')));
});

test("re-operating the SAME entity's field later in the journey is not a collision", () => {
  const spec = deriveBuildSpec(workModel({ taskFields: ["taskDescription", "taskStatus", "taskDueDate"] }));
  const { valid, problems } = spec.contract.interactionContract;
  assert.equal(valid, true, JSON.stringify(problems));
  // taskStatus is operated at create-task (step 3) and again at update-task-status (step 4): one
  // entity, one control, driven twice — exactly what a journey is allowed to do.
  const flows = spec.contract.interactionContract.flows.filter((flow) => flow.control?.logicalField === "taskStatus");
  assert.ok(new Set(flows.map((flow) => flow.stepIndex)).size >= 2, JSON.stringify(flows.map((flow) => flow.id)));
});

test("the retained medium fixtures keep passing the gate", async () => {
  for (const name of ["bv2-medium-create-step-contract.json", "bv2-medium-consumer-replay-contract.json"]) {
    const model = JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
    const { valid, problems } = deriveBuildSpec(model).contract.interactionContract;
    assert.equal(valid, true, `${name}: ${JSON.stringify(problems)}`);
  }
});

test("a contract-supplied fixture the located control does not offer is an application failure", () => {
  const outcome = applyMinimalStepClassification({
    status: "undriveable", drove: true,
    detail: "contracted control(s) could not be driven: status:fixture_invalid",
    controlEvidence: { fields: [{
      field: "status", status: "fixture_invalid", matchedBy: "machine=ctl_ba4b77ef", fixtureAuthority: "contract",
      expectedValue: "To Do", observedValue: "Active",
      availableOptions: [{ value: "Planning", label: "Planning" }, { value: "Active", label: "Active" }],
    }] },
  });
  assert.equal(outcome.classification, VERIFICATION_RESULT_CLASS.APP_FUNCTIONAL_FAILURE);
  assert.equal(outcome.status, "undriveable");
});

test("a fixture the verifier generated itself stays the verifier's own uncertainty", () => {
  const outcome = applyMinimalStepClassification({
    status: "undriveable", drove: true,
    detail: "contracted control(s) could not be driven: quantity:fixture_invalid",
    controlEvidence: { fields: [{
      field: "quantity", status: "fixture_invalid", matchedBy: "machine=ctl_1", fixtureAuthority: "native_or_generated",
      expectedValue: "Journey 1", validityMessage: "Please enter a number.",
    }] },
  });
  assert.equal(outcome.classification, VERIFICATION_RESULT_CLASS.PLATFORM_INCONCLUSIVE);
});
