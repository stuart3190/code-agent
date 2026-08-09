// Host-neutral D14 companion adapter. It projects existing D3/D9-D12 state into
// touch-friendly summaries and delegates fixture actions back to their owning contracts.
// It has no transport, credential, push, portal route, or production mutation fallback.

"use strict";

const D14_FIXTURE_SEED = "thrallo-desktop-d14-foundation";
const D14_FIXTURE_CLOCK = "2033-01-12T15:00:00.000Z";
const PORTAL_ORIGIN = "https://app.thrallo.com";

const PORTAL_RESPONSIBILITIES = Object.freeze({
  schemaVersion: 1,
  portal: Object.freeze([
    "signup", "login_recovery_authority", "subscription_purchase_change", "billing_recovery",
    "invoices", "account_management", "api_key_token_management", "browser_account_authorization",
    "desktop_downloads", "device_session_management", "cloud_workspace_launch_recovery_entry",
  ]),
  desktop: Object.freeze([
    "project_workbench", "conversation", "local_workspace", "editor_files", "agents",
    "preview_testing", "deployments_presentation", "integrations_presentation", "local_settings",
    "model_usage_summaries",
  ]),
  rule: "portal_authority_desktop_workbench",
});

const PORTAL_DESTINATIONS = Object.freeze({
  account: Object.freeze({ path: "/settings/preferences", owner: "portal", state: "available" }),
  billing: Object.freeze({ path: "/settings/billing", owner: "portal", state: "available" }),
  usage: Object.freeze({ path: "/settings/usage", owner: "portal", state: "available" }),
  integrations: Object.freeze({ path: "/settings/preferences", owner: "portal", state: "available" }),
  api_keys: Object.freeze({ path: "/settings/keys", owner: "portal", state: "available" }),
  downloads: Object.freeze({ path: "/", owner: "portal", state: "available" }),
  devices_sessions: Object.freeze({ path: null, owner: "portal", state: "integration_pending" }),
  recovery: Object.freeze({ path: "/settings/billing", owner: "portal", state: "available" }),
  project_status: Object.freeze({ path: null, owner: "shared_presentation", state: "integration_pending" }),
  cloud_workspace_launch: Object.freeze({ path: null, owner: "portal", state: "integration_pending" }),
});

const RETURN_ACTIONS = Object.freeze(["account_updated", "billing_recovered", "integration_completed", "project_status", "workspace_recovery"]);
const RETURN_VIEWS = Object.freeze(["home", "projects", "activity", "preview", "deployments", "usage", "account"]);

const COMPANION_NAVIGATION = Object.freeze([
  Object.freeze({ id: "home", label: "Home" }),
  Object.freeze({ id: "projects", label: "Projects" }),
  Object.freeze({ id: "activity", label: "Activity" }),
  Object.freeze({ id: "preview", label: "Preview" }),
  Object.freeze({ id: "deployments", label: "Deployments" }),
  Object.freeze({ id: "usage", label: "Usage" }),
  Object.freeze({ id: "account", label: "Account" }),
]);

const ALLOWED_COMPANION_CAPABILITIES = Object.freeze([
  "view_projects", "view_build_run", "view_agents", "send_simple_instruction", "review_typed_plan",
  "typed_plan_decision", "control_bounded_agent", "view_preview", "view_deployments", "view_logs",
  "view_usage_budget", "view_alerts", "portal_handoffs", "review_high_impact_action",
]);
const EXCLUDED_COMPANION_CAPABILITIES = Object.freeze({
  source_code_editing: "Use Thrallo Desktop with a keyboard and pointer.",
  terminal: "Terminal access is intentionally unavailable in companion mode.",
  secret_management: "Secrets remain in the secured desktop or portal workflow.",
  raw_environment_editing: "Raw environment editing is excluded from companion mode.",
  database_schema_mutation: "Database mutations require the desktop safety review.",
  unrestricted_git: "Unrestricted Git operations are excluded from companion mode.",
  arbitrary_browser: "Companion Preview is application-scoped, not a general browser.",
  cloud_infrastructure_admin: "Cloud infrastructure administration is unavailable.",
});
const TABLET_PROFILES = Object.freeze({
  companion_touch: Object.freeze({ state: "fixture_verified", input: "touch_keyboard", capabilities: ALLOWED_COMPANION_CAPABILITIES, excluded: EXCLUDED_COMPANION_CAPABILITIES }),
  reduced_workbench_keyboard_pointer: Object.freeze({ state: "qualification_pending", input: "keyboard_pointer", capabilities: Object.freeze([]), realDeviceVerified: false }),
});

