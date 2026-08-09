import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

import * as client from "../../shared/thrallo-client/src/index.mjs";
import { runGuard } from "../../desktop/d0/guard.mjs";
import { createD8Project } from "./d8-fixtures.mjs";

const require = createRequire(import.meta.url);
const { LocalWorkspaceRegistry } = require("../../editor/vscode/lib/localWorkspace.js");
const { createLocalWorkspaceHost } = require("../../editor/vscode/lib/localWorkspaceHost.js");
const { BUILD_STATES, NAVIGATION_ITEMS, createBuildPresentation, createDesktopProductController } = require("../../editor/vscode/lib/desktopProduct.js");
const { D9_SCENARIOS } = require("../../editor/vscode/lib/desktopProductFixtures.js");
const { renderDesktopProductHtml } = require("../../editor/vscode/lib/desktopProductView.js");
const { createDesktopProductHost, loadSharedClient } = require("../../editor/vscode/lib/desktopProductHost.js");

const FIXED_NOW = () => new Date("2032-08-09T14:00:00.000Z");

test("D9 scenario catalogue covers every required deterministic product state", () => {
  for (const scenario of [
    "first-launch", "signed-out", "authenticated-free", "authenticated-paid", "recent-local-workspace",
    "fixture-thrallo-project", "idle-conversation", "active-build-run", "waiting-plan-approval",
    "approved-plan", "requested-changes", "failed-build", "recovering-build", "parallel-fixture-agents",
    "canceled-agent", "budget-80", "budget-90", "exhausted-budget", "model-unavailable",
    "offline-local-project", "stale-entitlement-usage", "future-cloud-unavailable",
  ]) assert.ok(D9_SCENARIOS.includes(scenario), scenario);
  assert.equal(new Set(D9_SCENARIOS).size, D9_SCENARIOS.length);
});

test("home state composes D2 auth, D3 entitlement/usage, D1 projects/runs, and D8 recents", async (t) => {
  const setup = await createController("authenticated-paid", { localScenario: "clean-vite-react" });
  t.after(setup.cleanup);
  const state = setup.controller.snapshot();
  assert.equal(state.home.brand, "Thrallo");
  assert.equal(state.access.account.session.state, "authenticated");
  assert.equal(state.access.entitlement.state, "active_paid");
  assert.ok(state.projects.items.some((item) => item.workspaceType === "local_git_repository"));
  assert.ok(state.projects.items.some((item) => item.workspaceType === "fixture_thrallo_project"));
  assert.equal(state.integration.builderV2Mutation, "capability_unavailable");
  assert.equal(state.source, "fixture");
});

test("signed-out and first-launch homes stay useful for local work", async () => {
  for (const scenario of ["first-launch", "signed-out"]) {
    const setup = await createController(scenario);
    const state = setup.controller.snapshot();
    assert.equal(state.access.account.identity, null);
    assert.equal(state.access.capabilities.localWorkspace.availability, "available");
    assert.equal(state.home.fixtureOnly, true);
  }
});

test("project launcher distinguishes local, Git, imported, fixture Thrallo, and future cloud sources", async (t) => {
  const local = createD8Project("clean-vite-react");
  const imported = createD8Project("plain-html");
  t.after(() => { local.cleanup(); imported.cleanup(); });
  const stateStore = memoryState();
  const registry = new LocalWorkspaceRegistry({ state: stateStore, now: FIXED_NOW });
  await registry.open(local.root);
  await registry.open(imported.root, { mode: "imported_local_project" });
  const controller = await createDesktopProductController({ client, localRegistry: registry, stateStore, scenario: "recent-local-workspace" });
  const items = controller.snapshot().projects.items;
  assert.equal(items.find((item) => item.id.startsWith("local_") && item.name === "project" && item.workspaceType === "imported_local_project")?.local, true);
  assert.ok(items.some((item) => item.workspaceType === "local_git_repository" && item.git.detected));
  assert.ok(items.some((item) => item.workspaceType === "fixture_thrallo_project" && item.deploymentState));
  assert.equal(items.find((item) => item.workspaceType === "future_cloud_workspace").availability, "integration_pending");
});

