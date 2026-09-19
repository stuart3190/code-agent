import assert from "node:assert/strict";
import test from "node:test";

process.env.CODE_AGENT_STORE = "memory";

const { codeAgentStore, resetCodeAgentStoreForTests } =
  await import("../../shell/server/lib/codeAgentStore.mjs");
const { processRun } = await import("../../shell/server/lib/codeAgentService.mjs");
const { handleRunResume, handleRunArtifactContent } =
  await import("../../shell/server/routes/codeAgent.mjs");
const { publicRun } = await import("../../shell/server/lib/codeAgentContracts.mjs");
const { memoryDirectModelReservations } = await import("../../shell/server/lib/directModelReservations.mjs");
const { DISPATCH_STATES, providerFailure } = await import("../../shell/server/lib/providerOutcome.mjs");

const SUCCESS_RESULT = {
  summary: "Done",
  diff: "diff --git a/a.js b/a.js\n+done",
  status: " M a.js",
  provider: "openai",
  model: "test-model",
  usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
};

async function seed({ agentExtra = {}, installation = 42 } = {}) {
  resetCodeAgentStoreForTests();
  const store = codeAgentStore();
  const repository = await store.createRepository("owner", {
    provider: "github", installation_id: installation, full_name: "example/repo",
    clone_url: "https://github.com/example/repo.git", default_branch: "main", private: true,
  });
  const agent = await store.createAgent("owner", {
    repository_id: repository.id, name: "Agent", mode: "agent", ...agentExtra,
  });
  const run = await store.createRun("owner", agent, repository, {
    prompt: "Fix the bug", mode: "agent", model: "auto",
  });
  return { store, repository, agent, run };
}

function fakeRunner(overrides = {}) {
  return {
    id: "sandbox-1",
    branch: "code-agent/run-1",
    headSha: async () => "sha-1",
    diff: async () => ({ output: SUCCESS_RESULT.diff, exitCode: 0 }),
    status: async () => ({ output: SUCCESS_RESULT.status, exitCode: 0 }),
    stop: async () => { overrides.onStop?.(); },
    dispose: async () => { overrides.onDispose?.(); },
    ...overrides,
  };
}

const passthrough = {
  modelFactory: () => ({ id: "test", model: "test-model" }),
  repositoryIndexer: async () => ({ status: "ready" }),
  contextRetriever: async () => [],
  repositoryMapRetriever: async () => [],
};

test("auto_publish policy publishes the pull request without waiting", async () => {
  const { store, run } = await seed({ agentExtra: { publish_mode: "auto_publish", protected_paths: [] } });
  let publishedRun = null;
  const finished = await processRun(run, {
    ...passthrough,
    runnerFactory: async () => fakeRunner(),
    agentRunner: async () => SUCCESS_RESULT,
    publisher: async ({ run: publishing }) => {
      publishedRun = publishing;
      return { commitSha: "sha-2", branch: publishing.work_branch, pullRequest: { number: 7, url: "https://pr/7" } };
    },
  });
  assert.equal(finished.state, "succeeded");
  assert.equal(finished.result.publication.pullRequest.number, 7);
  assert.equal(publishedRun.work_branch, "code-agent/run-1");
  const events = await store.listEvents("owner", run.id, 0);
  assert.ok(events.some((event) => event.type === "publish.auto_approved"));
  assert.ok(!events.some((event) => event.type === "run.waiting_for_approval"));
});

test("auto_publish still waits when a protected path was touched", async () => {
  const { store, run } = await seed({
    agentExtra: { publish_mode: "auto_publish", protected_paths: ["a.js"] },
  });
  const finished = await processRun(run, {
    ...passthrough,
    runnerFactory: async () => fakeRunner(),
    agentRunner: async () => SUCCESS_RESULT,
    publisher: async () => { throw new Error("must not publish"); },
  });
  assert.equal(finished.state, "waiting_for_approval");
  assert.equal(finished.result.approval.reason, "protected_path");
  assert.deepEqual(finished.result.approval.protectedTouched, ["a.js"]);
  const events = await store.listEvents("owner", run.id, 0);
  assert.ok(events.some((event) => event.type === "run.waiting_for_approval"));
});

test("a failed automatic publication falls back to manual approval", async () => {
  const { run } = await seed({ agentExtra: { publish_mode: "auto_publish", protected_paths: [] } });
  const finished = await processRun(run, {
    ...passthrough,
    runnerFactory: async () => fakeRunner(),
    agentRunner: async () => SUCCESS_RESULT,
    publisher: async () => { throw new Error("github outage"); },
  });
  assert.equal(finished.state, "waiting_for_approval");
  assert.equal(finished.result.approval.required, true);
});