const BASE_SCENARIO = Object.freeze({
  desktop: "authenticated-paid", preview: "preview-idle", deployment: "live-healthy", settings: "supabase-healthy",
  companionState: "ready", initialView: "home", override: null,
});
const SCENARIOS = Object.freeze({
  "first-companion-launch": {},
  "signed-out": { desktop: "signed-out", override: "signed_out" },
  "active-paid-account": {},
  "offline-cached-state": { desktop: "offline-local-project", settings: "offline-local-project", companionState: "offline_cached", override: "offline" },
  "project-idle": { initialView: "projects" },
  "build-running": { desktop: "active-build-run", initialView: "activity" },
  "waiting-plan-approval": { desktop: "waiting-plan-approval", initialView: "activity" },
  "plan-approved": { desktop: "approved-plan", initialView: "activity" },
  "plan-rejected": { desktop: "waiting-plan-approval", initialView: "activity", override: "plan_rejected" },
  "build-failed": { desktop: "failed-build", initialView: "activity" },
  "build-recovered": { desktop: "recovering-build", initialView: "activity", override: "build_recovered" },
  "agent-failed": { desktop: "failed-build", initialView: "activity", override: "agent_failed" },
  "parallel-agent-activity": { desktop: "parallel-fixture-agents", initialView: "activity" },
  "preview-healthy": { preview: "dev-server-running", initialView: "preview" },
  "preview-unavailable": { preview: "preview-unavailable", initialView: "preview" },
  "deployment-healthy": { deployment: "live-healthy", initialView: "deployments" },
  "deployment-failed": { deployment: "first-publish-failure", initialView: "deployments" },
  "update-available": { deployment: "update-available", initialView: "deployments" },
  "rollback-review": { deployment: "rollback-available", initialView: "deployments", override: "rollback_review" },
  "unpublish-review": { deployment: "live-healthy", initialView: "deployments", override: "unpublish_review" },
  "domain-unhealthy": { deployment: "unhealthy-domain", initialView: "deployments" },
  "usage-80": { desktop: "budget-80", initialView: "usage" },
  "usage-90": { desktop: "budget-90", initialView: "usage" },
  "usage-exhausted": { desktop: "exhausted-budget", initialView: "usage" },
  "billing-recovery": { desktop: "authenticated-paid", initialView: "account", override: "billing_recovery" },
  "integration-degraded": { settings: "supabase-degraded", override: "integration_degraded" },
  "alert-unread": { override: "alert_unread" },
  "alert-read": { override: "alert_read" },
  "unsupported-editor-action": { override: "unsupported_editor" },
  "unsupported-terminal-action": { override: "unsupported_terminal" },
  "unsupported-secret-action": { override: "unsupported_secret" },
  "future-cloud-launch-unavailable": { override: "future_cloud" },
});
const D14_SCENARIOS = Object.freeze(Object.keys(SCENARIOS));

function getD14Scenario(name = "first-companion-launch") {
  if (!D14_SCENARIOS.includes(name)) throw new TypeError(`Unknown D14 fixture scenario: ${name}`);
  return Object.freeze({ name, ...BASE_SCENARIO, ...SCENARIOS[name] });
}

