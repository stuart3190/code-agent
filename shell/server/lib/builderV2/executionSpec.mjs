// THE CANONICAL COMPACT EXECUTION SPECIFICATION for full generation.
//
// The core generation prompt used to serialise the whole scoped capability graph, the whole
// interaction contract, every per-module contract and the scaffold composition plan as four
// independent pretty-printed JSON documents. Each of them restated the same operation
// responsibilities, state paths and control identities: a responsibility row appeared in the
// graph's operationResponsibilities, again inside every graph journey, again inside every
// custom_behavior node, again in that node's testContract, again in the extension point's
// operationContracts and once more in the interaction flows. The 2026-09-16 retained Advanced
// corpus measured 118k-274k estimated input tokens per core call against a 120k total-token
// envelope, so every Advanced core dispatch fell into headroom batching before one useful line
// of application code could be produced.
//
// This module derives ONE specification from the same derived views the validators enforce, in
// which every module, operation responsibility, control, state path, route, protected file and
// custom extension interface appears exactly once, and renders it deterministically. Nothing
// enforced after the patch is dropped: `executionSpecCoverage` proves, identity by identity,
// that the rendered text names everything the full views name. Verifier-only material
// (registry self-tests, verification prose, per-journey copies of the responsibility rows,
// data-flow edges that are the flows themselves) is not repeated because the validators read
// it from the derived views, not from the prompt.

import { capabilityCompositionPlan } from "./capabilityComposer.mjs";
import { scaffoldCompositionPlan } from "./scaffoldComposer.mjs";
import {
  CAPABILITY_COMPOSITION_RULES, SCAFFOLD_COMPOSITION_RULES, MODULE_CONTRACT_RULES, INTERACTION_CONTRACT_RULES,
} from "./executionSpecRules.mjs";

export {
  CAPABILITY_COMPOSITION_RULES, SCAFFOLD_COMPOSITION_RULES, MODULE_CONTRACT_RULES, INTERACTION_CONTRACT_RULES,
};

export const EXECUTION_SPEC_VERSION = 1;

const isPrimitive = (value) => value === null || ["string", "number", "boolean"].includes(typeof value);
const unique = (rows) => [...new Set((rows || []).filter((row) => row !== null && row !== undefined && row !== ""))];
const prune = (object) => Object.fromEntries(Object.entries(object || {}).filter(([, value]) => (
  value !== null && value !== undefined && !(Array.isArray(value) && !value.length)
)));
const byPath = (rows) => new Map((rows || []).map((row) => [row?.path, row]).filter(([path]) => path));

/**
 * Deterministic, dense JSON: objects one key per line, arrays of primitives on one line, small
 * flat objects inline. Still valid JSON, so the model can read it as such.
 */
