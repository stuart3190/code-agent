import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createRequire } from "node:module";

import * as client from "../../shared/thrallo-client/src/index.mjs";
import { runGuard } from "../../desktop/d0/guard.mjs";

const require = createRequire(import.meta.url);
const {
  PREVIEW_SOURCES, PREVIEW_STATES, PORT_STATES, TEST_STATES, VIEWPORT_PRESETS,
  D10_SCENARIOS, createPreviewController, safePreviewPath, safeLocalPreviewUrl,
  redactText, redactUrl,
} = require("../../editor/vscode/lib/previewFoundation.js");
const { createLocalPreviewRuntime, commandSpecification, extractPorts } = require("../../editor/vscode/lib/previewLocalRuntime.js");
const { renderDesktopProductHtml } = require("../../editor/vscode/lib/desktopProductView.js");
const { createDesktopProductController } = require("../../editor/vscode/lib/desktopProduct.js");
const { resolveDiagnosticSource } = require("../../editor/vscode/lib/desktopProductHost.js");
const { LocalWorkspaceRegistry } = require("../../editor/vscode/lib/localWorkspace.js");

test("D10 declares every preview, port, test and responsive state", () => {
  assert.deepEqual(PREVIEW_SOURCES, ["local_dev_server", "fixture_preview", "future_cloud_workspace", "future_verified_snapshot"]);
  for (const state of ["idle", "starting", "running", "failed", "recovering", "integration_pending"]) assert.ok(PREVIEW_STATES.includes(state));
  for (const state of ["listening", "unavailable", "timed_out", "exited", "ambiguous", "port_conflict"]) assert.ok(PORT_STATES.includes(state));
  for (const state of ["queued", "running", "passed", "failed", "canceled", "timed_out", "unavailable"]) assert.ok(TEST_STATES.includes(state));
  assert.deepEqual(VIEWPORT_PRESETS.map((item) => item.id), ["desktop", "laptop", "tablet_landscape", "tablet_portrait", "mobile_large", "mobile_small"]);
});

test("D10 scenario catalogue covers every required deterministic state", () => {
  for (const required of [
    "preview-unavailable", "preview-idle", "dev-server-starting", "dev-server-running", "port-conflict", "no-port-discovered", "dev-server-failure", "dev-server-reconnect", "clean-console", "console-warning", "runtime-exception", "failed-network-request", "successful-test-run", "failed-test-run", "canceled-test", "timed-out-test", "responsive-desktop", "responsive-tablet", "responsive-mobile", "screenshot-captured", "trace-available", "diagnostics-unavailable", "offline-local-preview", "future-cloud-preview-unavailable", "future-canonical-snapshot-unavailable",
  ]) assert.ok(D10_SCENARIOS.includes(required), required);
});

test("preview source classification is explicit and future sources fail closed", async () => {
  const controller = createPreviewController();
  for (const [workspaceType, local, source, allowed] of [
    ["local_folder", true, "local_dev_server", true],
    ["fixture_thrallo_project", false, "fixture_preview", true],
    ["future_cloud_workspace", false, "future_cloud_workspace", false],
    ["future_verified_snapshot", false, "future_verified_snapshot", false],
  ]) {
    const result = await controller.dispatch({ type: "set_project", project: project({ workspaceType, local }) });
    assert.equal(controller.snapshot().preview.source, source);
    assert.equal(result.result.ok, allowed);
    if (!allowed) assert.equal(result.result.code, "capability_unavailable");
  }
  assert.equal(controller.snapshot().boundaries.builderV2Mutation, "capability_unavailable");
});