function createCompanionPortalHandoff({ openExternal } = {}) {
  if (typeof openExternal !== "function") throw new TypeError("D14 portal handoff requires a system-browser host action");
  const calls = [];
  async function open(destination) {
    const descriptor = portalDescriptor(destination);
    calls.push(Object.freeze({ sequence: calls.length + 1, destination: descriptor.destination, pathname: descriptor.pathname, state: descriptor.state }));
    if (!descriptor.ok) return descriptor;
    await openExternal(descriptor.url);
    return descriptor;
  }
  return Object.freeze({ open, descriptor: portalDescriptor, getCalls: () => immutableClone(calls) });
}

function portalDescriptor(destination) {
  const item = typeof destination === "string" ? PORTAL_DESTINATIONS[destination] : null;
  if (!item) return unavailable("portal_destination_rejected", "portal_handoff");
  if (!item.path) return unavailable(item.state, destination);
  const url = new URL(item.path, PORTAL_ORIGIN);
  if (url.origin !== PORTAL_ORIGIN || url.username || url.password || url.search || url.hash) return unavailable("portal_destination_rejected", "portal_handoff");
  return Object.freeze({ ok: true, state: "handoff_ready", destination, pathname: url.pathname, url: url.toString(), owner: item.owner, sideEffects: false });
}

function createReturnContext(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return unavailable("return_context_rejected", "portal_return");
  const allowedKeys = new Set(["actionType", "projectReference", "destinationView", "recoveryReason", "integrationCompletionState"]);
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) return unavailable("return_context_rejected", "portal_return");
  if (!RETURN_ACTIONS.includes(input.actionType) || !RETURN_VIEWS.includes(input.destinationView)) return unavailable("return_context_rejected", "portal_return");
  const values = [input.projectReference, input.recoveryReason, input.integrationCompletionState].filter((value) => value != null);
  if (values.some((value) => typeof value !== "string" || value.length > 120 || /(?:https?:|thrallo:|token|secret|password|authorization|bearer|code=|state=)/i.test(value))) return unavailable("return_context_rejected", "portal_return");
  return Object.freeze({ ok: true, state: "safe_return_context", context: Object.freeze({
    actionType: input.actionType,
    projectReference: input.projectReference || null,
    destinationView: input.destinationView,
    recoveryReason: input.recoveryReason || null,
    integrationCompletionState: input.integrationCompletionState || null,
    authorizationMaterial: null,
  }), sideEffects: false });
}

function companionCapability(capability) {
  if (ALLOWED_COMPANION_CAPABILITIES.includes(capability)) return Object.freeze({ capability, availability: "fixture_only", explanation: "Available through an existing shared fixture contract." });
  if (Object.hasOwn(EXCLUDED_COMPANION_CAPABILITIES, capability)) return Object.freeze({ capability, availability: "capability_unavailable", explanation: EXCLUDED_COMPANION_CAPABILITIES[capability] });
  return Object.freeze({ capability, availability: "capability_unavailable", explanation: "This capability is not part of companion mode." });
}