test("navigation preserves all advanced Code OSS tools and fails closed for future entries", async () => {
  const setup = await createController("authenticated-paid");
  const ids = NAVIGATION_ITEMS.map((item) => item.id);
  for (const id of ["home", "conversation", "projects", "agents", "usage", "explorer", "search", "source_control", "terminal"]) assert.ok(ids.includes(id));
  assert.equal((await setup.controller.dispatch({ type: "navigate", destination: "projects" })).state.navigation.current, "projects");
  const cloud = await setup.controller.dispatch({ type: "navigate", destination: "cloud_workspace" });
  assert.equal(cloud.result.code, "capability_unavailable");
  assert.equal(cloud.result.sideEffects, false);
});

test("conversation messages cannot implicitly approve a typed fixture plan", async () => {
  const setup = await createController("waiting-plan-approval");
  const before = setup.controller.snapshot();
  assert.equal(before.plan.status, "pending");
  await setup.controller.dispatch({ type: "send_message", text: "I approve this plan" });
  assert.equal(setup.controller.snapshot().plan.status, "pending");
  assert.equal(setup.controller.getCalls().actions.at(-1).operation, "recordConversation");
  assert.equal(setup.controller.getCalls().actions.at(-1).input.textLength, 19);
});

test("typed plan approval is explicit, fixture-only, and moves the run to queued", async () => {
  const setup = await createController("waiting-plan-approval");
  const planId = setup.controller.snapshot().plan.id;
  const response = await setup.controller.dispatch({ type: "plan_decision", planId, decision: "approve", comment: "Proceed with the fixture." });
  assert.equal(response.result.state, "approved");
  assert.equal(response.state.plan.decisionSource, "explicit_typed_fixture_action");
  assert.equal(response.state.build.state, "queued");
  const call = setup.controller.getCalls().actions.at(-1);
  assert.equal(call.operation, "decidePlan");
  assert.equal(call.input.source, "explicit_typed_fixture_action");
  assert.equal(call.input.commentLength, 25);
});

test("plan request-changes, reject, expiry, and unavailable states are distinct", async () => {
  for (const [decision, expected] of [["request_changes", "changes_requested"], ["reject", "rejected"]]) {
    const setup = await createController("waiting-plan-approval");
    const result = await setup.controller.dispatch({ type: "plan_decision", planId: setup.controller.snapshot().plan.id, decision, comment: "Fixture review" });
    assert.equal(result.state.plan.status, expected);
  }
  for (const scenario of ["plan-expired", "capability-unavailable"]) {
    const setup = await createController(scenario);
    const beforeCalls = setup.controller.getCalls().actions.length;
    const result = await setup.controller.dispatch({ type: "plan_decision", planId: setup.controller.snapshot().plan.id, decision: "approve" });
    assert.equal(result.result.ok, false);
    assert.equal(setup.controller.getCalls().actions.length, beforeCalls);
  }
});

test("parallel, canceled, failed, and recovering agent controls expose honest availability", async () => {
  const parallel = await createController("parallel-fixture-agents");
  assert.equal(parallel.controller.snapshot().agents.filter((agent) => agent.status === "running").length, 2);
  const lead = parallel.controller.snapshot().agents[0];
  const canceled = await parallel.controller.dispatch({ type: "agent_control", agentId: lead.id, control: "cancel" });
  assert.equal(canceled.state.agents[0].status, "canceled");

  const retrySetup = await createController("canceled-agent");
  const retryAgent = retrySetup.controller.snapshot().agents[0];
  assert.ok(retryAgent.controls.some((control) => control.id === "retry" && control.enabled));
  assert.equal((await retrySetup.controller.dispatch({ type: "agent_control", agentId: retryAgent.id, control: "retry" })).state.agents[0].status, "queued");

  const unavailable = await createController("capability-unavailable");
  assert.ok(unavailable.controller.snapshot().agents.every((agent) => agent.controls.filter((control) => control.id !== "inspect").every((control) => !control.enabled)));

  const failed = await createController("failed-build");
  assert.equal(failed.controller.snapshot().agents[0].status, "failed");
  assert.ok(failed.controller.snapshot().agents[0].controls.some((control) => control.id === "retry"));
  const recovering = await createController("recovering-build");
  assert.equal(recovering.controller.snapshot().agents[0].status, "recovered");
  assert.ok(recovering.controller.snapshot().agents[0].controls.some((control) => control.id === "resume"));
  const waiting = await createController("waiting-plan-approval");
  assert.equal(waiting.controller.snapshot().agents[0].status, "waiting_approval");
  const succeeded = await createController("approved-plan");
  assert.equal(succeeded.controller.snapshot().agents[0].status, "success");
});

