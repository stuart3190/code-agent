import test from "node:test";
import assert from "node:assert/strict";

import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import {
  interactionDependencyProgress, normalizeInteractionStateDependencies,
  validateInteractionContract,
} from "../../shell/server/lib/builderV2/interactionContract.mjs";
import {
  contractDependencyRepairScope, generateContract, mergeContractDependencyRepair,
} from "../../shell/server/lib/appBuild/contractAgent.mjs";
import { validateContract } from "../../shell/shared/implementationContract.mjs";

const stateFlow = ({ id, journeyId = "journey", stepIndex, reads = [], writes = [], ...rest }) => ({
  id, journeyId, stepIndex, kind: "action", stateOwner: "src/components/Journey.jsx",
  reads, writes, dependsOn: [...reads], ...rest,
});

test("journey state dependencies accept only prior producers or declared start authority", () => {
  const valid = validateInteractionContract({ version: 2, flows: [
    stateFlow({ id: "journey:1:selection", stepIndex: 0, writes: ["journey.draft.competitionId"] }),
    stateFlow({ id: "journey:2:action", stepIndex: 1, reads: ["journey.draft.competitionId"] }),
    stateFlow({ id: "journey:3:input", stepIndex: 2, writes: ["journey.draft.ticketQuantity"] }),
    stateFlow({ id: "journey:4:review", stepIndex: 3,
      reads: ["journey.draft.competitionId", "journey.draft.ticketQuantity"] }),
  ] });
  assert.equal(valid.ok, true, valid.problems.join("; "));

  const missing = validateInteractionContract({ version: 2, flows: [
    stateFlow({ id: "journey:1:consumer", stepIndex: 0, reads: ["journey.draft.competitionId"] }),
  ] });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.issues, [{
    code: "interaction_state_dependency_missing",
    journeyId: "journey",
    consumerStepId: "journey:1:consumer",
    consumerStepIndex: 0,
    consumerOperationId: null,
    missingStatePath: "journey.draft.competitionId",
    expectedProducerSource: "journey_start_or_prior_step",
    expectedProducerSources: [
      "journey_initial_state", "durable_state", "external_input", "capability_output", "prior_step",
    ],
    candidateProducers: [],
  }]);
});

test("structured journey step reads are rejected when the contract declares no earlier producer", () => {
  const contract = {
    summary: "Generic state dependency", projectType: "tool",
    auth: { required: false }, routes: [{ path: "/", name: "Workspace" }],
    entities: [{ name: "draft", owned: false, fields: [{ name: "competitionId", type: "string" }] }],
    operations: [], integrations: [], states: [], acceptance: [], deferred: [],
    journeys: [{ id: "journey", title: "Use selection", priority: "primary", stage: "primary_journey",
      steps: [
        { action: "open the workspace", target: "/", expect: "the workspace is visible" },
        { action: "review the competition", target: "review", reads: ["competitionId"],
          expect: "the selected competition is visible" },
      ] }],
  };
  const invalid = deriveBuildSpec(contract);
  assert.equal(invalid.verdict.ok, false);
  assert.ok(invalid.verdict.interaction.issues.some((issue) => (
    issue.code === "interaction_state_dependency_missing"
      && issue.missingStatePath === "journey.draft.competitionId"
  )));

  const valid = deriveBuildSpec({
    ...contract,
    journeys: [{ ...contract.journeys[0], steps: [
      { action: "select the competition", target: "competition", operates: ["competitionId"],
        primitive: "selection", expect: "the competition is selected" },
      contract.journeys[0].steps[1],
    ] }],
  });
  assert.equal(valid.verdict.ok, true, valid.verdict.problems.join("; "));
});

test("initial, durable, external, and prior capability state are journey-scoped authorities", () => {
  const plan = {
    version: 2,
    scenarios: {
      stateful: {
        startState: "inherits",
        initialState: ["stateful.session.userId"],
        externalState: ["stateful.external.projectId"],
      },
    },
    flows: [
      // A different journey cannot satisfy this journey merely by writing the same path first.
      stateFlow({ id: "other:1", journeyId: "other", stepIndex: 0,
        writes: ["stateful.draft.foreignValue"] }),
      stateFlow({ id: "stateful:1", journeyId: "stateful", stepIndex: 0,
        reads: ["stateful.session.userId", "stateful.external.projectId", "stateful.durable.record"] }),
      stateFlow({ id: "stateful:2:create", journeyId: "stateful", stepIndex: 1,
        writes: ["stateful.capability.crud.entityId"] }),
      stateFlow({ id: "stateful:3:read", journeyId: "stateful", stepIndex: 2,
        reads: ["stateful.capability.crud.entityId"] }),
      stateFlow({ id: "stateful:4:foreign", journeyId: "stateful", stepIndex: 3,
        reads: ["stateful.draft.foreignValue"] }),
    ],
  };
  const verdict = validateInteractionContract(plan);
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.issues.map((issue) => issue.missingStatePath), ["stateful.draft.foreignValue"]);
});

