// Code OSS host adapter for the D9 fixture product surface. The webview is local-only;
// every message is allowlisted and routed to D1/D3 fixtures or D8 native host actions.

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { NAVIGATION_ITEMS, createDesktopProductController } = require("./desktopProduct.js");
const { renderDesktopProductHtml } = require("./desktopProductView.js");
const { createLocalPreviewRuntime } = require("./previewLocalRuntime.js");
const { safeLocalPreviewUrl, safeRelativeFile } = require("./previewFoundation.js");
const { createDeploymentLocalExportAdapter } = require("./deploymentLocalExport.js");
const { HANDOFFS, redactSensitive } = require("./settingsFoundation.js");
const { createCompanionPortalHandoff } = require("./companionFoundation.js");

const HOST_ACTIONS = Object.freeze(["openLocalFolder", "openLocalGit", "importLocal"]);

function createDesktopProductHost({
  vscode,
  context,
  output,
  localWorkspaceHost,
  scenario = "authenticated-paid",
  previewScenario = "preview-idle",
  deploymentScenario = "live-healthy",
  settingsScenario = "supabase-healthy",
  companionScenario = "first-companion-launch",
  client: injectedClient = null,
} = {}) {
  if (!vscode || !context || !localWorkspaceHost) throw new TypeError("D9 host requires Code OSS, extension context, and the D8 local workspace host");
  let panel = null;
  let controller = null;
  let client = injectedClient;
  let portal = null;
  let companionPortal = null;
  let localPreviewRuntime = null;

  async function initialize() {
    client ||= await loadSharedClient(context.extensionUri?.fsPath || path.resolve(__dirname, ".."));
    localPreviewRuntime ||= createLocalPreviewRuntime({
      registry: localWorkspaceHost.registry,
      artifactRoot: context.storageUri?.fsPath ? path.join(context.storageUri.fsPath, "preview-artifacts") : null,
    });
    const deploymentExportAdapter = createDeploymentLocalExportAdapter({ root: context.storageUri?.fsPath ? path.join(context.storageUri.fsPath, "deployment-exports") : null });
    controller ||= await createDesktopProductController({
      client,
      localRegistry: localWorkspaceHost.registry,
      stateStore: context.workspaceState || context.globalState,
      scenario,
      previewScenario,
      localPreviewAdapter: localPreviewRuntime,
      deploymentScenario,
      deploymentExportAdapter,
      settingsScenario,
      companionScenario,
    });
    portal ||= client.createPortalHandoff({
      openExternal: async (url) => vscode.env.openExternal(vscode.Uri.parse(url)),
    });
    companionPortal ||= createCompanionPortalHandoff({
      openExternal: async (url) => vscode.env.openExternal(vscode.Uri.parse(url)),
    });
    return controller;
  }

  async function open(destination = "home") {
    await initialize();
    const navigation = NAVIGATION_ITEMS.find((item) => item.id === destination);
    if (!navigation || navigation.kind !== "thrallo") destination = "home";
    if (controller.snapshot().navigation.current !== destination) await controller.dispatch({ type: "navigate", destination });
    if (panel) {
      panel.reveal(vscode.ViewColumn.One, true);
      render();
      return panel;
    }
    panel = vscode.window.createWebviewPanel(
      "thralloDesktop",
      "Thrallo",
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    panel.onDidDispose(() => { panel = null; });
    panel.webview.onDidReceiveMessage((message) => handleMessage(message).catch((error) => {
      log(`Thrallo desktop action failed: ${safeMessage(error)}`);
      vscode.window.showErrorMessage("Thrallo could not complete that fixture action.");
    }));
    render();
    return panel;
  }

  async function handleMessage(message) {
    if (!message || typeof message.type !== "string") return unavailable("invalid_message");
    if (message.type === "navigate") {
      const item = NAVIGATION_ITEMS.find((entry) => entry.id === message.destination);
      if (!item || !item.enabled) return unavailable(item?.state || "capability_unavailable");
      if (item.kind === "code_oss") {
        if (item.id === "terminal") await localWorkspaceHost.openLocalTerminal().catch(() => vscode.commands.executeCommand(item.command));
        else await vscode.commands.executeCommand(item.command);
        return Object.freeze({ ok: true, state: "native_code_oss_opened", destination: item.id });
      }
      await controller.dispatch({ type: "navigate", destination: item.id });
      render();
      return Object.freeze({ ok: true, state: "rendered" });
    }
    if (message.type === "hostAction") return handleHostAction(message.action);
    if (message.type === "selectProject") {
      const response = await controller.dispatch({ type: "select_project", projectId: String(message.projectId || "") });
      if (response.result.ok && response.result.local) await localWorkspaceHost.openWorkspaceById(response.result.projectId);
      else render();
      return response.result;
    }
    if (message.type === "openPreview") return dispatchAndRender({ type: "open_preview", projectId: String(message.projectId || "") });
    if (message.type === "previewAction") {
      if (message.action?.type === "open_external") return openPreviewExternal();
      if (message.action?.type === "copy_diagnostics") return copyDiagnostics();
      return dispatchAndRender({ type: "preview_action", action: message.action });
    }
    if (message.type === "openDiagnosticSource") return openDiagnosticSource(message);
    if (message.type === "deploymentAction") {
      const response = await controller.dispatch({ type: "deployment_action", action: message.action });
      if (response.result.state === "fixture_dns_instructions_ready") await vscode.env.clipboard.writeText(JSON.stringify(response.result.instructions, null, 2));
      render();
      return response.result;
    }
    if (message.type === "settingsAction") return dispatchAndRender({ type: "settings_action", action: message.action });
    if (message.type === "settingsHandoff") return openSettingsHandoff(String(message.destination || ""));
    if (message.type === "companionAction") return dispatchAndRender({ type: "companion_action", action: message.action });
    if (message.type === "companionPortal") {
      const result = await companionPortal.open(String(message.destination || ""));
      if (!result.ok) { render(); return result; }
      return Object.freeze({ ok: true, state: "system_browser_opened", destination: result.destination, pathname: result.pathname });
    }
    if (message.type === "sendMessage") return dispatchAndRender({ type: "send_message", text: message.text });
    if (message.type === "planDecision") return dispatchAndRender({ type: "plan_decision", planId: message.planId, decision: message.decision, comment: message.comment });
    if (message.type === "agentControl") return dispatchAndRender({ type: "agent_control", agentId: message.agentId, control: message.control });
    if (message.type === "selectModel") return dispatchAndRender({ type: "select_model", modelId: message.modelId });
    if (message.type === "advanceFixtureBuild") return dispatchAndRender({ type: "advance_fixture_build" });
    if (message.type === "portal") {
      const descriptor = await portal.open(String(message.destination || ""));
      return Object.freeze({ ok: true, state: "system_browser_opened", destination: descriptor.destination });
    }
    return unavailable("unsupported_message");
  }

  async function copyDiagnostics() {
    const state = controller.snapshot().preview;
    const summary = JSON.stringify({ preview: { source: state.preview.source, state: state.preview.state, path: state.preview.path, health: state.preview.health }, diagnostics: state.diagnostics, testSession: state.testSession }, null, 2);
    await vscode.env.clipboard.writeText(summary);
    return Object.freeze({ ok: true, state: "redacted_diagnostics_copied", sideEffects: true });
  }

  async function openSettingsHandoff(destination) {
    const response = await controller.dispatch({ type: "settings_action", action: { type: "request_handoff", destination } });
    if (!response.result.ok) { render(); return response.result; }
    const descriptor = response.result.descriptor;
    if (descriptor.kind === "portal") {
      const opened = await portal.open(descriptor.destination);
      return Object.freeze({ ok: true, state: "system_browser_opened", destination: opened.destination });
    }
    const url = safeExternalSettingsUrl(destination, descriptor);
    if (!url) return unavailable("handoff_destination_rejected");
    await vscode.env.openExternal(vscode.Uri.parse(url));
    return Object.freeze({ ok: true, state: "system_browser_opened", destination });
  }

  async function openPreviewExternal() {
    const preview = controller.snapshot().preview.preview;
    const url = safeLocalPreviewUrl(preview.url);
    if (!url || !preview.externalAllowed) return unavailable("external_preview_unavailable");
    await vscode.env.openExternal(vscode.Uri.parse(`${url.replace(/\/$/, "")}${preview.path || "/"}`));
    return Object.freeze({ ok: true, state: "system_browser_opened", sideEffects: true });
  }

  async function openDiagnosticSource(message) {
    const relative = safeRelativeFile(message.file);
    const project = controller.snapshot().preview.project;
    if (!relative || !project.local || !project.rootPath) return unavailable("diagnostic_source_unavailable");
    const target = resolveDiagnosticSource(project.rootPath, relative);
    if (!target) return unavailable("diagnostic_source_rejected");
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
    const editor = await vscode.window.showTextDocument(document, { preview: true, viewColumn: vscode.ViewColumn.One });
    const line = Math.max(0, Number(message.line || 1) - 1);
    const column = Math.max(0, Number(message.column || 1) - 1);
    const position = new vscode.Position(line, column);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position));
    return Object.freeze({ ok: true, state: "source_opened", file: relative, line: line + 1, column: column + 1 });
  }

  async function handleHostAction(action) {
    if (!HOST_ACTIONS.includes(action)) return unavailable("host_action_rejected");
    let result;
    if (action === "openLocalFolder") result = await localWorkspaceHost.openLocalFolder();
    else if (action === "openLocalGit") result = await localWorkspaceHost.openLocalGitRepository();
    else result = await localWorkspaceHost.reviewLocalImport();
    if (panel && action === "importLocal") {
      await controller.dispatch({ type: "refresh_local_workspaces" });
      render();
    }
    return result || Object.freeze({ ok: false, state: "canceled", sideEffects: false });
  }

  async function dispatchAndRender(action) {
    const response = await controller.dispatch(action);
    render();
    return response.result;
  }

  function render() {
    if (!panel || !controller) return;
    panel.webview.html = renderDesktopProductHtml(controller.snapshot(), {
      nonce: crypto.randomBytes(18).toString("base64url"),
      cspSource: panel.webview.cspSource,
    });
  }

  function registerCommands() {
    return [
      vscode.commands.registerCommand("thrallo.openHome", () => open("home")),
      vscode.commands.registerCommand("thrallo.openConversation", () => open("conversation")),
      vscode.commands.registerCommand("thrallo.openProjects", () => open("projects")),
      vscode.commands.registerCommand("thrallo.openAgents", () => open("agents")),
      vscode.commands.registerCommand("thrallo.openUsage", () => open("usage")),
      vscode.commands.registerCommand("thrallo.openPreview", () => open("preview")),
      vscode.commands.registerCommand("thrallo.openDeployments", () => open("deployments")),
      vscode.commands.registerCommand("thrallo.openThralloSettings", () => open("settings")),
      vscode.commands.registerCommand("thrallo.openCompanion", () => open("companion")),
      Object.freeze({ dispose: () => { localPreviewRuntime?.cleanup().catch(() => {}); } }),
    ];
  }

  function log(message) { output?.appendLine?.(`[desktop] ${message}`); }
  return Object.freeze({ initialize, open, handleMessage, registerCommands, getController: () => controller, getPanel: () => panel, getLocalPreviewRuntime: () => localPreviewRuntime, getCompanionPortal: () => companionPortal });
}

