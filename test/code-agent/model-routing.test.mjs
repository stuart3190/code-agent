import assert from "node:assert/strict";
import test from "node:test";

process.env.OPENAI_API_KEY = "test-openai";
process.env.GEMINI_API_KEY = "test-gemini";
process.env.CODE_AGENT_DEFAULT_PROVIDER = "openai";

const { MemoryAiRoutingStore } = await import("../../shell/server/lib/aiRoutingStore.mjs");
const { createRoutedCodingModel, routeCandidates } = await import("../../shell/server/lib/modelRouting.mjs");

test("balanced routing promotes complex production work to quality models", () => {
  const candidates = routeCandidates({
    credential: { provider: "managed" },
    policy: { routingMode: "balanced" },
    prompt: "Investigate a production authentication race condition",
  });
  assert.equal(candidates[0].tier, "quality");
  assert.equal(candidates[0].provider, "openai");
});

test("managed router never widens its billing lane after a retry-safe provider rejection", async () => {
  const store = new MemoryAiRoutingStore();
  const model = await createRoutedCodingModel({
    owner: "owner",
    run: { id: "run", prompt: "Fix this" },
    credential: { provider: "managed" },
    requested: "auto",
    policy: { routingMode: "balanced", allowFallback: true },
    store,
    providerFactory: (candidate) => ({
      id: candidate.provider,
      model: candidate.model,
      async turn() {
        if (candidate.provider === "openai") {
          const error = new Error("rate limited");
          error.status = 429;
          error.code = "rate_limit_exceeded";
          error.dispatchState = "provider_rejected";
          error.retrySafe = true;
          throw error;
        }
        return {
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] }],
          text: "Done",
          usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
        };
      },
    }),
  });

  await assert.rejects(model.turn({ instructions: "test", input: [], tools: [] }), /rate limited/);
  const attempts = await store.listRecentAttempts("owner");
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].status, "error");
  assert.equal(attempts[0].retryable, true);
});

test("router does not mask authentication failures", async () => {
  const store = new MemoryAiRoutingStore();
  const model = await createRoutedCodingModel({
    owner: "owner",
    run: { id: "run", prompt: "Fix this" },
    credential: { provider: "managed" },
    policy: { routingMode: "balanced", allowFallback: true },
    store,
    providerFactory: () => ({
      async turn() {
        const error = new Error("invalid key");
        error.status = 401;
        error.code = "invalid_api_key";
        throw error;
      },
    }),
  });
  await assert.rejects(model.turn({ instructions: "test", input: [], tools: [] }), /invalid key/);
  assert.equal((await store.listRecentAttempts("owner")).length, 1);
});

test("successful provider settlement is not reversed when attempt telemetry fails", async () => {
  let settled = 0;
  let failed = 0;
  const model = await createRoutedCodingModel({
    owner: "owner", credential: { provider: "managed" }, requested: "auto",
    policy: { routingMode: "balanced", allowFallback: true },
    store: { listRecentAttempts: async () => [], recordAttempt: async () => { throw new Error("telemetry down"); } },
    providerFactory: (candidate) => ({
      id: candidate.provider, model: candidate.model,
      turn: async () => ({ text: "Done", output: [], usage: { totalTokens: 1 } }),
    }),
  });
  const response = await model.turn({
    instructions: "test", input: [], tools: [],
    beforeDispatch: async () => ({ id: "hold" }),
    afterDispatch: async () => { settled += 1; },
    dispatchFailed: async () => { failed += 1; },
  });
  assert.equal(response.text, "Done");
  assert.equal(settled, 1);
  assert.equal(failed, 0);
});

test("a completed provider call with uncertain settlement fails closed without fallback", async () => {
  let providerCalls = 0;
  let failureTransitions = 0;
  const model = await createRoutedCodingModel({
    owner: "owner", credential: { provider: "managed" }, requested: "auto",
    policy: { routingMode: "balanced", allowFallback: true },
    store: new MemoryAiRoutingStore(),
    providerFactory: (candidate) => ({
      id: candidate.provider, model: candidate.model,
      turn: async () => {
        providerCalls += 1;
        return { text: "Done", output: [], usage: { totalTokens: 1 } };
      },
    }),
  });
  await assert.rejects(model.turn({
    instructions: "test", input: [], tools: [],
    beforeDispatch: async () => ({ id: "hold" }),
    afterDispatch: async () => { throw new Error("settlement acknowledgement lost"); },
    dispatchFailed: async () => { failureTransitions += 1; },
  }), (error) => error.code === "billing_settlement_failed");
  assert.equal(providerCalls, 1);
  assert.equal(failureTransitions, 0);
});