test("safe deterministic normalization moves an explicitly unconstrained producer before its consumer", () => {
  const plan = { version: 2, flows: [
    stateFlow({ id: "journey:consumer", stepIndex: 0, reads: ["journey.custom.result"], reorderable: true }),
    stateFlow({ id: "journey:producer", stepIndex: 1, writes: ["journey.custom.result"], reorderable: true }),
  ] };
  const before = validateInteractionContract(plan);
  assert.equal(before.ok, false);
  assert.equal(before.issues[0].candidateProducers[0].interactionId, "journey:producer");

  const normalized = normalizeInteractionStateDependencies(plan);
  assert.equal(normalized.changed, true);
  assert.deepEqual(normalized.plan.flows.map((flow) => flow.id), ["journey:producer", "journey:consumer"]);
  assert.equal(validateInteractionContract(normalized.plan).ok, true);
});

test("moving an unresolved dependency to another step is not correction progress", () => {
  const issue = (consumerStepId, consumerStepIndex) => ({
    code: "interaction_state_dependency_missing", journeyId: "complete-mock-entry",
    consumerStepId, consumerStepIndex, missingStatePath: "complete-mock-entry.draft.competitionId",
  });
  const progress = interactionDependencyProgress([issue("step-1", 0)], [issue("step-2", 1)]);
  assert.equal(progress.moved, false);
  assert.equal(progress.equivalent, true);
  assert.deepEqual(progress.resolved, []);
});

test("dependency correction is scoped to the invalid journey and preserves every unlisted section", () => {
  const contract = {
    summary: "Two journeys", auth: { required: false }, states: [],
    journeys: [
      { id: "broken", steps: [{ action: "consume", reads: ["value"] }] },
      { id: "untouched", steps: [{ action: "stay unchanged" }] },
    ],
    operations: [
      { id: "consume", journey: "broken", entity: "record", responsibilities: [{ reads: ["value"], writes: ["result"] }] },
      { id: "unrelated", journey: "untouched", entity: "other", responsibilities: [] },
    ],
    entities: [
      { name: "record", fields: [{ name: "value" }, { name: "result" }] },
      { name: "other", fields: [{ name: "otherValue" }] },
    ],
    routes: [{ path: "/", name: "Home" }], acceptance: ["unchanged"], deferred: [], integrations: [],
  };
  const issues = [{
    code: "interaction_state_dependency_missing", journeyId: "broken",
    consumerStepId: "broken:1", consumerOperationId: "consume",
    missingStatePath: "broken.draft.value", expectedProducerSource: "journey_start_or_prior_step",
    expectedProducerSources: ["prior_step"], candidateProducers: [],
  }];
  const scope = contractDependencyRepairScope(contract, issues);
  assert.deepEqual(scope.journeys.map((journey) => journey.id), ["broken"]);
  assert.deepEqual(scope.operations.map((operation) => operation.id), ["consume"]);
  assert.doesNotMatch(JSON.stringify(scope), /stay unchanged|unrelated|otherValue/);

  const correctedJourney = { id: "broken", steps: [
    { action: "produce", operates: ["value"] }, { action: "consume", reads: ["value"] },
  ] };
  const merged = mergeContractDependencyRepair(contract, { journeys: [correctedJourney] }, scope);
  assert.equal(merged.journeys[0], correctedJourney);
  assert.equal(merged.journeys[1], contract.journeys[1]);
  assert.equal(merged.routes, contract.routes);
  assert.equal(merged.acceptance, contract.acceptance);
});

const RETAINED_SMOKE_CONTRACT = {
  summary: "Competition entry mock flow retained from build 242c7292-b5a9-4657-9480-d6237ba3a082",
  projectType: "interactive",
  auth: { required: false, model: null, rules: [] },
  routes: [{ path: "/", name: "Competition entry" }],
  entities: [{
    name: "mockEntry",
    fields: [
      "competitionId", "ticketQuantity", "skillAnswer", "totalCost",
      "validationMessage", "orderReference", "successMessage",
    ].map((name) => ({ name, type: name === "ticketQuantity" ? "integer" : "string", required: true })),
    relationships: [], owned: false,
  }],
  operations: [
    {
      id: "calculate-entry-total", entity: "mockEntry", kind: "read", journey: "complete-mock-entry",
      description: "calculate the entry total from the selected competition and ticket quantity",
      responsibilities: [{
        type: "functional", behavior: "calculate total cost",
        reads: ["competitionId", "ticketQuantity"], writes: ["totalCost"],
      }],
    },
    {
      id: "confirm-mock-entry", entity: "mockEntry", kind: "create", journey: "complete-mock-entry",
      description: "validate and confirm the mock entry",
      responsibilities: [{
        type: "functional", behavior: "validate the entry and produce its confirmation",
        reads: ["competitionId", "ticketQuantity", "skillAnswer", "totalCost"],
        writes: ["validationMessage", "orderReference", "successMessage"],
      }],
    },
  ],
  journeys: [{
    id: "complete-mock-entry", title: "Complete mock entry", priority: "primary", stage: "primary_journey",
    steps: [
      { action: "open the homepage", target: "/", expect: "the active competition is visible" },
      { action: "click Enter on the active competition", target: "Enter", operates: ["competitionId"],
        expect: "the entry panel opens for the selected competition" },
      { action: "choose the ticket quantity", target: "ticket quantity",
        operates: ["ticketQuantity", "calculate-entry-total"], reads: ["competitionId"], primitive: "selection",
        expect: "the calculated total is visible" },
      { action: "answer the skill question correctly", target: "skill answer",
        operates: ["skillAnswer"], primitive: "selection", expect: "the answer is selected" },
      { action: "confirm the mock entry", target: "confirm entry", operates: ["confirm-mock-entry"],
        reads: ["competitionId", "ticketQuantity", "skillAnswer", "totalCost"],
        expect: "the order reference and success message are visible" },
    ],
    acceptance: ["a valid mock entry displays a stable order reference"],
  }],
  integrations: [], states: [], acceptance: [
    { id: "entry-opens", statement: "clicking Enter opens the selected competition entry panel" },
    { id: "total-visible", statement: "selecting ticket quantity displays the calculated total" },
    { id: "confirmation-visible", statement: "confirming valid details displays an order reference and success message" },
  ], deferred: [],
};

