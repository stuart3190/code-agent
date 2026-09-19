import assert from "node:assert/strict";
import test from "node:test";

process.env.PLATFORM_ENC_KEY = "22".repeat(32);
process.env.OPENAI_API_KEY = "managed-test-key";
process.env.CODE_AGENT_DEFAULT_PROVIDER = "openai";

const { MemoryAiRoutingStore } = await import("../../shell/server/lib/aiRoutingStore.mjs");
const { runModelEvaluation } = await import("../../shell/server/lib/modelEvaluations.mjs");
const { memoryDirectModelReservations } = await import("../../shell/server/lib/directModelReservations.mjs");
const { DISPATCH_STATES, providerFailure } = await import("../../shell/server/lib/providerOutcome.mjs");

test("model evaluations encrypt prompts and outputs while returning owner-safe results", async () => {
  const store = new MemoryAiRoutingStore();
  const reservations = memoryDirectModelReservations();
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
    reservationStoreFactory: () => reservations,
  });

  assert.equal(summary.evaluations[0].prompt, prompt);
  assert.equal(summary.evaluations[0].results.length, 3);
  assert.deepEqual(
    summary.evaluations[0].results.map((result) => result.model),
    ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-luna"],
  );
  assert.match(summary.evaluations[0].results[0].output, /empty array/);
  const stored = store.evaluations.get(summary.evaluations[0].id);
  assert.doesNotMatch(stored.prompt_encrypted, /reducer/);
  assert.doesNotMatch(store.results[0].output_encrypted, /empty array/);
  assert.equal(summary.health[0].successRate, 100);
  assert.equal(reservations.rows().length, 3);
  assert.ok(reservations.rows().every((row) => row.state === "settled"));
  assert.ok(reservations.rows().every((row) => row.kind === "model_evaluation"));
});

test("an ambiguous managed evaluation call aborts the candidate sequence and retains its hold", async () => {
  const store = new MemoryAiRoutingStore();
  const reservations = memoryDirectModelReservations();
  let providerCalls = 0;
  await assert.rejects(
    runModelEvaluation("owner", { prompt: "Explain this code" }, {
      store,
      credentialResolver: async () => ({
        provider: "managed", authMode: "managed",
        routing: { routingMode: "balanced", allowFallback: true },
      }),
      reservationStoreFactory: () => reservations,
      providerFactory: () => ({
        async turn() {
          providerCalls += 1;
          throw providerFailure(new Error("connection closed after dispatch"), {
            state: DISPATCH_STATES.ambiguous,
            providerRequestId: "req_eval_ambiguous",
          });
        },
      }),
    }),
    (error) => error.code === "provider_replay_unsafe",
  );
  assert.equal(providerCalls, 1, "evaluation must not dispatch another candidate after ambiguity");
  const [hold] = reservations.rows();
  assert.equal(hold.state, "held");
  assert.equal(hold.reconciliationState, "pending");
  assert.deepEqual(hold.providerRequestIds, ["req_eval_ambiguous"]);
  assert.equal([...store.evaluations.values()][0].status, "failed");
});

test("a safely rejected managed evaluation candidate releases its hold and continues", async () => {
  const store = new MemoryAiRoutingStore();
  const reservations = memoryDirectModelReservations();
  let providerCalls = 0;
  const summary = await runModelEvaluation("owner", { prompt: "Explain this code" }, {
    store,
    credentialResolver: async () => ({
      provider: "managed", authMode: "managed",
      routing: { routingMode: "balanced", allowFallback: true },
    }),
    reservationStoreFactory: () => reservations,
    providerFactory: () => ({
      async turn() {
        providerCalls += 1;
        if (providerCalls === 1) {
          throw providerFailure(new Error("provider rejected request"), {
            state: DISPATCH_STATES.rejected,
          });
        }
        return { text: "Safe answer", output: [], usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } };
      },
    }),
  });
  assert.equal(providerCalls, 3);
  assert.equal(summary.evaluations[0].status, "completed");
  assert.equal(reservations.rows()[0].state, "released");
  assert.ok(reservations.rows().slice(1).every((row) => row.state === "settled"));
});

test("BYOK evaluations keep their existing direct provider path without managed reservations", async () => {
  const store = new MemoryAiRoutingStore();
  let reservationFactories = 0;
  const summary = await runModelEvaluation("owner", { prompt: "Explain this code" }, {
    store,
    credentialResolver: async () => ({
      provider: "openai", secret: "test-user-key", authMode: "byok",
      routing: { routingMode: "balanced", allowFallback: true },
    }),
    reservationStoreFactory: () => { reservationFactories += 1; return memoryDirectModelReservations(); },
    providerFactory: () => ({
      async turn() {
        return { text: "BYOK answer", output: [], usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } };
      },
    }),
  });
  assert.equal(reservationFactories, 0);
  assert.ok(summary.evaluations[0].results.length > 0);
});
