// D10 native local-preview adapter. It starts only a D8-discovered package script after
// explicit user action, probes only bounded loopback candidates, and owns every process it stops.

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = fs.promises;
const net = require("node:net");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { safeLocalPreviewUrl, redactText, redactUrl } = require("./previewFoundation.js");

const MAX_OUTPUT_BYTES = 128 * 1024;
const MAX_PORT_CANDIDATES = 8;
const DEFAULT_PORTS = Object.freeze({ next: [3000], vite: [5173, 4173], vite_react: [5173, 4173], react: [3000], node: [3000, 8080], plain_html: [8080] });
const TEST_KINDS = new Set(["page_loads", "element_exists", "console_no_errors", "response_succeeds", "screenshot_capture", "responsive_smoke", "fixture_login_flow"]);

function createLocalPreviewRuntime({
  registry,
  now = () => new Date(),
  spawnProcess = defaultSpawnProcess,
  terminateProcess = defaultTerminateProcess,
  probePort = defaultProbePort,
  delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  playwrightFactory = defaultPlaywrightFactory,
  artifactRoot = null,
  discoveryAttempts = 24,
  discoveryIntervalMs = 250,
} = {}) {
  if (!registry?.recordPreview) throw new TypeError("D10 local preview runtime requires the D8 registry");
  const sessions = new Map();
  const testBrowsers = new Map();
  const calls = [];

  async function start({ project, commandId, userInitiated } = {}) {
    calls.push(call("start", project?.id, { commandId, userInitiated }));
    if (userInitiated !== true) return unavailable("explicit_user_action_required", "preview");
    const validated = await validateProject(project);
    if (!validated.ok) return validated;
    if (sessions.has(project.id)) return unavailable("preview_already_running", "preview");
    const command = project.previewCommands.find((item) => item.id === commandId || item.command === commandId);
    if (!command || command.autoRun === true) return unavailable("unsupported_preview_command", "preview");
    const specification = commandSpecification(command.command);
    if (!specification) return unavailable("unsupported_preview_command", "preview");
    const dependency = await dependencyState(project.rootPath);
    if (!dependency.available) return unavailable("dependencies_missing", "preview");

    const candidates = boundedCandidates(project, []);
    const occupiedBefore = new Set();
    for (const port of candidates) if (await probePort(port)) occupiedBefore.add(port);
    let child;
    try { child = spawnProcess(specification.command, specification.args, { cwd: project.rootPath }); }
    catch (error) { return failure("spawn_failed", redactText(error?.message), "exited"); }
    if (!child || !Number.isInteger(child.pid)) return failure("spawn_failed", "Preview process did not provide an owned process identifier.", "exited");
    const session = { projectId: project.id, rootPath: project.rootPath, command: command.command, commandId: command.id, child, pid: child.pid, state: "starting", portState: "starting", port: null, url: null, output: "", diagnostics: diagnostics(), exited: false, exitCode: null };
    sessions.set(project.id, session);
    attachOutput(session, child.stdout, "stdout");
    attachOutput(session, child.stderr, "stderr");
    child.once?.("exit", (code) => onExit(session, code));
    child.once?.("error", (error) => onError(session, error));
    await registry.recordPreview(project.id, command.command, { state: "starting", port: null });

    for (let attempt = 0; attempt < discoveryAttempts && !session.exited; attempt += 1) {
      const hinted = extractPorts(session.output);
      const bounded = boundedCandidates(project, hinted);
      const listening = [];
      for (const port of bounded) if (await probePort(port)) listening.push(port);
      const owned = listening.filter((port) => !occupiedBefore.has(port) || hinted.includes(port));
      if (owned.length === 1) {
        const port = owned[0];
        if (occupiedBefore.has(port) && hinted.includes(port)) {
          await stopOwnedSession(session, "port_conflict");
          return failure("port_conflict", `Port ${port} was already in use before Thrallo started this process.`, "port_conflict", session.diagnostics);
        }
        session.state = "running"; session.portState = "listening"; session.port = port; session.url = `http://127.0.0.1:${port}/`;
        await registry.recordPreview(project.id, command.command, { state: "running", port });
        return success(session, "healthy");
      }
      if (owned.length > 1) {
        session.state = "failed"; session.portState = "ambiguous";
        await stopOwnedSession(session, "ambiguous_ports");
        return failure("ambiguous_preview_ports", "More than one bounded preview port is listening.", "ambiguous", session.diagnostics);
      }
      await delay(discoveryIntervalMs);
    }
    if (session.exited) { sessions.delete(project.id); return failure("preview_process_exited", `Preview process exited with code ${session.exitCode ?? "unknown"}.`, "exited", session.diagnostics); }
    session.state = "failed"; session.portState = "timed_out";
    await stopOwnedSession(session, "port_timeout");
    return failure("preview_port_timed_out", "The explicit preview command did not open a bounded application port.", "timed_out", session.diagnostics);
  }

  async function stop({ projectId } = {}) {
    calls.push(call("stop", projectId));
    const session = sessions.get(projectId);
    if (!session) return unavailable("preview_process_not_owned", "preview");
    await stopOwnedSession(session, "user_stop");
    await registry.recordPreview(projectId, session.command, { state: "exited", exitCode: session.exitCode, port: null }).catch(() => {});
    return Object.freeze({ ok: true, state: "stopped", portState: "exited", health: "stopped", sideEffects: true, ownedPid: session.pid });
  }

  async function restart({ project, commandId, userInitiated } = {}) {
    calls.push(call("restart", project?.id, { commandId, userInitiated }));
    if (userInitiated !== true) return unavailable("explicit_user_action_required", "preview");
    if (sessions.has(project.id)) await stop({ projectId: project.id });
    return start({ project, commandId, userInitiated: true });
  }

  function status(projectId) {
    const session = sessions.get(projectId);
    return session ? success(session, session.state === "running" ? "healthy" : session.state) : unavailable("preview_process_not_owned", "preview");
  }

  async function captureScreenshot({ preview, project, viewport, metadata } = {}) {
    calls.push(call("captureScreenshot", project?.id));
    const target = safeLocalPreviewUrl(preview?.url);
    if (!target) return unavailable("local_preview_url_rejected", "screenshot");
    const root = await ensureArtifactRoot(artifactRoot);
    if (!root) return unavailable("local_artifact_storage_unavailable", "screenshot");
    let browser;
    try {
      const playwright = await playwrightFactory();
      browser = await playwright.chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: 15000 });
      const file = path.join(root, safeArtifactName(metadata.id, ".png"));
      await page.screenshot({ path: file, fullPage: false });
      return Object.freeze({ ...metadata, storage: "desktop_local", localPath: file, mimeType: "image/png", available: true });
    } catch (error) { return unavailable(classifyBrowserError(error), "screenshot"); }
    finally { await browser?.close().catch(() => {}); }
  }

  async function runTests({ sessionId: requestedSessionId, preview, project, viewport, tests } = {}) {
    calls.push(call("runTests", project?.id));
    const target = safeLocalPreviewUrl(preview?.url);
    if (!target) return unavailable("local_preview_url_rejected", "tests");
    const boundedTests = (tests || []).filter((item) => TEST_KINDS.has(item.kind)).slice(0, 12);
    if (!boundedTests.length) return unavailable("bounded_tests_required", "tests");
    const sessionId = /^local-test-[a-z0-9-]{8,80}$/.test(String(requestedSessionId || "")) ? requestedSessionId : `local-test-${digest(`${project.id}:${now().toISOString()}`)}`;
    let browser;
    const consoleItems = [];
    const networkItems = [];
    const runtimeItems = [];
    const results = [];
    const artifacts = [];
    try {
      const playwright = await playwrightFactory();
      browser = await playwright.chromium.launch({ headless: true });
      testBrowsers.set(sessionId, browser);
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
      const root = await ensureArtifactRoot(artifactRoot);
      const tracePath = root ? path.join(root, safeArtifactName(`${sessionId}-trace`, ".zip")) : null;
      if (tracePath) await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
      const page = await context.newPage();
      page.on("console", (message) => consoleItems.push({ id: `console-${consoleItems.length + 1}`, severity: normalizeSeverity(message.type()), message: redactText(message.text()), timestamp: now().toISOString(), occurrenceCount: 1, source: null }));
      page.on("pageerror", (error) => runtimeItems.push({ id: `runtime-${runtimeItems.length + 1}`, kind: "runtime_exception", message: redactText(error.message), timestamp: now().toISOString(), source: null }));
      page.on("requestfailed", (request) => networkItems.push(networkEvidence(request.method(), request.url(), null, "failed", request.resourceType(), now)));
      page.on("response", (response) => networkItems.push(networkEvidence(response.request().method(), response.url(), response.status(), response.ok() ? "completed" : "failed", response.request().resourceType(), now)));
      let loadError = null;
      const started = Date.now();
      try { await page.goto(target, { waitUntil: "domcontentloaded", timeout: 15000 }); } catch (error) { loadError = error; }
      for (const test of boundedTests) {
        const testStarted = Date.now();
        let passed = true;
        let failureSummary = null;
        try {
          if (test.kind === "page_loads" && loadError) throw loadError;
          if (test.kind === "element_exists") await page.locator(test.selector || "h1").first().waitFor({ state: "attached", timeout: 3000 });
          if (test.kind === "console_no_errors" && consoleItems.some((item) => item.severity === "error")) throw new Error("The application console contains errors.");
          if (test.kind === "response_succeeds" && networkItems.some((item) => item.state === "failed")) throw new Error("An application request failed.");
          if (test.kind === "screenshot_capture" && root) {
            const file = path.join(root, safeArtifactName(`${sessionId}-${test.id}`, ".png"));
            await page.screenshot({ path: file, fullPage: false });
            artifacts.push(Object.freeze({ id: `${sessionId}-${test.id}`, kind: "screenshot", storage: "desktop_local", localPath: file, mimeType: "image/png", localOnly: true, uploaded: false }));
          }
          if (test.kind === "responsive_smoke") await page.setViewportSize({ width: viewport.width, height: viewport.height });
        } catch (error) { passed = false; failureSummary = redactText(error?.message || error); }
        results.push(Object.freeze({ id: test.id, name: test.name, state: passed ? "passed" : "failed", durationMs: Date.now() - testStarted, failureSummary, screenshotArtifactId: artifacts.at(-1)?.id || null, traceAvailable: Boolean(tracePath), consoleEvidenceCount: consoleItems.length, networkEvidenceCount: networkItems.filter((item) => item.state === "failed").length }));
      }
      if (tracePath) { await context.tracing.stop({ path: tracePath }); artifacts.push(Object.freeze({ id: `${sessionId}-trace`, kind: "trace", storage: "desktop_local", localPath: tracePath, mimeType: "application/zip", localOnly: true, uploaded: false, available: true })); }
      await context.close();
      const failed = results.some((item) => item.state === "failed");
      return Object.freeze({ ok: true, state: failed ? "failed" : "passed", session: Object.freeze({ id: sessionId, state: failed ? "failed" : "passed", source: "local_playwright", explicit: true, startedAt: new Date(started).toISOString(), finishedAt: now().toISOString(), tests: Object.freeze(results), failureSummary: failed ? "One or more bounded local checks failed." : null }), artifacts: Object.freeze(artifacts), diagnostics: Object.freeze({ available: true, console: Object.freeze(consoleItems), network: Object.freeze(networkItems), runtime: Object.freeze(runtimeItems) }) });
    } catch (error) { return unavailable(classifyBrowserError(error), "tests"); }
    finally { testBrowsers.delete(sessionId); await browser?.close().catch(() => {}); }
  }

  async function cancelTests({ sessionId } = {}) {
    calls.push(call("cancelTests", null, { sessionId }));
    const browser = testBrowsers.get(sessionId);
    if (!browser) return unavailable("test_session_not_active", "tests");
    await browser.close().catch(() => {});
    testBrowsers.delete(sessionId);
    return Object.freeze({ ok: true, state: "canceled", sideEffects: true });
  }

  async function cleanup() {
    for (const session of [...sessions.values()]) await stopOwnedSession(session, "cleanup");
    for (const browser of [...testBrowsers.values()]) await browser.close().catch(() => {});
    testBrowsers.clear();
    return Object.freeze({ processes: sessions.size, browsers: testBrowsers.size, clean: sessions.size === 0 && testBrowsers.size === 0 });
  }

  async function stopOwnedSession(session, reason) {
    if (!sessions.has(session.projectId)) return;
    session.state = "stopping";
    await terminateProcess(session.child, session.pid);
    session.state = "stopped"; session.portState = "exited"; session.port = null; session.url = null; session.stopReason = reason;
    sessions.delete(session.projectId);
  }

  function attachOutput(session, stream, channel) {
    stream?.on?.("data", (chunk) => {
      const text = redactText(chunk.toString("utf8"));
      session.output = `${session.output}${text}`.slice(-MAX_OUTPUT_BYTES);
      if (channel === "stderr" && /error|exception|failed/i.test(text)) session.diagnostics.runtime.push(Object.freeze({ id: `runtime-${digest(`${session.pid}:${session.diagnostics.runtime.length}`)}`, kind: "dev_server_output", message: text.slice(0, 500), timestamp: now().toISOString(), source: null }));
    });
  }
  function onExit(session, code) { session.exited = true; session.exitCode = Number.isInteger(code) ? code : null; session.state = "failed"; session.portState = "exited"; }
  function onError(session, error) { session.diagnostics.runtime.push(Object.freeze({ id: `runtime-${digest(`${session.pid}:error`)}`, kind: "dev_server_disconnected", message: redactText(error?.message), timestamp: now().toISOString(), source: null })); onExit(session, null); }
  function getCalls() { return Object.freeze(calls.map((item) => Object.freeze({ ...item }))); }
  return Object.freeze({ start, stop, restart, status, captureScreenshot, runTests, cancelTests, cleanup, getCalls });
}

