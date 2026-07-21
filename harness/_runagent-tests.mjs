// Offline runAgent tests — NO model (a scripted fake provider). Proves the Phase 2.2
// empty-turn retry hardening without spending Codex turns.
// Run: node harness/_runagent-tests.mjs   (exit 0 = all pass)

import { runAgent } from "../src/engine/runAgent.mjs";
import { costForUsage, ASSUMED_CACHED_INPUT_MULTIPLIER } from "../src/cost.mjs";
import { createTelemetry } from "../src/engine/telemetry.mjs";

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

console.log("\nPhase 2.3 cached-token billing:");

// 5. costForUsage discounts cached input (a subset of input) vs charging it full price.
{
  const u = { input: 1000, output: 100, reasoning: 0, cached: 900, total: 1100 };
  const discounted = costForUsage(u).usd;
  const fullPrice = costForUsage({ ...u, cached: 0 }).usd;
  // 900 cached tokens move from full input rate to 10% of it → strictly cheaper.
  check("cached tokens are billed cheaper than full input", discounted < fullPrice);
  // Exact: uncached 100 + cached 900*0.1 + output 100 (in 'input-equivalent' units the input part is 100 + 90 = 190).
  const expectedUsd =
    (100 / 1e6) * 1.25 + (900 / 1e6) * 1.25 * ASSUMED_CACHED_INPUT_MULTIPLIER + (100 / 1e6) * 10;
  check("cached discount math is exact", Math.abs(discounted - expectedUsd) < 1e-12);
}

// 6. cached==0 is identical to the pre-2.3 formula (no silent baseline drift).
{
  const u = { input: 1000, output: 100, reasoning: 0, cached: 0, total: 1100 };
  const legacy = (1000 / 1e6) * 1.25 + (100 / 1e6) * 10;
  check("cached==0 reduces to the legacy full-input cost exactly", Math.abs(costForUsage(u).usd - legacy) < 1e-12);
}

// 7. telemetry accumulates cached + reports a hit rate, and its gbp is the discounted one.
{
  const t = createTelemetry();
  t.record({ input: 1000, output: 0, reasoning: 0, cached: 800, total: 1000 });
  t.record({ input: 1000, output: 0, reasoning: 0, cached: 200, total: 1000 });
  const s = t.summary();
  check("telemetry sums cached across turns", s.cached === 1000);
  check("telemetry reports cache hit rate (cached/input)", Math.abs(s.cacheHitRate - 1000 / 2000) < 1e-12);
  const undiscounted = createTelemetry();
  undiscounted.record({ input: 1000, output: 0, reasoning: 0, cached: 0, total: 1000 });
  undiscounted.record({ input: 1000, output: 0, reasoning: 0, cached: 0, total: 1000 });
  check("telemetry gbp reflects the cache discount", s.gbp < undiscounted.summary().gbp);
}

// 8. runAgent surfaces cached through to the returned telemetry summary.
{
  const provider = {
    calls: 0,
    runTurn() {
      this.calls++;
      return Promise.resolve({ text: "done", toolCalls: [], usage: { input: 2000, output: 0, reasoning: 0, cached: 1500, total: 2000 } });
    },
  };
  const { telemetry } = await runAgent({ provider, systemPrompt: "s", tools: [], toolImpls: {}, tree: {}, prompt: "p", log: noop });
  check("runAgent telemetry carries cached tokens end-to-end", telemetry.cached === 1500);
}

// 9. A caller-side usage ceiling is checked before provider-returned mutations are applied.
{
  const provider = fakeProvider([
    { text: "", toolCalls: [{ id: "t1", name: "write_file", arguments: { path: "x", contents: "y" }, rawArguments: "{}" }] },
  ]);
  let mutated = false;
  let stopped = false;
  try {
    await runAgent({
      provider, systemPrompt: "s", tools: [], tree: {}, prompt: "p", log: noop,
      toolImpls: { write_file: () => { mutated = true; return { ok: true }; } },
      onUsage: () => { throw new Error("budget reached"); },
    });
  } catch (e) {
    stopped = e.message === "budget reached";
  }
  check("usage guard stops the run before over-budget tool mutations", stopped && !mutated && provider.calls === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
