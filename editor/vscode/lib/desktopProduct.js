// Host-neutral D9 desktop product controller. It accepts the versioned D1/D3 fixture
// providers explicitly and has no transport, origin, credential, or production fallback.

"use strict";

const { D9_FIXTURE_CLOCK, D9_FIXTURE_SEED, createD9FixtureActionProvider, getD9Scenario } = require("./desktopProductFixtures.js");
const { createPreviewController } = require("./previewFoundation.js");
const { createDeploymentController } = require("./deploymentFoundation.js");

const D9_STATE_KEY = "thrallo.desktopProduct.d9.v1";
const NAVIGATION_ITEMS = Object.freeze([
  Object.freeze({ id: "home", label: "Home", kind: "thrallo", enabled: true }),
  Object.freeze({ id: "conversation", label: "Conversation", kind: "thrallo", enabled: true }),
  Object.freeze({ id: "projects", label: "Projects", kind: "thrallo", enabled: true }),
  Object.freeze({ id: "agents", label: "Agents", kind: "thrallo", enabled: true }),
  Object.freeze({ id: "usage", label: "Usage", kind: "thrallo", enabled: true }),
  Object.freeze({ id: "explorer", label: "Explorer", kind: "code_oss", enabled: true, command: "workbench.view.explorer" }),
  Object.freeze({ id: "search", label: "Search", kind: "code_oss", enabled: true, command: "workbench.view.search" }),
  Object.freeze({ id: "source_control", label: "Source Control", kind: "code_oss", enabled: true, command: "workbench.view.scm" }),
  Object.freeze({ id: "terminal", label: "Terminal", kind: "code_oss", enabled: true, command: "workbench.action.terminal.focus" }),
  Object.freeze({ id: "preview", label: "Preview", kind: "thrallo", enabled: true, package: "D10" }),
  Object.freeze({ id: "cloud_workspace", label: "Cloud Workspace", kind: "future", enabled: false, state: "capability_unavailable" }),
  Object.freeze({ id: "deployments", label: "Deployments", kind: "thrallo", enabled: true, package: "D11" }),
  Object.freeze({ id: "domains", label: "Domains", kind: "thrallo", enabled: true, package: "D11" }),
  Object.freeze({ id: "database", label: "Database", kind: "future", enabled: false, state: "integration_pending", package: "D12" }),
  Object.freeze({ id: "integrations", label: "Integrations", kind: "future", enabled: false, state: "integration_pending", package: "D12" }),
  Object.freeze({ id: "visual_editor", label: "Visual Editor", kind: "future", enabled: false, state: "integration_pending", package: "D13" }),
]);

const PLAN_STATES = Object.freeze(["pending", "approved", "rejected", "changes_requested", "expired", "unavailable", "error"]);
const PLAN_DECISIONS = Object.freeze(["approve", "reject", "request_changes"]);
const BUILD_STATES = Object.freeze([
  "not_started", "planning", "waiting_approval", "queued", "running", "verifying", "repairing",
  "completed", "failed", "canceled", "recovering", "capability_unavailable",
]);

const BUILD_PRESENTATION = Object.freeze({
  not_started: { label: "Not started", progress: 0, active: false },
  planning: { label: "Planning", progress: 12, active: true },
  waiting_approval: { label: "Waiting for approval", progress: 20, active: false },
  queued: { label: "Queued", progress: 28, active: true },
  running: { label: "Building", progress: 56, active: true },
  verifying: { label: "Verifying", progress: 76, active: true },
  repairing: { label: "Repairing", progress: 68, active: true },
  completed: { label: "Completed", progress: 100, active: false },
  failed: { label: "Failed", progress: 64, active: false },
  canceled: { label: "Canceled", progress: 34, active: false },
  recovering: { label: "Recovering", progress: 48, active: true },
  capability_unavailable: { label: "Build capability unavailable", progress: 0, active: false },
});

