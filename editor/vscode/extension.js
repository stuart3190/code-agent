// Thrallo VS Code extension: browse agents, launch cloud runs, follow the live timeline,
// review the diff, and approve or decline pull-request publication — all against the same
// owner-scoped v1 API the web workspace uses, authenticated with a personal access token.

"use strict";

const vscode = require("vscode");
const { ThralloClient, describeEvent, TERMINAL_STATES } = require("./lib/api.js");

const TOKEN_KEY = "thrallo.apiToken";

let client = null;
let output = null;
let treeProvider = null;

function activate(context) {
  output = vscode.window.createOutputChannel("Thrallo");
  treeProvider = new AgentTreeProvider();
  context.subscriptions.push(
    output,
    vscode.window.registerTreeDataProvider("thralloAgents", treeProvider),
    vscode.commands.registerCommand("thrallo.connect", () => connect(context)),
    vscode.commands.registerCommand("thrallo.disconnect", () => disconnect(context)),
    vscode.commands.registerCommand("thrallo.refresh", () => treeProvider.refresh()),
    vscode.commands.registerCommand("thrallo.runTask", (item) => runTask(item)),
    vscode.commands.registerCommand("thrallo.showLatestRun", (item) => showLatestRun(item)),
  );
  restoreConnection(context);
}

async function restoreConnection(context) {
  const token = await context.secrets.get(TOKEN_KEY);
  if (!token) return;
  buildClient(token);
  treeProvider.refresh();
}

function serverUrl() {
  return vscode.workspace.getConfiguration("thrallo").get("serverUrl") || "https://app.thrallo.com";
}

function buildClient(token) {
  client = new ThralloClient({ serverUrl: serverUrl(), token });
}

async function connect(context) {
  const token = await vscode.window.showInputBox({
    prompt: `Paste a Thrallo API token from ${serverUrl()} → Settings → API tokens`,
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => (value?.startsWith("thrallo_pat_") ? null : "Tokens start with thrallo_pat_"),
  });
  if (!token) return;
  buildClient(token.trim());
  try {
    await client.listAgents();
  } catch (error) {
    client = null;
    vscode.window.showErrorMessage(`Thrallo connection failed: ${error.message}`);
    return;
  }
  await context.secrets.store(TOKEN_KEY, token.trim());
  vscode.window.showInformationMessage("Connected to Thrallo.");
  treeProvider.refresh();
}

async function disconnect(context) {
  await context.secrets.delete(TOKEN_KEY);
  client = null;
  treeProvider.refresh();
  vscode.window.showInformationMessage("Disconnected from Thrallo.");
}

async function runTask(item) {
  const agent = await pickAgent(item);
  if (!agent) return;
  const prompt = await vscode.window.showInputBox({
    prompt: `Task for ${agent.name}`,
    placeHolder: "Describe a change, bug, or feature…",
    ignoreFocusOut: true,
  });
  if (!prompt?.trim()) return;
  try {
    const { run } = await client.createRun(agent.id, prompt.trim(), agent.mode || "agent");
    output.show(true);
    output.appendLine(`\n─── Run ${run.id} on ${agent.name} ───`);
    await followRun(run.id);
  } catch (error) {
    vscode.window.showErrorMessage(`Thrallo: ${error.message}`);
  }
}

async function followRun(runId) {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Thrallo agent is working…", cancellable: true },
    async (progress, cancellation) => {
      const controller = new AbortController();
      cancellation.onCancellationRequested(async () => {
        controller.abort();
        await client.cancelRun(runId).catch(() => {});
        output.appendLine("Cancellation requested.");
      });
      try {
        await client.streamRunEvents(runId, (event) => {
          output.appendLine(describeEvent(event));
          const message = event.payload?.message;
          if (message) progress.report({ message: String(message).slice(0, 80) });
        }, { signal: controller.signal });
      } catch (error) {
        if (error.name !== "AbortError") output.appendLine(`Stream ended: ${error.message}`);
      }
    },
  );
  await presentRunOutcome(runId);
  treeProvider.refresh();
}

