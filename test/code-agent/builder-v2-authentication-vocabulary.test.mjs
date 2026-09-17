// PLATFORM AUTHENTICATION VOCABULARY — the contract names the session, never an entity.
//
// Six advanced contracts on 2026-09-16 each expressed sign-in differently: an invented
// authSession/session entity holding authEmail/authPassword, an operation bound to CRUD
// ("sign-in:create:authSession", so a durable row was expected for a sign-in), "sign-in:read:plan",
// or bare credential names the validator rejected as undeclared. Every attempt that reached the
// browser then failed first on authentication. Three earliest-layer causes, each pinned here:
//   1. the contract had no vocabulary for the platform session;
//   2. derivation read "create or sign in" as commencing a flow, emitting a phantom flow-entry
//      control (and a phantom durable mutation) beside the session operation's own control, so
//      two buttons were both named "authentication form" and the browser pressed the dead one;
//   3. no static check caught a contracted action button rendered without any handler.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  AUTH_CREDENTIAL_FIELDS, contractReferences, contractUsesPlatformAuthentication, isSessionOperation, validateContract,
} from "../../shell/shared/implementationContract.mjs";
import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import { bindCapabilities } from "../../shell/server/lib/builderV2/contractTiering.mjs";
import { lintControlBindings } from "../../shell/server/lib/builderV2/bindingLint.mjs";
import { validateModuleConformance } from "../../shell/server/lib/builderV2/moduleContracts.mjs";
import { partitionFindings } from "../../shell/server/lib/builderV2/validationSeverity.mjs";
import { SYSTEM_PROMPT } from "../../shell/server/lib/appBuild/contractAgent.mjs";

const RETAINED = new URL("./fixtures/retained/advanced-20260916/", import.meta.url);
const retained = async (short, file) => JSON.parse(await readFile(new URL(`${short}/${file}`, RETAINED), "utf8"));
const contractOf = (row) => row.contract || row;

// The canonical shape the prompt now teaches: auth.required, reserved credential controls, one
// session operation bound to the session capability, no session entity anywhere.
const canonical = () => ({
  summary: "Lumen Layouts floor planner with accounts", projectType: "tool", version: 1,
  auth: { required: true, model: "email + password via the backend SDK", rules: ["workspace requires a signed-in session"] },
  routes: [{ path: "/", name: "Home" }, { path: "/workspace", name: "Workspace", auth: true }],
  entities: [{ name: "plan", owned: true, fields: [{ name: "name", type: "string", required: true }, { name: "zoom", type: "number" }] }],
  operations: [
    { id: "sign-in", kind: "signIn", journey: "create-plan", description: "sign in or create the account",
      responsibilities: [{ type: "functional", capability: "session", capabilityMethod: "signIn",
        behavior: "establish the platform session", reads: ["authEmail", "authPassword"], writes: [] }] },
    { id: "create-plan", entity: "plan", kind: "create", journey: "create-plan", description: "persist a plan",
      responsibilities: [{ type: "persistence", capability: "crud", capabilityMethod: "create", reads: ["name"], writes: ["name", "zoom"] }] },
  ],
  journeys: [{ id: "create-plan", title: "A user signs in and creates a plan", priority: "primary", stage: "primary_journey", steps: [
    { action: "open the workspace route while signed out", target: "/workspace", expect: "the sign-in panel with email and password controls is visible" },
    { action: "sign in or create an account with email and password", target: "authentication form",
      operates: ["authEmail", "authPassword", "sign-in"], expect: "the workspace shell and the plan list panel are visible" },
    { action: "create a named plan", target: "new plan form", operates: ["name", "create-plan"], expect: "the plan name appears as the active plan" },
    { action: "reload", target: "reload", expect: "the plan is still listed as the active plan" },
  ], acceptance: ["a created plan survives reload"] }],
  acceptance: [
    { id: "a1", statement: "a created plan survives a reload", journey: "create-plan", kind: "persistence" },
    { id: "a2", statement: "signing in shows the workspace", journey: "create-plan", kind: "behavior" },
    { id: "a3", statement: "the sign-in panel is visible when signed out", journey: "create-plan", kind: "behavior" },
  ],
  states: [], integrations: [], deferred: [],
});

test("the reserved credential controls are contract references only when the platform session is in play", () => {
  assert.deepEqual(AUTH_CREDENTIAL_FIELDS.map((field) => field.name), ["authEmail", "authPassword"]);
  const withAuth = canonical();
  assert.equal(contractUsesPlatformAuthentication(withAuth), true);
  assert.ok(contractReferences(withAuth).has("authemail"));
  assert.deepEqual(validateContract(withAuth).problems, []);
  // A session operation alone is enough, even without auth.required.
  const opOnly = { ...canonical(), auth: { required: false } };
  assert.equal(contractUsesPlatformAuthentication(opOnly), true);
  assert.equal(isSessionOperation(opOnly.operations[0]), true);
  assert.equal(isSessionOperation(opOnly.operations[1]), false);
  // Without either, the names are undeclared exactly as before.
  const none = { ...canonical(), auth: { required: false }, operations: [canonical().operations[1]] };
  none.journeys[0].steps[1].operates = ["authEmail", "authPassword"];
  assert.equal(contractUsesPlatformAuthentication(none), false);
  assert.ok(validateContract(none).problems.some((problem) => /operates "authEmail" is not a declared/.test(problem)));
});

