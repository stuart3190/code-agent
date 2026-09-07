// QUALIFIED CONTROL IDENTITIES.
//
// Retained defect (bv2 medium d6a2ab65; dd7970e identity collision): a project form and a task form
// on one journey both operated `status`, `description` and `dueDate`. Machine identities derived
// from the bare field name, so both forms carried the same data-thrallo-control ids, the browser
// found each control twice and matched the task's "To Do" against the project's select.
//
// The identity of a field two entities declare is now entity.field - the exact identity the runtime
// helper derives from `{ name, scope }` - in the contract, the verification manifest, the binding
// lint and the model brief. Declared identity is authoritative; a synonym never creates a competing
// control; a selection option's identity (data-thrallo-control) is never its action's identity
// (data-thrallo-action).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import { actionIdFor, controlIdFor, deriveVerificationManifest } from "../../shell/server/lib/builderV2/verificationManifest.mjs";
import { lintControlBindings } from "../../shell/server/lib/builderV2/bindingLint.mjs";
import { interactionContractBrief } from "../../shell/server/lib/builderV2/interactionContract.mjs";

const field = (name, type = "string") => ({ name, type, required: true });
const persistence = (fields, method) => ({ type: "persistence", reads: fields, writes: fields, capability: "crud", capabilityMethod: method });

/** Alder-shaped: project and task share title/status/ownerId; the member has its own fields. */
const shared = () => ({
  summary: "Alder Studio: projects and their tasks", projectType: "dashboard", version: 1, auth: { required: false },
  routes: [{ path: "/projects", name: "Projects" }],
  entities: [
    { name: "project", fields: [field("projectId"), field("title"), field("status"), field("ownerId"), field("clientName")] },
    { name: "task", fields: [field("taskId"), field("projectId"), field("title"), field("status"), field("ownerId")] },
    { name: "member", fields: [field("memberId"), field("role")] },
  ],
  operations: [
    { id: "create-project", kind: "create", entity: "project", journey: "work", description: "persist a project",
      responsibilities: [persistence(["title", "status", "ownerId", "clientName"], "create")] },
    { id: "create-task", kind: "create", entity: "task", journey: "work", description: "persist a task",
      responsibilities: [persistence(["projectId", "title", "status", "ownerId"], "create")] },
    { id: "update-task-status", kind: "update", entity: "task", journey: "work", description: "persist a task status",
      responsibilities: [persistence(["status"], "update")] },
  ],
  journeys: [{ id: "work", title: "create a project and a task", priority: "primary", steps: [
    { action: "open the projects page", target: "/projects", expect: "the projects list is shown" },
    { action: "create a project", target: "new project form", operates: ["title", "status", "ownerId", "clientName", "create-project"],
      produces: ["projectId"], expect: "the project appears in the list" },
    { action: "add a task to the project", target: "task form", reads: ["projectId"], operates: ["title", "ownerId", "create-task"],
      produces: ["taskId"], expect: "the task appears under the project" },
    { action: "change the task status", target: "task status selector", reads: ["taskId"], operates: ["status", "update-task-status"],
      primitive: "selection", expect: "the task shows the new status" },
  ] }],
  acceptance: [], states: [], deferred: [], imageIntents: [], integrations: [],
});

const controlsOf = (spec, stepIndex) => spec.interactionContract.flows
  .filter((flow) => flow.journeyId === "work" && flow.stepIndex === stepIndex && ["input", "selection"].includes(flow.kind) && flow.control);

test("a field two entities declare is identified as entity.field; a field one entity declares keeps its bare identity", () => {
  const spec = deriveBuildSpec(shared());
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));
  const project = Object.fromEntries(controlsOf(spec, 1).map((flow) => [flow.control.logicalField, flow.control]));
  const task = Object.fromEntries(controlsOf(spec, 2).map((flow) => [flow.control.logicalField, flow.control]));
  const taskStatus = controlsOf(spec, 3).find((flow) => flow.control.logicalField === "status").control;
  for (const name of ["title", "ownerId"]) {
    assert.equal(project[name].scope, "project");
    assert.equal(project[name].qualifiedName, `project.${name}`);
    assert.equal(project[name].machineId, controlIdFor(`project.${name}`));
    assert.equal(task[name].scope, "task");
    assert.equal(task[name].machineId, controlIdFor(`task.${name}`));
    assert.notEqual(project[name].machineId, task[name].machineId, `${name} is two controls`);
    // The logical field keeps its declared name: values, fixtures and provenance still speak of `title`.
    assert.equal(project[name].logicalField, name);
  }
  assert.deepEqual([project.status.scope, project.status.machineId], ["project", controlIdFor("project.status")]);
  assert.deepEqual([taskStatus.scope, taskStatus.qualifiedName, taskStatus.machineId], ["task", "task.status", controlIdFor("task.status")]);
  assert.notEqual(project.status.machineId, taskStatus.machineId);
  assert.equal(project.clientName.scope, undefined, "clientName is only the project's: no qualification");
  assert.equal(project.clientName.machineId, controlIdFor("clientName"));
});

