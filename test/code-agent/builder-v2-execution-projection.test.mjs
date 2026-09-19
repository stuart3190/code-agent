// ONE BOUND SPECIFICATION, EXACT PROJECTIONS.
//
// A verification pass is bound once (orchestrator.verificationExecutionContract) and then executed
// as per-journey sandbox jobs (executionProvenance.projectExecutionJourneys). Every job must be a
// COMPLETE projection of that binding: the journey, all of its bound flows, its scenario and
// coverage, unchanged. Membership alone let a job with a required flow removed - or with a rewritten
// scenario - pass the gate; these tests hold the stronger line, against the retained Alder
// Medium contract that production actually derived.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import { verificationExecutionContract } from "../../shell/server/lib/builderV2/orchestrator.mjs";
import { scopeInteractionContract } from "../../shell/server/lib/builderV2/interactionContract.mjs";
import {
  executionProvenance, executionProvenanceReport, executionProvenanceValid, projectExecutionJourneys,
  sourceContractDigest,
} from "../../shell/server/lib/builderV2/executionProvenance.mjs";
import { verifyJourneys } from "../../shell/server/lib/appBuild/journeyVerifier.mjs";

const retained = JSON.parse(await readFile(new URL("./fixtures/bv2-retained-medium-a5396ba2.json", import.meta.url)));
const spec = deriveBuildSpec(retained);
const contract = spec.contract;
const journeys = contract.journeys;
const [primary, filter, analytics, admin, boundaries] = journeys;
const roundTrip = (value) => JSON.parse(JSON.stringify(value)); // the sandbox boundary
const bind = (scoped, driven = scoped) => verificationExecutionContract(contract, scoped, driven.map((journey) => ({ journey })));
const job = (execution, journey) => roundTrip(projectExecutionJourneys(execution, [journey]));

// ── scoping preserves execution metadata ────────────────────────────────────────────────────────

test("scoping an interaction contract keeps every execution-relevant fact about the kept journeys", () => {
  const full = contract.interactionContract;
  const scoped = scopeInteractionContract(full, [analytics]);
  assert.deepEqual(Object.keys(scoped.scenarios), [analytics.id], "only the kept journey's scenario, but kept");
  assert.deepEqual(scoped.scenarios[analytics.id], full.scenarios[analytics.id]);
  assert.equal(scoped.initialState, full.initialState);
  assert.equal(scoped.durableState, full.durableState);
  assert.equal(scoped.externalState, full.externalState);
  assert.equal(scoped.capabilityOutputs, full.capabilityOutputs);
  assert.equal(scoped.valid, full.valid);
  assert.deepEqual(scoped.scopedJourneyIds, [analytics.id]);
  assert.ok(scoped.flows.length > 0 && scoped.flows.every((flow) => flow.journeyId === analytics.id));
  assert.deepEqual(scoped.operationCoverage.map((row) => row.operationId), ["calculate-analytics-summary"]);
  assert.ok(Object.keys(full.scenarios).length > 1, "the full plan knows more journeys than the scope");
});

// ── positive projections ────────────────────────────────────────────────────────────────────────

test("full scope: the bound execution and its round-trip are exact", () => {
  const execution = bind(journeys);
  assert.equal(execution.executionProvenance.version, 2);
  assert.deepEqual(execution.executionProvenance.drivenJourneyIds, journeys.map((j) => j.id));
  assert.deepEqual(execution.executionProvenance.reusedJourneyIds, []);
  assert.equal(executionProvenanceValid(roundTrip(execution)), true);
});

test("singleton scope: one bound journey, one job, exact", () => {
  const execution = bind([analytics]);
  assert.equal(executionProvenanceValid(job(execution, analytics)), true);
});

test("multi-journey pass: every per-journey job is a complete projection of the same binding", () => {
  const execution = bind(journeys);
  for (const journey of journeys) {
    const report = executionProvenanceReport(job(execution, journey));
    assert.deepEqual(report.reasons, [], `${journey.id}: ${report.reasons.join("; ")}`);
    const projected = job(execution, journey);
    assert.deepEqual(Object.keys(projected.interactionContract.scenarios), [journey.id]);
    assert.deepEqual(projected.executionProvenance, execution.executionProvenance, "the binding travels unchanged");
  }
});

test("cached primary + uncached secondary: the driven job passes, driving the reused journey is refused", () => {
  const execution = bind(journeys, [filter, analytics]); // primary reused from cache
  assert.deepEqual(execution.executionProvenance.reusedJourneyIds, [primary.id, admin.id, boundaries.id]);
  assert.deepEqual(execution.executionProvenance.drivenJourneyIds, [filter.id, analytics.id]);
  assert.equal(executionProvenanceValid(job(execution, analytics)), true);
  const reused = executionProvenanceReport(job(execution, primary));
  assert.equal(reused.ok, false);
  assert.match(reused.reasons.join("\n"), /bound as reused from cache, not driven/);
});

