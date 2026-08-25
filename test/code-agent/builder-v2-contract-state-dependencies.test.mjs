import test from "node:test";
import assert from "node:assert/strict";

import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import { contractRuntimeRequirements } from "../../shell/server/lib/builderV2/buildEnvelope.mjs";
import { journeyRequiresPersistentMutation } from "../../shell/server/lib/builderV2/runtimeComposition.mjs";
import {
  buildInteractionContract, interactionDependencyProgress, normalizeInteractionStateDependencies,
  validateInteractionContract,
} from "../../shell/server/lib/builderV2/interactionContract.mjs";
import {
  contractDependencyRepairScope, generateContract, mergeContractDependencyRepair, normaliseContract,
} from "../../shell/server/lib/appBuild/contractAgent.mjs";
import { validateContract } from "../../shell/shared/implementationContract.mjs";
import { inferRequirementSignals } from "../../shell/shared/buildProfile.mjs";

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

test("retained competition correction keeps observational review out of the state graph", () => {
  const retainedCorrection = {
    summary: "Budget competition interest application", projectType: "website",
    auth: { required: false }, routes: [{ path: "/", name: "Home" }],
    entities: [{ name: "entryInterest", owned: false, fields: [
      { name: "competitionId", type: "string", required: true },
      { name: "competitionTitle", type: "string" },
      { name: "prizeAmount", type: "number" },
      { name: "ticketPrice", type: "number" },
      { name: "remainingEntries", type: "number" },
      { name: "drawDate", type: "string" },
      { name: "ticketQuantity", type: "number", required: true },
      { name: "totalEntryCost", type: "number" },
      { name: "name", type: "string", required: true },
      { name: "email", type: "string", required: true },
    ] }],
    operations: [{ id: "create-entry-interest", name: "create-entry-interest", kind: "create",
      entity: "entryInterest", journey: "submit-entry-interest" }],
    integrations: [], states: [], acceptance: [], deferred: [],
    journeys: [{ id: "submit-entry-interest", title: "Submit competition interest",
      priority: "primary", stage: "primary_journey", steps: [
        { action: "open the homepage", target: "/", expect: "featured competitions are visible" },
        { action: "review the featured competition cards", target: "featured competitions section",
          expect: "each featured card shows its prize, price, remaining entries, and draw date" },
        { action: "choose a featured competition", target: "competition card", primitive: "selection",
          operates: ["competitionId"],
          produces: ["competitionTitle", "prizeAmount", "ticketPrice", "remainingEntries", "drawDate"],
          expect: "the chosen competition is selected" },
        { action: "choose a ticket quantity", target: "ticket quantity", primitive: "selection",
          operates: ["ticketQuantity"], reads: ["ticketPrice", "remainingEntries"],
          produces: ["totalEntryCost"], expect: "the entry total is shown" },
        { action: "enter contact details and submit interest", target: "register interest form",
          operates: ["name", "email", "create-entry-interest"], reads: [
            "competitionId", "competitionTitle", "prizeAmount", "ticketPrice", "remainingEntries",
            "drawDate", "ticketQuantity", "totalEntryCost",
          ], expect: "a success confirmation is visible" },
      ] }],
  };

  const spec = deriveBuildSpec(retainedCorrection);
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));
  assert.ok(spec.modulePlan.length > 0);
  assert.ok(spec.moduleContracts.specifications.length > 0);
  assert.equal(spec.contract.journeys[0].steps[1].action, "review the featured competition cards",
    "the observational step remains part of the browser journey");
  assert.equal(spec.interactionContract.flows.some((flow) => (
    flow.journeyId === "submit-entry-interest" && flow.stepIndex === 1 && flow.kind === "review"
  )), false, "observation without a state source does not fabricate an interaction dependency");

  const competition = spec.interactionContract.flows.find((flow) => (
    flow.journeyId === "submit-entry-interest" && flow.valueWritten === "competitionId"
  ));
  const quantity = spec.interactionContract.flows.find((flow) => (
    flow.journeyId === "submit-entry-interest" && flow.valueWritten === "ticketQuantity"
  ));
  const mutation = spec.interactionContract.flows.find((flow) => (
    flow.journeyId === "submit-entry-interest" && flow.kind === "mutation"
  ));
  assert.ok(competition.writes.includes("submit-entry-interest.draft.competitionId"));
  assert.ok(quantity.writes.includes("submit-entry-interest.draft.totalEntryCost"));
  assert.ok(mutation.reads.includes("submit-entry-interest.draft.competitionId"));
  assert.ok(mutation.reads.includes("submit-entry-interest.draft.ticketQuantity"));
  assert.ok(mutation.reads.includes("submit-entry-interest.draft.totalEntryCost"));
});