function createBuildPresentation(state) {
  if (!BUILD_STATES.includes(state)) throw new TypeError(`Unknown D9 build presentation state: ${state}`);
  return Object.freeze({ state, ...BUILD_PRESENTATION[state] });
}

async function createDesktopProductController({
  client,
  localRegistry,
  stateStore = null,
  scenario = "authenticated-paid",
  seed = D9_FIXTURE_SEED,
  previewScenario = "preview-idle",
  localPreviewAdapter = null,
  deploymentScenario = "live-healthy",
  deploymentExportAdapter = null,
} = {}) {
  assertDependencies(client, localRegistry);
  const definition = getD9Scenario(scenario);
  const providerSuite = client.createFixtureProviderSuite({
    seed: `${seed}:providers`,
    scenario: definition.providerScenario,
    capabilities: {},
  });
  const fixtureActions = createD9FixtureActionProvider({ seed: `${seed}:actions`, scenario });
  const accessFixture = client.createDesktopAccessFixture({ scenario: definition.accessScenario, seed: `${seed}:access` });
  const [accountResult, entitlementResult, usageResult, projectsResult, turnsResult, planResult, agentsResult, runResult, modelsResult, modelUsageResult, budgetResult, buildResult, previewResult, deploymentsResult, recent] = await Promise.all([
    accessFixture.provider.getAccount(),
    accessFixture.provider.getEntitlements(),
    accessFixture.provider.getUsage(),
    providerSuite.projects.listProjects(),
    providerSuite.conversations.listTurns(),
    providerSuite.plans.getPlan(),
    providerSuite.agents.listAgents(),
    providerSuite.agents.getRun(),
    providerSuite.models.listModels(),
    providerSuite.models.getUsage(),
    providerSuite.models.getBudget(),
    providerSuite.builds.getBuild(),
    providerSuite.preview.getPreview(),
    providerSuite.deployments.listDeployments(),
    localRegistry.recent(),
  ]);
  const access = client.composeDesktopAccessState({
    authSnapshot: accessFixture.authSnapshot,
    hostCapabilities: accessFixture.hostCapabilities,
    accountResult,
    entitlementResult,
    usageResult,
  });
  const persisted = validPersistedState(stateStore?.get?.(D9_STATE_KEY), scenario, seed);
  const previewController = createPreviewController({ scenario: previewScenario, seed: `${seed}:preview`, localAdapter: localPreviewAdapter, providerPreview: unwrap(previewResult, null) });
  const deploymentController = createDeploymentController({ scenario: deploymentScenario, seed: `${seed}:deployments`, providerDeployments: unwrap(deploymentsResult, []), exportAdapter: deploymentExportAdapter });
  let recentWorkspaces = recent;
  let actionSequence = persisted?.actionSequence || 0;
  let state = {
    schemaVersion: "1.0",
    source: "fixture",
    scenario,
    seed,
    observedAt: D9_FIXTURE_CLOCK,
    navigation: {
      current: persisted?.navigation || definition.initialNavigation,
      items: NAVIGATION_ITEMS,
    },
    home: {
      state: definition.homeState,
      brand: "Thrallo",
      headline: "Build software with Thrallo",
      detail: "Start with a conversation, then inspect code and technical tools whenever you need them.",
      fixtureOnly: true,
    },
    access,
    projects: createProjectLauncher(unwrap(projectsResult, []), recentWorkspaces, deploymentController.snapshot()),
    selectedProjectId: persisted?.selectedProjectId || null,
    conversation: createConversation(unwrap(turnsResult, []), definition),
    plan: createPlan(unwrap(planResult, null), persisted?.planState || definition.planState),
    agents: createAgents(unwrap(agentsResult, []), unwrap(runResult, null), definition),
    models: createModels(unwrap(modelsResult, []), persisted?.selectedModel || definition.selectedModel, definition),
    providerUsage: { usage: unwrap(modelUsageResult, null), budget: unwrap(budgetResult, null) },
    build: { ...createBuildPresentation(definition.buildState), provider: unwrap(buildResult, null) },
    preview: previewController.snapshot(),
    deployment: deploymentController.snapshot(),
    notices: createNotices(definition, access),
    lastAction: null,
    integration: {
      builderV2Mutation: "capability_unavailable",
      canonicalProjectSync: "integration_pending",
      cloudWorkspace: definition.futureCloudState,
      publishing: "fixture_foundation",
      providerSource: "deterministic_fixture",
    },
  };

  async function dispatch(action) {
    if (!action || typeof action.type !== "string") throw new TypeError("D9 action requires an explicit type");
    actionSequence += 1;
    let result;
    if (action.type === "navigate") result = navigate(action.destination);
    else if (action.type === "select_project") result = await selectProject(action.projectId);
    else if (action.type === "send_message") result = await sendMessage(action.text);
    else if (action.type === "plan_decision") result = await decidePlan(action);
    else if (action.type === "agent_control") result = await controlAgent(action);
    else if (action.type === "select_model") result = await selectModel(action.modelId);
    else if (action.type === "advance_fixture_build") result = advanceBuild();
    else if (action.type === "refresh_local_workspaces") result = await refreshLocalWorkspaces();
    else if (action.type === "preview_action") result = (await previewController.dispatch(action.action)).result;
    else if (action.type === "open_preview") result = await openPreview(action.projectId);
    else if (action.type === "deployment_action") result = (await deploymentController.dispatch(action.action)).result;
    else throw new TypeError(`Unsupported D9 action: ${action.type}`);
    state.preview = previewController.snapshot();
    state.deployment = deploymentController.snapshot();
    state.projects = createProjectLauncher(unwrap(projectsResult, []), recentWorkspaces, state.deployment);
    state.lastAction = Object.freeze({ sequence: actionSequence, type: action.type, result });
    await persist();
    return Object.freeze({ result, state: snapshot() });
  }

  function navigate(destination) {
    const item = NAVIGATION_ITEMS.find((entry) => entry.id === destination);
    if (!item) return unavailable("navigation_unknown", destination);
    if (!item.enabled) return unavailable(item.state || "capability_unavailable", destination);
    state.navigation = { ...state.navigation, current: destination };
    return Object.freeze({ ok: true, state: "selected", destination, command: item.command || null });
  }

  async function selectProject(projectId) {
    const project = state.projects.items.find((entry) => entry.id === projectId);
    if (!project) return unavailable("project_unknown", projectId);
    if (project.workspaceType === "future_cloud_workspace") return unavailable("capability_unavailable", "cloudWorkspace");
    state.selectedProjectId = projectId;
    await previewController.dispatch({ type: "set_project", project });
    if (project.workspaceType === "fixture_thrallo_project") state.navigation = { ...state.navigation, current: "conversation" };
    return Object.freeze({ ok: true, state: "selected", projectId, workspaceType: project.workspaceType, local: project.local });
  }

  async function openPreview(projectId) {
    const project = state.projects.items.find((entry) => entry.id === projectId);
    if (!project) return unavailable("project_unknown", projectId);
    const selected = await previewController.dispatch({ type: "set_project", project });
    state.preview = previewController.snapshot();
    if (!selected.result.ok) return selected.result;
    state.selectedProjectId = projectId;
    state.navigation = { ...state.navigation, current: "preview" };
    return Object.freeze({ ok: true, state: "preview_opened", projectId, source: state.preview.preview.source });
  }

  async function sendMessage(input) {
    const text = String(input || "").trim().slice(0, 4000);
    if (!text) return unavailable("message_required", "conversation");
    const response = fixtureActions.recordConversation({ conversationId: state.conversation.id, text });
    state.conversation = {
      ...state.conversation,
      messages: [...state.conversation.messages,
        message(`fixture-user-${actionSequence}`, "user", text, "complete"),
        response.ok
          ? message(`fixture-assistant-${actionSequence}`, "assistant", "I recorded that fixture instruction. No production build or project was changed.", "complete")
          : message(`fixture-system-${actionSequence}`, "system", "This conversation capability is unavailable in the current fixture state.", "capability_unavailable"),
      ],
    };
    return response.ok ? Object.freeze({ ok: true, state: "fixture_recorded" }) : response;
  }

  async function decidePlan(action) {
    if (!PLAN_DECISIONS.includes(action.decision)) throw new TypeError("Plan decisions must be approve, reject, or request_changes");
    if (action.planId !== state.plan.id) return unavailable("plan_mismatch", action.planId);
    if (state.plan.status !== "pending") return unavailable(state.plan.status === "unavailable" ? "capability_unavailable" : `plan_${state.plan.status}`, action.planId);
    const response = fixtureActions.decidePlan({
      planId: state.plan.id,
      decision: action.decision,
      comment: String(action.comment || "").trim().slice(0, 1000) || null,
      source: "explicit_typed_fixture_action",
    });
    if (!response.ok) {
      state.plan = { ...state.plan, status: response.code === "capability_unavailable" ? "unavailable" : "error", lastError: response.code };
      return response;
    }
    const next = action.decision === "approve" ? "approved" : action.decision === "reject" ? "rejected" : "changes_requested";
    state.plan = { ...state.plan, status: next, decisionSource: "explicit_typed_fixture_action", comment: String(action.comment || "").trim().slice(0, 1000) || null };
    state.build = { ...state.build, ...createBuildPresentation(next === "approved" ? "queued" : next === "changes_requested" ? "planning" : "canceled") };
    return Object.freeze({ ok: true, state: next, fixtureOnly: true });
  }

  async function controlAgent(action) {
    const agent = state.agents.find((entry) => entry.id === action.agentId);
    if (!agent) return unavailable("agent_unknown", action.agentId);
    const control = agent.controls.find((entry) => entry.id === action.control);
    if (!control || !control.enabled) return unavailable(control?.reason || "capability_unavailable", action.control);
    if (action.control === "inspect") {
      state.navigation = { ...state.navigation, current: "agents" };
      state.agents = state.agents.map((entry) => ({ ...entry, selected: entry.id === action.agentId }));
      return Object.freeze({ ok: true, state: "selected" });
    }
    const response = fixtureActions.controlAgent({ runId: agent.runId, agentId: agent.id, control: action.control });
    if (!response.ok) return response;
    const nextState = action.control === "cancel" ? "canceled" : action.control === "resume" ? "running" : "queued";
    state.agents = state.agents.map((entry) => entry.id === agent.id ? { ...entry, status: nextState, currentAction: action.control === "cancel" ? "Stopped by fixture control" : "Fixture recovery queued", controls: controlsForAgent(nextState, true) } : entry);
    return Object.freeze({ ok: true, state: nextState, fixtureOnly: true });
  }

  async function selectModel(modelId) {
    const model = state.models.items.find((entry) => entry.id === modelId);
    if (!model) return unavailable("model_unknown", modelId);
    if (!model.available) return unavailable("capability_unavailable", modelId);
    if (state.access.capabilities.managedAi.availability !== "available") return unavailable(state.access.capabilities.managedAi.reason, "managedAi");
    const response = fixtureActions.selectModel({ modelId });
    if (!response.ok) return response;
    state.models = { ...state.models, selected: modelId };
    return Object.freeze({ ok: true, state: "selected", modelId, fixtureOnly: true });
  }

  function advanceBuild() {
    const sequence = ["not_started", "planning", "waiting_approval", "queued", "running", "verifying", "repairing", "completed"];
    const index = sequence.indexOf(state.build.state);
    const next = index < 0 || index === sequence.length - 1 ? state.build.state : sequence[index + 1];
    state.build = { ...state.build, ...createBuildPresentation(next) };
    return Object.freeze({ ok: true, state: next, fixtureOnly: true });
  }

  async function refreshLocalWorkspaces() {
    recentWorkspaces = await localRegistry.recent();
    state.projects = createProjectLauncher(unwrap(projectsResult, []), recentWorkspaces, deploymentController.snapshot());
    return Object.freeze({ ok: true, state: "refreshed", count: recentWorkspaces.length });
  }

  function snapshot() { return immutableClone(state); }
  function getCalls() {
    return Object.freeze({
      providers: providerSuite.getCalls(),
      access: accessFixture.getCalls(),
      actions: fixtureActions.getCalls(),
      preview: previewController.getCalls(),
      deployment: deploymentController.getCalls(),
    });
  }
  async function persist() {
    if (!stateStore?.update) return;
    await stateStore.update(D9_STATE_KEY, Object.freeze({
      schemaVersion: 1,
      scenario,
      seed,
      navigation: state.navigation.current,
      selectedProjectId: state.selectedProjectId,
      selectedModel: state.models.selected,
      planState: state.plan.status,
      actionSequence,
    }));
  }

  await persist();
  return Object.freeze({ dispatch, snapshot, getCalls, providerSuite, accessFixture, previewController, deploymentController });
}

