import assert from "node:assert/strict";
import test from "node:test";

process.env.CODE_AGENT_STORE = "memory";

const {
  buildReviewPrompt, parseReviewOutput, renderReviewMarkdown, reviewEventForVerdict, reviewTools,
} = await import("../../shell/server/lib/reviewAgent.mjs");
const { codeAgentStore, resetCodeAgentStoreForTests } =
  await import("../../shell/server/lib/codeAgentStore.mjs");
const { approveRunPublication, processRun } =
  await import("../../shell/server/lib/codeAgentService.mjs");
const { parseRunInput, CodeAgentInputError } =
  await import("../../shell/server/lib/codeAgentContracts.mjs");

const REVIEW_JSON = JSON.stringify({
  verdict: "request_changes",
  summary: "The retry loop drops the final error.",
  findings: [
    { path: "src/retry.js", line: 42, severity: "blocker", title: "Swallowed error", detail: "The catch discards the last failure, so callers see undefined." },
    { path: "src/retry.js", severity: "minor", title: "Naming", detail: "attemptsLeft reads as a boolean." },
  ],
});

test("review toolset is read-only and prompts embed the truncated diff", () => {
  const tools = reviewTools();
  assert.ok(!tools.some((tool) => tool.name === "write_file"));
  assert.ok(tools.some((tool) => tool.name === "run_command"));
  const prompt = buildReviewPrompt("focus on retries", 7, "x".repeat(70_000));
  assert.match(prompt, /pull request #7/i);
  assert.match(prompt, /focus on retries/);
  assert.match(prompt, /truncated/);
});

test("review output parses strict JSON, fenced JSON, and degrades on prose", () => {
  const strict = parseReviewOutput(REVIEW_JSON);
  assert.equal(strict.verdict, "request_changes");
  assert.equal(strict.findings.length, 2);
  assert.equal(strict.findings[0].line, 42);
  assert.equal(strict.findings[1].line, null);

  const fenced = parseReviewOutput(`Here you go:\n\`\`\`json\n${REVIEW_JSON}\n\`\`\`\nDone.`);
  assert.equal(fenced.structured, true);
  assert.equal(fenced.findings.length, 2);

  const prose = parseReviewOutput("Looks fine to me overall.");
  assert.equal(prose.structured, false);
  assert.equal(prose.verdict, "comment");
  assert.deepEqual(prose.findings, []);
});

test("verdict mapping is conservative about approvals", () => {
  assert.equal(reviewEventForVerdict("approve", []), "APPROVE");
  assert.equal(reviewEventForVerdict("approve", [{ severity: "major" }]), "COMMENT");
  assert.equal(reviewEventForVerdict("comment", [{ severity: "blocker" }]), "REQUEST_CHANGES");
  assert.equal(reviewEventForVerdict("request_changes", []), "REQUEST_CHANGES");
});

test("run input accepts a pull request only for review runs", () => {
  const agent = { mode: "review" };
  const parsed = parseRunInput({ prompt: "review", pullRequestNumber: 12 }, agent);
  assert.equal(parsed.pull_request, 12);
  assert.throws(
    () => parseRunInput({ prompt: "x", mode: "agent", pullRequestNumber: 12 }, { mode: "agent" }),
    CodeAgentInputError,
  );
  assert.throws(() => parseRunInput({ prompt: "x", pullRequestNumber: -1 }, agent), /positive/);
});

async function seedReviewRun() {
  resetCodeAgentStoreForTests();
  const store = codeAgentStore();
  const repository = await store.createRepository("owner", {
    provider: "github", installation_id: 42, full_name: "example/repo",
    clone_url: "https://github.com/example/repo.git", default_branch: "main", private: true,
  });
  const agent = await store.createAgent("owner", {
    repository_id: repository.id, name: "Reviewer", mode: "review",
  });
  const run = await store.createRun("owner", agent, repository, {
    prompt: "Review it", mode: "review", model: "auto", pull_request: 7,
  });
  return { store, repository, agent, run };
}

const passthrough = {
  modelFactory: () => ({ id: "test", model: "test-model" }),
  repositoryIndexer: async () => ({}),
  contextRetriever: async () => [],
  repositoryMapRetriever: async () => [],
};

function reviewRunner(overrides = {}) {
  return {
    id: "sandbox-r", branch: "code-agent/r1",
    headSha: async () => "sha",
    diff: async () => ({ output: "" }),
    status: async () => ({ output: "" }),
    stop: async () => {}, dispose: async () => {},
    checkoutPullRequest: async (number) => ({ branch: `thrallo-review-${number}`, diff: "diff --git a/x b/x\n+1" }),
    ...overrides,
  };
}

test("a PR review run checks out the head, waits for approval, then posts", async () => {
  const { store, run } = await seedReviewRun();
  let receivedPrompt = null;
  let receivedTools = null;
  const waiting = await processRun(run, {
    ...passthrough,
    runnerFactory: async () => reviewRunner(),
    agentRunner: async ({ prompt, tools }) => {
      receivedPrompt = prompt;
      receivedTools = tools;
      return { summary: REVIEW_JSON, diff: "", status: "", provider: "openai", model: "m", usage: { totalTokens: 5 } };
    },
  });
  assert.equal(waiting.state, "waiting_for_approval");
  assert.equal(waiting.result.approval.action, "post_review");
  assert.equal(waiting.result.verdict, "request_changes");
  assert.equal(waiting.result.findings.length, 2);
  assert.match(receivedPrompt, /pull request #7/i);
  assert.ok(!receivedTools.some((tool) => tool.name === "write_file"));

  const artifacts = await store.listArtifacts("owner", run.id);
  assert.deepEqual(artifacts.map((a) => a.name).sort(), ["pull-request.patch", "review.json", "review.md"]);

  let posted = null;
  const finished = await approveRunPublication("owner", run.id, {}, {
    reviewPoster: async (args) => { posted = args; return { id: 1, url: "https://github.com/example/repo/pull/7#review-1", state: "CHANGES_REQUESTED", inlineComments: 1 }; },
  });
  assert.equal(finished.state, "succeeded");
  assert.equal(posted.pullNumber, 7);
  assert.equal(posted.event, "REQUEST_CHANGES");
  assert.equal(posted.comments.length, 2);
  assert.equal(finished.result.publication.review.url, "https://github.com/example/repo/pull/7#review-1");
});

test("a review without a pull request succeeds directly with findings", async () => {
  resetCodeAgentStoreForTests();
  const store = codeAgentStore();
  const repository = await store.createRepository("owner", {
    provider: "github", installation_id: null, full_name: "example/repo",
    clone_url: "https://github.com/example/repo.git", default_branch: "main", private: true,
  });
  const agent = await store.createAgent("owner", { repository_id: repository.id, name: "Reviewer", mode: "review" });
  const run = await store.createRun("owner", agent, repository, {
    prompt: "Audit error handling", mode: "review", model: "auto",
  });
  const finished = await processRun(run, {
    ...passthrough,
    runnerFactory: async () => reviewRunner({ checkoutPullRequest: async () => { throw new Error("must not fetch"); } }),
    agentRunner: async () => ({ summary: REVIEW_JSON, diff: "", status: "", provider: "openai", model: "m", usage: {} }),
  });
  assert.equal(finished.state, "succeeded");
  assert.equal(finished.result.review, true);
  assert.equal(finished.result.findings.length, 2);
});

test("markdown rendering includes verdict, anchors, and severities", () => {
  const markdown = renderReviewMarkdown(parseReviewOutput(REVIEW_JSON), 7);
  assert.match(markdown, /# Review of pull request #7/);
  assert.match(markdown, /request changes/);
  assert.match(markdown, /`src\/retry\.js`:42/);
  assert.match(markdown, /Swallowed error/);
});
