import test from "node:test";
import assert from "node:assert/strict";
import { resolveSandboxRepositoryPath } from "../../shell/server/lib/daytonaRunner.mjs";

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
