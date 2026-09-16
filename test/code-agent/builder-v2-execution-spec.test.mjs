// THE CANONICAL EXECUTION SPECIFICATION — full generation states every fact once and fits its call.
//
// Before this layer the core prompt of every retained 2026-09-16 Advanced attempt serialised the
// scoped capability graph, the per-module contracts, the scaffold composition and the interaction
// contract as four full JSON documents that restated the same responsibilities, state paths and
// control identities up to six times: 118k-274k estimated input tokens against a 120k-token
// Advanced core envelope. These tests pin the redesign on the retained corpus: the specification
// is complete (no enforced identity is lost), deterministic, a fraction of the legacy size, and
// the production core prompt fits the approved Advanced envelope with its full output allowance.

import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import { coreGenerationScope } from "../../shell/server/lib/builderV2/preRepairPipeline.mjs";
import { persistenceOwnershipPlan } from "../../shell/server/lib/builderV2/contractTiering.mjs";
import {
  buildExecutionSpec, renderExecutionSpecBrief, renderExecutionSpecSection, executionSpecCoverage,
  compactInteractionFlow, renderCompactJson, EXECUTION_SPEC_SECTIONS,
} from "../../shell/server/lib/builderV2/executionSpec.mjs";
import { moduleGenerationContractsBrief } from "../../shell/server/lib/builderV2/moduleContracts.mjs";
import { interactionContractBrief } from "../../shell/server/lib/builderV2/interactionContract.mjs";
import { capabilityCompositionBrief } from "../../shell/server/lib/builderV2/capabilityComposer.mjs";
import { scaffoldCompositionBrief } from "../../shell/server/lib/builderV2/scaffoldComposer.mjs";
import {
  renderPatchPrompt, estimatePromptTokens, planCallReservation, headroomDispatchScope,
} from "../../shell/server/lib/builderV2/modelLanes.mjs";
import { stepOutputPolicy } from "../../shell/server/lib/builderV2/runtimeComposition.mjs";

const RETAINED = new URL("./fixtures/retained/advanced-20260916/", import.meta.url);
const SHORTS = ["6833295", "f8e2281", "ca48824", "46aab6c", "1f56b9c", "62841e8"];

async function fixture(short) {
  const raw = JSON.parse(await readFile(new URL(`${short}/contract.json`, RETAINED), "utf8"));
  const contract = raw.contract || raw;
  const spec = deriveBuildSpec(contract);
  const scope = coreGenerationScope(spec, contract);
  const foundation = (await readdir(new URL(`${short}/`, RETAINED))).find((file) => /^tree-foundation-scaffold/.test(file));
  const tree = JSON.parse(await readFile(new URL(`${short}/${foundation}`, RETAINED), "utf8"));
  const scoped = scope.scoped;
  const sources = {
    capabilityGraph: scoped.capabilityGraph, scaffoldGraph: scoped.scaffoldGraph,
    modulePlan: scoped.modulePlan, moduleContracts: scoped.moduleContracts,
    interactionContract: scoped.interactionContract,
    persistencePlan: persistenceOwnershipPlan(contract, scope.journeys, scoped.modulePlan),
  };
  return { contract, spec, scope, scoped, tree, sources };
}

// Exactly the production core dispatch arguments (modelLanes' patchesFn for step "core").
function corePrompt({ spec, scope, scoped, tree }) {
  return renderPatchPrompt({
    step: "core", originalStep: "core", contract: spec.contract, tiers: scope.generationTiers, tree,
    journey: scope.journeys[0] || null, rejections: [], problems: [], editRequest: null, projectKnowledge: null,
    modulePlan: scoped.modulePlan, moduleContracts: scoped.moduleContracts,
    repairScope: null, moduleCorrectionScope: null, headroomScope: null, repairBoundary: null,
    regenerateFiles: [], advisory: [],
    capabilityGraph: scoped.capabilityGraph, compositionPlan: scoped.compositionPlan,
    scaffoldGraph: scoped.scaffoldGraph, scaffoldPlan: scoped.scaffoldCompositionPlan,
  });
}