test("the verification manifest and the brief carry the qualified identity, never a re-hash of the bare name", () => {
  const spec = deriveBuildSpec(shared());
  const manifest = deriveVerificationManifest(spec);
  const ids = manifest.controls.map((control) => control.id);
  assert.ok(ids.includes(controlIdFor("project.status")), JSON.stringify(ids));
  assert.ok(ids.includes(controlIdFor("task.status")));
  assert.ok(!ids.includes(controlIdFor("status")), "the bare name is nobody's control any more");
  assert.equal(manifest.mapping[controlIdFor("task.status")].scope, "task");
  assert.equal(manifest.mapping[controlIdFor("task.status")].qualifiedName, "task.status");
  const brief = interactionContractBrief(spec.interactionContract);
  assert.match(brief, /control\.scope/);
  assert.match(brief, /useSemanticField\(\{ name: logicalField, scope \}\)/);
  assert.match(brief, /"qualifiedName": "task\.status"/);
});

test("the binding lint accepts the scoped binding and refuses the unscoped one for a scoped control", () => {
  const spec = deriveBuildSpec(shared());
  const screen = (statusGroup) => ({ "src/screens/scaffold/ProjectsScreen.jsx": `
import React, { useState } from "react";
import { useSemanticField, useSemanticSelection, useSemanticAction } from "../../lib/capabilities/react.js";
export default function ProjectsScreen() {
  const [project, setProject] = useState({ title: "", status: "", ownerId: "", clientName: "" });
  const [task, setTask] = useState({ title: "", status: "", ownerId: "" });
  const [taskStatus, setTaskStatus] = useState("");
  const projectTitle = useSemanticField({ name: "title", scope: "project", value: project.title, onChange: (v) => setProject({ ...project, title: v }) });
  const projectStatus = useSemanticField({ name: "status", scope: "project", value: project.status, onChange: (v) => setProject({ ...project, status: v }) });
  const projectOwner = useSemanticField({ name: "ownerId", scope: "project", value: project.ownerId, onChange: (v) => setProject({ ...project, ownerId: v }) });
  const clientName = useSemanticField({ name: "clientName", value: project.clientName, onChange: (v) => setProject({ ...project, clientName: v }) });
  const createProject = useSemanticAction({ name: "create-project", label: "Create project", onActivate: () => {} });
  const taskTitle = useSemanticField({ name: "title", scope: "task", value: task.title, onChange: (v) => setTask({ ...task, title: v }) });
  const taskOwner = useSemanticField({ name: "ownerId", scope: "task", value: task.ownerId, onChange: (v) => setTask({ ...task, ownerId: v }) });
  const createTask = useSemanticAction({ name: "create-task", label: "Add task", onActivate: () => {} });
  ${statusGroup}
  const updateStatus = useSemanticAction({ name: "update-task-status", label: "Save status", onActivate: () => {} });
  return <main>
    <form><label {...projectTitle.labelProps} /><input {...projectTitle.inputProps} />
      <label {...projectStatus.labelProps} /><input {...projectStatus.inputProps} />
      <label {...projectOwner.labelProps} /><input {...projectOwner.inputProps} />
      <label {...clientName.labelProps} /><input {...clientName.inputProps} />
      <button {...createProject.buttonProps}>Create project</button></form>
    <form><label {...taskTitle.labelProps} /><input {...taskTitle.inputProps} />
      <label {...taskOwner.labelProps} /><input {...taskOwner.inputProps} />
      <button {...createTask.buttonProps}>Add task</button></form>
    <div {...status.groupProps}>{["To Do", "In Progress"].map((option) => <button key={option} {...status.optionProps(option)}>{option}</button>)}</div>
    <button {...updateStatus.buttonProps}>Save status</button>
  </main>;
}
` });
  const scoped = lintControlBindings(screen(
    `const status = useSemanticSelection({ name: "status", scope: "task", value: taskStatus, onSelect: setTaskStatus });`,
  ), { interactionContract: spec.interactionContract });
  // Only the VALUE controls are under test here; the form-entry action controls the prose also
  // derives are a different rule and this fixture screen deliberately does not model them.
  const failing = (result) => result.findings.filter((row) => row.fails
    && ["useSemanticField", "useSemanticSelection"].includes(row.requiredBinding?.helper));
  assert.deepEqual(failing(scoped).map((row) => `${row.code}:${row.control || row.field || ""}`), [], JSON.stringify(failing(scoped)));

  // The status chooser binds the bare `status`: that is the identity of NO contracted control.
  const unscoped = lintControlBindings(screen(
    `const status = useSemanticSelection({ name: "status", value: taskStatus, onSelect: setTaskStatus });`,
  ), { interactionContract: spec.interactionContract });
  const problems = failing(unscoped);
  assert.ok(problems.length, "an unscoped binding does not satisfy a scoped control");
  assert.ok(problems.some((row) => JSON.stringify(row).includes("task.status")), JSON.stringify(problems));
  const required = problems.map((row) => row.requiredBinding).find((row) => row?.scope === "task");
  assert.ok(required, "the finding tells the model which scope to pass");
  assert.equal(required.identity, "task.status");
});