test("a failed run preserves and stops its sandbox for resume", async () => {
  const { run } = await seed();
  let stopped = false;
  let disposed = false;
  const finished = await processRun(run, {
    ...passthrough,
    runnerFactory: async () => fakeRunner({ onStop: () => { stopped = true; }, onDispose: () => { disposed = true; } }),
    agentRunner: async () => { const error = new Error("model exploded"); error.code = "provider_error"; throw error; },
  });
  assert.equal(finished.state, "failed");
  assert.equal(finished.sandbox_state, "preserved");
  assert.equal(stopped, true);
  assert.equal(disposed, false);
  assert.equal(publicRun(finished).resumable, true);
});

test("an ambiguous managed run never writes aggregate post-hoc usage around its durable hold", async () => {
  const { store, run } = await seed();
  const reservations = memoryDirectModelReservations();
  const finished = await processRun(run, {
    ...passthrough,
    runnerFactory: async () => fakeRunner(),
    credentialResolver: async () => ({
      provider: "managed", routing: { routingMode: "balanced", allowFallback: true },
    }),
    providerNameResolver: async () => "managed",
    budgetGuard: async () => ({ budgets: { managedTokens: { remaining: 10_000 } } }),
    reservationStoreFactory: () => reservations,
    agentRunner: async ({ dispatchAccounting }) => {
      const candidate = { provider: "openai", model: "gpt-5.6-luna" };
      const hooks = dispatchAccounting.forTurn(1);
      const hold = await hooks.beforeDispatch(candidate, {
        attemptOrder: 1,
        args: { instructions: "work", input: [], tools: [], maxOutputTokens: 400 },
      });
      try {
        await hooks.dispatchFailed(hold, candidate, providerFailure(new Error("socket ended"), {
          state: DISPATCH_STATES.ambiguous,
          providerRequestId: "req_run_ambiguous",
        }));
      } catch (error) {
        error.usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120 };
        throw error;
      }
    },
  });
  assert.equal(finished.state, "failed");
  assert.equal(finished.error_code, "provider_replay_unsafe");
  const [hold] = reservations.rows();
  assert.equal(hold.reconciliationState, "pending");
  assert.equal([...store.usageRecords.values()].length, 0,
    "managed aggregate usage must not bypass the unresolved direct reservation");
});

test("managed repository work uses purchased credits after included allowance is exhausted", async () => {
  const { store, run } = await seed({ installation: null });
  await store.upsertSubscription("owner", { managed_token_limit_override: 10 });
  await store.recordStandaloneUsage("owner", {
    billing_source: "managed", input_tokens: 10, output_tokens: 0, compute_seconds: 0,
  });
  const usageBefore = [...store.usageRecords.values()].length;
  const reservations = memoryDirectModelReservations({
    balanceResolver: async () => ({ included: 0, purchased: 100 }),
  });
  let providerCalls = 0;
  const finished = await processRun(run, {
    ...passthrough,
    runnerFactory: async () => fakeRunner(),
    credentialResolver: async () => ({
      provider: "managed", routing: { routingMode: "balanced", allowFallback: true },
    }),
    providerNameResolver: async () => "managed",
    reservationStoreFactory: () => reservations,
    modelFactory: async () => ({
      id: "openai", model: "gpt-5.6-luna",
      async turn(args) {
        providerCalls += 1;
        assert.equal(args.maxOutputTokens, 8_000);
        return {
          id: "req_repo_topup", text: "Done",
          output: [{ type: "message", content: [{ type: "output_text", text: "Done" }] }],
          usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
        };
      },
    }),
  });
  assert.equal(finished.state, "succeeded");
  assert.equal(providerCalls, 1);
  const [reservation] = reservations.rows();
  assert.equal(reservation.state, "settled");
  assert.equal(reservation.includedReservedCredits, 0);
  assert.ok(reservation.purchasedReservedCredits > 0);
  assert.equal([...store.usageRecords.values()].length, usageBefore,
    "per-turn purchased settlement must not be followed by aggregate managed usage");
});

