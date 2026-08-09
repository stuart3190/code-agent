// Host-neutral D10 preview/testing state. Local side effects are supplied by the Code OSS
// host; deterministic fixture behavior has no transport, production origin, or live fallback.

"use strict";

const PREVIEW_SOURCES = Object.freeze([
  "local_dev_server", "fixture_preview", "future_cloud_workspace", "future_verified_snapshot",
]);
const PREVIEW_STATES = Object.freeze([
  "unavailable", "idle", "starting", "running", "stopping", "stopped", "failed", "recovering", "offline", "integration_pending",
]);
const PORT_STATES = Object.freeze(["idle", "starting", "listening", "unavailable", "timed_out", "exited", "ambiguous", "port_conflict"]);
const TEST_STATES = Object.freeze(["idle", "queued", "running", "passed", "failed", "canceled", "timed_out", "unavailable"]);
const VIEWPORT_PRESETS = Object.freeze([
  preset("desktop", "Desktop", 1440, 900),
  preset("laptop", "Laptop", 1280, 800),
  preset("tablet_landscape", "Tablet landscape", 1024, 768),
  preset("tablet_portrait", "Tablet portrait", 768, 1024),
  preset("mobile_large", "Mobile large", 430, 932),
  preset("mobile_small", "Mobile small", 360, 800),
]);

const D10_FIXTURE_SEED = "thrallo-desktop-d10-foundation";
const D10_FIXTURE_CLOCK = "2032-09-10T15:00:00.000Z";
const BASE_SCENARIO = Object.freeze({ previewState: "idle", portState: "idle", testState: "idle", viewport: "desktop", source: "fixture_preview", console: "clean", network: "clean", runtime: "clean", screenshot: false, trace: false });
const SCENARIOS = Object.freeze({
  "preview-unavailable": { previewState: "unavailable", portState: "unavailable" },
  "preview-idle": {},
  "dev-server-starting": { source: "local_dev_server", previewState: "starting", portState: "starting" },
  "dev-server-running": { source: "local_dev_server", previewState: "running", portState: "listening" },
  "port-conflict": { source: "local_dev_server", previewState: "failed", portState: "port_conflict", runtime: "server_failure" },
  "no-port-discovered": { source: "local_dev_server", previewState: "failed", portState: "timed_out", runtime: "server_failure" },
  "dev-server-failure": { source: "local_dev_server", previewState: "failed", portState: "exited", runtime: "server_failure" },
  "dev-server-reconnect": { source: "local_dev_server", previewState: "recovering", portState: "listening", runtime: "server_recovered" },
  "clean-console": { previewState: "running", portState: "listening" },
  "console-warning": { previewState: "running", portState: "listening", console: "warning" },
  "runtime-exception": { previewState: "running", portState: "listening", console: "error", runtime: "exception" },
  "failed-network-request": { previewState: "running", portState: "listening", network: "failure", runtime: "network_failure" },
  "successful-test-run": { previewState: "running", portState: "listening", testState: "passed" },
  "failed-test-run": { previewState: "running", portState: "listening", testState: "failed", console: "error" },
  "canceled-test": { previewState: "running", portState: "listening", testState: "canceled" },
  "timed-out-test": { previewState: "running", portState: "listening", testState: "timed_out" },
  "responsive-desktop": { previewState: "running", portState: "listening", viewport: "desktop" },
  "responsive-tablet": { previewState: "running", portState: "listening", viewport: "tablet_portrait" },
  "responsive-mobile": { previewState: "running", portState: "listening", viewport: "mobile_large" },
  "screenshot-captured": { previewState: "running", portState: "listening", screenshot: true },
  "trace-available": { previewState: "running", portState: "listening", testState: "passed", trace: true },
  "diagnostics-unavailable": { previewState: "running", portState: "listening", console: "unavailable", network: "unavailable", runtime: "unavailable" },
  "offline-local-preview": { source: "local_dev_server", previewState: "offline", portState: "unavailable", runtime: "server_failure" },
  "future-cloud-preview-unavailable": { source: "future_cloud_workspace", previewState: "integration_pending", portState: "unavailable" },
  "future-canonical-snapshot-unavailable": { source: "future_verified_snapshot", previewState: "integration_pending", portState: "unavailable" },
});
const D10_SCENARIOS = Object.freeze(Object.keys(SCENARIOS));

