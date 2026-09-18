// THE GENERATION ENVELOPE IS ESTIMATED AGAINST MEASURED TOKENISATION.
//
// Production rerun 675d2a73 (recessed-light calculator, medium profile, 2026-09-17): the core prompt
// wire was 275,912 bytes. The estimator called it 110,877 tokens; the medium envelope is 9 credits
// (90,000 tokens); "maximum fitting output 0" forced twelve isolated headroom batches, whose files
// were generated without seeing each other, and the build blocked at 40.29 credits before the
// browser. The provider's own usage on that build's calls tokenised prompts at 4.0-4.5 bytes per
// token on the exact wire. These tests pin the estimator to that evidence and prove the retained build would now run
// its core as ONE full-context call with its full 16k output - with no provider call.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  estimatePromptTokens, planCallReservation, createModelLanes, coreSystemPrompt, renderPatchPrompt,
  ESTIMATED_BYTES_PER_TOKEN, ESTIMATED_FRAMING_TOKENS, HEADROOM_FRAGMENT_SYSTEM_PROMPT,
} from "../../shell/server/lib/builderV2/modelLanes.mjs";
import { EMIT_PATCHES_SCHEMA } from "../../shell/server/lib/builderV2/patchEngine.mjs";
import { stepOutputPolicy } from "../../shell/server/lib/builderV2/runtimeComposition.mjs";
import { memoryKnowledgeStore } from "../../shell/server/lib/builderV2/knowledge.mjs";
import { memoryModelReservations } from "../../shell/server/lib/builderV2/modelReservations.mjs";
import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import { coreGenerationScope, staticCandidateVerdict } from "../../shell/server/lib/builderV2/preRepairPipeline.mjs";
import { moduleCorrectionScope } from "../../shell/server/lib/builderV2/moduleContracts.mjs";

const RETAINED = new URL("./fixtures/retained/medium-20260917-recessed/", import.meta.url);
const MEDIUM = stepOutputPolicy("core", { profile: "medium" });
const ENVELOPE_TOKENS = MEDIUM.callCeilingCredits * 10_000;
// The estimator that fragmented the retained build, kept only to state what changed.
const previousEstimate = (bytes) => Math.ceil((bytes / 3) * 1.2) + 512;

// The exact wire the lane sent for a retained call: its system prompt, the user prompt and the
// tool schema. The retained table records the user prompt's bytes and which system prompt the
// dispatch used; the provider's usage covers all three.
const SYSTEM_PROMPTS = { core: coreSystemPrompt(), headroom_fragment: HEADROOM_FRAGMENT_SYSTEM_PROMPT };
const retainedWire = (call) => ({
  systemPrompt: SYSTEM_PROMPTS[call.systemPrompt], messages: [{ role: "user", content: "x".repeat(call.bytes) }], tools: [EMIT_PATCHES_SCHEMA],
});
const wireBytes = (options) => Buffer.byteLength(options.systemPrompt, "utf8") + Buffer.byteLength(options.messages[0].content, "utf8") + Buffer.byteLength(JSON.stringify(options.tools), "utf8");

test("the estimator never underestimates a measured call and no longer inflates by 1.6-1.8x", async () => {
  const { calls } = JSON.parse(await readFile(new URL("measured-calls.json", RETAINED), "utf8"));
  assert.ok(calls.length >= 15);
  const margins = [];
  for (const call of calls) {
    assert.ok(SYSTEM_PROMPTS[call.systemPrompt], `${call.label}: retained system prompt kind ${call.systemPrompt}`);
    const options = retainedWire(call);
    const wire = wireBytes(options);
    const estimated = estimatePromptTokens(options);
    const ratio = estimated / call.actualInputTokens;
    assert.ok(estimated >= call.actualInputTokens, `${call.label} (${wire} wire bytes): estimated ${estimated} < actual ${call.actualInputTokens}`);
    // The provider tokenised every retained wire at 4.02 bytes per token or sparser.
    assert.ok(wire / call.actualInputTokens >= 4.0, `${call.label}: ${(wire / call.actualInputTokens).toFixed(2)} bytes per token`);
    if (wire >= 20_000) {
      margins.push(ratio);
      assert.ok(ratio <= 1.35, `${call.label}: margin ${ratio.toFixed(2)} is not a calibrated estimate`);
    }
    if (wire >= 60_000) {
      const before = previousEstimate(wire) / call.actualInputTokens;
      assert.ok(before >= 1.5, `${call.label}: the previous estimator inflated this call ${before.toFixed(2)}x`);
    }
  }
  assert.ok(margins.length >= 12);
  assert.ok(Math.min(...margins) >= 1.05, `smallest margin ${Math.min(...margins).toFixed(2)} keeps a safety allowance`);
  assert.equal(ESTIMATED_BYTES_PER_TOKEN, 3.8);
  assert.equal(ESTIMATED_FRAMING_TOKENS, 512);
});

