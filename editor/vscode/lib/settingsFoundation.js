// Host-neutral D12 settings and integrations foundation. Every mutable action is
// deterministic fixture state or an explicit fail-closed result; this module has
// no transport, filesystem, credential-vault, OAuth, SQL, or production fallback.

"use strict";

const D12_FIXTURE_SEED = "thrallo-desktop-d12-foundation";
const D12_FIXTURE_CLOCK = "2032-08-09T16:00:00.000Z";

const SETTINGS_SECTIONS = Object.freeze([
  "overview", "account", "workspace", "ai_models", "environment", "secrets", "database",
  "stripe", "github", "integrations", "storage", "usage", "security", "desktop_local",
]);
const SETTINGS_SCOPES = Object.freeze(["desktop_local", "workspace_local", "project", "account", "portal_managed", "future_cloud_workspace"]);
const INTEGRATION_STATES = Object.freeze(["disconnected", "connecting", "connected", "degraded", "expired", "revoked", "permission_denied", "configuration_required", "unavailable", "capability_unavailable"]);
const SECRET_CLASSES = Object.freeze(["application_secret", "provider_api_key", "database_credential", "webhook_secret", "oauth_token_metadata", "environment_secret"]);
const SUPABASE_STATES = Object.freeze(["not_connected", "configured", "healthy", "degraded", "authentication_issue", "rls_warning", "migration_pending", "storage_unavailable", "integration_unavailable"]);
const STRIPE_STATES = Object.freeze(["not_connected", "connected", "test_mode_fixture", "live_mode", "degraded", "webhook_issue", "capability_unavailable"]);
const GITHUB_STATES = Object.freeze(["not_connected", "connected", "dirty_local_workspace", "connection_degraded", "permission_unavailable"]);
const MODEL_PROVIDER_STATES = Object.freeze(["managed", "byok_configured", "byok_missing", "invalid", "revoked", "unavailable", "quota_budget_issue"]);

const BASE_SCENARIO = Object.freeze({
  supabase: "healthy", stripe: "test_mode_fixture", github: "connected", model: "managed",
  secret: "configured", environmentConflict: false, integration: "connected", offline: false,
  stale: false, storage: "available", databaseChange: "safe", initialSection: "overview",
});
const SCENARIOS = Object.freeze({
  "no-integrations": { supabase: "not_connected", stripe: "not_connected", github: "not_connected", model: "byok_missing", secret: "unconfigured", integration: "disconnected" },
  "supabase-healthy": { supabase: "healthy", initialSection: "database" },
  "supabase-degraded": { supabase: "degraded", initialSection: "database" },
  "supabase-rls-warning": { supabase: "rls_warning", initialSection: "database" },
  "migration-pending": { supabase: "migration_pending", initialSection: "database" },
  "stripe-connected-test-mode": { stripe: "test_mode_fixture", initialSection: "stripe" },
  "stripe-webhook-failure": { stripe: "webhook_issue", initialSection: "stripe" },
  "github-connected": { github: "connected", initialSection: "github" },
  "github-permission-issue": { github: "permission_unavailable", initialSection: "github" },
  "model-provider-managed": { model: "managed", initialSection: "ai_models" },
  "byok-configured": { model: "byok_configured", initialSection: "ai_models" },
  "byok-missing": { model: "byok_missing", secret: "unconfigured", initialSection: "ai_models" },
  "byok-revoked": { model: "revoked", initialSection: "ai_models" },
  "secret-configured": { secret: "configured", initialSection: "secrets" },
  "secret-replacement": { secret: "replaced", initialSection: "secrets" },
  "secret-deleted": { secret: "deleted", initialSection: "secrets" },
  "invalid-secret-name": { secret: "invalid", initialSection: "secrets" },
  "environment-conflict": { environmentConflict: true, initialSection: "environment" },
  "database-destructive-change-preview": { databaseChange: "destructive", initialSection: "database" },
  "database-safe-change-preview": { databaseChange: "safe", initialSection: "database" },
  "database-mutation-unavailable": { databaseChange: "unavailable", initialSection: "database" },
  "integration-expired": { integration: "expired", initialSection: "integrations" },
  "integration-revoked": { integration: "revoked", initialSection: "integrations" },
  "integration-unavailable": { integration: "unavailable", initialSection: "integrations" },
  "offline-local-project": { offline: true, initialSection: "workspace" },
  "stale-integration-health": { stale: true, initialSection: "integrations" },
  "storage-unavailable": { storage: "unavailable", initialSection: "storage" },
});
const D12_SCENARIOS = Object.freeze(Object.keys(SCENARIOS));