function getD10Scenario(name = "preview-idle") {
  if (!D10_SCENARIOS.includes(name)) throw new TypeError(`Unknown D10 fixture scenario: ${name}`);
  return Object.freeze({ name, ...BASE_SCENARIO, ...SCENARIOS[name] });
}

function createPreviewController({ scenario = "preview-idle", seed = D10_FIXTURE_SEED, localAdapter = null, providerPreview = null, now = () => new Date(D10_FIXTURE_CLOCK) } = {}) {
  const definition = getD10Scenario(scenario);
  const calls = [];
  let sequence = 0;
  let state = initialState(definition, seed, now, providerPreview);

  async function dispatch(action) {
    if (!action || typeof action.type !== "string") throw new TypeError("D10 actions require an explicit type");
    sequence += 1;
    const call = recordCall(calls, sequence, action, seed, now);
    let result;
    if (action.type === "set_project") result = setProject(action.project);
    else if (action.type === "set_viewport") result = setViewport(action);
    else if (action.type === "rotate_viewport") result = rotateViewport();
    else if (action.type === "reset_viewport") result = setViewport({ presetId: "desktop" });
    else if (action.type === "set_zoom") result = setZoom(action.zoom);
    else if (action.type === "start_preview") result = await startPreview(action);
    else if (action.type === "stop_preview") result = await stopPreview();
    else if (action.type === "restart_preview") result = await restartPreview(action);
    else if (action.type === "reload_preview") result = reloadPreview();
    else if (action.type === "navigate_preview") result = navigate(action.path);
    else if (action.type === "history_back") result = moveHistory(-1);
    else if (action.type === "history_forward") result = moveHistory(1);
    else if (action.type === "capture_screenshot") result = await captureScreenshot(action.name);
    else if (action.type === "run_tests") result = await runTests(action.tests);
    else if (action.type === "cancel_tests") result = await cancelTests();
    else if (action.type === "clear_diagnostics") result = clearDiagnostics(action.kind);
    else if (action.type === "filter_diagnostics") result = filterDiagnostics(action.severity);
    else if (action.type === "sync_local_runtime") result = syncLocalRuntime(action.runtime);
    else return unavailable("unsupported_preview_action", action.type);
    state.lastAction = Object.freeze({ requestId: call.requestId, type: action.type, result: safeClone(result) });
    return Object.freeze({ result, state: snapshot() });
  }

  function setProject(project) {
    if (!project || typeof project.id !== "string") return unavailable("preview_project_required", "project");
    const source = sourceForProject(project);
    const functional = source === "local_dev_server" || source === "fixture_preview";
    state.project = Object.freeze({ id: bounded(project.id), title: bounded(project.name || "Application"), workspaceType: bounded(project.workspaceType), projectType: bounded(project.framework || project.projectType || "unknown"), local: project.local === true, rootPath: project.local ? String(project.path || "") : null, previewCommands: Object.freeze((project.previewCommands || []).map(safeCommand)) });
    state.preview = Object.freeze({ ...state.preview, source, state: functional ? "idle" : "integration_pending", url: null, path: "/", port: null, portState: functional ? "idle" : "unavailable", health: functional ? "ready" : "capability_unavailable", reloadCount: 0, externalAllowed: false });
    state.history = Object.freeze({ entries: Object.freeze(["/"]), index: 0 });
    return functional ? ok("project_selected") : unavailable("capability_unavailable", source);
  }

  function setViewport({ presetId, width, height } = {}) {
    const presetValue = VIEWPORT_PRESETS.find((item) => item.id === presetId);
    if (presetValue) state.viewport = Object.freeze({ ...presetValue, custom: false, zoom: state.viewport.zoom });
    else {
      const safeWidth = boundedDimension(width);
      const safeHeight = boundedDimension(height);
      if (!safeWidth || !safeHeight) return unavailable("invalid_viewport", "viewport");
      state.viewport = Object.freeze({ id: "custom", label: "Custom", width: safeWidth, height: safeHeight, custom: true, zoom: state.viewport.zoom });
    }
    return ok("viewport_updated", { viewport: state.viewport });
  }

  function rotateViewport() {
    state.viewport = Object.freeze({ ...state.viewport, width: state.viewport.height, height: state.viewport.width, label: state.viewport.custom ? "Custom" : `${state.viewport.label} rotated`, custom: true, id: "custom" });
    return ok("viewport_rotated", { viewport: state.viewport });
  }

  function setZoom(value) {
    const zoom = value === "fit" ? "fit" : Number(value);
    if (zoom !== "fit" && (!Number.isFinite(zoom) || zoom < 0.25 || zoom > 2)) return unavailable("invalid_zoom", "viewport");
    state.viewport = Object.freeze({ ...state.viewport, zoom });
    return ok("zoom_updated", { zoom });
  }

  async function startPreview(action) {
    if (action.userInitiated !== true) return unavailable("explicit_user_action_required", "preview");
    if (!isFunctionalSource(state.preview.source)) return unavailable("capability_unavailable", state.preview.source);
    if (state.preview.source === "fixture_preview") {
      state.preview = Object.freeze({ ...state.preview, state: "running", portState: "listening", health: "healthy", path: state.preview.path || "/fixture-preview", url: null, externalAllowed: false });
      return ok("running", { fixtureOnly: true });
    }
    if (!localAdapter?.start) return unavailable("local_preview_adapter_unavailable", "local_dev_server");
    state.preview = Object.freeze({ ...state.preview, state: "starting", portState: "starting", health: "starting" });
    const result = await localAdapter.start({ project: state.project, commandId: action.commandId, userInitiated: true });
    applyRuntimeResult(result);
    return result;
  }

  async function stopPreview() {
    if (state.preview.source === "fixture_preview") { state.preview = Object.freeze({ ...state.preview, state: "stopped", portState: "exited", health: "stopped" }); return ok("stopped", { fixtureOnly: true }); }
    if (!localAdapter?.stop) return unavailable("local_preview_adapter_unavailable", "local_dev_server");
    const result = await localAdapter.stop({ projectId: state.project.id });
    applyRuntimeResult(result);
    return result;
  }

  async function restartPreview(action) {
    if (state.preview.source === "fixture_preview") { state.preview = Object.freeze({ ...state.preview, state: "running", portState: "listening", health: "recovered", reloadCount: state.preview.reloadCount + 1 }); return ok("running", { fixtureOnly: true }); }
    if (!localAdapter?.restart) return unavailable("local_preview_adapter_unavailable", "local_dev_server");
    const result = await localAdapter.restart({ project: state.project, commandId: action.commandId, userInitiated: action.userInitiated === true });
    applyRuntimeResult(result);
    return result;
  }

  function reloadPreview() {
    if (state.preview.state !== "running" && state.preview.state !== "recovering") return unavailable("preview_not_running", "reload");
    state.preview = Object.freeze({ ...state.preview, reloadCount: state.preview.reloadCount + 1, health: "healthy" });
    return ok("reloaded");
  }

  function navigate(rawPath) {
    if (state.preview.state !== "running") return unavailable("preview_not_running", "navigation");
    const safePath = safePreviewPath(rawPath);
    if (!safePath) return unavailable("cross_origin_navigation_blocked", "navigation");
    const entries = state.history.entries.slice(0, state.history.index + 1).concat(safePath);
    state.history = Object.freeze({ entries: Object.freeze(entries), index: entries.length - 1 });
    state.preview = Object.freeze({ ...state.preview, path: safePath });
    return ok("navigated", { path: safePath });
  }

  function moveHistory(delta) {
    const next = state.history.index + delta;
    if (next < 0 || next >= state.history.entries.length) return unavailable("history_boundary", "navigation");
    state.history = Object.freeze({ ...state.history, index: next });
    state.preview = Object.freeze({ ...state.preview, path: state.history.entries[next] });
    return ok("navigated", { path: state.preview.path });
  }

  async function captureScreenshot(name) {
    if (state.preview.state !== "running") return unavailable("preview_not_running", "screenshot");
    const metadata = artifactMetadata("screenshot", state, now, name);
    let artifact;
    if (state.preview.source === "fixture_preview") artifact = Object.freeze({ ...metadata, storage: "fixture_memory", mimeType: "image/svg+xml", content: fixtureScreenshotSvg(state) });
    else if (localAdapter?.captureScreenshot) artifact = await localAdapter.captureScreenshot({ preview: state.preview, project: state.project, viewport: state.viewport, metadata });
    else return unavailable("screenshot_adapter_unavailable", "screenshot");
    if (artifact?.ok === false) return artifact;
    state.artifacts = Object.freeze([...state.artifacts, safeClone(artifact)]);
    return ok("screenshot_captured", { artifact: safeClone(artifact) });
  }

  async function runTests(requestedTests) {
    if (state.preview.state !== "running") return unavailable("preview_not_running", "tests");
    const tests = normalizeTests(requestedTests);
    const sessionId = `${state.preview.source === "local_dev_server" ? "local" : "fixture"}-test-${digest(`${state.project.id}:${sequence}:${now().toISOString()}`)}`;
    state.testSession = Object.freeze({ ...state.testSession, id: sessionId, state: "running", tests, startedAt: now().toISOString(), finishedAt: null });
    let result;
    if (state.preview.source === "fixture_preview") result = fixtureTestResult(definition, tests, state, now, true);
    else if (localAdapter?.runTests) result = await localAdapter.runTests({ sessionId, preview: state.preview, project: state.project, viewport: state.viewport, tests });
    else result = unavailable("test_adapter_unavailable", "tests");
    if (state.testSession.state === "canceled") return ok("canceled", { fixtureOnly: false });
    if (!result.ok) { state.testSession = Object.freeze({ ...state.testSession, state: result.state === "timed_out" ? "timed_out" : "unavailable", failureSummary: result.code }); return result; }
    state.testSession = safeClone(result.session);
    state.artifacts = Object.freeze([...state.artifacts, ...(result.artifacts || []).map(safeClone)]);
    state.diagnostics = mergeDiagnostics(state.diagnostics, result.diagnostics || {});
    return result;
  }

  async function cancelTests() {
    if (state.testSession.state !== "running" && state.testSession.state !== "queued") return unavailable("test_session_not_active", "tests");
    const result = state.preview.source === "fixture_preview" ? ok("canceled", { fixtureOnly: true }) : localAdapter?.cancelTests ? await localAdapter.cancelTests({ sessionId: state.testSession.id }) : unavailable("test_adapter_unavailable", "tests");
    if (result.ok) state.testSession = Object.freeze({ ...state.testSession, state: "canceled", finishedAt: now().toISOString() });
    return result;
  }

  function clearDiagnostics(kind = "all") {
    if (kind === "all") state.diagnostics = emptyDiagnostics();
    else if (["console", "network", "runtime"].includes(kind)) state.diagnostics = Object.freeze({ ...state.diagnostics, [kind]: Object.freeze([]) });
    else return unavailable("diagnostic_kind_unknown", kind);
    return ok("diagnostics_cleared");
  }

  function filterDiagnostics(severity = "all") {
    if (!["all", "log", "info", "warning", "error"].includes(severity)) return unavailable("diagnostic_filter_unknown", severity);
    state.diagnosticFilter = severity;
    return ok("diagnostic_filter_updated", { severity });
  }

  function syncLocalRuntime(runtime) { applyRuntimeResult(runtime); return ok("runtime_synchronized"); }
  function applyRuntimeResult(result) {
    if (!result || result.ok !== true) {
      state.preview = Object.freeze({ ...state.preview, state: result?.state === "starting" ? "starting" : "failed", portState: PORT_STATES.includes(result?.portState) ? result.portState : "unavailable", health: result?.code || "unavailable", url: null, port: null });
      if (result?.diagnostics) state.diagnostics = mergeDiagnostics(state.diagnostics, result.diagnostics);
      return;
    }
    state.preview = Object.freeze({ ...state.preview, state: PREVIEW_STATES.includes(result.state) ? result.state : "running", portState: PORT_STATES.includes(result.portState) ? result.portState : "listening", health: result.health || "healthy", url: safeLocalPreviewUrl(result.url), port: Number.isInteger(result.port) ? result.port : null, externalAllowed: Boolean(safeLocalPreviewUrl(result.url)), command: bounded(result.command || "") || null });
    if (result.diagnostics) state.diagnostics = mergeDiagnostics(state.diagnostics, result.diagnostics);
  }

  function snapshot() { return safeClone(state); }
  function getCalls() { return Object.freeze(calls.map(safeClone)); }
  return Object.freeze({ dispatch, snapshot, getCalls, presets: VIEWPORT_PRESETS });
}