test("every retained Advanced core scope renders a complete, deterministic specification", async () => {
  for (const short of SHORTS) {
    const { sources } = await fixture(short);
    const text = renderExecutionSpecBrief(buildExecutionSpec(sources));
    const coverage = executionSpecCoverage(text, sources);
    assert.ok(coverage.required > 500, `${short}: the proof checks hundreds of identities (${coverage.required})`);
    assert.deepEqual(coverage.missing, [], `${short}: every enforced identity is stated`);
    assert.equal(text, renderExecutionSpecBrief(buildExecutionSpec(sources)), `${short}: deterministic`);
    for (const section of EXECUTION_SPEC_SECTIONS) {
      // heading line, then the payload up to its unindented closing brace, then the rule text
      const lines = renderExecutionSpecSection(buildExecutionSpec(sources), section).split("\n");
      const close = lines.indexOf("}", 1);
      assert.ok(close > 1, `${short}: ${section} carries a JSON payload`);
      assert.ok(JSON.parse(lines.slice(1, close + 1).join("\n")), `${short}: ${section} payload is valid JSON`);
    }
  }
});

test("the specification is a fraction of the legacy four-document serialisation", async () => {
  for (const short of SHORTS) {
    const { scoped, sources } = await fixture(short);
    const legacy = [
      JSON.stringify(scoped.capabilityGraph, null, 2),
      capabilityCompositionBrief(scoped.capabilityGraph),
      scaffoldCompositionBrief(scoped.scaffoldGraph),
      moduleGenerationContractsBrief(scoped.moduleContracts),
      interactionContractBrief(scoped.interactionContract),
      JSON.stringify(sources.persistencePlan, null, 2),
    ].join("\n").length;
    const compact = renderExecutionSpecBrief(buildExecutionSpec(sources)).length;
    assert.ok(compact < legacy * 0.35, `${short}: ${compact} chars vs legacy ${legacy}`);
  }
});