function createCompanionController({ getSharedState, dispatchShared, scenario = "first-companion-launch", seed = D14_FIXTURE_SEED } = {}) {
  if (typeof getSharedState !== "function" || typeof dispatchShared !== "function") throw new TypeError("D14 companion requires shared state and action delegates");
  const definition = getD14Scenario(scenario);
  const calls = [];
  let sequence = 0;
  let currentView = definition.initialView;
  let composer = Object.freeze({ state: definition.companionState === "offline_cached" ? "offline" : "idle", length: 0, error: null });
  let alertReads = new Set(definition.override === "alert_read" ? ["fixture-general-attention"] : []);
  let overrideState = Object.freeze({ plan: definition.override === "plan_rejected" ? "rejected" : null, recovered: definition.override === "build_recovered" });

  async function dispatch(action) {
    if (!action || typeof action.type !== "string") throw new TypeError("D14 actions require an explicit type");
    sequence += 1;
    const record = { sequence, type: action.type, observedAt: observedAt(sequence), input: safeActionRecord(action) };
    calls.push(Object.freeze(record));
    let result;
    if (action.type === "navigate") result = navigate(action.destination);
    else if (action.type === "set_instruction_text") result = setInstruction(action.text);
    else if (action.type === "send_instruction") result = await sendInstruction(action.text);
    else if (action.type === "plan_decision") result = await planDecision(action);
    else if (action.type === "agent_control") result = await boundedDelegate("agent_control", action);
    else if (action.type === "deployment_action") result = await deploymentAction(action);
    else if (action.type === "mark_alert_read") result = markAlertRead(action.alertId);
    else if (action.type === "request_capability") result = companionCapability(action.capability);
    else if (action.type === "future_cloud_launch") result = unavailable("integration_pending", "cloud_workspace_launch");
    else result = unavailable("unsupported_companion_action", action.type);
    return Object.freeze({ result, state: snapshot() });
  }

  function navigate(destination) {
    if (!COMPANION_NAVIGATION.some((item) => item.id === destination)) return unavailable("companion_destination_rejected", "navigation");
    currentView = destination;
    return ok("selected", { destination });
  }

  function setInstruction(text) {
    const safe = validateInstruction(text);
    if (!safe.ok) { composer = Object.freeze({ state: "failed", length: 0, error: safe.code }); return safe; }
    composer = Object.freeze({ state: "composing", length: safe.length, error: null });
    return ok("composing", { length: safe.length });
  }

  async function sendInstruction(text) {
    const state = snapshot();
    if (state.connection.offline || state.connection.stale) { composer = Object.freeze({ state: "offline", length: 0, error: "fresh_capability_required" }); return unavailable("fresh_capability_required", "send_simple_instruction"); }
    const safe = validateInstruction(text);
    if (!safe.ok) { composer = Object.freeze({ state: "failed", length: 0, error: safe.code }); return safe; }
    composer = Object.freeze({ state: "sending", length: safe.length, error: null });
    const result = await dispatchShared({ type: "send_message", text: safe.text, source: "d14_fixture_companion" });
    composer = Object.freeze({ state: result?.ok ? "sent" : result?.state === "capability_unavailable" ? "capability_unavailable" : "failed", length: 0, error: result?.ok ? null : result?.code || "send_failed" });
    return result?.ok ? ok("sent", { fixtureOnly: true }) : result;
  }

  async function planDecision(action) {
    if (!action.confirmed || !["approve", "reject", "request_changes"].includes(action.decision)) return unavailable("explicit_typed_confirmation_required", "typed_plan_decision");
    if (snapshot().connection.offline || snapshot().connection.stale) return unavailable("fresh_capability_required", "typed_plan_decision");
    const result = await dispatchShared({ type: "plan_decision", planId: action.planId, decision: action.decision, comment: action.comment || null, source: "d14_fixture_companion" });
    if (result?.ok) overrideState = Object.freeze({ ...overrideState, plan: result.state });
    return result;
  }

  async function boundedDelegate(type, action) {
    if (snapshot().connection.offline || snapshot().connection.stale) return unavailable("fresh_capability_required", type);
    return dispatchShared({ type, agentId: action.agentId, control: action.control, source: "d14_fixture_companion" });
  }

  async function deploymentAction(action) {
    const highImpact = ["publish", "update", "rollback", "unpublish", "cancel_active_work"].includes(action.actionId);
    if (highImpact && action.operation === "confirm_action" && action.confirmed !== true) return Object.freeze({ ok: false, code: "explicit_confirmation_required", state: "confirmation_required", capability: action.actionId, reauthentication: action.reauthentication || "may_be_required_in_track_b", sideEffects: false });
    if (snapshot().connection.offline || snapshot().connection.stale) return unavailable("fresh_capability_required", action.actionId);
    return dispatchShared({ type: "deployment_action", action: { type: action.operation || "review_action", actionId: action.actionId, releaseId: action.releaseId, confirmed: action.confirmed }, source: "d14_fixture_companion" });
  }

  function markAlertRead(alertId) {
    const alert = snapshot().alerts.find((item) => item.id === alertId);
    if (!alert) return unavailable("alert_unknown", "view_alerts");
    alertReads = new Set([...alertReads, alertId]);
    return ok("alert_read", { alertId });
  }

  function snapshot() {
    const shared = getSharedState();
    const projected = projectSharedState(shared, definition, overrideState, alertReads);
    return immutableClone({
      schemaVersion: 1, source: "deterministic_fixture", seed, scenario, observedAt: D14_FIXTURE_CLOCK,
      profile: "companion_touch", navigation: { current: currentView, items: COMPANION_NAVIGATION },
      capabilities: { allowed: ALLOWED_COMPANION_CAPABILITIES, excluded: EXCLUDED_COMPANION_CAPABILITIES },
      composer, scenarioResult: initialScenarioResult(definition), ...projected,
      boundaries: {
        productionCompanion: "track_b_unapproved", mobileApplication: "not_created", pushNotifications: "not_implemented",
        tabletReducedWorkbench: "qualification_pending", cloudLaunch: "integration_pending", builderV2Mutation: "capability_unavailable",
        productionMutations: "capability_unavailable", buildr101Reuse: "forbidden",
      },
    });
  }

  return Object.freeze({ dispatch, snapshot, getCalls: () => immutableClone(calls) });
}

