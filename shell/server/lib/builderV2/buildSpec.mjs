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
  bindInteractionModulePlan, buildInteractionContract, composeCapabilityGraphInteractions, scopeInteractionContract,
  validateInteractionContract,
} from "./interactionContract.mjs";
import { buildModuleGenerationContracts } from "./moduleContracts.mjs";
import { deriveDependencyPlan, scopeDependencyPlan } from "./dependencyPlan.mjs";
import {
  capabilityModulePlan, deriveCapabilityGraph, scopeCapabilityGraph, validateCapabilityGraph,
} from "./capabilityGraph.mjs";
import { capabilityCompositionPlan } from "./capabilityComposer.mjs";
import {
  deriveScaffoldGraph, scaffoldGraphSummary, scaffoldModulePlan, scopeScaffoldGraph,
  validateScaffoldGraph,
} from "./scaffoldGraph.mjs";
import { scaffoldCompositionPlan } from "./scaffoldComposer.mjs";
import {
  adoptBuildProfile, resolveBuildProfile, validateBuildProfileContract,
} from "../../../shared/buildProfile.mjs";

export const BUILD_SPEC_VERSION = 3;

/**
 * Derive the complete build specification from a raw contract.
 *
 * Order matters and is the reason this exists: bindings feed the module plan, the module plan
 * feeds interaction ownership, and both feed the per-module contracts. Computing any of them
 * out of band reproduces the drift this replaces.
 */