function createProjectLauncher(fixtureProjects, recent, deploymentState) {
  const deployment = deploymentState?.deployments?.[0] || null;
  const publishingState = deploymentState?.publishing?.state || "fixture_only";
  const localItems = recent.map((workspace) => Object.freeze({
    id: workspace.id,
    name: workspace.displayName,
    workspaceType: workspace.mode,
    sourceLabel: workspace.mode === "local_git_repository" ? "Local Git repository" : workspace.mode === "imported_local_project" ? "Imported local project" : "Local folder",
    local: true,
    path: workspace.realPath,
    updatedAt: workspace.lastOpenedAt,
    framework: workspace.projectType,
    git: workspace.git,
    dirty: workspace.git?.dirty === true,
    conflict: false,
    runState: workspace.preview?.state || "not_started",
    deploymentState: null,
    resumable: workspace.availability === "available",
    availability: workspace.availability,
    previewCommands: workspace.previewCommands || [],
  }));
  const fixtureItems = fixtureProjects.map((project) => Object.freeze({
    id: project.id,
    name: project.name,
    workspaceType: "fixture_thrallo_project",
    sourceLabel: "Fixture Thrallo project",
    local: false,
    path: null,
    updatedAt: D9_FIXTURE_CLOCK,
    framework: "Fixture web application",
    git: null,
    dirty: project.status === "conflict",
    conflict: project.status === "conflict",
    runState: project.status,
    deploymentState: compactPublishingState(publishingState, deployment?.status),
    healthState: deploymentState?.health?.state || "unknown",
    resumable: true,
    availability: "fixture_only",
    previewCommands: [],
  }));
  return Object.freeze({
    items: Object.freeze([...localItems, ...fixtureItems, Object.freeze({
      id: "future-cloud-workspace",
      name: "Cloud workspace",
      workspaceType: "future_cloud_workspace",
      sourceLabel: "Future cloud workspace",
      local: false,
      updatedAt: null,
      framework: null,
      dirty: false,
      conflict: false,
      runState: "capability_unavailable",
      deploymentState: null,
      healthState: "unavailable",
      resumable: false,
      availability: "integration_pending",
      previewCommands: [],
    })]),
  });
}