function projectSharedState(shared, definition, overrideState, alertReads) {
  if (!shared?.access || !shared?.projects || !shared?.preview || !shared?.deployment || !shared?.settings) throw new TypeError("D14 requires composed D3/D9-D12 state");
  const selected = shared.projects.items.find((item) => item.id === shared.selectedProjectId) || shared.projects.items[0] || null;
  const integrationWarnings = shared.settings.integrations?.items?.filter((item) => !["connected", "disconnected"].includes(item.status)) || [];
  const stale = shared.access.entitlement.freshness !== "fresh" || shared.access.usage.freshness !== "fresh" || shared.settings.integrations?.stale === true;
  const offline = definition.companionState === "offline_cached" || shared.notices?.some((item) => item.id === "offline");
  const plan = Object.freeze({ ...shared.plan, status: overrideState.plan || shared.plan.status, sourceContract: "D9_PLAN_DECISIONS" });
  const build = Object.freeze({ state: shared.build.state, label: shared.build.label, progress: shared.build.progress, active: shared.build.active, recovered: overrideState.recovered === true, sourceContract: "D9_BUILD_STATES" });
  const deployment = Object.freeze({ publishing: shared.deployment.publishing, activeReleaseId: shared.deployment.activeReleaseId, currentDeployment: shared.deployment.selectedDeployment, health: shared.deployment.health, domain: shared.deployment.domain, logs: { state: shared.deployment.logs.state, count: shared.deployment.filteredLogs?.length || 0 }, pendingReview: shared.deployment.pendingReview || inferredReview(definition, shared.deployment), sourceContract: "D11_DEPLOYMENT_STATES" });
  const preview = Object.freeze({ source: shared.preview.preview.source, state: shared.preview.preview.state, health: shared.preview.preview.health, path: shared.preview.preview.path, viewport: shared.preview.viewport, screenshot: shared.preview.artifacts?.find((item) => item.kind === "screenshot") || null, diagnostics: { available: shared.preview.diagnostics.available, console: shared.preview.diagnostics.console.length, runtime: shared.preview.diagnostics.runtime.length, network: shared.preview.diagnostics.network.length }, externalAllowed: shared.preview.preview.externalAllowed === true, sourceContract: "D10_PREVIEW_STATES" });
  const alerts = buildAlerts({ shared, build, deployment, integrationWarnings, definition }).map((item) => Object.freeze({ ...item, read: alertReads.has(item.id) || definition.override === "alert_read" }));
  return Object.freeze({
    connection: Object.freeze({ offline, stale, state: offline ? "offline_cached" : stale ? "stale" : "fresh", actionsRequireFreshState: true }),
    account: Object.freeze({ identity: shared.access.account.identity, session: shared.access.account.session.state, entitlement: shared.access.entitlement.state, recovery: shared.access.account.recovery, sourceContract: "D3_ACCOUNT_ENTITLEMENT" }),
    projects: Object.freeze(shared.projects.items.map((item) => Object.freeze({ id: item.id, name: item.name, workspaceType: item.workspaceType, local: item.local, runState: item.runState, deploymentState: item.deploymentState, healthState: item.healthState, resumable: item.resumable, updatedAt: item.updatedAt }))),
    currentProject: selected ? Object.freeze({ id: selected.id, name: selected.name, workspaceType: selected.workspaceType, local: selected.local }) : null,
    conversation: Object.freeze({ id: shared.conversation.id, status: shared.conversation.status, lastMessage: shared.conversation.messages.at(-1) || null, sourceContract: "D9_CONVERSATION" }),
    plan, build,
    agents: Object.freeze(shared.agents.map((agent) => Object.freeze({ id: agent.id, name: agent.name, purpose: agent.task, state: definition.override === "agent_failed" && agent.kind === "primary" ? "failed" : agent.status, model: agent.model, usage: agent.usageLabel, waitingApproval: agent.waitingApproval, controls: agent.controls, sourceContract: "D9_AGENT_STATES" }))),
    models: Object.freeze({ selected: shared.models.selected, available: shared.models.items.filter((item) => item.available).map((item) => Object.freeze({ id: item.id, label: item.label })), sourceContract: "D9_MODEL_SELECTOR" }),
    usage: Object.freeze({ ...shared.access.usage, sourceContract: "D3_USAGE" }),
    preview, deployment,
    integrations: Object.freeze({ warnings: integrationWarnings.map((item) => Object.freeze({ id: item.id, name: item.name, status: definition.override === "integration_degraded" && item.id === "supabase" ? "degraded" : item.status })), sourceContract: "D12_INTEGRATION_STATES" }),
    alerts: Object.freeze(alerts),
    attention: Object.freeze(alerts.filter((item) => !item.read).slice(0, 6)),
    sourceRefs: Object.freeze(["D3_ACCOUNT_ENTITLEMENT", "D9_PLAN_DECISIONS", "D9_AGENT_STATES", "D9_BUILD_STATES", "D10_PREVIEW_STATES", "D11_DEPLOYMENT_STATES", "D12_INTEGRATION_STATES"]),
  });
}