test("dependency correction dispatch receives only the invalid subset and merges it server-side", async () => {
  const unrelated = {
    id: "unrelated-journey", title: "UNRELATED SECRET MARKER", priority: "secondary",
    stage: "supporting", steps: [
      { action: "open the unrelated page", target: "/unrelated", expect: "the unrelated page is visible" },
      { action: "return home", target: "/", expect: "the homepage is visible" },
    ], acceptance: ["the unrelated journey remains unchanged"],
  };
  const priorContract = {
    ...RETAINED_SMOKE_CONTRACT,
    journeys: [...RETAINED_SMOKE_CONTRACT.journeys, unrelated],
    routes: [...RETAINED_SMOKE_CONTRACT.routes, { path: "/unrelated", name: "Unrelated" }],
  };
  const issues = [{
    code: "interaction_state_dependency_missing", journeyId: "complete-mock-entry",
    consumerStepId: "complete-mock-entry:2:action", consumerOperationId: "calculate-entry-total",
    missingStatePath: "complete-mock-entry.draft.competitionId",
    expectedProducerSource: "journey_start_or_prior_step",
    expectedProducerSources: ["prior_step"], candidateProducers: [],
  }];
  let dispatchedPrompt = "";
  const provider = { runTurn: async ({ messages }) => {
    dispatchedPrompt = String(messages.at(-1)?.content || "");
    return {
      text: JSON.stringify({
        journeys: RETAINED_SMOKE_CONTRACT.journeys,
        operations: RETAINED_SMOKE_CONTRACT.operations,
        entities: RETAINED_SMOKE_CONTRACT.entities,
      }),
      toolCalls: [], usage: { input: 0, output: 0, total: 0 },
    };
  } };
  const outcome = await generateContract({
    provider, prompt: "retained smoke request", priorContract,
    priorProblems: ["dependency invalid"], priorIssues: issues,
  });
  assert.ok(outcome.contract);
  assert.match(dispatchedPrompt, /INVALID DEPENDENCY SUBSET/);
  assert.match(dispatchedPrompt, /complete-mock-entry\.draft\.competitionId/);
  assert.doesNotMatch(dispatchedPrompt, /UNRELATED SECRET MARKER|unrelated-journey|"routes"/);
  assert.deepEqual(outcome.contract.journeys[1], unrelated,
    "the unlisted journey is retained from durable server-side contract state");
});

test("retained smoke 242c7292 binds both draft producers before calculation and reaches module planning", () => {
  const contractVerdict = validateContract(RETAINED_SMOKE_CONTRACT);
  assert.equal(contractVerdict.ok, true, contractVerdict.problems.join("; "));
  const spec = deriveBuildSpec(RETAINED_SMOKE_CONTRACT);
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));
  const flows = spec.interactionContract.flows.filter((flow) => flow.journeyId === "complete-mock-entry");
  const indexOfWrite = (path) => flows.findIndex((flow) => (flow.writes || []).includes(path));
  const calculationIndex = flows.findIndex((flow) => flow.operationId === "calculate-entry-total");
  const confirmationIndex = flows.findIndex((flow) => flow.operationId === "confirm-mock-entry");
  assert.ok(indexOfWrite("complete-mock-entry.draft.competitionId") < calculationIndex);
  assert.ok(indexOfWrite("complete-mock-entry.draft.ticketQuantity") < calculationIndex);
  assert.ok(calculationIndex < confirmationIndex);
  assert.equal(flows[calculationIndex].stepIndex, 2,
    "the calculation must stay on the declared quantity step, not the earlier Enter action");
  assert.ok(flows[calculationIndex].writes.includes("complete-mock-entry.custom.totalCost"));
  assert.ok(!spec.verdict.problems.some((problem) => problem.includes("reads state before it is produced")));
  assert.ok(spec.modulePlan.length > 0);
  assert.ok(spec.moduleContracts.specifications.length > 0);
});