function getD12Scenario(name = "supabase-healthy") {
  if (!D12_SCENARIOS.includes(name)) throw new TypeError(`Unknown D12 fixture scenario: ${name}`);
  return Object.freeze({ name, ...BASE_SCENARIO, ...SCENARIOS[name] });
}

function createSettingsController({ scenario = "supabase-healthy", seed = D12_FIXTURE_SEED, providerSummary = null, now = fixtureNow } = {}) {
  const definition = getD12Scenario(scenario);
  const calls = [];
  let sequence = 0;
  let state = createInitialState(definition, seed, normalizeProviderSummary(providerSummary), now);

  async function dispatch(action) {
    if (!action || typeof action.type !== "string") throw new TypeError("D12 actions require an explicit type");
    sequence += 1;
    const call = recordCall(calls, sequence, action, seed, scenario, now);
    let result;
    if (action.type === "select_section") result = selectSection(action.section);
    else if (action.type === "set_project_context") result = setProjectContext(action.project);
    else if (action.type === "update_preference") result = updatePreference(action);
    else if (action.type === "save_preferences") result = savePreferences();
    else if (action.type === "create_secret") result = createSecret(action);
    else if (action.type === "replace_secret") result = replaceSecret(action);
    else if (action.type === "delete_secret") result = deleteSecret(action);
    else if (action.type === "review_secret_delete") result = reviewSecretDelete(action.name);
    else if (action.type === "cancel_secret_delete") result = cancelSecretDelete();
    else if (action.type === "confirm_secret_delete") result = confirmSecretDelete(action);
    else if (action.type === "preview_environment_variable") result = previewEnvironmentVariable(action);
    else if (action.type === "preview_database_change") result = previewDatabaseChange(action.changeId);
    else if (["apply_database_change", "rollback_database_change"].includes(action.type)) result = unavailable("integration_pending", action.type);
    else if (action.type === "integration_action") result = integrationAction(action.integrationId, action.actionId);
    else if (action.type === "request_handoff") result = requestHandoff(action.destination);
    else result = unavailable("unsupported_settings_action", action.type);
    state.lastAction = Object.freeze({ requestId: call.requestId, type: action.type, result: clone(result) });
    return Object.freeze({ result, state: snapshot() });
  }

  function selectSection(section) {
    if (!SETTINGS_SECTIONS.includes(section)) return unavailable("settings_section_unknown", "settings");
    state.section = section;
    return ok("settings_section_selected", { section });
  }

  function setProjectContext(project) {
    state.projectContext = safeProjectContext(project);
    state.storage = Object.freeze({ ...state.storage, local: Object.freeze({
      available: state.projectContext.local,
      projectType: state.projectContext.workspaceType,
      approximateBytes: safeNumber(project?.approximateBytes),
      importManifestBytes: safeNumber(project?.importManifestBytes),
      uploadState: "not_uploaded",
    }) });
    return ok("safe_project_context_selected", { projectId: state.projectContext.id, local: state.projectContext.local });
  }

  function updatePreference({ preferenceId, value }) {
    const index = state.preferences.findIndex((item) => item.id === preferenceId);
    if (index < 0) return unavailable("preference_unknown", "settings");
    const item = state.preferences[index];
    if (item.portalManaged) return unavailable("requires_portal", item.id);
    if (item.mutability !== "fixture_editable") return unavailable("capability_unavailable", item.id);
    const validation = validatePreference(item, value);
    if (!validation.valid) return unavailable(validation.code, item.id);
    state.preferences = replaceAt(state.preferences, index, Object.freeze({ ...item, value: validation.value, dirty: true, validation: "valid", currentState: "changed_fixture_only" }));
    return ok("fixture_preference_changed", { preferenceId: item.id, fixtureOnly: true });
  }

  function savePreferences() {
    const dirty = state.preferences.filter((item) => item.dirty && item.mutability === "fixture_editable");
    if (!dirty.length) return unavailable("no_settings_changes", "settings");
    state.preferences = Object.freeze(state.preferences.map((item) => item.dirty ? Object.freeze({ ...item, dirty: false, currentState: "fixture_saved", saveAvailability: "fixture_only" }) : item));
    addAudit("desktop_user", "preference_configured", "desktop_preferences", "fixture_saved");
    return ok("fixture_preferences_saved", { count: dirty.length, fixtureOnly: true });
  }

  function createSecret({ name, secretClass = "application_secret", value }) {
    const validation = validateSecretInput(name, secretClass, value);
    if (!validation.valid) return unavailable(validation.code, "secret");
    if (state.secrets.items.some((item) => item.name === validation.name && item.state !== "deleted")) return unavailable("duplicate_secret_name", "secret");
    const metadata = secretMetadata(validation.name, secretClass, "configured", now, sequence);
    state.secrets = Object.freeze({ ...state.secrets, items: Object.freeze([...state.secrets.items.filter((item) => item.name !== validation.name), metadata]), lastOperation: "configured" });
    addAudit("desktop_user", "secret_configured", validation.name, "fixture_only");
    return ok("fixture_secret_configured", { name: validation.name, secretState: "configured", valueRetrievable: false, fixtureOnly: true });
  }

  function replaceSecret({ name, value }) {
    const validation = validateSecretInput(name, "application_secret", value, { skipClass: true });
    if (!validation.valid) return unavailable(validation.code, "secret");
    const index = state.secrets.items.findIndex((item) => item.name === validation.name && item.state !== "deleted");
    if (index < 0) return unavailable("secret_not_configured", "secret");
    const current = state.secrets.items[index];
    state.secrets = Object.freeze({ ...state.secrets, items: replaceAt(state.secrets.items, index, Object.freeze({ ...current, state: "configured", revision: current.revision + 1, lastChangedAt: observedAt(now, sequence), valueRetrievable: false })), lastOperation: "replaced" });
    addAudit("desktop_user", "secret_replaced", validation.name, "fixture_only");
    return ok("fixture_secret_replaced", { name: validation.name, valueRetrievable: false, fixtureOnly: true });
  }

  function deleteSecret({ name }) {
    const safeName = validateSecretName(name);
    if (!safeName.valid) return unavailable(safeName.code, "secret");
    const index = state.secrets.items.findIndex((item) => item.name === safeName.name && item.state !== "deleted");
    if (index < 0) return unavailable("secret_not_configured", "secret");
    const current = state.secrets.items[index];
    state.secrets = Object.freeze({ ...state.secrets, items: replaceAt(state.secrets.items, index, Object.freeze({ ...current, state: "deleted", configured: false, revision: current.revision + 1, lastChangedAt: observedAt(now, sequence), valueRetrievable: false })), lastOperation: "deleted" });
    addAudit("desktop_user", "secret_removed", safeName.name, "fixture_only");
    return ok("fixture_secret_deleted", { name: safeName.name, fixtureOnly: true });
  }

  function reviewSecretDelete(name) {
    const safeName = validateSecretName(name);
    if (!safeName.valid || !state.secrets.items.some((item) => item.name === safeName.name && item.state !== "deleted")) return unavailable("secret_not_configured", "secret");
    state.secrets = Object.freeze({ ...state.secrets, pendingDelete: Object.freeze({ name: safeName.name, confirmationRequired: true, valueAvailable: false }) });
    return ok("fixture_secret_delete_review_ready", { name: safeName.name, confirmationRequired: true });
  }

  function cancelSecretDelete() {
    state.secrets = Object.freeze({ ...state.secrets, pendingDelete: null });
    return ok("fixture_secret_delete_review_canceled");
  }

  function confirmSecretDelete(action) {
    if (!state.secrets.pendingDelete || action.confirmed !== true || state.secrets.pendingDelete.name !== action.name) return unavailable("explicit_confirmation_required", "secret");
    const result = deleteSecret({ name: action.name });
    state.secrets = Object.freeze({ ...state.secrets, pendingDelete: null });
    return result;
  }

  function previewEnvironmentVariable({ key, environment = "development", secret = false }) {
    const validation = validateEnvironmentVariableName(key, state.environment.variables);
    if (!validation.valid) return unavailable(validation.code, "environment");
    if (!state.environment.environments.includes(environment)) return unavailable("environment_unknown", "environment");
    const preview = Object.freeze({ key: validation.name, environment, secret: secret === true, operation: "fixture_metadata_preview", valueAccepted: false, applyAvailability: "integration_pending" });
    state.environment = Object.freeze({ ...state.environment, pendingPreview: preview });
    addAudit("desktop_user", "environment_change_proposed", validation.name, "previewed");
    return ok("fixture_environment_preview_ready", { preview, fixtureOnly: true });
  }

  function previewDatabaseChange(changeId) {
    const change = state.database.changes.find((item) => item.id === changeId);
    if (!change) return unavailable("database_change_unknown", "database");
    state.database = Object.freeze({ ...state.database, pendingReview: Object.freeze({ ...change, approvalSource: "explicit_typed_fixture_action", reviewedAt: observedAt(now, sequence) }) });
    addAudit("desktop_user", "database_change_proposed", change.id, "previewed");
    return ok("fixture_database_change_previewed", { changeId, risk: change.risk, applyAvailability: "integration_pending", fixtureOnly: true });
  }

  function integrationAction(integrationId, actionId) {
    const integration = state.integrations.items.find((item) => item.id === integrationId);
    if (!integration) return unavailable("integration_unknown", "integrations");
    const descriptor = integration.actions.find((item) => item.id === actionId);
    if (!descriptor) return unavailable("integration_action_unknown", integrationId);
    if (descriptor.mode !== "fixture_read_only") return unavailable(descriptor.availability || "integration_pending", actionId);
    addAudit("desktop_user", "integration_inspected", integrationId, "fixture_only");
    return ok("fixture_integration_inspected", { integrationId, health: integration.health, fixtureOnly: true });
  }

  function requestHandoff(destination) {
    const descriptor = HANDOFFS[destination];
    if (!descriptor) return unavailable("handoff_destination_rejected", "handoff");
    return ok("approved_handoff_ready", { descriptor, sideEffects: false });
  }

  function addAudit(actor, action, resource, outcome) {
    state.audit = Object.freeze([Object.freeze({ id: `fixture-audit-${sequence}`, actorClassification: actor, action, timestamp: observedAt(now, sequence), resource: boundedIdentifier(resource), outcome }), ...state.audit]);
  }

  function snapshot() { return immutableClone(redactSensitive(state)); }
  function getCalls() { return Object.freeze(calls.map((item) => immutableClone(item))); }
  return Object.freeze({ dispatch, snapshot, getCalls });
}

