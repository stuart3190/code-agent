// Offline tests for the Anthropic BYOK adapter — NO network, NO spend. Proves the neutral<->wire
// translation, tool_result coalescing, SSE accumulation, usage normalisation, and the real-rate
// cost math (incl. the 1.25× cache-write premium) without sending a single token.
// Run: node harness/_anthropic-provider-tests.mjs   (exit 0 = all pass)

import {
  toAnthropicMessages,
  toAnthropicTools,
  buildRequestBody,
  normalizeUsage,
  createAccumulator,
} from "../src/providers/anthropicProvider.mjs";
import { costForUsage, ANTHROPIC_RATES, GPT55_ASSUMED_RATES } from "../src/cost.mjs";

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

console.log("tool translation:");
{
  const tools = [{ name: "read_file", description: "read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
  const wire = toAnthropicTools(tools);
  check("parameters -> input_schema (schema preserved verbatim)", wire[0].input_schema === tools[0].parameters && wire[0].name === "read_file" && !("parameters" in wire[0]));
  check("no tools -> undefined", toAnthropicTools([]) === undefined);
}

console.log("\nmessage translation + tool_result coalescing:");
{
  const messages = [
    { role: "user", content: "build a todo app" },
    { role: "assistant", toolCalls: [
      { id: "toolu_a", name: "read_file", arguments: '{"path":"src/App.jsx"}' },
      { id: "toolu_b", name: "list_files", arguments: "{}" },
    ] },
    { role: "tool", toolCallId: "toolu_a", name: "read_file", output: '{"contents":"x"}' },
    { role: "tool", toolCallId: "toolu_b", name: "list_files", output: '{"files":["src/App.jsx"]}' },
    { role: "assistant", content: "done" },
  ];
  const wire = toAnthropicMessages(messages);

  check("user text -> user/text block", wire[0].role === "user" && wire[0].content[0].type === "text" && wire[0].content[0].text === "build a todo app");
  const asst = wire[1];
  check("assistant toolCalls -> tool_use blocks", asst.role === "assistant" && asst.content.length === 2 && asst.content[0].type === "tool_use");
  check("tool_use input is PARSED from the raw JSON string", asst.content[0].input.path === "src/App.jsx" && typeof asst.content[1].input === "object");
  check("tool_use ids round-trip verbatim", asst.content[0].id === "toolu_a" && asst.content[1].id === "toolu_b");

  // The two neutral tool results must COALESCE into ONE user message (Anthropic requirement).
  const merged = wire[2];
  check("parallel tool results coalesce into ONE user message", merged.role === "user" && merged.content.length === 2 && merged.content.every((b) => b.type === "tool_result"));
  check("tool_result carries tool_use_id + output", merged.content[0].tool_use_id === "toolu_a" && merged.content[0].content === '{"contents":"x"}');
  check("trailing assistant text -> text block (after the merged results)", wire[3].role === "assistant" && wire[3].content[0].text === "done");
  check("exactly 4 wire messages (user, assistant, merged-results, assistant)", wire.length === 4);
}

console.log("\nrequest body + cache_control gating:");
{
  const args = {
    systemPrompt: "SYS",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "list_files", description: "d", parameters: { type: "object", properties: {} } }],
    model: "claude-sonnet-4-6",
  };
  const off = buildRequestBody({ ...args, cache: false });
  check("stream is on", off.stream === true);
  check("tool_choice auto when tools present", off.tool_choice && off.tool_choice.type === "auto");
  check("system is an array of text blocks", Array.isArray(off.system) && off.system[0].type === "text" && off.system[0].text === "SYS");
  check("cache OFF: NO cache_control on system (no write premium on the 2.2 default path)", off.system[0].cache_control === undefined);
  check("cache OFF: NO cache_control on the last message block", off.messages[0].content[off.messages[0].content.length - 1].cache_control === undefined);

  const on = buildRequestBody({ ...args, cache: true });
  check("cache ON: breakpoint on the last system block (caches tools+system prefix)", on.system[on.system.length - 1].cache_control && on.system[on.system.length - 1].cache_control.type === "ephemeral");
  const lastMsg = on.messages[on.messages.length - 1];
  check("cache ON: breakpoint on the last content block of the latest turn", lastMsg.content[lastMsg.content.length - 1].cache_control && lastMsg.content[lastMsg.content.length - 1].cache_control.type === "ephemeral");
}

