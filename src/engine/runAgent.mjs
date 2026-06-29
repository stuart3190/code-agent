// THE tool-use loop — the single, deduplicated heart of the engine, extracted from
// the two near-identical copies in the spike (generate.mjs + iterate.mjs).
//
// Archetype- and provider-agnostic: it speaks only the neutral seam
//   provider.runTurn({ systemPrompt, messages, tools }) -> { text, toolCalls, usage }
// and a generic toolImpls map. Codex specifics live entirely behind the provider.
//
//   runAgent({ provider, systemPrompt, tools, toolImpls, tree, prompt, maxTurns, log })
//     -> { tree, telemetry, finalText }
//
// `tree` is mutated in place by the toolImpls (bind them with makeFileTools(tree)).
// `telemetry` is the summary() of per-turn usage; per-turn lines are logged live.

import { createTelemetry } from "./telemetry.mjs";
import { fmtGBP, TOKENS_PER_CREDIT } from "../cost.mjs";

const DEFAULT_MAX_TURNS = 25;

export async function runAgent({
  provider,
  systemPrompt,
  tools,
  toolImpls,
  tree,
  prompt,
  maxTurns = DEFAULT_MAX_TURNS,
  log = console.log,
}) {
  const messages = [{ role: "user", content: prompt }];
  const telemetry = createTelemetry();
  let finalText = "";

  for (let turn = 1; turn <= maxTurns; turn++) {
    const { text, toolCalls, usage } = await provider.runTurn({ systemPrompt, messages, tools });

    const c = telemetry.record(usage);
    const s = telemetry.summary();
    log(
      `   turn ${turn}: in/out/reason ${usage.input}/${usage.output}/${usage.reasoning}` +
        ` (total ${usage.total}) · cost-if-metered ${fmtGBP(c.gbp)}` +
        ` · running ${s.total} tok = ${(s.total / TOKENS_PER_CREDIT).toFixed(2)} credits`
    );

    if (toolCalls.length === 0) {
      finalText = text;
      break;
    }

    // Record the assistant's tool calls, then execute each and feed results back.
    messages.push({
      role: "assistant",
      toolCalls: toolCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.rawArguments })),
    });

    for (const tc of toolCalls) {
      const impl = toolImpls[tc.name];
      const result = impl ? impl(tc.arguments) : { error: `unknown tool: ${tc.name}` };
      log(`     ↳ ${summarizeCall(tc, result)}`);
      messages.push({
        role: "tool",
        toolCallId: tc.id,
        name: tc.name,
        output: JSON.stringify(result),
      });
    }
  }

  return { tree, telemetry: telemetry.summary(), finalText };
}

// Generic one-line summary of a tool call for the live log.
function summarizeCall(tc, result) {
  const p = tc.arguments?.path;
  if (tc.name === "write_file") {
    return `write_file ${p} (${result.bytes ?? "?"}b${result.created === false ? ", rewrote" : ", new"})`;
  }
  if (tc.name === "read_file") return `read_file ${p}`;
  if (tc.name === "list_files") return "list_files";
  return tc.name + (p ? ` ${p}` : "");
}