const HANDOFFS = Object.freeze({
  thrallo_account: Object.freeze({ id: "thrallo_account", kind: "portal", destination: "account", label: "Account settings" }),
  thrallo_billing: Object.freeze({ id: "thrallo_billing", kind: "portal", destination: "billing", label: "Billing" }),
  thrallo_integrations: Object.freeze({ id: "thrallo_integrations", kind: "portal", destination: "integrations", label: "Thrallo integrations" }),
  thrallo_usage: Object.freeze({ id: "thrallo_usage", kind: "portal", destination: "usage", label: "Usage" }),
  thrallo_api_keys: Object.freeze({ id: "thrallo_api_keys", kind: "portal", destination: "api_keys", label: "API keys" }),
  github_manage: Object.freeze({ id: "github_manage", kind: "external", url: "https://github.com/settings/installations", label: "GitHub installations" }),
  stripe_manage: Object.freeze({ id: "stripe_manage", kind: "external", url: "https://dashboard.stripe.com/", label: "Stripe dashboard" }),
});

function createInitialState(definition, seed, providerSummary, now) {
  const integrationState = definition.integration;
  const initialSecret = definition.secret === "unconfigured" || definition.secret === "deleted" ? [] : [Object.freeze({
    ...secretMetadata("FIXTURE_PROVIDER_KEY", "provider_api_key", definition.secret === "invalid" ? "invalid" : "configured", now, 0),
    revision: definition.secret === "replaced" ? 2 : 1,
  })];
  if (definition.secret === "deleted") initialSecret.push(Object.freeze({ ...secretMetadata("FIXTURE_PROVIDER_KEY", "provider_api_key", "deleted", now, 0), configured: false }));
  const databaseChanges = Object.freeze([
    Object.freeze({ id: "add-project-index", operation: "add_index", affectedObjects: Object.freeze(["public.fixture_projects"]), risk: "non_destructive", dataLossWarning: false, approvalRequired: true, validation: "valid", rollbackAvailability: "future_provider_required" }),
    Object.freeze({ id: "remove-legacy-column", operation: "drop_column", affectedObjects: Object.freeze(["public.fixture_projects.legacy_label"]), risk: "destructive", dataLossWarning: true, approvalRequired: true, validation: "warning", rollbackAvailability: "unavailable" }),
  ]);
  const preferredChange = definition.databaseChange === "destructive" ? databaseChanges[1] : definition.databaseChange === "safe" ? databaseChanges[0] : null;
  const providerState = definition.model;
  const supabaseState = definition.supabase;
  return {
    schemaVersion: "1.0", source: "deterministic_fixture", fixtureOnly: true, seed, scenario: definition.name, observedAt: D12_FIXTURE_CLOCK,
    section: definition.initialSection,
    sections: SETTINGS_SECTIONS,
    preferences: createPreferences(),
    projectContext: safeProjectContext(null),
    environment: Object.freeze({ environments: Object.freeze(["development", "preview", "production"]), customEnvironmentAvailability: "integration_pending", variables: createEnvironmentVariables(definition.environmentConflict), pendingPreview: null, authority: "desktop_fixture_metadata_only" }),
    secrets: Object.freeze({ states: Object.freeze(["configured", "unconfigured", "invalid", "unavailable", "permission_denied", "deleted"]), classes: SECRET_CLASSES, items: Object.freeze(initialSecret), lastOperation: definition.secret, valuePolicy: "accepted_once_metadata_only", plaintextFallback: false, pendingDelete: null }),
    database: Object.freeze({ provider: "supabase_fixture", state: supabaseState, projectLabel: supabaseState === "not_connected" ? null : "Fixture Supabase project", health: databaseHealth(supabaseState), tables: Object.freeze([{ schema: "public", name: "fixture_projects", columns: 6, rowsApproximate: 12, rls: supabaseState === "rls_warning" ? "warning" : "enabled" }, { schema: "public", name: "fixture_runs", columns: 8, rowsApproximate: 24, rls: "enabled" }]), migrationStatus: supabaseState === "migration_pending" ? "pending" : "current", storageStatus: supabaseState === "storage_unavailable" ? "unavailable" : "healthy", authCapability: supabaseState === "authentication_issue" ? "issue" : "configured", rlsStatus: supabaseState === "rls_warning" ? "warning" : "enabled", recentOperation: "fixture_read_only", changes: databaseChanges, pendingReview: preferredChange, applyAvailability: definition.databaseChange === "unavailable" ? "capability_unavailable" : "integration_pending", serviceCredentialExposed: false, sqlConsole: false }),
    stripe: createStripe(definition.stripe),
    github: createGithub(definition.github),
    modelProviders: createModelProviders(providerState),
    integrations: Object.freeze({ states: INTEGRATION_STATES, items: createIntegrationRegistry({ integrationState, supabaseState, stripeState: definition.stripe, githubState: definition.github, providerState, stale: definition.stale }), stale: definition.stale }),
    storage: Object.freeze({ local: Object.freeze({ available: false, projectType: null, approximateBytes: null, importManifestBytes: null, uploadState: "not_uploaded" }), fixtureCloud: Object.freeze({ state: definition.storage, allowance: definition.storage === "unavailable" ? null : Object.freeze({ availability: "fixture_only", value: "unknown" }), artifactUsage: definition.storage === "unavailable" ? null : Object.freeze({ bytes: 24576, classification: "fixture_artifacts" }) }), uploadEnabled: false }),
    audit: createInitialAudit(definition),
    handoffs: Object.freeze(Object.values(HANDOFFS)),
    providerSummary,
    offline: definition.offline,
    boundaries: Object.freeze({ productionMutations: "capability_unavailable", builderV2Mutation: "capability_unavailable", cloudWorkspaceEnvironment: "integration_pending", oauthCallbacks: "integration_pending", databaseApply: "integration_pending", realCredentialStorage: "not_implemented_in_fixture_provider", buildr101Reuse: "forbidden", portalManaged: Object.freeze(["account", "billing", "usage", "api_tokens"]) }),
    lastAction: null,
  };
}