console.log("\nSSE accumulation:");
{
  const acc = createAccumulator();
  const events = [
    { type: "message_start", message: { usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 80, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello " } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "read_file" } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"' } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'src/App.jsx"}' } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_2", name: "list_files" } },
    { type: "content_block_stop", index: 2 }, // no input deltas -> defaults to "{}"
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 42 } },
  ];
  for (const e of events) acc.push(e);
  const r = acc.result();

  check("text accumulates across deltas", r.text === "Hello world");
  check("two tool calls assembled", r.toolCalls.length === 2);
  check("tool_use input JSON assembled from partial_json deltas", r.toolCalls[0].rawArguments === '{"path":"src/App.jsx"}' && r.toolCalls[0].arguments.path === "src/App.jsx");
  check("empty tool_use defaults to {} (raw + parsed)", r.toolCalls[1].rawArguments === "{}" && Object.keys(r.toolCalls[1].arguments).length === 0);
  check("tool ids preserved for replay", r.toolCalls[0].id === "toolu_1" && r.toolCalls[1].id === "toolu_2");
  check("stop_reason captured", r.stopReason === "tool_use");

  // usage: neutral input folds remainder + read + write; output is the FINAL message_delta value.
  check("usage.input = remainder + cacheRead + cacheWrite", r.usage.input === 200);
  check("usage.cached = cache_read_input_tokens", r.usage.cached === 80);
  check("usage.cacheWrite = cache_creation_input_tokens", r.usage.cacheWrite === 20);
  check("usage.output = final output_tokens (message_delta overrides message_start)", r.usage.output === 42);
  check("usage.total = input + output", r.usage.total === 242);
}

console.log("\nnormalizeUsage edge cases:");
{
  check("null usage -> all zeros", JSON.stringify(normalizeUsage(null)) === JSON.stringify({ input: 0, output: 0, reasoning: 0, cached: 0, cacheWrite: 0, total: 0 }));
  const u = normalizeUsage({ input_tokens: 50, output_tokens: 10 }); // no cache fields
  check("no cache fields -> cached/cacheWrite 0, input = input_tokens", u.input === 50 && u.cached === 0 && u.cacheWrite === 0 && u.total === 60);
}

console.log("\ncost math (REAL Anthropic rates + cache-write premium):");
{
  const sonnet = ANTHROPIC_RATES["claude-sonnet-4-6"];
  const u = { input: 200, output: 42, reasoning: 0, cached: 80, cacheWrite: 20, total: 242 };
  const usd = costForUsage(u, sonnet).usd;
  const expected =
    (100 / 1e6) * 3.0 + // uncached 100 @ $3/M
    (80 / 1e6) * 3.0 * 0.1 + // cache-read 80 @ 0.1×
    (20 / 1e6) * 3.0 * 1.25 + // cache-write 20 @ 1.25×
    (42 / 1e6) * 15.0; // output @ $15/M
  check("sonnet cost is exact (uncached + read 0.1× + write 1.25× + output)", Math.abs(usd - expected) < 1e-12);

  // The write premium really bites: 100 tokens as cache-write cost MORE than as plain input.
  const asWrite = costForUsage({ input: 100, output: 0, cached: 0, cacheWrite: 100, total: 100 }, sonnet).usd;
  const asPlain = costForUsage({ input: 100, output: 0, cached: 0, cacheWrite: 0, total: 100 }, sonnet).usd;
  check("cache-write is billed at a premium over plain input (1.25×)", asWrite > asPlain && Math.abs(asWrite / asPlain - 1.25) < 1e-9);

  // Cache-read is the cheap one.
  const asRead = costForUsage({ input: 100, output: 0, cached: 100, cacheWrite: 0, total: 100 }, sonnet).usd;
  check("cache-read is far cheaper than plain input (0.1×)", Math.abs(asRead / asPlain - 0.1) < 1e-9);
}

console.log("\nback-compat (Codex path is byte-identical):");
{
  // GPT55 assumed rates + no cacheWrite must reduce to the pre-BYOK formula exactly.
  const u = { input: 1000, output: 100, reasoning: 0, cached: 0, total: 1100 };
  const legacy = (1000 / 1e6) * 1.25 + (100 / 1e6) * 10;
  check("gpt-5.5 assumed rates + cacheWrite absent == legacy cost", Math.abs(costForUsage(u, GPT55_ASSUMED_RATES).usd - legacy) < 1e-12);
  // GPT55 write multiplier is 1.0, so even if a cacheWrite slipped in it would NOT add a premium.
  const withWrite = { input: 1000, output: 100, reasoning: 0, cached: 0, cacheWrite: 300, total: 1100 };
  check("gpt-5.5 write multiplier is 1.0 (no premium) -> same as legacy", Math.abs(costForUsage(withWrite, GPT55_ASSUMED_RATES).usd - legacy) < 1e-12);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
