import assert from "node:assert/strict";
import test from "node:test";

process.env.CODE_AGENT_STORE = "memory";

const {
  registerCapability, capabilityToolDefs, invokeCapability, listCapabilities,
  resetCapabilityRegistryForTests,
} = await import("../../shell/server/lib/capabilityRegistry.mjs");
const { MemoryConversationStore } = await import("../../shell/server/lib/conversationStore.mjs");
const { MemoryCodeAgentStore, codeAgentStore, resetCodeAgentStoreForTests } =
  await import("../../shell/server/lib/codeAgentStore.mjs");
const {
  buildDispatchConfirmation, ensureCoreCapabilities, postUserMessage, preservedBuildRetryTarget,
  processConversation, recoverStaleConversations, resetLeadAgentForTests,
} = await import("../../shell/server/lib/leadAgentService.mjs");

const OWNER = "77777777-7777-4777-8777-777777777777";

function stubModel(script) {
  let index = 0;
  return {
    async turn({ instructions, input, tools }) {
      const step = script[Math.min(index, script.length - 1)];
      index += 1;
      if (typeof step === "function") return step({ instructions, input, tools });
      return step;
    },
  };
}

const finalMessage = (text) => ({
  text, output: [{ type: "message", content: [{ type: "output_text", text }] }],
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
});
const toolCall = (name, args, callId = "c1") => ({
  text: "", usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
  output: [{ type: "function_call", call_id: callId, name, arguments: JSON.stringify(args) }],
});

test("the registry is the extension point: a new capability is immediately usable with zero Lead Agent changes", async () => {
  resetLeadAgentForTests();
  resetCapabilityRegistryForTests();
  ensureCoreCapabilities();
  const before = (await capabilityToolDefs({ owner: OWNER })).map((tool) => tool.name);
  assert.ok(before.includes("repo_change") && before.includes("remember") && before.includes("ask_business_question"));

  let invoked = null;
  registerCapability({
    id: "dummy_capability",
    specialist: "Tester",
    statusText: "Testing the registry…",
    description: "A test-only capability.",
    inputSchema: { type: "object", properties: { value: { type: "string", description: "x" } }, required: ["value"], additionalProperties: false },
    invoke: async (_ctx, input) => { invoked = input.value; return { ok: true }; },
  });
  const after = (await capabilityToolDefs({ owner: OWNER })).map((tool) => tool.name);
  assert.ok(after.includes("dummy_capability"), "newly registered capability appears in the generated tool list");

  const store = new MemoryConversationStore();
  const conversation = await store.createConversation(OWNER, {});
  await store.claimConversationThinking(conversation);
  await store.appendTurn(conversation, { role: "user", content: "exercise the dummy" });
  await processConversation(conversation, {
    store,
    runStore: new MemoryCodeAgentStore(),
    credentialResolver: async () => ({ provider: "managed", routing: {} }),
    modelFactory: async () => stubModel([
      toolCall("dummy_capability", { value: "it-works" }),
      finalMessage("Dummy exercised."),
    ]),
  });
  assert.equal(invoked, "it-works");
});

test("capability requirements gate the tool list per owner", async () => {
  resetCapabilityRegistryForTests();
  registerCapability({
    id: "gated_capability", specialist: "Tester", description: "gated",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    requirements: (ctx) => (ctx.owner === "allowed" ? { ok: true } : { ok: false, reason: "no" }),
    invoke: async () => ({}),
  });
  assert.equal((await capabilityToolDefs({ owner: "allowed" })).length, 1);
  assert.equal((await capabilityToolDefs({ owner: OWNER })).length, 0);
  await assert.rejects(invokeCapability("gated_capability", { owner: OWNER }, {}),
    (error) => error.code === "capability_unavailable");
});