async function validateProject(project) {
  if (!project?.local || typeof project.rootPath !== "string" || !project.rootPath) return unavailable("local_project_required", "preview");
  if (!Array.isArray(project.previewCommands) || !project.previewCommands.length) return unavailable("preview_command_unavailable", "preview");
  try { const real = await fsp.realpath(project.rootPath); if (!samePath(real, path.resolve(project.rootPath))) return unavailable("workspace_path_mismatch", "preview"); const stat = await fsp.stat(real); if (!stat.isDirectory()) return unavailable("workspace_unavailable", "preview"); }
  catch { return unavailable("workspace_unavailable", "preview"); }
  return Object.freeze({ ok: true });
}
async function dependencyState(root) { try { const pkg = JSON.parse(await fsp.readFile(path.join(root, "package.json"), "utf8")); const needs = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }).length > 0; if (!needs) return { available: true }; try { const stat = await fsp.stat(path.join(root, "node_modules")); return { available: stat.isDirectory() }; } catch { return { available: false }; } } catch { return { available: false }; } }
function commandSpecification(command) { const match = /^(npm run|pnpm|yarn) (dev|start)$/.exec(String(command || "")); if (!match) return null; const runner = match[1] === "npm run" ? "npm" : match[1]; if (process.platform === "win32" && runner === "npm") { const cli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"); return Object.freeze({ command: process.execPath, args: Object.freeze([cli, "run", match[2]]) }); } if (process.platform === "win32") return Object.freeze({ command: process.env.ComSpec || "cmd.exe", args: Object.freeze(["/d", "/s", "/c", `${runner} ${match[2]}`]) }); return Object.freeze({ command: runner, args: Object.freeze(runner === "npm" ? ["run", match[2]] : [match[2]]) }); }
function boundedCandidates(project, hinted) { const defaults = DEFAULT_PORTS[project.workspaceType === "local_dev_server" ? "node" : project.projectType] || DEFAULT_PORTS.node; return [...new Set([...hinted, ...defaults])].filter((port) => Number.isInteger(port) && port >= 1024 && port <= 65535).slice(0, MAX_PORT_CANDIDATES); }
function extractPorts(output) { const ports = []; const patterns = [/(?:localhost|127\.0\.0\.1|\[::1\])[:\s](\d{4,5})/gi, /\bport\s+(\d{4,5})\b/gi]; for (const pattern of patterns) { let match; while ((match = pattern.exec(String(output || "")))) ports.push(Number(match[1])); } return [...new Set(ports)].filter((port) => port >= 1024 && port <= 65535).slice(0, MAX_PORT_CANDIDATES); }
function defaultSpawnProcess(command, args, options) { return spawn(command, args, { cwd: options.cwd, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"], env: process.env }); }
async function defaultTerminateProcess(child, pid) { if (!Number.isInteger(pid) || pid <= 0) return; if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); else { try { child.kill("SIGTERM"); } catch { /* already gone */ } } }
function defaultProbePort(port) { return new Promise((resolve) => { const socket = net.createConnection({ host: "127.0.0.1", port }); const done = (value) => { socket.destroy(); resolve(value); }; socket.setTimeout(300); socket.once("connect", () => done(true)); socket.once("timeout", () => done(false)); socket.once("error", () => done(false)); }); }
async function defaultPlaywrightFactory() { try { return require("playwright"); } catch { const error = new Error("Playwright is not packaged in this desktop environment."); error.code = "PLAYWRIGHT_UNAVAILABLE"; throw error; } }
async function ensureArtifactRoot(root) { if (!root) return null; const resolved = path.resolve(root); await fsp.mkdir(resolved, { recursive: true }); return resolved; }
function safeArtifactName(id, extension) { return `${String(id || "artifact").replace(/[^a-z0-9_-]/gi, "-").slice(0, 120)}${extension}`; }
function success(session, health) { return Object.freeze({ ok: true, state: session.state, portState: session.portState, health, port: session.port, url: safeLocalPreviewUrl(session.url), command: session.command, diagnostics: Object.freeze({ available: true, console: Object.freeze(session.diagnostics.console), network: Object.freeze(session.diagnostics.network), runtime: Object.freeze(session.diagnostics.runtime) }), sideEffects: true, ownedPid: session.pid }); }
function failure(code, message, portState, diagnosticState = diagnostics()) { const runtime = [...(diagnosticState.runtime || []), Object.freeze({ id: `runtime-${digest(`${code}:${message}`)}`, kind: "dev_server_disconnected", message: redactText(message), timestamp: new Date(0).toISOString(), source: null })]; return Object.freeze({ ok: false, code, state: "failed", portState, diagnostics: Object.freeze({ available: true, console: Object.freeze(diagnosticState.console || []), network: Object.freeze(diagnosticState.network || []), runtime: Object.freeze(runtime) }), sideEffects: false }); }
function unavailable(code, capability) { return Object.freeze({ ok: false, code, state: "capability_unavailable", portState: "unavailable", capability, sideEffects: false }); }
function diagnostics() { return { console: [], network: [], runtime: [] }; }
function networkEvidence(method, rawUrl, status, state, type, now) { let pathValue = "/"; try { const url = new URL(rawUrl); pathValue = redactUrl(`${url.pathname}${url.search}`); } catch { pathValue = "[invalid-path]"; } return Object.freeze({ id: `network-${digest(`${method}:${pathValue}:${status}`)}`, method: String(method).slice(0, 12), path: pathValue, status: Number.isInteger(status) ? status : null, state, durationMs: null, type: String(type).slice(0, 40), sizeBytes: null, timestamp: now().toISOString() }); }
function normalizeSeverity(value) { return value === "warn" ? "warning" : ["log", "info", "warning", "error"].includes(value) ? value : "log"; }
function classifyBrowserError(error) { if (error?.code === "PLAYWRIGHT_UNAVAILABLE") return "playwright_unavailable"; if (/executable.*doesn.t exist|browser.*install/i.test(String(error?.message))) return "browser_binary_unavailable"; return "browser_test_failed"; }
function samePath(left, right) { return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right; }
function call(operation, projectId, input = {}) { return Object.freeze({ operation, projectId: String(projectId || "").slice(0, 120), commandId: String(input.commandId || "").replace(/[^a-z0-9:_-]/gi, "").slice(0, 100), userInitiated: input.userInitiated === true, sessionId: String(input.sessionId || "").replace(/[^a-z0-9:_-]/gi, "").slice(0, 100) }); }
function digest(value) { return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12); }

module.exports = { createLocalPreviewRuntime, commandSpecification, extractPorts, defaultProbePort };