test("review of a contract-declared existing record retains its durable state dependency", () => {
  const plan = buildInteractionContract({
    summary: "Review an existing durable record", projectType: "tool", auth: { required: false },
    routes: [{ path: "/record", name: "Record" }],
    entities: [{ name: "record", fields: [{ name: "reference", type: "string" }] }],
    operations: [{ id: "read-record", kind: "read", entity: "record", journey: "review-record" }],
    journeys: [{ id: "review-record", title: "Review record", priority: "primary", steps: [
      { action: "review the existing record", target: "record summary",
        expect: "the saved record is visible" },
    ] }],
    integrations: [], states: [], acceptance: [], deferred: [],
  }, { modulePlan: [], bindings: [] });

  assert.equal(plan.valid, true, plan.problems.join("; "));
  assert.equal(plan.scenarios["review-record"].startState, "inherits");
  assert.deepEqual(plan.flows[0].reads, ["review-record.durable.record"]);
});

test("structured reads never borrow a matching producer from an earlier journey", () => {
  const base = {
    summary: "Independent competition journeys", projectType: "tool",
    auth: { required: false }, routes: [{ path: "/", name: "Home" }],
    entities: [{ name: "draft", owned: false, fields: [
      { name: "competitionId", type: "string" },
      { name: "competitionTitle", type: "string" },
      { name: "ticketQuantity", type: "number" },
      { name: "ticketsRemaining", type: "number" },
    ] }],
    operations: [], integrations: [], states: [], acceptance: [], deferred: [],
    journeys: [
      { id: "view-competition-details", title: "View details", priority: "primary",
        stage: "primary_journey", steps: [
          { action: "select a competition", target: "competition", primitive: "selection",
            operates: ["competitionId"], expect: "competition details are visible" },
        ] },
      { id: "enter-demo-competition", title: "Enter a competition", priority: "secondary",
        stage: "supporting", steps: [
          { action: "select a competition title", target: "competition title", primitive: "selection",
            operates: ["competitionTitle"], expect: "the title is selected" },
          { action: "choose a ticket quantity", target: "ticket quantity", primitive: "selection",
            operates: ["ticketQuantity", "ticketsRemaining"], expect: "the quantity is selected" },
        ] },
      { id: "entry-validation", title: "Validate entry", priority: "secondary",
        stage: "supporting", steps: [
          { action: "open the entry form", target: "/", expect: "the form is visible" },
          { action: "confirm the entry", target: "confirm entry", reads: [
            "competitionId", "competitionTitle", "ticketQuantity", "ticketsRemaining",
          ], expect: "validation is visible" },
        ] },
    ],
  };

  const invalid = deriveBuildSpec(base);
  assert.equal(invalid.verdict.ok, false);
  const missing = invalid.verdict.interaction.issues
    .filter((issue) => issue.code === "interaction_state_dependency_missing")
    .map((issue) => issue.missingStatePath);
  assert.deepEqual(missing, [
    "entry-validation.draft.competitionId",
    "entry-validation.draft.competitionTitle",
    "entry-validation.draft.ticketQuantity",
    "entry-validation.draft.ticketsRemaining",
  ]);
  assert.ok(missing.every((path) => path.startsWith("entry-validation.")));

  const corrected = {
    ...base,
    journeys: base.journeys.map((journey) => journey.id !== "entry-validation" ? journey : {
      ...journey,
      steps: [
        { action: "select a competition", target: "competition", primitive: "selection",
          operates: ["competitionId", "competitionTitle", "ticketsRemaining"],
          expect: "the selected competition is visible" },
        { action: "choose a ticket quantity", target: "ticket quantity", primitive: "selection",
          operates: ["ticketQuantity"], expect: "the quantity is selected" },
        journey.steps[1],
      ],
    }),
  };
  const spec = deriveBuildSpec(corrected);
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));
  assert.ok(spec.modulePlan.length > 0);
  assert.ok(spec.moduleContracts.specifications.length > 0);
});