test("the lead instructions ban technical questions and ask_business_question rejects non-business use", async () => {
  resetLeadAgentForTests();
  resetCapabilityRegistryForTests();
  ensureCoreCapabilities();
  const store = new MemoryConversationStore();
  const runStore = new MemoryCodeAgentStore();
  const conversation = await store.createConversation(OWNER, {});
  await store.claimConversationThinking(conversation);
  await store.appendTurn(conversation, { role: "user", content: "Build me a booking system." });

  let seenInstructions = null;
  await processConversation(conversation, {
    store, runStore,
    credentialResolver: async () => ({ provider: "managed", routing: {} }),
    modelFactory: async () => stubModel([
      ({ instructions }) => { seenInstructions = instructions; return toolCall("ask_business_question", { question: "React or Vue?", businessConsequence: "" }); },
      finalMessage("Understood — I'll decide the stack myself and get the team building."),
    ]),
  });
  assert.match(seenInstructions, /NEVER ask technical questions/);
  const events = await store.listEvents(OWNER, conversation.id, 0);
  assert.ok(!events.some((event) => event.type === "question_asked"),
    "a technical question without a business consequence must not reach the user");
  assert.equal((await store.getConversation(OWNER, conversation.id)).state, "idle");
});

test("a genuine business question pauses the conversation for the user", async () => {
  resetLeadAgentForTests();
  resetCapabilityRegistryForTests();
  ensureCoreCapabilities();
  const store = new MemoryConversationStore();
  const conversation = await store.createConversation(OWNER, {});
  await store.claimConversationThinking(conversation);
  await store.appendTurn(conversation, { role: "user", content: "Build me a booking system." });
  await processConversation(conversation, {
    store, runStore: new MemoryCodeAgentStore(),
    credentialResolver: async () => ({ provider: "managed", routing: {} }),
    modelFactory: async () => stubModel([
      toolCall("ask_business_question", {
        question: "Should customers pay when they book, or on arrival?",
        businessConsequence: "Determines whether the booking flow takes payment upfront, which changes your revenue and refund handling.",
      }),
    ]),
  });
  const events = await store.listEvents(OWNER, conversation.id, 0);
  assert.ok(events.some((event) => event.type === "question_asked"));
  assert.equal((await store.getConversation(OWNER, conversation.id)).state, "waiting_user");
});

test("Lead Agent marks a completed provider call ambiguous once when settlement acknowledgement fails", async () => {
  resetLeadAgentForTests();
  resetCapabilityRegistryForTests();
  ensureCoreCapabilities();
  const store = new MemoryConversationStore();
  const conversation = await store.createConversation(OWNER, {});
  await store.claimConversationThinking(conversation);
  await store.appendTurn(conversation, { role: "user", content: "Tell me what you can build." });
  let settles = 0;
  const ambiguous = [];
  await processConversation(conversation, {
    store,
    runStore: new MemoryCodeAgentStore(),
    credentialResolver: async () => ({ provider: "managed", routing: {} }),
    modelFactory: async () => stubModel([{
      ...finalMessage("I can build it."),
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, providerRequestId: "req-lead-success" },
    }]),
    reservationStoreFactory: () => ({
      reserve: async () => ({ id: "lead-hold", billingLane: "managed", acquired: true }),
      settle: async () => { settles += 1; throw new Error("settlement acknowledgement lost"); },
      markAmbiguous: async (owner, id, input) => { ambiguous.push({ owner, id, input }); },
    }),
  });
  assert.equal(settles, 1, "a completed provider response is never classified as a provider failure");
  assert.deepEqual(ambiguous, [{
    owner: OWNER,
    id: "lead-hold",
    input: {
      reason: "provider completed but settlement failed: settlement acknowledgement lost",
      providerRequestIds: ["req-lead-success"],
    },
  }]);
});

