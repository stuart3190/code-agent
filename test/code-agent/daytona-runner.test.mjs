import test from "node:test";
import assert from "node:assert/strict";
import {
  collectWorkspaceDiff,
  resolveSandboxRepositoryPath,
  runCodexInSandbox,
} from "../../shell/server/lib/daytonaRunner.mjs";

test("Daytona repositories are created inside the sandbox working directory", async () => {
  const path = await resolveSandboxRepositoryPath({
    getWorkDir: async () => "/home/daytona",
  });
  assert.equal(path, "/home/daytona/repository");
});

test("Daytona repository paths normalize trailing separators", async () => {
  const path = await resolveSandboxRepositoryPath({
    getWorkDir: async () => "/home/daytona/",
  });
  assert.equal(path, "/home/daytona/repository");
});

test("Daytona repository paths reject unsafe working directories", async () => {
  await assert.rejects(
    resolveSandboxRepositoryPath({ getWorkDir: async () => "../workspace" }),
    /invalid sandbox working directory/,
  );
});

test("Daytona diffs include newly created files", async () => {
  const commands = [];
  const sandbox = {
    process: {
      async executeCommand(command, cwd) {
        commands.push({ command, cwd });
        if (command === "git add -N .") return { exitCode: 0, result: "" };
        return {
          exitCode: 0,
          result: "diff --git a/docs/proof.md b/docs/proof.md\nnew file mode 100644\n",
        };
      },
    },
  };

  const result = await collectWorkspaceDiff(sandbox, "/home/daytona/repository");

  assert.match(result.output, /new file mode 100644/);
  assert.deepEqual(commands, [
    { command: "git add -N .", cwd: "/home/daytona/repository" },
    {
      command: "git diff --no-ext-diff --stat && git diff --no-ext-diff",
      cwd: "/home/daytona/repository",
    },
  ]);
});

test("Codex runs use a temporary private auth directory and remove it afterward", async () => {
  const commands = [];
  const uploads = new Map();
  const authJson = JSON.stringify({ tokens: { access_token: "never-log-this-token" } });
  const sandbox = {
    fs: {
      async uploadFile(buffer, path) { uploads.set(path, buffer.toString("utf8")); },
      async downloadFile(path) {
        if (path.endsWith("/last-message.txt")) return Buffer.from("Implemented the requested change.");
        if (path.endsWith("/auth.json")) return Buffer.from(authJson);
        throw new Error(`Unexpected download: ${path}`);
      },
    },
    process: {
      async executeCommand(command, cwd) {
        commands.push({ command, cwd });
        if (command.includes("@openai/codex@0.146.0 exec")) {
          return {
            exitCode: 0,
            result: [
              JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
              JSON.stringify({
                type: "turn.completed",
                usage: { input_tokens: 100, cached_input_tokens: 25, output_tokens: 30 },
              }),
            ].join("\n"),
          };
        }
        if (command === "git status --short") return { exitCode: 0, result: " M src/app.js" };
        if (command.startsWith("git diff")) return { exitCode: 0, result: "diff --git a/src/app.js b/src/app.js" };
        return { exitCode: 0, result: "" };
      },
    },
  };

  const result = await runCodexInSandbox({
    sandbox,
    workspacePath: "/home/daytona/repository",
    run: { id: "run-123" },
    prompt: "Fix the app",
    authJson,
  });

  assert.equal(result.summary, "Implemented the requested change.");
  assert.equal(result.provider, "codex");
  assert.equal(result.usage.inputTokens, 100);
  assert.equal(result.usage.cachedTokens, 25);
  assert.equal(result.usage.outputTokens, 30);
  assert.equal(result.refreshedAuthJson, authJson);
  assert.ok([...uploads.keys()].some((path) => path.endsWith("/auth.json")));
  assert.ok(commands.some(({ command }) => command.includes("rm -rf -- '/tmp/thrallo-codex-run-123'")));
  assert.ok(commands.some(({ command }) => command.includes("--dangerously-bypass-approvals-and-sandbox")));
  assert.ok(commands.every(({ command }) => !command.includes("never-log-this-token")));
});
