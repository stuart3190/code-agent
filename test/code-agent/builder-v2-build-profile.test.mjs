import assert from "node:assert/strict";
import test from "node:test";

process.env.CODE_AGENT_STORE = "memory";

const {
  latestBuildProfile, requestUsesTransientSimulation, resolveBuildProfile, validateBuildProfileInput,
} = await import("../../shell/shared/buildProfile.mjs");
const { classifyComplexity } = await import("../../shell/server/lib/appBuild/buildProfile.mjs");
const { deriveBuildSpec } = await import("../../shell/server/lib/builderV2/buildSpec.mjs");
const { generateContract, normaliseContract } = await import("../../shell/server/lib/appBuild/contractAgent.mjs");
const { validateContract } = await import("../../shell/shared/implementationContract.mjs");
const { MemoryConversationStore } = await import("../../shell/server/lib/conversationStore.mjs");
const { MemoryCodeAgentStore } = await import("../../shell/server/lib/codeAgentStore.mjs");
const { assembleInput, postUserMessage } = await import("../../shell/server/lib/leadAgentService.mjs");
const { handleConversations } = await import("../../shell/server/routes/conversations.mjs");

const OWNER = "88888888-8888-4888-8888-888888888888";

function contract({
  summary = "A structured product",
  buildProfile,
  entities = [],
  operations = [],
  steps = [
    { action: "open the product", target: "/", expect: "the product is visible" },
    { action: "review the result", target: "main content", expect: "the result is visible" },
  ],
  auth = { required: false, model: null, rules: [] },
  integrations = [],
} = {}) {
  return {
    summary,
    projectType: "other",
    buildProfile,
    journeys: [{
      id: "primary-flow", title: "Primary flow", priority: "primary", stage: "primary_journey",
      steps, acceptance: ["the requested outcome is visible"],
    }],
    routes: [{ path: "/", name: "Home", purpose: summary, auth: false }],
    entities,
    operations,
    auth,
    integrations,
    states: [], acceptance: [], deferred: [],
  };
}

function field(name, type = "string") {
  return { name, type, required: true };
}

test("contract normalization embeds the same authoritative profile before graph derivation", () => {
  const profile = resolveBuildProfile({
    prompt: "Build an application with saved customer data.",
    input: { requestedBuildType: "application", requirementSignals: ["saved_data"] },
  });
  const normalized = normaliseContract(contract({
    entities: [{ name: "record", fields: [field("name")] }],
    operations: [{
      id: "save-record", entity: "record", kind: "create", journey: "primary-flow",
      responsibilities: [{ type: "persistence", capability: "crud", capabilityMethod: "create", reads: ["name"], writes: ["id"] }],
    }],
    steps: [
      { action: "enter a record", target: "record form", operates: ["name"], expect: "the value is visible" },
      { action: "save the record", target: "save", operates: ["save-record"], expect: "the saved record is visible" },
    ],
  }), { prompt: "Build an application with saved customer data.", buildProfile: profile });
  assert.deepEqual(normalized.buildProfile, profile);
  const spec = deriveBuildSpec(normalized);
  assert.deepEqual(spec.contract.buildProfile, spec.capabilityGraph.buildProfile);
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));
});

test("contract generation receives authoritative product guidance before its zero-model fixture dispatch", async () => {
  let ask = "";
  const profile = resolveBuildProfile({
    prompt: "Create a company website with a contact form.",
    input: { requestedBuildType: "website" },
  });
  const fixtureContract = contract({ summary: "A company website with a contact form" });
  const outcome = await generateContract({
    prompt: "Create a company website with a contact form.",
    buildProfile: profile,
    provider: {
      model: "zero-model-fixture",
      async runTurn(input) {
        ask = input.messages?.[0]?.content || "";
        return {
          text: JSON.stringify(fixtureContract), toolCalls: [],
          usage: { input: 0, output: 0, total: 0 },
        };
      },
    },
  });
  assert.ok(outcome.contract);
  assert.equal(outcome.contract.buildProfile.resolvedBuildType, "website");
  assert.match(ask, /AUTHORITATIVE BUILDER V2 PRODUCT PROFILE/);
  assert.match(ask, /Website means content and presentation are likely dominant/);
});