test("memory round-trip: remember writes, the next conversation is briefed", async () => {
  resetLeadAgentForTests();
  resetCapabilityRegistryForTests();
  ensureCoreCapabilities();
  const store = new MemoryConversationStore();
  const runStore = new MemoryCodeAgentStore();
  const first = await store.createConversation(OWNER, {});
  await store.claimConversationThinking(first);
  await store.appendTurn(first, { role: "user", content: "I always want dark blue branding. My product is called Booking System." });
  await processConversation(first, {
    store, runStore,
    credentialResolver: async () => ({ provider: "managed", routing: {} }),
    modelFactory: async () => stubModel([
      toolCall("remember", { kind: "preference", content: "Prefers dark blue branding across products.", productName: "Booking System" }),
      finalMessage("Noted — dark blue it is, always."),
    ]),
  });
  const products = await store.listProducts(OWNER);
  assert.equal(products[0].name, "Booking System");

  const second = await store.createConversation(OWNER, {});
  await store.claimConversationThinking(second);
  await store.appendTurn(second, { role: "user", content: "What do you know about me?" });
  let briefed = null;
  await processConversation(second, {
    store, runStore,
    credentialResolver: async () => ({ provider: "managed", routing: {} }),
    modelFactory: async () => stubModel([
      ({ instructions }) => { briefed = instructions; return finalMessage("You prefer dark blue branding, and you're building Booking System."); },
    ]),
  });
  assert.match(briefed, /dark blue branding/);
  assert.match(briefed, /Booking System/);
});

test("repo_change dispatches a budget-checked run linked to the conversation", async () => {
  resetLeadAgentForTests();
  resetCapabilityRegistryForTests();
  resetCodeAgentStoreForTests();
  ensureCoreCapabilities();
  const runStore = codeAgentStore();
  await runStore.createRepository(OWNER, {
    provider: "github", installation_id: 42, full_name: "example/repo",
    clone_url: "https://github.com/example/repo.git", default_branch: "main", private: true,
  });
  const store = new MemoryConversationStore();
  const conversation = await store.createConversation(OWNER, {});
  await store.claimConversationThinking(conversation);
  await store.appendTurn(conversation, { role: "user", content: "Fix the login bug." });
  await processConversation(conversation, {
    store, runStore,
    credentialResolver: async () => ({ provider: "managed", routing: {} }),
    modelFactory: async () => stubModel([
      toolCall("repo_change", { task: "Fix the login bug: investigate and repair." }),
      finalMessage("The Builder is on it — I'll report back here when the fix is ready."),
    ]),
  });
  const events = await store.listEvents(OWNER, conversation.id, 0);
  const linked = events.find((event) => event.type === "run_linked");
  assert.ok(linked, "run_linked event emitted");
  const run = await runStore.getRun(OWNER, linked.payload.runId);
  assert.equal(run.mode, "agent");
  assert.match(run.prompt, /login bug/);
  assert.ok(events.some((event) => event.type === "agent_spawned" && event.payload.agent === "Builder"));
  assert.ok(events.some((event) => event.type === "agent_done" && event.payload.agent === "Builder"));
});

test("postUserMessage creates conversations, streams, and refuses concurrent messages", async () => {
  resetLeadAgentForTests();
  resetCapabilityRegistryForTests();
  ensureCoreCapabilities();
  const store = new MemoryConversationStore();
  const { conversation, processing } = await postUserMessage(OWNER, { text: "Hello team" }, {
    store,
    processOptions: {
      runStore: new MemoryCodeAgentStore(),
      credentialResolver: async () => ({ provider: "managed", routing: {} }),
      modelFactory: async () => stubModel([finalMessage("Hello! What shall we build?")]),
    },
  });
  assert.equal(conversation.state, "thinking");
  await assert.rejects(
    postUserMessage(OWNER, { conversationId: conversation.id, text: "impatient" }, { store }),
    (error) => error.code === "conversation_busy",
  );
  await processing;
  const events = await store.listEvents(OWNER, conversation.id, 0);
  const types = events.map((event) => event.type);
  assert.deepEqual(types[0], "message");
  assert.ok(types.includes("agent_spawned"));
  assert.equal(events.at(-1).type, "message");
  assert.equal(events.at(-1).payload.role, "lead");
  assert.equal((await store.getConversation(OWNER, conversation.id)).state, "idle");
  const after = await store.listEvents(OWNER, conversation.id, events.at(-1).sequence - 1);
  assert.equal(after.length, 1, "after-resume returns only newer events");
});