test("the production Advanced core prompt fits the approved envelope with its full output allowance", async () => {
  const policy = stepOutputPolicy("core", { profile: "advanced" });
  for (const short of SHORTS) {
    const loaded = await fixture(short);
    const prompt = corePrompt(loaded);
    const plan = planCallReservation({ messages: [{ role: "user", content: prompt }] }, "gpt-5.5", {
      requestedMaxOutputTokens: policy.maxOutputTokens, callCeilingCredits: policy.callCeilingCredits,
      budget: { approvedCeilingCredits: 60, consumedCredits: 0, reservedCredits: 0, remainingCredits: 60 },
    });
    assert.equal(plan.maxOutputTokens, policy.maxOutputTokens,
      `${short}: ${plan.estimatedInputTokens} estimated input tokens leave the full ${policy.maxOutputTokens}-token output`);
    assert.match(prompt, /CAPABILITY GRAPH \(authoritative behavior\/state\/data-flow ownership for this scope; each responsibility is stated once here\)/);
    assert.match(prompt, /PER-MODULE GENERATION CONTRACTS/);
    assert.match(prompt, /INTERACTION CONTRACT \(machine-enforced JSON/);
    assert.doesNotMatch(prompt, /"testContract"|"verificationSemantics"|"persistenceSemantics"/,
      "verifier-only registry material is enforced after the patch, not serialised into generation");
    const coverage = executionSpecCoverage(prompt, loaded.sources);
    assert.deepEqual(coverage.missing, [], `${short}: the dispatched prompt itself carries every identity`);
  }
});

test("the proof names exactly what a lossy rendering drops", async () => {
  const { sources } = await fixture("ca48824");
  const spec = buildExecutionSpec(sources);
  const text = renderExecutionSpecBrief(spec);
  const control = sources.interactionContract.flows.find((flow) => flow.control?.machineId);
  const module = sources.moduleContracts.specifications.find((row) => (row.requiredImports || []).length);
  const lossy = text.split(control.control.machineId).join("").split(module.requiredImports[0]).join("");
  const coverage = executionSpecCoverage(lossy, sources);
  const lost = new Set(coverage.missing.map((row) => row.value));
  assert.ok(lost.has(control.control.machineId), "a dropped control identity is reported");
  assert.ok(lost.has(module.requiredImports[0]), "a dropped module dependency is reported");
  assert.ok(coverage.missing.every((row) => lost.size <= 2 || row.value === control.control.machineId
    || row.value === module.requiredImports[0]), "nothing else is reported");
});

test("a specification built without a module's dependencies fails the proof", async () => {
  const { sources } = await fixture("62841e8");
  const stripped = {
    ...sources,
    moduleContracts: {
      ...sources.moduleContracts,
      specifications: sources.moduleContracts.specifications.map((row) => ({ ...row, requiredImports: [] })),
    },
  };
  const text = renderExecutionSpecBrief(buildExecutionSpec(stripped));
  const coverage = executionSpecCoverage(text, sources);
  const expected = sources.moduleContracts.specifications.flatMap((row) => row.requiredImports || []);
  assert.ok(expected.length > 0);
  // Every import path also names a module that exists elsewhere in the spec, so the proof only
  // fires for a dependency whose module the specification never states at all.
  const unstated = [...new Set(expected.filter((path) => !text.includes(path)))].sort();
  assert.ok(unstated.length > 0, "a relative import path is stated nowhere but in its module's contract");
  assert.deepEqual([...new Set(coverage.missing.filter((row) => /requiredImports/.test(row.source)).map((row) => row.value))].sort(),
    unstated);
});

test("bounded repair and headroom dispatches keep their focused briefs and the shared flow projection", async () => {
  const loaded = await fixture("1f56b9c");
  const { spec, scope, scoped, tree } = loaded;
  const controller = scoped.modulePlan.find((module) => module.journeyController === undefined && /Flow\.jsx$/.test(module.path))
    || scoped.modulePlan.find((module) => /Flow\.jsx$/.test(module.path));
  const headroomScope = headroomDispatchScope({
    tree, modulePlan: scoped.modulePlan, moduleContracts: scoped.moduleContracts,
    repairScope: { files: [controller.path], allowedFiles: [controller.path] }, logicalStep: "core",
  });
  const prompt = renderPatchPrompt({
    step: "core", originalStep: "core", contract: spec.contract, tiers: scope.generationTiers, tree,
    modulePlan: scoped.modulePlan, moduleContracts: scoped.moduleContracts,
    capabilityGraph: scoped.capabilityGraph, compositionPlan: scoped.compositionPlan,
    scaffoldGraph: scoped.scaffoldGraph, scaffoldPlan: scoped.scaffoldCompositionPlan, headroomScope,
  });
  assert.doesNotMatch(prompt, /each responsibility is stated once here/, "a continuation keeps its focused graph brief");
  assert.match(prompt, /INTERNAL HEADROOM-SCOPED WRITE BOUNDARY/);
  const flow = scoped.interactionContract.flows.find((row) => row.control?.machineId);
  const projected = compactInteractionFlow({ ...flow, control: { ...flow.control, scope: "plan", qualifiedName: "plan.name" } });
  assert.equal(projected.control.scope, "plan");
  assert.equal(projected.control.qualifiedName, "plan.name");
  assert.ok(!("expectedStateTransition" in compactInteractionFlow(flow, { verifierFacts: false })));
});

test("the compact JSON renderer is valid JSON that keeps primitive arrays on one line", () => {
  const value = { a: [1, "two", null], b: { c: { d: ["x"] } }, e: [] };
  const text = renderCompactJson(value);
  assert.deepEqual(JSON.parse(text), value);
  assert.match(text, /"a": \[1,"two",null\]/);
  assert.equal(renderCompactJson(value), text);
});
