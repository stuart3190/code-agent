import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import * as client from "../../shared/thrallo-client/src/index.mjs";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const settingsPath = path.join(root, "editor/vscode/lib/settingsFoundation.js");
const viewPath = path.join(root, "editor/vscode/lib/settingsView.js");
const hostPath = path.join(root, "editor/vscode/lib/desktopProductHost.js");
const {
  D12_SCENARIOS, SETTINGS_SECTIONS, SETTINGS_SCOPES, INTEGRATION_STATES, SECRET_CLASSES,
  SUPABASE_STATES, STRIPE_STATES, GITHUB_STATES, MODEL_PROVIDER_STATES, HANDOFFS,
  createSettingsController, createD12ReadOnlyAdapter, validateSecretName,
  validateEnvironmentVariableName, validateWebhookUrl, validateRepositoryIdentifier,
  classifySchemaChange, redactSensitive,
} = require(settingsPath);
const { createDesktopProductController, NAVIGATION_ITEMS } = require(path.join(root, "editor/vscode/lib/desktopProduct.js"));
const { renderDesktopProductHtml } = require(path.join(root, "editor/vscode/lib/desktopProductView.js"));
const { createDesktopProductHost, safeExternalSettingsUrl } = require(hostPath);

const localRegistry = Object.freeze({ async recent() { return Object.freeze([]); }, async recordPreview() { return null; } });

test("D12 declares the complete settings, scope, integration and provider state vocabularies", () => {
  assert.deepEqual(SETTINGS_SCOPES, ["desktop_local", "workspace_local", "project", "account", "portal_managed", "future_cloud_workspace"]);
  for (const section of ["account", "workspace", "ai_models", "environment", "secrets", "database", "stripe", "github", "integrations", "storage", "usage", "security", "desktop_local"]) assert.ok(SETTINGS_SECTIONS.includes(section));
  for (const state of ["disconnected", "connecting", "connected", "degraded", "expired", "revoked", "permission_denied", "configuration_required", "unavailable", "capability_unavailable"]) assert.ok(INTEGRATION_STATES.includes(state));
  assert.equal(SECRET_CLASSES.length, 6);
  assert.ok(SUPABASE_STATES.includes("rls_warning") && STRIPE_STATES.includes("webhook_issue") && GITHUB_STATES.includes("permission_unavailable") && MODEL_PROVIDER_STATES.includes("byok_configured"));
});

test("D12 deterministic scenario catalogue covers every requested foundation state", () => {
  const required = ["no-integrations", "supabase-healthy", "supabase-degraded", "supabase-rls-warning", "migration-pending", "stripe-connected-test-mode", "stripe-webhook-failure", "github-connected", "github-permission-issue", "model-provider-managed", "byok-configured", "byok-missing", "byok-revoked", "secret-configured", "secret-replacement", "secret-deleted", "invalid-secret-name", "environment-conflict", "database-destructive-change-preview", "database-safe-change-preview", "database-mutation-unavailable", "integration-expired", "integration-revoked", "integration-unavailable", "offline-local-project", "stale-integration-health", "storage-unavailable"];
  assert.deepEqual(D12_SCENARIOS, required);
});

test("identical D12 seeds yield identical settings, integration and audit state", async () => {
  const first = createSettingsController({ scenario: "supabase-rls-warning", seed: "same" });
  const second = createSettingsController({ scenario: "supabase-rls-warning", seed: "same" });
  await first.dispatch({ type: "preview_database_change", changeId: "add-project-index" });
  await second.dispatch({ type: "preview_database_change", changeId: "add-project-index" });
  assert.deepEqual(first.snapshot(), second.snapshot());
  assert.deepEqual(first.getCalls(), second.getCalls());
});

test("settings model distinguishes source, type, scope, mutability and portal authority", async () => {
  const controller = createSettingsController();
  const snapshot = controller.snapshot();
  assert.ok(snapshot.preferences.every((item) => item.id && item.valueType && SETTINGS_SCOPES.includes(item.scope) && item.source && item.mutability && item.validation && item.currentState));
  const result = await controller.dispatch({ type: "update_preference", preferenceId: "account.billing", value: true });
  assert.equal(result.result.code, "requires_portal");
  assert.equal(result.result.sideEffects, false);
});