function initialState(definition, seed, now, providerPreview) {
  const viewport = VIEWPORT_PRESETS.find((item) => item.id === definition.viewport) || VIEWPORT_PRESETS[0];
  const project = Object.freeze({ id: "fixture-project-0001", title: "Fixture storefront", workspaceType: "fixture_thrallo_project", local: false, rootPath: null, previewCommands: Object.freeze([]) });
  const diagnostics = fixtureDiagnostics(definition, now);
  const testSession = fixtureTestResult(definition, normalizeTests(), { project, viewport, preview: { source: definition.source, path: "/fixture-preview" } }, now).session;
  const artifacts = [];
  if (definition.screenshot) artifacts.push(Object.freeze({ ...artifactMetadata("screenshot", { project, viewport, preview: { source: definition.source, path: "/fixture-preview" } }, now, "Fixture capture"), storage: "fixture_memory", mimeType: "image/svg+xml" }));
  if (definition.trace) artifacts.push(Object.freeze({ ...artifactMetadata("trace", { project, viewport, preview: { source: definition.source, path: "/fixture-preview" } }, now, "Fixture trace"), storage: "fixture_memory", mimeType: "application/zip", available: true }));
  return {
    schemaVersion: 1, source: "deterministic_fixture", seed, observedAt: now().toISOString(), project, providerPreview: safeClone(providerPreview),
    preview: Object.freeze({ source: definition.source, state: definition.previewState, path: "/fixture-preview", url: null, port: definition.portState === "listening" && definition.source === "local_dev_server" ? 4173 : null, portState: definition.portState, command: null, health: healthFor(definition), reloadCount: 0, externalAllowed: false }),
    viewport: Object.freeze({ ...viewport, zoom: "fit" }), presets: VIEWPORT_PRESETS, history: Object.freeze({ entries: Object.freeze(["/fixture-preview"]), index: 0 }), diagnostics, diagnosticFilter: "all", testSession, artifacts: Object.freeze(artifacts), lastAction: null,
    boundaries: Object.freeze({ cloudPreview: "integration_pending_D6", canonicalSnapshot: "integration_pending_D7", productionDiagnostics: "track_b_blocked", productionArtifacts: "track_b_blocked", builderV2Mutation: "capability_unavailable", publishing: "capability_unavailable" }),
  };
}