async function retainedCore(treeFile = "tree-foundation-scaffold-77c68fda.json") {
  const raw = JSON.parse(await readFile(new URL("contract.json", RETAINED), "utf8"));
  const contract = raw.contract || raw;
  const spec = deriveBuildSpec(contract);
  const scope = coreGenerationScope(spec, contract);
  const tree = JSON.parse(await readFile(new URL(treeFile, RETAINED), "utf8"));
  const scoped = scope.scoped;
  const prompt = renderPatchPrompt({
    step: "core", originalStep: "core", contract: spec.contract, tiers: scope.generationTiers, tree,
    journey: scope.journeys[0] || null, rejections: [], problems: [], editRequest: null, projectKnowledge: null,
    modulePlan: scoped.modulePlan, moduleContracts: scoped.moduleContracts,
    repairScope: null, moduleCorrectionScope: null, headroomScope: null, repairBoundary: null, regenerateFiles: [], advisory: [],
    capabilityGraph: scoped.capabilityGraph, compositionPlan: scoped.compositionPlan,
    scaffoldGraph: scoped.scaffoldGraph, scaffoldPlan: scoped.scaffoldCompositionPlan,
  });
  return { contract, spec, scope, scoped, tree, prompt };
}

test("the retained recessed core fits the medium envelope with its full 16k output; the previous estimator could not fit it", async () => {
  const { prompt } = await retainedCore();
  const options = { systemPrompt: coreSystemPrompt(), messages: [{ role: "user", content: prompt }], tools: [EMIT_PATCHES_SCHEMA] };
  const bytes = Buffer.byteLength(prompt, "utf8");
  assert.ok(bytes > 200_000, `the retained core prompt is ${bytes} bytes`);
  const estimated = estimatePromptTokens(options);
  assert.ok(estimated + MEDIUM.maxOutputTokens <= ENVELOPE_TOKENS,
    `estimated ${estimated} + ${MEDIUM.maxOutputTokens} output must fit ${ENVELOPE_TOKENS}`);
  assert.ok(previousEstimate(bytes) > ENVELOPE_TOKENS, "the previous estimator alone exceeded the whole envelope, before any output");
  const plan = planCallReservation(options, "gpt-5.5", {
    requestedMaxOutputTokens: MEDIUM.maxOutputTokens, callCeilingCredits: MEDIUM.callCeilingCredits,
    budget: { approvedCeilingCredits: 30, consumedCredits: 0, reservedCredits: 0, remainingCredits: 30 },
  });
  assert.equal(plan.maxOutputTokens, MEDIUM.maxOutputTokens);
  assert.equal(plan.estimatedInputTokens, estimated);
});

test("the lane dispatches the retained recessed core as ONE full-context call, never a headroom batch", async () => {
  const { spec, scope, scoped, tree } = await retainedCore();
  let providerCalls = 0;
  const logs = [];
  const provider = {
    model: "gpt-5.5", provider: "codex",
    runTurn: async () => {
      providerCalls += 1;
      return {
        text: "", toolCalls: [{ id: "c", name: "emit_patches", arguments: { patches: [{
          newFile: "src/screens/scaffold/DashboardScreen.jsx", content: "export default function DashboardScreen(){return <main>Dashboard</main>}",
        }] } }],
        usage: { input: 57_000, output: 300, total: 57_300, providerRequestId: "req-retained-core" },
      };
    },
  };
  const lanes = createModelLanes({
    providerForStep: async () => ({ provider, decision: {
      provider: "codex", model: "gpt-5.5", billingLane: "connected_allowance",
      estimatedCredits: MEDIUM.estimatedCredits, callCeilingCredits: MEDIUM.callCeilingCredits, maxOutputTokens: MEDIUM.maxOutputTokens,
    } }),
    ceilingCredits: 30, reservations: memoryModelReservations(), knowledgeStore: memoryKnowledgeStore(), log: (line) => logs.push(String(line)),
  });
  const patches = await lanes.patchesFn({
    owner: "owner", projectId: "project", buildId: "build", step: "core", originalStep: "core",
    contract: spec.contract, tiers: scope.generationTiers, tree, journey: scope.journeys[0] || null,
    rejections: [], problems: [], modulePlan: scoped.modulePlan, moduleContracts: scoped.moduleContracts, spec: scoped,
  });
  assert.equal(providerCalls, 1, "one full-context core call");
  assert.equal(patches.dispatchScope, undefined, "no headroom scope was attached");
  assert.ok(!logs.some((line) => /exceeds its per-call envelope|continuing internally/.test(line)), logs.join("\n"));
});

