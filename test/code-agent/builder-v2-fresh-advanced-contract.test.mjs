// THE FIRST FRESH ADVANCED CONTRACT UNDER THE STRUCTURED-EVIDENCE RULES (2026-09-17).
//
// One contract call (Codex gpt-5.5) for Northwind Field Ops: authentication, four entities,
// create/update flows, a parameterised detail route, reload, filtering, analytics, admin roles,
// seven journeys with cross-entity dependencies. The model's reply is retained verbatim. Two
// shared-layer defects rejected it: sign-in steps carried verificationValues.authEmail, and a
// consumer journey's detail-route read of workOrderId resolved to custom state an operation of the
// same journey produces two steps LATER. These tests pin both fixes on the retained reply.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { normaliseContract, SYSTEM_PROMPT } from "../../shell/server/lib/appBuild/contractAgent.mjs";
import { validateContract, isSessionOperation } from "../../shell/shared/implementationContract.mjs";
import { resolveBuildProfile } from "../../shell/shared/buildProfile.mjs";
import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";

const FIXTURE = new URL("./fixtures/retained/advanced-20260917-fresh/northwind-field-ops.reply.json", import.meta.url);

async function fresh() {
  const { request, reply } = JSON.parse(await readFile(FIXTURE, "utf8"));
  const profile = resolveBuildProfile({ prompt: request, input: { requestedBuildType: "application" } });
  return { request, reply, contract: normaliseContract(structuredClone(reply), { prompt: request, buildProfile: profile }) };
}

test("the reply carried demo credentials as fixtures; normalisation strips them and the validator is green", async () => {
  const { reply, contract } = await fresh();
  const credentialFixtures = (steps) => steps.flatMap((step) => Object.keys(step.verificationValues || {}))
    .filter((key) => /^auth(Email|Password)$/.test(key));
  assert.equal(credentialFixtures(reply.journeys.flatMap((journey) => journey.steps)).length, 7, "the model pre-filled a sign-in fixture on every journey");
  assert.equal(credentialFixtures(contract.journeys.flatMap((journey) => journey.steps)).length, 0);
  // Ordinary fixtures survive the strip.
  const logVisit = contract.journeys.find((journey) => journey.id === "technician-log-visit");
  assert.deepEqual(Object.keys(logVisit.steps[2].verificationValues), ["arrivalTime", "notes", "partsUsed"]);
  const verdict = validateContract(contract);
  assert.deepEqual(verdict.problems, []);
  assert.ok(contract.operations.filter(isSessionOperation).length >= 1);
  assert.equal(contract.entities.some((entity) => /session|account|auth/i.test(entity.name)), false);
});

test("a consumer's detail-route read of the inherited record id is the durable record, and the gate is green", async () => {
  const { contract } = await fresh();
  const spec = deriveBuildSpec(contract);
  assert.deepEqual(spec.verdict.problems, []);
  assert.equal(spec.interactionContract.valid, true);
  const navigation = spec.interactionContract.flows.find((flow) => flow.id === "technician-log-visit:2:navigation");
  assert.ok(navigation.reads.includes("technician-log-visit.durable.workOrderId"), JSON.stringify(navigation.reads));
  assert.ok(!navigation.reads.some((path) => /\.custom\.workOrderId$/.test(path)));
  assert.equal(spec.interactionContract.scenarios["technician-log-visit"].startState, "inherits");
  // Every step states a verifiable outcome (no CONTRACT_INCOMPLETE under the validator's rule).
  assert.equal(validateContract(contract).problems.filter((problem) => /no verifiable outcome/.test(problem)).length, 0);
});

test("without its declared producer the same consumer is still rejected: the record has no source", async () => {
  const { contract } = await fresh();
  const orphaned = structuredClone(contract);
  const journey = orphaned.journeys.find((row) => row.id === "technician-log-visit");
  delete journey.dependsOn;
  delete journey.durableState;
  const spec = deriveBuildSpec(orphaned);
  assert.equal(spec.verdict.ok, false);
  assert.match(spec.verdict.problems.join("; "), /workOrderId|workOrder records/);
});

test("the contract prompt forbids credential fixtures outright", () => {
  assert.match(SYSTEM_PROMPT, /NEVER put authEmail or authPassword in verificationValues/);
});

// ── THE PROVING CALL (reply 2, under the fixed prompt) ─────────────────────────────────────────
// Validator green in one attempt (no credential fixtures); the gate then rejected three reads of
// a shape the resolver had never seen: a create step "reading" the id it generates, a visit's
// foreign key naming the inherited work order, and a search-by-name step inferred to be a durable
// record lookup from its verb. Each is a derivation rule, pinned here on the retained reply.
const FIXTURE_2 = new URL("./fixtures/retained/advanced-20260917-fresh/northwind-field-ops.reply-2.json", import.meta.url);
async function proving() {
  const { request, reply } = JSON.parse(await readFile(FIXTURE_2, "utf8"));
  const profile = resolveBuildProfile({ prompt: request, input: { requestedBuildType: "application" } });
  return { reply, contract: normaliseContract(structuredClone(reply), { prompt: request, buildProfile: profile }) };
}

test("the proving reply carries no credential fixture and clears the validator and the gate", async () => {
  const { reply, contract } = await proving();
  assert.equal(reply.journeys.flatMap((journey) => journey.steps).some((step) => /authEmail|authPassword/.test(Object.keys(step.verificationValues || {}).join())), false,
    "the fixed prompt produced no demo credentials");
  assert.deepEqual(validateContract(contract).problems, []);
  const spec = deriveBuildSpec(contract);
  assert.deepEqual(spec.verdict.problems, []);
  assert.equal(spec.interactionContract.valid, true);
  assert.equal(contract.journeys.length, 7);
});

test("a create step that reads the id its own operation generates has no dependency on it", async () => {
  const { contract } = await proving();
  const spec = deriveBuildSpec(contract);
  const mutation = spec.interactionContract.flows.find((flow) => flow.id === "create-work-order:4:mutation");
  assert.ok(mutation, "the create step's mutation flow");
  assert.ok(!mutation.reads.some((path) => /\.(custom|draft)\.id$/.test(path)), JSON.stringify(mutation.reads));
});

test("a foreign key naming the inherited entity reads that inherited record", async () => {
  const { contract } = await proving();
  const spec = deriveBuildSpec(contract);
  const visit = spec.interactionContract.flows.find((flow) => flow.id === "technician-logs-visit:4:operation:createvisit");
  assert.ok(visit.reads.includes("technician-logs-visit.durable.workOrderId"), JSON.stringify(visit.reads));
  assert.ok(!visit.reads.some((path) => /\.custom\.workOrderId$/.test(path)));
});

test("a search step that operates a field and declares no lookup operation is an input, not a record lookup", async () => {
  const { contract } = await proving();
  const spec = deriveBuildSpec(contract);
  const search = spec.interactionContract.flows.filter((flow) => flow.journeyId === "manage-sites" && flow.stepIndex === 4);
  assert.ok(search.length > 0);
  assert.ok(!search.some((flow) => flow.kind === "lookup"), JSON.stringify(search.map((flow) => flow.kind)));
  assert.ok(search.some((flow) => flow.kind === "input" && flow.control?.logicalField === "name"));
  // A declared lookup operation still derives a lookup: the corpus's reference lookups are unchanged
  // (builder-v2-contract-gate-corpus and the retained pipeline test pin them).
});
