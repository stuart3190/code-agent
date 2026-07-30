import { optionalEnv } from "./env.mjs";
import { createInstallationToken, createPullRequest } from "./githubApp.mjs";

export function daytonaConfigured() {
  return !!optionalEnv("DAYTONA_API_KEY");
}

export async function createDaytonaRunner({ run, repository, emit }) {
  if (!daytonaConfigured()) {
    const error = new Error("Daytona is not connected. Set DAYTONA_API_KEY on the server.");
    error.code = "daytona_setup_required";
    throw error;
  }
  const { Daytona } = await import("@daytona/sdk");
  const daytona = new Daytona();
  const sandbox = await daytona.create({
    language: "typescript",
    autoStopInterval: Number(optionalEnv("DAYTONA_AUTO_STOP_MINUTES", "30")),
    autoArchiveInterval: Number(optionalEnv("DAYTONA_AUTO_ARCHIVE_MINUTES", "120")),
    autoDeleteInterval: Number(optionalEnv("DAYTONA_AUTO_DELETE_MINUTES", "1440")),
  });
  await emit("sandbox.created", { sandboxId: sandbox.id, message: "Secure workspace ready" });
  const workspacePath = await resolveSandboxRepositoryPath(sandbox);

  const token = repository.installation_id
    ? (await createInstallationToken(repository.installation_id)).token
    : optionalEnv("GITHUB_AGENT_TOKEN");
  await sandbox.git.clone(
    repository.clone_url,
    workspacePath,
    run.base_branch,
    undefined,
    token ? "x-access-token" : undefined,
    token || undefined,
    false,
    50,
  );
  const branch = `code-agent/${run.id.slice(0, 8)}`;
  await sandbox.git.createBranch(workspacePath, branch);
  await emit("repository.cloned", { branch, message: `Checked out ${repository.full_name}` });

  return {
    id: sandbox.id,
    branch,
    async runCodex({ prompt, authJson, isCancelled = async () => false }) {
      if (await isCancelled()) return { cancelled: true, provider: "codex", model: "codex-subscription", usage: {} };
      return runCodexInSandbox({
        sandbox,
        workspacePath,
        run,
        prompt,
        authJson,
      });
    },
    async listFiles(path = ".", depth = 4) {
      const safe = safeRelative(path);
      const result = await sandbox.process.executeCommand(
        `find ${shellQuote(safe)} -maxdepth ${Math.min(Math.max(Number(depth) || 4, 1), 8)} -type f | sort | head -400`,
        workspacePath, undefined, 20,
      );
      return commandResult(result);
    },
    async listIndexFiles() {
      const result = await sandbox.process.executeCommand(
        "git ls-files -co --exclude-standard -z",
        workspacePath, undefined, 30,
      );
      const checked = commandResult(result);
      return checked.output.split("\0").filter(Boolean);
    },
    async readIndexFile(path, maxBytes = 350_000) {
      const safe = safeRelative(path);
      const buffer = await sandbox.fs.downloadFile(`${workspacePath}/${safe}`);
      if (buffer.length > maxBytes || buffer.subarray(0, 8_192).includes(0)) return null;
      return { content: buffer.toString("utf8"), sizeBytes: buffer.length };
    },
    async readFile(path) {
      const buffer = await sandbox.fs.downloadFile(`${workspacePath}/${safeRelative(path)}`);
      return buffer.toString("utf8").slice(0, 200_000);
    },
    async writeFile(path, content) {
      const safe = safeRelative(path);
      const parent = safe.split("/").slice(0, -1).join("/");
      if (parent) {
        await sandbox.process.executeCommand(`mkdir -p ${shellQuote(parent)}`, workspacePath, undefined, 20);
      }
      await sandbox.fs.uploadFile(Buffer.from(String(content), "utf8"), `${workspacePath}/${safe}`);
      return { ok: true, path };
    },
    async search(query, path = ".") {
      const result = await sandbox.process.executeCommand(
        `rg --line-number --hidden --glob '!.git' ${shellQuote(String(query).slice(0, 500))} ${shellQuote(safeRelative(path))} | head -300`,
        workspacePath, undefined, 20,
      );
      return commandResult(result, [0, 1]);
    },
    async runCommand(command, timeout = 120) {
      const result = await sandbox.process.executeCommand(String(command).slice(0, 8_000), workspacePath, undefined,
        Math.min(Math.max(Number(timeout) || 120, 1), 600));
      return commandResult(result);
    },
    async status() {
      const result = await sandbox.process.executeCommand("git status --short", workspacePath, undefined, 20);
      return commandResult(result);
    },
    async headSha() {
      const result = await sandbox.process.executeCommand("git rev-parse HEAD", workspacePath, undefined, 20);
      return commandResult(result).output.trim();
    },
    async diff() {
      return collectWorkspaceDiff(sandbox, workspacePath);
    },
    async dispose() {
      try { await daytona.delete(sandbox); } catch { /* expiry policy remains the fallback */ }
    },
  };
}

