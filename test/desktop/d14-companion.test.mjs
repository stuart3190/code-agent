import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import * as client from "../../shared/thrallo-client/src/index.mjs";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const foundationPath = path.join(root, "editor/vscode/lib/companionFoundation.js");
const viewPath = path.join(root, "editor/vscode/lib/companionView.js");
const hostPath = path.join(root, "editor/vscode/lib/desktopProductHost.js");
const {
  D14_SCENARIOS, PORTAL_ORIGIN, PORTAL_RESPONSIBILITIES, PORTAL_DESTINATIONS,
  COMPANION_NAVIGATION, ALLOWED_COMPANION_CAPABILITIES, EXCLUDED_COMPANION_CAPABILITIES,
  TABLET_PROFILES, getD14Scenario, createCompanionPortalHandoff, createReturnContext,
  companionCapability, createCompanionController,
} = require(foundationPath);
const { createDesktopProductController, NAVIGATION_ITEMS } = require(path.join(root, "editor/vscode/lib/desktopProduct.js"));
const { renderDesktopProductHtml } = require(path.join(root, "editor/vscode/lib/desktopProductView.js"));
const { createDesktopProductHost } = require(hostPath);

const localRegistry = Object.freeze({ async recent() { return Object.freeze([]); }, async recordPreview() { return null; } });
const requiredScenarios = [
  "first-companion-launch", "signed-out", "active-paid-account", "offline-cached-state", "project-idle",
  "build-running", "waiting-plan-approval", "plan-approved", "plan-rejected", "build-failed",
  "build-recovered", "agent-failed", "parallel-agent-activity", "preview-healthy", "preview-unavailable",
  "deployment-healthy", "deployment-failed", "update-available", "rollback-review", "unpublish-review",
  "domain-unhealthy", "usage-80", "usage-90", "usage-exhausted", "billing-recovery",
  "integration-degraded", "alert-unread", "alert-read", "unsupported-editor-action",
  "unsupported-terminal-action", "unsupported-secret-action", "future-cloud-launch-unavailable",
];

test("portal and desktop responsibilities are explicit, complete and disjoint", () => {
  for (const responsibility of ["signup", "login_recovery_authority", "subscription_purchase_change", "billing_recovery", "invoices", "account_management", "api_key_token_management", "browser_account_authorization", "desktop_downloads", "device_session_management", "cloud_workspace_launch_recovery_entry"]) assert.ok(PORTAL_RESPONSIBILITIES.portal.includes(responsibility));
  for (const responsibility of ["project_workbench", "conversation", "local_workspace", "editor_files", "agents", "preview_testing", "deployments_presentation", "integrations_presentation", "local_settings", "model_usage_summaries"]) assert.ok(PORTAL_RESPONSIBILITIES.desktop.includes(responsibility));
  assert.deepEqual(PORTAL_RESPONSIBILITIES.portal.filter((item) => PORTAL_RESPONSIBILITIES.desktop.includes(item)), []);
});

test("portal handoff uses a fixed allowlist, records calls and fails closed", async () => {
  const opened = [];
  const handoff = createCompanionPortalHandoff({ openExternal: async (url) => opened.push(url) });
  const billing = await handoff.open("billing");
  assert.equal(billing.ok, true);
  assert.equal(billing.url, `${PORTAL_ORIGIN}/settings/billing`);
  assert.equal(opened[0], `${PORTAL_ORIGIN}/settings/billing`);
  assert.equal((await handoff.open("devices_sessions")).code, "integration_pending");
  assert.equal((await handoff.open("cloud_workspace_launch")).code, "integration_pending");
  assert.equal((await handoff.open("https://evil.invalid/?token=fake")).code, "portal_destination_rejected");
  assert.equal(opened.length, 1);
  assert.equal(handoff.getCalls().length, 4);
  for (const item of Object.values(PORTAL_DESTINATIONS)) assert.ok(item.path === null || (item.path.startsWith("/") && !item.path.startsWith("//")));
  assert.ok(!JSON.stringify(handoff.getCalls()).match(/bearer|token=|secret=/i));
});

test("return-to-desktop context permits metadata only and rejects auth material", () => {
  const safe = createReturnContext({ actionType: "integration_completed", projectReference: "fixture-project-0001", destinationView: "activity", integrationCompletionState: "connected" });
  assert.equal(safe.ok, true);
  assert.equal(safe.context.authorizationMaterial, null);
  for (const input of [
    { actionType: "integration_completed", destinationView: "activity", token: "fake" },
    { actionType: "integration_completed", destinationView: "activity", recoveryReason: "token=fake" },
    { actionType: "integration_completed", destinationView: "activity", projectReference: "https://evil.invalid" },
    { actionType: "unknown", destinationView: "activity" },
  ]) assert.equal(createReturnContext(input).code, "return_context_rejected");
});