test("contract normalization makes read and terminal functional results valid before graph derivation", () => {
  const source = contract({
    summary: "An application that renders supplied records into a downloadable result",
    entities: [{ name: "record", fields: [field("rows")], owned: false }],
    operations: [{
      id: "render-records", entity: "record", kind: "export", journey: "primary-flow",
      description: "render the supplied records into an observable artifact",
      responsibilities: [{
        type: "functional", behavior: "render the supplied records into an observable artifact",
        reads: ["rows"], writes: [],
      }],
    }],
    steps: [
      { action: "enter report rows", target: "rows", operates: ["rows"], expect: "the report rows are visible" },
      { action: "render the records", target: "render control", reads: ["render-records"], expect: "a downloadable result is offered" },
    ],
  });
  source.acceptance = [
    { id: "a1", statement: "entered report rows remain visible before rendering", journey: "primary-flow", kind: "interaction" },
    { id: "a2", statement: "using the render control offers a downloadable result", journey: "primary-flow", kind: "output" },
    { id: "a3", statement: "the rendered result visibly reflects the supplied rows", journey: "primary-flow", kind: "output" },
  ];

  const normalized = normaliseContract(source, {
    prompt: source.summary,
    buildProfile: { requestedBuildType: "application", requirementSignals: ["custom_logic", "export"] },
  });
  const responsibility = normalized.operations[0].responsibilities[0];
  assert.deepEqual(responsibility.outputEffect, {
    type: "transient_result", effect: "artifact", operationKind: "export", durable: false,
  });
  const verdict = validateContract(normalized);
  assert.equal(verdict.ok, true, verdict.problems.join("; "));
  const spec = deriveBuildSpec(normalized);
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));
});

test("Auto resolves a simple marketing-site prompt as website without forcing application behavior", () => {
  const profile = resolveBuildProfile({
    prompt: "Create a marketing website with Home, About, Services and Contact pages.",
  });
  assert.equal(profile.requestedBuildType, "auto");
  assert.equal(profile.resolvedBuildType, "website");
  const spec = deriveBuildSpec(contract({ summary: "A marketing website", buildProfile: profile }));
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));
  assert.equal(spec.buildProfile.resolvedBuildType, "website");
  assert.equal(spec.capabilityGraph.operationResponsibilities.length, 0);
});

const RETAINED_BUDGET_COMPETITION_REQUEST = "Build a basic, polished public website for a low-budget competition brand called Budget Competitions. It should promote affordable prize draws around £100 and £200. Target users are UK visitors looking for cheap, simple competitions. Key screens/sections: a homepage hero explaining low-cost competitions, featured competition cards for examples such as £100 Cash Boost, £200 Shopping Voucher, and £150 Weekend Treat; each card should show prize value, ticket price, entries remaining/progress, draw date/countdown-style copy, and a clear Enter now call-to-action. Include a simple How it works section (choose a competition, answer/confirm entry, wait for draw), trust/legitimacy messaging, FAQs, and an email/contact interest form for users to register interest or get notified. Since no payment or compliance details were provided, do not implement real-money checkout; make entry buttons open a friendly register interest modal or scroll to the form. Use UK currency formatting and a clean budget-friendly visual identity with bright, trustworthy colours. Make it fully responsive and verify the primary journey: visitor opens site, views competitions, clicks enter, submits interest form, and sees success feedback.";

test("register-interest website copy does not invent account or payment requirements", () => {
  const profile = resolveBuildProfile({ prompt: RETAINED_BUDGET_COMPETITION_REQUEST });
  assert.equal(profile.resolvedBuildType, "website");
  assert.equal(profile.requirementSignals.includes("user_accounts"), false);
  assert.equal(profile.requirementSignals.includes("payments"), false);

  const genuineAccounts = resolveBuildProfile({
    prompt: "Build an application where members can register an account and sign in.",
  });
  assert.equal(genuineAccounts.requirementSignals.includes("user_accounts"), true);
});