export async function runCodexInSandbox({
  sandbox,
  workspacePath,
  run,
  prompt,
  authJson,
}) {
  const suffix = String(run?.id || "run").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48) || "run";
  const authDir = `/tmp/thrallo-codex-${suffix}`;
  const authPath = `${authDir}/auth.json`;
  const promptPath = `${authDir}/prompt.txt`;
  const outputPath = `${authDir}/last-message.txt`;
  const timeout = Math.min(Math.max(Number(optionalEnv("CODEX_RUN_TIMEOUT_SECONDS", "600")) || 600, 30), 600);
  let output = "";
  let refreshedAuthJson = null;

  try {
    commandResult(await sandbox.process.executeCommand(
      `mkdir -p ${shellQuote(authDir)} && chmod 700 ${shellQuote(authDir)}`,
      workspacePath, undefined, 20,
    ));
    await sandbox.fs.uploadFile(Buffer.from(normalizeCodexAuth(authJson), "utf8"), authPath);
    await sandbox.fs.uploadFile(Buffer.from(String(prompt || ""), "utf8"), promptPath);
    commandResult(await sandbox.process.executeCommand(
      `chmod 600 ${shellQuote(authPath)} ${shellQuote(promptPath)}`,
      workspacePath, undefined, 20,
    ));

    const command = [
      `CODEX_HOME=${shellQuote(authDir)}`,
      "npx --yes @openai/codex@0.146.0 exec",
      "--json --color never",
      "--dangerously-bypass-approvals-and-sandbox",
      "--ephemeral --ignore-user-config --ignore-rules",
      `--output-last-message ${shellQuote(outputPath)}`,
      `-C ${shellQuote(workspacePath)} -`,
      `< ${shellQuote(promptPath)}`,
    ].join(" ");
    const execution = commandResult(await sandbox.process.executeCommand(
      command,
      workspacePath,
      undefined,
      timeout,
    ));
    output = execution.output;
    const lastMessage = await downloadUtf8(sandbox, outputPath);
    const diff = (await collectWorkspaceDiff(sandbox, workspacePath)).output;
    const status = commandResult(await sandbox.process.executeCommand(
      "git status --short",
      workspacePath, undefined, 20,
    )).output;
    refreshedAuthJson = await downloadUtf8(sandbox, authPath);
    return {
      summary: lastMessage.trim() || finalCodexMessage(output) || "Codex completed the run.",
      diff,
      status,
      provider: "codex",
      model: "codex-subscription",
      usage: codexUsage(output),
      refreshedAuthJson,
    };
  } finally {
    await sandbox.process.executeCommand(
      `rm -rf -- ${shellQuote(authDir)}`,
      workspacePath, undefined, 20,
    ).catch(() => {});
  }
}

