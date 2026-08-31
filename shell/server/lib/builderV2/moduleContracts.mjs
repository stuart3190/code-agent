// Per-module generation contracts for Builder V2.
//
// This is the deterministic bridge between a build contract and generated patches. The model
// still owns implementation and visual design, but it no longer gets to choose whether a
// planned module honours capability ownership, interaction identity, or downstream data flow.

import { CAPABILITIES } from "./capabilityRegistry.mjs";
import {
  aggregateCapabilityFacts, lintCapabilitySafety, lintRequiredCapabilityBindings, lintRequiredModulePlan,
} from "./capabilityLint.mjs";
import { partitionFindings } from "./validationSeverity.mjs";
import { lintControlBindings } from "./bindingLint.mjs";
import { lintInteractiveWorkflow } from "./interactionContract.mjs";
import { FILE_MAX_TOKENS, APP_SHELL_MAX_TOKENS } from "../appBuild/modularity.mjs";
import { capabilityCompositionPlan, validateCapabilityComposition } from "./capabilityComposer.mjs";
import { scaffoldCompositionPlan, validateScaffoldComposition } from "./scaffoldComposer.mjs";
import { reachableSourcePaths } from "./surfaceIntegration.mjs";

const SOURCE = /^src\/.*\.(?:jsx?|tsx?)$/;
const PLATFORM_SOURCE = /^src\/lib\/(?:capabilities\/|scaffolds\/composed\/|backend\/|visitorSession\.js$|assets\.js$|assetData\.js$)/;
const FACTORY_TO_CAPABILITY = new Map(Object.entries(CAPABILITIES).flatMap(([name, capability]) =>
  (capability.interface || []).filter((entry) => /^make[A-Z]/.test(entry)).map((factory) => [factory, name])));

const unique = (values) => [...new Set((values || []).filter(Boolean))];
const normalized = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const factoryForBinding = (binding) => (CAPABILITIES[binding?.name]?.interface || [])
  .find((entry) => /^make[A-Z]/.test(entry)) || null;

/**
 * Reserve output for missing planned modules from their deterministic responsibilities.
 * Ordinary leaf modules retain the observed 1,600-token baseline. A shared journey controller
 * owns several interaction state transitions, so size it from its declared controls while still
 * respecting the same enforced per-file boundary as generated source.
 */
export function expectedMissingModuleTokens(paths = [], moduleContracts = null) {
  const specifications = new Map((moduleContracts?.specifications || [])
    .map((specification) => [specification.path, specification]));
  return unique(paths).reduce((total, path) => {
    const specification = specifications.get(path);
    if (!specification?.sharedControllerFor) return total + 1_600;
    const interactions = (specification.semanticInteractions || []).length;
    const boundary = Math.max(1_600, Number(specification.moduleSizeBoundary || FILE_MAX_TOKENS));
    return total + Math.min(boundary, Math.max(1_600, 1_200 + (interactions * 250)));
  }, 0);
}

function targetModules(flow, modulePlan) {
  const targets = new Set(flow?.responsibleModules || []);
  const responsiblePaths = new Set(flow?.responsibleModules || []);
  const responsibleScreen = modulePlan.find((module) => (
    module.providedBy === "scaffold_screen_slot" && responsiblePaths.has(module.path)
  ));
  const responsibleController = modulePlan.find((module) => (
    module.providedBy !== "scaffold_screen_slot"
      && /flow|form|editor|composition/i.test(module.role || "")
      && responsiblePaths.has(module.path)
  ));
  const plannedVisualController = responsibleController || (!responsibleScreen && modulePlan.find((module) => (
    module.providedBy !== "scaffold_screen_slot"
      && /flow|form|editor|composition/i.test(module.role || "")
      && (module.journeyIds || module.ownedJourneys || []).includes(flow?.journeyId)
  )));
  if (plannedVisualController) targets.add(plannedVisualController.path);
  const hasVisualController = Boolean(plannedVisualController) || [...targets].some((path) => modulePlan.some((module) => (
    module.path === path && module.providedBy !== "scaffold_screen_slot"
      && /flow|form|editor|composition/i.test(module.role || "")
  )));
  const hasBoundScaffoldScreen = [...targets].some((path) => modulePlan.some((module) => (
    module.path === path && module.providedBy === "scaffold_screen_slot"
  )));
  const hasBoundVisual = hasVisualController || hasBoundScaffoldScreen;
  // The scaffold graph is the mounted live-surface authority. A screen owns an interaction only
  // when no planned child controller owns it; otherwise the screen composes that controller.
  for (const module of modulePlan) {
    if (!hasBoundVisual && module?.providedBy === "scaffold_screen_slot"
      && (module.journeyIds || []).includes(flow?.journeyId)) {
      targets.add(module.path);
    }
  }
  const addRole = (pattern) => modulePlan.filter((module) => {
    const ownedJourneys = module.journeyIds || module.ownedJourneys || [];
    return !(hasBoundVisual && module.providedBy === "scaffold_screen_slot")
      && !(hasBoundVisual && module.sharedControllerFor && !targets.has(module.path))
      && pattern.test(module.role || "")
      && (!ownedJourneys.length || ownedJourneys.includes(flow?.journeyId));
  })
    .forEach((module) => targets.add(module.path));
  if (["selection", "input", "action"].includes(flow?.kind)) addRole(/flow|form|editor|composition/i);
  if (flow?.kind === "review") addRole(/review|summary/i);
  if (flow?.kind === "mutation") addRole(/confirmation|result/i);
  if (["recovery", "lookup", "cancellation"].includes(flow?.kind)) addRole(/status|history|detail/i);
  return [...targets].filter((path) => modulePlan.some((module) => module.path === path));
}