function createPreferences() {
  return Object.freeze([
    preference("desktop.compactControls", "boolean", "desktop_local", false, "fixture_editable", false, "available"),
    preference("desktop.reducedMotion", "boolean", "desktop_local", false, "fixture_editable", false, "available"),
    preference("workspace.restoreLast", "boolean", "workspace_local", true, "fixture_editable", false, "available"),
    preference("account.profile", "action", "portal_managed", null, "portal_only", false, "requires_portal"),
    preference("account.billing", "action", "portal_managed", null, "portal_only", true, "requires_portal"),
    preference("cloud.compute", "resource", "future_cloud_workspace", null, "unavailable", false, "integration_pending"),
  ]);
}
function preference(id, valueType, scope, value, mutability, sensitivity, saveAvailability) { return Object.freeze({ id, valueType, source: scope === "portal_managed" ? "portal" : "desktop_fixture", scope, mutability, validation: "valid", sensitivity, capabilityRequirement: scope === "future_cloud_workspace" ? "cloudWorkspace" : null, currentState: scope === "portal_managed" ? "portal_managed" : "configured", dirty: false, saveAvailability, restartRequirement: id === "desktop.reducedMotion" ? "none" : "none", portalManaged: scope === "portal_managed", value }); }

function createEnvironmentVariables(conflict) {
  return Object.freeze([
    Object.freeze({ key: "PUBLIC_APP_MODE", environment: "development", source: "fixture_project_metadata", secret: false, configured: true, inherited: false, overridden: false, lastChangedAt: D12_FIXTURE_CLOCK, validation: "valid", valueReturned: false }),
    Object.freeze({ key: "FIXTURE_PROVIDER_KEY", environment: "preview", source: "secret_metadata", secret: true, configured: true, inherited: true, overridden: false, lastChangedAt: D12_FIXTURE_CLOCK, validation: "valid", valueReturned: false }),
    ...(conflict ? [Object.freeze({ key: "PUBLIC_APP_MODE", environment: "development", source: "fixture_override", secret: false, configured: true, inherited: false, overridden: true, lastChangedAt: D12_FIXTURE_CLOCK, validation: "duplicate_conflict", valueReturned: false })] : []),
  ]);
}

