// Drive one real repair agent, with the real brief, over the real file tools.
//
// Deliberately the same seam the pipeline uses — `runAgent` with `makeFileTools` in apply_patch
// mode and the edit system prompt — so what this proves is what production does, not an
// approximation of it. The only thing supplied from outside is the brief, which is the subject of
// the proof.
//
// This spends real tokens. Nothing calls it except a proof run with --with-agent.

import { runAgent } from "../../src/engine/runAgent.mjs";
import { makeFileTools } from "../../src/tools/fileTools.mjs";
import { systemPromptForEdit } from "../../src/prompts/builder.mjs";
import { createAnthropicProvider } from "../../src/providers/anthropicProvider.mjs";

export async function runRepairForProof({ tree, brief, provider = null }) {
  const working = { ...tree };
  const before = { ...tree };
  const { schemas, impls, stats } = makeFileTools(working, { editFormat: "apply_patch" });

  const engine = provider || createAnthropicProvider({ cache: false });
  const { telemetry, finalText } = await runAgent({
    provider: engine,
    systemPrompt: systemPromptForEdit("apply_patch"),
    tools: schemas,
    toolImpls: impls,
    tree: working,
    prompt: brief,
  });

  const changedPaths = [...new Set([...Object.keys(before), ...Object.keys(working)])]
    .filter((path) => before[path] !== working[path]);

  return { tree: working, changedPaths, telemetry, finalText, editStats: stats() };
}
