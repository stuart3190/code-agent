// PRE-REPAIR PIPELINE PARITY — retained trees are judged exactly as the builds that made them.
//
// Zero-model validation of a retained candidate used to re-derive the core scope by hand and
// compare whole-app secondary placeholders against core-tier generation, reporting 6-21 blocking
// findings per attempt that production never saw. preRepairPipeline is now the one scoping and
// verdict authority for the orchestrator and for local validation; these tests pin that the two
// agree, and that every retained candidate production sent to the browser is static-clean under it.

import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

import { deriveBuildSpec, scopeBuildSpec, journeysInMountedScreenUnit } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import { coreGenerationScope, staticCandidateVerdict } from "../../shell/server/lib/builderV2/preRepairPipeline.mjs";
import { validateModuleConformance } from "../../shell/server/lib/builderV2/moduleContracts.mjs";
import { lintDurablePersistence } from "../../shell/server/lib/builderV2/persistenceLint.mjs";
import { runStaticApplicationGate } from "../../shell/server/lib/builderV2/staticApplicationGate.mjs";
import { partitionFindings } from "../../shell/server/lib/builderV2/validationSeverity.mjs";

const RETAINED = new URL("./fixtures/retained/advanced-20260916/", import.meta.url);
const load = async (url) => { const raw = JSON.parse(await readFile(url, "utf8")); return raw.contract || raw; };
// The last core candidate before the first browser verification, per attempt that reached it.
const BROWSER_REACHING = {
  "6833295": "tree-candidate-core-2-a56fbefb.json",
  f8e2281: "tree-candidate-core-2-e58a77db.json",
  ca48824: "tree-candidate-core-3-f391f8a0.json",
  "46aab6c": "tree-candidate-core-2-b87d6667.json",
};

test("the core scope is exactly what the orchestrator computed inline", async () => {
  for (const short of Object.keys(BROWSER_REACHING)) {
    const contract = await load(new URL(`${short}/contract.json`, RETAINED));
    const spec = deriveBuildSpec(contract);
    const scope = coreGenerationScope(spec, contract);
    const journeysById = new Map(contract.journeys.map((journey) => [journey.id, journey]));
    const essential = spec.tiers.essential.journeys.map((id) => journeysById.get(id)).filter(Boolean);
    const expected = journeysInMountedScreenUnit(spec, essential);
    assert.deepEqual(scope.journeyIds, expected.map((journey) => journey.id), short);
    assert.deepEqual(scope.generationTiers.essential.journeys, scope.journeyIds);
    assert.ok(scope.incrementJourneys.every((journey) => !scope.journeyIds.includes(journey.id)));
    assert.deepEqual(scope.scoped.scopedJourneyIds, scopeBuildSpec(spec, expected).scopedJourneyIds);
    assert.equal(scope.contract, contract, "the full contract is what production passes to the checks");
  }
});

test("the canonical verdict equals the orchestrator's direct calls, finding for finding", async () => {
  for (const [short, file] of Object.entries(BROWSER_REACHING)) {
    const contract = await load(new URL(`${short}/contract.json`, RETAINED));
    const tree = JSON.parse(await readFile(new URL(`${short}/${file}`, RETAINED), "utf8"));
    const spec = deriveBuildSpec(contract);
    const scope = coreGenerationScope(spec, contract);
    const verdict = staticCandidateVerdict(tree, scope);
    const { scoped, journeys } = scope;
    const conformance = validateModuleConformance(tree, {
      contract, modulePlan: scoped.modulePlan, moduleContracts: scoped.moduleContracts,
      interactionContract: scoped.interactionContract, bindings: scoped.bindings, capabilityGraph: scoped.capabilityGraph,
    });
    const persistence = partitionFindings(lintDurablePersistence(tree, { contract, journeys, modulePlan: scoped.modulePlan }).findings || []);
    const gate = runStaticApplicationGate(tree, { contract, modulePlan: scoped.modulePlan, journeys, stage: { id: "core", journeys } });
    const codes = (rows) => rows.map((row) => row.code).sort();
    assert.deepEqual(codes(verdict.conformance.blocking), codes(conformance.blocking), short);
    assert.deepEqual(codes(verdict.persistenceVerdict.blocking), codes(persistence.blocking), short);
    assert.deepEqual(codes(verdict.gate.blocking || []), codes(gate.blocking || []), short);
    assert.equal(verdict.ok, !conformance.blocking.length && !persistence.blocking.length && gate.ok !== false, short);
  }
});

test("every retained candidate production sent to the browser is static-clean under canonical scoping", async () => {
  for (const [short, file] of Object.entries(BROWSER_REACHING)) {
    const contract = await load(new URL(`${short}/contract.json`, RETAINED));
    const tree = JSON.parse(await readFile(new URL(`${short}/${file}`, RETAINED), "utf8"));
    const spec = deriveBuildSpec(contract);
    const verdict = staticCandidateVerdict(tree, coreGenerationScope(spec, contract));
    assert.deepEqual(verdict.blocking.map((row) => `${row.code}: ${String(row.message || "").slice(0, 120)}`), [], short);
  }
});

