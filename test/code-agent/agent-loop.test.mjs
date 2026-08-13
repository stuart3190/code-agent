import assert from "node:assert/strict";
import test from "node:test";
import { runCodingAgent } from "../../shell/server/lib/codingAgent.mjs";
import {
  createManagedDirectDispatchAccounting, memoryDirectModelReservations,
} from "../../shell/server/lib/directModelReservations.mjs";

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

test("managed coding-agent turns each reserve before dispatch and settle atomically", async () => {
  const recorded = [];
  const reservations = memoryDirectModelReservations({
    runStore: { recordUsage: async (...args) => recorded.push(args) },
  });
  const accounting = createManagedDirectDispatchAccounting({
    owner: "owner", kind: "coding_agent", subjectId: "run-1", runId: "run-1",
    reservations, maxOutputTokens: 400,
  });
  let turn = 0;
  const provider = {
    id: "openai", model: "gpt-5.6-luna",
    async turn(args) {
      turn += 1;
      assert.equal(args.maxOutputTokens, 400);
      if (turn === 1) return {
        id: "req_agent_1",
        text: "", usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
        output: [{ type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"README.md\"}" }],
      };
      return {
        id: "req_agent_2",
        text: "Done", usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
        output: [{ type: "message", content: [{ type: "output_text", text: "Done" }] }],
      };
    },
  };
  await runCodingAgent({
    run: { id: "run-1", prompt: "Inspect", owner: "owner", model: "auto" },
    runner: {
      readFile: async () => "# Readme",
      diff: async () => ({ output: "" }),
      status: async () => ({ output: "" }),
    },
    provider,
    dispatchAccounting: accounting,
    maxOutputTokens: 400,
    emit: async () => {},
    isCancelled: async () => false,
  });
  assert.equal(turn, 2);
  assert.equal(reservations.rows().length, 2);
  assert.ok(reservations.rows().every((row) => row.state === "settled"));
  assert.deepEqual(reservations.rows().map((row) => row.providerRequestIds), [["req_agent_1"], ["req_agent_2"]]);
  assert.equal(recorded.length, 2);
});

test("coding-agent never replays a completed turn whose settlement became ambiguous", async () => {
  const base = memoryDirectModelReservations();
  const reservations = { ...base, settle: async () => { throw new Error("settlement offline"); } };
  const accounting = createManagedDirectDispatchAccounting({
    owner: "owner", kind: "coding_agent", subjectId: "run-2", runId: "run-2",
    reservations, maxOutputTokens: 400,
  });
  let providerCalls = 0;
  await assert.rejects(
    runCodingAgent({
      run: { id: "run-2", prompt: "Inspect", owner: "owner", model: "auto" },
      runner: {},
      provider: {
        id: "openai", model: "gpt-5.6-luna",
        async turn() {
          providerCalls += 1;
          return {
            id: "req_agent_completed",
            text: "Done", output: [{ type: "message", content: [] }],
            usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
          };
        },
      },
      dispatchAccounting: accounting,
      maxOutputTokens: 400,
      emit: async () => {},
      isCancelled: async () => false,
    }),
    (error) => error.code === "provider_replay_unsafe",
  );
  assert.equal(providerCalls, 1);
  const [hold] = base.rows();
  assert.equal(hold.state, "held");
  assert.equal(hold.reconciliationState, "pending");
  assert.deepEqual(hold.providerRequestIds, ["req_agent_completed"]);
});