test("retained smoke profile remains authoritative throughout contract generation", async () => {
  const retainedProfile = Object.freeze({
    version: 1,
    requestedBuildType: "auto",
    resolvedBuildType: "auto",
    applicationSubtype: "auto",
    requirementSignals: [],
    inferenceSource: "auto",
    confidence: 0.45,
  });
  let dispatches = 0;
  const fixture = contract({ summary: "A public competition interest website" });
  fixture.acceptance = [
    { id: "a1", statement: "the competition cards are visible", journey: "primary-flow", kind: "content" },
    { id: "a2", statement: "the interest action is reachable", journey: "primary-flow", kind: "interaction" },
    { id: "a3", statement: "the visitor sees interest feedback", journey: "primary-flow", kind: "interaction" },
  ];
  const outcome = await generateContract({
    prompt: RETAINED_BUDGET_COMPETITION_REQUEST,
    buildProfile: retainedProfile,
    provider: {
      model: "zero-model-retained-smoke",
      async runTurn() {
        dispatches += 1;
        return {
          text: JSON.stringify(fixture),
          toolCalls: [], usage: { input: 0, output: 0, total: 0 },
        };
      },
    },
  });

  assert.equal(dispatches, 1, "a false auth obligation forced a correction dispatch");
  assert.deepEqual(outcome.contract?.buildProfile, retainedProfile);
  assert.equal(outcome.problems.length, 0, outcome.problems.join("; "));
});

test("a stored resolved profile is not re-inferred from register-interest turn copy", () => {
  const retainedProfile = {
    version: 1, requestedBuildType: "auto", resolvedBuildType: "auto",
    applicationSubtype: "auto", requirementSignals: [], inferenceSource: "auto", confidence: 0.45,
  };
  const restored = latestBuildProfile([{
    content: RETAINED_BUDGET_COMPETITION_REQUEST,
    payload: { build_profile: retainedProfile },
  }]);
  assert.deepEqual(restored, retainedProfile);
});

test("explicit Website remains website-oriented while requested forms and integrations remain represented", () => {
  const profile = resolveBuildProfile({
    prompt: "A website with a contact form connected to our email integration.",
    input: { requestedBuildType: "website" },
  });
  const source = contract({
    summary: "A content-led company website with a contact form",
    buildProfile: profile,
    entities: [{ name: "message", fields: [field("name"), field("email"), field("body")] }],
    operations: [{
      id: "submit-message", entity: "message", kind: "create", journey: "primary-flow",
      responsibilities: [{
        type: "persistence", capability: "crud", capabilityMethod: "create",
        reads: ["name", "email", "body"], writes: ["id"],
      }],
    }],
    steps: [
      { action: "open the contact page", target: "/contact", expect: "the contact form is visible" },
      { action: "enter and submit a message", target: "contact form", operates: ["name", "email", "body"], expect: "a success message is visible" },
    ],
    integrations: [{ name: "email", purpose: "deliver the submitted message", required: true }],
  });
  const spec = deriveBuildSpec(source);
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));
  assert.equal(spec.buildProfile.resolvedBuildType, "website");
  assert.ok(spec.capabilityGraph.nodes.some((node) => node.capabilityId === "crud"));
  assert.equal(spec.contract.integrations[0].name, "email");
});

test("explicit Application makes structured behavior and state flow a planning invariant", () => {
  const profile = resolveBuildProfile({
    prompt: "Build an application that tracks an adjustable counter.",
    input: { requestedBuildType: "application" },
  });
  const source = contract({
    summary: "An interactive counter application",
    buildProfile: profile,
    entities: [{ name: "counter", fields: [field("value", "number")] }],
    operations: [{
      id: "change-counter", entity: "counter", kind: "update", journey: "primary-flow",
      responsibilities: [{ type: "persistence", capability: "crud", capabilityMethod: "update", reads: ["value"], writes: ["value"] }],
    }],
    steps: [
      { action: "open the counter", target: "/", reads: ["value"], expect: "the current value is visible" },
      { action: "change the value", target: "counter control", operates: ["value"], expect: "the changed value is visible" },
    ],
  });
  const spec = deriveBuildSpec(source);
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));
  assert.ok(spec.capabilityGraph.operationResponsibilities.length > 0);
  assert.ok(spec.capabilityGraph.journeys[0].dataFlows.some((flow) => flow.reads.length || flow.writes.length));

  const incomplete = deriveBuildSpec(contract({ buildProfile: profile }));
  assert.equal(incomplete.verdict.ok, false);
  assert.ok(incomplete.verdict.problems.includes(
    "build_profile_contract_incomplete signal=application missing=behavior_or_stateful_journey",
  ));
});

