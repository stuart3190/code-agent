import { optionalEnv } from "./env.mjs";
import { createInstallationToken, createPullRequest } from "./githubApp.mjs";

const workspacePath = "/workspace/repository";

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
    async listFiles(path = ".", depth = 4) {
      const safe = safeRelative(path);
      const result = await sandbox.process.executeCommand(
        `find ${shellQuote(safe)} -maxdepth ${Math.min(Math.max(Number(depth) || 4, 1), 8)} -type f | sort | head -400`,
        workspacePath, undefined, 20,
      );
      return commandResult(result);
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
      const result = await sandbox.process.executeCommand("git diff --no-ext-diff --stat && git diff --no-ext-diff",
        workspacePath, undefined, 30);
      return commandResult(result);
    },
    async dispose() {
      try { await daytona.delete(sandbox); } catch { /* expiry policy remains the fallback */ }
    },
  };
}

export async function publishDaytonaRun({ run, repository, title, body, emit = async () => {} }) {
  if (!daytonaConfigured()) throw setupError("Daytona is not connected.");
  if (!run.sandbox_id || !run.work_branch) throw setupError("The run workspace is no longer available.");
  if (!repository.installation_id) throw setupError("Pull-request publishing requires a GitHub App installation.");

  const { Daytona } = await import("@daytona/sdk");
  const daytona = new Daytona();
  const sandbox = await daytona.get(run.sandbox_id);
  if (sandbox.state !== "started") await sandbox.start(120);
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

function safeRelative(value) {
  const path = String(value || ".").replaceAll("\\", "/").replace(/^\/+/, "");
  if (path.split("/").includes("..")) throw new Error("Path traversal is not allowed");
  if (path.split("/")[0] === ".git") throw new Error("Direct access to git metadata is not allowed");
  return path || ".";
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