function fixtureDiagnostics(definition, now) {
  const consoleItems = [];
  if (definition.console === "warning") consoleItems.push(consoleDiagnostic("warning", "Fixture deprecation warning", now));
  if (definition.console === "error") consoleItems.push(consoleDiagnostic("error", "Fixture runtime exception: value was unavailable", now, "src/App.jsx", 18, 7));
  const network = definition.network === "failure" ? [networkDiagnostic({ method: "GET", url: "/api/fixture-failure?token=fake-secret", status: 503, state: "failed", durationMs: 42, type: "fetch", now })] : [];
  const runtime = [];
  if (definition.runtime === "exception") runtime.push(runtimeDiagnostic("runtime_exception", "Fixture application threw an exception", now, "src/App.jsx", 18, 7));
  if (definition.runtime === "network_failure") runtime.push(runtimeDiagnostic("failed_fetch", "Fixture request failed", now));
  if (definition.runtime === "server_failure") runtime.push(runtimeDiagnostic("dev_server_disconnected", "Local fixture server is unavailable", now));
  if (definition.runtime === "server_recovered") runtime.push(runtimeDiagnostic("dev_server_recovered", "Local fixture server reconnected", now));
  return Object.freeze({ available: definition.console !== "unavailable", console: Object.freeze(groupConsole(consoleItems)), network: Object.freeze(network), runtime: Object.freeze(runtime) });
}