function secretMetadata(name, secretClass, state, now, sequence) { return Object.freeze({ id: `fixture-secret-${digest(name)}`, name, class: secretClass, state, configured: state === "configured", valueRetrievable: false, copyAvailable: false, revealStatus: "metadata_only", revision: state === "replaced" ? 2 : 1, lastChangedAt: observedAt(now, sequence), permission: "fixture_only" }); }
function createStripe(state) { return Object.freeze({ state, connectionLabel: state === "not_connected" ? null : "Fixture Stripe connection", mode: state === "live_mode" ? "live_metadata_only" : "test_fixture", webhookHealth: state === "webhook_issue" ? "failing" : state === "not_connected" ? "unavailable" : "healthy", projectState: state === "not_connected" ? "not_configured" : "fixture_configured", recentEvents: Object.freeze(state === "not_connected" ? [] : [{ type: "fixture.checkout.completed", outcome: "simulated", timestamp: D12_FIXTURE_CLOCK }]), secretExposed: false, mutations: "capability_unavailable" }); }
function createGithub(state) { return Object.freeze({ state, accountLabel: state === "not_connected" ? null : "Fixture GitHub installation", repository: state === "not_connected" ? null : "fixture-org/fixture-app", branch: state === "not_connected" ? null : "desktop-fixture", defaultBranch: state === "not_connected" ? null : "main", dirty: state === "dirty_local_workspace", remoteStatus: state === "permission_unavailable" ? "permission_denied" : state === "not_connected" ? "unavailable" : "read_only_fixture", pullRequest: state === "connected" ? Object.freeze({ number: 42, title: "Fixture desktop foundation", state: "open" }) : null, permissions: state === "permission_unavailable" ? "unavailable" : "metadata_read", mutations: "capability_unavailable" }); }
function createModelProviders(state) { return Object.freeze([{ id: "thrallo-managed", name: "Thrallo managed", classification: "managed", state: "managed", secretId: null, callsModels: false }, { id: "fixture-byok", name: "Fixture BYOK provider", classification: "byok", state: state === "managed" ? "byok_missing" : state, secretId: state === "byok_configured" ? "fixture-secret-provider" : null, callsModels: false }]); }