test("the canonical authentication contract derives to one session-bound action plus its two credential inputs", () => {
  const spec = deriveBuildSpec(canonical());
  assert.equal(spec.verdict.ok, true, (spec.verdict.problems || []).join(" | "));
  const step = spec.interactionContract.flows.filter((flow) => flow.journeyId === "create-plan" && flow.stepIndex === 1);
  assert.deepEqual(step.map((flow) => flow.kind), ["input", "input", "action"]);
  assert.deepEqual(step.map((flow) => flow.control?.logicalField || flow.operationId), ["authEmail", "authPassword", "sign-in"]);
  const action = step[2];
  assert.equal(action.control?.flowEntry, undefined, "a sign-in is the act, not a door");
  assert.deepEqual(action.reads, ["create-plan.draft.authEmail", "create-plan.draft.authPassword"]);
  assert.ok(action.writes.includes("create-plan.capability.session.session"));
  const responsibilities = spec.capabilityGraph.operationResponsibilities.find((row) => row.operationId === "sign-in").responsibilities;
  assert.deepEqual(responsibilities.map((row) => [row.type, row.capabilityId, row.capabilityMethod]), [["capability_functional", "session", "signIn"]]);
  assert.deepEqual(bindCapabilities(canonical()).find((row) => row.name === "session").requiredMethods, ["signIn"]);
  const email = step[0].control;
  assert.deepEqual(email.inputTypes, ["email"]);
  assert.equal(email.required, true);
});

test("every retained advanced contract's sign-in step derives one action and no flow-entry or durable commit", async () => {
  for (const short of ["6833295", "f8e2281", "1f56b9c", "ca48824", "46aab6c"]) {
    const contract = contractOf(await retained(short, "contract.json"));
    const spec = deriveBuildSpec(contract);
    const journey = contract.journeys[0];
    const index = journey.steps.findIndex((step) => /sign (?:up|in)|create or sign|sign in or create|authenticat/i.test(step.action) && !/^open/i.test(step.action));
    const step = spec.interactionContract.flows.filter((flow) => flow.journeyId === journey.id && flow.stepIndex === index);
    const kinds = step.map((flow) => flow.kind);
    assert.equal(kinds.filter((kind) => kind === "action").length, 1, `${short}: ${JSON.stringify(kinds)}`);
    assert.ok(!kinds.includes("flow_start"), `${short}: phantom flow entry ${JSON.stringify(kinds)}`);
    assert.ok(!kinds.includes("mutation"), `${short}: phantom durable commit ${JSON.stringify(kinds)}`);
    assert.ok(step.every((flow) => !flow.control?.flowEntry), short);
  }
});

test("a contracted action button rendered with no handler is a blocking pre-browser finding (retained 46aab6c)", async () => {
  const contract = contractOf(await retained("46aab6c", "contract.json"));
  const tree = await retained("46aab6c", "tree-candidate-core-2-b87d6667.json");
  const spec = deriveBuildSpec(contract);
  // The retained tree bound the phantom flow-entry identity act_44e00d0b to a dead button. With the
  // phantom gone the sign-in action is act_4a45a5d0, which the tree wired; prove the rule on the
  // dead element by pointing the contracted action at it.
  const flow = spec.interactionContract.flows.find((row) => row.journeyId === "create-edit-save-plan" && row.stepIndex === 1 && row.kind === "action");
  const deadIdentityContract = { ...spec.interactionContract, flows: spec.interactionContract.flows.map((row) => (
    row === flow ? { ...row, control: { ...row.control, machineId: "act_44e00d0b" } } : row)) };
  const lint = lintControlBindings(tree, { interactionContract: deadIdentityContract });
  const dead = lint.findings.filter((finding) => finding.code === "contracted_action_unwired");
  assert.equal(dead.length, 1, JSON.stringify(lint.findings.map((row) => row.code)));
  // The same tree also renders its "new plan form" flow-entry doors with no handler: reported, not blocking.
  const doors = lint.findings.filter((finding) => finding.code === "contracted_flow_entry_unwired");
  assert.ok(doors.length >= 1 && doors.every((finding) => finding.fails === false), JSON.stringify(doors));
  assert.equal(dead[0].fails, true);
  assert.match(dead[0].message, /act_44e00d0b .*declares no onClick\/onSubmit handler/);
  assert.equal(dead[0].elements[0].file, "src/screens/scaffold/SignInScreen.jsx");
  assert.equal(partitionFindings(dead).blocking.length, 1, "the finding is blocking, not advisory");
  // The wired button (act_4a45a5d0, onClick={handleAuthenticate}) raises nothing.
  const wired = lintControlBindings(tree, { interactionContract: spec.interactionContract });
  assert.deepEqual(wired.findings.filter((finding) => finding.code === "contracted_action_unwired"), []);
});