test("companion profile includes monitoring controls and explicitly excludes technical surfaces", () => {
  for (const capability of ["view_projects", "view_build_run", "send_simple_instruction", "review_typed_plan", "view_preview", "view_deployments", "view_usage_budget", "view_alerts"]) assert.ok(ALLOWED_COMPANION_CAPABILITIES.includes(capability));
  for (const capability of ["source_code_editing", "terminal", "secret_management", "raw_environment_editing", "database_schema_mutation", "unrestricted_git", "arbitrary_browser", "cloud_infrastructure_admin"]) assert.equal(companionCapability(capability).availability, "capability_unavailable");
  assert.equal(TABLET_PROFILES.companion_touch.state, "fixture_verified");
  assert.equal(TABLET_PROFILES.reduced_workbench_keyboard_pointer.state, "qualification_pending");
  assert.equal(TABLET_PROFILES.reduced_workbench_keyboard_pointer.realDeviceVerified, false);
});

test("companion navigation is deliberately smaller than Code OSS and desktop settings", () => {
  assert.deepEqual(COMPANION_NAVIGATION.map((item) => item.id), ["home", "projects", "activity", "preview", "deployments", "usage", "account"]);
  for (const excluded of ["explorer", "terminal", "secrets", "database", "settings", "source_control"]) assert.ok(!COMPANION_NAVIGATION.some((item) => item.id === excluded));
});

test("D14 scenario catalogue exactly covers the approved deterministic matrix", () => {
  assert.deepEqual(D14_SCENARIOS, requiredScenarios);
  for (const name of requiredScenarios) assert.equal(getD14Scenario(name).name, name);
});

test("every D14 scenario composes existing D9-D12 fixture contracts", async () => {
  for (const name of requiredScenarios) {
    const desktop = await createDesktopFor(name);
    const state = desktop.snapshot().companion;
    assert.equal(state.scenario, name);
    assert.deepEqual(state.sourceRefs, ["D3_ACCOUNT_ENTITLEMENT", "D9_PLAN_DECISIONS", "D9_AGENT_STATES", "D9_BUILD_STATES", "D10_PREVIEW_STATES", "D11_DEPLOYMENT_STATES", "D12_INTEGRATION_STATES"]);
    assert.equal(state.boundaries.builderV2Mutation, "capability_unavailable");
  }
});

test("identical seeds produce identical companion state and delegated call records", async () => {
  const first = await createDesktopFor("waiting-plan-approval", "same-seed");
  const second = await createDesktopFor("waiting-plan-approval", "same-seed");
  const planId = first.snapshot().companion.plan.id;
  await first.dispatch({ type: "companion_action", action: { type: "plan_decision", planId, decision: "request_changes", confirmed: true, comment: "Keep it fixture-only" } });
  await second.dispatch({ type: "companion_action", action: { type: "plan_decision", planId, decision: "request_changes", confirmed: true, comment: "Keep it fixture-only" } });
  assert.deepEqual(first.snapshot().companion, second.snapshot().companion);
  assert.deepEqual(first.getCalls().companion, second.getCalls().companion);
  assert.deepEqual(first.getCalls().actions, second.getCalls().actions);
});

test("shared presentation preserves owning D9-D12 identities instead of cloning business logic", async () => {
  const desktop = await createDesktopFor("update-available");
  const state = desktop.snapshot();
  assert.equal(state.companion.plan.id, state.plan.id);
  assert.equal(state.companion.build.state, state.build.state);
  assert.equal(state.companion.agents[0].id, state.agents[0].id);
  assert.equal(state.companion.preview.state, state.preview.preview.state);
  assert.equal(state.companion.deployment.publishing.state, state.deployment.publishing.state);
  assert.equal(state.companion.usage.observedAt, state.access.usage.observedAt);
  assert.equal(state.companion.integrations.sourceContract, "D12_INTEGRATION_STATES");
});