function ownershipRules(bindings) {
  return (bindings || []).flatMap((binding) => {
    const capability = CAPABILITIES[binding.name];
    const owner = factoryForBinding(binding);
    if (!capability || !owner) return [];
    const entities = unique([binding.configuration?.entity, ...(capability.entities || [])]);
    return entities.map((entity) => ({
      entity,
      operationOwner: owner,
      capability: binding.name,
      requiredOperations: [...(binding.requiredMethods || [])],
      forbiddenApis: [`db.entity(${JSON.stringify(entity)})`],
    }));
  });
}

function sharedCustomOperations(flows) {
  const byOperation = new Map();
  for (const flow of flows || []) {
    if (!flow?.operationId || !flow?.customBehaviorModule) continue;
    const group = byOperation.get(flow.operationId) || new Map();
    const implementation = group.get(flow.customBehaviorModule) || {
      module: flow.customBehaviorModule,
      journeys: [],
      inputFields: [],
      outputFields: [],
    };
    implementation.journeys = unique([...implementation.journeys, flow.journeyId]);
    implementation.inputFields = unique([...implementation.inputFields,
      ...(flow.reads || []).map((path) => String(path).split(".").at(-1))]);
    implementation.outputFields = unique([...implementation.outputFields,
      ...(flow.writes || []).map((path) => String(path).split(".").at(-1))]);
    group.set(flow.customBehaviorModule, implementation);
    byOperation.set(flow.operationId, group);
  }
  return [...byOperation.entries()].flatMap(([operationId, implementations]) => (
    implementations.size > 1 ? [{
      operationId,
      implementations: [...implementations.values()],
      composition: "one_runtime_operation",
    }] : []
  ));
}

/**
 * Convert the build-wide plans into exact contracts for every planned generated module.
 * Callers may supply richer generic module-plan rows; no application domain is special-cased.
 */
export function buildModuleGenerationContracts({
  contract = null, modulePlan = [], interactionContract = null, bindings = [], journeys = contract?.journeys || [],
  capabilityGraph = contract?.capabilityGraph || null,
  scaffoldGraph = contract?.scaffoldGraph || null,
} = {}) {
  const journeyIds = new Set((journeys || []).map((journey) => journey.id));
  const flows = (interactionContract?.flows || []).filter((flow) => journeyIds.has(flow.journeyId));
  const owners = ownershipRules(bindings);
  const specifications = modulePlan.map((planned) => {
    const assignedFlows = flows.filter((flow) => targetModules(flow, modulePlan).includes(planned.path));
    const requiredBinding = planned.factory
      ? bindings.find((binding) => factoryForBinding(binding) === planned.factory) : null;
    const explicitCapabilities = planned.requiredCapabilities || [];
    const requiredCapabilities = unique([
      ...(requiredBinding ? [{
        capability: requiredBinding.name,
        factory: planned.factory,
        configuration: requiredBinding.configuration || null,
        methods: (requiredBinding.requiredMethods || []).map((method) => ({
          method, bound: true, invoked: true, exported: false,
          reachableFromJourneys: unique(assignedFlows.map((flow) => flow.journeyId)),
        })),
      }] : []),
      ...explicitCapabilities,
    ].map((entry) => JSON.stringify(entry))).map((entry) => JSON.parse(entry));
    const controls = assignedFlows.filter((flow) => flow.control && /\.(?:jsx|tsx)$/.test(planned.path)).map((flow) => ({
      interactionId: flow.id,
      journeyId: flow.journeyId,
      stepIndex: flow.stepIndex,
      logicalField: flow.control.logicalField || flow.valueWritten || null,
      roles: flow.control.roles || [],
      inputTypes: flow.control.inputTypes || [],
      accessibleNames: flow.control.accessibleNames || [flow.control.accessibleName].filter(Boolean),
      editable: flow.control.editable === true,
      selectedState: flow.control.selectedState === true,
      stateOwner: flow.stateOwner,
      writes: flow.writes || [],
    }));
    const reads = unique(assignedFlows.flatMap((flow) => flow.reads || []));
    const writes = unique(assignedFlows.flatMap((flow) => flow.writes || []));
    return {
      path: planned.path,
      role: planned.role || "planned module",
      providedBy: planned.providedBy || null,
      journeyController: planned.journeyController || null,
      sharedControllerFor: planned.sharedControllerFor || null,
      protected: planned.protected === true,
      ownedJourneys: unique([
        ...(planned.journeyIds || planned.ownedJourneys || []),
        ...assignedFlows.map((flow) => flow.journeyId),
      ]),
      requiredImports: unique(planned.requiredImports || []),
      requiredCapabilities,
      forbiddenCapabilityBypasses: owners,
      state: {
        owns: planned.stateOwnership?.owns || planned.owns || "presentation only",
        mayConsume: reads,
        mustProduce: writes,
        survivesReload: planned.stateOwnership?.survivesReload === true,
      },
      semanticInteractions: controls,
      sharedCustomOperations: sharedCustomOperations(assignedFlows),
      downstream: {
        consumes: reads,
        produces: writes,
        consumers: unique(flows.filter((candidate) => (candidate.reads || []).some((read) => writes.includes(read)))
          .map((candidate) => candidate.id)),
      },
      persistence: {
        owner: planned.stateOwnership?.approvedPersistence || planned.stateOwnership?.durableStateOwner || null,
        forbiddenApis: ["localStorage", "sessionStorage", "indexedDB", "IndexedDB", "process_memory"],
      },
      requiredExports: unique(planned.requiredExports || []),
      moduleSizeBoundary: /^src\/App\.(?:jsx?|tsx?)$/.test(planned.path) ? APP_SHELL_MAX_TOKENS : FILE_MAX_TOKENS,
    };
  });
  return { version: 1, specifications };
}

