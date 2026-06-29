// Offline runAgent tests — NO model (a scripted fake provider). Proves the Phase 2.2
// empty-turn retry hardening without spending Codex turns.
// Run: node harness/_runagent-tests.mjs   (exit 0 = all pass)

import { runAgent } from "../src/engine/runAgent.mjs";

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

const USAGE = { input: 10, output: 0, reasoning: 0, cached: 0, total: 10 };

// A provider that replays a fixed script of turn results, counting how many times it's called.
function fakeProvider(script) {
  let i = 0;
  return {
    calls: 0,
    runTurn() {
      this.calls++;
      const r = script[Math.min(i, script.length - 1)];
      i++;
      return Promise.resolve({ usage: USAGE, ...r });
    },
  };
}

const noop = () => {};

console.log("runAgent empty-turn retry:");

// 1. transient empty turn (no text, no tool call) -> retry once -> then completes.
{
  const provider = fakeProvider([
    { text: "", toolCalls: [] }, // empty -> should retry
    { text: "done", toolCalls: [] }, // completion on retry
  ]);
  const { finalText } = await runAgent({ provider, systemPrompt: "s", tools: [], toolImpls: {}, tree: {}, prompt: "p", log: noop });
  check("retries a single empty turn then finishes", finalText === "done");
  check("retry actually re-called the provider (2 calls)", provider.calls === 2);
}

// 2. two consecutive empty turns -> give up after one retry (no infinite loop).
{
  const provider = fakeProvider([{ text: "", toolCalls: [] }]); // always empty
  const { finalText } = await runAgent({ provider, systemPrompt: "s", tools: [], toolImpls: {}, tree: {}, prompt: "p", log: noop });
  check("gives up after the retry also comes back empty", finalText === "");
  check("gives up at exactly 2 calls (1 + 1 retry), no runaway", provider.calls === 2);
}

// 3. a normal completion (non-empty text, no tool call) finishes immediately, no retry.
{
  const provider = fakeProvider([{ text: "all done", toolCalls: [] }]);
  const { finalText } = await runAgent({ provider, systemPrompt: "s", tools: [], toolImpls: {}, tree: {}, prompt: "p", log: noop });
  check("normal completion finishes on the first turn", finalText === "all done" && provider.calls === 1);
}

// 4. emptyStreak resets after a productive (tool-call) turn — a later empty turn still gets its retry.
{
  const provider = fakeProvider([
    { text: "", toolCalls: [{ id: "t1", name: "list_files", arguments: {}, rawArguments: "{}" }] }, // productive
    { text: "", toolCalls: [] }, // empty -> retry
    { text: "finished", toolCalls: [] }, // completion
  ]);
  const tree = { "a.js": "x" };
  const impls = { list_files: () => ({ files: Object.keys(tree) }) };
  const { finalText } = await runAgent({ provider, systemPrompt: "s", tools: [], toolImpls: impls, tree, prompt: "p", log: noop });
  check("tool turn resets the empty streak; later empty still retries", finalText === "finished" && provider.calls === 3);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