test("simple instruction composer delegates to D9 fixture conversation and stores no text in D14 calls", async () => {
  const desktop = await createDesktopFor("active-paid-account");
  const before = desktop.snapshot().conversation.messages.length;
  const response = await desktop.dispatch({ type: "companion_action", action: { type: "send_instruction", text: "Make the fixture heading clearer" } });
  assert.equal(response.result.state, "sent");
  assert.equal(response.state.conversation.messages.length, before + 2);
  assert.equal(response.state.companion.composer.state, "sent");
  const serialized = JSON.stringify(desktop.getCalls().companion);
  assert.ok(!serialized.includes("Make the fixture heading clearer"));
  assert.match(serialized, /textLength/);
});

test("instruction composer rejects secret-shaped content without delegation", async () => {
  const desktop = await createDesktopFor("active-paid-account");
  const before = desktop.getCalls().actions.length;
  const response = await desktop.dispatch({ type: "companion_action", action: { type: "send_instruction", text: "api_key=sk_fixture_not_real_123456" } });
  assert.equal(response.result.code, "secret_content_rejected");
  assert.equal(desktop.getCalls().actions.length, before);
  assert.ok(!JSON.stringify(desktop.snapshot()).includes("sk_fixture_not_real_123456"));
});

test("typed plan decisions require explicit confirmation and reuse D9 semantics", async () => {
  const desktop = await createDesktopFor("waiting-plan-approval");
  const planId = desktop.snapshot().companion.plan.id;
  assert.equal((await desktop.dispatch({ type: "companion_action", action: { type: "plan_decision", planId, decision: "approve" } })).result.code, "explicit_typed_confirmation_required");
  const approved = await desktop.dispatch({ type: "companion_action", action: { type: "plan_decision", planId, decision: "approve", confirmed: true } });
  assert.equal(approved.result.state, "approved");
  assert.equal(approved.state.plan.status, "approved");
  assert.equal(approved.state.companion.plan.status, "approved");
  assert.equal(desktop.getCalls().actions.at(-1).operation, "decidePlan");
});

test("agent controls delegate only when the D9 control is enabled", async () => {
  const desktop = await createDesktopFor("parallel-agent-activity");
  const agent = desktop.snapshot().companion.agents.find((item) => item.controls.some((control) => control.enabled && control.id !== "inspect")) || desktop.snapshot().companion.agents[0];
  const control = agent.controls.find((item) => item.enabled)?.id;
  const result = await desktop.dispatch({ type: "companion_action", action: { type: "agent_control", agentId: agent.id, control } });
  assert.equal(result.result.ok, true);
  assert.ok(desktop.getCalls().actions.some((call) => call.operation === "controlAgent") || control === "inspect");
});

test("offline and stale companion state cannot authorize fresh controls", async () => {
  for (const scenario of ["offline-cached-state"]) {
    const desktop = await createDesktopFor(scenario);
    const state = desktop.snapshot().companion;
    const response = await desktop.dispatch({ type: "companion_action", action: { type: "send_instruction", text: "Fixture instruction" } });
    assert.equal(response.result.code, "fresh_capability_required");
    assert.equal(state.connection.actionsRequireFreshState, true);
  }
  const stale = await createDesktopFor("active-paid-account");
  const shared = stale.snapshot();
  const synthetic = createCompanionController({ getSharedState: () => ({ ...shared, access: { ...shared.access, usage: { ...shared.access.usage, freshness: "stale" } } }), dispatchShared: async () => ({ ok: true }), scenario: "active-paid-account" });
  assert.equal((await synthetic.dispatch({ type: "send_instruction", text: "Do it" })).result.code, "fresh_capability_required");
});

test("alerts derive from shared plan, build, deployment, domain, usage, recovery and integration state", async () => {
  const cases = [["waiting-plan-approval", "plan-waiting"], ["build-failed", "build-failed"], ["build-recovered", "build-recovered"], ["deployment-failed", "deployment-failed"], ["domain-unhealthy", "domain-unhealthy"], ["usage-exhausted", "usage-exhausted"], ["billing-recovery", "billing-recovery"], ["integration-degraded", "integration-supabase"]];
  for (const [scenario, alertId] of cases) assert.ok((await createDesktopFor(scenario)).snapshot().companion.alerts.some((item) => item.id === alertId), `${scenario}:${alertId}`);
  const usage80 = (await createDesktopFor("usage-80")).snapshot().companion.alerts.filter((item) => item.id.startsWith("usage-"));
  const usage90 = (await createDesktopFor("usage-90")).snapshot().companion.alerts.filter((item) => item.id.startsWith("usage-"));
  assert.ok(usage80.every((item) => item.id.endsWith("-80")) && new Set(usage80.map((item) => item.id)).size === usage80.length);
  assert.ok(usage90.every((item) => item.id.endsWith("-90")) && new Set(usage90.map((item) => item.id)).size === usage90.length);
  const desktop = await createDesktopFor("alert-unread");
  const alert = desktop.snapshot().companion.alerts.find((item) => item.id === "fixture-general-attention");
  assert.equal(alert.read, false);
  await desktop.dispatch({ type: "companion_action", action: { type: "mark_alert_read", alertId: alert.id } });
  assert.equal(desktop.snapshot().companion.alerts.find((item) => item.id === alert.id).read, true);
});