test("a whole-app scope is NOT the core scope: secondary placeholders appear only outside the core tier", async () => {
  const short = "ca48824";
  const contract = await load(new URL(`${short}/contract.json`, RETAINED));
  const tree = JSON.parse(await readFile(new URL(`${short}/${BROWSER_REACHING[short]}`, RETAINED), "utf8"));
  const spec = deriveBuildSpec(contract);
  const whole = staticCandidateVerdict(tree, { contract, journeys: contract.journeys, scoped: scopeBuildSpec(spec, contract.journeys) });
  assert.ok(whole.blocking.some((row) => /still unimplemented/.test(String(row.message || ""))),
    "the placeholder screens of increment journeys are real, and belong to the increments");
  const core = staticCandidateVerdict(tree, coreGenerationScope(spec, contract));
  assert.deepEqual(core.blocking, []);
});

test("the retained first core candidates carry the blocking findings production corrected", async () => {
  // 62841e8's first candidate was a headroom batch that left the journey controller unmounted;
  // production logged a blocking correction. The canonical verdict must see it too.
  const short = "ca48824";
  const contract = await load(new URL(`${short}/contract.json`, RETAINED));
  const files = (await readdir(new URL(`${short}/`, RETAINED))).filter((file) => /^tree-candidate-core-1-[0-9a-f]{8}\.json$/.test(file)).sort();
  const first = JSON.parse(await readFile(new URL(`${short}/${files[0]}`, RETAINED), "utf8"));
  const spec = deriveBuildSpec(contract);
  const verdict = staticCandidateVerdict(first, coreGenerationScope(spec, contract));
  assert.ok(verdict.blocking.length > 0, "an unfinished headroom batch is not runnable");
});

// ── THE WHOLE PRE-REPAIR PIPELINE, EVERY RETAINED ADVANCED FIXTURE, NO MODEL ───────────────────
// contract validator → interaction/provenance gate → core scope → execution specification
// (complete, deterministic) → static verdict on the candidate production sent to the browser.
test("every retained Advanced fixture passes the full pre-repair pipeline deterministically", async () => {
  const { validateContract } = await import("../../shell/shared/implementationContract.mjs");
  const { buildExecutionSpec, renderExecutionSpecBrief, executionSpecCoverage } = await import("../../shell/server/lib/builderV2/executionSpec.mjs");
  const { persistenceOwnershipPlan } = await import("../../shell/server/lib/builderV2/contractTiering.mjs");
  const shorts = (await readdir(RETAINED)).filter((name) => /^[0-9a-f]{7}$/.test(name));
  assert.ok(shorts.length >= 6);
  for (const short of shorts) {
    const contract = await load(new URL(`${short}/contract.json`, RETAINED));
    const validated = validateContract(contract);
    // The retained contracts predate the verifiable-outcome rule; its four known findings are
    // pinned in builder-v2-verifiable-outcomes. Every other validator rule must hold.
    const other = (validated.problems || []).filter((problem) => !/states no verifiable outcome/.test(problem));
    assert.deepEqual(other, [], `${short}: validator`);
    const spec = deriveBuildSpec(contract);
    assert.equal(spec.verdict.ok, true, `${short}: gate — ${spec.verdict.problems.join("; ")}`);
    assert.equal(spec.interactionContract.valid, true, `${short}: interaction contract`);
    const scope = coreGenerationScope(spec, contract);
    assert.ok(scope.journeyIds.length > 0, `${short}: a core scope`);
    const sources = {
      capabilityGraph: scope.scoped.capabilityGraph, scaffoldGraph: scope.scoped.scaffoldGraph,
      modulePlan: scope.scoped.modulePlan, moduleContracts: scope.scoped.moduleContracts,
      interactionContract: scope.scoped.interactionContract,
      persistencePlan: persistenceOwnershipPlan(contract, scope.journeys, scope.scoped.modulePlan),
    };
    const text = renderExecutionSpecBrief(buildExecutionSpec(sources));
    assert.deepEqual(executionSpecCoverage(text, sources).missing, [], `${short}: execution specification complete`);
    assert.equal(text, renderExecutionSpecBrief(buildExecutionSpec(sources)), `${short}: deterministic`);
    const file = BROWSER_REACHING[short];
    if (!file) continue; // attempts that never produced a candidate: nothing to judge statically
    const tree = JSON.parse(await readFile(new URL(`${short}/${file}`, RETAINED), "utf8"));
    const verdict = staticCandidateVerdict(tree, scope);
    assert.deepEqual(verdict.blocking.map((row) => row.code), [], `${short}: static verdict on the browser-reaching candidate`);
  }
});
