import assert from "node:assert/strict";
import test from "node:test";

test("GitHub App runs wait for approval before publishing", async () => {
  process.env.CODE_AGENT_STORE = "memory";
  const { codeAgentStore, resetCodeAgentStoreForTests } =
    await import("../../shell/server/lib/codeAgentStore.mjs");
  const { approveRunPublication, processRun } =
    await import("../../shell/server/lib/codeAgentService.mjs");
  resetCodeAgentStoreForTests();
  const store = codeAgentStore();

  const repository = await store.createRepository("owner", {
    provider: "github",
    installation_id: 42,
    full_name: "example/repo",
    clone_url: "https://github.com/example/repo.git",
    default_branch: "main",
    private: true,
  });
  const agent = await store.createAgent("owner", {
    repository_id: repository.id,
    name: "Agent",
    mode: "agent",
  });
  const run = await store.createRun("owner", agent, repository, {
    prompt: "Fix the bug",
    mode: "agent",
    model: "auto",
  });

  let disposed = false;
  let receivedContext = null;
  const waiting = await processRun(run, {
    runnerFactory: async () => ({
      id: "sandbox-1",
      branch: "code-agent/run-1",
      headSha: async () => "baseline-sha",
      diff: async () => ({ output: "diff --git a/a.js b/a.js\n+fixed", exitCode: 0 }),
      status: async () => ({ output: " M a.js", exitCode: 0 }),
      dispose: async () => { disposed = true; },
    }),
    agentRunner: async ({ context }) => {
      receivedContext = context;
      return ({
      summary: "Fixed the bug",
      diff: "diff --git a/a.js b/a.js\n+fixed",
      status: " M a.js",
      provider: "openai",
      model: "test-model",
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      });
    },
    modelFactory: () => ({ id: "test", model: "test-model" }),
    repositoryIndexer: async () => ({ status: "ready" }),
    contextRetriever: async () => [{
      path: "src/a.js", startLine: 1, endLine: 2, language: "javascript", content: "const fixed = true;",
    }],
  });

  assert.equal(waiting.state, "waiting_for_approval");
  assert.equal(waiting.result.approval.action, "create_pull_request");
  assert.equal(disposed, false);
  assert.equal(receivedContext[0].path, "src/a.js");
  assert.equal((await store.listArtifacts("owner", run.id)).length, 3);

  const published = await approveRunPublication("owner", run.id, {}, {
    publisher: async ({ emit }) => {
      await emit("publish.pull_request_created", { message: "Pull request #7 created" });
      return {
        commitSha: "published-sha",
        branch: "code-agent/run-1",
        pullRequest: { number: 7, url: "https://github.com/example/repo/pull/7", state: "open" },
      };
    },
  });
  assert.equal(published.state, "succeeded");
  assert.equal(published.result.publication.pullRequest.number, 7);
  assert.equal(store.checkpoints.size, 2);
});
