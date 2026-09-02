// A route is where a step happens, never what its control is called.
//
// Retained defect (bv2 medium qualification, build 47648001 on 8f11f93): "return to analytics and
// refresh" (target /analytics, operates calculate-analytics) derived its operation control with the
// accessible name "/analytics", while the earlier "refresh the analytics summary" step had named the
// SAME machine identity "refresh analytics control". The generated screen implemented both names —
// the machine-bound refresh button plus a hand-wired `<button aria-label="/analytics">` — and the
// conformance lint blocked the duplicate through three corrections and the whole allowance. Every
// retained contract carried the same shape for sign-in ("/sign-in", "/login", "/admin").

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";

const persistence = (fields, method) => ({
  type: "persistence", reads: fields, writes: fields, capability: "crud", capabilityMethod: method,
});

const analyticsModel = () => ({
  summary: "Alder Studio analytics: refresh a computed summary, then return to it after a task change",
  projectType: "dashboard", version: 1, auth: { required: true, model: "email + password via the backend SDK" },
  routes: [
    { path: "/login", name: "Sign in", auth: false, purpose: "authenticate" },
    { path: "/tasks", name: "Tasks", auth: true, purpose: "update task status" },
    { path: "/analytics", name: "Analytics", auth: true, purpose: "computed summary" },
  ],
  entities: [
    { name: "task", fields: [{ name: "taskId", type: "string", required: true }, { name: "taskStatus", type: "string", required: true }] },
    { name: "analyticsReport", fields: [{ name: "completedTaskCount", type: "number", required: true }] },
  ],
  operations: [
    { id: "sign-in", kind: "read", entity: "authSession", journey: "view-analytics-summary",
      description: "authenticate via auth.signIn", responsibilities: [{ type: "functional", reads: ["email", "password"], writes: [], behavior: "authenticate" }] },
    { id: "update-task-status", kind: "update", entity: "task", journey: "view-analytics-summary",
      description: "persist a changed task status", responsibilities: [persistence(["taskStatus"], "update")] },
    { id: "calculate-analytics", kind: "read", entity: "analyticsReport", journey: "view-analytics-summary",
      description: "compute the analytics summary from durable tasks",
      responsibilities: [{ type: "functional", reads: ["taskStatus"], writes: ["completedTaskCount"], behavior: "count done tasks" }] },
  ],
  journeys: [{ id: "view-analytics-summary", title: "analytics", priority: "primary", steps: [
    { action: "sign in as a team member", target: "/login", operates: ["email", "password", "sign-in"],
      expect: "the dashboard shows the signed-in member" },
    { action: "open the analytics page while signed in", target: "/analytics",
      expect: "analytics cards for total tasks and completed tasks are visible" },
    { action: "refresh the analytics summary", target: "refresh analytics control", operates: ["calculate-analytics"],
      expect: "the analytics cards show numeric values derived from the current tasks" },
    { action: "open the tasks page and mark a visible task as Done", target: "/tasks",
      operates: ["taskStatus", "update-task-status"], primitive: "selection", verificationValues: { taskStatus: "Done" },
      expect: "the task shows status Done" },
    { action: "return to analytics and refresh", target: "/analytics", operates: ["calculate-analytics"],
      expect: "the completed tasks count is visible and reflects the Done task" },
  ] }],
  acceptance: [], states: [], deferred: [], imageIntents: [], integrations: [],
});

const flowsOf = (contract, journeyId) => contract.interactionContract.flows.filter((flow) => flow.journeyId === journeyId);

test("an operation re-driven from a route-targeted step keeps the name its identity already has", () => {
  const contract = deriveBuildSpec(analyticsModel()).contract;
  const flows = flowsOf(contract, "view-analytics-summary");
  const refresh = flows.find((flow) => flow.stepIndex === 2 && flow.operationId === "calculate-analytics");
  const again = flows.find((flow) => flow.stepIndex === 4 && flow.operationId === "calculate-analytics");
  assert.ok(refresh && again, JSON.stringify(flows.map((flow) => flow.id)));
  assert.equal(again.control.machineId, refresh.control.machineId, "one declared operation is one identity");
  assert.equal(again.control.accessibleName, "refresh analytics control");
  assert.equal(again.control.purpose, "refresh analytics control");
  assert.equal(contract.journeys[0].steps[4].target, "/analytics", "the route stays the step's navigation authority");
  assert.equal(contract.interactionContract.valid, true, JSON.stringify(contract.interactionContract.problems));
});

test("no contracted control is ever named by a route path", () => {
  const contract = deriveBuildSpec(analyticsModel()).contract;
  const routeNamed = contract.interactionContract.flows
    .filter((flow) => flow.control && /^\//.test(String(flow.control.accessibleName || "")));
  assert.deepEqual(routeNamed.map((flow) => flow.id), [], JSON.stringify(routeNamed.map((flow) => flow.control)));
  const taskUpdate = contract.interactionContract.flows.find((flow) => flow.operationId === "update-task-status" && flow.control);
  assert.equal(taskUpdate.control.accessibleName, "update task status", "a first-seen operation is named from its identity");
  const signIn = contract.interactionContract.flows.find((flow) => flow.stepIndex === 0 && flow.kind === "action" && flow.control);
  assert.doesNotMatch(signIn.control.accessibleName, /^\//);
});

test("the retained medium fixtures derive no route-named controls", async () => {
  for (const name of ["bv2-medium-create-step-contract.json", "bv2-medium-consumer-replay-contract.json"]) {
    const model = JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
    const contract = deriveBuildSpec(model).contract;
    const routeNamed = contract.interactionContract.flows
      .filter((flow) => flow.control && /^\//.test(String(flow.control.accessibleName || "")));
    assert.deepEqual(routeNamed, [], name);
    assert.equal(contract.interactionContract.valid, true, name);
  }
});