test("fixture preview requires explicit start and supports stop, restart, reload and bounded history", async () => {
  const controller = createPreviewController();
  assert.equal((await controller.dispatch({ type: "start_preview" })).result.code, "explicit_user_action_required");
  assert.equal(controller.snapshot().preview.state, "idle");
  assert.equal((await controller.dispatch({ type: "start_preview", userInitiated: true })).result.state, "running");
  assert.equal((await controller.dispatch({ type: "navigate_preview", path: "/settings?token=fake-token" })).result.ok, true);
  assert.match(controller.snapshot().preview.path, /REDACTED/);
  assert.equal((await controller.dispatch({ type: "navigate_preview", path: "https://example.invalid" })).result.code, "cross_origin_navigation_blocked");
  assert.equal((await controller.dispatch({ type: "history_back" })).result.ok, true);
  assert.equal((await controller.dispatch({ type: "history_forward" })).result.ok, true);
  assert.equal((await controller.dispatch({ type: "reload_preview" })).result.state, "reloaded");
  assert.equal((await controller.dispatch({ type: "stop_preview" })).result.state, "stopped");
  assert.equal((await controller.dispatch({ type: "restart_preview", userInitiated: true })).result.state, "running");
});

test("responsive presets, custom dimensions, orientation, reset and zoom are data driven", async () => {
  const controller = createPreviewController({ scenario: "responsive-tablet" });
  assert.equal(controller.snapshot().viewport.id, "tablet_portrait");
  await controller.dispatch({ type: "set_viewport", presetId: "mobile_small" });
  assert.deepEqual([controller.snapshot().viewport.width, controller.snapshot().viewport.height], [360, 800]);
  await controller.dispatch({ type: "rotate_viewport" });
  assert.deepEqual([controller.snapshot().viewport.width, controller.snapshot().viewport.height], [800, 360]);
  await controller.dispatch({ type: "set_viewport", width: 777, height: 555 });
  assert.equal(controller.snapshot().viewport.id, "custom");
  assert.equal((await controller.dispatch({ type: "set_viewport", width: 20, height: 9000 })).result.code, "invalid_viewport");
  await controller.dispatch({ type: "set_zoom", zoom: 0.75 });
  assert.equal(controller.snapshot().viewport.zoom, 0.75);
  await controller.dispatch({ type: "reset_viewport" });
  assert.equal(controller.snapshot().viewport.id, "desktop");
});

test("console, network and runtime diagnostics are bounded, grouped and redacted", () => {
  const warning = createPreviewController({ scenario: "console-warning" }).snapshot();
  const runtime = createPreviewController({ scenario: "runtime-exception" }).snapshot();
  const network = createPreviewController({ scenario: "failed-network-request" }).snapshot();
  assert.equal(warning.diagnostics.console[0].severity, "warning");
  assert.equal(runtime.diagnostics.runtime[0].kind, "runtime_exception");
  assert.equal(runtime.diagnostics.console[0].source.file, "src/App.jsx");
  assert.equal(network.diagnostics.network[0].state, "failed");
  assert.doesNotMatch(JSON.stringify(network), /fake-secret/);
  assert.match(network.diagnostics.network[0].path, /REDACTED/);
  assert.doesNotMatch(redactText("Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456 token=fake-token-value"), /abcdefghijklmnopqrstuvwxyz|fake-token-value/);
  assert.doesNotMatch(redactUrl("/callback?code=fake-code&signature=fake-signature&view=safe"), /fake-code|fake-signature/);
});

test("diagnostic filters and clear actions remain presentation-only", async () => {
  const controller = createPreviewController({ scenario: "runtime-exception" });
  await controller.dispatch({ type: "filter_diagnostics", severity: "error" });
  assert.equal(controller.snapshot().diagnosticFilter, "error");
  await controller.dispatch({ type: "clear_diagnostics", kind: "console" });
  assert.equal(controller.snapshot().diagnostics.console.length, 0);
  assert.ok(controller.snapshot().diagnostics.runtime.length > 0);
  await controller.dispatch({ type: "clear_diagnostics", kind: "all" });
  assert.deepEqual(controller.snapshot().diagnostics, { available: true, console: [], network: [], runtime: [] });
});