test("desktop-local preferences change and save only deterministic fixture state", async () => {
  const controller = createSettingsController();
  await controller.dispatch({ type: "update_preference", preferenceId: "desktop.compactControls", value: true });
  assert.equal(controller.snapshot().preferences.find((item) => item.id === "desktop.compactControls").dirty, true);
  const saved = await controller.dispatch({ type: "save_preferences" });
  assert.equal(saved.result.state, "fixture_preferences_saved");
  assert.equal(controller.snapshot().preferences.find((item) => item.id === "desktop.compactControls").dirty, false);
});

test("environment metadata contains no values and conflicts are explicit", () => {
  const snapshot = createSettingsController({ scenario: "environment-conflict" }).snapshot();
  assert.ok(snapshot.environment.variables.some((item) => item.validation === "duplicate_conflict"));
  assert.ok(snapshot.environment.variables.every((item) => item.valueReturned === false && !Object.hasOwn(item, "value")));
  assert.equal(snapshot.environment.authority, "desktop_fixture_metadata_only");
});

test("environment, secret, webhook, repository and schema validation fail safely", () => {
  assert.equal(validateSecretName("bad-name").valid, false);
  assert.equal(validateSecretName("SUPABASE_SERVICE_ROLE_KEY").code, "reserved_secret_name");
  assert.equal(validateEnvironmentVariableName("NODE_OPTIONS").code, "environment_name_reserved");
  assert.equal(validateEnvironmentVariableName("DUPLICATE", [{ key: "DUPLICATE", environment: "development" }]).code, "duplicate_environment_variable");
  assert.equal(validateWebhookUrl("http://fixture.invalid/hook").valid, false);
  assert.equal(validateWebhookUrl("https://fixture.invalid/hook").valid, true);
  assert.equal(validateWebhookUrl("https://fixture.invalid/hook?token=synthetic").valid, false);
  assert.equal(validateRepositoryIdentifier("fixture-org/fixture-app").valid, true);
  assert.equal(validateRepositoryIdentifier("https://github.com/x/y").valid, false);
  assert.equal(classifySchemaChange("drop_table").risk, "destructive");
  assert.equal(classifySchemaChange("add_index").risk, "non_destructive");
});

test("secret create replace and delete lifecycle returns metadata only", async () => {
  const controller = createSettingsController({ scenario: "no-integrations" });
  const value = "sk-proj-SYNTHETIC_D12_VALUE_123456";
  const created = await controller.dispatch({ type: "create_secret", name: "FIXTURE_NEW_KEY", secretClass: "provider_api_key", value });
  assert.equal(created.result.state, "fixture_secret_configured");
  assert.equal(created.result.valueRetrievable, false);
  assert.equal(controller.snapshot().secrets.items[0].valueRetrievable, false);
  const replaced = await controller.dispatch({ type: "replace_secret", name: "FIXTURE_NEW_KEY", value: "sk-ant-api03-SYNTHETIC_REPLACEMENT_98765" });
  assert.equal(replaced.result.state, "fixture_secret_replaced");
  assert.equal(controller.snapshot().secrets.items[0].revision, 2);
  await controller.dispatch({ type: "review_secret_delete", name: "FIXTURE_NEW_KEY" });
  const rejected = await controller.dispatch({ type: "confirm_secret_delete", name: "FIXTURE_NEW_KEY", confirmed: false });
  assert.equal(rejected.result.code, "explicit_confirmation_required");
  const deleted = await controller.dispatch({ type: "confirm_secret_delete", name: "FIXTURE_NEW_KEY", confirmed: true });
  assert.equal(deleted.result.state, "fixture_secret_deleted");
  assert.equal(controller.snapshot().secrets.items[0].state, "deleted");
});