test("opening one item produces its selection through the activation instead of a duplicate chooser", () => {
  const contract = {
    summary: "Open a featured item", projectType: "website", auth: { required: false },
    routes: [{ path: "/", name: "Home" }, { path: "/competition", name: "Detail" }],
    entities: [{ name: "entry", owned: false, fields: [
      { name: "competitionId", type: "string" }, { name: "ticketQuantity", type: "number" },
    ] }], operations: [], integrations: [], states: [], acceptance: [], deferred: [],
    journeys: [{ id: "reserve-competition-entry", title: "Reserve entry", priority: "primary",
      stage: "primary_journey", steps: [
        { action: "open the homepage", target: "/", expect: "featured competitions are visible" },
        { action: "open a featured competition", target: "featured competition card",
          operates: ["competitionId"], expect: "the competition detail page is visible" },
        { action: "choose a ticket quantity", target: "ticket quantity", primitive: "selection",
          operates: ["ticketQuantity"], reads: ["competitionId"], expect: "the total updates" },
      ] }],
  };
  const spec = deriveBuildSpec(contract);
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));
  const openFlows = spec.interactionContract.flows.filter((flow) => (
    flow.journeyId === "reserve-competition-entry" && flow.stepIndex === 1
  ));
  assert.equal(openFlows.length, 1, JSON.stringify(openFlows));
  assert.equal(openFlows[0].kind, "flow_start");
  assert.equal(openFlows[0].control.accessibleName, "featured competition card");
  assert.equal(openFlows[0].control.logicalField, "competitionId");
  assert.ok(openFlows[0].writes.includes("reserve-competition-entry.draft.competitionId"));
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