function fixtureTestResult(definition, tests, state, now, executed = false) {
  const status = executed && definition.testState === "idle" ? "passed" : definition.testState;
  const results = tests.map((item, index) => Object.freeze({ id: item.id, name: item.name, state: status === "failed" && index === 0 ? "failed" : status === "timed_out" ? "timed_out" : status === "canceled" ? "canceled" : status === "idle" ? "queued" : "passed", durationMs: status === "idle" ? null : 140 + index * 37, failureSummary: status === "failed" && index === 0 ? "Expected fixture heading was not found." : null, screenshotArtifactId: null, traceAvailable: definition.trace, consoleEvidenceCount: definition.console === "error" ? 1 : 0, networkEvidenceCount: definition.network === "failure" ? 1 : 0 }));
  const sessionState = status === "idle" ? "idle" : status;
  return Object.freeze({ ok: true, state: sessionState, session: Object.freeze({ id: `fixture-test-${digest(`${state.project.id}:${definition.name}`)}`, state: sessionState, source: "deterministic_fixture", explicit: true, startedAt: status === "idle" ? null : now().toISOString(), finishedAt: ["passed", "failed", "canceled", "timed_out"].includes(status) ? now().toISOString() : null, tests: Object.freeze(results), failureSummary: status === "failed" ? "One bounded fixture check failed." : null }), artifacts: Object.freeze([]), diagnostics: Object.freeze({}) });
}

