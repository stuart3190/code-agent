// DECLARED PRODUCERS — a contract may name a consumer's producer journey two ways, and both count.
//
// The 2026-09-16 Lumen advanced qualification (build 9350c938) was blocked before generation with
// nine "one producer must own the record" findings. Its contract HAD named the owner: every
// consuming journey carried durableState entries of the form
//   { entity: "plan", sourceJourney: "create-edit-and-save-plan", sourceOperation: "create-plan" }
// but the gate resolved ambiguity only through journey.dependsOn, which the model-facing schema
// never documented, and it stringified those objects into the consumption path "[object Object]".
// Four contract calls (3.86 credits) could not close a gate whose vocabulary the model was never
// given. These tests pin: a sourceJourney declaration is a producer declaration, it is lifted into
// dependsOn once for every consumer of the spec, it is validated like dependsOn, and two creators
// with NO declaration stay ambiguous exactly as before.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import {
  PROVENANCE_AMBIGUOUS_ISSUE, declaredProducerJourneys, stateProvenanceIssues, withDeclaredProducerDependencies,
} from "../../shell/server/lib/builderV2/interactionContract.mjs";
import { validateContract } from "../../shell/shared/implementationContract.mjs";
import {
  contractDependencyRepairScope, PROVENANCE_REPAIR_INSTRUCTION, SYSTEM_PROMPT,
} from "../../shell/server/lib/appBuild/contractAgent.mjs";

const retained = JSON.parse(await readFile(new URL("./fixtures/retained/lumen-advanced-20260916-contract.json", import.meta.url)));
const clone = (value) => JSON.parse(JSON.stringify(value));
const ambiguous = (spec) => stateProvenanceIssues(spec.interactionContract, spec.contract)
  .filter((issue) => issue.code === PROVENANCE_AMBIGUOUS_ISSUE);

test("the retained Lumen advanced contract derives clean: its sourceJourney declarations own the records", () => {
  const spec = deriveBuildSpec(clone(retained));
  assert.equal(spec.verdict.ok, true, (spec.verdict.problems || []).join(" | "));
  assert.deepEqual(ambiguous(spec), []);
  // The declarations were lifted into dependsOn for every consumer of the derived spec.
  const byId = Object.fromEntries(spec.contract.journeys.map((journey) => [journey.id, journey.dependsOn || null]));
  assert.deepEqual(byId["undo-redo-edits"], ["create-edit-and-save-plan"]);
  assert.deepEqual(byId["keyboard-accessible-canvas-actions"], ["create-edit-and-save-plan"]);
  assert.deepEqual(byId["export-and-print-report"], ["create-edit-and-save-plan"]);
  assert.equal(byId["switch-between-plans"], null, "a journey with no declaration is left alone");
  assert.deepEqual(spec.journeys.find((journey) => journey.id === "undo-redo-edits").dependsOn, ["create-edit-and-save-plan"],
    "the journeys view the verifier replays from carries the same declaration");
  // No consumption path was manufactured from a declaration object.
  const declaredPaths = stateProvenanceIssues(spec.interactionContract, spec.contract).map((issue) => issue.declaredPath);
  assert.ok(!declaredPaths.includes("[object Object]"));
});

test("without any declaration the same two creators are still ambiguous — the rule did not weaken", () => {
  const contract = clone(retained);
  for (const journey of contract.journeys) delete journey.durableState;
  const spec = deriveBuildSpec(contract);
  assert.equal(spec.verdict.ok, false);
  const issues = ambiguous(spec);
  assert.ok(issues.length >= 3, `expected the original ambiguity, got ${issues.length}`);
  assert.deepEqual(issues[0].candidateProducers, ["create-edit-and-save-plan", "switch-between-plans"]);
  assert.equal(issues[0].primaryJourneyId, "create-edit-and-save-plan");
});

test("a declaration naming a journey that does not create the entity does not silence the ambiguity", () => {
  const contract = clone(retained);
  const consumer = contract.journeys.find((journey) => journey.id === "undo-redo-edits");
  // browse-library-route creates nothing: naming it as the plan's source names no real creator.
  consumer.durableState = [{ entity: "plan", sourceJourney: "browse-library-route", sourceOperation: "none" }];
  const spec = deriveBuildSpec(contract);
  const issues = ambiguous(spec).filter((issue) => issue.journeyId === "undo-redo-edits" && issue.entity === "plan");
  assert.ok(issues.length >= 1, "two real creators remain ambiguous until one of them is named");
});