export function renderCompactJson(value, depth = 0) {
  const pad = " ".repeat(depth);
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    if (value.every(isPrimitive)) return JSON.stringify(value);
    return `[\n${value.map((row) => `${pad} ${renderCompactJson(row, depth + 1)}`).join(",\n")}\n${pad}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (!entries.length) return "{}";
    const flat = entries.every(([, row]) => isPrimitive(row) || (Array.isArray(row) && row.every(isPrimitive)));
    if (flat) {
      const inline = `{ ${entries.map(([key, row]) => `${JSON.stringify(key)}: ${JSON.stringify(row)}`).join(", ")} }`;
      if (inline.length <= 140) return inline;
    }
    return `{\n${entries.map(([key, row]) => `${pad} ${JSON.stringify(key)}: ${renderCompactJson(row, depth + 1)}`).join(",\n")}\n${pad}}`;
  }
  return JSON.stringify(value);
}

/**
 * One interaction flow with every execution-relevant fact and nothing verifier-only. This is the
 * projection bounded repair and headroom dispatch already used; it now lives here so the core
 * prompt and every scoped prompt share one control-identity shape. `scope` / `qualifiedName`
 * travel with the control: the interaction rules make scope part of a control's identity, and a
 * projection that dropped it left a scoped field indistinguishable from an unscoped one.
 */
export function compactInteractionFlow(flow, { verifierFacts = true } = {}) {
  const control = flow.control ? prune({
    machineId: flow.control.machineId || null,
    roles: flow.control.roles || [], logicalField: flow.control.logicalField || null,
    scope: flow.control.scope || null, qualifiedName: flow.control.qualifiedName || null,
    inputTypes: flow.control.inputTypes || [], accessibleNames: flow.control.accessibleNames || [],
    valueType: flow.control.valueType || null, required: flow.control.required === true ? true : null,
    options: flow.control.options || [],
    verificationValue: verifierFacts ? flow.control.verificationValue ?? null : null,
    editable: flow.control.editable === true, selectedState: flow.control.selectedState === true,
    stateOwner: flow.control.stateOwner || null, statePath: flow.control.statePath || null,
    downstream: verifierFacts ? flow.control.downstream || [] : [],
  }) : null;
  return prune({
    id: flow.id, journeyId: flow.journeyId, stepIndex: flow.stepIndex, kind: flow.kind,
    action: flow.action, target: flow.target || null,
    reads: flow.reads || [], writes: flow.writes || [],
    control,
    capability: flow.capability || null, observable: flow.observable || null,
    stateOwner: flow.stateOwner || null, responsibleModules: flow.responsibleModules || [],
    operationId: flow.operationId || null,
    responsibilityIds: flow.responsibilityIds || [],
    semanticResponsibilityTypes: verifierFacts ? flow.semanticResponsibilityTypes || [] : [],
    actionIdentity: flow.actionIdentity || null,
    expectedStateTransition: verifierFacts ? flow.expectedStateTransition || null : null,
    downstreamConsumers: verifierFacts ? flow.downstreamConsumers || [] : [],
    capabilityId: flow.capabilityId || null,
    capabilityMethod: flow.capabilityMethod || null,
    customBehavior: flow.customBehavior || null,
    customBehaviorModule: flow.customBehaviorModule || null,
    customBehaviorExports: verifierFacts ? flow.customBehaviorExports || [] : [],
    persistenceHandoff: verifierFacts ? flow.persistenceHandoff || null : null,
    verificationObservation: verifierFacts ? flow.verificationObservation || null : null,
  });
}

function compactResponsibility(row) {
  return prune({
    id: row.id, type: row.type, semanticOperation: row.semanticOperation || null,
    behavior: row.behavior || null,
    capability: row.capabilityId ? `${row.capabilityId}.${row.capabilityMethod || "?"}` : null,
    requestedCapability: row.requestedCapability
      ? `${row.requestedCapability}.${row.requestedCapabilityMethod || "?"}` : null,
    custom: row.customBehavior || null,
    owner: row.owner || null,
    reads: row.reads || [], writes: row.writes || [],
    declaredReads: row.declaredReads || [], declaredWrites: row.declaredWrites || [],
    interactionIds: row.interactionIds || [],
    outputEffect: row.outputEffect || null,
    persistenceHandoff: row.persistenceHandoff || null,
    persistenceSource: row.persistenceSource || null,
    downstreamDependencies: row.downstreamDependencies || [],
    requiresTransformation: row.requiresTransformation === true ? true : null,
  });
}

/**
 * A module's state lists are usually "every path of every journey it owns"; naming each path per
 * module repeated the same sixty-path list in the capability module, the journey controller and
 * the screen slot. A list that covers a journey's entire declared state is named by the journey
 * (its paths are listed once under journeyState); only paths outside that cover stay explicit.
 */
function coverByJourney(paths, journeyState) {
  const wanted = new Set(paths || []);
  if (!wanted.size) return [];
  const covered = [];
  for (const [journeyId, state] of Object.entries(journeyState || {})) {
    if (state.length && state.every((path) => wanted.has(path))) {
      covered.push(`journey:${journeyId}`);
      for (const path of state) wanted.delete(path);
    }
  }
  return [...covered, ...wanted];
}

export function buildExecutionSpec({
  capabilityGraph = null, compositionPlan = null, scaffoldGraph = null, scaffoldPlan = null,
  modulePlan = [], moduleContracts = null, interactionContract = null, persistencePlan = null,
} = {}) {
  const graph = capabilityGraph || null;
  const composition = compositionPlan || (graph ? capabilityCompositionPlan(graph) : null);
  const scaffold = scaffoldPlan || (scaffoldGraph ? scaffoldCompositionPlan(scaffoldGraph) : null);
  const interfacesByModule = byPath((composition?.interfaces || []).map((row) => ({ ...row, path: row.module })));
  const journeyState = Object.fromEntries((graph?.journeys || []).map((journey) => [
    journey.journeyId, unique(journey.state || []),
  ]));

  const capabilities = (graph?.nodes || []).filter((node) => node.type !== "custom_behavior").map((node) => {
    const iface = interfacesByModule.get(node.compositionModule) || null;
    return prune({
      id: node.id, capabilityId: node.capabilityId || null, version: node.version ?? null,
      protected: node.protected === true, module: node.compositionModule || null,
      exports: iface?.exports || [], asyncExports: iface?.asyncExports || [], owns: iface?.owns || [],
      requiredOperations: node.requiredOperations || [],
      entities: node.entities || [], journeys: node.journeys || [],
    });
  });

  const extensionsByModule = byPath((scaffold?.extensionPoints || []).map((row) => ({ ...row, path: row.module })));
  const extensions = (composition?.extensionPoints || []).map((point) => {
    const scaffolded = extensionsByModule.get(point.module) || {};
    const node = (graph?.nodes || []).find((row) => row.id === point.id) || {};
    return prune({
      id: point.id, module: point.module, requiredExports: point.requiredExports || [],
      interface: point.interface || null,
      owningJourneys: scaffolded.owningJourneys || node.journeys || [],
      allowedFiles: scaffolded.allowedFiles || [],
      integrationPoints: scaffolded.integrationPoints || [],
      owns: scaffolded.stateOwnership?.owns || node.stateOwnership?.owns || [],
      operations: (scaffolded.operationContracts || []).map((row) => prune({
        responsibilityId: row.responsibilityId, operationId: row.operationId,
        selectors: row.selectors || [], inputKeys: row.inputKeys || [],
        inputs: row.inputs || [], outputs: row.outputs || [],
      })),
    });
  });

  const operations = (graph?.operationResponsibilities || []).map((row) => prune({
    operationId: row.operationId, journeyId: row.journeyId, stepIndex: row.stepIndex ?? null,
    entity: row.entity || null,
    owner: row.owner || null, module: row.module || null, moduleOperation: row.moduleOperation || null,
    output: row.output?.type || null,
    responsibilities: (row.responsibilities || []).map(compactResponsibility),
  }));

  const planByPath = byPath(modulePlan);
  const bypasses = new Map();
  const forbiddenPersistenceApis = new Set();
  const modules = (moduleContracts?.specifications || []).map((spec) => {
    const planned = planByPath.get(spec.path) || {};
    for (const rule of spec.forbiddenCapabilityBypasses || []) {
      const key = JSON.stringify([rule.entity, rule.operationOwner, rule.capability]);
      if (!bypasses.has(key)) bypasses.set(key, prune({
        entity: rule.entity, operationOwner: rule.operationOwner, capability: rule.capability,
        requiredOperations: rule.requiredOperations || [],
      }));
    }
    for (const api of spec.persistence?.forbiddenApis || []) forbiddenPersistenceApis.add(api);
    const state = spec.state || {};
    return prune({
      path: spec.path, role: spec.role || planned.role || null, providedBy: spec.providedBy || planned.providedBy || null,
      protected: spec.protected === true ? true : null,
      journeyController: spec.journeyController || planned.journeyController || null,
      sharedControllerFor: spec.sharedControllerFor || [],
      ownedJourneys: spec.ownedJourneys || [],
      routePath: planned.routePath || null,
      factory: planned.factory || null,
      state: prune({
        owns: state.owns || null,
        survivesReload: state.survivesReload === true,
        persistenceOwner: spec.persistence?.owner || null,
        approvedPersistence: planned.stateOwnership?.approvedPersistence || null,
        durableStateOwner: planned.stateOwnership?.durableStateOwner || null,
        mayConsume: coverByJourney(state.mayConsume, journeyState),
        mustProduce: coverByJourney(state.mustProduce, journeyState),
      }),
      consumers: spec.downstream?.consumers || [],
      requiredImports: spec.requiredImports || [],
      requiredExports: spec.requiredExports || [],
      requiredCapabilities: spec.requiredCapabilities || [],
      semanticInteractions: (spec.semanticInteractions || []).map((row) => prune({
        interactionId: row.interactionId, journeyId: row.journeyId, stepIndex: row.stepIndex ?? null,
        logicalField: row.logicalField || null, scope: row.scope || null,
        roles: row.roles || [], inputTypes: row.inputTypes || [], accessibleNames: row.accessibleNames || [],
        editable: row.editable === true, selectedState: row.selectedState === true,
        stateOwner: row.stateOwner || null, reads: row.reads || [], writes: row.writes || [],
      })),
      sharedCustomOperations: spec.sharedCustomOperations || [],
      moduleSizeBoundary: spec.moduleSizeBoundary ?? null,
    });
  });

  const scenarios = Object.fromEntries(Object.entries(interactionContract?.scenarios || {}).map(([journeyId, row]) => [
    journeyId, prune({
      role: row.role, startState: row.startState, lifecycle: row.lifecycle || null, basis: row.basis || null,
      lifecycles: row.lifecycles || [], initialState: row.initialState || [], durableState: row.durableState || [],
      externalState: row.externalState || [], capabilityOutputs: row.capabilityOutputs || [],
    }),
  ]));
  const flows = (interactionContract?.flows || []).map((flow) => compactInteractionFlow(flow, { verifierFacts: false }));

  const persistence = persistencePlan ? {
    durableJourneys: persistencePlan.durableJourneys || [],
    forbiddenBusinessPersistence: persistencePlan.forbiddenBusinessPersistence || [],
    owners: persistencePlan.owners || [],
    modules: (persistencePlan.modules || []).map(({ forbiddenPersistence: _forbidden, ...module }) => module),
  } : null;

  return {
    version: EXECUTION_SPEC_VERSION,
    buildProfile: graph?.buildProfile || null,
    capabilities, journeyState, operations,
    composition: composition ? prune({
      version: composition.version, configurationModule: composition.configurationModule || null,
      protectedFiles: composition.protectedFiles || [],
    }) : null,
    extensions,
    scaffold: scaffold ? prune({
      version: scaffold.version, families: scaffold.familyInterfaces || [],
      mountedRoutes: scaffold.routeScreenMap || [], protectedFiles: scaffold.protectedFiles || [],
      modelOwnedScreenFiles: scaffold.modelOwnedScreenFiles || [],
    }) : null,
    modules,
    forbiddenCapabilityBypasses: [...bypasses.values()],
    forbiddenPersistenceApis: [...forbiddenPersistenceApis],
    persistence,
    interactions: interactionContract ? { version: interactionContract.version, scenarios, flows } : null,
  };
}

export const EXECUTION_SPEC_SECTIONS = Object.freeze([
  "capabilityGraph", "composition", "scaffold", "modules", "persistence", "interactions",
]);

/**
 * One section of the specification, under the heading generation has always seen for that
 * material. The headings are stable so the surrounding prompt, the tests and the operators'
 * reading of a retained prompt stay the same; only the payload beneath them is canonical now.
 */
export function renderExecutionSpecSection(spec, section) {
  switch (section) {
    case "capabilityGraph":
      return spec.capabilities.length || spec.operations.length ? [
        "CAPABILITY GRAPH (authoritative behavior/state/data-flow ownership for this scope; each responsibility is stated once here):",
        renderCompactJson(prune({
          version: spec.version, buildProfile: spec.buildProfile,
          capabilities: spec.capabilities, journeyState: spec.journeyState, operations: spec.operations,
        })),
        "journeyState lists every contracted state path per journey once; \"journey:<id>\" in a module's mayConsume/mustProduce means every path of that journey.",
      ].join("\n") : "CAPABILITY GRAPH: none.";
    case "composition":
      return spec.composition ? [
        "DETERMINISTIC CAPABILITY COMPOSITION (already generated and protected; import, never recreate):",
        renderCompactJson(prune({
          ...spec.composition,
          interfaces: spec.capabilities.filter((row) => row.module).map((row) => prune({
            module: row.module, exports: row.exports, asyncExports: row.asyncExports, owns: row.owns,
          })),
          extensionPoints: spec.extensions,
        })),
        ...CAPABILITY_COMPOSITION_RULES,
      ].join("\n") : "";
    case "scaffold":
      return spec.scaffold ? [
        "DETERMINISTIC SCAFFOLD COMPOSITION (mounted runtime authority; consume, never regenerate):",
        renderCompactJson(spec.scaffold),
        "Custom extension interfaces (module, requiredExports, per-operation inputKeys/inputs/outputs, allowedFiles) are stated once under DETERMINISTIC CAPABILITY COMPOSITION.",
        ...SCAFFOLD_COMPOSITION_RULES,
      ].join("\n") : "";
    case "modules":
      return spec.modules.length ? [
        "PER-MODULE GENERATION CONTRACTS (the intended responsibilities for this build):",
        renderCompactJson(prune({
          specifications: spec.modules,
          forbiddenCapabilityBypasses: spec.forbiddenCapabilityBypasses,
          forbiddenPersistenceApis: spec.forbiddenPersistenceApis,
        })),
        "forbiddenCapabilityBypasses and forbiddenPersistenceApis apply to EVERY module above.",
        ...MODULE_CONTRACT_RULES,
      ].join("\n") : "PER-MODULE GENERATION CONTRACTS: none for this scope.";
    case "persistence":
      return spec.persistence
        ? `PERSISTENCE OWNERSHIP CONTRACT (machine-enforced JSON; hard constraints, not advice):\n${renderCompactJson(spec.persistence)}`
        : "PERSISTENCE OWNERSHIP CONTRACT: no durable journey in this scope.";
    case "interactions":
      return spec.interactions?.flows?.length ? [
        "INTERACTION CONTRACT (machine-enforced JSON; implement these state/data-flow edges before styling):",
        renderCompactJson(spec.interactions),
        ...INTERACTION_CONTRACT_RULES,
      ].join("\n") : "INTERACTION CONTRACT: no interactive state transitions in this scope.";
    default:
      throw new Error(`unknown execution specification section: ${section}`);
  }
}

export function renderExecutionSpecBrief(spec) {
  return EXECUTION_SPEC_SECTIONS.map((section) => renderExecutionSpecSection(spec, section))
    .filter(Boolean).join("\n\n");
}

/**
 * The completeness proof. Every identity the full derived views carry that generation must
 * honour — module paths, imports, exports, control ids and names, state paths, responsibility
 * ids, capability methods, custom extension exports and input keys, routes, protected files,
 * ownership rules — must appear verbatim in the rendered text. Returns the identities that do
 * not, with the view they came from, so a regression names exactly what was lost.
 */
export function executionSpecCoverage(rendered, {
  capabilityGraph = null, compositionPlan = null, scaffoldGraph = null, scaffoldPlan = null,
  modulePlan = [], moduleContracts = null, interactionContract = null, persistencePlan = null,
} = {}) {
  const text = typeof rendered === "string" ? rendered : renderExecutionSpecBrief(rendered);
  const required = [];
  const need = (source, value) => {
    if (typeof value === "string" && value.length) required.push({ source, value });
  };
  const graph = capabilityGraph || null;
  const composition = compositionPlan || (graph ? capabilityCompositionPlan(graph) : null);
  const scaffold = scaffoldPlan || (scaffoldGraph ? scaffoldCompositionPlan(scaffoldGraph) : null);
  for (const node of graph?.nodes || []) {
    need("graph.node", node.id);
    need("graph.node", node.compositionModule);
    for (const op of node.requiredOperations || []) need(`graph.node ${node.id}.requiredOperations`, String(op));
    for (const name of node.extension?.requiredExports || []) need(`graph.node ${node.id}.extension`, name);
  }
  for (const journey of graph?.journeys || []) {
    need("graph.journey", journey.journeyId);
    for (const path of journey.state || []) need(`graph.journey ${journey.journeyId}.state`, path);
  }
  for (const row of graph?.operationResponsibilities || []) {
    need("graph.operation", row.operationId);
    for (const resp of row.responsibilities || []) {
      need("graph.responsibility", resp.id);
      if (resp.capabilityId) need(`graph.responsibility ${resp.id}.capability`, `${resp.capabilityId}.${resp.capabilityMethod || "?"}`);
      need(`graph.responsibility ${resp.id}.owner`, resp.owner);
      for (const path of [...(resp.reads || []), ...(resp.writes || [])]) need(`graph.responsibility ${resp.id}.state`, path);
      for (const id of resp.interactionIds || []) need(`graph.responsibility ${resp.id}.interaction`, id);
    }
  }
  for (const iface of composition?.interfaces || []) {
    need("composition.interface", iface.module);
    for (const name of iface.exports || []) need(`composition.interface ${iface.module}.exports`, name);
  }
  for (const path of composition?.protectedFiles || []) need("composition.protectedFiles", path);
  need("composition.configurationModule", composition?.configurationModule || null);
  for (const point of composition?.extensionPoints || []) {
    need("composition.extension", point.module);
    for (const name of point.requiredExports || []) need(`composition.extension ${point.module}.requiredExports`, name);
  }
  for (const point of scaffold?.extensionPoints || []) {
    need("scaffold.extension", point.module);
    for (const file of point.allowedFiles || []) need(`scaffold.extension ${point.module}.allowedFiles`, file);
    for (const op of point.operationContracts || []) {
      need(`scaffold.extension ${point.module}.operation`, op.responsibilityId);
      for (const key of op.inputKeys || []) need(`scaffold.extension ${point.module}.${op.operationId}.inputKeys`, key);
      for (const path of [...(op.inputs || []), ...(op.outputs || [])]) need(`scaffold.extension ${point.module}.${op.operationId}.state`, path);
    }
  }
  for (const route of scaffold?.routeScreenMap || []) {
    need("scaffold.route", route.routePath);
    need("scaffold.route", route.module);
  }
  for (const path of scaffold?.protectedFiles || []) need("scaffold.protectedFiles", path);
  for (const path of scaffold?.modelOwnedScreenFiles || []) need("scaffold.modelOwnedScreenFiles", path);
  for (const module of modulePlan || []) need("modulePlan", module.path);
  for (const spec of moduleContracts?.specifications || []) {
    need("moduleContract", spec.path);
    for (const path of spec.requiredImports || []) need(`moduleContract ${spec.path}.requiredImports`, path);
    for (const name of spec.requiredExports || []) need(`moduleContract ${spec.path}.requiredExports`, name);
    for (const cap of spec.requiredCapabilities || []) need(`moduleContract ${spec.path}.requiredCapabilities`, cap.factory || cap.name || null);
    for (const path of [...(spec.state?.mayConsume || []), ...(spec.state?.mustProduce || [])]) need(`moduleContract ${spec.path}.state`, path);
    for (const row of spec.semanticInteractions || []) {
      need(`moduleContract ${spec.path}.control`, row.interactionId);
      need(`moduleContract ${spec.path}.control`, row.logicalField || null);
      for (const name of row.accessibleNames || []) need(`moduleContract ${spec.path}.control ${row.interactionId}.names`, name);
    }
    for (const rule of spec.forbiddenCapabilityBypasses || []) {
      need(`moduleContract ${spec.path}.bypass`, rule.entity);
      need(`moduleContract ${spec.path}.bypass`, rule.operationOwner);
      need(`moduleContract ${spec.path}.bypass`, rule.capability);
    }
    for (const shared of spec.sharedCustomOperations || []) {
      need(`moduleContract ${spec.path}.shared`, shared.operationId);
      for (const impl of shared.implementations || []) need(`moduleContract ${spec.path}.shared ${shared.operationId}`, impl.module);
    }
    for (const api of spec.persistence?.forbiddenApis || []) need(`moduleContract ${spec.path}.persistence`, api);
  }
  for (const flow of interactionContract?.flows || []) {
    need("flow", flow.id);
    need(`flow ${flow.id}.stateOwner`, flow.stateOwner || null);
    for (const path of [...(flow.reads || []), ...(flow.writes || [])]) need(`flow ${flow.id}.state`, path);
    for (const module of flow.responsibleModules || []) need(`flow ${flow.id}.responsibleModules`, module);
    if (flow.control) {
      need(`flow ${flow.id}.control`, flow.control.machineId || null);
      need(`flow ${flow.id}.control`, flow.control.logicalField || null);
      need(`flow ${flow.id}.control`, flow.control.qualifiedName || null);
      need(`flow ${flow.id}.control`, flow.control.statePath || null);
      for (const name of flow.control.accessibleNames || []) need(`flow ${flow.id}.control.names`, name);
    }
    need(`flow ${flow.id}.operation`, flow.operationId || null);
    need(`flow ${flow.id}.customBehaviorModule`, flow.customBehaviorModule || null);
  }
  for (const [journeyId] of Object.entries(interactionContract?.scenarios || {})) need("scenario", journeyId);
  for (const id of persistencePlan?.durableJourneys || []) need("persistence.durableJourneys", id);
  for (const api of persistencePlan?.forbiddenBusinessPersistence || []) need("persistence.forbidden", api);
  for (const module of persistencePlan?.modules || []) need("persistence.module", module.path);
  const seen = new Set();
  const missing = [];
  for (const row of required) {
    const key = `${row.source}\u0000${row.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!text.includes(row.value)) missing.push(row);
  }
  return { required: seen.size, missing };
}