test("fixture screenshot metadata is local, route-safe and viewport-specific", async () => {
  const controller = createPreviewController({ scenario: "responsive-mobile" });
  await controller.dispatch({ type: "start_preview", userInitiated: true });
  const captured = await controller.dispatch({ type: "capture_screenshot", name: "Mobile fixture" });
  assert.equal(captured.result.state, "screenshot_captured");
  const artifact = controller.snapshot().artifacts.at(-1);
  assert.equal(artifact.storage, "fixture_memory");
  assert.equal(artifact.uploaded, false);
  assert.deepEqual([artifact.viewport.width, artifact.viewport.height], [430, 932]);
  assert.match(artifact.content, /^<svg/);
  assert.doesNotMatch(artifact.id, /token|account|owner/i);
});

test("fixture test sessions cover pass, fail, cancel and timeout deterministically", async () => {
  for (const [scenario, expected] of [["preview-idle", "passed"], ["failed-test-run", "failed"], ["canceled-test", "canceled"], ["timed-out-test", "timed_out"]]) {
    const controller = createPreviewController({ scenario, seed: "test-states" });
    if (controller.snapshot().preview.state !== "running") await controller.dispatch({ type: "start_preview", userInitiated: true });
    await controller.dispatch({ type: "run_tests" });
    assert.equal(controller.snapshot().testSession.state, expected, scenario);
    assert.ok(controller.snapshot().testSession.tests.every((item) => [expected, "passed"].includes(item.state)));
  }
});

test("an explicitly running local test session can be canceled without stopping preview", async () => {
  let finishRun;
  let canceledSession = null;
  const adapter = {
    async start() { return { ok: true, state: "running", portState: "listening", health: "healthy", port: 43117, url: "http://127.0.0.1:43117/", command: "npm run dev" }; },
    runTests() { return new Promise((resolve) => { finishRun = () => resolve({ ok: false, code: "browser_test_failed", state: "capability_unavailable" }); }); },
    async cancelTests({ sessionId }) { canceledSession = sessionId; return { ok: true, state: "canceled" }; },
  };
  const controller = createPreviewController({ localAdapter: adapter });
  await controller.dispatch({ type: "set_project", project: project({ workspaceType: "local_folder", local: true }) });
  await controller.dispatch({ type: "start_preview", commandId: "npm:dev", userInitiated: true });
  const running = controller.dispatch({ type: "run_tests" });
  await new Promise((resolve) => setImmediate(resolve));
  const activeId = controller.snapshot().testSession.id;
  assert.equal(controller.snapshot().testSession.state, "running");
  const canceled = await controller.dispatch({ type: "cancel_tests" });
  assert.equal(canceled.result.state, "canceled");
  assert.equal(canceledSession, activeId);
  finishRun();
  await running;
  assert.equal(controller.snapshot().testSession.state, "canceled");
  assert.equal(controller.snapshot().preview.state, "running");
});

test("identical seeds yield identical preview state, test results, artifacts and call evidence", async () => {
  const left = createPreviewController({ scenario: "failed-network-request", seed: "same" });
  const right = createPreviewController({ scenario: "failed-network-request", seed: "same" });
  for (const controller of [left, right]) {
    await controller.dispatch({ type: "capture_screenshot", name: "Deterministic" });
    await controller.dispatch({ type: "run_tests" });
    await controller.dispatch({ type: "set_viewport", presetId: "tablet_landscape" });
  }
  assert.deepEqual(left.snapshot(), right.snapshot());
  assert.deepEqual(left.getCalls(), right.getCalls());
});

test("local command parsing and port extraction accept only bounded D8 commands", () => {
  assert.deepEqual(commandSpecification("npm run dev").args.slice(-2), ["run", "dev"]);
  assert.equal(commandSpecification("pnpm start").args.at(-1).includes("start"), true);
  assert.equal(commandSpecification("npm install"), null);
  assert.equal(commandSpecification("node evil.js"), null);
  assert.deepEqual(extractPorts("Local: http://localhost:5173/\nport 43119\nhttps://example.invalid:9999"), [5173, 43119]);
});

