import assert from "node:assert/strict";
import test from "node:test";

process.env.PLATFORM_ENC_KEY = "22".repeat(32);
process.env.OPENAI_API_KEY = "managed-test-key";
process.env.CODE_AGENT_DEFAULT_PROVIDER = "openai";

const { MemoryAiRoutingStore } = await import("../../shell/server/lib/aiRoutingStore.mjs");
const { runModelEvaluation } = await import("../../shell/server/lib/modelEvaluations.mjs");

test("model evaluations encrypt prompts and outputs while returning owner-safe results", async () => {
  const store = new MemoryAiRoutingStore();
  const prompt = "Explain why this reducer needs an initial value.";
  const summary = await runModelEvaluation("owner", { prompt }, {
    store,
    credentialResolver: async () => ({
      provider: "managed",
      authMode: "managed",
      routing: { routingMode: "balanced", allowFallback: true },
    }),
    providerFactory: (candidate) => ({
      id: candidate.provider,
      model: candidate.model,
      async turn() {
        return {
          output: [],
          text: "Without an initial value, an empty array throws.",
          usage: { inputTokens: 8, outputTokens: 9, totalTokens: 17 },
        };
      },
    }),
  });

  assert.equal(summary.evaluations[0].prompt, prompt);
  assert.match(summary.evaluations[0].results[0].output, /empty array/);
  const stored = store.evaluations.get(summary.evaluations[0].id);
  assert.doesNotMatch(stored.prompt_encrypted, /reducer/);
  assert.doesNotMatch(store.results[0].output_encrypted, /empty array/);
  assert.equal(summary.health[0].successRate, 100);
});