function compactPublishingState(publishingState, deploymentState) {
  if (["publish_failed", "update_failed", "unpublish_failed"].includes(publishingState) || deploymentState === "failed") return "failed";
  if (publishingState === "update_available" || deploymentState === "update_available") return "update_available";
  if (publishingState === "published" || publishingState === "rollback_available") return "published";
  if (publishingState === "unpublished") return "unpublished";
  return "draft";
}

function createConversation(turns, definition) {
  const messages = turns.map((turn) => message(turn.id, turn.role, turn.text, "complete"));
  if (["planning", "queued", "running", "verifying", "repairing"].includes(definition.buildState)) messages.push(message(`fixture-build-${definition.buildState}`, "system", `${createBuildPresentation(definition.buildState).label} in the deterministic fixture run.`, "progress"));
  if (definition.buildState === "failed") messages.push(message("fixture-build-failed", "system", "The fixture build failed verification. Retry remains a fixture-only control.", "failure"));
  if (definition.buildState === "recovering") messages.push(message("fixture-build-recovery", "system", "Recovering from the deterministic checkpoint.", "recovery"));
  if (definition.buildState === "waiting_approval") messages.push(message("fixture-plan-wait", "assistant", "Review the typed plan card before the fixture run can continue.", "waiting_approval"));
  if (definition.buildState === "canceled") messages.push(message("fixture-build-canceled", "system", "The deterministic fixture run was canceled.", "cancellation"));
  if (definition.buildState === "completed") messages.push(message("fixture-build-completed", "system", "The deterministic fixture run completed verification.", "completion"));
  if (definition.providerScenario === "budget-warning") messages.push(message("fixture-budget-warning", "system", "Fixture usage is approaching its allowance. Local work remains available.", "warning"));
  if (definition.buildState === "capability_unavailable") messages.push(message("fixture-unavailable", "system", "This capability is unavailable. No live fallback was attempted.", "capability_unavailable"));
  return Object.freeze({ id: "fixture-conversation-0001", status: definition.providerScenario, messages: Object.freeze(messages) });
}

