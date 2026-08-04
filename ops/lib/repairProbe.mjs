// Drive one real repair agent, with the real brief, over the real file tools.
//
// Deliberately the same seam the pipeline uses — `runAgent` with `makeFileTools` in apply_patch
// mode and the edit system prompt — so what this proves is what production does, not an
// approximation of it. The only thing supplied from outside is the brief, which is the subject of
// the proof.
//
// This spends real tokens. Nothing calls it except a proof run with --with-agent.

import { loadEnv } from "../../shell/server/lib/env.mjs";
import { runAgent } from "../../src/engine/runAgent.mjs";
import { makeFileTools } from "../../src/tools/fileTools.mjs";
import { systemPromptForEdit } from "../../src/prompts/builder.mjs";
import { createAnthropicProvider } from "../../src/providers/anthropicProvider.mjs";
import { createCodexProvider } from "../../src/providers/codexProvider.mjs";

export async function runRepairForProof({ tree, brief, provider = null }) {
  // The proof runs on the VPS, where the provider key lives in shell/.env like every other secret.
  // loadEnv fills process.env without overwriting anything already set, so an explicitly exported
  // key still wins and the value is never read by this file.
  loadEnv();
  const working = { ...tree };
  const before = { ...tree };
  const { schemas, impls, stats } = makeFileTools(working, { editFormat: "apply_patch" });

  // Whichever provider this deployment actually repairs with. Production's managed lane runs on
  // OpenAI — its ANTHROPIC_API_KEY is empty — and a proof that quietly used a different model from
  // the one doing the real work would not be evidence about the real work.
  const engine = provider
    || (process.env.OPENAI_API_KEY ? createCodexProvider() : createAnthropicProvider({ cache: false }));
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