function inferredReview(definition, deployment) {
  if (!definition.override || !["rollback_review", "unpublish_review"].includes(definition.override)) return null;
  const actionId = definition.override === "rollback_review" ? "rollback" : "unpublish";
  return Object.freeze({ actionId, state: "confirmation_required", confirmed: false, fixtureOnly: true, currentReleaseId: deployment.activeReleaseId, selectedReleaseId: actionId === "rollback" ? deployment.previousReleaseId : null });
}

function buildAlerts({ shared, build, deployment, integrationWarnings, definition }) {
  const result = [];
  const push = (id, severity, title, destination, summary) => result.push(Object.freeze({ id, severity, title, destination, summary, timestamp: D14_FIXTURE_CLOCK, source: "shared_fixture_state" }));
  if (shared.plan.status === "pending") push("plan-waiting", "attention", "Plan waiting for approval", "activity", shared.plan.title);
  if (build.state === "failed") push("build-failed", "error", "Build failed", "activity", "Review the fixture failure and recovery controls.");
  if (build.state === "recovering" || build.recovered) push("build-recovered", "success", "Build recovered", "activity", "Fixture recovery completed or remains in progress.");
  if (shared.agents.some((agent) => agent.status === "failed") || definition.override === "agent_failed") push("agent-failed", "error", "Agent needs attention", "activity", "A fixture agent failed.");
  if (["failed", "update_failed", "publish_failed"].includes(deployment.publishing.state) || deployment.currentDeployment?.status === "failed") push("deployment-failed", "error", "Deployment failed", "deployments", "The fixture deployment is terminal.");
  if (["unhealthy", "verification_failed", "certificate_failed"].includes(deployment.domain.state)) push("domain-unhealthy", "warning", "Domain needs attention", "deployments", "Fixture domain health is not ready.");
  const usageWarnings = shared.access.usage.warnings || [];
  for (const warning of usageWarnings) {
    const level = warning.percent || warning.threshold || warning.level || "warning";
    const resource = bounded(warning.resource || "resource");
    push(`usage-${resource}-${level}`, warning.hardLimitReached ? "error" : "warning", `${resource} usage ${level}${Number.isFinite(Number(level)) ? "%" : ""}`, "usage", warning.detail || `Review ${resource} usage.`);
  }
  if (shared.access.usage.hardLimitReached) push("usage-exhausted", "error", "Usage exhausted", "usage", "Managed actions remain unavailable until access is restored.");
  if (shared.access.account.recovery?.billingRequired) push("billing-recovery", "error", "Billing recovery required", "account", "Continue in the Thrallo portal.");
  if (definition.override === "billing_recovery") push("billing-recovery", "error", "Billing recovery required", "account", "Continue in the Thrallo portal; purchasing is not duplicated here.");
  if (shared.access.account.recovery?.workspaceRequired) push("workspace-recovery", "error", "Workspace recovery required", "account", "Use the approved portal recovery entry point when it becomes available.");
  for (const item of integrationWarnings) push(`integration-${item.id}`, "warning", `${item.name} ${item.status}`, "home", "Review integration health on desktop or in the portal.");
  if (definition.override === "alert_unread" || definition.override === "alert_read") push("fixture-general-attention", "information", "Fixture status available", "home", "This deterministic companion alert has no push notification.");
  return result;
}

