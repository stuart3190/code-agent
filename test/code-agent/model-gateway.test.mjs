import assert from "node:assert/strict";
import test from "node:test";
import {
  createAnthropicCodingProvider, toNeutralMessages,
} from "../../shell/server/lib/anthropicCodingProvider.mjs";
import { createCodingModelForCredential, resolveModelSelection, toCodexLeadMessages } from "../../shell/server/lib/modelGateway.mjs";

test("model gateway resolves explicit commercial providers", () => {
  assert.deepEqual(resolveModelSelection("managed:openai:gpt-5.6-sol"), { provider: "openai", model: "gpt-5.6-sol" });
  assert.deepEqual(resolveModelSelection("byok_api:anthropic:claude-sonnet-5", { defaultLane: "byok_api" }), {
    provider: "anthropic", model: "claude-sonnet-5",
  });
  assert.deepEqual(resolveModelSelection("byok_api:gemini:gemini-3.6-flash", { defaultLane: "byok_api" }), {
    provider: "gemini", model: "gemini-3.6-flash",
  });
  assert.throws(() => resolveModelSelection("gemini-3.5-flash-lite"), /must include lane/);
  assert.throws(() => resolveModelSelection("byok_api:anthropic:claude-opus-4-1", { defaultLane: "byok_api" }), /not executable/);
});

test("Codex Lead adapter preserves tool calls, usage, and request identity", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response([
      'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_1","name":"app_build","arguments":"{\\"description\\":\\"A site\\"}"}}',
      'data: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":10,"input_tokens_details":{"cached_tokens":4},"output_tokens":3,"output_tokens_details":{"reasoning_tokens":1},"total_tokens":13}}}',
      "",
    ].join("\n\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
    const model = createCodingModelForCredential({ provider: "codex" });
    const result = await model.turn({
      instructions: "Use tools", input: [{ role: "user", content: "Build" }],
      tools: [{ name: "app_build", description: "Build", parameters: { type: "object" } }],
    });
    assert.deepEqual(result.output, [{
      type: "function_call", call_id: "call_1", name: "app_build", arguments: "{\"description\":\"A site\"}",
    }]);
    assert.deepEqual(result.usage, {
      inputTokens: 10, cachedTokens: 4, outputTokens: 3, reasoningTokens: 1, totalTokens: 13,
      providerRequestId: "codex:response:resp_1",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Codex Lead adapter carries function call history into the next turn", () => {
  assert.deepEqual(toCodexLeadMessages([
    { role: "user", content: "Build it" },
    { type: "function_call", call_id: "call_1", name: "app_build", arguments: "{\"description\":\"A site\"}" },
    { type: "function_call_output", call_id: "call_1", output: "{\"jobId\":\"job-1\"}" },
  ]), [
    { role: "user", content: "Build it" },
    { role: "assistant", toolCalls: [{ id: "call_1", name: "app_build", arguments: "{\"description\":\"A site\"}" }] },
    { role: "tool", toolCallId: "call_1", name: null, output: "{\"jobId\":\"job-1\"}" },
  ]);
});
test("Anthropic adapter preserves user, tool call, and tool output history", () => {
  assert.deepEqual(toNeutralMessages([
    { role: "user", content: "Inspect the repo" },
    { type: "reasoning", id: "provider-specific" },
    { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"README.md\"}" },
    { type: "function_call_output", call_id: "call_1", output: "contents" },
  ]), [
    { role: "user", content: "Inspect the repo" },
    { role: "assistant", toolCalls: [{ id: "call_1", name: "read_file", arguments: "{\"path\":\"README.md\"}" }] },
    { role: "tool", toolCallId: "call_1", output: "contents" },
  ]);
});

test("Anthropic coding adapter preserves durable provider request identity", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response([
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":4}}}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Done"}}',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
      "",
    ].join("\n\n"), {
      status: 200,
      headers: { "content-type": "text/event-stream", "request-id": "req_anthropic_1" },
    });
    const model = createAnthropicCodingProvider({ apiKey: "test-key", model: "claude-sonnet-5" });
    const result = await model.turn({ instructions: "Answer", input: [{ role: "user", content: "Hi" }], tools: [] });
    assert.equal(result.usage.providerRequestId, "req_anthropic_1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