test("model selector uses configured fixture models, explicit selection, fallback, and D3 budget gating", async () => {
  const paid = await createController("authenticated-paid");
  assert.ok(paid.controller.snapshot().models.items.some((model) => model.id === "auto"));
  assert.ok(paid.controller.snapshot().models.items.every((model) => !/\$|per token|gpt-|claude-/i.test(model.detail)));
  assert.ok(paid.controller.snapshot().models.items.filter((model) => model.id !== "auto").every((model) => model.classification === "unknown_fixture"));
  assert.equal((await paid.controller.dispatch({ type: "select_model", modelId: "fixture-deep" })).state.models.selected, "fixture-deep");

  const unavailable = await createController("model-unavailable");
  assert.equal(unavailable.controller.snapshot().models.items.find((model) => model.id === "fixture-deep").available, false);
  assert.equal((await unavailable.controller.dispatch({ type: "select_model", modelId: "fixture-deep" })).result.code, "capability_unavailable");

  const exhausted = await createController("exhausted-budget");
  assert.equal(exhausted.controller.snapshot().access.capabilities.managedAi.availability, "unavailable");
  assert.equal((await exhausted.controller.dispatch({ type: "select_model", modelId: "fixture-balanced" })).result.ok, false);
});

test("D3 usage presentation covers normal, 80, 90, exhausted, stale, and unavailable data", async () => {
  const cases = [
    ["authenticated-paid", "normal"], ["budget-80", "warning_80"], ["budget-90", "warning_90"],
    ["exhausted-budget", "exhausted"], ["stale-entitlement-usage", "normal"],
  ];
  for (const [scenario, expected] of cases) {
    const setup = await createController(scenario);
    assert.equal(setup.controller.snapshot().access.usage.resources.aiModel.state, expected);
  }
  const unavailableFixture = client.createDesktopAccessFixture({ scenario: "usage-unavailable", seed: "d9-usage-unavailable" });
  const access = client.composeDesktopAccessState({
    authSnapshot: unavailableFixture.authSnapshot,
    hostCapabilities: unavailableFixture.hostCapabilities,
    accountResult: await unavailableFixture.provider.getAccount(),
    entitlementResult: await unavailableFixture.provider.getEntitlements(),
    usageResult: await unavailableFixture.provider.getUsage(),
  });
  assert.equal(access.usage.resources.aiModel.state, "unavailable");
});

test("all D9 builder/run presentation states are explicit and bounded", () => {
  assert.deepEqual(BUILD_STATES, ["not_started", "planning", "waiting_approval", "queued", "running", "verifying", "repairing", "completed", "failed", "canceled", "recovering", "capability_unavailable"]);
  for (const state of BUILD_STATES) {
    const presentation = createBuildPresentation(state);
    assert.equal(presentation.state, state);
    assert.ok(presentation.progress >= 0 && presentation.progress <= 100);
    assert.ok(presentation.label);
  }
});

test("conversation presentation carries progress, warning, failure, recovery, cancellation, completion, and unavailable events", async () => {
  const expected = [
    ["active-build-run", "progress"], ["budget-90", "warning"], ["failed-build", "failure"],
    ["recovering-build", "recovery"], ["canceled-agent", "cancellation"], ["completed-build", "completion"],
    ["capability-unavailable", "capability_unavailable"],
  ];
  for (const [scenario, state] of expected) {
    const setup = await createController(scenario);
    assert.ok(setup.controller.snapshot().conversation.messages.some((item) => item.state === state), `${scenario}:${state}`);
  }
});

test("offline and stale states retain local capability while managed actions fail honestly", async () => {
  const offline = await createController("offline-local-project");
  assert.equal(offline.controller.snapshot().access.account.session.state, "offline");
  assert.equal(offline.controller.snapshot().access.capabilities.localWorkspace.availability, "available");
  assert.ok(offline.controller.snapshot().notices.some((notice) => notice.id === "offline"));
  const stale = await createController("stale-entitlement-usage");
  assert.equal(stale.controller.snapshot().access.usage.freshness, "stale");
  assert.ok(stale.controller.snapshot().notices.some((notice) => notice.id === "stale-access"));
});