test("a bare retry resumes the exact preserved V2 build without consulting the Lead model", async () => {
  resetLeadAgentForTests();
  resetCapabilityRegistryForTests();
  ensureCoreCapabilities();
  const store = new MemoryConversationStore();
  const conversation = await store.createConversation(OWNER, {});
  await store.appendTurn(conversation, { role: "user", content: "Build the planner" });
  await store.appendTurn(conversation, {
    role: "lead",
    content: "Builder V2 call cannot fit a useful response inside approved headroom",
    payload: { pipelineVersion: "v2", projectId: "project-1", jobId: "job-1" },
  });
  await store.appendTurn(conversation, { role: "user", content: "Try again" });
  await store.claimConversationThinking(conversation);
  let modelCreated = false;
  let dispatched = null;
  await processConversation(conversation, {
    store,
    runStore: new MemoryCodeAgentStore(),
    credentialResolver: async () => { throw new Error("retry must precede credential/model dispatch"); },
    modelFactory: async () => { modelCreated = true; throw new Error("model must not run"); },
    retryDispatcher: async ({ ctx, target }) => {
      dispatched = target;
      await ctx.emit("build_started", {
        jobId: "job-2", projectId: target.projectId, buildId: "diag-2", pipelineVersion: "v2",
      });
      return { handled: true, result: {
        jobId: "job-2", projectId: target.projectId, buildId: "diag-2", pipelineVersion: "v2",
      } };
    },
  });
  assert.deepEqual(dispatched, {
    jobId: "job-1",
    projectId: "project-1",
    failure: "Builder V2 call cannot fit a useful response inside approved headroom",
  });
  assert.equal(modelCreated, false);
  const turns = await store.listTurns(OWNER, conversation.id);
  assert.equal(turns.filter((turn) => turn.role === "user").length, 2);
  assert.equal(turns.at(-1).content, buildDispatchConfirmation("resume"));
  assert.doesNotMatch(turns.at(-1).content, /Build ID|``/);
  assert.deepEqual(turns.at(-1).payload, {
    projectId: "project-1", jobId: "job-2", buildId: "diag-2",
    pipelineVersion: "v2", dispatch: "resume",
  });
  const events = await store.listEvents(OWNER, conversation.id, 0);
  assert.equal(events.filter((event) => event.type === "build_started").length, 1);
  assert.equal((await store.getConversation(OWNER, conversation.id)).state, "idle");
});

test("retry targeting requires a bare retry and a durable V2 terminal identity", () => {
  const terminal = { role: "lead", content: "failed", payload: {
    pipelineVersion: "v2", projectId: "project", jobId: "job",
  } };
  assert.deepEqual(preservedBuildRetryTarget([terminal, { role: "user", content: "Continue" }]), {
    projectId: "project", jobId: "job", failure: "failed",
  });
  assert.deepEqual(preservedBuildRetryTarget([
    terminal,
    { role: "lead", content: "The retained build could not resume yet. Its checkpoint is preserved and no replacement project was created." },
    { role: "user", content: "Retry again" },
  ]), { projectId: "project", jobId: "job", failure: "failed" });
  assert.deepEqual(preservedBuildRetryTarget([
    terminal,
    { role: "user", content: "Retry again" },
    { role: "lead", content: "The retained build could not resume yet. Its checkpoint is preserved and no replacement project was created." },
    { role: "user", content: "Retry again" },
  ]), { projectId: "project", jobId: "job", failure: "failed" });
  assert.equal(preservedBuildRetryTarget([
    terminal,
    { role: "lead", content: "I changed something else." },
    { role: "user", content: "Retry again" },
  ]), null);
  assert.equal(preservedBuildRetryTarget([terminal, { role: "user", content: "Try again with a darker theme" }]), null);
  assert.equal(preservedBuildRetryTarget([{ role: "user", content: "Try again" }]), null);
});

test("a pre-dispatch resume failure preserves the exact retry identity", async () => {
  resetLeadAgentForTests();
  resetCapabilityRegistryForTests();
  ensureCoreCapabilities();
  const store = new MemoryConversationStore();
  const conversation = await store.createConversation(OWNER, {});
  await store.appendTurn(conversation, {
    role: "lead", content: "failed",
    payload: { pipelineVersion: "v2", projectId: "project-1", jobId: "job-1" },
  });
  await store.appendTurn(conversation, { role: "user", content: "Retry again" });
  await store.claimConversationThinking(conversation);
  await processConversation(conversation, {
    store,
    runStore: new MemoryCodeAgentStore(),
    retryDispatcher: async () => {
      throw Object.assign(new Error("column bv2_builds.created_at does not exist"), { code: "42703" });
    },
  });
  const turns = await store.listTurns(OWNER, conversation.id);
  assert.equal(turns.at(-1).content,
    "The retained build could not resume yet. Its checkpoint is preserved and no replacement project was created.");
  assert.deepEqual(turns.at(-1).payload, {
    projectId: "project-1", jobId: "job-1", pipelineVersion: "v2",
    retryDispatchFailure: true, errorCode: "42703",
  });
});