test("Application plus SaaS carries account and durable ownership context without inventing payments", () => {
  const profile = resolveBuildProfile({
    prompt: "Build a SaaS application for teams to keep shared records.",
    input: { requestedBuildType: "application", applicationSubtype: "saas" },
  });
  assert.equal(profile.applicationSubtype, "saas");
  assert.ok(profile.requirementSignals.includes("user_accounts"));
  assert.ok(profile.requirementSignals.includes("saved_data"));
  assert.ok(!profile.requirementSignals.includes("payments"));
  const spec = deriveBuildSpec(contract({
    buildProfile: profile,
    entities: [{ name: "record", owned: true, fields: [field("workspaceId"), field("name")] }],
    operations: [{
      id: "save-record", entity: "record", kind: "create", journey: "primary-flow",
      responsibilities: [{ type: "persistence", capability: "crud", capabilityMethod: "create", reads: ["workspaceId", "name"], writes: ["id"] }],
    }],
    steps: [
      { action: "sign in and open a workspace", target: "workspace", reads: ["workspaceId"], expect: "the workspace is visible" },
      { action: "create a record", target: "record form", operates: ["name"], expect: "the saved record is visible" },
    ],
    auth: { required: true, model: "email and password", rules: ["records belong to a workspace"] },
  }));
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));
  assert.ok(!spec.contract.operations.some((operation) => operation.kind === "payment"));
});

test("explicitly excluded capabilities do not become inferred requirement signals", () => {
  const profile = resolveBuildProfile({
    prompt: "Build a basic website using local in-app state; no real payments or backend are required yet.",
  });
  assert.equal(profile.resolvedBuildType, "website");
  assert.equal(profile.requirementSignals.includes("payments"), false);
  assert.equal(profile.requirementSignals.includes("saved_data"), false);
});

test("simulated rather than real payments do not become a payment requirement", () => {
  const profile = resolveBuildProfile({
    prompt: "Build a demo/basic competition website, so payments should be simulated rather than real.",
  });
  assert.equal(profile.resolvedBuildType, "website");
  assert.equal(profile.requirementSignals.includes("payments"), false);
  assert.equal(profile.requirementSignals.includes("saved_data"), false);

  const durable = resolveBuildProfile({
    prompt: "Build a demo checkout with simulated payments, but save entries to the backend for recovery.",
  });
  assert.equal(durable.requirementSignals.includes("payments"), false);
  assert.equal(durable.requirementSignals.includes("saved_data"), true);
});

test("a demo checkout that explicitly declines payment integration is not a payment requirement", () => {
  const profile = resolveBuildProfile({
    prompt: "Competition detail flow. Do not integrate real payments; label checkout as demo/reserve entry so it is safe for preview.",
  });
  assert.equal(profile.requirementSignals.includes("payments"), false);
});

test("retained basic competition request is not mistaken for Unity or real payments", () => {
  const prompt = `Build a basic public competition website for Budget Competitions.
    This first version does not need real payments; it should use a simulated reservation and
    show a confirmation state with entry quantity and entrant details. Keep all state local/in-browser for now; no real payment or backend
    required. Avoid gambling-heavy visuals; make it feel like transparent community prize competitions.`;
  const complexity = classifyComplexity({ prompt });
  const profile = resolveBuildProfile({
    prompt,
    input: {
      version: 1, requestedBuildType: "auto", resolvedBuildType: "auto",
      applicationSubtype: "auto", requirementSignals: [], inferenceSource: "auto", confidence: 0.45,
    },
  });
  assert.equal(complexity.level, "simple", complexity.reasons.join("; "));
  assert.equal(profile.resolvedBuildType, "website");
  assert.equal(profile.requirementSignals.includes("payments"), false);
});