test("rendered home, launcher, conversation, plan, agents, models, usage, and run state are Thrallo-native", async (t) => {
  const setup = await createController("waiting-plan-approval", { localScenario: "clean-vite-react" });
  t.after(setup.cleanup);
  for (const destination of ["home", "projects", "conversation", "agents", "usage"]) {
    await setup.controller.dispatch({ type: "navigate", destination });
    const html = renderDesktopProductHtml(setup.controller.snapshot(), { nonce: "fixture-nonce", cspSource: "vscode-webview://fixture" });
    assert.match(html, /Thrallo Desktop|Thrallo/);
    assert.match(html, new RegExp(destination === "conversation" ? "Typed plan approval" : destination === "agents" ? "Activity and control" : destination === "usage" ? "Usage and budget" : destination === "projects" ? "Project launcher" : "Build software with Thrallo"));
    assert.doesNotMatch(html, /window\.__THRALLO_DESKTOP__|media\/app|app\.thrallo\.com/);
  }
});

test("D9 webview meets keyboard, screen-reader, focus, reduced-motion, zoom/reflow, and non-color state basics", async () => {
  const setup = await createController("waiting-plan-approval");
  await setup.controller.dispatch({ type: "navigate", destination: "conversation" });
  const html = renderDesktopProductHtml(setup.controller.snapshot(), { nonce: "accessibility-nonce", cspSource: "vscode-webview://fixture" });
  for (const pattern of [/<html lang="en">/, /class="skip-link"/, /<main id="main" tabindex="-1">/, /aria-label="Thrallo navigation"/, /role="log"/, /aria-live="polite"/, /aria-label="Plan decision controls"/, /:focus-visible/, /prefers-reduced-motion:reduce/, /@media\(max-width:650px\)/, /role="progressbar"/]) assert.match(html, pattern);
  assert.doesNotMatch(html, /onclick=|onchange=/i);
  assert.match(html, /Waiting for approval/i);
  assert.match(html, /Chat messages never approve plans/);
});

test("all fixture and local values are escaped before entering the webview", async () => {
  const setup = await createController("authenticated-paid");
  const unsafe = JSON.parse(JSON.stringify(setup.controller.snapshot()));
  unsafe.projects.items[0].name = `<img src=x onerror="alert(1)">`;
  const html = renderDesktopProductHtml(unsafe, { nonce: "escape-nonce", cspSource: "vscode-webview://fixture" });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});

test("identical seeds produce identical UI states, transitions, and call evidence", async () => {
  const first = await createController("waiting-plan-approval", { seed: "repeatable-d9" });
  const second = await createController("waiting-plan-approval", { seed: "repeatable-d9" });
  assert.deepEqual(first.controller.snapshot(), second.controller.snapshot());
  for (const controller of [first.controller, second.controller]) {
    await controller.dispatch({ type: "send_message", text: "Deterministic fixture instruction" });
    await controller.dispatch({ type: "plan_decision", planId: controller.snapshot().plan.id, decision: "request_changes", comment: "Same fixture note" });
  }
  assert.deepEqual(first.controller.snapshot(), second.controller.snapshot());
  assert.deepEqual(first.controller.getCalls(), second.controller.getCalls());
});

test("workbench state restores only matching D9 scenario/seed metadata", async () => {
  const stateStore = memoryState();
  const registry = new LocalWorkspaceRegistry({ state: memoryState(), now: FIXED_NOW });
  const first = await createDesktopProductController({ client, localRegistry: registry, stateStore, scenario: "waiting-plan-approval", seed: "restart-d9" });
  await first.dispatch({ type: "navigate", destination: "usage" });
  await first.dispatch({ type: "select_model", modelId: "fixture-deep" });
  const restarted = await createDesktopProductController({ client, localRegistry: registry, stateStore, scenario: "waiting-plan-approval", seed: "restart-d9" });
  assert.equal(restarted.snapshot().navigation.current, "usage");
  assert.equal(restarted.snapshot().models.selected, "fixture-deep");
  const different = await createDesktopProductController({ client, localRegistry: registry, stateStore, scenario: "authenticated-paid", seed: "different" });
  assert.equal(different.snapshot().navigation.current, "home");
});