test("retained basic-site smoke aa154da3 keeps one chooser and never invents backend persistence", () => {
  const request = "Build a basic competition website. Use local in-app state; no real payments or backend are required yet.";
  assert.equal(inferRequirementSignals(request).includes("payments"), false);
  assert.equal(inferRequirementSignals(request).includes("saved_data"), false);

  const contract = {
    summary: "A mobile-first competition website with a local entry flow and no backend persistence.",
    projectType: "landing", auth: { required: false, rules: [] },
    routes: [{ path: "/", name: "Home" }, { path: "/competitions/:competitionId", name: "Entry" }],
    entities: [{ name: "entry", owned: false,
      storage: "local in-app state only for the current browser session; not saved to backend",
      fields: [
        ["competitionId", "string"], ["competitionTitle", "string"], ["ticketPricePence", "number"],
        ["ticketQuantity", "number"], ["totalCostPence", "number"], ["skillAnswer", "string"],
        ["entrantName", "string"], ["entrantEmail", "string"], ["confirmationStatus", "string"],
        ["confirmationNumber", "string"],
      ].map(([name, type]) => ({ name, type, required: true })) }],
    operations: [{
      id: "calculate-entry-total", kind: "get", entity: "entry", journey: "enter-a-competition",
      description: "calculate the visible local total",
      responsibilities: [{ type: "functional", behavior: "multiply quantity by ticket price",
        reads: ["ticketQuantity", "ticketPricePence"], writes: ["totalCostPence"] }],
    }, {
      id: "confirm-entry", kind: "create", entity: "entry", journey: "enter-a-competition",
      description: "validate local fields and show a confirmation without backend persistence",
      responsibilities: [
        { type: "functional", behavior: "validate the local entry", reads: ["entrantName", "entrantEmail", "ticketQuantity", "skillAnswer"], writes: ["confirmationStatus"] },
        { type: "functional", behavior: "create a visible local confirmation number", reads: ["competitionId", "ticketQuantity", "entrantEmail"], writes: ["confirmationNumber"] },
      ],
    }],
    journeys: [{ id: "enter-a-competition", title: "A visitor enters a competition", priority: "primary",
      stage: "primary_journey", steps: [
        { action: "open the homepage", target: "/", expect: "the competition homepage is visible" },
        { action: "click the browse competitions call to action", target: "Browse competitions button", expect: "the competitions are visible" },
        { action: "choose a competition", target: "Enter now action on a competition card",
          operates: ["competitionId", "competitionTitle", "ticketPricePence"], primitive: "selection",
          expect: "the selected competition entry view is visible" },
        { action: "choose a ticket quantity", target: "ticket quantity control",
          operates: ["ticketQuantity", "calculate-entry-total"], reads: ["ticketPricePence"], primitive: "selection",
          expect: "the selected quantity and total cost are visible" },
        { action: "answer the skill-based question", target: "skill answer", operates: ["skillAnswer"], primitive: "textbox", expect: "the answer remains visible" },
        { action: "enter contact details", target: "contact form", operates: ["entrantName", "entrantEmail"], expect: "the contact details remain visible" },
        { action: "submit the entry", target: "Submit entry button", operates: ["confirm-entry"],
          reads: ["competitionId", "competitionTitle", "ticketQuantity", "totalCostPence", "skillAnswer", "entrantName", "entrantEmail"],
          expect: "a local confirmation with competition, ticket count, total, and next steps is visible" },
      ] }],
    integrations: [], states: [], acceptance: [
      { id: "a1", statement: "choosing a competition opens its entry view" },
      { id: "a2", statement: "choosing a ticket quantity displays the total cost" },
      { id: "a3", statement: "submitting valid local details displays a confirmation number" },
    ], deferred: [{ item: "backend persistence of competition entries", reason: "the entry uses local in-app state" }],
  };

  const contractVerdict = validateContract(contract);
  assert.equal(contractVerdict.ok, true, contractVerdict.problems.join("; "));
  const spec = deriveBuildSpec(contract);
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));

  const choiceFlows = spec.interactionContract.flows.filter((flow) => (
    flow.journeyId === "enter-a-competition" && flow.stepIndex === 2 && flow.control
  ));
  assert.deepEqual(choiceFlows.map((flow) => flow.control.logicalField), ["competitionId"]);
  assert.deepEqual(choiceFlows[0].producedValues, ["competitionTitle", "ticketPricePence"]);
  for (const field of ["competitionId", "competitionTitle", "ticketPricePence"]) {
    assert.ok(choiceFlows[0].writes.includes(`enter-a-competition.draft.${field}`));
  }

  const responsibilities = spec.capabilityGraph.operationResponsibilities
    .flatMap((operation) => operation.responsibilities || []);
  assert.equal(responsibilities.some((responsibility) => responsibility.type === "persistence"), false);
  assert.equal(spec.capabilityGraph.journeys[0].requiredNodeIds.includes("capability:crud"), false);
  assert.deepEqual(spec.capabilityGraph.nodes.find((node) => node.id === "capability:crud")?.entities, []);
  assert.equal(spec.persistencePlan, null);
  assert.equal(spec.modulePlan.some((module) => module.path.includes("composed/crud")), false);
  assert.deepEqual(contractRuntimeRequirements(spec.contract), { accounts: false, durableMutation: false });
  assert.equal(journeyRequiresPersistentMutation(contract.journeys[0], spec.contract), false);
  const submit = spec.interactionContract.flows.find((flow) => flow.operationId === "confirm-entry");
  assert.equal(submit.kind, "action");
  assert.deepEqual(submit.expectedStateTransition.persists, []);

  // Retained production build 3407db0f: the selected item was expressed as one identity plus
  // explicit metadata outputs, but "Enter Now" made the prose classifier call it typed input.
  // Structured produces must remain authoritative without requiring the model to add a primitive.
  const retainedActivation = structuredClone(contract);
  retainedActivation.journeys[0].steps[2] = {
    action: "open an entry panel from a competition card",
    target: "Enter Now button",
    operates: ["competitionId"],
    produces: ["competitionTitle", "ticketPricePence"],
    expect: "the selected competition entry panel is visible",
  };
  const retainedSpec = deriveBuildSpec(retainedActivation);
  assert.equal(retainedSpec.verdict.ok, true, retainedSpec.verdict.problems.join("; "));
  const retainedProducer = retainedSpec.interactionContract.flows.find((flow) => (
    flow.journeyId === "enter-a-competition" && flow.stepIndex === 2
      && flow.valueWritten === "competitionId"
  ));
  assert.equal(retainedProducer.kind, "selection");
  assert.deepEqual(retainedProducer.producedValues, ["competitionTitle", "ticketPricePence"]);
  for (const field of ["competitionId", "competitionTitle", "ticketPricePence"]) {
    assert.ok(retainedProducer.writes.includes(`enter-a-competition.draft.${field}`));
  }
  assert.ok(retainedProducer.control.roles.includes("button"));
  assert.ok(!retainedSpec.verdict.problems.some((problem) => problem.includes("reads state before it is produced")));
});

