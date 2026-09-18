// WP2 — typed ownership and platform values.
//
// Every operation names its owner (module | generated) and its platform value type; session-shaped
// entities and credential-shaped fields leave the domain schema; session operations bind to the
// identity module; platform infrastructure the contract needs is declared under
// ownership.platformRequirements instead of leaking into generation. The normalisation is
// versioned, idempotent and reversible: originals are preserved verbatim.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

import {
  OWNERSHIP_VERSION, PLATFORM_REQUIREMENT_ENFORCEMENT, PLATFORM_VALUE_TYPES, generatedOperations,
  moduleOwnedOperations, normalizeContractOwnership, ownershipProblems, ownershipWarnings,
} from "../../shell/shared/contractOwnership.mjs";
import { contractUsesPlatformAuthentication, validateContract } from "../../shell/shared/implementationContract.mjs";
import { deriveBuildSpec, validateTypedOwnership } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import { normaliseContract } from "../../shell/server/lib/appBuild/contractAgent.mjs";
import { composeCapabilityFoundation } from "../../shell/server/lib/builderV2/capabilityComposer.mjs";
import { buildExecutionSpec } from "../../shell/server/lib/builderV2/executionSpec.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";

const RETAINED = new URL("./fixtures/retained/", import.meta.url);
const readJson = async (relative) => JSON.parse(await readFile(new URL(relative, RETAINED), "utf8"));
const contractOf = (row) => row.contract || row.reply || row;

async function retainedAdvancedContracts() {
  const shorts = (await readdir(new URL("advanced-20260916/", RETAINED))).filter((name) => /^[0-9a-f]{7}$/.test(name)).sort();
  return Promise.all(shorts.map(async (short) => [short, contractOf(await readJson(`advanced-20260916/${short}/contract.json`))]));
}