test("comma-separated exclusions and session-local catalogue selections remain transient", () => {
  const prompt = [
    "Build a polished software catalogue with sample data.",
    "No user accounts, team workspaces, or administrative backend.",
    "Let visitors browse software entries, filter them, open a detail view, select an item for comparison, and see confirmation.",
    "Persist comparison selections locally for the session if appropriate.",
  ].join(" ");
  const source = contract({
    summary: "A searchable software catalogue with session-local comparison selections",
    entities: [{
      name: "catalogueSelection", owned: false, storage: "client_session",
      fields: [field("softwareId"), field("softwareName"), field("category"),
        field("platform"), field("successMessage")],
    }],
    operations: [{
      id: "record-catalogue-selection", entity: "catalogueSelection", kind: "create",
      journey: "primary-flow", description: "record a comparison selection in session-local state",
      responsibilities: [{
        id: "record-selection", type: "persistence",
        capability: "crud", capabilityMethod: "create",
        reads: ["softwareId", "softwareName", "category"], writes: ["successMessage"],
      }],
    }],
    steps: [
      { action: "browse software", target: "catalogue grid", expect: "software entries are visible" },
      { action: "filter software", target: "category filter", operates: ["category"], expect: "matching software is visible" },
      { action: "open software details", target: "software card", operates: ["softwareId", "softwareName", "platform"], expect: "the detail view is visible" },
      { action: "select software for comparison", target: "compare control", operates: ["record-catalogue-selection", "successMessage"], expect: "a visible selection confirmation appears" },
      { action: "review the selection", target: "confirmation panel",
        reads: ["softwareId", "softwareName", "category"], expect: "the selected software is visible" },
    ],
  });
  source.acceptance = [
    { id: "a1", statement: "catalogue entries can be filtered by category", journey: "primary-flow", kind: "interaction" },
    { id: "a2", statement: "software details open from the catalogue", journey: "primary-flow", kind: "interaction" },
    { id: "a3", statement: "a comparison selection shows visible confirmation", journey: "primary-flow", kind: "output" },
  ];

  assert.equal(requestUsesTransientSimulation(prompt), true);
  const profile = resolveBuildProfile({ prompt });
  assert.equal(profile.requirementSignals.includes("saved_data"), false);
  const normalized = normaliseContract(source, { prompt, buildProfile: profile });
  assert.equal(normalized.entities[0].storage.includes("client-only transient"), true);
  assert.equal(normalized.operations[0].responsibilities[0].type, "functional");
  assert.equal("capability" in normalized.operations[0].responsibilities[0], false);
  assert.equal(validateContract(normalized).ok, true, validateContract(normalized).problems.join("; "));

  const spec = deriveBuildSpec(normalized);
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));
  assert.equal(spec.capabilityGraph.nodes.some((node) => node.id === "capability:client_session"), false);
  const crudNode = spec.capabilityGraph.nodes.find((node) => node.id === "capability:crud");
  assert.deepEqual(crudNode?.entities, []);
  assert.deepEqual(crudNode?.requiredOperations, []);
  assert.equal(spec.capabilityGraph.journeys.some((journey) => (
    journey.requiredNodeIds.includes("capability:crud")
  )), false);
  const responsibility = spec.capabilityGraph.operationResponsibilities[0].responsibilities[0];
  assert.equal(responsibility.type, "custom_functional");
  assert.deepEqual(responsibility.declaredReads, ["softwareId", "softwareName", "category"]);
  assert.deepEqual(responsibility.declaredWrites, ["successMessage"]);
  const customBehavior = spec.capabilityGraph.nodes.find((node) => (
    node.id === responsibility.customBehavior
  ));
  assert.ok(customBehavior?.extension?.module);
  assert.ok(spec.modulePlan.length > 0, "the retained contract did not reach module planning");
});

test("session-local qualification does not hide a separate durable backend requirement", () => {
  const prompt = "Persist draft filters locally for the session, but save member records to the backend and restore them after reload.";
  assert.equal(requestUsesTransientSimulation(prompt), false);
  assert.equal(resolveBuildProfile({ prompt }).requirementSignals.includes("saved_data"), true);
});

test("Application plus custom calculations preserves novel transformation as custom_behavior", () => {
  const profile = resolveBuildProfile({
    prompt: "Build an application that calculates derived totals and saves them.",
    input: { requestedBuildType: "application", requirementSignals: ["custom_logic"] },
  });
  const spec = deriveBuildSpec(contract({
    buildProfile: profile,
    entities: [{ name: "estimate", fields: [field("amounts"), field("total", "number")] }],
    operations: [{
      id: "calculate-total", entity: "estimate", kind: "update", journey: "primary-flow",
      responsibilities: [{
        type: "functional", behavior: "derive total from amounts", reads: ["amounts"], writes: ["total"],
      }],
    }],
    steps: [
      { action: "enter amounts", target: "amount fields", operates: ["amounts"], expect: "the amounts are visible" },
      { action: "calculate the total", target: "calculate", operates: ["calculate-total"], expect: "the total is visible" },
    ],
  }));
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));
  const functional = spec.capabilityGraph.operationResponsibilities[0].responsibilities
    .find((responsibility) => responsibility.type === "custom_functional");
  assert.ok(functional?.customBehavior);
  assert.equal(functional.capabilityMethod, null);
  assert.equal(functional.persistenceHandoff.capabilityId, "crud");
});