test("submitted secret material disappears from state, calls, results and audit events", async () => {
  const secrets = [
    "sk-proj-SYNTHETIC_OPENAI_123456789", "sk-ant-api03-SYNTHETIC_ANTHROPIC_123456", "xai-SYNTHETIC_XAI_123456789",
    "sk_live_SYNTHETIC_STRIPE_123456", "whsec_SYNTHETIC_WEBHOOK_123456", "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.SYNTHETICSIGNATURE",
    "postgresql://fixture:synthetic-password@db.fixture.invalid/postgres", "ghp_SYNTHETIC_GITHUB_123456789", "oauth_token_SYNTHETIC_123456789",
    "Cookie: session=synthetic-cookie-value", "Bearer SYNTHETIC_BEARER_TOKEN_123456", "-----BEGIN PRIVATE KEY-----\nSYNTHETICPRIVATEKEY\n-----END PRIVATE KEY-----",
  ];
  for (let index = 0; index < secrets.length; index += 1) {
    const controller = createSettingsController({ scenario: "no-integrations", seed: `redact-${index}` });
    const response = await controller.dispatch({ type: "create_secret", name: `FIXTURE_KEY_${index}`, secretClass: "application_secret", value: secrets[index] });
    const evidence = JSON.stringify({ response, snapshot: controller.snapshot(), calls: controller.getCalls() });
    assert.ok(!evidence.includes(secrets[index]), `secret ${index} leaked`);
    assert.ok(!JSON.stringify(redactSensitive({ message: secrets[index] })).includes(secrets[index]));
  }
});

test("secret snapshots never expose copy, reveal or plaintext fallback", () => {
  const secret = createSettingsController({ scenario: "secret-configured" }).snapshot().secrets;
  assert.equal(secret.plaintextFallback, false);
  assert.ok(secret.items.every((item) => item.copyAvailable === false && item.valueRetrievable === false && item.revealStatus === "metadata_only"));
});

test("Supabase fixture states expose safe health, table, migration, storage, auth and RLS metadata", () => {
  for (const [scenario, expected] of [["supabase-healthy", "healthy"], ["supabase-degraded", "degraded"], ["supabase-rls-warning", "rls_warning"], ["migration-pending", "migration_pending"]]) {
    const database = createSettingsController({ scenario }).snapshot().database;
    assert.equal(database.state, expected);
    assert.ok(Array.isArray(database.tables));
    assert.equal(database.serviceCredentialExposed, false);
    assert.equal(database.sqlConsole, false);
  }
});

test("database safe and destructive reviews are structured and explicit", async () => {
  const controller = createSettingsController({ scenario: "database-safe-change-preview" });
  const safe = await controller.dispatch({ type: "preview_database_change", changeId: "add-project-index" });
  assert.equal(safe.result.risk, "non_destructive");
  const destructive = await controller.dispatch({ type: "preview_database_change", changeId: "remove-legacy-column" });
  assert.equal(destructive.result.risk, "destructive");
  assert.equal(controller.snapshot().database.pendingReview.dataLossWarning, true);
  assert.equal(controller.snapshot().database.pendingReview.approvalSource, "explicit_typed_fixture_action");
});

test("database apply and rollback always fail closed without SQL", async () => {
  const controller = createSettingsController();
  for (const type of ["apply_database_change", "rollback_database_change"]) {
    const response = await controller.dispatch({ type, changeId: "add-project-index", approved: true });
    assert.equal(response.result.code, "integration_pending");
    assert.equal(response.result.sideEffects, false);
  }
});

test("Stripe states are redacted metadata and expose no commerce mutations", () => {
  const connected = createSettingsController({ scenario: "stripe-connected-test-mode" }).snapshot().stripe;
  const failed = createSettingsController({ scenario: "stripe-webhook-failure" }).snapshot().stripe;
  assert.equal(connected.mode, "test_fixture");
  assert.equal(connected.secretExposed, false);
  assert.equal(connected.mutations, "capability_unavailable");
  assert.equal(failed.webhookHealth, "failing");
});

test("GitHub states preserve Code OSS local authority and disable mutations", () => {
  const connected = createSettingsController({ scenario: "github-connected" }).snapshot().github;
  const denied = createSettingsController({ scenario: "github-permission-issue" }).snapshot().github;
  assert.equal(connected.repository, "fixture-org/fixture-app");
  assert.equal(connected.mutations, "capability_unavailable");
  assert.equal(denied.permissions, "unavailable");
});

