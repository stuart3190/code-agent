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
import { deriveDependencyPlan, scopeDependencyPlan } from "./dependencyPlan.mjs";
import {
  capabilityModulePlan, deriveCapabilityGraph, scopeCapabilityGraph, validateCapabilityGraph,
} from "./capabilityGraph.mjs";
import { capabilityCompositionPlan } from "./capabilityComposer.mjs";

export const BUILD_SPEC_VERSION = 2;

/**
 * Derive the complete build specification from a raw contract.
 *
 * Order matters and is the reason this exists: bindings feed the module plan, the module plan
 * feeds interaction ownership, and both feed the per-module contracts. Computing any of them
 * out of band reproduces the drift this replaces.
 */
export function deriveBuildSpec(contract, { userCritical = [], journeys = contract?.journeys || [] } = {}) {
  const bindings = bindCapabilities(contract);
  const dependencyPlan = deriveDependencyPlan(contract, journeys);
  // The existing planner supplies route/screen responsibility. Capability adapters are then
  // replaced with composer-owned protected modules, and unsupported flows become bounded custom
  // modules. A second interaction pass stamps those final owners onto the SAME flow contract.
  const legacyModulePlan = deriveModulePlan(contract, journeys, { dependencyPlan });
  const initialInteraction = buildInteractionContract(contract, { modulePlan: legacyModulePlan, bindings });
  const initialGraph = deriveCapabilityGraph(contract, { bindings, interactionContract: initialInteraction });
  const modulePlan = capabilityModulePlan(initialGraph, legacyModulePlan);
  const interactionContract = buildInteractionContract(contract, { modulePlan, bindings });
  const capabilityGraph = deriveCapabilityGraph(contract, { bindings, interactionContract });
  const compositionPlan = capabilityCompositionPlan(capabilityGraph);
  const enriched = { ...contract, interactionContract, dependencyPlan, capabilityGraph };
  const tiers = tierContract(enriched, { userCritical });
  const moduleContracts = buildModuleGenerationContracts({
    contract: enriched, modulePlan, interactionContract, bindings, journeys, capabilityGraph,
  });
  const interactionVerdict = validateInteractionContract(interactionContract);
  const graphVerdict = validateCapabilityGraph(capabilityGraph, enriched, interactionContract);
  return {
    version: BUILD_SPEC_VERSION,
    contract: enriched,
    journeys,
    entities: contract?.entities || [],
    operations: contract?.operations || [],
    tiers,
    bindings,
    dependencyPlan,
    modulePlan,
    interactionContract,
    capabilityGraph,
    compositionPlan,
    moduleContracts,
    persistencePlan: persistenceOwnershipPlan(enriched, journeys, modulePlan),
    imageIntents: imageIntents(contract),
    verdict: {
      ok: interactionVerdict.ok && graphVerdict.ok,
      problems: [...interactionVerdict.problems, ...graphVerdict.problems],
      interaction: interactionVerdict,
      capabilityGraph: graphVerdict,
    },
  };
}

/**
 * Narrow a derived spec to the journeys one increment implements. Every view stays consistent
 * because they are all filtered from the same source of truth.
 */
export function scopeBuildSpec(spec, journeys = []) {
  const scopedJourneys = journeys.length ? journeys : spec.journeys;
  const ids = new Set(scopedJourneys.map((journey) => journey?.id).filter(Boolean));
  const operations = (spec.contract?.operations || []).filter((operation) => (
    !operation?.journey || ids.has(operation.journey)
  ));
  const entityNames = new Set(operations.map((operation) => operation?.entity).filter(Boolean));
  const structuredOwnership = (spec.contract?.operations || []).some((operation) => (
    operation?.journey || operation?.entity
  ));
  const entities = structuredOwnership
    ? (spec.contract?.entities || []).filter((entity) => entityNames.has(entity.name))
    : (spec.contract?.entities || []);
  const interactionContract = scopeInteractionContract(spec.interactionContract, scopedJourneys);
  const bindings = bindingsForJourneys(spec.contract, spec.bindings, scopedJourneys);
  const dependencyPlan = scopeDependencyPlan(spec.dependencyPlan, scopedJourneys);
  const capabilityGraph = scopeCapabilityGraph(spec.capabilityGraph, scopedJourneys);
  const scopedContract = {
    ...spec.contract, journeys: scopedJourneys, operations, entities, interactionContract, dependencyPlan,
    capabilityGraph,
  };
  const modulePlan = capabilityModulePlan(capabilityGraph,
    deriveModulePlan(scopedContract, scopedJourneys, { dependencyPlan }));
  return {
    ...spec,
    scopedContract,
    journeys: scopedJourneys,
    scopedJourneyIds: [...ids],
    entities,
    operations,
    bindings,
    dependencyPlan,
    modulePlan,
    interactionContract,
    capabilityGraph,
    compositionPlan: capabilityCompositionPlan(capabilityGraph),
    moduleContracts: buildModuleGenerationContracts({
      contract: scopedContract, modulePlan, interactionContract, bindings, journeys: scopedJourneys,
      capabilityGraph,
    }),
    persistencePlan: persistenceOwnershipPlan(scopedContract, scopedJourneys, modulePlan),
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
    dependencies: (spec?.dependencyPlan?.requirements || []).map((row) => ({
      capability: row.capability, package: row.package, version: row.version,
    })),
    interactionFlows: (spec?.interactionContract?.flows || []).length,
    capabilityNodes: (spec?.capabilityGraph?.nodes || []).map((node) => ({
      id: node.id, type: node.type, version: node.version,
    })),
    customBehavior: spec?.capabilityGraph?.customBehavior || [],
    composedModules: spec?.compositionPlan?.protectedFiles || [],
    durableJourneys: spec?.persistencePlan?.durableJourneys || [],
  };
}
