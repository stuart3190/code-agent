import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIProvider } from "../../shell/server/lib/openAIProvider.mjs";
import {
  createGeminiCodingProvider,
  toGeminiInput,
} from "../../shell/server/lib/geminiCodingProvider.mjs";

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

test("Gemini Interactions adapter is stateless and round-trips tool history", async () => {
  let request;
  const provider = createGeminiCodingProvider({
    apiKey: `AIza${"x".repeat(36)}`,
    model: "gemini-test",
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return new Response(JSON.stringify({
        id: "interaction_1",
        status: "requires_action",
        steps: [{ type: "function_call", id: "call_1", name: "read_file", arguments: { path: "README.md" } }],
        usage: {
          total_input_tokens: 12,
          total_output_tokens: 4,
          total_thought_tokens: 2,
          total_tokens: 18,
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const result = await provider.turn({
    instructions: "Work carefully",
    input: [{ role: "user", content: "Inspect it" }],
    tools: [{
      type: "function", name: "read_file", description: "Read a file",
      strict: true,
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    }],
  });

  assert.equal(request.store, false);
  assert.equal(request.system_instruction, "Work carefully");
  assert.equal(request.tools[0].type, "function");
  assert.equal(request.tools[0].strict, undefined);
  assert.equal(result.output[0].call_id, "call_1");
  assert.equal(result.usage.reasoningTokens, 2);
  assert.deepEqual(toGeminiInput([
    { role: "user", content: "Inspect it" },
    result.output[0],
    { type: "function_call_output", call_id: "call_1", output: "{\"ok\":true}" },
  ]), [
    { type: "user_input", content: [{ type: "text", text: "Inspect it" }] },
    { type: "function_call", id: "call_1", name: "read_file", arguments: { path: "README.md" } },
    {
      type: "function_result",
      name: "read_file",
      call_id: "call_1",
      result: [{ type: "text", text: "{\"ok\":true}" }],
    },
  ]);
});