test("high-impact deployment actions require confirmation and remain fixture delegated", async () => {
  const desktop = await createDesktopFor("rollback-review");
  const review = await desktop.dispatch({ type: "companion_action", action: { type: "deployment_action", operation: "review_action", actionId: "rollback" } });
  assert.equal(review.result.state, "action_review_ready");
  assert.equal(review.state.companion.deployment.pendingReview.actionId, "rollback");
  const rejected = await desktop.dispatch({ type: "companion_action", action: { type: "deployment_action", operation: "confirm_action", actionId: "rollback" } });
  assert.equal(rejected.result.code, "explicit_confirmation_required");
  const confirmed = await desktop.dispatch({ type: "companion_action", action: { type: "deployment_action", operation: "confirm_action", actionId: "rollback", confirmed: true } });
  assert.equal(confirmed.result.ok, true);
  assert.equal(confirmed.result.source, "deterministic_fixture");
});

test("unsupported editor, terminal, secret and cloud requests remain visible and fail closed", async () => {
  const scenarioCapabilities = [["unsupported-editor-action", "source_code_editing"], ["unsupported-terminal-action", "terminal"], ["unsupported-secret-action", "secret_management"]];
  for (const [scenario, capability] of scenarioCapabilities) {
    const desktop = await createDesktopFor(scenario);
    assert.equal(desktop.snapshot().companion.scenarioResult.capability, capability);
    const response = await desktop.dispatch({ type: "companion_action", action: { type: "request_capability", capability } });
    assert.equal(response.result.availability, "capability_unavailable");
    assert.ok(response.result.explanation);
  }
  const desktop = await createDesktopFor("future-cloud-launch-unavailable");
  assert.equal(desktop.snapshot().companion.scenarioResult.code, "integration_pending");
  assert.equal((await desktop.dispatch({ type: "companion_action", action: { type: "future_cloud_launch" } })).result.code, "integration_pending");
});

test("preview and deployment companion summaries stay bounded", async () => {
  const desktop = await createDesktopFor("preview-healthy");
  const state = desktop.snapshot().companion;
  assert.equal(state.preview.sourceContract, "D10_PREVIEW_STATES");
  assert.deepEqual(Object.keys(state.preview.diagnostics).sort(), ["available", "console", "network", "runtime"]);
  assert.equal(state.deployment.sourceContract, "D11_DEPLOYMENT_STATES");
  assert.ok(!Object.hasOwn(state.preview, "consoleItems"));
  assert.ok(!Object.hasOwn(state.deployment, "logItems"));
});

test("responsive companion view renders real desktop state with accessible touch controls", async () => {
  const desktop = await createDesktopFor("waiting-plan-approval");
  await desktop.dispatch({ type: "navigate", destination: "companion" });
  const html = renderDesktopProductHtml(desktop.snapshot(), { nonce: "d14-test", cspSource: "vscode-webview://fixture" });
  for (const marker of ["Thrallo Companion", "Typed plan review", "data-profile=\"companion_touch\"", "aria-live=\"polite\"", "data-companion-plan=\"approve\""]) assert.ok(html.includes(marker), marker);
  await desktop.dispatch({ type: "companion_action", action: { type: "navigate", destination: "home" } });
  const home = renderDesktopProductHtml(desktop.snapshot(), { nonce: "d14-home", cspSource: "vscode-webview://fixture" });
  assert.ok(home.includes("What needs you"));
  for (const query of ["max-width:1024px", "max-width:820px", "max-width:480px", "max-width:600px", "orientation:portrait", "orientation:landscape", "--touch:44px", "prefers-reduced-motion:reduce", "focus-visible"]) assert.ok(html.includes(query), query);
  assert.ok(!html.includes("data-companion-nav=\"terminal\"") && !html.includes("data-companion-nav=\"secrets\""));
});