test("a form submit button without its own handler is not a dead control", () => {
  const tree = {
    "src/screens/scaffold/SignInScreen.jsx": `import React from "react";
export default function SignInScreen() {
  return (<form onSubmit={(event) => { event.preventDefault(); }}>
    <input aria-label="auth Email" data-thrallo-control="ctl_9f12d5bd" />
    <input aria-label="auth Password" data-throllo-control="ctl_d20ad486" />
    <button type="submit" aria-label="authentication form" data-thrallo-action="act_281c1798">Sign in</button>
  </form>);
}`,
  };
  const spec = deriveBuildSpec(canonical());
  const lint = lintControlBindings(tree, { interactionContract: spec.interactionContract });
  assert.deepEqual(lint.findings.filter((finding) => finding.code === "contracted_action_unwired"), []);
});

test("the contract prompt teaches the session vocabulary and forbids a session entity", () => {
  assert.match(SYSTEM_PROMPT, /"authEmail" and "authPassword"/);
  assert.match(SYSTEM_PROMPT, /"capability": "session", "capabilityMethod": "signIn"/);
  assert.match(SYSTEM_PROMPT, /declare no session, account or authSession entity/);
  assert.match(SYSTEM_PROMPT, /never pre-fill demo\s+credentials/);
});

test("a session sign-in creates no durable record lifecycle, so dependent journeys need no producer for it", () => {
  // Pre-vocabulary contracts bound sign-in to capability "auth" on an accountView entity holding
  // the credential fields. The platform session stores no record: a consumer journey that signs in
  // is not consuming accountView records, and the provenance gate must not demand a producer.
  const legacy = {
    summary: "Workspace with account access",
    entities: [
      { name: "item", fields: [{ name: "title" }] },
      { name: "accountView", fields: [{ name: "authEmail" }, { name: "authPassword" }] },
    ],
    operations: [
      { id: "create-item", entity: "item", kind: "create", journey: "manage-items" },
      { id: "sign-in-workspace", entity: "accountView", kind: "auth", journey: "manage-items",
        responsibilities: [{ type: "persistence", capability: "auth", capabilityMethod: "signIn", reads: ["authEmail", "authPassword"], writes: [] }] },
      { id: "sign-in-catalogue", entity: "accountView", kind: "auth", journey: "filter-catalogue",
        responsibilities: [{ type: "persistence", capability: "auth", capabilityMethod: "signIn", reads: ["authEmail", "authPassword"], writes: [] }] },
    ],
    routes: [{ path: "/", name: "Home" }, { path: "/workspace", name: "Workspace" }, { path: "/catalogue", name: "Catalogue" }],
    auth: { required: true },
    journeys: [
      { id: "manage-items", title: "Manage items", priority: "primary", steps: [
        { action: "enter account sign-in credentials", target: "authEmail", operates: ["authEmail", "authPassword"], primitive: "textbox", expect: "the account email is visible" },
        { action: "submit sign-in", target: "sign in control", operates: ["sign-in-workspace"], expect: "the workspace opens" },
        { action: "create an item", target: "title", operates: ["create-item"], expect: "the created item is visible" },
      ] },
      { id: "filter-catalogue", title: "Filter the catalogue", priority: "secondary", steps: [
        { action: "enter account sign-in credentials", target: "authEmail", operates: ["authEmail", "authPassword"], primitive: "textbox", expect: "the account email is visible" },
        { action: "submit sign-in", target: "sign in control", operates: ["sign-in-catalogue"], expect: "the catalogue opens" },
        { action: "enter a catalogue filter", target: "filter", expect: "matching items are visible" },
      ] },
    ],
  };
  const spec = deriveBuildSpec(legacy);
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));
  const signIn = spec.interactionContract.flows.find((flow) => flow.journeyId === "filter-catalogue" && flow.operationId === "sign-in-catalogue");
  assert.ok(signIn, "the sign-in action is derived");
  assert.equal(signIn.durableLifecycle ?? null, null, "a session operation has no record lifecycle");
  assert.equal(signIn.durableOperation ?? null, null);
  // A real durable consumer keeps its producer requirement: the same catalogue journey updating
  // report records that no journey creates, no loader loads and no seed supplies is still rejected.
  const consumer = {
    ...legacy,
    entities: [...legacy.entities, { name: "report", fields: [{ name: "title" }] }],
    operations: [...legacy.operations, { id: "update-report", entity: "report", kind: "update", journey: "filter-catalogue" }],
    journeys: [legacy.journeys[0], { ...legacy.journeys[1], steps: [...legacy.journeys[1].steps,
      { action: "rename the first report", target: "title", operates: ["update-report"], expect: "the renamed report is visible" }] }],
  };
  const rejected = deriveBuildSpec(consumer);
  assert.equal(rejected.verdict.ok, false);
  assert.match(rejected.verdict.problems.join("; "), /filter-catalogue consumes report records with no proven source/);
  assert.doesNotMatch(rejected.verdict.problems.join("; "), /accountView/, "the session entity is never the complaint");
});