test("local runtime never starts without explicit action or installs dependencies", async (t) => {
  const local = await createLocalProject({ dependencies: { vite: "0.0.0-fixture" } });
  t.after(local.cleanup);
  let spawned = 0;
  const runtime = createLocalPreviewRuntime({ registry: local.registry, spawnProcess() { spawned += 1; throw new Error("must not spawn"); } });
  const noAction = await runtime.start({ project: local.project, commandId: "npm:dev", userInitiated: false });
  assert.equal(noAction.code, "explicit_user_action_required");
  const missing = await runtime.start({ project: local.project, commandId: "npm:dev", userInitiated: true });
  assert.equal(missing.code, "dependencies_missing");
  assert.equal(spawned, 0);
  const source = await fsp.readFile(path.join(process.cwd(), "editor/vscode/lib/previewLocalRuntime.js"), "utf8");
  assert.doesNotMatch(source, /npm\s+install|pnpm\s+install|yarn\s+install|child\.stdin|shell:\s*true/);
});

test("bounded discovery reports conflicts and timeouts while terminating only its owned process", async (t) => {
  const local = await createLocalProject();
  t.after(local.cleanup);
  const terminated = [];
  const conflictChild = fakeChild(8101);
  const conflict = createLocalPreviewRuntime({ registry: local.registry, spawnProcess: () => { queueMicrotask(() => conflictChild.stdout.write("Local: http://localhost:3000/\n")); return conflictChild; }, terminateProcess: async (_child, pid) => terminated.push(pid), probePort: async (port) => port === 3000, delay: async () => {}, discoveryAttempts: 2 });
  const conflictResult = await conflict.start({ project: local.project, commandId: "npm:dev", userInitiated: true });
  assert.equal(conflictResult.code, "port_conflict");
  assert.deepEqual(terminated, [8101]);

  const timeoutChild = fakeChild(8102);
  const timeout = createLocalPreviewRuntime({ registry: local.registry, spawnProcess: () => timeoutChild, terminateProcess: async (_child, pid) => terminated.push(pid), probePort: async () => false, delay: async () => {}, discoveryAttempts: 1 });
  const timeoutResult = await timeout.start({ project: local.project, commandId: "npm:dev", userInitiated: true });
  assert.equal(timeoutResult.code, "preview_port_timed_out");
  assert.deepEqual(terminated, [8101, 8102]);
});

test("a real synthetic local server starts explicitly, changes port, screenshots, tests, restarts and stops cleanly", { timeout: 60000 }, async (t) => {
  const port = await freePort();
  const local = await createLocalProject({ serverPort: port });
  t.after(local.cleanup);
  const artifactRoot = path.join(local.root, ".thrallo-test-artifacts");
  const runtime = createLocalPreviewRuntime({ registry: local.registry, artifactRoot, discoveryAttempts: 40, discoveryIntervalMs: 125 });
  const controller = createPreviewController({ localAdapter: runtime, now: () => new Date("2032-09-10T15:00:00.000Z") });
  await controller.dispatch({ type: "set_project", project: local.project });
  assert.equal(controller.snapshot().preview.state, "idle");
  const started = await controller.dispatch({ type: "start_preview", commandId: "npm:dev", userInitiated: true });
  assert.equal(started.result.ok, true);
  assert.equal(controller.snapshot().preview.port, port);
  assert.match(controller.snapshot().preview.url, /^http:\/\/127\.0\.0\.1:/);
  const shot = await controller.dispatch({ type: "capture_screenshot", name: "Local desktop" });
  assert.equal(shot.result.ok, true);
  assert.equal(await exists(shot.result.artifact.localPath), true);
  const tested = await controller.dispatch({ type: "run_tests", tests: [
    { id: "load", name: "Page loads", kind: "page_loads" },
    { id: "heading", name: "Heading exists", kind: "element_exists", selector: "h1" },
    { id: "console", name: "Console clean", kind: "console_no_errors" },
    { id: "screen", name: "Screenshot", kind: "screenshot_capture" },
    { id: "responsive", name: "Responsive", kind: "responsive_smoke" },
  ] });
  assert.equal(tested.result.state, "passed");
  assert.ok(controller.snapshot().artifacts.some((artifact) => artifact.kind === "trace"));
  assert.ok(controller.snapshot().artifacts.some((artifact) => artifact.kind === "screenshot"));
  const restarted = await controller.dispatch({ type: "restart_preview", commandId: "npm:dev", userInitiated: true });
  assert.equal(restarted.result.ok, true);
  const stopped = await controller.dispatch({ type: "stop_preview" });
  assert.equal(stopped.result.state, "stopped");
  assert.equal((await runtime.cleanup()).clean, true);
  assert.equal(await waitForClosed(port), true);
});

