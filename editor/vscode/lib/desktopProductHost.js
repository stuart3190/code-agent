// Code OSS host adapter for the D9 fixture product surface. The webview is local-only;
// every message is allowlisted and routed to D1/D3 fixtures or D8 native host actions.

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { NAVIGATION_ITEMS, createDesktopProductController } = require("./desktopProduct.js");
const { renderDesktopProductHtml } = require("./desktopProductView.js");

const HOST_ACTIONS = Object.freeze(["openLocalFolder", "openLocalGit", "importLocal"]);

function createDesktopProductHost({
  vscode,
  context,
  output,
  localWorkspaceHost,
  scenario = "authenticated-paid",
  client: injectedClient = null,
} = {}) {
  if (!vscode || !context || !localWorkspaceHost) throw new TypeError("D9 host requires Code OSS, extension context, and the D8 local workspace host");
  let panel = null;
  let controller = null;
  let client = injectedClient;
  let portal = null;

  async function initialize() {
    client ||= await loadSharedClient(context.extensionUri?.fsPath || path.resolve(__dirname, ".."));
    controller ||= await createDesktopProductController({
      client,
      localRegistry: localWorkspaceHost.registry,
      stateStore: context.workspaceState || context.globalState,
      scenario,
    });
    portal ||= client.createPortalHandoff({
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
      log(`D9 action failed: ${safeMessage(error)}`);
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
    ];
  }

  function log(message) { output?.appendLine?.(`[desktop] ${message}`); }
  return Object.freeze({ initialize, open, handleMessage, registerCommands, getController: () => controller, getPanel: () => panel });
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
function safeMessage(error) { return String(error?.message || error || "unknown error").replace(/[\r\n]+/g, " ").slice(0, 240); }

module.exports = { HOST_ACTIONS, createDesktopProductHost, loadSharedClient };