test("declaredProducerJourneys reads both forms, entity-wise, and dedupes", () => {
  const journey = {
    id: "consumer", dependsOn: ["a"],
    durableState: [
      { entity: "plan", sourceJourney: "a" },
      { entity: "fixture", sourceJourney: "b", sourceOperation: "add-fixture" },
      "consumer.draft.planId",
      null,
    ],
  };
  assert.deepEqual(declaredProducerJourneys(journey), ["a", "b"]);
  assert.deepEqual(declaredProducerJourneys(journey, "fixture"), ["a", "b"], "dependsOn is journey-wide");
  assert.deepEqual(declaredProducerJourneys({ id: "c", durableState: [{ entity: "Plan", sourceJourney: "x" }] }, "plan"), ["x"]);
  assert.deepEqual(declaredProducerJourneys({ id: "c", durableState: ["c.draft.id"] }), []);
  assert.deepEqual(declaredProducerJourneys(null), []);
});

test("withDeclaredProducerDependencies lifts declarations into dependsOn and is otherwise identity", () => {
  const contract = {
    journeys: [
      { id: "make", steps: [] },
      { id: "use", durableState: [{ entity: "plan", sourceJourney: "make" }], steps: [] },
      { id: "self", durableState: [{ entity: "plan", sourceJourney: "self" }], steps: [] },
      { id: "already", dependsOn: ["make"], durableState: [{ entity: "plan", sourceJourney: "make" }], steps: [] },
    ],
  };
  const lifted = withDeclaredProducerDependencies(contract);
  assert.notEqual(lifted, contract);
  assert.deepEqual(lifted.journeys.map((journey) => journey.dependsOn || null), [null, ["make"], null, ["make"]]);
  assert.equal(lifted.journeys[3], contract.journeys[3], "an already-equal declaration keeps the same object");
  assert.equal(withDeclaredProducerDependencies(lifted), lifted, "a lifted contract is a fixed point");
  assert.equal(withDeclaredProducerDependencies({ journeys: [{ id: "x", steps: [] }] }).journeys.length, 1);
  assert.equal(withDeclaredProducerDependencies(null), null);
});

test("the shared validator holds a sourceJourney to the dependsOn rule", () => {
  const good = validateContract(clone(retained));
  assert.deepEqual(good.problems.filter((problem) => /source journey|source its records/.test(problem)), []);
  const contract = clone(retained);
  contract.journeys.find((journey) => journey.id === "undo-redo-edits").durableState[0].sourceJourney = "missing-journey";
  contract.journeys.find((journey) => journey.id === "export-and-print-report").durableState[0].sourceJourney = "export-and-print-report";
  const problems = validateContract(contract).problems;
  assert.ok(problems.some((problem) => /undo-redo-edits durableState names an undeclared source journey "missing-journey"/.test(problem)), problems.join(" | "));
  assert.ok(problems.some((problem) => /export-and-print-report cannot source its records from itself/.test(problem)), problems.join(" | "));
});

test("the model is told how to name a producer, and the repair scope names the obvious candidate", () => {
  assert.match(SYSTEM_PROMPT, /"dependsOn"/);
  assert.match(SYSTEM_PROMPT, /names exactly one of them/);
  assert.match(PROVENANCE_REPAIR_INSTRUCTION, /"dependsOn" to exactly one of those journey ids/);
  assert.match(PROVENANCE_REPAIR_INSTRUCTION, /primaryJourneyId/);
  const contract = clone(retained);
  for (const journey of contract.journeys) delete journey.durableState;
  const spec = deriveBuildSpec(contract);
  const scope = contractDependencyRepairScope(contract, ambiguous(spec));
  assert.equal(scope.mode, "interaction_contract_repair");
  assert.equal(scope.invalidProvenance[0].primaryJourneyId, "create-edit-and-save-plan");
  assert.deepEqual(scope.invalidProvenance[0].candidateProducers, ["create-edit-and-save-plan", "switch-between-plans"]);
});
