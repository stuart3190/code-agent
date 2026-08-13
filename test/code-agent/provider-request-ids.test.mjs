import assert from "node:assert/strict";
import test from "node:test";

test("openaiEngineProvider captures the provider response id", async () => {
  const { createOpenAIEngineProvider } = await import("../../shell/server/lib/appBuild/openaiEngineProvider.mjs");
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({
      id: "resp_real_path_001",
      output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }],
      usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 40 } },
    }),
  });
  const provider = createOpenAIEngineProvider({ apiKey: "k", model: "gpt-5.6-sol", fetchImpl: fakeFetch });
  const turn = await provider.runTurn({ systemPrompt: "s", messages: [], tools: [] });
  assert.equal(turn.usage.providerRequestId, "resp_real_path_001");
  assert.equal(turn.usage.cached, 40, "cached tokens still flow");
});

test("telemetry aggregates distinct provider ids without multiplying duplicates", async () => {
  const { createTelemetry } = await import("../../src/engine/telemetry.mjs");
  const telemetry = createTelemetry();
  telemetry.record({ input: 10, output: 5, reasoning: 0, cached: 0, total: 15, providerRequestId: "resp_a" });
  telemetry.record({ input: 10, output: 5, reasoning: 0, cached: 0, total: 15, providerRequestId: "resp_b" });
  const summary = telemetry.summary();
  assert.deepEqual(summary.providerRequestIds, ["resp_a", "resp_b"]);

  const rows = new Map();
  const persist = (value) => {
    const key = value.providerRequestIds.join("|");
    if (!rows.has(key)) rows.set(key, value);
  };
  persist(summary);
  persist(summary);
  assert.equal(rows.size, 1);
});

test("failed-call telemetry preserves an issued provider response id", async () => {
  const { normalizeTelemetry } = await import("../../shell/server/lib/appBuild/buildDiagnostics.mjs");
  const normalized = normalizeTelemetry({
    input: 500,
    output: 0,
    cached: 0,
    reasoning: 0,
    total: 500,
    providerRequestIds: ["resp_failed_but_metered"],
  });
  assert.deepEqual(normalized.providerRequestIds, ["resp_failed_but_metered"]);
});