test("diagnostic source mapping stays inside the selected local workspace", async (t) => {
  const local = await createLocalProject();
  t.after(local.cleanup);
  const source = path.join(local.root, "src", "App.jsx");
  assert.equal(resolveDiagnosticSource(local.root, "src/App.jsx"), source);
  assert.equal(resolveDiagnosticSource(local.root, "../outside.txt"), null);
  assert.equal(resolveDiagnosticSource(local.root, "missing.js"), null);
  assert.equal(resolveDiagnosticSource(local.root, "C:\\Windows\\system.ini"), null);
});

test("D9 opens fixture/local preview without changing beginner-first navigation contracts", async () => {
  const registry = Object.freeze({ async recent() { return Object.freeze([]); } });
  const controller = await createDesktopProductController({ client, localRegistry: registry });
  const fixture = controller.snapshot().projects.items.find((item) => item.workspaceType === "fixture_thrallo_project");
  const opened = await controller.dispatch({ type: "open_preview", projectId: fixture.id });
  assert.equal(opened.result.state, "preview_opened");
  assert.equal(controller.snapshot().navigation.current, "preview");
  assert.equal(controller.snapshot().preview.preview.source, "fixture_preview");
  assert.ok(controller.snapshot().navigation.items.some((item) => item.id === "conversation" && item.enabled));
  assert.ok(controller.snapshot().navigation.items.some((item) => item.id === "explorer" && item.enabled));
});

test("D10 rendering exposes application browser, diagnostics and results accessibly", async () => {
  const registry = Object.freeze({ async recent() { return Object.freeze([]); } });
  const controller = await createDesktopProductController({ client, localRegistry: registry, previewScenario: "failed-network-request" });
  await controller.dispatch({ type: "navigate", destination: "preview" });
  const html = renderDesktopProductHtml(controller.snapshot(), { nonce: "d10-test", cspSource: "vscode-webview://fixture" });
  for (const marker of ["Application testing", "Responsive viewport simulation", "Application preview controls", "Console", "Network", "Runtime", "Run bounded tests", "Test results"]) assert.match(html, new RegExp(marker));
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /aria-label="Responsive viewport simulation"/);
  assert.match(html, /prefers-reduced-motion:reduce/);
  assert.match(html, /focus-visible/);
  assert.match(html, /@media\(max-width:650px\)/);
  assert.match(html, /bodies not retained/);
  assert.doesNotMatch(html, /fake-secret|Authorization:|Cookie:/i);
});

test("preview URLs and paths never create an unrestricted browser", () => {
  assert.equal(safePreviewPath("/account/settings"), "/account/settings");
  assert.equal(safePreviewPath("//other.invalid/path"), null);
  assert.equal(safePreviewPath("https://other.invalid/path"), null);
  assert.equal(safeLocalPreviewUrl("http://127.0.0.1:43119/path"), "http://127.0.0.1:43119/path");
  assert.equal(safeLocalPreviewUrl("https://app.thrallo.com/project"), null);
  assert.equal(safeLocalPreviewUrl("http://192.168.1.10:3000/"), null);
});