function message(id, role, text, state) { return Object.freeze({ id, role, text, state }); }

function createPlan(providerPlan, state) {
  if (!PLAN_STATES.includes(state)) throw new TypeError(`Unknown D9 plan state: ${state}`);
  return Object.freeze({
    id: providerPlan?.id || "fixture-plan-0001",
    title: "Build the fixture project foundation",
    summary: providerPlan?.summary || "Create a deterministic local presentation without contacting production services.",
    affectedCapabilities: Object.freeze(["local files", "fixture conversation", "fixture verification"]),
    complexity: "medium",
    usageClass: "fixture_only",
    warnings: Object.freeze([
      Object.freeze({ kind: "external_action", label: "No external action will run in D9." }),
      Object.freeze({ kind: "destructive_action", label: "No destructive operation is permitted." }),
    ]),
    status: state,
    decisionSource: state === "pending" ? null : "fixture_scenario",
    comment: null,
    lastError: null,
  });
}

function createAgents(providerAgents, run, definition) {
  const sourceAgents = providerAgents.length ? providerAgents : definition.providerScenario === "failure"
    ? [Object.freeze({ id: "fixture-agent-lead", name: "Lead", state: "failed" })]
    : [];
  const enriched = sourceAgents.map((agent, index) => {
    let status = index === 0 ? normalizeAgentState(run?.state || agent.state) : definition.parallelAgents ? "running" : "idle";
    if (definition.canceledAgent && index === 0) status = "canceled";
    return Object.freeze({
      id: agent.id,
      runId: run?.id || "fixture-run-0001",
      name: index === 0 ? "Thrallo" : "Review agent",
      kind: index === 0 ? "primary" : "child",
      task: index === 0 ? "Coordinate the fixture build" : "Review accessibility and local changes",
      model: index === 0 ? "Fixture Balanced" : "Fixture Deep",
      status,
      currentAction: status === "running" ? (index === 0 ? "Preparing deterministic changes" : "Reviewing fixture files") : status === "canceled" ? "Canceled by fixture scenario" : "Waiting",
      filesAffected: index === 0 ? Object.freeze(["src/App.jsx", "src/styles.css"]) : Object.freeze(["test/accessibility.spec.js"]),
      elapsedSeconds: index === 0 ? 84 : 31,
      usageLabel: index === 0 ? "42 fixture units" : "11 fixture units",
      waitingApproval: definition.buildState === "waiting_approval" && index === 0,
      controls: controlsForAgent(status, definition.providerScenario !== "unsupported-capability"),
      selected: false,
    });
  });
  return Object.freeze(enriched);
}