async function presentRunOutcome(runId) {
  let run;
  try {
    run = (await client.getRun(runId)).run;
  } catch {
    return;
  }
  if (!run) return;
  if (run.state === "waiting_for_approval") {
    await showDiff(runId);
    const choice = await vscode.window.showInformationMessage(
      "Thrallo finished with changes. Approve to commit, push, and open a pull request?",
      { modal: true },
      "Approve & open PR",
      "Decline & discard",
    );
    if (choice === "Approve & open PR") {
      try {
        const published = (await client.publishRun(runId)).run;
        const pr = published.result?.publication?.pullRequest;
        if (pr?.url) {
          const open = await vscode.window.showInformationMessage(`Pull request #${pr.number} published.`, "Open PR");
          if (open) vscode.env.openExternal(vscode.Uri.parse(pr.url));
        }
      } catch (error) {
        vscode.window.showErrorMessage(`Publication failed: ${error.message}`);
      }
    } else if (choice === "Decline & discard") {
      await client.cancelRun(runId).catch(() => {});
      vscode.window.showInformationMessage("Workspace discarded.");
    }
    return;
  }
  if (run.state === "succeeded") {
    vscode.window.showInformationMessage(`Thrallo run succeeded: ${run.result?.summary?.slice(0, 120) || "done"}`);
  } else if (TERMINAL_STATES.has(run.state)) {
    const actions = run.resumable ? ["Resume run"] : [];
    const choice = await vscode.window.showWarningMessage(
      `Thrallo run ${run.state}: ${run.error || "no details"}`,
      ...actions,
    );
    if (choice === "Resume run") {
      const { run: resumed } = await client.resumeRun(runId);
      output.appendLine(`\n─── Resumed as ${resumed.id} ───`);
      await followRun(resumed.id);
    }
  }
}

async function showDiff(runId) {
  try {
    const { artifacts } = await client.runArtifacts(runId);
    const diff = artifacts.find((artifact) => artifact.type === "diff");
    if (!diff?.content) return;
    const document = await vscode.workspace.openTextDocument({ language: "diff", content: diff.content });
    await vscode.window.showTextDocument(document, { preview: true, viewColumn: vscode.ViewColumn.Beside });
  } catch { /* diff view is best-effort */ }
}

async function showLatestRun(item) {
  const agent = await pickAgent(item);
  if (!agent) return;
  try {
    const { run } = await client.latestRun(agent.id);
    if (!run) return vscode.window.showInformationMessage("This agent has no runs yet.");
    output.show(true);
    output.appendLine(`\n─── Latest run ${run.id} (${run.state}) ───`);
    if (TERMINAL_STATES.has(run.state) || run.state === "waiting_for_approval") {
      await presentRunOutcome(run.id);
    } else {
      await followRun(run.id);
    }
  } catch (error) {
    vscode.window.showErrorMessage(`Thrallo: ${error.message}`);
  }
}

async function pickAgent(item) {
  if (!client) {
    vscode.window.showWarningMessage("Connect to Thrallo first (Thrallo: Connect).");
    return null;
  }
  if (item?.agent) return item.agent;
  const { agents } = await client.listAgents();
  if (!agents.length) {
    vscode.window.showInformationMessage("No agents yet — connect a repository in the Thrallo web workspace.");
    return null;
  }
  const picked = await vscode.window.showQuickPick(
    agents.map((agent) => ({ label: agent.name, description: agent.mode, agent })),
    { placeHolder: "Choose a Thrallo agent" },
  );
  return picked?.agent || null;
}

class AgentTreeProvider {
  constructor() {
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
  }

  refresh() {
    this.emitter.fire();
  }

  getTreeItem(element) {
    return element;
  }

  async getChildren() {
    if (!client) {
      const item = new vscode.TreeItem("Connect to Thrallo…");
      item.command = { command: "thrallo.connect", title: "Connect" };
      return [item];
    }
    try {
      const [{ agents }, { repositories }] = await Promise.all([
        client.listAgents(),
        client.listRepositories(),
      ]);
      const repoNames = new Map(repositories.map((repo) => [repo.id, repo.fullName]));
      return agents.map((agent) => {
        const item = new vscode.TreeItem(agent.name);
        item.description = repoNames.get(agent.repositoryId) || agent.mode;
        item.contextValue = "agent";
        item.agent = agent;
        item.iconPath = new vscode.ThemeIcon("hubot");
        item.command = { command: "thrallo.runTask", title: "Run task", arguments: [{ agent }] };
        return item;
      });
    } catch (error) {
      const item = new vscode.TreeItem(`Error: ${error.message}`);
      item.iconPath = new vscode.ThemeIcon("warning");
      return [item];
    }
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
