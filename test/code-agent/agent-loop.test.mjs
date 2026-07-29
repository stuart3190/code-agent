import assert from "node:assert/strict";
import test from "node:test";
import { runCodingAgent } from "../../shell/server/lib/codingAgent.mjs";

test("coding loop executes a tool then returns a verified result", async () => {
  const calls = [];
  let turn = 0;
  const provider = {
    model: "fake",
    async turn() {
      turn += 1;
      if (turn === 1) return {
        text: "", usage: { inputTokens: 1 },
        output: [{ type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"README.md\"}" }],
      };
      return {
        text: "Updated and verified.", usage: { outputTokens: 2 },
        output: [{ type: "message", content: [{ type: "output_text", text: "Updated and verified." }] }],
      };
    },
  };
  const runner = {
    readFile: async (path) => { calls.push(path); return "# Readme"; },
    diff: async () => ({ output: "diff" }),
    status: async () => ({ output: " M README.md" }),
  };
  const result = await runCodingAgent({
    run: { prompt: "Update it", owner: "owner", model: "auto" }, runner, provider,
    emit: async () => {}, isCancelled: async () => false,
  });
  assert.deepEqual(calls, ["README.md"]);
  assert.equal(result.summary, "Updated and verified.");
  assert.equal(result.diff, "diff");
});