test("Saved data requires and carries durable persistence ownership", () => {
  const profile = resolveBuildProfile({
    prompt: "Build an application where records are saved in a database.",
    input: { requestedBuildType: "application", requirementSignals: ["saved_data"] },
  });
  const spec = deriveBuildSpec(contract({
    buildProfile: profile,
    entities: [{ name: "record", fields: [field("name")] }],
    operations: [{
      id: "save-record", entity: "record", kind: "create", journey: "primary-flow",
      responsibilities: [{ type: "persistence", capability: "crud", capabilityMethod: "create", reads: ["name"], writes: ["id"] }],
    }],
    steps: [
      { action: "enter a record", target: "record form", operates: ["name"], expect: "the value is visible" },
      { action: "save the record", target: "save", operates: ["save-record"], expect: "the saved record is visible" },
    ],
  }));
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));
  assert.ok(spec.capabilityGraph.operationResponsibilities[0].responsibilities
    .some((responsibility) => responsibility.type === "persistence" && responsibility.owner === "capability:crud"));
});

test("Interactive workspace requires a represented interaction and state contract", () => {
  const profile = resolveBuildProfile({
    prompt: "Build an application with an interactive workspace.",
    input: { requestedBuildType: "application", requirementSignals: ["interactive_workspace"] },
  });
  const spec = deriveBuildSpec(contract({
    buildProfile: profile,
    entities: [{ name: "item", fields: [field("position")] }],
    operations: [{
      id: "move-item", entity: "item", kind: "update", journey: "primary-flow",
      responsibilities: [{ type: "persistence", capability: "crud", capabilityMethod: "update", reads: ["position"], writes: ["position"] }],
    }],
    steps: [
      { action: "select an item", target: "workspace item", reads: ["position"], expect: "the item is selected" },
      { action: "move the item", target: "workspace", operates: ["position"], expect: "the item is visible in its new position" },
    ],
  }));
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));
  assert.ok(spec.interactionContract.flows.some((flow) => flow.reads.length || flow.writes.length));
  assert.equal(spec.capabilityGraph.buildProfile.requirementSignals.includes("interactive_workspace"), true);
});

test("the build gate holds the contract to the profile it was generated against, not to its own summary", () => {
  // The contract agent validated against the profile resolved from the REQUEST. Re-inferring at
  // the gate from the model's summary invented obligations no attempt could have satisfied: this
  // request names no signal at all, and the summary's own wording added user_accounts, which
  // demands auth.required — blocking the build before a single generation dispatch.
  const prompt = "Build me something for my dog grooming business";
  const profile = resolveBuildProfile({ prompt });
  assert.deepEqual(profile.requirementSignals, []);

  const normalized = normaliseContract(contract({
    summary: "A grooming app where staff log in to manage and save appointments",
    entities: [{ name: "appointment", fields: [field("slotId"), field("guestName")] }],
    operations: [{
      id: "save-appointment", entity: "appointment", kind: "create", journey: "primary-flow",
      responsibilities: [{
        type: "persistence", capability: "crud", capabilityMethod: "create",
        reads: ["slotId", "guestName"], writes: ["id"],
      }],
    }],
    steps: [
      { action: "choose a slot", target: "slot picker", operates: ["slotId"], expect: "the slot is selected" },
      { action: "enter the guest name and save", target: "details form", operates: ["guestName"], expect: "the saved appointment is visible" },
    ],
  }), { prompt, buildProfile: profile });

  const spec = deriveBuildSpec(normalized);
  assert.deepEqual(spec.buildProfile.requirementSignals, []);
  assert.equal(spec.buildProfile.inferenceSource, profile.inferenceSource);
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));
});