async function loadSharedClient(extensionRoot) {
  const candidates = [
    path.join(extensionRoot, "shared", "thrallo-client", "src", "index.mjs"),
    path.resolve(__dirname, "..", "..", "..", "shared", "thrallo-client", "src", "index.mjs"),
  ];
  const source = candidates.find((candidate) => fs.existsSync(candidate));
  if (!source) throw new Error("The versioned shared Thrallo client is unavailable in this desktop build.");
  return import(pathToFileURL(source).href);
}

function unavailable(code) { return Object.freeze({ ok: false, code, state: "capability_unavailable", sideEffects: false }); }
function safeMessage(error) { return String(redactSensitive(String(error?.message || error || "unknown error"))).replace(/[\r\n]+/g, " ").slice(0, 240); }
function safeExternalSettingsUrl(destination, descriptor) {
  const allowed = HANDOFFS[destination];
  if (!allowed || allowed.kind !== "external" || descriptor?.url !== allowed.url) return null;
  try { const url = new URL(allowed.url); return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash ? url.toString() : null; } catch { return null; }
}
function resolveDiagnosticSource(rootPath, relativeFile, fsApi = fs) {
  const relative = safeRelativeFile(relativeFile);
  if (!rootPath || !relative) return null;
  try {
    const root = fsApi.realpathSync(path.resolve(rootPath));
    const target = path.resolve(root, relative);
    const stat = fsApi.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const realTarget = fsApi.realpathSync(target);
    const check = path.relative(root, realTarget);
    if (!check || check.startsWith("..") || path.isAbsolute(check)) return null;
    return realTarget;
  } catch { return null; }
}

module.exports = { HOST_ACTIONS, createDesktopProductHost, loadSharedClient, resolveDiagnosticSource, safeExternalSettingsUrl };