test("successful build capability output closes with canonical copy instead of a model-written blank ID", async () => {
  resetLeadAgentForTests();
  resetCapabilityRegistryForTests();
  ensureCoreCapabilities();
  // Keep coreRegistered true while replacing the registry with one deterministic test capability.
  resetCapabilityRegistryForTests();
  registerCapability({
    id: "app_build", specialist: "Builder", description: "test build",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    invoke: async (ctx) => {
      await ctx.emit("build_started", {
        jobId: "job", projectId: "project", buildId: "7b93a4b7-0d95-4320-9e8f-514a0745e124",
        pipelineVersion: "v2",
      });
      return {
        jobId: "job", projectId: "project", buildId: "7b93a4b7-0d95-4320-9e8f-514a0745e124",
        pipelineVersion: "v2",
      };
    },
  });
  const store = new MemoryConversationStore();
  const conversation = await store.createConversation(OWNER, {});
  await store.appendTurn(conversation, { role: "user", content: "Build it" });
  await store.claimConversationThinking(conversation);
  let modelTurns = 0;
  await processConversation(conversation, {
    store, runStore: new MemoryCodeAgentStore(),
    credentialResolver: async () => ({ provider: "managed", routing: {} }),
    modelFactory: async () => ({
      turn: async () => {
        modelTurns += 1;
        if (modelTurns > 1) throw new Error("a second model turn must not write dispatch copy");
        return toolCall("app_build", {});
      },
    }),
  });
  assert.equal(modelTurns, 1);
  const turns = await store.listTurns(OWNER, conversation.id);
  assert.equal(turns.at(-1).content, buildDispatchConfirmation("build"));
  assert.doesNotMatch(turns.at(-1).content, /Build ID|``|7b93a4b7/);
  assert.deepEqual(turns.at(-1).payload, {
    projectId: "project", jobId: "job", buildId: "7b93a4b7-0d95-4320-9e8f-514a0745e124",
    pipelineVersion: "v2", dispatch: "build",
  });
});

test("stale thinking conversations recover so the Lead Agent never visibly dies", async () => {
  const store = new MemoryConversationStore();
  const conversation = await store.createConversation(OWNER, {});
  await store.claimConversationThinking(conversation);
  const row = await store.getConversation(OWNER, conversation.id);
  row.updated_at = new Date(Date.now() - 10 * 60_000).toISOString();
  const recovered = await recoverStaleConversations({ store });
  assert.equal(recovered.length, 1);
  assert.equal((await store.getConversation(OWNER, conversation.id)).state, "idle");
  const events = await store.listEvents(OWNER, conversation.id, 0);
  assert.equal(events.at(-1).type, "lead_recovered");
});

test("conversation usage is metered as standalone budget spend", async () => {
  resetLeadAgentForTests();
  resetCapabilityRegistryForTests();
  ensureCoreCapabilities();
  const store = new MemoryConversationStore();
  const runStore = new MemoryCodeAgentStore();
  const conversation = await store.createConversation(OWNER, {});
  await store.claimConversationThinking(conversation);
  await store.appendTurn(conversation, { role: "user", content: "hi" });
  await processConversation(conversation, {
    store, runStore,
    credentialResolver: async () => ({ provider: "managed", routing: {} }),
    modelFactory: async () => stubModel([finalMessage("Hi!")]),
  });
  const usage = [...runStore.usageRecords.values()];
  assert.equal(usage.length, 1);
  assert.equal(usage[0].billing_source, "managed");
  assert.equal(usage[0].metadata.kind, "conversation");
});