test("resumed checkpoint scope: rebinding the same contract reproduces the same source digest", () => {
  const first = bind([primary]);
  const resumed = bind([primary, filter], [filter]);
  assert.equal(first.executionProvenance.sourceContractDigest, resumed.executionProvenance.sourceContractDigest);
  assert.equal(executionProvenanceValid(job(resumed, filter)), true);
  // Evidence from the first binding can authorise nothing once the source changes.
  const repaired = structuredClone(contract);
  repaired.entities[0].fields.push({ name: "clientReference", type: "string" });
  assert.notEqual(sourceContractDigest(repaired), first.executionProvenance.sourceContractDigest);
});

// ── negative projections ────────────────────────────────────────────────────────────────────────

test("a required flow removed from a singleton job is refused", () => {
  const execution = bind(journeys);
  const projected = job(execution, primary);
  const removed = projected.interactionContract.flows.pop();
  const report = executionProvenanceReport(projected);
  assert.equal(report.ok, false);
  assert.match(report.reasons.join("\n"), new RegExp(`missing required flow ${removed.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("a foreign flow added to a job is refused", () => {
  const execution = bind(journeys);
  const projected = job(execution, analytics);
  const foreign = contract.interactionContract.flows.find((flow) => flow.journeyId === filter.id);
  projected.interactionContract.flows.push(foreign);
  const report = executionProvenanceReport(projected);
  assert.equal(report.ok, false);
  assert.match(report.reasons.join("\n"), /outside this projection/);
});

test("changed scenario metadata is refused", () => {
  const execution = bind(journeys);
  const projected = job(execution, filter);
  const scenario = projected.interactionContract.scenarios[filter.id];
  scenario.startState = scenario.startState === "fresh" ? "inherits" : "fresh";
  const report = executionProvenanceReport(projected);
  assert.equal(report.ok, false);
  assert.match(report.reasons.join("\n"), /scenario metadata for journey filter-board-and-list-views differs/);
});

test("changed producer requirements or control semantics on a flow are refused", () => {
  const execution = bind(journeys);
  const projected = job(execution, analytics);
  const flow = projected.interactionContract.flows.find((row) => row.requiredProducerEntities?.length)
    || projected.interactionContract.flows[0];
  flow.requiredProducerEntities = [...(flow.requiredProducerEntities || []), "member"];
  const report = executionProvenanceReport(projected);
  assert.equal(report.ok, false);
  assert.match(report.reasons.join("\n"), /differs from its bound source/);
  const control = job(execution, analytics);
  control.interactionContract.flows.find((row) => row.control).control.machineId = "act_00000000";
  assert.equal(executionProvenanceValid(control), false);
});

test("incomplete operation coverage is refused", () => {
  const execution = bind(journeys);
  const projected = job(execution, analytics);
  projected.interactionContract.operationCoverage = [];
  const report = executionProvenanceReport(projected);
  assert.equal(report.ok, false);
  assert.match(report.reasons.join("\n"), /operation coverage for journey view-analytics-summary is incomplete/);
});

test("a changed journey step is refused", () => {
  const execution = bind(journeys);
  const projected = job(execution, admin);
  projected.journeys[0].steps[0].expect = "something the contract never said";
  assert.equal(executionProvenanceValid(projected), false);
});

test("a stale contract fingerprint is refused before any browser opens", async () => {
  const execution = bind(journeys);
  const projected = job(execution, primary);
  projected.entities.push({ name: "invoice", fields: [{ name: "amount", type: "number" }] });
  const report = executionProvenanceReport(projected);
  assert.deepEqual(report.reasons, ["source contract changed after binding (stale fingerprint)"]);
  const result = await verifyJourneys({ contract: projected, previewUrl: "http://127.0.0.1:1" });
  assert.equal(result.pass, false);
  assert.equal(result.verifierDefects[0].code, "execution_contract_provenance_mismatch");
  assert.match(result.verifierDefects[0].detail, /stale fingerprint/);
});

test("the projection operation is total: projecting every driven journey reproduces the bound flows exactly once", () => {
  const execution = bind(journeys);
  const seen = journeys.flatMap((journey) => job(execution, journey).interactionContract.flows.map((flow) => flow.id));
  const bound = execution.interactionContract.flows.map((flow) => flow.id);
  assert.deepEqual(seen.sort(), bound.slice().sort());
  assert.equal(new Set(seen).size, seen.length);
});

test("provenance itself is deterministic", () => {
  assert.deepEqual(executionProvenance(bind(journeys)), executionProvenance(bind(journeys)));
});