const canonical = () => ({
  summary: "Lumen Layouts floor planner with accounts", projectType: "tool", version: 2,
  auth: { required: true, model: "email + password via the backend SDK", rules: [] },
  routes: [{ path: "/", name: "Home" }, { path: "/workspace", name: "Workspace", auth: true }],
  entities: [{ name: "plan", owned: true, fields: [{ name: "name", type: "string", required: true }, { name: "zoom", type: "number" }] }],
  operations: [
    { id: "sign-in", kind: "signIn", journey: "create-plan", description: "sign in or create the account",
      responsibilities: [{ type: "functional", capability: "session", capabilityMethod: "signIn",
        behavior: "establish the platform session", reads: ["authEmail", "authPassword"], writes: [] }] },
    { id: "create-plan", entity: "plan", kind: "create", journey: "create-plan", description: "persist a plan",
      responsibilities: [{ type: "persistence", capability: "crud", capabilityMethod: "create", reads: ["name"], writes: ["name", "zoom"] }] },
    { id: "list-plans", entity: "plan", kind: "list", journey: "create-plan", description: "list plans" },
    { id: "export-plan", entity: "plan", kind: "export", journey: "create-plan", description: "export a plan summary",
      responsibilities: [{ type: "functional", behavior: "render the plan summary document", reads: ["name", "zoom"], writes: [] }] },
    { id: "score-plan", entity: "plan", kind: "update", journey: "create-plan", description: "score a plan and save it",
      responsibilities: [
        { type: "functional", behavior: "compute the lighting score from the zoom", reads: ["zoom"], writes: ["name"] },
        { type: "persistence", capability: "crud", capabilityMethod: "update", reads: ["name"], writes: ["name"] },
      ] },
  ],
  journeys: [{ id: "create-plan", title: "A user signs in and creates a plan", priority: "primary", stage: "primary_journey", steps: [
    { action: "open the workspace route while signed out", target: "/workspace", expect: "the sign-in panel is visible" },
    { action: "sign in with email and password", target: "authentication form", operates: ["authEmail", "authPassword", "sign-in"], expect: "the workspace shell is visible" },
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

test("WP2 — every operation is typed: owner, module operation and platform value", () => {
  const { contract, report, changed } = normalizeContractOwnership(canonical());
  assert.equal(changed, true);
  assert.equal(report.version, OWNERSHIP_VERSION);
  assert.equal(report.normalizedFrom, 2);
  const byId = Object.fromEntries(contract.operations.map((operation) => [operation.id, operation]));
  assert.deepEqual([byId["sign-in"].owner, byId["sign-in"].module, byId["sign-in"].moduleOperation, byId["sign-in"].output.type],
    ["module", "thrallo.identity", "signIn", "session"]);
  assert.deepEqual([byId["create-plan"].owner, byId["create-plan"].module, byId["create-plan"].moduleOperation, byId["create-plan"].output.type],
    ["module", "thrallo.entities", "create", "entity"]);
  assert.deepEqual([byId["list-plans"].owner, byId["list-plans"].module, byId["list-plans"].moduleOperation, byId["list-plans"].output.type],
    ["module", "thrallo.entities", "list", "collection"], "a bare durable list is module-owned CRUD");
  assert.deepEqual([byId["export-plan"].owner, byId["export-plan"].output.type], ["generated", "artifact"]);
  // A generated calculation followed by module persistence: generated owner, module binding kept.
  assert.equal(byId["score-plan"].owner, "generated");
  assert.deepEqual(byId["score-plan"].moduleBindings, [{ responsibility: 1, module: "thrallo.entities", operation: "update" }]);
  assert.equal(byId["score-plan"].output.type, "entity");
  for (const operation of contract.operations) assert.ok(PLATFORM_VALUE_TYPES.includes(operation.output.type), operation.id);
  assert.deepEqual(moduleOwnedOperations(contract).map((row) => row.id), ["sign-in", "create-plan", "list-plans"]);
  assert.deepEqual(generatedOperations(contract).map((row) => row.id), ["export-plan", "score-plan"]);
  assert.deepEqual(report.platformRequirements.map((row) => [row.type, row.status]),
    [["identity", "resolved"], ["entities", "resolved"], ["exports", "unresolved"]]);
  assert.deepEqual(ownershipProblems(contract), []);
  assert.match(ownershipWarnings(contract).join(), /exports .*not yet module-owned/);
});

test("WP2 — normalisation is versioned and idempotent; a typed contract passes through unchanged", () => {
  const first = normalizeContractOwnership(canonical()).contract;
  const second = normalizeContractOwnership(first);
  assert.equal(second.changed, false);
  assert.equal(second.contract, first, "same object, no re-derivation");
  assert.deepEqual(normalizeContractOwnership(canonical()).contract, first, "deterministic");
});

test("WP2 — session-shaped entities and credential fields leave the schema; originals are preserved verbatim", () => {
  const raw = canonical();
  raw.entities.push({ name: "authSession", owned: false, transient: true, fields: [
    { name: "authEmail", type: "string", required: true }, { name: "authPassword", type: "string", required: true }, { name: "signedIn", type: "boolean" },
  ] });
  raw.entities[0].fields.push({ name: "password", type: "string" }, { name: "apiKey", type: "string" });
  raw.operations[0] = { id: "sign-in", kind: "create", entity: "authSession", journey: "create-plan", description: "authenticate",
    responsibilities: [{ type: "functional", reads: ["authEmail", "authPassword"], writes: ["authEmail", "signedIn"], behavior: "establish a visible signed-in session" }] };
  raw.operations.push({ id: "sign-out", kind: "delete", entity: "authSession", journey: "create-plan", description: "end the session",
    responsibilities: [{ type: "functional", reads: ["signedIn"], writes: ["signedIn"], behavior: "clear the session" }] });
  const { contract, report } = normalizeContractOwnership(raw);
  assert.deepEqual(contract.entities.map((entity) => entity.name), ["plan"]);
  assert.deepEqual(contract.entities[0].fields.map((field) => field.name), ["name", "zoom"]);
  assert.deepEqual(report.removedEntities, [raw.entities[1]], "the removed entity is preserved verbatim");
  assert.deepEqual(report.strippedFields.map((row) => `${row.entity}.${row.field.name}`), ["plan.password", "plan.apiKey"]);
  const signIn = contract.operations.find((operation) => operation.id === "sign-in");
  assert.equal(signIn.entity, undefined);
  assert.equal(signIn.kind, "signIn");
  assert.deepEqual(signIn.responsibilities, [{ type: "functional", capability: "session", capabilityMethod: "signIn",
    behavior: "establish a visible signed-in session", reads: ["authEmail", "authPassword"], writes: [] }]);
  const signOut = contract.operations.find((operation) => operation.id === "sign-out");
  assert.deepEqual([signOut.kind, signOut.module, signOut.moduleOperation, signOut.output.type, signOut.responsibilities[0].reads],
    ["signOut", "thrallo.identity", "signOut", "session", []]);
  assert.deepEqual(report.retargetedOperations.map((row) => [row.id, row.reason, row.to.operation]),
    [["sign-in", "platform_session", "signIn"], ["sign-out", "platform_session", "signOut"]]);
  assert.deepEqual(report.retargetedOperations[0].from, raw.operations[0], "the original operation is preserved verbatim");
  assert.equal(contractUsesPlatformAuthentication(contract), true);
  assert.equal(validateContract(contract).problems.length, 0, validateContract(contract).problems.join(" | "));
  // A contract that declared the session as an entity without auth.required was asking for
  // platform authentication: the inference is recorded, never silent.
  const inferred = normalizeContractOwnership({ ...raw, auth: { required: false, rules: [] } }).contract;
  assert.deepEqual([inferred.auth.required, inferred.auth.inferredFrom], [true, "session_entity"]);
  // An explicitly session-bound responsibility keeps its declared type and reads.
  const declared = normalizeContractOwnership({ ...canonical(), operations: [{ id: "sign-in", kind: "auth", entity: "plan", journey: "create-plan",
    responsibilities: [{ type: "persistence", capability: "auth", capabilityMethod: "signIn", reads: ["name"], writes: ["zoom"] }] }] }).contract;
  assert.deepEqual(declared.operations[0].responsibilities, [{ type: "persistence", capability: "session", capabilityMethod: "signIn", reads: ["name"], writes: [] }]);
});

test("WP2 — every retained Advanced contract compiles without a fake session entity", async () => {
  for (const [short, raw] of await retainedAdvancedContracts()) {
    const { contract, report } = normalizeContractOwnership(raw);
    assert.ok(!contract.entities.some((entity) => /session/i.test(entity.name)), `${short}: no session entity remains`);
    assert.ok(!contract.operations.some((operation) => /session/i.test(String(operation.entity || ""))), `${short}: no operation targets a session entity`);
    for (const operation of contract.operations) {
      if (/sign|auth/i.test(operation.id)) assert.equal(operation.module, "thrallo.identity", `${short}: ${operation.id} is identity-owned`);
    }
    const spec = deriveBuildSpec(raw);
    assert.equal(spec.verdict.ok, true, `${short}: ${spec.verdict.problems.join(" | ")}`);
    assert.equal(spec.verdict.ownership.ok, true, `${short}: ${spec.verdict.ownership.problems.join(" | ")}`);
    const crud = spec.capabilityGraph.nodes.find((node) => node.id === "capability:crud");
    assert.ok(!crud.entities.some((entity) => /session/i.test(entity)), `${short}: composed crud owns no session store`);
    const composed = composeCapabilityFoundation(REACT_VITE, spec.capabilityGraph).tree["src/lib/capabilities/composed/crud.js"];
    assert.doesNotMatch(composed, /authSession|"session"/, `${short}: no session entity store is composed`);
    assert.ok(report.removedEntities.length > 0 || report.retargetedOperations.length >= 0);
  }
});

test("WP2 — the fresh Advanced and both Medium retained contracts type every operation and derive green", async () => {
  const fixtures = [
    "advanced-20260917-fresh/northwind-field-ops.reply-2.json",
    "medium-20260917-recessed/contract.json",
    "medium-20260918-recessed/contract-7e74b401-attempt2.json",
    "lumen-advanced-20260916-contract.json",
  ];
  for (const fixture of fixtures) {
    const raw = contractOf(await readJson(fixture));
    const spec = deriveBuildSpec(raw);
    assert.equal(spec.verdict.ok, true, `${fixture}: ${spec.verdict.problems.join(" | ")}`);
    for (const operation of spec.contract.operations) {
      assert.ok(["module", "generated"].includes(operation.owner), `${fixture}: ${operation.id} owner`);
      assert.ok(PLATFORM_VALUE_TYPES.includes(operation.output?.type), `${fixture}: ${operation.id} output type`);
    }
    const signIns = spec.contract.operations.filter((operation) => /sign-?in|authenticate/i.test(operation.id));
    for (const operation of signIns) assert.deepEqual([operation.module, operation.output.type], ["thrallo.identity", "session"], `${fixture}: ${operation.id}`);
  }
  // The Medium contracts declare account-shaped entities: flagged as an unresolved accounts
  // requirement (warn until WP4), never silently treated as real accounts.
  const medium = deriveBuildSpec(contractOf(await readJson("medium-20260917-recessed/contract.json")));
  const accounts = medium.contract.ownership.platformRequirements.find((row) => row.type === "accounts");
  assert.deepEqual([accounts.status, accounts.enforcement, accounts.source], ["unresolved", "warn", "entity:appUser"]);
  assert.ok(medium.verdict.ownership.warnings.some((warning) => /accounts .*not yet module-owned/.test(warning)));
  assert.equal(PLATFORM_REQUIREMENT_ENFORCEMENT.identity, "block");
});

test("WP2 — the contract agent emits typed contracts, and the execution spec states ownership once per operation", () => {
  const typed = normaliseContract(canonical(), { prompt: "Lumen Layouts floor planner with accounts" });
  assert.equal(typed.ownership.version, OWNERSHIP_VERSION);
  assert.ok(typed.operations.every((operation) => operation.owner && operation.output?.type));
  const spec = deriveBuildSpec(typed);
  const rows = spec.capabilityGraph.operationResponsibilities.filter((row) => row.operationId === "sign-in");
  assert.ok(rows.length > 0);
  assert.deepEqual([rows[0].owner, rows[0].module, rows[0].moduleOperation, rows[0].output.type], ["module", "thrallo.identity", "signIn", "session"]);
  const execution = buildExecutionSpec({
    capabilityGraph: spec.capabilityGraph, compositionPlan: spec.compositionPlan, scaffoldGraph: spec.scaffoldGraph,
    scaffoldPlan: spec.scaffoldCompositionPlan, modulePlan: spec.modulePlan, moduleContracts: spec.moduleContracts,
    interactionContract: spec.interactionContract, persistencePlan: spec.persistencePlan,
  });
  const signIn = execution.operations.find((row) => row.operationId === "sign-in");
  assert.deepEqual([signIn.owner, signIn.module, signIn.moduleOperation, signIn.output], ["module", "thrallo.identity", "signIn", "session"]);
  const scored = execution.operations.find((row) => row.operationId === "score-plan");
  assert.equal(scored.owner, "generated");
});

test("WP2 — negative controls: a blocked requirement or an unknown module operation fails before generation", () => {
  const typed = normalizeContractOwnership(canonical()).contract;
  const forged = { ...typed, operations: typed.operations.map((operation) => operation.id === "create-plan"
    ? { ...operation, moduleOperation: "upsert" } : operation) };
  const verdict = validateTypedOwnership(forged);
  assert.equal(verdict.ok, false);
  assert.match(verdict.problems.join(), /create-plan names thrallo\.entities\.upsert, which thrallo\.entities@1\.0\.0 does not provide/);
  const untyped = { ...typed, operations: typed.operations.map(({ owner: _owner, output: _output, ...rest }) => rest) };
  assert.ok(ownershipProblems(untyped).some((problem) => /has no owner/.test(problem)));
  const blocked = { ...typed, ownership: { ...typed.ownership, platformRequirements: [
    { type: "identity", status: "unresolved", enforcement: "block", source: "auth.required" },
  ] } };
  assert.match(ownershipProblems(blocked).join(), /platform requirement identity .* has no qualified module/);
});
