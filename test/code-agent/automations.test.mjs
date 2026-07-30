import assert from "node:assert/strict";
import test from "node:test";

process.env.CODE_AGENT_STORE = "memory";

const { MemoryAutomationsStore, nextRunAt } = await import("../../shell/server/lib/automationsStore.mjs");
const {
  parseAutomationInput, sweepScheduledAutomations, triggerPullRequestAutomations,
} = await import("../../shell/server/lib/automationService.mjs");
const { MemoryCodeAgentStore, codeAgentStore, resetCodeAgentStoreForTests } =
  await import("../../shell/server/lib/codeAgentStore.mjs");
const { processRun } = await import("../../shell/server/lib/codeAgentService.mjs");
const { processGithubWebhookDelivery } = await import("../../shell/server/lib/githubWebhookService.mjs");

const OWNER = "55555555-5555-4555-8555-555555555555";

async function seedRepo(runStore, installation = 42) {
  const repository = await runStore.createRepository(OWNER, {
    provider: "github", installation_id: installation, external_id: 900,
    full_name: "example/repo", clone_url: "https://github.com/example/repo.git",
    default_branch: "main", private: true,
  });
  return repository;
}

test("automation input validation covers kinds, intervals, and config", () => {
  const review = parseAutomationInput({ kind: "pr_review", config: { autoPost: true, prompt: "focus" } });
  assert.equal(review.kind, "pr_review");
  assert.equal(review.config.autoPost, true);
  const scheduled = parseAutomationInput({ kind: "scheduled_task", intervalHours: 6, config: { prompt: "maintain", mode: "review" } });
  assert.equal(scheduled.interval_hours, 6);
  assert.equal(scheduled.config.mode, "review");
  assert.throws(() => parseAutomationInput({ kind: "cron" }), /kind/);
  assert.throws(() => parseAutomationInput({ kind: "scheduled_task", intervalHours: 500 }), /between 1 and 168/);
});

