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
  summary: "A responsive UK competition website called Low Budget Competitions presenting affordable prize competitions and a client-only mock entry flow with ticket totals, skill question validation, responsible play messaging, and mock order references.",
  projectType: "landing",
  auth: { required: false, model: "none", rules: [
    "visitors can browse competitions without signing in", "mock entries do not create user accounts",
    "no customer data is stored",
  ] },
  routes: [{ path: "/", name: "Home" }],
  entities: [{
    name: "mockEntry",
    fields: [
      "competitionId", "ticketQuantity", "skillAnswer", "totalCost",
      "validationMessage", "orderReference", "successMessage",
    ].map((name) => ({
      name, type: ["ticketQuantity", "totalCost"].includes(name) ? "number" : "string",
      required: ["competitionId", "ticketQuantity", "totalCost"].includes(name),
    })),
    storage: "client-only transient state; not persisted to backend",
    relationships: ["a mockEntry references one in-code competition constant"], owned: false,
  }],
  operations: [
    {
      id: "calculate-entry-total", entity: "mockEntry", kind: "read", journey: "complete-mock-entry",
      description: "Calculate and display the mock total cost from the selected competition ticket price and ticket quantity.",
      responsibilities: [{
        type: "functional", behavior: "multiply the selected competition ticket price by ticketQuantity and format the result as pound sterling for display",
        reads: ["competitionId", "ticketQuantity"], writes: ["totalCost"],
      }],
    },
    {
      id: "confirm-mock-entry", entity: "mockEntry", kind: "create", journey: "complete-mock-entry",
      description: "Validate the skill answer and produce either a visible validation message or a client-only mock entry success state with an order reference; no backend write and no payment processing occur.",
      responsibilities: [{
        type: "functional", behavior: "verify that skillAnswer matches the correct answer for the selected in-code competition; if invalid, set a visible validation message and do not display an orderReference",
        reads: ["competitionId", "skillAnswer"], writes: ["validationMessage"],
      }, {
        type: "functional", behavior: "when the skill answer is correct, clear validation, generate a visible mock order reference, and display a friendly success message that identifies the entry as mock-only",
        reads: ["competitionId", "ticketQuantity", "skillAnswer", "totalCost"],
        writes: ["validationMessage", "orderReference", "successMessage"],
      }],
    },
  ],
  journeys: [
    {
      id: "browse-competitions", title: "A visitor browses affordable active competitions",
      priority: "primary", stage: "primary_journey", steps: [
        { action: "open the homepage", target: "/", expect: "the hero headline 'Win big on a low budget' is visible with a browse competitions CTA" },
        { action: "click the browse competitions CTA", target: "browse competitions CTA", expect: "the Active Competitions section is visible with four competition cards" },
        { action: "inspect a competition card", target: "competition card", expect: "the card shows prize value, ticket price, entries sold progress, max entries, draw date, and an Enter button" },
        { action: "resize to a mobile-width viewport", target: "responsive page layout", expect: "competition cards stack in a single column without horizontal scrolling" },
      ], acceptance: ["the homepage and all competition cards are visible"],
    },
    {
    id: "complete-mock-entry", title: "A visitor completes a mock entry for a competition",
    priority: "secondary", stage: "supporting",
    steps: [
      { action: "open the homepage", target: "/", expect: "the Active Competitions section is available on the page" },
      { action: "click Enter on an active competition", target: "competition card Enter button", operates: ["competitionId"],
        expect: "an entry panel or modal opens showing the selected competition name, prize value, ticket price, progress, and draw date" },
      { action: "choose a ticket quantity", target: "ticket quantity control",
        operates: ["ticketQuantity", "calculate-entry-total"], reads: ["competitionId"], primitive: "selection",
        expect: "the selected quantity is displayed and the total cost updates in pound sterling" },
      { action: "answer the skill question correctly", target: "skill question answer control",
        operates: ["skillAnswer"], primitive: "selection", expect: "the chosen answer is visibly selected" },
      { action: "confirm the mock entry", target: "confirm entry button", operates: ["confirm-mock-entry"],
        reads: ["competitionId", "ticketQuantity", "skillAnswer", "totalCost"],
        expect: "a friendly success message is visible with a mock order reference and wording that clearly says no real payment was taken" },
    ],
    acceptance: ["changing ticket quantity updates the visible total cost before confirmation"],
  }, {
    id: "skill-question-validation",
    title: "A visitor sees validation for an incorrect or missing skill question answer",
    priority: "secondary", stage: "supporting", steps: [
      { action: "open the homepage", target: "/", expect: "the Active Competitions section is available on the page" },
      { action: "click Enter on an active competition", target: "competition card Enter button",
        operates: ["competitionId"], expect: "the entry panel is visible with the ticket quantity control and skill question" },
      { action: "choose a ticket quantity", target: "ticket quantity control",
        operates: ["ticketQuantity", "calculate-entry-total"], reads: ["competitionId"], primitive: "selection",
        expect: "the selected quantity is displayed and the total cost updates in pound sterling" },
      { action: "try to confirm without selecting the correct skill answer", target: "confirm entry button",
        operates: ["confirm-mock-entry"], reads: ["competitionId", "ticketQuantity"],
        expect: "a validation message is visible and no mock order reference is shown" },
      { action: "select the correct skill answer and confirm again", target: "skill question answer control and confirm entry button",
        operates: ["skillAnswer", "confirm-mock-entry"], reads: ["competitionId", "ticketQuantity", "totalCost"],
        expect: "the validation message is cleared and the success message with a mock order reference is shown" },
    ], acceptance: ["selecting the correct answer allows confirmation"],
  }, {
    id: "read-trust-and-legal-information",
    title: "A visitor reviews responsible play, trust, FAQ, and legal placeholder information",
    priority: "secondary", stage: "polish", steps: [
      { action: "open the homepage", target: "/", expect: "the Low Budget Competitions page is visible" },
      { action: "scroll to responsible play messaging", target: "responsible play section", expect: "18+ only and responsible play messages are visible" },
      { action: "scroll to How It Works", target: "How It Works section", expect: "the mock entry steps are explained" },
      { action: "scroll to Recent Winners and Trust/Safety", target: "Recent Winners and Trust/Safety sections", expect: "winner examples and safety reassurance are visible" },
      { action: "open or inspect FAQ and footer", target: "FAQ section and footer", expect: "FAQ content and legal placeholder links are visible" },
    ], acceptance: ["responsible play and legal information are visible"],
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
  assert.deepEqual(outcome.contract.journeys.find((journey) => journey.id === unrelated.id), unrelated,
    "the unlisted journey is retained from durable server-side contract state");
});

test("retained smoke 242c7292 binds both draft producers before calculation and reaches module planning", () => {
  const contractVerdict = validateContract(RETAINED_SMOKE_CONTRACT);
  assert.equal(contractVerdict.ok, true, contractVerdict.problems.join("; "));
  const spec = deriveBuildSpec(RETAINED_SMOKE_CONTRACT);
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));
  assert.deepEqual(spec.journeys.map((journey) => journey.id), [
    "browse-competitions", "complete-mock-entry", "skill-question-validation",
    "read-trust-and-legal-information",
  ]);
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
  assert.ok(spec.interactionContract.flows.some((flow) => (
    flow.journeyId === "skill-question-validation"
      && flow.operationId === "calculate-entry-total" && flow.actionIdentity?.operationId
  )), "the reused calculation operation must remain bound in the validation journey");
});