export function moduleGenerationContractsBrief(moduleContracts) {
  if (!(moduleContracts?.specifications || []).length) return "PER-MODULE GENERATION CONTRACTS: none for this scope.";
  return [
    "PER-MODULE GENERATION CONTRACTS (the intended responsibilities for this build):",
    JSON.stringify(moduleContracts, null, 2),
    "ENFORCED: capability-owned operations may not be reimplemented through a lower-level persistence API,",
    "and contracted durable state may not live in browser or process-local storage. These are checked before compilation.",
    "GUIDANCE: module paths, where a capability is instantiated, and how a required method is reached",
    "(called directly or passed as a reference, e.g. useSyncExternalStore) are yours to decide — the browser",
    "journeys decide whether the result is correct.",
    "Semantic controls may use any standards-compliant accessible HTML/ARIA shape; visual design is unrestricted.",
    "A sharedCustomOperations group is ONE runtime action projected into several contracted journeys, not a pipeline of independent fallbacks.",
    "Delegate to one implementation, or pass the same canonical source data explicitly through every implementation's declared runtime inputs; never recreate controller-owned domain collections independently inside extensions.",
    "Declared runtime inputs are authoritative. Collection add/remove/toggle operations must transform the passed collection using the passed identifier and must not reject that identifier against private module-local records unless those records are themselves a declared input. Merge equivalent outputs without allowing an empty/default result from a missing input to overwrite a valid result.",
  ].join("\n");
}

/**
 * Compact the already-enforced module contracts for any bounded repair or correction.
 *
 * Full generation needs the complete machine contract. A targeted dispatch has a retained tree
 * plus an exact write boundary, and the same full contracts are re-run deterministically after its
 * patch. Repeating every flow and capability-owner rule inside every module made live repair and
 * correction prompts too large to fit even their minimum useful response under the six-credit
 * per-call ceiling. This summary preserves the responsibilities needed to patch safely while the
 * validators remain the authoritative, unchanged gate.
 */
