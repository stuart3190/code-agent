// The canonical derived build specification.
//
// One contract used to be re-interpreted independently by at least four subsystems: the
// orchestrator derived a module plan, interactionContract derived its own from the same prose,
// persistenceOwnershipPlan derived a third, and modelLanes assembled all of them plus tiers and
// bindings into a prompt. Each derivation ran its own regex pass over model-written journey
// text, so the requirements Thrallo enforced could — and did — drift from the requirements
// Thrallo briefed.
//
// This module derives all of it ONCE per build and hands the result down. Nothing here is new
// logic: it is the existing deterministic functions, called in dependency order, with a single
// owner. Scoping an increment narrows the same object rather than recomputing it.

import {
  bindCapabilities, bindingsForJourneys, deriveModulePlan, imageIntents, persistenceOwnershipPlan,
  tierContract,
} from "./contractTiering.mjs";
import {
  buildInteractionContract, scopeInteractionContract, validateInteractionContract,
} from "./interactionContract.mjs";
import { buildModuleGenerationContracts } from "./moduleContracts.mjs";

export const BUILD_SPEC_VERSION = 1;

/**
 * Derive the complete build specification from a raw contract.
 *
 * Order matters and is the reason this exists: bindings feed the module plan, the module plan
 * feeds interaction ownership, and both feed the per-module contracts. Computing any of them
 * out of band reproduces the drift this replaces.
 */
export function deriveBuildSpec(contract, { userCritical = [], journeys = contract?.journeys || [] } = {}) {
  const bindings = bindCapabilities(contract);
  const modulePlan = deriveModulePlan(contract, journeys);
  const interactionContract = buildInteractionContract(contract, { modulePlan, bindings });
  const enriched = { ...contract, interactionContract };
  const tiers = tierContract(enriched, { userCritical });
  const moduleContracts = buildModuleGenerationContracts({
    contract: enriched, modulePlan, interactionContract, bindings, journeys,
  });
  return {
    version: BUILD_SPEC_VERSION,
    contract: enriched,
    journeys,
    entities: contract?.entities || [],
    operations: contract?.operations || [],
    tiers,
    bindings,
    modulePlan,
    interactionContract,
    moduleContracts,
    persistencePlan: persistenceOwnershipPlan(enriched, journeys, modulePlan),
    imageIntents: imageIntents(contract),
    verdict: validateInteractionContract(interactionContract),
  };
}

/**
 * Narrow a derived spec to the journeys one increment implements. Every view stays consistent
 * because they are all filtered from the same source of truth.
 */
export function scopeBuildSpec(spec, journeys = []) {
  const scopedJourneys = journeys.length ? journeys : spec.journeys;
  const ids = new Set(scopedJourneys.map((journey) => journey?.id).filter(Boolean));
  const interactionContract = scopeInteractionContract(spec.interactionContract, scopedJourneys);
  const bindings = bindingsForJourneys(spec.contract, spec.bindings, scopedJourneys);
  const modulePlan = deriveModulePlan(spec.contract, scopedJourneys);
  return {
    ...spec,
    journeys: scopedJourneys,
    scopedJourneyIds: [...ids],
    bindings,
    modulePlan,
    interactionContract,
    moduleContracts: buildModuleGenerationContracts({
      contract: spec.contract, modulePlan, interactionContract, bindings, journeys: scopedJourneys,
    }),
    persistencePlan: persistenceOwnershipPlan(spec.contract, scopedJourneys, modulePlan),
  };
}

/** Machine-readable summary for diagnostics — what Thrallo believed it was asking for. */
export function buildSpecSummary(spec) {
  return {
    version: spec?.version || BUILD_SPEC_VERSION,
    journeys: (spec?.journeys || []).map((journey) => journey.id),
    essential: spec?.tiers?.essential?.journeys || [],
    bindings: (spec?.bindings || []).map((binding) => ({
      capability: binding.name, requiredMethods: binding.requiredMethods || [],
    })),
    modulePlan: (spec?.modulePlan || []).map((module) => ({ path: module.path, role: module.role })),
    interactionFlows: (spec?.interactionContract?.flows || []).length,
    durableJourneys: spec?.persistencePlan?.durableJourneys || [],
  };
}
