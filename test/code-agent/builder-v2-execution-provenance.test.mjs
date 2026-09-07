import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { deriveBuildSpec, scopeBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import { verificationExecutionContract } from "../../shell/server/lib/builderV2/orchestrator.mjs";
import { journeyPrerequisites, verifyJourneys } from "../../shell/server/lib/appBuild/journeyVerifier.mjs";
import { executionProvenanceValid } from "../../shell/server/lib/builderV2/executionProvenance.mjs";
import { verificationDefects, actionableDefects } from "../../shell/server/lib/builderV2/verificationDefects.mjs";
import { MINIMAL_CONTRACT_VERIFIER_POLICY } from "../../shell/server/lib/appBuild/verifierPolicy.mjs";

// Retained production contract, build a5396ba2-eb5a-4d57-a2e8-8fcb293e8c57,
// worker a18d8235858ea86e2ddc3c53d6c4f753544e20b6 (2026-09-02).
const retained = JSON.parse(await readFile(new URL("./fixtures/bv2-retained-medium-a5396ba2.json", import.meta.url)));
const spec = deriveBuildSpec(retained);
const analytics = retained.journeys.find((journey) => journey.id === "view-analytics-summary");
const primary = retained.journeys[0].id;

test("retained Medium scopes analytics dependencies and keeps its controller on analytics", () => {
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));
  const scoped = scopeBuildSpec(spec, [analytics]);
  assert.ok(scoped.entities.some((entity) => entity.name === "project"));
  assert.ok(scoped.entities.some((entity) => entity.name === "task"));
  assert.deepEqual(scoped.operations.map((operation) => operation.id), ["calculate-analytics-summary"]);
  assert.deepEqual(scoped.scaffoldGraph.journeyRouteOwnership.map((owner) => owner.routePath), ["/analytics"]);
});

test("retained Medium replay reaches task creation, not merely project creation", () => {
  for (const id of [analytics.id, "filter-board-and-list-views"]) {
    const replay = journeyPrerequisites(spec.interactionContract.flows, id, primary, { reconstructIsolated: true });
    assert.equal(replay.planningIssues, undefined);
    assert.deepEqual(replay.controls.filter((flow) => flow.operationId).map((flow) => flow.operationId),
      ["create-project", "create-task"]);
    assert.equal(replay.controls.at(-1).operationId, "create-task");
    assert.equal(new Set(replay.controls.map((flow) => flow.id)).size, replay.controls.length);
  }
});

const producer = (entity, journeyId, stepIndex = 1, requiredProducerEntities = []) => ({
  id: `${journeyId}:${stepIndex}`, entity, journeyId, stepIndex, kind: "mutation", durableOperation: "create",
  control: { machineId: `${journeyId}-create`, logicalField: `${entity} create` }, requiredProducerEntities,
});
const consumer = (requiredProducerEntities) => ({ id: "consumer:1", journeyId: "consumer", stepIndex: 1,
  kind: "action", control: { logicalField: "summary" }, requiredProducerEntities });

test("producer replay is topological across journeys and includes prerequisite prefixes", () => {
  const flows = [producer("account", "account"), producer("project", "project", 2, ["account"]),
    producer("task", "task", 3, ["project"]), consumer(["task", "account"])];
  const replay = journeyPrerequisites(flows, "consumer", "account", { reconstructIsolated: true });
  assert.deepEqual(replay.controls.map((flow) => flow.entity), ["account", "project", "task"]);
});

test("producer replay can return to an earlier journey without executing its later commit too soon", () => {
  const flows = [producer("account", "shared", 1), producer("task", "shared", 3, ["project"]),
    producer("project", "other", 1, ["account"]), consumer(["task"])];
  const replay = journeyPrerequisites(flows, "consumer", "shared", { reconstructIsolated: true });
  assert.deepEqual(replay.controls.map((flow) => flow.entity), ["account", "project", "task"]);
});

test("an external member dependency never replays an unrelated project creation", () => {
  const replay = journeyPrerequisites([producer("project", "primary"), consumer(["member"])],
    "consumer", "primary", { reconstructIsolated: true, requiresPrimaryRecord: true });
  assert.deepEqual(replay.controls, []);
  assert.deepEqual(replay.externalEntities, ["member"]);
});

test("failed typed producer actions route repair to the producer, even when control names repeat", () => {
  const creator = { ...producer("task", "make-task"), kind: "action", action: "create task",
    stateOwner: "src/TaskForm.jsx", responsibleModules: ["src/TaskForm.jsx"] };
  const wrong = { ...creator, id: "wrong", journeyId: "make-project", stateOwner: "src/ProjectForm.jsx" };
  const contract = { interactionContract: { flows: [wrong, creator] } };
  const defects = verificationDefects({ contract, journeyResults: {
    verifierPolicy: MINIMAL_CONTRACT_VERIFIER_POLICY,
    journeys: [{ id: "analytics", owners: ["src/Analytics.jsx"], setup: { ok: false,
      failure: { control: creator.control.logicalField, producerInteractionId: creator.id,
        reason: "the durable mutation did not reach its contracted observable state" } } }],
  } });
  assert.equal(defects[0].journeyId, "make-task");
  assert.equal(defects[0].blockedJourneyId, "analytics");
  assert.deepEqual(defects[0].modules, ["src/TaskForm.jsx"]);
  assert.equal(actionableDefects(defects).length, 1);
});

test("cyclic and ambiguous producer chains are contract defects with no app repair spend", () => {
  const shapes = [
    [producer("a", "a", 1, ["b"]), producer("b", "b", 1, ["a"]), consumer(["a"])],
    [producer("a", "first"), producer("a", "second"), consumer(["a"])],
  ];
  for (const flows of shapes) {
    const replay = journeyPrerequisites(flows, "consumer", "first", { reconstructIsolated: true });
    assert.ok(replay.planningIssues.length);
    assert.deepEqual(replay.controls, []);
    const defects = verificationDefects({ journeyResults: { journeys: [{ id: "consumer",
      setup: { ok: false, planningIssues: replay.planningIssues } }] } });
    assert.equal(defects[0].defectClass, "contract");
    assert.deepEqual(actionableDefects(defects), []);
  }
});

test("execution projection retains the full producer authority and detects later scope drift before browser launch", async () => {
  const execution = verificationExecutionContract(spec.contract, [analytics], [analytics]);
  assert.equal(executionProvenanceValid(execution), true);
  assert.equal(execution.prerequisiteInteractionContract, spec.interactionContract);
  const changed = structuredClone(execution);
  changed.interactionContract.flows[0].action = "a different action";
  assert.equal(executionProvenanceValid(changed), false);
  const result = await verifyJourneys({ contract: changed, previewUrl: "http://127.0.0.1:1" });
  assert.equal(result.verifierDefects[0].code, "execution_contract_provenance_mismatch");
});

test("stale contract browser evidence cannot authorize repair against a new contract", () => {
  const execution = verificationExecutionContract(spec.contract, [analytics], [analytics]);
  const changed = structuredClone(spec.contract);
  changed.entities[0].fields.push({ name: "newField", type: "string" });
  const defects = verificationDefects({ contract: changed,
    journeyResults: { journeys: [], executionProvenance: execution.executionProvenance } });
  assert.equal(defects[0].code, "verification_evidence_contract_mismatch");
  assert.deepEqual(actionableDefects(defects), []);
  assert.deepEqual(verificationDefects({ contract: spec.contract,
    journeyResults: { journeys: [], executionProvenance: execution.executionProvenance } }), []);
});