function createIntegrationRegistry({ integrationState, supabaseState, stripeState, githubState, providerState, stale }) {
  const checked = stale ? "2032-08-08T16:00:00.000Z" : D12_FIXTURE_CLOCK;
  return Object.freeze([
    integration("supabase", "Supabase", mapSupabaseIntegration(supabaseState), "project", "project_configuration", checked),
    integration("stripe", "Stripe", mapStripeIntegration(stripeState), "project", "external_handoff", checked),
    integration("github", "GitHub", mapGithubIntegration(githubState), "account", "future_oauth", checked),
    integration("model-provider", "Model provider", mapProviderIntegration(providerState), "project", "secret_contract", checked),
    integration("external-service", "Future external service", integrationState, "project", "future_provider", checked),
  ]);
}
function integration(id, name, status, scope, authType, lastChecked) { return Object.freeze({ id, type: id, name, status, requiredCapability: "integrations", authType, scope, health: status === "connected" ? "healthy" : status, lastChecked, actions: Object.freeze([{ id: "inspect", label: "Inspect fixture state", mode: "fixture_read_only", availability: "available" }, { id: "connect", label: "Connect", mode: "production_mutation", availability: "integration_pending" }, { id: "disconnect", label: "Disconnect", mode: "production_mutation", availability: "integration_pending" }]), portalHandoff: ["stripe", "github"].includes(id), mutationAvailability: "integration_pending" }); }

function createInitialAudit(definition) { return Object.freeze([Object.freeze({ id: "fixture-audit-initial", actorClassification: "fixture_system", action: "integration_state_observed", timestamp: D12_FIXTURE_CLOCK, resource: boundedIdentifier(definition.name), outcome: "fixture_only" })]); }
function databaseHealth(state) { return ({ healthy: "healthy", configured: "healthy", degraded: "degraded", authentication_issue: "unhealthy", rls_warning: "degraded", migration_pending: "checking", storage_unavailable: "degraded", not_connected: "unavailable", integration_unavailable: "unavailable" })[state] || "unknown"; }
function mapSupabaseIntegration(state) { return ({ healthy: "connected", configured: "connected", degraded: "degraded", authentication_issue: "expired", rls_warning: "degraded", migration_pending: "configuration_required", storage_unavailable: "degraded", not_connected: "disconnected", integration_unavailable: "unavailable" })[state] || "unavailable"; }
function mapStripeIntegration(state) { return ({ connected: "connected", test_mode_fixture: "connected", live_mode: "connected", degraded: "degraded", webhook_issue: "degraded", not_connected: "disconnected", capability_unavailable: "capability_unavailable" })[state] || "unavailable"; }
function mapGithubIntegration(state) { return ({ connected: "connected", dirty_local_workspace: "connected", connection_degraded: "degraded", permission_unavailable: "permission_denied", not_connected: "disconnected" })[state] || "unavailable"; }
function mapProviderIntegration(state) { return ({ managed: "connected", byok_configured: "connected", byok_missing: "configuration_required", invalid: "degraded", revoked: "revoked", unavailable: "unavailable", quota_budget_issue: "degraded" })[state] || "unavailable"; }