// Retained candidate core-2 (85406063) is the tree behind the rerun's four-screen correction. The
// orchestrator retained it and asked for a correction of exactly four screens; the lane rendered a
// 753k-byte prompt (the full scoped capability graph and every interaction flow, raw), estimated
// 316,254 tokens, and fragmented the correction into isolated batches. A bounded dispatch now
// carries the bounded briefs headroom continuations always had.
function retainedCorrection({ spec, scope, scoped, tree }) {
  const verdict = staticCandidateVerdict(tree, { contract: spec.contract, journeys: scope.journeys, scoped, stepId: "core" });
  const correction = moduleCorrectionScope(verdict.conformance, scoped.moduleContracts);
  assert.equal(verdict.conformance.correction?.wholeCoreRequired, false);
  assert.deepEqual(correction.allowedFiles, [
    "src/screens/scaffold/AdminAreaScreen.jsx", "src/screens/scaffold/EstimateAndProjectSummaryScreen.jsx",
    "src/screens/scaffold/ProductsCatalogueScreen.jsx", "src/screens/scaffold/ProjectDetailScreen.jsx",
  ]);
  const problems = [...(verdict.conformance.blocking || []), ...(verdict.persistenceVerdict.blocking || [])].map((row) => JSON.stringify(row));
  return { verdict, correction, problems };
}

test("the retained four-screen correction renders bounded briefs and fits the medium envelope with its full output", async () => {
  const loaded = await retainedCore("tree-candidate-core-2-85406063.json");
  const { spec, scope, scoped, tree } = loaded;
  const { verdict, correction, problems } = retainedCorrection(loaded);
  const prompt = renderPatchPrompt({
    step: "core", originalStep: "core", contract: spec.contract, tiers: scope.generationTiers, tree,
    journey: scope.journeys[0] || null, rejections: [], problems, editRequest: null, projectKnowledge: null,
    modulePlan: scoped.modulePlan, moduleContracts: scoped.moduleContracts,
    repairScope: null, moduleCorrectionScope: correction, headroomScope: null, repairBoundary: null, regenerateFiles: [], advisory: verdict.advisory,
    capabilityGraph: scoped.capabilityGraph, compositionPlan: scoped.compositionPlan,
    scaffoldGraph: scoped.scaffoldGraph, scaffoldPlan: scoped.scaffoldCompositionPlan,
  });
  assert.match(prompt, /CORE CORRECTION: preserve the current candidate/);
  const graphStart = prompt.indexOf("CAPABILITY GRAPH (");
  const graphEnd = prompt.indexOf("DETERMINISTIC CAPABILITY COMPOSITION", graphStart);
  assert.ok(graphStart > 0 && graphEnd > graphStart);
  const graphBytes = Buffer.byteLength(prompt.slice(graphStart, graphEnd), "utf8");
  assert.ok(graphBytes < 40_000, `the bounded graph brief is ${graphBytes} bytes; the raw scoped graph was 438k`);
  const bytes = Buffer.byteLength(prompt, "utf8");
  assert.ok(bytes < 300_000, `the correction prompt is ${bytes} bytes`);
  const estimated = estimatePromptTokens({ systemPrompt: coreSystemPrompt(), messages: [{ role: "user", content: prompt }], tools: [EMIT_PATCHES_SCHEMA] });
  assert.ok(estimated + MEDIUM.maxOutputTokens <= ENVELOPE_TOKENS, `estimated ${estimated} + ${MEDIUM.maxOutputTokens} output must fit ${ENVELOPE_TOKENS}`);
});

test("the lane dispatches the retained four-screen correction as ONE bounded call", async () => {
  const loaded = await retainedCore("tree-candidate-core-2-85406063.json");
  const { spec, scope, scoped, tree } = loaded;
  const { correction, problems } = retainedCorrection(loaded);
  let providerCalls = 0;
  const logs = [];
  const provider = {
    model: "gpt-5.5", provider: "codex",
    runTurn: async () => {
      providerCalls += 1;
      return {
        text: "", toolCalls: [{ id: "c", name: "emit_patches", arguments: { patches: [{
          newFile: "src/screens/scaffold/ProjectDetailScreen.jsx", content: "export default function ProjectDetailScreen(){return <main>Project</main>}",
        }] } }],
        usage: { input: 60_000, output: 400, total: 60_400, providerRequestId: "req-retained-correction" },
      };
    },
  };
  const lanes = createModelLanes({
    providerForStep: async () => ({ provider, decision: {
      provider: "codex", model: "gpt-5.5", billingLane: "connected_allowance",
      estimatedCredits: MEDIUM.estimatedCredits, callCeilingCredits: MEDIUM.callCeilingCredits, maxOutputTokens: MEDIUM.maxOutputTokens,
    } }),
    ceilingCredits: 30, reservations: memoryModelReservations(), knowledgeStore: memoryKnowledgeStore(), log: (line) => logs.push(String(line)),
  });
  const patches = await lanes.patchesFn({
    owner: "owner", projectId: "project", buildId: "build", step: "core", originalStep: "core",
    contract: spec.contract, tiers: scope.generationTiers, tree, journey: scope.journeys[0] || null,
    rejections: [], problems, modulePlan: scoped.modulePlan, moduleContracts: scoped.moduleContracts,
    moduleCorrectionScope: correction, spec: scoped,
  });
  assert.equal(providerCalls, 1, "one bounded correction call");
  assert.equal(patches.dispatchScope, undefined, "no headroom fragmentation");
  assert.ok(!logs.some((line) => /exceeds its per-call envelope|continuing internally/.test(line)), logs.join("\n"));
});