test("representative companion screens render without horizontal product duplication", async () => {
  const cases = ["first-companion-launch", "build-running", "build-failed", "parallel-agent-activity", "preview-healthy", "deployment-healthy", "usage-90", "billing-recovery"];
  for (const scenario of cases) {
    const desktop = await createDesktopFor(scenario);
    await desktop.dispatch({ type: "navigate", destination: "companion" });
    const html = renderDesktopProductHtml(desktop.snapshot(), { nonce: `d14-${scenario}`, cspSource: "vscode-webview://fixture" });
    assert.match(html, /data-profile="companion_touch"/);
    assert.ok(!html.includes("Full mobile workbench"));
  }
});

test("Code OSS host owns D14 portal opening and typed companion messages", async () => {
  const env = mockHost();
  const host = createDesktopProductHost({ ...env, client, companionScenario: "active-paid-account" });
  await host.open("companion");
  const result = await host.handleMessage({ type: "companionPortal", destination: "billing" });
  assert.equal(result.state, "system_browser_opened");
  assert.equal(env.calls.external[0], `${PORTAL_ORIGIN}/settings/billing`);
  const rejected = await host.handleMessage({ type: "companionPortal", destination: "https://evil.invalid/?token=fake" });
  assert.equal(rejected.code, "portal_destination_rejected");
  assert.equal(env.calls.external.length, 1);
  const navigation = await host.handleMessage({ type: "companionAction", action: { type: "navigate", destination: "activity" } });
  assert.equal(navigation.state, "selected");
});

test("Code OSS manifest registers D14 as one extension-driven workbench surface", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "editor/vscode/package.json"), "utf8"));
  assert.ok(manifest.contributes.commands.some((item) => item.command === "thrallo.openCompanion"));
  assert.ok(NAVIGATION_ITEMS.some((item) => item.id === "companion" && item.kind === "thrallo" && item.package === "D14"));
  assert.match(fs.readFileSync(hostPath, "utf8"), /companionAction/);
});

test("D14 has no network, production mutation, Builder V2, push, mobile runtime or Buildr101 fallback", () => {
  const source = [foundationPath, viewPath].map((file) => fs.readFileSync(file, "utf8")).join("\n");
  assert.ok(!/fetch\s*\(|XMLHttpRequest|WebSocket\s*\(|https\.request|child_process|supabase\.from|stripe\.|octokit|pushManager|serviceWorker\.register/i.test(source));
  for (const forbidden of ["project_secrets", "project_integrations", "project_environments", "ownerConsole", "saasPayments", "metaConnector", "capabilityRuntime", "Buildr101"]) assert.ok(!source.includes(forbidden), forbidden);
  assert.ok(!/builderV2(?!Mutation)/i.test(source));
  assert.ok(!/POST|PATCH|PUT|DELETE/.test(source));
});

test("D0 protected-path, Buildr101 and fixture-network guards remain green", () => {
  const result = spawnSync(process.execPath, [path.join(root, "desktop/d0/guard.mjs")], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

async function createDesktopFor(name, seed = "d14-test-seed") {
  const definition = getD14Scenario(name);
  return createDesktopProductController({ client, localRegistry, seed, scenario: definition.desktop, previewScenario: definition.preview, deploymentScenario: definition.deployment, settingsScenario: definition.settings, companionScenario: name });
}

function mockHost() {
  const calls = { external: [], panels: [] };
  const values = new Map();
  const store = { get(key) { return values.get(key); }, async update(key, value) { values.set(key, value); } };
  const vscode = {
    ViewColumn: { One: 1 },
    Uri: { parse: (value) => ({ value, toString: () => value }), file: (fsPath) => ({ fsPath }) },
    env: { async openExternal(uri) { calls.external.push(uri.value); return true; }, clipboard: { async writeText() {} } },
    commands: { registerCommand() { return { dispose() {} }; }, async executeCommand() {} },
    window: { createWebviewPanel() { const panel = { webview: { html: "", cspSource: "vscode-webview://fixture", onDidReceiveMessage() { return { dispose() {} }; } }, reveal() {}, onDidDispose() { return { dispose() {} }; } }; calls.panels.push(panel); return panel; }, showErrorMessage() {} },
  };
  const context = { extensionUri: { fsPath: path.join(root, "editor/vscode") }, workspaceState: store, globalState: store, subscriptions: [] };
  const localWorkspaceHost = { registry: localRegistry, async openWorkspaceById() {}, async openLocalFolder() {}, async openLocalGitRepository() {}, async reviewLocalImport() {}, async openLocalTerminal() {} };
  return { vscode, context, output: { appendLine() {} }, localWorkspaceHost, calls };
}