test("D10 sources contain no production fallback, Builder V2, publishing or deployment mutation", async () => {
  const files = ["previewFoundation.js", "previewLocalRuntime.js", "previewView.js"].map((file) => path.join(process.cwd(), "editor/vscode/lib", file));
  const source = (await Promise.all(files.map((file) => fsp.readFile(file, "utf8")))).join("\n");
  assert.doesNotMatch(source, /app\.thrallo\.com|\/api\/v\d|createHttpTransport|createStableReadOnlyProvider|publish\s*\(|deploy\s*\(|builderV2Mutation:\s*true|runtime-worker|Buildr101/i);
  assert.doesNotMatch(source, /document\.cookie|page\.cookies\s*\(|context\.cookies\s*\(/);
});

test("D0 protected path, Buildr101 and fixture-network guards remain green", () => {
  const result = runGuard();
  assert.equal(result.phase, "desktop-foundation");
});

function project({ workspaceType = "fixture_thrallo_project", local = false } = {}) {
  return { id: `project-${workspaceType}`, name: "D10 project", workspaceType, local, path: local ? process.cwd() : null, framework: "vite_react", previewCommands: local ? [{ id: "npm:dev", label: "npm run dev", command: "npm run dev", autoRun: false }] : [] };
}

async function createLocalProject({ dependencies = {}, serverPort = 43117 } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "thrallo-d10-local-"));
  await fsp.mkdir(path.join(root, "src"), { recursive: true });
  await fsp.writeFile(path.join(root, "src", "App.jsx"), "export const App = () => <h1>Local preview</h1>;\n");
  const server = `const http=require('node:http');const port=${serverPort};const html='<!doctype html><html><body><h1>Local Thrallo preview</h1><script>console.log(\"fixture local ready\")<\\/script></body></html>';http.createServer((req,res)=>{if(req.url===\"/\"||req.url===\"/index.html\"){res.writeHead(200,{\"content-type\":\"text/html\"});res.end(html)}else{res.writeHead(404);res.end(\"missing\")}}).listen(port,\"127.0.0.1\",()=>console.log(\"Local: http://127.0.0.1:\"+port+\"/\"));`;
  await fsp.writeFile(path.join(root, "server.cjs"), server);
  await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "thrallo-d10-local-fixture", private: true, scripts: { dev: "node server.cjs" }, dependencies }));
  const values = new Map();
  const registry = new LocalWorkspaceRegistry({ state: { get: (key) => values.get(key), update: async (key, value) => values.set(key, value) }, now: () => new Date("2032-09-10T15:00:00.000Z") });
  const workspace = await registry.open(root);
  return {
    root, registry,
    project: { id: workspace.id, name: workspace.displayName, workspaceType: workspace.mode, projectType: workspace.projectType, framework: workspace.projectType, local: true, rootPath: workspace.realPath, path: workspace.realPath, previewCommands: workspace.previewCommands },
    cleanup: async () => fsp.rm(root, { recursive: true, force: true }),
  };
}

function fakeChild(pid) { const child = new EventEmitter(); child.pid = pid; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => child.emit("exit", 0); return child; }
async function freePort() { return new Promise((resolve, reject) => { const server = net.createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolve(port)); }); }); }
async function exists(file) { try { await fsp.stat(file); return true; } catch { return false; } }
async function waitForClosed(port) { for (let attempt = 0; attempt < 20; attempt += 1) { const open = await new Promise((resolve) => { const socket = net.createConnection({ host: "127.0.0.1", port }); const finish = (value) => { socket.destroy(); resolve(value); }; socket.setTimeout(100); socket.once("connect", () => finish(true)); socket.once("timeout", () => finish(false)); socket.once("error", () => finish(false)); }); if (!open) return true; await new Promise((resolve) => setTimeout(resolve, 100)); } return false; }