function validateInstruction(value) {
  const text = String(value || "").trim().slice(0, 1000);
  if (!text) return unavailable("instruction_required", "send_simple_instruction");
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|ghp|github_pat|xai|anthropic)_[a-z0-9_-]{8,}\b|\bbearer\s+[a-z0-9._~-]{8,}|(?:password|secret|api[_-]?key|token)\s*[:=]/i.test(text)) return unavailable("secret_content_rejected", "send_simple_instruction");
  return Object.freeze({ ok: true, text, length: text.length });
}
function initialScenarioResult(definition) {
  const capability = ({ unsupported_editor: "source_code_editing", unsupported_terminal: "terminal", unsupported_secret: "secret_management", future_cloud: "cloud_workspace_launch" })[definition.override];
  if (!capability) return null;
  return capability === "cloud_workspace_launch" ? unavailable("integration_pending", capability) : Object.freeze({ ...companionCapability(capability), ok: false, state: "capability_unavailable", sideEffects: false });
}
function safeActionRecord(action) { return Object.freeze({ destination: bounded(action.destination), decision: bounded(action.decision), planId: bounded(action.planId), agentId: bounded(action.agentId), control: bounded(action.control), actionId: bounded(action.actionId), capability: bounded(action.capability), confirmed: action.confirmed === true, textLength: typeof action.text === "string" ? action.text.length : 0 }); }
function observedAt(sequence) { return new Date(Date.parse(D14_FIXTURE_CLOCK) + sequence * 1000).toISOString(); }
function bounded(value) { return value == null ? null : String(value).replace(/[\r\n\0]/g, " ").slice(0, 120); }
function ok(state, extra = {}) { return Object.freeze({ ok: true, state, fixtureOnly: true, sideEffects: false, ...extra }); }
function unavailable(code, capability) { return Object.freeze({ ok: false, code, state: code === "integration_pending" ? "integration_pending" : "capability_unavailable", capability, sideEffects: false }); }
function immutableClone(value) { if (Array.isArray(value)) return Object.freeze(value.map(immutableClone)); if (value && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, immutableClone(item)]))); return value; }

module.exports = {
  D14_FIXTURE_SEED, D14_FIXTURE_CLOCK, D14_SCENARIOS, PORTAL_ORIGIN, PORTAL_RESPONSIBILITIES,
  PORTAL_DESTINATIONS, RETURN_ACTIONS, RETURN_VIEWS, COMPANION_NAVIGATION,
  ALLOWED_COMPANION_CAPABILITIES, EXCLUDED_COMPANION_CAPABILITIES, TABLET_PROFILES,
  getD14Scenario, createCompanionPortalHandoff, createReturnContext, companionCapability,
  createCompanionController,
};