export function moduleGenerationContractsRepairBrief(moduleContracts, { focusPaths = [], focusControls = [] } = {}) {
  const focused = new Set((focusPaths || []).filter(Boolean));
  const focusedControls = new Set((focusControls || []).filter(Boolean).map((value) => String(value).toLowerCase()));
  const allSpecifications = moduleContracts?.specifications || [];
  const specifications = focused.size
    ? allSpecifications.filter((specification) => focused.has(specification.path))
    : allSpecifications;
  if (!specifications.length) return "PER-MODULE REPAIR CONTRACT SUMMARY: none for this scope.";
  const ownership = new Map();
  for (const specification of specifications) {
    for (const rule of specification.forbiddenCapabilityBypasses || []) {
      const key = JSON.stringify([rule.entity, rule.operationOwner, rule.capability]);
      if (!ownership.has(key)) ownership.set(key, {
        entity: rule.entity,
        operationOwner: rule.operationOwner,
        capability: rule.capability,
        requiredOperations: rule.requiredOperations || [],
      });
    }
  }
  const uniqueRows = (rows) => [...new Map((rows || []).map((row) => [JSON.stringify(row), row])).values()];
  // Exact interaction ids outrank human labels. A shared module can legitimately have several
  // unrelated fields all called "name"; treating the label as a global selector re-expanded a
  // one-control live repair into every journey that happened to use that word.
  const exactInteractionIds = new Set(allSpecifications.flatMap((specification) => (
    specification.semanticInteractions || []
  )).map((interaction) => interaction.interactionId)
    .filter((id) => id && focusedControls.has(String(id).toLowerCase())));
  const focusedInteractions = (specification) => (specification.semanticInteractions || [])
    .filter((control) => !focusedControls.size
      || (exactInteractionIds.size ? exactInteractionIds.has(control.interactionId) : [
        control.interactionId,
        control.logicalField,
        ...(control.accessibleNames || []),
      ].filter(Boolean).some((value) => focusedControls.has(String(value).toLowerCase()))));
  const focusedState = (specification, interactions) => {
    if (!focusedControls.size) return specification.state || null;
    const relevant = new Set(interactions.flatMap((interaction) => [
      ...(interaction.reads || []), ...(interaction.writes || []),
    ]));
    const state = specification.state || null;
    if (!state) return null;
    return {
      ...state,
      ...Object.fromEntries(["mayConsume", "mustProduce"].filter((key) => Array.isArray(state[key]))
        .map((key) => [key, state[key].filter((value) => relevant.has(value))])),
    };
  };
  const compact = {
    version: moduleContracts.version || 1,
    specifications: specifications.map((specification) => {
      const interactions = focusedInteractions(specification);
      const ownedJourneys = focusedControls.size
        ? [...new Set(interactions.map((interaction) => interaction.journeyId).filter(Boolean))]
        : specification.ownedJourneys || [];
      return {
        path: specification.path,
        role: specification.role,
        ownedJourneys,
        journeyController: specification.journeyController || null,
        sharedControllerFor: specification.sharedControllerFor || null,
        requiredImports: specification.requiredImports || [],
        capabilities: (specification.requiredCapabilities || []).map((capability) => ({
          capability: capability.capability,
          factory: capability.factory,
          methods: (capability.methods || []).map((method) => method.method),
        })),
        controls: uniqueRows(interactions.map((control) => ({
          logicalField: control.logicalField,
          roles: control.roles || [],
          inputTypes: control.inputTypes || [],
          accessibleNames: control.accessibleNames || [],
          stateOwner: control.stateOwner || null,
        }))),
        sharedCustomOperations: specification.sharedCustomOperations || [],
        state: focusedState(specification, interactions),
        persistenceOwner: specification.persistence?.owner || null,
        requiredExports: specification.requiredExports || [],
        moduleSizeBoundary: specification.moduleSizeBoundary,
      };
    }),
    capabilityOwnership: [...ownership.values()],
  };
  return [
    "PER-MODULE REPAIR CONTRACT SUMMARY (the full contracts remain machine-enforced after this patch):",
    JSON.stringify(compact, null, 2),
    "ENFORCED: preserve capability ownership, durable state, module boundaries and every currently passing journey.",
    "Browser/process-local persistence and lower-level writes around capability-owned operations remain forbidden.",
    "A sharedCustomOperations group is one runtime action: use one implementation or pass identical canonical source data through declared runtime inputs; never recreate controller-owned domain collections independently inside extensions.",
    "Declared runtime inputs are authoritative. Collection add/remove/toggle operations must transform the passed collection using the passed identifier and must not reject that identifier against private module-local records unless those records are themselves a declared input. Never overwrite a valid result with an empty/default result produced from missing inputs.",
  ].join("\n");
}

function location(source, index, length) {
  return {
    line: String(source).slice(0, index).split("\n").length,
    span: { start: index, end: index + length },
  };
}

function bypassDetails(source, match, rule) {
  const tail = String(source).slice(match.index + match[0].length, match.index + match[0].length + 100);
  const mutation = tail.match(/^\s*\)\s*\.\s*(create|update|remove|delete)\s*\(/i)?.[1]?.toLowerCase() || null;
  const operation = (rule.requiredOperations || []).find((method) => mutation && normalized(method).startsWith(mutation))
    || (rule.requiredOperations || [])[0] || mutation || "contracted_persistence";
  const actualApi = `db.entity(${JSON.stringify(rule.entity)})${mutation ? `.${mutation}(...)` : ""}`;
  return { mutation, operation, actualApi };
}

function patchPath(patch) {
  return patch?.newFile || patch?.replaceFile || patch?.deleteFile || patch?.file || null;
}

/** Reject writes outside a module-scoped correction before patch application. */
export function validateModulePatchScope(patches, scope) {
  if (!scope?.allowedFiles?.length && !scope?.allowedPrefixes?.length) return { ok: true, findings: [] };
  const allowed = new Set(scope.allowedFiles || []);
  const prefixes = [...new Set(scope.allowedPrefixes || [])];
  const withinScope = (path) => allowed.has(path) || prefixes.some((prefix) => path.startsWith(prefix));
  const findings = (patches || []).map(patchPath).filter((path) => path && !withinScope(path)).map((path) => ({
    code: "module_correction_scope_exceeded", module: path, allowedFiles: [...allowed].sort(), allowedPrefixes: prefixes,
    message: `module-scoped correction may not change ${path}`,
  }));
  return { ok: findings.length === 0, findings };
}