test("retained smoke 8fe1191e composes every responsibility owned by one operation", () => {
  const contract = {
    summary: "A transient multi-step basket and simulated checkout.",
    projectType: "other",
    auth: { required: false, model: "none", rules: [] },
    routes: [{ path: "/", name: "Home" }],
    entities: [{
      name: "basketItem", storage: "transient", owned: false,
      fields: [
        ["competitionId", "string"], ["quantity", "number"], ["skillAnswer", "string"],
        ["validationMessage", "string"], ["basketTotal", "number"],
      ].map(([name, type]) => ({ name, type, required: true })),
    }, {
      name: "simulatedOrder", storage: "transient", owned: false,
      fields: [
        ["orderNumber", "string"], ["basketCleared", "boolean"], ["basketTotal", "number"],
      ].map(([name, type]) => ({ name, type, required: true })),
    }],
    operations: [{
      id: "add-to-basket", entity: "basketItem", kind: "create", journey: "enter-a-competition",
      description: "Validate and copy a selected entry into transient basket state.",
      responsibilities: [{
        type: "functional", behavior: "validate the entry",
        reads: ["competitionId", "quantity", "skillAnswer"], writes: ["validationMessage"],
      }, {
        type: "functional", behavior: "copy the selected entry into the basket",
        reads: ["competitionId", "quantity", "skillAnswer"],
        writes: ["competitionId", "quantity", "skillAnswer"],
      }, {
        type: "functional", behavior: "calculate the basket total",
        reads: ["quantity"], writes: ["basketTotal"],
      }],
    }, {
      id: "complete-simulated-order", entity: "simulatedOrder", kind: "create",
      journey: "enter-a-competition", description: "Confirm the local order and clear the basket.",
      responsibilities: [{
        type: "functional", behavior: "create the simulated confirmation",
        reads: ["competitionId", "quantity", "skillAnswer", "basketTotal"],
        writes: ["orderNumber"],
      }, {
        type: "functional", behavior: "clear the transient basket after confirmation",
        reads: ["competitionId", "quantity"], writes: ["basketCleared"],
      }],
    }],
    journeys: [{
      id: "enter-a-competition", title: "Enter a competition", priority: "primary",
      stage: "primary_journey", steps: [
        { action: "open the homepage", target: "/", expect: "the homepage is visible" },
        { action: "choose a competition", target: "competition card", primitive: "selection",
          operates: ["competitionId"], expect: "the competition is selected" },
        { action: "choose a quantity", target: "quantity", primitive: "selection",
          operates: ["quantity"], expect: "the quantity is selected" },
        { action: "answer the skill question", target: "skill answer", primitive: "textbox",
          operates: ["skillAnswer"], expect: "the answer is visible" },
        { action: "add the entries to the basket", target: "add entries", operates: ["add-to-basket"],
          reads: ["competitionId", "quantity", "skillAnswer"],
          expect: "the basket total and entry are visible" },
        { action: "complete the simulated checkout", target: "complete entry",
          operates: ["complete-simulated-order"],
          reads: ["competitionId", "quantity", "skillAnswer", "basketTotal"],
          expect: "the order number is visible" },
        { action: "check the basket after checkout", target: "basket indicator",
          reads: ["basketCleared"], expect: "the basket is empty" },
      ],
      acceptance: ["the transient order completes and clears the basket"],
    }],
    integrations: [], states: [],
    acceptance: [
      { id: "selection", statement: "the competition, quantity, and answer remain selected" },
      { id: "total", statement: "adding the entry displays a basket total" },
      { id: "order", statement: "the simulated order completes and clears the basket" },
    ],
    deferred: [],
  };

  const contractVerdict = validateContract(contract);
  assert.equal(contractVerdict.ok, true, contractVerdict.problems.join("; "));
  const spec = deriveBuildSpec(contract);
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));

  const flows = spec.interactionContract.flows
    .filter((flow) => flow.journeyId === "enter-a-competition");
  const add = flows.find((flow) => flow.operationId === "add-to-basket");
  const complete = flows.find((flow) => flow.operationId === "complete-simulated-order");
  for (const path of [
    "enter-a-competition.custom.competitionId",
    "enter-a-competition.custom.quantity",
    "enter-a-competition.custom.skillAnswer",
    "enter-a-competition.custom.basketTotal",
  ]) assert.ok(add.writes.includes(path), `${path} must be produced by add-to-basket`);
  for (const path of [
    "enter-a-competition.custom.competitionId",
    "enter-a-competition.custom.quantity",
    "enter-a-competition.custom.skillAnswer",
    "enter-a-competition.custom.basketTotal",
  ]) assert.ok(complete.reads.includes(path), `${path} must reach complete-simulated-order`);
  assert.ok(complete.writes.includes("enter-a-competition.custom.basketCleared"));
  assert.ok(flows.indexOf(add) < flows.indexOf(complete));
  assert.ok(!spec.verdict.problems.some((problem) => problem.includes("reads state before it is produced")));
  assert.ok(spec.modulePlan.length > 0);
});