test("managed and BYOK model-provider states compose without model calls or stored keys", () => {
  for (const scenario of ["model-provider-managed", "byok-configured", "byok-missing", "byok-revoked"]) {
    const providers = createSettingsController({ scenario }).snapshot().modelProviders;
    assert.ok(providers.every((item) => item.callsModels === false));
    assert.ok(providers.every((item) => !Object.hasOwn(item, "apiKey")));
    assert.ok(providers.every((item) => MODEL_PROVIDER_STATES.includes(item.state)));
  }
});

test("integration registry covers Supabase, Stripe, GitHub, model providers and future services", async () => {
  const controller = createSettingsController({ scenario: "stale-integration-health" });
  const state = controller.snapshot();
  assert.deepEqual(state.integrations.items.map((item) => item.id), ["supabase", "stripe", "github", "model-provider", "external-service"]);
  assert.equal(state.integrations.stale, true);
  const inspected = await controller.dispatch({ type: "integration_action", integrationId: "supabase", actionId: "inspect" });
  assert.equal(inspected.result.state, "fixture_integration_inspected");
  const blocked = await controller.dispatch({ type: "integration_action", integrationId: "supabase", actionId: "connect" });
  assert.equal(blocked.result.code, "integration_pending");
});

test("expired, revoked and unavailable integration states are distinct", () => {
  assert.equal(createSettingsController({ scenario: "integration-expired" }).snapshot().integrations.items.at(-1).status, "expired");
  assert.equal(createSettingsController({ scenario: "integration-revoked" }).snapshot().integrations.items.at(-1).status, "revoked");
  assert.equal(createSettingsController({ scenario: "integration-unavailable" }).snapshot().integrations.items.at(-1).status, "unavailable");
});

test("portal and external handoffs are enumerated, token-free and reject arbitrary destinations", async () => {
  const controller = createSettingsController();
  for (const destination of Object.keys(HANDOFFS)) {
    const response = await controller.dispatch({ type: "request_handoff", destination });
    assert.equal(response.result.state, "approved_handoff_ready");
    assert.ok(!/[?&](?:token|key|auth)=/i.test(JSON.stringify(response.result.descriptor)));
  }
  assert.equal((await controller.dispatch({ type: "request_handoff", destination: "https://evil.invalid/?token=bad" })).result.code, "handoff_destination_rejected");
  assert.equal(safeExternalSettingsUrl("github_manage", HANDOFFS.github_manage), "https://github.com/settings/installations");
  assert.equal(safeExternalSettingsUrl("unknown", { url: "https://evil.invalid" }), null);
});

test("audit events record safe actor, action, resource and outcome without values", async () => {
  const controller = createSettingsController({ scenario: "no-integrations" });
  await controller.dispatch({ type: "create_secret", name: "FIXTURE_AUDIT_KEY", secretClass: "application_secret", value: "synthetic-audit-value" });
  await controller.dispatch({ type: "preview_database_change", changeId: "add-project-index" });
  const audit = controller.snapshot().audit;
  assert.ok(audit.some((item) => item.action === "secret_configured"));
  assert.ok(audit.some((item) => item.action === "database_change_proposed"));
  assert.ok(audit.every((item) => item.actorClassification && item.timestamp && item.resource && item.outcome && !Object.hasOwn(item, "value")));
  assert.ok(!JSON.stringify(audit).includes("synthetic-audit-value"));
});

test("storage presentation remains local-safe and never enables upload", async () => {
  const controller = createSettingsController();
  await controller.dispatch({ type: "set_project_context", project: { id: "local-1", name: "Local fixture", workspaceType: "local_git_repository", local: true, framework: "Vite", git: { dirty: true }, approximateBytes: 1234, importManifestBytes: 456 } });
  const state = controller.snapshot();
  assert.equal(state.storage.local.approximateBytes, 1234);
  assert.equal(state.storage.local.uploadState, "not_uploaded");
  assert.equal(state.storage.uploadEnabled, false);
  assert.equal(createSettingsController({ scenario: "storage-unavailable" }).snapshot().storage.fixtureCloud.state, "unavailable");
});

test("local project context contains safe metadata and never reads env files or uploads", async () => {
  const controller = createSettingsController({ scenario: "offline-local-project" });
  await controller.dispatch({ type: "set_project_context", project: { id: "local-2", name: "Offline local", workspaceType: "local_folder", local: true, framework: "Plain HTML", git: null } });
  const project = controller.snapshot().projectContext;
  assert.equal(project.environmentFilesRead, false);
  assert.equal(project.uploaded, false);
  assert.equal(controller.snapshot().offline, true);
});

