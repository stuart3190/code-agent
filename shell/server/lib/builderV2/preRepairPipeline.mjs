// The pre-repair pipeline's ONE scoping and static-verdict authority.
//
// The orchestrator generates the core tier for "every journey in the essential product screen's
// model-owned write unit" and judges each candidate with module conformance, the durable
// persistence lint and the static application gate. Local, zero-model validation of a retained
// tree used to re-derive that scope by hand and disagreed: it compared whole-app secondary
// placeholders against core-tier generation, reporting blocking findings production never saw
// (2026-09-16 corpus: 6-21 phantom "mounted scaffold screen is still unimplemented" findings per
// attempt). Both callers now come here, so a retained candidate is judged exactly as the build
// that produced it was.

import { journeysInMountedScreenUnit, scopeBuildSpec } from "./buildSpec.mjs";
import { validateModuleConformance } from "./moduleContracts.mjs";
import { lintDurablePersistence } from "./persistenceLint.mjs";
import { rewriteMissingReactImports, runStaticApplicationGate } from "./staticApplicationGate.mjs";
import { partitionFindings } from "./validationSeverity.mjs";

/**
 * The core generation scope of a build: the essential journeys plus every journey rendered by a
 * screen they already require, the spec narrowed to them, and the tier override the orchestrator
 * hands the model. `contract` stays the FULL contract - that is what production passes to the
 * conformance, persistence and gate checks; only the journey list and the derived views narrow.
 */
export function coreGenerationScope(spec, contract, { tiers = spec?.tiers } = {}) {
  const journeysById = new Map((contract?.journeys || []).map((journey) => [journey?.id, journey]));
  const essentialIds = tiers?.essential?.journeys || [];
  const essentialJourneys = essentialIds.map((id) => journeysById.get(id)).filter(Boolean);
  const journeys = journeysInMountedScreenUnit(spec, essentialJourneys);
  const journeyIds = journeys.map((journey) => journey.id);
  const secondaryIds = tiers?.secondary?.journeys || [];
  const incrementJourneys = secondaryIds.map((id) => journeysById.get(id))
    .filter((journey) => journey && !journeyIds.includes(journey.id));
  return {
    journeys, journeyIds, incrementJourneys,
    scoped: scopeBuildSpec(spec, journeys),
    contract,
    generationTiers: tiers ? { ...tiers, essential: { ...tiers.essential, journeys: [...journeyIds] } } : null,
  };
}

/**
 * Deterministic corrections a candidate receives BEFORE it is judged: defects with exactly one
 * safe fix are applied here rather than spending a model correction call on them. The
 * orchestrator and zero-model validation of a retained tree call this same step.
 */
export function preprocessCandidateTree(tree) {
  if (!tree || typeof tree !== "object") return { tree, rewrites: [] };
  const react = rewriteMissingReactImports(tree);
  return { tree: react.tree, rewrites: react.rewrites };
}

/**
 * The static verdict on one candidate tree, with exactly the arguments the orchestrator's core
 * loop and verifyStage use. `blocking` empty means the candidate proceeds to compile and the
 * browser without a correction round.
 */
export function staticCandidateVerdict(tree, { contract, journeys, scoped, stepId = "core" }) {
  const conformance = validateModuleConformance(tree, {
    contract, modulePlan: scoped.modulePlan, moduleContracts: scoped.moduleContracts,
    interactionContract: scoped.interactionContract, bindings: scoped.bindings,
    capabilityGraph: scoped.capabilityGraph,
  });
  const persistence = lintDurablePersistence(tree, { contract, journeys, modulePlan: scoped.modulePlan });
  const persistenceVerdict = partitionFindings(persistence.findings || []);
  const gate = runStaticApplicationGate(tree, {
    contract, modulePlan: scoped.modulePlan || [], journeys, stage: { id: stepId, journeys },
  });
  return {
    conformance, persistence, persistenceVerdict, gate,
    // The orchestrator's own ordering: candidate-shape findings first, then the gate.
    blocking: [...(conformance.blocking || []), ...(persistenceVerdict.blocking || []), ...(gate.blocking || [])],
    advisory: [...(conformance.advisory || []), ...(persistenceVerdict.advisory || []), ...(gate.advisory || [])],
    ok: !(conformance.blocking || []).length && !(persistenceVerdict.blocking || []).length && gate.ok !== false,
  };
}