function normalizeTests(tests) {
  const defaults = [
    { id: "page_loads", name: "Page loads", kind: "page_loads" },
    { id: "heading_exists", name: "Expected heading exists", kind: "element_exists", selector: "h1" },
    { id: "console_clean", name: "Console has no errors", kind: "console_no_errors" },
    { id: "responses_succeed", name: "Expected responses succeed", kind: "response_succeeds" },
    { id: "responsive_smoke", name: "Responsive viewport smoke", kind: "responsive_smoke" },
  ];
  const source = Array.isArray(tests) && tests.length ? tests : defaults;
  return Object.freeze(source.slice(0, 12).map((item, index) => Object.freeze({ id: bounded(item.id || `test-${index}`), name: bounded(item.name || "Bounded test"), kind: bounded(item.kind || "page_loads"), selector: item.selector ? bounded(item.selector) : null })));
}

function consoleDiagnostic(severity, message, now, file = null, line = null, column = null) { return Object.freeze({ id: `console-${digest(`${severity}:${message}:${file}`)}`, severity, message: redactText(message), timestamp: now().toISOString(), occurrenceCount: 1, source: file ? Object.freeze({ file: safeRelativeFile(file), line, column }) : null }); }
function networkDiagnostic({ method, url, status, state, durationMs, type, sizeBytes = null, now }) { return Object.freeze({ id: `network-${digest(`${method}:${url}:${status}`)}`, method: bounded(method).toUpperCase(), path: redactUrl(url), status: Number.isInteger(status) ? status : null, state: bounded(state), durationMs: Number(durationMs) || 0, type: bounded(type), sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : null, timestamp: now().toISOString() }); }
function runtimeDiagnostic(kind, message, now, file = null, line = null, column = null) { return Object.freeze({ id: `runtime-${digest(`${kind}:${message}`)}`, kind, message: redactText(message), timestamp: now().toISOString(), source: file ? Object.freeze({ file: safeRelativeFile(file), line, column }) : null }); }
function groupConsole(items) { const grouped = new Map(); for (const item of items) { const key = `${item.severity}:${item.message}:${item.source?.file || ""}:${item.source?.line || ""}`; const current = grouped.get(key); grouped.set(key, current ? Object.freeze({ ...current, occurrenceCount: current.occurrenceCount + 1 }) : item); } return [...grouped.values()]; }
function mergeDiagnostics(current, incoming) { return Object.freeze({ available: incoming.available ?? current.available, console: Object.freeze(groupConsole([...(current.console || []), ...((incoming.console || []).map(safeDiagnostic))])), network: Object.freeze([...(current.network || []), ...((incoming.network || []).map(safeNetwork))]), runtime: Object.freeze([...(current.runtime || []), ...((incoming.runtime || []).map(safeDiagnostic))]) }); }
function emptyDiagnostics() { return Object.freeze({ available: true, console: Object.freeze([]), network: Object.freeze([]), runtime: Object.freeze([]) }); }

