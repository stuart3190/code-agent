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

const SOURCE = /^src\/.*\.(?:jsx?|tsx?)$/;
const PLATFORM_SOURCE = /^src\/lib\/(?:capabilities\/|backend\/|visitorSession\.js$|assets\.js$|assetData\.js$)/;
const FACTORY_TO_CAPABILITY = new Map(Object.entries(CAPABILITIES).flatMap(([name, capability]) =>
  (capability.interface || []).filter((entry) => /^make[A-Z]/.test(entry)).map((factory) => [factory, name])));

const unique = (values) => [...new Set((values || []).filter(Boolean))];
const normalized = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const factoryForBinding = (binding) => (CAPABILITIES[binding?.name]?.interface || [])
  .find((entry) => /^make[A-Z]/.test(entry)) || null;

function targetModules(flow, modulePlan) {
  const targets = new Set(flow?.responsibleModules || []);
  const addRole = (pattern) => modulePlan.filter((module) => pattern.test(module.role || ""))
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

/**
 * Convert the build-wide plans into exact contracts for every planned generated module.
 * Callers may supply richer generic module-plan rows; no application domain is special-cased.
 */
export function buildModuleGenerationContracts({
  contract = null, modulePlan = [], interactionContract = null, bindings = [], journeys = contract?.journeys || [],
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
      ownedJourneys: unique(assignedFlows.map((flow) => flow.journeyId)),
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
  ].join("\n");
}

/**
 * Compact the already-enforced module contracts for a browser-informed repair.
 *
 * Full generation needs the complete machine contract. A targeted repair already has a compiled
 * tree plus exact browser evidence, and the same full contracts are re-run deterministically after
 * its patch. Repeating every flow and capability-owner rule inside every module made one live
 * repair prompt 160 KB and unable to fit even its minimum useful response under the six-credit
 * per-call ceiling. This summary preserves the responsibilities needed to patch safely while the
 * validators remain the authoritative, unchanged gate.
 */
export function moduleGenerationContractsRepairBrief(moduleContracts) {
  const specifications = moduleContracts?.specifications || [];
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
  const compact = {
    version: moduleContracts.version || 1,
    specifications: specifications.map((specification) => ({
      path: specification.path,
      role: specification.role,
      ownedJourneys: specification.ownedJourneys || [],
      requiredImports: specification.requiredImports || [],
      capabilities: (specification.requiredCapabilities || []).map((capability) => ({
        capability: capability.capability,
        factory: capability.factory,
        methods: (capability.methods || []).map((method) => method.method),
      })),
      controls: (specification.semanticInteractions || []).map((control) => ({
        logicalField: control.logicalField,
        roles: control.roles || [],
        inputTypes: control.inputTypes || [],
        accessibleNames: control.accessibleNames || [],
        stateOwner: control.stateOwner || null,
      })),
      dataFlow: {
        consumes: specification.downstream?.consumes || [],
        produces: specification.downstream?.produces || [],
      },
      state: specification.state || null,
      persistenceOwner: specification.persistence?.owner || null,
      requiredExports: specification.requiredExports || [],
      moduleSizeBoundary: specification.moduleSizeBoundary,
    })),
    capabilityOwnership: [...ownership.values()],
  };
  return [
    "PER-MODULE REPAIR CONTRACT SUMMARY (the full contracts remain machine-enforced after this patch):",
    JSON.stringify(compact, null, 2),
    "ENFORCED: preserve capability ownership, durable state, module boundaries and every currently passing journey.",
    "Browser/process-local persistence and lower-level writes around capability-owned operations remain forbidden.",
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
  if (!scope?.allowedFiles?.length) return { ok: true, findings: [] };
  const allowed = new Set(scope.allowedFiles);
  const findings = (patches || []).map(patchPath).filter((path) => path && !allowed.has(path)).map((path) => ({
    code: "module_correction_scope_exceeded", module: path, allowedFiles: [...allowed].sort(),
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
} = {}) {
  const contracts = moduleContracts || buildModuleGenerationContracts({ contract, modulePlan, interactionContract, bindings });
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
      const exported = new RegExp(`\\bexport\\s+(?:default\\s+)?(?:const|let|var|function|class|\\{)[\\s\\S]{0,240}?\\b${requiredExport}\\b`).test(source);
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
  const requiredVerdict = lintRequiredCapabilityBindings(tree, bindings);
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

  // Is every contracted control ADDRESSABLE? Asked after emit and before the app is served, so a
  // hand-wired control is named here rather than discovered part-way through a paid journey.
  //
  // Reported ALONGSIDE module conformance, never inside it: these are observations about binding,
  // not facts a module contract promised, and folding them into a module's missing facts made a
  // correctly-corrected module look non-conformant.
  const controlBindings = lintControlBindings(tree, { interactionContract });

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
    instruction: "Correct only the validator-named modules so they satisfy their per-module generation contracts. Preserve every conforming module, the module plan, and visual design; do not regenerate the application.",
  };
}
