import assert from "node:assert/strict";
import test from "node:test";
import { toNeutralMessages } from "../../shell/server/lib/anthropicCodingProvider.mjs";
import { resolveModelSelection } from "../../shell/server/lib/modelGateway.mjs";

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