test("an adopted profile keeps every obligation the request actually carried", () => {
  const prompt = "Build an application where users log in and their records are saved.";
  const profile = resolveBuildProfile({ prompt });
  assert.ok(profile.requirementSignals.includes("user_accounts"));

  const spec = deriveBuildSpec(normaliseContract(contract({
    summary: "A records application",
    entities: [{ name: "record", fields: [field("name")] }],
    operations: [{
      id: "save-record", entity: "record", kind: "create", journey: "primary-flow",
      responsibilities: [{
        type: "persistence", capability: "crud", capabilityMethod: "create",
        reads: ["name"], writes: ["id"],
      }],
    }],
    steps: [
      { action: "enter a record", target: "record form", operates: ["name"], expect: "the value is visible" },
      { action: "save the record", target: "save", operates: ["save-record"], expect: "the saved record is visible" },
    ],
    auth: { required: false, model: null, rules: [] },
  }), { prompt, buildProfile: profile }));

  assert.ok(spec.buildProfile.requirementSignals.includes("user_accounts"));
  assert.equal(spec.verdict.ok, false);
  assert.ok(spec.verdict.problems.includes(
    "build_profile_contract_incomplete signal=user_accounts missing=required_auth_semantics",
  ));
});

test("an existing contract without build-profile fields remains compatible through legacy Auto", () => {
  const source = contract({ buildProfile: undefined });
  delete source.buildProfile;
  const spec = deriveBuildSpec(source);
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));
  assert.equal(spec.buildProfile.requestedBuildType, "auto");
  assert.equal(spec.buildProfile.inferenceSource, "legacy_auto");
});

test("invalid browser-supplied build type is rejected before a conversation is created", async () => {
  assert.throws(() => validateBuildProfileInput({ requestedBuildType: "capability:crud" }),
    (error) => error.code === "invalid_build_profile" && error.field === "requestedBuildType");
  const store = new MemoryConversationStore();
  await assert.rejects(postUserMessage(OWNER, {
    text: "Build something",
    buildProfile: { requestedBuildType: "application", capabilities: ["crud"] },
  }, { store }), (error) => error.code === "invalid_build_profile" && error.status === 400);
  assert.equal((await store.listConversations(OWNER)).length, 0);
  await assert.rejects(handleConversations({}, {}, {
    owner: { id: OWNER }, method: "POST",
    body: { text: "Build something", buildProfile: { requestedBuildType: "unknown" } },
  }), (error) => error.code === "invalid_build_profile" && error.status === 400);
});

test("the API intake persists one canonical DTO and supplies it to the Lead Agent context", async () => {
  const store = new MemoryConversationStore();
  let dispatches = 0;
  const { conversation, processing } = await postUserMessage(OWNER, {
    text: "Build an application that saves projects and exports them.",
    buildProfile: {
      requestedBuildType: "application",
      applicationSubtype: "general_application",
      requirementSignals: ["saved_data", "export"],
      inferenceSource: "adjusted",
    },
  }, {
    store,
    processOptions: {
      runStore: new MemoryCodeAgentStore(),
      credentialResolver: async () => ({ provider: "codex", routing: {} }),
      modelFactory: async () => ({
        id: "fixture", model: "fixture",
        async turn() {
          dispatches += 1;
          return {
            text: "The request is understood.",
            output: [{ type: "message", content: [{ type: "output_text", text: "The request is understood." }] }],
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          };
        },
      }),
      reservationStoreFactory: () => ({
        reserve: async () => ({ id: "fixture-reservation", acquired: true, billingLane: "connected_allowance" }),
        settle: async () => {}, release: async () => {}, markAmbiguous: async () => {},
      }),
    },
  });
  await processing;
  const turns = await store.listTurns(OWNER, conversation.id, { limit: 10 });
  const stored = turns.find((turn) => turn.role === "user")?.payload?.build_profile;
  assert.deepEqual(stored, {
    version: 1,
    requestedBuildType: "application",
    resolvedBuildType: "application",
    applicationSubtype: "general_application",
    requirementSignals: ["saved_data", "export"],
    inferenceSource: "adjusted",
    confidence: 1,
  });
  const input = await assembleInput(store, conversation);
  assert.match(input.find((item) => item.role === "user")?.content || "", /AUTHORITATIVE BUILDER V2 PRODUCT PROFILE/);
  assert.equal(dispatches, 1, "only the injected zero-model fixture ran");
});
