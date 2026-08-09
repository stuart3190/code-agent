// VS Code host adapter for D8. It coordinates built-in Code OSS folder, editor, SCM and
// terminal primitives. It never uploads a folder and never runs a project command on open.

"use strict";

const {
  LocalWorkspaceRegistry,
  createImportManifest,
  inspectLocalWorkspace,
  workspaceModeCapability,
} = require("./localWorkspace.js");

function createLocalWorkspaceHost({ vscode, context, output, now = () => new Date() }) {
  if (!vscode || !context) throw new TypeError("D8 local workspace host requires vscode and extension context.");
  const registry = new LocalWorkspaceRegistry({ state: context.globalState, now });
  const previewTerminals = new Map();
  const localTerminals = new Map();

  async function initialize() {
    const current = currentFolder();
    if (current) {
      await registry.open(current.fsPath, { restoreOnStartup: true }).catch((error) => log(`Local workspace inspection unavailable: ${safeMessage(error)}`));
      return { state: "current_workspace" };
    }
    const recovery = await registry.recovery();
    if (recovery.action === "reopen" && recovery.workspace) {
      await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(recovery.workspace.realPath), false);
    } else if (["missing_folder", "inaccessible_folder", "corrupt_metadata"].includes(recovery.state)) {
      vscode.window.showWarningMessage(recoveryMessage(recovery.state));
    }
    return recovery;
  }

  async function openLocalFolder() {
    const selected = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: "Open Local Workspace", title: "Open a local folder in Thrallo" });
    if (!selected?.[0]) return null;
    const recovery = await registry.recovery([selected[0].fsPath]);
    const workspace = recovery.state === "moved"
      ? recovery.workspace
      : await registry.open(selected[0].fsPath, { restoreOnStartup: true });
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(workspace.realPath), false);
    return workspace;
  }

  async function openLocalGitRepository() {
    const selected = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: "Open Local Git Repository", title: "Choose an existing local Git repository" });
    if (!selected?.[0]) return null;
    const inspected = await inspectLocalWorkspace(selected[0].fsPath);
    if (!inspected.git?.detected) {
      vscode.window.showWarningMessage("That folder is not an existing Git repository. Thrallo did not initialize or modify it.");
      return Object.freeze({ ok: false, code: "git_repository_not_detected", state: "capability_unavailable", sideEffects: false });
    }
    const workspace = await registry.open(inspected.realPath, { mode: "local_git_repository", restoreOnStartup: true });
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(workspace.realPath), false);
    return workspace;
  }

  async function openWorkspaceById(workspaceId) {
    const recent = await registry.recent();
    const selected = recent.find((workspace) => workspace.id === workspaceId);
    if (!selected) return Object.freeze({ ok: false, code: "local_workspace_unknown", state: "capability_unavailable", sideEffects: false });
    if (selected.availability !== "available") return Object.freeze({ ok: false, code: selected.availability, state: "capability_unavailable", sideEffects: false });
    const workspace = await registry.open(selected.realPath, { mode: selected.mode, restoreOnStartup: true });
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(workspace.realPath), false);
    return workspace;
  }

  async function openRecentWorkspace() {
    const recent = await registry.recent();
    if (!recent.length) { vscode.window.showInformationMessage("No recent local Thrallo workspaces."); return null; }
    const picked = await vscode.window.showQuickPick(recent.map((workspace) => ({
      label: workspace.displayName,
      description: workspace.realPath,
      detail: workspace.availability === "available" ? `${workspace.projectType} - ${workspace.mode}` : `Unavailable: ${workspace.availability}`,
      workspace,
    })), { placeHolder: "Reopen a recent local workspace" });
    if (!picked) return null;
    if (picked.workspace.availability !== "available") {
      vscode.window.showWarningMessage("That local folder is missing or inaccessible. Use Open Local Folder to locate it.");
      return null;
    }
    const workspace = await registry.open(picked.workspace.realPath, { mode: picked.workspace.mode, restoreOnStartup: true });
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(workspace.realPath), false);
    return workspace;
  }

  async function showLocalStatus() {
    const root = requireCurrentRoot();
    const workspace = await registry.open(root.fsPath, { restoreOnStartup: true });
    return showJsonDocument("Thrallo Local Workspace", presentationWorkspace(workspace));
  }

  async function reviewLocalImport() {
    const current = currentFolder();
    let folder = current;
    if (!folder) {
      const selected = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: "Review Local Import", title: "Choose a local project to review" });
      folder = selected?.[0] || null;
    }
    if (!folder) return null;
    const manifest = await createImportManifest(folder.fsPath);
    await registry.open(folder.fsPath, { mode: "imported_local_project", restoreOnStartup: Boolean(current) });
    await showJsonDocument("Thrallo Local Import Review", manifest);
    vscode.window.showInformationMessage(`Local review only: ${manifest.summary.includedFileCount} included, ${manifest.summary.excludedEntryCount} excluded. Nothing was uploaded.`);
    return manifest;
  }

  async function openLocalTerminal() {
    const root = requireCurrentRoot();
    const terminal = vscode.window.createTerminal({ name: `Thrallo - ${root.name}`, cwd: root.uri || root });
    localTerminals.set(terminal, Object.freeze({ state: "running", rootPath: root.fsPath, exitCode: null }));
    terminal.show(false);
    return terminal;
  }

  async function startLocalPreview() {
    const root = requireCurrentRoot();
    const workspace = await inspectLocalWorkspace(root.fsPath);
    if (!workspace.previewCommands.length) {
      vscode.window.showInformationMessage("No supported local preview command was detected. Thrallo did not run anything.");
      return null;
    }
    const picked = await vscode.window.showQuickPick(workspace.previewCommands.map((item) => ({ label: item.label, description: "Runs only after this explicit selection", command: item })), { placeHolder: "Choose a local preview command to run" });
    if (!picked) return null;
    const registered = await registry.open(root.fsPath, { restoreOnStartup: true });
    const terminal = vscode.window.createTerminal({ name: `Thrallo Preview - ${root.name}`, cwd: root.uri || root });
    localTerminals.set(terminal, Object.freeze({ state: "running", rootPath: root.fsPath, exitCode: null }));
    previewTerminals.set(terminal, { workspaceId: registered.id, command: picked.command.command });
    await registry.recordPreview(registered.id, picked.command.command, { state: "running", port: null });
    terminal.show(false);
    terminal.sendText(picked.command.command, true);
    return { terminal, command: picked.command, state: "running", port: null, userInitiated: true };
  }

  async function onTerminalClosed(terminal) {
    const local = localTerminals.get(terminal);
    if (local) {
      const exitCode = Number.isInteger(terminal.exitStatus?.code) ? terminal.exitStatus.code : null;
      localTerminals.set(terminal, Object.freeze({ ...local, state: "exited", exitCode }));
    }
    const tracked = previewTerminals.get(terminal);
    if (!tracked) return;
    previewTerminals.delete(terminal);
    const code = Number.isInteger(terminal.exitStatus?.code) ? terminal.exitStatus.code : null;
    await registry.recordPreview(tracked.workspaceId, tracked.command, { state: "exited", exitCode: code, port: null }).catch((error) => log(`Preview exit could not be recorded: ${safeMessage(error)}`));
  }

  function terminalStatus(terminal) {
    return localTerminals.get(terminal) || Object.freeze({ state: "untracked", rootPath: null, exitCode: null });
  }

  function associationBoundary() {
    return Object.freeze({
      current: workspaceModeCapability("future_thrallo_project"),
      futureFlow: Object.freeze(["explicit_user_request", "D7_canonical_project_association", "review_exclusions", "create_working_set", "verified_synchronization"]),
      uploadImplemented: false,
      syncImplemented: false,
    });
  }

  function registerCommands() {
    return [
      vscode.commands.registerCommand("thrallo.local.openFolder", openLocalFolder),
      vscode.commands.registerCommand("thrallo.local.openRecent", openRecentWorkspace),
      vscode.commands.registerCommand("thrallo.local.showStatus", showLocalStatus),
      vscode.commands.registerCommand("thrallo.local.reviewImport", reviewLocalImport),
      vscode.commands.registerCommand("thrallo.local.openTerminal", openLocalTerminal),
      vscode.commands.registerCommand("thrallo.local.startPreview", startLocalPreview),
      vscode.window.onDidCloseTerminal(onTerminalClosed),
    ];
  }

  function currentFolder() {
    const folders = vscode.workspace.workspaceFolders || [];
    const active = vscode.window.activeTextEditor?.document?.uri;
    const activeFolder = active ? vscode.workspace.getWorkspaceFolder?.(active) : null;
    return activeFolder?.uri || folders[0]?.uri || null;
  }

  function requireCurrentRoot() {
    const uri = currentFolder();
    if (!uri || uri.scheme !== "file") throw new Error("Open a local folder before using this command.");
    const folder = (vscode.workspace.workspaceFolders || []).find((item) => item.uri.fsPath === uri.fsPath);
    return { uri, fsPath: uri.fsPath, name: folder?.name || uri.fsPath.split(/[\\/]/).filter(Boolean).at(-1) || "Workspace" };
  }

  async function showJsonDocument(title, value) {
    const document = await vscode.workspace.openTextDocument({ language: "json", content: JSON.stringify(value, null, 2) });
    await vscode.window.showTextDocument(document, { preview: true, viewColumn: vscode.ViewColumn.Beside });
    log(`${title}: local-only data shown in an untitled editor.`);
    return document;
  }

  function log(message) { output?.appendLine?.(`[local] ${message}`); }

  return Object.freeze({ initialize, openLocalFolder, openLocalGitRepository, openWorkspaceById, openRecentWorkspace, showLocalStatus, reviewLocalImport, openLocalTerminal, startLocalPreview, onTerminalClosed, terminalStatus, associationBoundary, registerCommands, registry });
}

function presentationWorkspace(workspace) {
  return {
    mode: workspace.mode,
    displayName: workspace.displayName,
    path: workspace.path,
    writable: workspace.writable,
    projectType: workspace.projectType,
    detection: workspace.detection,
    git: workspace.git,
    previewCommands: workspace.previewCommands,
    lastOpenedAt: workspace.lastOpenedAt,
    recovery: workspace.recovery,
    association: workspace.association,
  };
}

function recoveryMessage(state) {
  if (state === "corrupt_metadata") return "Thrallo recovered corrupt local workspace history. Your project files were not changed.";
  if (state === "missing_folder") return "The previous local workspace has moved or is missing. Open its new location to recover it.";
  return "The previous local workspace is inaccessible to the current user.";
}

function safeMessage(error) { return String(error?.message || error || "unknown error").replace(/[\r\n]+/g, " ").slice(0, 240); }

module.exports = { createLocalWorkspaceHost, presentationWorkspace };