function controlsForAgent(status, providerAvailable) {
  const controls = [Object.freeze({ id: "inspect", label: "Inspect", enabled: true, reason: null })];
  if (["running", "waiting_approval", "queued"].includes(status)) controls.push(Object.freeze({ id: "cancel", label: "Cancel", enabled: providerAvailable, reason: providerAvailable ? null : "capability_unavailable" }));
  if (["failed", "canceled"].includes(status)) controls.push(Object.freeze({ id: "retry", label: "Retry", enabled: providerAvailable, reason: providerAvailable ? null : "capability_unavailable" }));
  if (["recovered", "recovering"].includes(status)) controls.push(Object.freeze({ id: "resume", label: "Resume", enabled: providerAvailable, reason: providerAvailable ? null : "capability_unavailable" }));
  return Object.freeze(controls);
}

function normalizeAgentState(value) {
  return ({ cancelled: "canceled", succeeded: "success", recovered: "recovered", "waiting-approval": "waiting_approval" })[value] || value || "idle";
}

function createModels(providerModels, selected, definition) {
  const items = [Object.freeze({ id: "auto", label: "Auto / Model Select", provider: "Thrallo fixture router", classification: "routing", available: true, detail: "Chooses an available fixture model and explains fallback." })];
  for (const model of providerModels) items.push(Object.freeze({
    id: model.id,
    label: model.label,
    provider: "Thrallo fixture provider",
    classification: "unknown_fixture",
    available: model.available && !(definition.modelUnavailable && model.id === "fixture-deep"),
    detail: model.id === "fixture-deep" ? "Fixture quality-oriented route; managed/BYOK classification is not supplied." : "Fixture balanced route; managed/BYOK classification is not supplied.",
  }));
  return Object.freeze({ selected: items.some((item) => item.id === selected && item.available) ? selected : "auto", items: Object.freeze(items), fallbackExplanation: definition.modelUnavailable ? "Fixture Deep is unavailable, so Auto remains selected." : "Auto selects only an available configured fixture route." });
}