test("retained basic-site smoke a983b37 removes invented durable recovery from a simulated entry", () => {
  const prompt = "Build a basic but polished competition website for low-budget competitions, aimed at UK users entering affordable prize draws around £100–£200. The site should feel trustworthy, modern, and simple. Core experience: a homepage with a hero section explaining low-cost competitions, featured live competitions, clear pricing/odds-style information, how it works, recent winners, trust/safety messaging, FAQ, and a call to action. Include a competitions listing page with several demo competitions such as £100 cash, £200 shopping voucher, gaming bundle, weekend treat fund, etc. Include competition detail pages showing prize value, ticket price, remaining tickets, closing date, short description, rules summary, and an entry journey where the user chooses ticket quantity, answers a simple skill question, sees a basket/entry summary, and receives a confirmation-style success state. This is a demo/basic site, so payments should be simulated rather than real. Include responsive layouts for mobile, tablet, and desktop. Use GBP formatting throughout and friendly UK copy. Branding: affordable, cheerful, trustworthy; name the product Budget Competitions.";
  const contract = normaliseContract({
    summary: "A basic competition website with a simulated entry flow.",
    projectType: "landing",
    auth: { required: false, rules: [] },
    routes: [{ path: "/", name: "Home" }],
    entities: [{ name: "demoEntry", owned: true, fields: [
      "competitionId", "remainingTickets", "ticketQuantity", "skillAnswer",
      "reference", "paymentStatus", "status", "createdAt",
    ].map((name) => ({ name, type: name === "ticketQuantity" ? "number" : "string" })) }],
    operations: [{
      id: "confirmDemoEntry", kind: "create", entity: "demoEntry", journey: "enter-demo-competition",
      description: "create the confirmation-style simulated entry",
      responsibilities: [{
        type: "persistence", capability: "crud", capabilityMethod: "create",
        reads: ["competitionId", "ticketQuantity", "skillAnswer"],
        writes: ["reference", "paymentStatus", "status", "createdAt"],
      }],
    }, {
      id: "readEntryByReference", kind: "read", entity: "demoEntry", journey: "enter-demo-competition",
      description: "recover the entry by reference after reload",
      responsibilities: [{
        type: "persistence", capability: "crud", capabilityMethod: "get",
        reads: ["reference"], writes: ["paymentStatus", "status", "createdAt"],
      }],
    }],
    journeys: [{
      id: "enter-demo-competition", title: "Enter a demo competition", priority: "primary",
      stage: "primary_journey", steps: [
        { action: "open the homepage", target: "/", expect: "competitions are visible" },
        { action: "select a competition", target: "competition card", primitive: "selection",
          operates: ["competitionId", "remainingTickets"], expect: "the entry form opens" },
        { action: "choose a ticket quantity", target: "ticket quantity", primitive: "selection",
          operates: ["ticketQuantity"], reads: ["remainingTickets"], expect: "the quantity is visible" },
        { action: "answer the skill question", target: "skill answer", primitive: "textbox",
          operates: ["skillAnswer"], expect: "the answer is visible" },
        { action: "review the demo entry", target: "entry summary",
          reads: ["competitionId", "ticketQuantity", "skillAnswer"], expect: "the summary is visible" },
        { action: "confirm the simulated entry", target: "confirm entry", operates: ["confirmDemoEntry"],
          reads: ["competitionId", "ticketQuantity", "skillAnswer"], expect: "a confirmation reference is visible" },
        { action: "reload and recover the entry", target: "recovery", operates: ["readEntryByReference"],
          reads: ["reference", "paymentStatus", "status", "createdAt"], expect: "the recovered entry is visible" },
      ], acceptance: ["the simulated confirmation is visible", "the entry can be recovered after reload"],
    }],
    integrations: [], states: [], acceptance: [
      { id: "a1", statement: "competitions are visible" },
      { id: "a2", statement: "the entry summary is visible" },
      { id: "a3", statement: "the simulated confirmation is visible" },
      { id: "a4", statement: "the entry can be recovered by reference after reload" },
    ], deferred: [],
  }, { prompt });

  assert.deepEqual(contract.buildProfile.requirementSignals, []);
  assert.equal(contract.entities[0].owned, false);
  assert.match(contract.entities[0].storage, /client-only transient/i);
  assert.deepEqual(contract.operations.map((operation) => operation.id), ["confirmDemoEntry"]);
  assert.equal(contract.operations[0].responsibilities[0].type, "functional");
  assert.equal(contract.journeys[0].steps.some((step) => /recover|reload/i.test(step.action)), false);
  assert.equal(contract.acceptance.some((entry) => /recover|reload/i.test(JSON.stringify(entry))), false);

  const verdict = validateContract(contract);
  assert.equal(verdict.ok, true, verdict.problems.join("; "));
  const spec = deriveBuildSpec(contract);
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));
  assert.equal(spec.capabilityGraph.operationResponsibilities.flatMap((row) => row.responsibilities)
    .some((responsibility) => responsibility.type === "persistence"), false);
  assert.deepEqual(contractRuntimeRequirements(spec.contract), { accounts: false, durableMutation: false });
  assert.equal(journeyRequiresPersistentMutation(contract.journeys[0], spec.contract), false);
});