test("Code OSS host routes typed webview actions to D8/native primitives and allowlisted portal handoff", async (t) => {
  const setup = await createController("authenticated-paid", { localScenario: "clean-vite-react" });
  t.after(setup.cleanup);
  const env = mockCodeOssHost(setup.registry);
  const host = createDesktopProductHost({ ...env, localWorkspaceHost: env.localWorkspaceHost, client });
  await host.open("home");
  assert.match(env.calls.panels[0].webview.html, /Build software with Thrallo/);
  await host.handleMessage({ type: "navigate", destination: "explorer" });
  assert.ok(env.calls.commands.some((entry) => entry[0] === "workbench.view.explorer"));
  const localId = host.getController().snapshot().projects.items.find((item) => item.local).id;
  await host.handleMessage({ type: "selectProject", projectId: localId });
  assert.deepEqual(env.calls.localOpen, [localId]);
  await host.handleMessage({ type: "portal", destination: "usage" });
  assert.equal(env.calls.external.length, 1);
  assert.match(env.calls.external[0], /^https:\/\/app\.thrallo\.com\/settings\/usage$/);
  assert.equal((await host.handleMessage({ type: "hostAction", action: "arbitrary" })).code, "host_action_rejected");
});

test("D9 local launcher uses D8 Git validation and recent-workspace reopening without initializing repositories", async (t) => {
  const gitFixture = createD8Project("clean-vite-react");
  const plainFixture = createD8Project("plain-html");
  t.after(() => { gitFixture.cleanup(); plainFixture.cleanup(); });
  const gitEnv = mockLocalWorkspaceCodeOss(gitFixture.root);
  const gitHost = createLocalWorkspaceHost(gitEnv);
  const opened = await gitHost.openLocalGitRepository();
  assert.equal(opened.git.detected, true);
  assert.ok(gitEnv.calls.commands.some((entry) => entry[0] === "vscode.openFolder"));
  gitEnv.calls.commands.length = 0;
  await gitHost.openWorkspaceById(opened.id);
  assert.ok(gitEnv.calls.commands.some((entry) => entry[0] === "vscode.openFolder"));

  const plainEnv = mockLocalWorkspaceCodeOss(plainFixture.root);
  const plainHost = createLocalWorkspaceHost(plainEnv);
  const rejected = await plainHost.openLocalGitRepository();
  assert.equal(rejected.code, "git_repository_not_detected");
  assert.equal(fs.existsSync(path.join(plainFixture.root, ".git")), false);
  assert.equal(plainEnv.calls.commands.length, 0);
  assert.equal(plainEnv.context.globalState.values.size, 0);
});

test("shared client loader resolves the real D1-D3 package used by the built-in extension", async () => {
  const loaded = await loadSharedClient(path.resolve("editor/vscode"));
  assert.equal(loaded.CLIENT_CONTRACT_VERSION, "1.0");
  assert.equal(typeof loaded.createFixtureProviderSuite, "function");
  assert.equal(typeof loaded.createDesktopAccessFixture, "function");
});

