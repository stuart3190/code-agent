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

test("router falls back on retryable failures and records both attempts", async () => {
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

  const result = await model.turn({ instructions: "test", input: [], tools: [] });
  assert.equal(result.provider, "gemini");
  assert.equal(result.routing.fallbackFrom.provider, "openai");
  const attempts = await store.listRecentAttempts("owner");
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].status, "success");
  assert.equal(attempts[1].retryable, true);
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