export async function publishDaytonaRun({ run, repository, title, body, emit = async () => {} }) {
  if (!daytonaConfigured()) throw setupError("Daytona is not connected.");
  if (!run.sandbox_id || !run.work_branch) throw setupError("The run workspace is no longer available.");
  if (!repository.installation_id) throw setupError("Pull-request publishing requires a GitHub App installation.");

  const { Daytona } = await import("@daytona/sdk");
  const daytona = new Daytona();
  const sandbox = await daytona.get(run.sandbox_id);
  if (sandbox.state !== "started") await sandbox.start(120);
  const workspacePath = await resolveSandboxRepositoryPath(sandbox);
  const { token } = await createInstallationToken(repository.installation_id);
  const commitTitle = String(title || `Thrallo: ${run.prompt}`).replace(/\s+/g, " ").trim().slice(0, 120);

  await emit("publish.started", { message: "Committing approved changes" });
  await sandbox.git.add(workspacePath, ["."]);
  await sandbox.git.commit(workspacePath, commitTitle, "Thrallo", "thrallo@users.noreply.github.com", false);
  const shaResult = await sandbox.process.executeCommand("git rev-parse HEAD", workspacePath, undefined, 20);
  const commitSha = commandResult(shaResult).output.trim();
  await sandbox.git.push(workspacePath, "x-access-token", token, run.work_branch, "origin", true);
  await emit("publish.branch_pushed", { branch: run.work_branch, commitSha, message: "Approved branch pushed" });

  const pullRequest = await createPullRequest({
    installationId: repository.installation_id,
    repository: repository.full_name,
    head: run.work_branch,
    base: run.base_branch,
    title: commitTitle,
    body: body || `Created by Thrallo for run ${run.id}.\n\n${run.result?.summary || ""}`,
  });
  await emit("publish.pull_request_created", {
    message: `Pull request #${pullRequest.number} created`,
    pullRequest,
  });
  await daytona.delete(sandbox);
  return { commitSha, branch: run.work_branch, pullRequest };
}

export async function discardDaytonaSandbox(sandboxId) {
  if (!sandboxId || !daytonaConfigured()) return false;
  const { Daytona } = await import("@daytona/sdk");
  const daytona = new Daytona();
  try {
    const sandbox = await daytona.get(sandboxId);
    await daytona.delete(sandbox);
    return true;
  } catch {
    return false;
  }
}

export async function resolveSandboxRepositoryPath(sandbox) {
  const workDir = String(await sandbox.getWorkDir()).replaceAll("\\", "/").replace(/\/+$/, "");
  if (!workDir.startsWith("/") || workDir.split("/").includes("..")) {
    throw new Error("Daytona returned an invalid sandbox working directory.");
  }
  return `${workDir}/repository`;
}

export async function collectWorkspaceDiff(sandbox, workspacePath) {
  const intentToAdd = await sandbox.process.executeCommand(
    "git add -N .",
    workspacePath, undefined, 20,
  );
  commandResult(intentToAdd);
  const result = await sandbox.process.executeCommand(
    "git diff --no-ext-diff --stat && git diff --no-ext-diff",
    workspacePath, undefined, 30,
  );
  return commandResult(result);
}

function safeRelative(value) {
  const path = String(value || ".").replaceAll("\\", "/").replace(/^\/+/, "");
  if (path.split("/").includes("..")) throw new Error("Path traversal is not allowed");
  if (path.split("/")[0] === ".git") throw new Error("Direct access to git metadata is not allowed");
  return path || ".";
}

async function downloadUtf8(sandbox, filePath) {
  const buffer = await sandbox.fs.downloadFile(filePath);
  return buffer.toString("utf8").slice(0, 500_000);
}

function normalizeCodexAuth(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Codex authentication state is invalid.");
  }
  return JSON.stringify(parsed);
}

function finalCodexMessage(output) {
  let text = "";
  for (const event of jsonLines(output)) {
    const item = event?.item;
    if (event?.type === "item.completed" && item?.type === "agent_message" && item?.text) {
      text = String(item.text);
    }
  }
  return text.trim();
}

function codexUsage(output) {
  const total = { inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 };
  for (const event of jsonLines(output)) {
    if (event?.type !== "turn.completed" || !event.usage) continue;
    total.inputTokens += Number(event.usage.input_tokens || 0);
    total.cachedTokens += Number(event.usage.cached_input_tokens || 0);
    total.outputTokens += Number(event.usage.output_tokens || 0);
  }
  total.totalTokens = total.inputTokens + total.outputTokens;
  return total;
}

function jsonLines(output) {
  return String(output || "").split(/\r?\n/).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function commandResult(result, accepted = [0]) {
  const exitCode = Number(result?.exitCode ?? -1);
  const output = String(result?.result || "").slice(0, 200_000);
  if (!accepted.includes(exitCode)) {
    const error = new Error(output || `Command exited with ${exitCode}`);
    error.exitCode = exitCode;
    throw error;
  }
  return { exitCode, output };
}

function setupError(message) {
  const error = new Error(message);
  error.code = "publish_setup_required";
  return error;
}
