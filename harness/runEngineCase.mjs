// Run one archetype case through the engine, with an optional targeted edit format.
// Shared by the A/B trial and by run.mjs so both measure identically.
//
//   runEngineCase(provider, case, { editFormat, contextSelection, workName }) -> result
//
// editFormat: undefined -> write-only (baseline path); "apply_patch" | "search_replace".
// contextSelection: Phase 2.2 input-side lever (manifest + relevant-file contents + history pruning).

import { runAgent } from "../src/engine/runAgent.mjs";
import { fromScaffold, clone } from "../src/engine/fileTree.mjs";
import { makeFileTools } from "../src/tools/fileTools.mjs";
import { systemPromptForEdit } from "../src/prompts/builder.mjs";
import { markersPresent } from "./assertions.mjs";
import { buildTree } from "./workspace.mjs";

export async function runEngineCase(provider, c, { editFormat, contextSelection, cacheFriendly, workName } = {}) {
  const tree = clone(fromScaffold(c.scaffold, c.startFiles));
  const { schemas, impls, stats } = makeFileTools(tree, { editFormat });

  const { telemetry, turnLog, finalText } = await runAgent({
    provider,
    systemPrompt: systemPromptForEdit(editFormat),
    tools: schemas,
    toolImpls: impls,
    tree,
    prompt: c.editPrompt,
    contextSelection,
    cacheFriendly,
  });

  const build = await buildTree(tree, workName || c.name);
  const prior = markersPresent(tree, c.priorFeatures);
  const fresh = markersPresent(tree, c.newFeature);
  const pass = build.ok && prior.missing.length === 0 && fresh.missing.length === 0;

  return {
    name: c.name,
    pass,
    build: build.ok,
    prior,
    fresh,
    telemetry,
    turnLog,
    editStats: stats(),
    finalText,
    appBytes: Buffer.byteLength(tree["src/App.jsx"] || ""),
  };
}