function createNotices(definition, access) {
  const notices = [Object.freeze({ id: "fixture-mode", state: "information", title: "Fixture mode", detail: "D9 actions are deterministic and do not contact production mutation services." })];
  if (definition.localOffline) notices.push(Object.freeze({ id: "offline", state: "warning", title: "Offline local mode", detail: "Local files, Git and terminal remain available. Managed services are read-only or unavailable." }));
  if (access.entitlement.freshness !== "fresh" || access.usage.freshness !== "fresh") notices.push(Object.freeze({ id: "stale-access", state: "warning", title: "Account data may be stale", detail: "Managed actions fail closed; local work remains available." }));
  return Object.freeze(notices);
}

function unwrap(result, fallback) { return result?.ok === true ? result.data : fallback; }
function unavailable(code, capability) { return Object.freeze({ ok: false, code, state: "capability_unavailable", capability, sideEffects: false }); }
function immutableClone(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(immutableClone));
  if (value && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, immutableClone(item)])));
  return value;
}
function validPersistedState(value, scenario, seed) {
  if (!value || value.schemaVersion !== 1 || value.scenario !== scenario || value.seed !== seed) return null;
  if (!NAVIGATION_ITEMS.some((item) => item.id === value.navigation && item.enabled)) return null;
  if (value.planState && !PLAN_STATES.includes(value.planState)) return null;
  return value;
}
function assertDependencies(client, localRegistry) {
  for (const method of ["createFixtureProviderSuite", "createDesktopAccessFixture", "composeDesktopAccessState"]) {
    if (typeof client?.[method] !== "function") throw new TypeError(`D9 requires shared Thrallo client method: ${method}`);
  }
  if (typeof localRegistry?.recent !== "function") throw new TypeError("D9 requires the D8 local workspace registry");
}

module.exports = {
  D9_STATE_KEY,
  NAVIGATION_ITEMS,
  PLAN_STATES,
  PLAN_DECISIONS,
  BUILD_STATES,
  createBuildPresentation,
  createDesktopProductController,
};