function validateSecretInput(name, secretClass, value, { skipClass = false } = {}) { const nameResult = validateSecretName(name); if (!nameResult.valid) return nameResult; if (!skipClass && !SECRET_CLASSES.includes(secretClass)) return { valid: false, code: "secret_class_invalid" }; if (typeof value !== "string" || value.length < 8 || value.length > 8192) return { valid: false, code: "secret_value_invalid" }; return { valid: true, name: nameResult.name }; }
function validateSecretName(value) { const name = String(value || "").trim(); if (!/^[A-Z][A-Z0-9_]{1,79}$/.test(name)) return { valid: false, code: "secret_name_invalid" }; if (/^(SUPABASE_SERVICE_ROLE_KEY|STRIPE_SECRET_KEY|DATABASE_URL|PRIVATE_KEY)$/.test(name)) return { valid: false, code: "reserved_secret_name" }; return { valid: true, name }; }
function validateEnvironmentVariableName(value, existing = []) { const name = String(value || "").trim(); if (!/^[A-Z_][A-Z0-9_]{1,79}$/.test(name)) return { valid: false, code: "environment_name_invalid" }; if (/^(NODE_OPTIONS|ELECTRON_RUN_AS_NODE)$/.test(name)) return { valid: false, code: "environment_name_reserved" }; if (existing.some((item) => item.key === name && item.environment === "development")) return { valid: false, code: "duplicate_environment_variable" }; return { valid: true, name }; }
function validateWebhookUrl(value) { try { const url = new URL(String(value || "")); return { valid: url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash, code: "webhook_url_invalid" }; } catch { return { valid: false, code: "webhook_url_invalid" }; } }
function validateRepositoryIdentifier(value) { const normalized = String(value || "").trim(); return { valid: /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(normalized), value: normalized, code: "repository_identifier_invalid" }; }
function classifySchemaChange(operation) { return Object.freeze({ operation, risk: /drop|truncate|delete|alter_type/i.test(String(operation)) ? "destructive" : "non_destructive", approvalRequired: true }); }
function validatePreference(item, value) { if (item.valueType === "boolean" && typeof value !== "boolean") return { valid: false, code: "preference_value_invalid" }; return { valid: true, value: item.valueType === "boolean" ? value : boundedIdentifier(value) }; }

function createD12ReadOnlyAdapter({ transport, routes } = {}) {
  if (!transport || typeof transport.request !== "function") throw new TypeError("D12 read-only adapter requires injected transport");
  const allowed = Object.freeze(["settings", "environment", "secrets", "database", "integrations", "audit"]);
  const routeMap = {};
  for (const key of allowed) routeMap[key] = validateReadRoute(routes?.[key], key);
  async function read(key) { return transport.request({ method: "GET", path: routeMap[key] }); }
  const mutation = (operation) => async () => unavailable("capability_unavailable", operation);
  return Object.freeze({
    getSettings: () => read("settings"), getEnvironmentMetadata: () => read("environment"), listSecretMetadata: () => read("secrets"), getDatabaseSummary: () => read("database"), listIntegrations: () => read("integrations"), listAuditEvents: () => read("audit"),
    createSecret: mutation("createSecret"), replaceSecret: mutation("replaceSecret"), deleteSecret: mutation("deleteSecret"), applyDatabaseChange: mutation("applyDatabaseChange"), connectIntegration: mutation("connectIntegration"),
  });
}
function validateReadRoute(value, key) { if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) throw new TypeError(`D12 ${key} route must be explicit and origin-relative`); const url = new URL(value, "https://fixture.invalid"); if (url.origin !== "https://fixture.invalid" || url.username || url.password || url.search || url.hash) throw new TypeError(`D12 ${key} route is unsafe`); return url.pathname; }