function sourceForProject(project) { if (project.workspaceType === "future_cloud_workspace") return "future_cloud_workspace"; if (project.workspaceType === "future_verified_snapshot") return "future_verified_snapshot"; return project.local ? "local_dev_server" : "fixture_preview"; }
function isFunctionalSource(source) { return source === "local_dev_server" || source === "fixture_preview"; }
function safeCommand(item) { return Object.freeze({ id: bounded(item.id), label: bounded(item.label || item.command), command: boundedCommand(item.command), autoRun: false }); }
function boundedCommand(value) { const command = String(value || "").trim(); return /^(?:npm run (?:dev|start)|pnpm (?:dev|start)|yarn (?:dev|start))$/.test(command) ? command : ""; }
function safePreviewPath(value) { try { const raw = String(value || "").trim(); if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || /[\r\n]/.test(raw)) return null; const url = new URL(raw, "http://fixture.invalid"); if (url.origin !== "http://fixture.invalid") return null; return redactUrl(`${url.pathname}${url.search}${url.hash}`); } catch { return null; } }
function safeLocalPreviewUrl(value) { try { if (!value) return null; const url = new URL(String(value)); if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return null; url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.toString(); } catch { return null; } }
function safeRelativeFile(value) { const normalized = String(value || "").replaceAll("\\", "/").replace(/^\.\//, ""); if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..") || /[\r\n]/.test(normalized)) return null; return normalized.slice(0, 500); }
function redactUrl(value) { try { const url = new URL(String(value), "http://fixture.invalid"); for (const key of [...url.searchParams.keys()]) if (/token|secret|key|password|auth|signature|sig|credential|session|code/i.test(key)) url.searchParams.set(key, "[REDACTED]"); return `${url.pathname}${url.search}${url.hash}`.slice(0, 1000); } catch { return "[invalid-path]"; } }
function redactText(value) { return String(value ?? "").replace(/\bbearer\s+[a-z0-9._~-]{12,}/gi, "Bearer [REDACTED]").replace(/\b(?:sk|pk|sb|ghp|github_pat)_[a-z0-9_-]{12,}\b/gi, "[REDACTED]").replace(/((?:token|secret|password|api[_-]?key|authorization|cookie)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]").slice(0, 2000); }
function safeDiagnostic(item) { return Object.freeze({ ...item, message: redactText(item.message), source: item.source?.file ? Object.freeze({ file: safeRelativeFile(item.source.file), line: positiveInt(item.source.line), column: positiveInt(item.source.column) }) : null }); }
function safeNetwork(item) { return Object.freeze({ id: bounded(item.id), method: bounded(item.method).toUpperCase(), path: redactUrl(item.path || item.url || "/"), status: Number.isInteger(item.status) ? item.status : null, state: bounded(item.state), durationMs: Number(item.durationMs) || 0, type: bounded(item.type), sizeBytes: Number.isFinite(item.sizeBytes) ? item.sizeBytes : null, timestamp: bounded(item.timestamp) }); }
function artifactMetadata(kind, state, now, name) { return Object.freeze({ id: `${kind}-${digest(`${state.project.id}:${state.viewport.width}:${state.viewport.height}:${state.preview.path}:${now().toISOString()}`)}`, kind, name: bounded(name || `${state.viewport.label} ${kind}`), projectId: bounded(state.project.id), viewport: Object.freeze({ width: state.viewport.width, height: state.viewport.height, preset: state.viewport.label }), timestamp: now().toISOString(), previewSource: state.preview.source, route: redactUrl(state.preview.path || "/"), localOnly: true, uploaded: false }); }
function fixtureScreenshotSvg(state) { const title = escapeXml(state.project.title); return `<svg xmlns="http://www.w3.org/2000/svg" width="${state.viewport.width}" height="${state.viewport.height}" viewBox="0 0 ${state.viewport.width} ${state.viewport.height}"><rect width="100%" height="100%" fill="#f7f7f4"/><rect x="24" y="24" width="${Math.max(1, state.viewport.width - 48)}" height="64" rx="12" fill="#6056d9"/><text x="48" y="65" font-family="system-ui" font-size="24" fill="white">${title}</text><text x="48" y="140" font-family="system-ui" font-size="18" fill="#24232a">Deterministic fixture preview</text></svg>`; }
function healthFor(definition) { if (definition.previewState === "running") return "healthy"; if (definition.previewState === "recovering") return "recovered"; if (["failed", "offline"].includes(definition.previewState)) return "unhealthy"; return definition.previewState; }
function preset(id, label, width, height) { return Object.freeze({ id, label, width, height, custom: false, zoom: "fit" }); }
function boundedDimension(value) { const number = Number(value); return Number.isInteger(number) && number >= 240 && number <= 3840 ? number : null; }
function positiveInt(value) { return Number.isInteger(value) && value > 0 ? value : null; }
function bounded(value) { return String(value ?? "").replace(/[\r\n\0]/g, " ").slice(0, 500); }
function digest(value) { let hash = 0x811c9dc5; for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193) >>> 0; return hash.toString(16).padStart(8, "0"); }
function recordCall(calls, sequence, action, seed, now) { const call = Object.freeze({ sequence, requestId: `fixture-d10-${digest(`${seed}:${sequence}:${action.type}`)}`, type: action.type, observedAt: now().toISOString(), input: Object.freeze({ projectId: bounded(action.project?.id || ""), commandId: bounded(action.commandId || ""), presetId: bounded(action.presetId || ""), userInitiated: action.userInitiated === true }) }); calls.push(call); return call; }
function ok(state, data = {}) { return Object.freeze({ ok: true, state, sideEffects: true, source: "desktop_foundation", ...data }); }
function unavailable(code, capability) { return Object.freeze({ ok: false, code, state: "capability_unavailable", capability, sideEffects: false }); }
function safeClone(value) { if (Array.isArray(value)) return Object.freeze(value.map(safeClone)); if (value && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).filter(([key]) => !["headers", "cookies", "requestBody", "responseBody", "authorization"].includes(key)).map(([key, item]) => [key, safeClone(typeof item === "string" ? redactText(item) : item)]))); return value; }
function escapeXml(value) { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }

module.exports = {
  PREVIEW_SOURCES, PREVIEW_STATES, PORT_STATES, TEST_STATES, VIEWPORT_PRESETS,
  D10_FIXTURE_SEED, D10_FIXTURE_CLOCK, D10_SCENARIOS, getD10Scenario,
  createPreviewController, safePreviewPath, safeLocalPreviewUrl, safeRelativeFile,
  redactText, redactUrl, networkDiagnostic, consoleDiagnostic, runtimeDiagnostic,
};