function reportModule(reportByPath, path) {
  if (!reportByPath.has(path)) reportByPath.set(path, {
    path, requiredFacts: [], satisfiedFacts: [], missingFacts: [], forbiddenFacts: [], sourceSpans: [], dependentJourneys: [],
  });
  return reportByPath.get(path);
}

/**
 * Deterministic conformance over every planned module. Validators return facts or intentional
 * findings; they never mutate the tree and never make an application-specific decision.
 */
export function validateModuleConformance(tree, {
  contract = null, modulePlan = [], moduleContracts = null, interactionContract = null, bindings = [],
  capabilityGraph = contract?.capabilityGraph || null,
  scaffoldGraph = contract?.scaffoldGraph || null,
} = {}) {
  const contracts = moduleContracts || buildModuleGenerationContracts({
    contract, modulePlan, interactionContract, bindings, capabilityGraph,
  });
  const reports = new Map((contracts.specifications || []).map((spec) => [spec.path, {
    path: spec.path,
    requiredFacts: [
      `module:${spec.path}`,
      ...spec.requiredCapabilities.flatMap((capability) => [
        `factory:${capability.factory}`,
        ...capability.methods.flatMap((method) => [
          `bound:${capability.factory}.${method.method}`,
          ...(method.invoked ? [`invoked:${capability.factory}.${method.method}`] : []),
          ...(method.exported ? [`exported:${capability.factory}.${method.method}`] : []),
        ]),
      ]),
      ...spec.semanticInteractions.map((control) => `interaction:${control.interactionId}`),
      ...spec.downstream.consumes.map((path) => `consumes:${path}`),
      ...spec.downstream.produces.map((path) => `produces:${path}`),
    ],
    satisfiedFacts: [], missingFacts: [], forbiddenFacts: [], sourceSpans: [],
    dependentJourneys: unique(spec.ownedJourneys),
  }]));
  const findings = [];
  const add = (finding) => {
    findings.push(finding);
    const module = finding.module ? reportModule(reports, finding.module) : null;
    if (module) {
      if (finding.forbidden) module.forbiddenFacts.push(finding.code);
      else module.missingFacts.push(finding.code);
      if (finding.span) module.sourceSpans.push({ code: finding.code, line: finding.line || null, span: finding.span });
      module.dependentJourneys = unique([...module.dependentJourneys, ...(finding.journeys || [])]);
    }
  };

  const provenance = aggregateCapabilityFacts(tree, bindings);
  for (const spec of contracts.specifications || []) {
    const report = reportModule(reports, spec.path);
    const source = tree?.[spec.path];
    if (typeof source !== "string") {
      add({ code: "required_module_missing", module: spec.path, journeys: spec.ownedJourneys,
        message: `required planned module is missing: ${spec.path}` });
      continue;
    }
    report.satisfiedFacts.push(`module:${spec.path}`);
    const tokenCount = Math.ceil(String(source).length / 4);
    if (tokenCount > spec.moduleSizeBoundary) add({ code: "module_size_exceeded", module: spec.path,
      actualTokens: tokenCount, maximumTokens: spec.moduleSizeBoundary, journeys: spec.ownedJourneys,
      message: `${spec.path} is ${tokenCount} tokens (max ${spec.moduleSizeBoundary})` });
    for (const requiredImport of spec.requiredImports || []) {
      const present = new RegExp(`\\bimport[\\s\\S]{0,300}?[\"']${String(requiredImport).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\"']`).test(source);
      if (!present) add({ code: "required_import_missing", module: spec.path, requiredImport,
        journeys: spec.ownedJourneys, message: `${spec.path} must import ${requiredImport}` });
      else report.satisfiedFacts.push(`import:${requiredImport}`);
    }
    for (const requiredExport of spec.requiredExports || []) {
      const exported = requiredExport === "default" ? /\bexport\s+default\b/.test(source)
        : new RegExp(`\\bexport\\s+(?:default\\s+)?(?:const|let|var|function|class|\\{)[\\s\\S]{0,240}?\\b${requiredExport}\\b`).test(source);
      if (!exported) add({ code: "required_export_missing", module: spec.path, requiredExport,
        journeys: spec.ownedJourneys, message: `${spec.path} must export ${requiredExport}` });
      else report.satisfiedFacts.push(`export:${requiredExport}`);
    }
    // Capability facts are read PROJECT-WIDE, not per module.
    //
    // Requiring the declaring module to also invoke every method ("invocation locality") had no
    // correctness meaning: a clean `src/data/wizard.js` that instantiates the machine and exports
    // it failed seven checks, and the only passing shape was a hand-written pass-through wrapper
    // per method. Where a capability is instantiated is architecture preference — recorded as
    // placement advice, never a defect.
    for (const required of spec.requiredCapabilities) {
      if (spec.providedBy === "capability_composer") {
        report.satisfiedFacts.push(`factory:${required.factory}`);
        for (const method of required.methods || []) {
          report.satisfiedFacts.push(`bound:${required.factory}.${method.method}`);
          if (method.invoked) report.satisfiedFacts.push(`invoked:${required.factory}.${method.method}`);
          if (method.exported) report.satisfiedFacts.push(`exported:${required.factory}.${method.method}`);
        }
        continue;
      }
      const facts = provenance.get(required.factory);
      const instances = (facts?.instances || []).filter((row) => row.module === spec.path);
      if (!instances.length) {
        add({ code: "module_factory_placement", module: spec.path, factory: required.factory,
          journeys: spec.ownedJourneys,
          placedIn: [...new Set((facts?.instances || []).map((row) => row.module))],
          message: `${spec.path} was planned to instantiate ${required.factory}(...)`
            + `${(facts?.instances || []).length ? ` (found in ${[...new Set((facts.instances).map((row) => row.module))].join(", ")})` : ""}` });
        continue;
      }
      report.satisfiedFacts.push(`factory:${required.factory}`);
      for (const method of required.methods || []) {
        if (facts?.bound?.has(method.method)) report.satisfiedFacts.push(`bound:${required.factory}.${method.method}`);
        if (method.invoked && facts?.used?.has(method.method)) {
          report.satisfiedFacts.push(`invoked:${required.factory}.${method.method}`);
        }
        if (method.exported) {
          const exported = new RegExp(`\\bexport\\s+(?:const|function|class|\\{)[\\s\\S]{0,240}\\b${method.method}\\b`).test(source);
          if (!exported) add({ code: "required_method_unexported", module: spec.path, factory: required.factory,
            method: method.method, journeys: method.reachableFromJourneys,
            message: `${spec.path} was planned to export the contracted ${method.method} operation` });
          else report.satisfiedFacts.push(`exported:${required.factory}.${method.method}`);
        }
      }
    }

    for (const rule of spec.forbiddenCapabilityBypasses || []) {
      const escaped = String(rule.entity).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(`\\bdb\\s*\\.\\s*entity\\s*\\(\\s*[\"'\\x60]${escaped}[\"'\\x60]`, "g");
      for (const match of String(source).matchAll(regex)) {
        const at = location(source, match.index, match[0].length);
        const bypass = bypassDetails(source, match, rule);
        add({ code: "capability_owner_bypassed", module: spec.path, operation: bypass.operation,
          expectedOwner: rule.operationOwner, actualApi: bypass.actualApi,
          entity: rule.entity, ...at, forbidden: true, journeys: spec.ownedJourneys,
          message: `${spec.path}:${at.line} bypasses ${rule.operationOwner} with db.entity(${JSON.stringify(rule.entity)})` });
      }
    }
  }

  // Ownership applies to every generated module, including an extra helper the model invents
  // outside the plan. Such a helper may be corrected in place, but cannot become a bypass.
  const plannedPaths = new Set((contracts.specifications || []).map((spec) => spec.path));
  for (const [path, raw] of Object.entries(tree || {})) {
    if (!SOURCE.test(path) || PLATFORM_SOURCE.test(path) || plannedPaths.has(path)) continue;
    const source = String(raw);
    for (const rule of ownershipRules(bindings)) {
      const escaped = String(rule.entity).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(`\\bdb\\s*\\.\\s*entity\\s*\\(\\s*[\"'\\x60]${escaped}[\"'\\x60]`, "g");
      for (const match of source.matchAll(regex)) {
        const at = location(source, match.index, match[0].length);
        const bypass = bypassDetails(source, match, rule);
        add({ code: "capability_owner_bypassed", module: path, operation: bypass.operation,
          expectedOwner: rule.operationOwner, actualApi: bypass.actualApi,
          entity: rule.entity, ...at, forbidden: true, journeys: [],
          message: `${path}:${at.line} bypasses ${rule.operationOwner} with db.entity(${JSON.stringify(rule.entity)})` });
      }
    }
  }

  const planVerdict = lintRequiredModulePlan(tree, modulePlan);
  for (const problem of planVerdict.problems || []) {
    const module = modulePlan.find((entry) => String(problem).includes(entry.path))?.path || null;
    if (!findings.some((finding) => finding.module === module && ["required_module_missing", "required_factory_missing"].includes(finding.code))) {
      add({ code: "module_plan_violation", module, message: problem });
    }
  }

  // Preserve the registry's canonical factory-configuration checks. Per-module facts add
  // placement and reachability; they do not replace entity/persistence option validation.
  const composed = new Set((capabilityGraph?.nodes || [])
    .filter((node) => node.type === "deterministic_capability" && node.protected)
    .map((node) => node.capabilityId));
  const generatedBindings = (bindings || []).filter((binding) => !composed.has(binding.name));
  const requiredVerdict = lintRequiredCapabilityBindings(tree, generatedBindings);
  for (const issue of requiredVerdict.issues || []) {
    const plannedModule = (contracts.specifications || []).find((spec) => spec.requiredCapabilities
      .some((required) => required.factory === issue.factory))?.path || null;
    const observedModule = (provenance.get(issue.factory)?.instances || [])[0]?.module || null;
    const module = plannedModule || observedModule;
    const duplicate = findings.some((finding) => finding.code === issue.code && finding.module === module
      && (finding.method || null) === (issue.method || null));
    if (!duplicate) add({ ...issue, module, message: issue.message });
  }

  // One capability authority: safety findings now arrive already structured and AST-derived.
  // (The former sessionless_mutation dedupe is gone with the finding itself — session
  // establishment is a runtime invariant, not a generated-source obligation.)
  for (const issue of lintCapabilitySafety(tree, bindings).findings || []) add(issue);

  // The composition contract is structural authority, not source inference: protected modules
  // must exist and every explicitly custom node must expose its declared bounded interface.
  if (capabilityGraph && typeof tree?.["src/lib/capabilities/composed/manifest.js"] === "string") {
    const composition = validateCapabilityComposition(tree, capabilityGraph,
      capabilityCompositionPlan(capabilityGraph));
    for (const problem of composition.problems) {
      const module = String(problem).match(/(?:missing:\s*|^)(src\/[^\s:]+)/)?.[1] || null;
      add({
        code: "capability_composition_invalid", module,
        journeys: (capabilityGraph.journeys || [])
          .filter((journey) => !module || (capabilityGraph.nodes || []).some((node) => (
            node.extension?.module === module && node.journeys?.includes(journey.journeyId)
          ))).map((journey) => journey.journeyId),
        message: problem,
      });
    }
  }
  if (scaffoldGraph && typeof tree?.["src/lib/scaffolds/composed/manifest.js"] === "string") {
    const scopedJourneyIds = unique((modulePlan || []).flatMap((module) => module.journeyIds || []));
    const composition = validateScaffoldComposition(tree, scaffoldGraph,
      scaffoldCompositionPlan(scaffoldGraph), { requireExtensions: true, rejectScreenSlots: true,
        journeyIds: scopedJourneyIds.length ? scopedJourneyIds : null });
    for (const problem of composition.problems) {
      const module = String(problem).match(/src\/[^\s:]+/)?.[0] || null;
      add({ code: "scaffold_composition_invalid", module,
        journeys: (scaffoldGraph.journeyRouteOwnership || scaffoldGraph.journeyOwnership || [])
          .filter((row) => !module || row.mountedModule === module)
          .map((row) => row.journeyId), message: problem });
    }
  }

  // Is every contracted control ADDRESSABLE? Asked after emit and before the app is served, so a
  // hand-wired control is named here rather than discovered part-way through a paid journey.
  //
  // Reported ALONGSIDE module conformance, never inside it: these are observations about binding,
  // not facts a module contract promised, and folding them into a module's missing facts made a
  // correctly-corrected module look non-conformant.
  const scaffoldActive = Boolean(scaffoldGraph
    && typeof tree?.["src/lib/scaffolds/composed/manifest.js"] === "string");
  const controlBindings = lintControlBindings(tree, {
    interactionContract,
    // Universal scaffold composition owns the mounted runtime graph. Dead generated routes are
    // retained as evidence, but can neither satisfy nor conflict with a live journey control.
    authoritativeFiles: scaffoldActive ? reachableSourcePaths(tree) : null,
  });
  // Keep the broad binding lint advisory: static inference cannot follow every correct wrapper or
  // dynamic binding. The enforceable subsets are a mixed implementation where one exact
  // contracted identity is hand-wired while another copy is demonstrably machine-bound, and a
  // literal/helper binding whose primitive is provably different from the contract. These are
  // exact source facts, not behavioural guesses.
  for (const conflict of (controlBindings.findings || [])
    .filter((finding) => ["contract_control_binding_conflict", "contract_control_wrong_binding"]
      .includes(finding.code))) {
    for (const element of conflict.elements || []) {
      add({ ...conflict, module: element.file, file: element.file, line: element.line,
        journeys: [conflict.journeyId].filter(Boolean) });
    }
  }

  const interactions = lintInteractiveWorkflow(tree, { interactionContract, modulePlan, bindings });
  for (const issue of interactions.findings || []) {
    const contractModules = issue.interactionId
      ? (contracts.specifications || []).filter((spec) => spec.semanticInteractions
        .some((control) => control.interactionId === issue.interactionId)).map((spec) => spec.path)
      : [];
    let modules = unique([...(contractModules.length ? contractModules : (issue.responsibleModules || [])), ...(issue.files || []),
      ...(issue.controls || []).map((control) => control.file)]).filter((path) => reports.has(path));
    if (!modules.length && issue.code === "review_data_flow_missing") modules = modulePlan.filter((row) => /review|summary/i.test(row.role || "")).map((row) => row.path);
    if (!modules.length && /confirmation|fabricated_confirmation/.test(issue.code)) modules = modulePlan.filter((row) => /confirmation|result/i.test(row.role || "")).map((row) => row.path);
    if (!modules.length && /cancellation/.test(issue.code)) modules = modulePlan.filter((row) => /status|history|detail/i.test(row.role || "")).map((row) => row.path);
    if (!modules.length) add({ ...issue, module: null, message: issue.message || JSON.stringify(issue) });
    else for (const module of modules) add({ ...issue, module, journeys: [issue.journeyId].filter(Boolean), message: issue.message || JSON.stringify(issue) });
  }

  for (const spec of contracts.specifications || []) {
    const report = reportModule(reports, spec.path);
    for (const control of spec.semanticInteractions || []) {
      if (!findings.some((finding) => finding.module === spec.path && finding.interactionId === control.interactionId)) {
        report.satisfiedFacts.push(`interaction:${control.interactionId}`);
      }
    }
    const source = normalized(tree?.[spec.path]);
    for (const path of spec.downstream?.consumes || []) {
      if (source.includes(normalized(String(path).split(".").at(-1)))) report.satisfiedFacts.push(`consumes:${path}`);
    }
    for (const path of spec.downstream?.produces || []) {
      if (source.includes(normalized(String(path).split(".").at(-1)))) report.satisfiedFacts.push(`produces:${path}`);
    }
  }

  for (const report of reports.values()) {
    report.requiredFacts = unique(report.requiredFacts).sort();
    report.satisfiedFacts = unique(report.satisfiedFacts).sort();
    report.missingFacts = unique(report.missingFacts).sort();
    report.forbiddenFacts = unique(report.forbiddenFacts).sort();
    report.dependentJourneys = unique(report.dependentJourneys).sort();
  }
  // Severity decides what stops a build. Only BLOCKING findings can scope a correction or
  // demand regeneration; advisory findings ride along as evidence.
  const { blocking, advisory } = partitionFindings(findings);
  const offendingModules = unique(blocking.map((finding) => finding.module)).sort();
  const unmapped = blocking.some((finding) => !finding.module);
  const narrowLimit = Math.max(2, Math.ceil((contracts.specifications || []).length / 2));
  const narrow = offendingModules.length > 0 && offendingModules.length <= narrowLimit && !unmapped;
  return {
    ok: blocking.length === 0,
    version: 1,
    modules: [...reports.values()].sort((a, b) => a.path.localeCompare(b.path)),
    findings,
    blocking,
    advisory,
    problems: blocking.map((finding) => JSON.stringify(finding)),
    advisoryProblems: advisory.map((finding) => JSON.stringify(finding)),
    // The binding lint's answer, RETURNED. It was computed on every build and dropped on the
    // floor — the whole AST walk ran and reached nobody. It stays out of `findings` on purpose:
    // wired as a gate it rejected 7/7 of the known-working corpus, and three of the four
    // indirection classes are beyond a static walker. The browser's probe now answers the same
    // question behaviourally, for actions as well as fields; this is context, never a verdict.
    controlBindings,
    correction: {
      kind: narrow ? "module_scoped" : "whole_core",
      modules: offendingModules,
      wholeCoreRequired: blocking.length > 0 && !narrow,
    },
  };
}