test("D9 actions have no production network, D1 mutation, hidden live fallback, or secret logging", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("network disabled for D9"); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const setup = await createController("waiting-plan-approval");
  await setup.controller.dispatch({ type: "send_message", text: "token=fixture-secret-that-must-not-be-recorded" });
  await setup.controller.dispatch({ type: "plan_decision", planId: setup.controller.snapshot().plan.id, decision: "approve", comment: "secret=fixture-value" });
  const calls = setup.controller.getCalls();
  assert.ok(calls.providers.every((call) => call.kind === "read"));
  assert.doesNotMatch(JSON.stringify(calls), /fixture-secret-that-must-not-be-recorded|fixture-value/);
  const sources = ["desktopProduct.js", "desktopProductHost.js", "desktopProductView.js"].map((file) => fs.readFileSync(path.resolve("editor/vscode/lib", file), "utf8")).join("\n");
  assert.doesNotMatch(sources, /\bfetch\s*\(|XMLHttpRequest|WebSocket\s*\(|\/api\/|buildr101|runtime-worker/i);
  assert.doesNotMatch(sources, /createStableReadOnlyProvider|createHttpTransport|builderV2Mutation:\s*true/);
});

test("bootstrap packages the shared client with the genuine Code OSS built-in extension", () => {
  const bootstrap = fs.readFileSync(path.resolve("desktop/bootstrap.mjs"), "utf8");
  assert.match(bootstrap, /shared["'],\s*["']thrallo-client/);
  assert.match(bootstrap, /HEAD:shared\/thrallo-client/);
  assert.doesNotMatch(bootstrap, /Tauri|BrowserWindow\(|app\.thrallo\.com.*loadURL/i);
});

test("D0 protected-path and retired Buildr101 guards remain green", () => {
  assert.doesNotThrow(() => runGuard());
});

async function createController(scenario, { localScenario = null, seed = "d9-test-seed" } = {}) {
  const workspace = localScenario ? createD8Project(localScenario) : null;
  const registryState = memoryState();
  const registry = new LocalWorkspaceRegistry({ state: registryState, now: FIXED_NOW });
  if (workspace) await registry.open(workspace.root);
  const stateStore = memoryState();
  const controller = await createDesktopProductController({ client, localRegistry: registry, stateStore, scenario, seed });
  return { controller, registry, stateStore, cleanup: workspace?.cleanup || (() => {}) };
}

function memoryState(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { values, get(key) { return values.get(key); }, async update(key, value) { values.set(key, value); } };
}

function mockCodeOssHost(registry) {
  const calls = { commands: [], panels: [], external: [], localOpen: [], hostActions: [] };
  const commandHandlers = new Map();
  const vscode = {
    ViewColumn: { One: 1 },
    Uri: { parse: (value) => ({ value, toString: () => value }), file: (fsPath) => ({ scheme: "file", fsPath }) },
    env: { appName: "Thrallo", async openExternal(uri) { calls.external.push(uri.value); return true; } },
    commands: {
      registerCommand(id, handler) { commandHandlers.set(id, handler); return { dispose() {} }; },
      async executeCommand(...args) { calls.commands.push(args); return commandHandlers.get(args[0])?.(...args.slice(1)); },
    },
    window: {
      createWebviewPanel() {
        let receiver = null;
        const panel = {
          webview: { html: "", cspSource: "vscode-webview://fixture", onDidReceiveMessage(handler) { receiver = handler; return { dispose() {} }; } },
          reveal() {}, onDidDispose() { return { dispose() {} }; }, get receiver() { return receiver; },
        };
        calls.panels.push(panel);
        return panel;
      },
      showErrorMessage() {},
    },
  };
  const context = { extensionUri: { fsPath: path.resolve("editor/vscode") }, workspaceState: memoryState(), globalState: memoryState(), subscriptions: [] };
  const localWorkspaceHost = {
    registry,
    async openWorkspaceById(id) { calls.localOpen.push(id); return { id }; },
    async openLocalFolder() { calls.hostActions.push("openLocalFolder"); return null; },
    async openLocalGitRepository() { calls.hostActions.push("openLocalGit"); return null; },
    async reviewLocalImport() { calls.hostActions.push("importLocal"); return null; },
    async openLocalTerminal() { calls.hostActions.push("terminal"); return {}; },
  };
  return { vscode, context, output: { appendLine() {} }, localWorkspaceHost, calls };
}

function mockLocalWorkspaceCodeOss(selectedFolder) {
  const calls = { commands: [], warnings: [] };
  const uri = (fsPath) => ({ scheme: "file", fsPath });
  return {
    vscode: {
      Uri: { file: uri },
      workspace: { workspaceFolders: [], getWorkspaceFolder() { return null; } },
      commands: { registerCommand() { return { dispose() {} }; }, async executeCommand(...args) { calls.commands.push(args.map((item) => item?.fsPath || item)); } },
      window: {
        activeTextEditor: null,
        async showOpenDialog() { return [uri(selectedFolder)]; },
        showWarningMessage(message) { calls.warnings.push(message); },
        showInformationMessage() {},
        onDidCloseTerminal() { return { dispose() {} }; },
      },
    },
    context: { globalState: memoryState(), subscriptions: [] },
    output: { appendLine() {} },
    calls,
  };
}