test("a selection option's identity is never its action's identity, and the runtime derives scope.name like the contract", async () => {
  assert.notEqual(controlIdFor("status"), actionIdFor("status"));
  assert.notEqual(controlIdFor("task.status"), actionIdFor("task.status"));
  const runtime = await readFile(new URL("../../src/scaffolds/reactVite/lib/capabilities/react.js", import.meta.url), "utf8");
  // Both helpers accept `scope` and derive the identity from scope.name with the same hash the
  // contract uses (controlIdFor: FNV-1a over the whitespace-stripped lower-cased name).
  assert.match(runtime, /export function useSemanticField\(\{[\s\S]*?scope = null,/);
  assert.match(runtime, /export function useSemanticSelection\(\{[\s\S]*?scope = null,/);
  assert.match(runtime, /"data-thrallo-control": controlId\(scope \? `\$\{scope\}\.\$\{name\}` : name\)/);
  assert.match(runtime, /const identityName = scope \? `\$\{scope\}\.\$\{groupName\}` : groupName;/);
  assert.match(runtime, /"data-throllo-action"|"data-thrallo-action": actionName \? actionId\(actionName\) : undefined/);
  const fnv = (name, prefix) => {
    const text = String(name).trim().toLowerCase().replace(/\s+/g, "");
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 0x01000193) >>> 0; }
    return `${prefix}_${hash.toString(16).padStart(8, "0")}`;
  };
  assert.equal(controlIdFor("task.status"), fnv("task.status", "ctl"));
  assert.equal(controlIdFor("task.status"), fnv("task . status", "ctl"), "whitespace is presentation; dots are identity");
  assert.notEqual(controlIdFor("task.status"), controlIdFor("taskstatus"));
});

test("the retained medium fixtures qualify their shared projectId controls by the step's entity", async () => {
  const model = JSON.parse(await readFile(new URL("./fixtures/bv2-retained-medium-a5396ba2.json", import.meta.url), "utf8"));
  const spec = deriveBuildSpec(model);
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));
  const qualified = spec.interactionContract.flows.filter((flow) => flow.control?.scope);
  // Every qualified control names a field that more than one entity declares, scoped by the
  // entity of the step's declared operation, and its identity is the qualified hash.
  for (const flow of qualified) {
    const owners = model.entities.filter((entity) => entity.fields.some((entry) => entry.name === flow.control.logicalField));
    assert.ok(owners.length > 1, `${flow.id}: ${flow.control.logicalField} is shared`);
    assert.ok(owners.some((entity) => entity.name === flow.control.scope));
    assert.equal(flow.control.machineId, controlIdFor(`${flow.control.scope}.${flow.control.logicalField}`));
  }
  // Fields only one entity declares are untouched: the same identities the retained apps bind today.
  const unshared = spec.interactionContract.flows.filter((flow) => ["input", "selection"].includes(flow.kind) && flow.control && !flow.control.scope);
  for (const flow of unshared) assert.equal(flow.control.machineId, controlIdFor(flow.control.logicalField));
});
