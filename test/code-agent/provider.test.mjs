import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIProvider } from "../../shell/server/lib/openAIProvider.mjs";

test("commercial OpenAI adapter sends Responses tool input and normalizes output", async () => {
  let request;
  const provider = createOpenAIProvider({
    apiKey: "test-key",
    model: "gpt-test",
    reasoningEffort: "low",
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return new Response(JSON.stringify({
        id: "resp_1",
        output: [{ type: "message", content: [{ type: "output_text", text: "Done" }] }],
        usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const result = await provider.turn({
    instructions: "Work carefully", input: [{ role: "user", content: "Fix it" }], tools: [],
    safetyIdentifier: "owner-id",
  });
  assert.equal(request.store, false);
  assert.equal(request.model, "gpt-test");
  assert.deepEqual(request.reasoning, { effort: "low" });
  assert.equal(result.text, "Done");
  assert.equal(result.usage.totalTokens, 13);
});