function normalizeProviderSummary(value) { if (!value || typeof value !== "object") return null; return Object.freeze({ integrations: safeNumber(value.integrations), secretMetadata: safeNumber(value.secretMetadata), databaseProvider: boundedIdentifier(value.databaseProvider || "unavailable"), source: "injected_read_only" }); }
function safeProjectContext(project) { return Object.freeze({ id: boundedIdentifier(project?.id || "none"), name: boundedText(project?.name || "No project selected", 120), workspaceType: boundedIdentifier(project?.workspaceType || "none"), local: project?.local === true, framework: boundedText(project?.framework || "Unknown", 80), gitState: project?.git?.dirty === true ? "dirty" : project?.git ? "clean" : "unavailable", environmentFilesRead: false, uploaded: false }); }
function recordCall(calls, sequence, action, seed, scenario, now) { const call = Object.freeze({ sequence, operation: boundedIdentifier(action.type), requestId: `fixture-d12-${digest(`${seed}:${scenario}:${action.type}:${sequence}`)}`, observedAt: observedAt(now, sequence), input: sanitizeAction(action) }); calls.push(call); return call; }
function sanitizeAction(action) { const result = { type: boundedIdentifier(action.type) }; for (const [key, value] of Object.entries(action)) { if (key === "type" || /value|secret|token|password|credential|cookie|authorization/i.test(key)) continue; if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") result[key] = typeof value === "string" ? boundedText(value, 120) : value; } if (Object.prototype.hasOwnProperty.call(action, "value")) result.valueProvided = typeof action.value === "string" && action.value.length > 0; return Object.freeze(result); }
function redactSensitive(value) { if (Array.isArray(value)) return value.map(redactSensitive); if (value && typeof value === "object") { const out = {}; for (const [key, child] of Object.entries(value)) out[key] = /(^|_)(password|private_key|service_role|secret_value|token|cookie|authorization|credential)($|_)/i.test(key) ? "[REDACTED]" : redactSensitive(child); return out; } if (typeof value !== "string") return value; return redactString(value); }
function redactString(value) { return String(value)
  .replace(/(?:sk|xai|ghp|github_pat|sb_secret|whsec)[-_][A-Za-z0-9_-]{8,}/gi, "[REDACTED]")
  .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
  .replace(/Cookie:\s*[^\r\n]+/gi, "Cookie: [REDACTED]")
  .replace(/\b(?:oauth|access|refresh)[-_]?token[-_:]?[A-Za-z0-9._-]{8,}\b/gi, "[REDACTED_TOKEN]")
  .replace(/(?:postgres(?:ql)?|mysql):\/\/[^\s]+/gi, "[REDACTED_DATABASE_URL]")
  .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi, "[REDACTED_PRIVATE_KEY]")
  .replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED_JWT]")
  .replace(/((?:password|token|secret|api[_-]?key|cookie|authorization))=([^&\s]+)/gi, "$1=[REDACTED]"); }
function ok(state, extra = {}) { return Object.freeze({ ok: true, state, sideEffects: state.startsWith("fixture_") || state === "safe_project_context_selected", source: "fixture", ...extra }); }
function unavailable(code, capability) { return Object.freeze({ ok: false, code, state: code === "integration_pending" ? "integration_pending" : "capability_unavailable", capability, sideEffects: false, source: "fixture" }); }
function replaceAt(items, index, value) { return Object.freeze(items.map((item, current) => current === index ? value : item)); }
function safeNumber(value) { const number = Number(value); return Number.isFinite(number) && number >= 0 ? number : null; }
function boundedIdentifier(value) { return String(value || "").replace(/[^a-z0-9_.:\/-]/gi, "").slice(0, 120) || "unknown"; }
function boundedText(value, length) { return redactString(String(value || "").replace(/[\r\n]+/g, " ").slice(0, length)); }
function observedAt(now, sequence) { return new Date(now().valueOf() + sequence * 1000).toISOString(); }
function fixtureNow() { return new Date(D12_FIXTURE_CLOCK); }
function digest(value) { let hash = 0x811c9dc5; for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193) >>> 0; return hash.toString(16).padStart(8, "0"); }
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function immutableClone(value) { const cloned = clone(value); const freeze = (item) => { if (!item || typeof item !== "object" || Object.isFrozen(item)) return item; Object.values(item).forEach(freeze); return Object.freeze(item); }; return freeze(cloned); }

module.exports = {
  D12_FIXTURE_SEED, D12_FIXTURE_CLOCK, D12_SCENARIOS, SETTINGS_SECTIONS, SETTINGS_SCOPES,
  INTEGRATION_STATES, SECRET_CLASSES, SUPABASE_STATES, STRIPE_STATES, GITHUB_STATES,
  MODEL_PROVIDER_STATES, HANDOFFS, getD12Scenario, createSettingsController,
  createD12ReadOnlyAdapter, validateSecretName, validateEnvironmentVariableName,
  validateWebhookUrl, validateRepositoryIdentifier, classifySchemaChange, redactSensitive,
};