export function moduleCorrectionScope(report, moduleContracts) {
  const allowedFiles = unique(report?.correction?.modules).sort();
  const selected = (moduleContracts?.specifications || []).filter((spec) => allowedFiles.includes(spec.path));
  const blocking = report?.blocking || report?.findings || [];
  const factories = unique([
    ...selected.flatMap((spec) => spec.requiredCapabilities.map((row) => row.factory)),
    ...blocking.filter((finding) => allowedFiles.includes(finding.module)).map((finding) => finding.expectedOwner),
  ]);
  const capabilityPaths = unique(factories.map((factory) => CAPABILITIES[FACTORY_TO_CAPABILITY.get(factory)]?.package));
  return {
    kind: "module_contract",
    files: allowedFiles,
    allowedFiles,
    adapterInterfaces: allowedFiles.filter((path) => /\/data\//.test(path)),
    capabilityPaths,
    findings: blocking,
    moduleContracts: { version: moduleContracts?.version || 1, specifications: selected },
    instruction: "Correct only the validator-named modules so they satisfy their per-module generation contracts. Preserve every conforming module, the module plan, and visual design; do not regenerate the application. For every control-binding finding, modify the exact existing element named by finding.file/finding.line (and every finding.elements entry) to attach requiredBinding directly in this same response, including its inputProps/buttonProps spread or exact attribute and machineId. Do not add a parallel bound copy of the control: a new compliant duplicate leaves the named hand-wired element blocking. Merely importing/calling the helper or declaring an unused props variable is incomplete. data-journey-control is not a verifier identity.",
  };
}