test("pull_request webhook triggers enabled automations and skips drafts", async () => {
  const runStore = new MemoryCodeAgentStore();
  const store = new MemoryAutomationsStore();
  const repository = await seedRepo(runStore);
  await store.create(OWNER, {
    repository_id: repository.id, kind: "pr_review", enabled: true,
    config: { prompt: "", includeDrafts: false, autoPost: false },
  });

  const results = await triggerPullRequestAutomations(
    { repository, pullNumber: 12, title: "Add feature", draft: false },
    { store, runStore },
  );
  assert.equal(results.length, 1);
  assert.ok(results[0].runId);
  const run = await runStore.getRun(OWNER, results[0].runId);
  assert.equal(run.mode, "review");
  assert.equal(run.pull_request, 12);
  assert.ok(run.automation_id);
  assert.match(run.prompt, /#12/);
  const agents = await runStore.listAgents(OWNER);
  assert.equal(agents[0].mode, "review");

  const draft = await triggerPullRequestAutomations(
    { repository, pullNumber: 13, title: "WIP", draft: true },
    { store, runStore },
  );
  assert.equal(draft[0].skipped, "draft");
});

test("the webhook processor routes pull_request events into automations", async () => {
  resetCodeAgentStoreForTests();
  const store = codeAgentStore();
  await store.upsertGithubInstallation(OWNER, { installation_id: 42, status: "active" });
  const repository = await seedRepo(store);
  const { delivery } = await store.recordGithubWebhookDelivery({
    delivery_id: "pr-1", event: "pull_request", action: "opened", owner: OWNER,
    installation_id: 42, payload_sha256: "x".repeat(64),
    payload: { installation: { id: 42 }, repository: { id: 900 }, pull_request: { number: 5, title: "T", draft: false } },
  });
  let triggered = null;
  const result = await processGithubWebhookDelivery(delivery, {
    store,
    automationTrigger: async (args) => { triggered = args; return [{ automationId: "a1", runId: "r1" }]; },
  });
  assert.equal(result.status, "processed");
  assert.equal(triggered.pullNumber, 5);
  assert.equal(triggered.repository.id, repository.id);

  const { delivery: closed } = await store.recordGithubWebhookDelivery({
    delivery_id: "pr-2", event: "pull_request", action: "closed", owner: OWNER,
    installation_id: 42, payload_sha256: "y".repeat(64),
    payload: { installation: { id: 42 }, repository: { id: 900 }, pull_request: { number: 5 } },
  });
  const ignored = await processGithubWebhookDelivery(closed, {
    store,
    automationTrigger: async () => { throw new Error("must not trigger"); },
  });
  assert.equal(ignored.result.reason, "unsupported_pull_request_action");
});

test("scheduled sweep claims due automations once and records outcomes", async () => {
  const runStore = new MemoryCodeAgentStore();
  const store = new MemoryAutomationsStore();
  const repository = await seedRepo(runStore);
  const due = await store.create(OWNER, {
    repository_id: repository.id, kind: "scheduled_task", enabled: true,
    interval_hours: 24, next_run_at: "2026-07-30T00:00:00.000Z",
    config: { prompt: "Update dependencies", mode: "agent" },
  });
  await store.create(OWNER, {
    repository_id: repository.id, kind: "scheduled_task", enabled: true,
    interval_hours: 24, next_run_at: "2099-01-01T00:00:00.000Z",
    config: { prompt: "later" },
  });

  const results = await sweepScheduledAutomations({ store, runStore, now: new Date("2026-07-30T12:00:00Z") });
  assert.equal(results.length, 1);
  assert.ok(results[0].runId);
  const updated = await store.get(OWNER, due.id);
  assert.equal(updated.last_run_id, results[0].runId);
  assert.ok(updated.next_run_at > "2026-07-30T12:00:00");
  const again = await sweepScheduledAutomations({ store, runStore, now: new Date("2026-07-30T12:00:05Z") });
  assert.equal(again.length, 0);
});

test("a rejected trigger records the error without creating a run", async () => {
  const runStore = new MemoryCodeAgentStore();
  const store = new MemoryAutomationsStore();
  const repository = await seedRepo(runStore);
  await runStore.upsertSubscription(OWNER, { run_limit_override: 1 });
  const agent = await runStore.createAgent(OWNER, { repository_id: repository.id, name: "A", mode: "agent" });
  const existing = await runStore.createRun(OWNER, agent, repository, { prompt: "x", mode: "agent", model: "auto" });
  await runStore.updateRun(existing, { started_at: new Date().toISOString(), state: "succeeded" });

  const automation = await store.create(OWNER, {
    repository_id: repository.id, kind: "pr_review", enabled: true, config: {},
  });
  const results = await triggerPullRequestAutomations(
    { repository, pullNumber: 9, title: "T", draft: false },
    { store, runStore },
  );
  assert.equal(results[0].skipped, "budget_exceeded");
  const row = await store.get(OWNER, automation.id);
  assert.match(row.last_error, /allowance/);
  assert.equal(row.last_run_id, null);
});

test("autoPost automations post the review without waiting for approval", async () => {
  resetCodeAgentStoreForTests();
  const runStore = codeAgentStore();
  const repository = await seedRepo(runStore);
  const agent = await runStore.createAgent(OWNER, { repository_id: repository.id, name: "Reviewer", mode: "review" });
  const run = await runStore.createRun(OWNER, agent, repository, {
    prompt: "Review", mode: "review", model: "auto", pull_request: 7, automation_id: "auto-1",
  });
  let posted = null;
  const finished = await processRun(run, {
    modelFactory: () => ({ id: "test", model: "m" }),
    repositoryIndexer: async () => ({}),
    contextRetriever: async () => [],
    repositoryMapRetriever: async () => [],
    runnerFactory: async () => ({
      id: "s", branch: "b", headSha: async () => "sha",
      diff: async () => ({ output: "" }), status: async () => ({ output: "" }),
      stop: async () => {}, dispose: async () => {},
      checkoutPullRequest: async () => ({ branch: "thrallo-review-7", diff: "+1" }),
    }),
    agentRunner: async () => ({
      summary: JSON.stringify({ verdict: "comment", summary: "Fine.", findings: [] }),
      diff: "", status: "", provider: "openai", model: "m", usage: {},
    }),
    automationResolver: async () => ({ id: "auto-1", config: { autoPost: true } }),
    reviewPoster: async (args) => { posted = args; return { id: 9, url: "https://pr/7#r9", state: "COMMENTED", inlineComments: 0 }; },
  });
  assert.equal(finished.state, "succeeded");
  assert.equal(posted.pullNumber, 7);
  assert.equal(finished.result.publication.auto, true);
});

test("nextRunAt clamps the interval", () => {
  const from = "2026-07-30T00:00:00.000Z";
  assert.equal(nextRunAt(24, from), "2026-07-31T00:00:00.000Z");
  assert.equal(nextRunAt(0, from), "2026-07-31T00:00:00.000Z");
  assert.equal(nextRunAt(9_999, from), new Date(new Date(from).getTime() + 168 * 3_600_000).toISOString());
});
