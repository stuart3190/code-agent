import assert from "node:assert/strict";
import test from "node:test";
import { toNeutralMessages } from "../../shell/server/lib/anthropicCodingProvider.mjs";
import { resolveModelSelection } from "../../shell/server/lib/modelGateway.mjs";

test("model gateway resolves explicit commercial providers", () => {
  assert.deepEqual(resolveModelSelection("openai:gpt-5.6-sol"), { provider: "openai", model: "gpt-5.6-sol" });
  assert.deepEqual(resolveModelSelection("anthropic:claude-sonnet-4-6"), {
    provider: "anthropic", model: "claude-sonnet-4-6",
  });
  assert.deepEqual(resolveModelSelection("gemini:gemini-3.6-flash"), {
    provider: "gemini", model: "gemini-3.6-flash",
  });
  assert.deepEqual(resolveModelSelection("gemini-3.5-flash-lite"), {
    provider: "gemini", model: "gemini-3.5-flash-lite",
  });
  assert.deepEqual(resolveModelSelection("claude-opus-4-1"), { provider: "anthropic", model: "claude-opus-4-1" });
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