test("managed repository work with no included or purchased credits fails before provider dispatch", async () => {
  const { store, run } = await seed({ installation: null });
  const reservations = memoryDirectModelReservations({
    balanceResolver: async () => ({ included: 0, purchased: 0 }),
  });
  let providerCalls = 0;
  const finished = await processRun(run, {
    ...passthrough,
    runnerFactory: async () => fakeRunner(),
    credentialResolver: async () => ({
      provider: "managed", routing: { routingMode: "balanced", allowFallback: true },
    }),
    providerNameResolver: async () => "managed",
    reservationStoreFactory: () => reservations,
    modelFactory: async () => ({
      id: "openai", model: "gpt-5.6-luna",
      async turn() { providerCalls += 1; return { text: "must not happen", output: [], usage: {} }; },
    }),
  });
  assert.equal(finished.state, "failed");
  assert.equal(finished.error_code, "account_budget");
  assert.equal(providerCalls, 0);
  assert.equal([...store.usageRecords.values()].length, 0);
});

test("resume reattaches the preserved sandbox and briefs the agent", async () => {
  const { store, agent, repository, run } = await seed();
  const failed = await processRun(run, {
    ...passthrough,
    runnerFactory: async () => fakeRunner(),
    agentRunner: async () => { throw new Error("stopped midway"); },
  });
  assert.equal(publicRun(failed).resumable, true);

  const resumed = await store.createRun("owner", agent, repository, {
    prompt: "Fix the bug", mode: "agent", model: "auto", resumed_from_run_id: failed.id,
  });
  let attachedPrevious = null;
  let freshCreates = 0;
  let agentPrompt = null;
  const finished = await processRun(resumed, {
    ...passthrough,
    attachRunnerFactory: async ({ previous }) => {
      attachedPrevious = previous;
      return fakeRunner({ id: previous.sandbox_id, branch: previous.work_branch });
    },
    runnerFactory: async () => { freshCreates += 1; return fakeRunner(); },
    agentRunner: async ({ prompt, run: current }) => {
      agentPrompt = prompt ?? current.prompt;
      return { ...SUCCESS_RESULT, diff: "" };
    },
  });
  assert.equal(finished.state, "succeeded");
  assert.equal(attachedPrevious.id, failed.id);
  assert.equal(freshCreates, 0);
  assert.equal(finished.work_branch, failed.work_branch);
  assert.match(agentPrompt, /resuming an earlier run/);
  assert.match(agentPrompt, /stopped midway/);
  const priorRun = await store.getRun("owner", failed.id);
  assert.equal(priorRun.sandbox_state, "discarded");
  assert.equal(publicRun(priorRun).resumable, false);
});

test("resume falls back to a clean baseline when the sandbox expired", async () => {
  const { store, agent, repository, run } = await seed();
  const failed = await processRun(run, {
    ...passthrough,
    runnerFactory: async () => fakeRunner(),
    agentRunner: async () => { throw new Error("boom"); },
  });
  const resumed = await store.createRun("owner", agent, repository, {
    prompt: "Fix the bug", mode: "agent", model: "auto", resumed_from_run_id: failed.id,
  });
  const finished = await processRun(resumed, {
    ...passthrough,
    attachRunnerFactory: async () => { const error = new Error("gone"); error.code = "sandbox_expired"; throw error; },
    runnerFactory: async () => fakeRunner({ id: "sandbox-fresh" }),
    agentRunner: async () => ({ ...SUCCESS_RESULT, diff: "" }),
  });
  assert.equal(finished.state, "succeeded");
  assert.equal(finished.sandbox_id, "sandbox-fresh");
  const events = await store.listEvents("owner", resumed.id, 0);
  assert.ok(events.some((event) => event.type === "resume.fallback"));
});

test("the resume route rejects runs without a preserved workspace", async () => {
  const { run } = await seed();
  const res = { writeHead() {}, end() {} };
  await assert.rejects(
    handleRunResume(null, res, { owner: { id: "owner" }, runId: run.id, body: {} }),
    (error) => error.code === "run_not_resumable" && error.status === 409,
  );
});

test("artifact content is served through the authenticated store path", async () => {
  const { store, run } = await seed();
  const artifact = await store.createArtifact(run, {
    type: "diff", name: "changes.patch", content: "+hello", content_type: "text/x-diff", size_bytes: 6,
  });
  let sent = null;
  const res = {
    writeHead(code, headers) { sent = { code, headers }; },
    end(body) { sent.body = body; },
  };
  await handleRunArtifactContent(null, res, { owner: { id: "owner" }, runId: run.id, artifactId: artifact.id });
  assert.equal(sent.code, 200);
  assert.equal(sent.body, "+hello");
  await assert.rejects(
    handleRunArtifactContent(null, res, { owner: { id: "owner" }, runId: run.id, artifactId: "missing" }),
    (error) => error.code === "artifact_not_found",
  );
});