export function deriveBuildSpec(contract, { userCritical = [], journeys = contract?.journeys || [] } = {}) {
  // The profile the contract was GENERATED and validated against is authoritative here. Inferring
  // a second one from the model's own summary let this gate demand obligations the contract agent
  // never saw, and no attempt it could make would have satisfied them. Only a contract that
  // carries no profile at all is inferred for, and that one stays legacy (obligation-free).
  const buildProfile = adoptBuildProfile(contract?.buildProfile)
    || resolveBuildProfile({ prompt: contract?.summary || "", input: null, legacy: true });
  const plannedContract = { ...contract, buildProfile };
  const bindings = bindCapabilities(plannedContract);
  const dependencyPlan = deriveDependencyPlan(plannedContract, journeys);
  // The existing planner supplies route/screen responsibility. Capability adapters are then
  // replaced with composer-owned protected modules, and unsupported flows become bounded custom
  // modules. A second interaction pass stamps those final owners onto the SAME flow contract.
  const legacyModulePlan = deriveModulePlan(plannedContract, journeys, { dependencyPlan });
  const initialInteraction = buildInteractionContract(plannedContract, { modulePlan: legacyModulePlan, bindings });
  const initialGraph = deriveCapabilityGraph(plannedContract, { bindings, interactionContract: initialInteraction });
  const modulePlan = capabilityModulePlan(initialGraph, legacyModulePlan);
  const baseInteraction = buildInteractionContract(plannedContract, { modulePlan, bindings });
  const graphBeforeInteractionBinding = deriveCapabilityGraph(plannedContract, {
    bindings, interactionContract: baseInteraction,
  });
  const graphBoundInteraction = composeCapabilityGraphInteractions(
    baseInteraction, graphBeforeInteractionBinding, plannedContract,
  );
  // Re-derive once from the graph-bound interactions so every responsibility points at the
  // authoritative interaction it owns, including operations that had no prose-derived flow.
  const capabilityGraph = deriveCapabilityGraph(plannedContract, {
    bindings, interactionContract: graphBoundInteraction,
  });
  const interactionContract = composeCapabilityGraphInteractions(
    graphBoundInteraction, capabilityGraph, plannedContract,
  );
  const compositionPlan = capabilityCompositionPlan(capabilityGraph);
  const scaffoldGraph = deriveScaffoldGraph(plannedContract, capabilityGraph, { modulePlan });
  const finalModulePlan = scaffoldModulePlan(scaffoldGraph, modulePlan);
  const finalInteractionContract = bindInteractionModulePlan(interactionContract, finalModulePlan);
  const scaffoldPlan = scaffoldCompositionPlan(scaffoldGraph);
  const enriched = { ...plannedContract, interactionContract: finalInteractionContract,
    dependencyPlan, capabilityGraph, scaffoldGraph };
  const tiers = tierContract(enriched, { userCritical });
  const moduleContracts = buildModuleGenerationContracts({
    contract: enriched, modulePlan: finalModulePlan, interactionContract: finalInteractionContract,
    bindings, journeys, capabilityGraph,
  });
  const interactionVerdict = validateInteractionContract(finalInteractionContract, { capabilityGraph });
  const graphVerdict = validateCapabilityGraph(capabilityGraph, enriched, interactionContract);
  const scaffoldVerdict = validateScaffoldGraph(scaffoldGraph, enriched, capabilityGraph);
  const profileVerdict = validateBuildProfileContract(enriched, buildProfile);
  return {
    version: BUILD_SPEC_VERSION,
    contract: enriched,
    journeys,
    buildProfile,
    entities: plannedContract?.entities || [],
    operations: plannedContract?.operations || [],
    tiers,
    bindings,
    dependencyPlan,
    modulePlan: finalModulePlan,
    interactionContract: finalInteractionContract,
    capabilityGraph,
    compositionPlan,
    scaffoldGraph,
    scaffoldCompositionPlan: scaffoldPlan,
    moduleContracts,
    persistencePlan: persistenceOwnershipPlan(enriched, journeys, finalModulePlan),
    imageIntents: imageIntents(plannedContract),
    verdict: {
      ok: interactionVerdict.ok && graphVerdict.ok && scaffoldVerdict.ok && profileVerdict.ok,
      problems: [...interactionVerdict.problems, ...graphVerdict.problems,
        ...scaffoldVerdict.problems, ...profileVerdict.problems],
      interaction: interactionVerdict,
      capabilityGraph: graphVerdict,
      scaffoldGraph: scaffoldVerdict,
      buildProfile: profileVerdict,
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
  const scopedBaseInteraction = scopeInteractionContract(spec.interactionContract, scopedJourneys);
  const bindings = bindingsForJourneys(spec.contract, spec.bindings, scopedJourneys);
  const dependencyPlan = scopeDependencyPlan(spec.dependencyPlan, scopedJourneys);
  const capabilityGraph = scopeCapabilityGraph(spec.capabilityGraph, scopedJourneys);
  const scaffoldGraph = scopeScaffoldGraph(spec.scaffoldGraph, scopedJourneys);
  const scopedContract = {
    ...spec.contract, journeys: scopedJourneys, operations, entities,
    interactionContract: scopedBaseInteraction, dependencyPlan,
    capabilityGraph, scaffoldGraph,
  };
  const modulePlan = scaffoldModulePlan(scaffoldGraph, capabilityModulePlan(capabilityGraph,
    deriveModulePlan(scopedContract, scopedJourneys, { dependencyPlan })));
  const interactionContract = bindInteractionModulePlan(scopedBaseInteraction, modulePlan);
  scopedContract.interactionContract = interactionContract;
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
    scaffoldGraph,
    scaffoldCompositionPlan: scaffoldCompositionPlan(scaffoldGraph),
    moduleContracts: buildModuleGenerationContracts({
      contract: scopedContract, modulePlan, interactionContract, bindings, journeys: scopedJourneys,
      capabilityGraph,
    }),
    persistencePlan: persistenceOwnershipPlan(scopedContract, scopedJourneys, modulePlan),
  };
}

/**
 * A mounted screen is one model-owned write unit. Include every journey rendered by a screen
 * already required by the seed set so generation cannot rewrite that file once per journey and
 * invalidate an identity or state transition which was previously browser-green.
 */
export function journeysInMountedScreenUnit(spec, seedJourneys = []) {
  const seeds = new Set(seedJourneys.map((journey) => journey?.id).filter(Boolean));
  if (!seeds.size) return [];
  const ownership = spec?.scaffoldGraph?.journeyRouteOwnership
    || spec?.scaffoldGraph?.journeyOwnership || [];
  const mountedModules = new Set(ownership
    .filter((owner) => seeds.has(owner.journeyId))
    .map((owner) => owner.mountedModule).filter(Boolean));
  const included = new Set([
    ...seeds,
    ...ownership.filter((owner) => mountedModules.has(owner.mountedModule))
      .map((owner) => owner.journeyId),
  ]);
  return (spec?.contract?.journeys || spec?.journeys || [])
    .filter((journey) => included.has(journey?.id));
}

/** Machine-readable summary for diagnostics — what Thrallo believed it was asking for. */
export function buildSpecSummary(spec) {
  return {
    version: spec?.version || BUILD_SPEC_VERSION,
    buildProfile: spec?.buildProfile || spec?.contract?.buildProfile || null,
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
    scaffold: scaffoldGraphSummary(spec?.scaffoldGraph),
    scaffoldModules: spec?.scaffoldCompositionPlan?.protectedFiles || [],
    durableJourneys: spec?.persistencePlan?.durableJourneys || [],
  };
}