test("D12 read-only adapter requires injected origin-relative routes and rejects every mutation", async () => {
  const calls = [];
  const adapter = createD12ReadOnlyAdapter({ transport: { async request(request) { calls.push(request); return { ok: true }; } }, routes: { settings: "/api/settings", environment: "/api/environment", secrets: "/api/secrets", database: "/api/database", integrations: "/api/integrations", audit: "/api/audit" } });
  await adapter.getSettings(); await adapter.getEnvironmentMetadata(); await adapter.listSecretMetadata(); await adapter.getDatabaseSummary(); await adapter.listIntegrations(); await adapter.listAuditEvents();
  assert.ok(calls.every((call) => call.method === "GET" && call.path.startsWith("/")));
  for (const operation of ["createSecret", "replaceSecret", "deleteSecret", "applyDatabaseChange", "connectIntegration"]) assert.equal((await adapter[operation]()).code, "capability_unavailable");
  assert.throws(() => createD12ReadOnlyAdapter({ transport: { request() {} }, routes: { settings: "https://app.thrallo.com/api/settings" } }), /origin-relative/);
});

test("D9-D11 navigation coexists with enabled D12 settings, database and integrations", async () => {
  const desktop = await createDesktopProductController({ client, localRegistry, settingsScenario: "stripe-webhook-failure" });
  for (const destination of ["settings", "database", "integrations", "preview", "deployments"]) {
    const response = await desktop.dispatch({ type: "navigate", destination });
    assert.equal(response.result.ok, true);
  }
  assert.ok(NAVIGATION_ITEMS.find((item) => item.id === "settings")?.enabled);
  assert.equal(desktop.snapshot().preview.boundaries.builderV2Mutation, "capability_unavailable");
  assert.equal(desktop.snapshot().deployment.boundaries.productionMutations, "capability_unavailable");
  assert.equal(desktop.snapshot().settings.boundaries.productionMutations, "capability_unavailable");
});

test("D12 view renders settings, secrets, Supabase, Stripe, GitHub and model providers accessibly", async () => {
  const desktop = await createDesktopProductController({ client, localRegistry, settingsScenario: "supabase-rls-warning" });
  await desktop.dispatch({ type: "navigate", destination: "settings" });
  let html = renderDesktopProductHtml(desktop.snapshot(), { nonce: "d12-test", cspSource: "vscode-webview://fixture" });
  for (const marker of ["Settings and integrations", "No live mutation path", "Project Environment", "Database / Supabase", "External Integrations", "Desktop / Local"]) assert.ok(html.includes(marker));
  assert.ok(html.includes("aria-label=\"Settings sections\"") && html.includes("aria-live=\"polite\"") && html.includes("prefers-reduced-motion"));
  await desktop.dispatch({ type: "settings_action", action: { type: "select_section", section: "secrets" } });
  html = renderDesktopProductHtml(desktop.snapshot(), { nonce: "d12-test", cspSource: "vscode-webview://fixture" });
  assert.ok(html.includes("type=\"password\"") && html.includes("autocomplete=\"new-password\"") && html.includes("value disappears"));
});

test("secret deletion and destructive database review have explicit accessible language", async () => {
  const desktop = await createDesktopProductController({ client, localRegistry, settingsScenario: "secret-configured" });
  await desktop.dispatch({ type: "navigate", destination: "settings" });
  await desktop.dispatch({ type: "settings_action", action: { type: "select_section", section: "secrets" } });
  await desktop.dispatch({ type: "settings_action", action: { type: "review_secret_delete", name: "FIXTURE_PROVIDER_KEY" } });
  let html = renderDesktopProductHtml(desktop.snapshot(), { nonce: "d12-dialog", cspSource: "vscode-webview://fixture" });
  assert.ok(html.includes("<dialog") && html.includes("Confirm fixture deletion") && html.includes("showModal()"));
  await desktop.dispatch({ type: "settings_action", action: { type: "select_section", section: "database" } });
  await desktop.dispatch({ type: "settings_action", action: { type: "preview_database_change", changeId: "remove-legacy-column" } });
  html = renderDesktopProductHtml(desktop.snapshot(), { nonce: "d12-dialog", cspSource: "vscode-webview://fixture" });
  assert.ok(html.includes("Data loss warning") && html.includes("Yes — destructive") && html.includes("Apply unavailable until Track B"));
});

