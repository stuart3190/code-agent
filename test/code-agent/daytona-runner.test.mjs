import test from "node:test";
import assert from "node:assert/strict";
import {
  collectWorkspaceDiff,
  resolveSandboxRepositoryPath,
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