test("Code OSS host and manifest register only typed D12 entry points", () => {
  const host = fs.readFileSync(hostPath, "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "editor/vscode/package.json"), "utf8"));
  assert.match(host, /settingsAction/);
  assert.match(host, /safeExternalSettingsUrl/);
  assert.ok(manifest.contributes.commands.some((item) => item.command === "thrallo.openThralloSettings"));
});

test("Code OSS host owns approved portal and external handoffs and rejects injection", async () => {
  const env = mockD12Host();
  const host = createDesktopProductHost({ ...env, localWorkspaceHost: env.localWorkspaceHost, client });
  await host.open("settings");
  assert.equal((await host.handleMessage({ type: "settingsHandoff", destination: "thrallo_billing" })).state, "system_browser_opened");
  assert.equal(env.calls.external[0], "https://app.thrallo.com/settings/billing");
  assert.equal((await host.handleMessage({ type: "settingsHandoff", destination: "github_manage" })).state, "system_browser_opened");
  assert.equal(env.calls.external[1], "https://github.com/settings/installations");
  const rejected = await host.handleMessage({ type: "settingsHandoff", destination: "https://evil.invalid/?token=synthetic" });
  assert.equal(rejected.code, "handoff_destination_rejected");
  assert.equal(env.calls.external.length, 2);
});

test("D12 source has no production network, SQL, OAuth callback, Builder V2 or Buildr101 fallback", () => {
  const source = [settingsPath, viewPath, hostPath].map((file) => fs.readFileSync(file, "utf8")).join("\n");
  for (const forbidden of ["projectSecrets.mjs", "environments.mjs", "saasPayments.mjs", "capabilityRuntime.mjs", "runtime-worker", "project_secrets", "project_integrations", "project_environments", "ownerConsole", "Meta connector"]) assert.ok(!source.includes(forbidden), forbidden);
  assert.ok(!/fetch\s*\(|XMLHttpRequest|WebSocket\s*\(|child_process|execute_sql|apply_migration|supabase\.from|stripe\.customers|octokit/i.test(fs.readFileSync(settingsPath, "utf8")));
  assert.ok(!/BuilderV2|builderV2/i.test(fs.readFileSync(settingsPath, "utf8").replace(/builderV2Mutation/g, "")));
});

test("D0 protected paths, Buildr101 denylist and fixture-network guard remain green", () => {
  const result = spawnSync(process.execPath, [path.join(root, "desktop/d0/guard.mjs")], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

function mockD12Host() {
  const calls = { external: [], panels: [] };
  const state = new Map();
  const stateStore = { get(key) { return state.get(key); }, async update(key, value) { state.set(key, value); } };
  const vscode = {
    ViewColumn: { One: 1 },
    Uri: { parse: (value) => ({ value, toString: () => value }), file: (fsPath) => ({ fsPath }) },
    env: { async openExternal(uri) { calls.external.push(uri.value); return true; }, clipboard: { async writeText() {} } },
    commands: { registerCommand() { return { dispose() {} }; }, async executeCommand() {} },
    window: {
      createWebviewPanel() { const panel = { webview: { html: "", cspSource: "vscode-webview://fixture", onDidReceiveMessage() { return { dispose() {} }; } }, reveal() {}, onDidDispose() { return { dispose() {} }; } }; calls.panels.push(panel); return panel; },
      showErrorMessage() {},
    },
  };
  const context = { extensionUri: { fsPath: path.join(root, "editor/vscode") }, workspaceState: stateStore, globalState: stateStore, subscriptions: [] };
  const localWorkspaceHost = { registry: localRegistry, async openWorkspaceById() {}, async openLocalFolder() {}, async openLocalGitRepository() {}, async reviewLocalImport() {}, async openLocalTerminal() {} };
  return { vscode, context, output: { appendLine() {} }, localWorkspaceHost, calls };
}
