// Contract-derived application-structure graph.
//
// The graph composes several generic scaffold families; it never chooses a product template.
// Known structure stays deterministic and every unsupported semantic unit is represented as one
// bounded extension rather than turning the whole application back into free-form generation.

import { scaffoldEntry, SCAFFOLD_REGISTRY_VERSION, SCAFFOLDS } from "./scaffoldRegistry.mjs";

export const SCAFFOLD_GRAPH_VERSION = 1;

const unique = (values) => [...new Set((values || []).filter(Boolean))];
const slug = (value, fallback = "screen") => String(value || fallback).toLowerCase()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || fallback;
const pascal = (value, fallback = "Screen") => slug(value, fallback).split("-")
  .map((part) => part[0].toUpperCase() + part.slice(1)).join("") || fallback;
const normalized = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const semanticTokens = (value) => new Set(String(value || "").toLowerCase().split(/[^a-z0-9]+/)
  .filter((part) => part.length > 2)
  .map((part) => part.replace(/(?:ing|ed|es|s)$/, ""))
  .filter(Boolean));
const textOf = (journey) => `${journey?.title || ""} ${(journey?.steps || [])
  .map((step) => `${step?.action || ""} ${step?.target || ""} ${step?.expect || ""}`).join(" ")}`.toLowerCase();

function capabilityIds(graph) {
  return new Set((graph?.nodes || []).filter((node) => node.type === "deterministic_capability")
    .map((node) => node.capabilityId));
}

function requiredCapabilityIds(graph) {
  return new Set((graph?.journeys || []).flatMap((journey) => journey.requiredNodeIds || [])
    .filter((id) => String(id).startsWith("capability:"))
    .map((id) => String(id).replace(/^capability:/, "")));
}

function operationMethods(graph) {
  return new Set((graph?.operationResponsibilities || []).flatMap((operation) => (
    operation.responsibilities || []
  )).map((responsibility) => responsibility.capabilityMethod || responsibility.semanticOperation).filter(Boolean));
}

function routeForJourney(contract, journey) {
  const routes = contract?.routes || [];
  if (!routes.length) return "/";
  const explicit = (journey?.steps || []).map((step) => String(step?.target || "").trim())
    .find((target) => target.startsWith("/") && routes.some((route) => route.path === target.split(/[?#]/)[0]));
  if (explicit) return explicit.split(/[?#]/)[0] || "/";
  const words = normalized(`${journey?.id || ""} ${journey?.title || ""}`);
  const journeyTokens = semanticTokens(`${journey?.id || ""} ${journey?.title || ""}`);
  const ranked = routes.map((route, index) => {
    const routeIdentity = normalized(`${route?.name || ""} ${String(route?.path || "").split("/").at(-1) || ""}`);
    const routeTokens = semanticTokens(`${route?.name || ""} ${route?.path || ""}`);
    const overlap = [...routeTokens].filter((token) => journeyTokens.has(token)).length;
    const containment = routeIdentity && (words.includes(routeIdentity) || routeIdentity.includes(words)) ? 2 : 0;
    return { route, index, score: overlap * 3 + containment };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  return (ranked[0]?.score > 0 ? ranked[0].route?.path : routes[0]?.path) || "/";
}

function screensFor(contract) {
  const routes = contract?.routes?.length ? contract.routes : [{ path: "/", name: "Home" }];
  const used = new Set();
  return routes.map((route, index) => {
    let name = pascal(route.name || (route.path === "/" ? "Home" : route.path), "Screen");
    if (!/Screen$/.test(name)) name += "Screen";
    if (used.has(name)) name = `${name.replace(/Screen$/, "")}${index + 1}Screen`;
    used.add(name);
    const screenId = slug(`${route.name || (route.path === "/" ? "home" : route.path)}-screen`);
    return {
      screenId, routePath: route.path || "/", routeName: route.name || route.path || "Home",
      module: `src/screens/scaffold/${name}.jsx`, exportName: "default",
      owner: `screen:${screenId}`, mountedBy: "scaffold:app_shell",
    };
  });
}

function selectedFamilies(contract, capabilityGraph) {
  const capabilities = requiredCapabilityIds(capabilityGraph);
  const availableCapabilities = capabilityIds(capabilityGraph);
  const methods = operationMethods(capabilityGraph);
  const signals = new Set(contract?.buildProfile?.requirementSignals || []);
  const routes = contract?.routes || [];
  const journeys = contract?.journeys || [];
  const allText = journeys.map(textOf).join(" ");
  const selected = new Set(["app_shell"]);
  if (routes.length > 1 || contract?.buildProfile?.resolvedBuildType === "website") selected.add("content_navigation");
  if (capabilities.has("crud")) selected.add("crud_resource");
  if ((methods.has("list") || /\b(?:browse|catalogue|catalog|directory|collection)\b/.test(allText))
    && (methods.has("get") || routes.length > 1 || /\bdetail\b/.test(allText))) selected.add("catalogue_detail");
  if (contract?.buildProfile?.applicationSubtype === "internal_tool"
    || routes.some((route) => /\b(?:dashboard|overview)\b/i.test(route?.name || ""))
    || methods.has("count")) selected.add("dashboard");
  if (capabilities.has("wizard") || journeys.some((journey) => (journey.steps || []).length >= 3
    && /\b(?:continue|next|review|confirm|step)\b/.test(textOf(journey)))) selected.add("workflow");
  if (signals.has("interactive_workspace") && capabilities.has("crud")
    || (capabilities.has("crud") && /\b(?:project|workspace).*(?:save|open|reopen)|(?:save|open|reopen).*(?:project|workspace)\b/.test(allText))) {
    selected.add("project_workspace");
  }
  if (signals.has("interactive_workspace") || /\b(?:canvas|editor|move object|resize object|workspace surface)\b/.test(allText)) {
    selected.add("canvas_editor");
  }
  if (availableCapabilities.has("booking")
    && /\b(?:book|booking|schedule|availability|appointment|slot)\b/.test(allText)) selected.add("scheduling");
  if ((contract?.auth?.required === true || signals.has("user_accounts")) && capabilities.has("session")) {
    selected.add("auth_account");
  }
  if (signals.has("admin") && availableCapabilities.has("roles")) selected.add("admin_management");
  if (signals.has("export") || /\b(?:export|download|print output)\b/.test(allText)) selected.add("export_output");
  return [...selected].filter((id) => scaffoldEntry(id)?.status !== "unavailable");
}

function unsupportedSignalExtensions(contract, capabilityGraph) {
  const supported = new Set();
  const capabilities = requiredCapabilityIds(capabilityGraph);
  if (capabilities.has("session")) supported.add("user_accounts");
  if (capabilities.has("crud")) supported.add("saved_data");
  if (capabilities.has("roles")) supported.add("admin");
  if ((capabilityGraph?.nodes || []).some((node) => node.type === "custom_behavior")) supported.add("custom_logic");
  const unsupported = (contract?.buildProfile?.requirementSignals || [])
    .filter((signal) => ["payments", "file_uploads", "realtime"].includes(signal) && !supported.has(signal));
  return unsupported.flatMap((signal) => (contract?.journeys || []).filter((journey) => {
    const body = textOf(journey);
    if (signal === "payments") return /\b(?:payment|checkout|subscription)\b/.test(body);
    if (signal === "file_uploads") return /\b(?:file|upload|document|asset)\b/.test(body);
    return /\b(?:real-time|realtime|live collaboration|presence)\b/.test(body);
  }).map((journey) => ({ signal, journey })));
}

function extensionContracts(contract, capabilityGraph) {
  const graphExtensions = (capabilityGraph?.nodes || []).filter((node) => node.type === "custom_behavior")
    .map((node) => ({
      extensionId: node.id,
      owningJourneys: [...(node.journeys || [])],
      inputs: [...(node.requiredInputs || [])], outputs: [...(node.outputs || [])],
      reads: [...(node.requiredInputs || [])], writes: [...(node.outputs || [])],
      stateOwnership: node.stateOwnership,
      allowedFiles: [node.extension.module], module: node.extension.module,
      requiredExports: [...(node.extension.requiredExports || [])],
      integrationPoints: ["mounted_screen", ...(node.dependencies || []).map((id) => `capability:${id}`)],
      verificationSemantics: node.verificationSemantics,
      source: "capability_graph",
    }));
  const signalExtensions = unsupportedSignalExtensions(contract, capabilityGraph).map(({ signal, journey }) => {
    const name = `run${pascal(journey.id)}${pascal(signal)}Extension`;
    const module = `src/extensions/scaffolds/${slug(journey.id)}-${slug(signal)}.js`;
    const flows = (capabilityGraph?.journeys || []).find((row) => row.journeyId === journey.id)?.dataFlows || [];
    return {
      extensionId: `custom_extension:${journey.id}:${signal}`,
      owningJourneys: [journey.id], inputs: unique(flows.flatMap((flow) => flow.reads || [])),
      outputs: unique(flows.flatMap((flow) => flow.writes || [])),
      reads: unique(flows.flatMap((flow) => flow.reads || [])),
      writes: unique(flows.flatMap((flow) => flow.writes || [])),
      stateOwnership: { owns: unique(flows.flatMap((flow) => flow.writes || [])), scope: "bounded extension" },
      allowedFiles: [module], module, requiredExports: [name],
      integrationPoints: ["mounted_screen"],
      verificationSemantics: { actions: (journey.steps || []).map((step) => step.action),
        stateChange: unique(flows.flatMap((flow) => flow.writes || [])),
        observe: (journey.steps || []).map((step) => step.expect).filter(Boolean) },
      source: `unsupported_requirement_signal:${signal}`,
    };
  });
  return [...new Map([...graphExtensions, ...signalExtensions].map((row) => [row.extensionId, row])).values()];
}

export function deriveScaffoldGraph(contract, capabilityGraph, { modulePlan = [] } = {}) {
  const screens = screensFor(contract);
  const families = selectedFamilies(contract, capabilityGraph);
  const familyNodes = families.map((scaffoldId) => {
    const entry = scaffoldEntry(scaffoldId);
    return {
      id: `scaffold:${scaffoldId}`, scaffoldId, version: entry.version, status: entry.status,
      purpose: entry.purpose, requiredCapabilities: [...entry.requiredCapabilities],
      optionalCapabilities: [...entry.optionalCapabilities], extensionPoints: [...entry.extensionPoints],
      verificationContract: entry.verificationContract,
    };
  });
  const journeyOwnership = (contract?.journeys || []).map((journey) => {
    const routePath = routeForJourney(contract, journey);
    const screen = screens.find((candidate) => candidate.routePath === routePath) || screens[0];
    const body = textOf(journey);
    const ownedFamilies = families.filter((id) => {
      if (id === "app_shell") return true;
      if (id === "content_navigation") return (contract?.routes || []).length > 1;
      if (id === "workflow") return (journey.steps || []).length >= 3;
      if (id === "canvas_editor") return /\b(?:canvas|editor|move|resize|position|workspace)\b/.test(body);
      if (id === "project_workspace") return /\b(?:project|workspace|save|open|reopen)\b/.test(body);
      if (id === "scheduling") return /\b(?:book|schedule|slot|availability|appointment)\b/.test(body);
      if (id === "auth_account") return /\b(?:sign|login|account|password|session)\b/.test(body);
      if (id === "admin_management") return /\b(?:admin|manage|moderate)\b/.test(body);
      if (id === "export_output") return /\b(?:export|download|print)\b/.test(body);
      if (id === "catalogue_detail") return /\b(?:browse|list|catalog|detail|view)\b/.test(body);
      return id === "crud_resource" || id === "dashboard";
    });
    return {
      journeyId: journey.id, routePath: screen.routePath, screenId: screen.screenId,
      mountedModule: screen.module, scaffoldNodeIds: ownedFamilies.map((id) => `scaffold:${id}`),
      capabilityNodeIds: (capabilityGraph?.journeys || [])
        .find((candidate) => candidate.journeyId === journey.id)?.requiredNodeIds || [],
      extensionIds: [],
    };
  });
  const extensions = extensionContracts(contract, capabilityGraph);
  for (const owner of journeyOwnership) {
    owner.extensionIds = extensions.filter((extension) => extension.owningJourneys.includes(owner.journeyId))
      .map((extension) => extension.extensionId);
  }
  const dependencyOrder = families.slice().sort((a, b) => {
    if (a === "app_shell") return -1;
    if (b === "app_shell") return 1;
    if (a === "content_navigation") return -1;
    if (b === "content_navigation") return 1;
    return a.localeCompare(b);
  });
  const edges = [
    ...families.filter((id) => id !== "app_shell")
      .map((id) => ({ from: "scaffold:app_shell", to: `scaffold:${id}`, type: "contains" })),
    ...screens.map((screen) => ({ from: "scaffold:app_shell", to: screen.owner, type: "mounts" })),
    ...journeyOwnership.flatMap((owner) => [
      { from: `journey:${owner.journeyId}`, to: owner.screenId ? `screen:${owner.screenId}` : null, type: "renders_on" },
      ...owner.scaffoldNodeIds.map((id) => ({ from: `journey:${owner.journeyId}`, to: id, type: "uses" })),
      ...owner.capabilityNodeIds.map((id) => ({ from: owner.screenId ? `screen:${owner.screenId}` : null, to: id, type: "adapts" })),
      ...owner.extensionIds.map((id) => ({ from: owner.screenId ? `screen:${owner.screenId}` : null, to: id, type: "extends" })),
    ]),
  ].filter((edge) => edge.from && edge.to);
  const crossScaffoldInterfaces = familyNodes.flatMap((node) => node.requiredCapabilities
    .map((capabilityId) => ({ consumer: node.id, provider: `capability:${capabilityId}`, interface: "capability_adapter" })));
  const expectedModuleSurface = {
    routes: screens.length,
    scaffoldFamilies: familyNodes.length,
    entities: (contract?.entities || []).length,
    customExtensions: extensions.length,
    deterministicFiles: 4,
    expectedGeneratedModules: screens.length + extensions.length + Math.min(modulePlan.length, (contract?.journeys || []).length * 3),
  };
  expectedModuleSurface.softMaximum = Math.max(8,
    4 + screens.length * 3 + familyNodes.length + (contract?.entities || []).length * 2 + extensions.length * 3);
  expectedModuleSurface.extremeMaximum = Math.max(16, Math.ceil(expectedModuleSurface.softMaximum * 1.75));
  return {
    version: SCAFFOLD_GRAPH_VERSION,
    registryVersion: SCAFFOLD_REGISTRY_VERSION,
    families: familyNodes,
    dependencyOrder: dependencyOrder.map((id) => `scaffold:${id}`),
    routes: screens.map(({ owner: _owner, ...screen }) => ({ ...screen,
      journeyIds: journeyOwnership.filter((row) => row.screenId === screen.screenId).map((row) => row.journeyId) })),
    screens,
    stateOwnership: familyNodes.map((node) => ({ scaffoldNodeId: node.id,
      ownership: scaffoldEntry(node.scaffoldId).stateOwnership })),
    persistenceOwnership: familyNodes.map((node) => ({ scaffoldNodeId: node.id,
      ownership: scaffoldEntry(node.scaffoldId).persistenceOwnership })),
    journeyOwnership, extensions, edges, crossScaffoldInterfaces, expectedModuleSurface,
    protectedFiles: unique(familyNodes.flatMap((node) => scaffoldEntry(node.scaffoldId).protectedModules)),
  };
}

export function validateScaffoldGraph(graph, contract, capabilityGraph) {
  const problems = [];
  if (graph?.version !== SCAFFOLD_GRAPH_VERSION) problems.push("unsupported scaffold graph version");
  if (!(graph?.families || []).some((node) => node.scaffoldId === "app_shell")) problems.push("app_shell is required");
  const capabilities = capabilityIds(capabilityGraph);
  for (const node of graph?.families || []) {
    const entry = SCAFFOLDS[node.scaffoldId];
    if (!entry) { problems.push(`unknown scaffold family ${node.scaffoldId}`); continue; }
    if (entry.version !== node.version) problems.push(`${node.scaffoldId} version does not match registry`);
    for (const capability of node.requiredCapabilities || []) {
      if (!capabilities.has(capability)) problems.push(`${node.scaffoldId} requires missing capability ${capability}`);
    }
  }
  const routePaths = new Set((graph?.routes || []).map((route) => route.routePath));
  for (const route of contract?.routes || []) {
    if (!routePaths.has(route.path)) problems.push(`contracted route ${route.path} has no scaffold screen`);
  }
  const journeyIds = new Set((contract?.journeys || []).map((journey) => journey.id));
  for (const journeyId of journeyIds) {
    const owner = (graph?.journeyOwnership || []).find((row) => row.journeyId === journeyId);
    if (!owner?.mountedModule || !routePaths.has(owner.routePath)) {
      problems.push(`journey ${journeyId} has no mounted scaffold owner`);
    }
  }
  for (const extension of graph?.extensions || []) {
    if (!extension.module || !(extension.requiredExports || []).length || !(extension.allowedFiles || []).includes(extension.module)) {
      problems.push(`extension ${extension.extensionId} is not bounded to a declared module/export`);
    }
  }
  return { ok: problems.length === 0, problems };
}

export function scaffoldModulePlan(graph, existingPlan = []) {
  // Scaffold families replace the old speculative free-form flow/component tree. Retain only
  // deterministic capability modules and explicitly bounded specialist/custom modules; mounted
  // screens below are the sole generated UI owners.
  const boundedExisting = (existingPlan || []).filter((module) => module?.providedBy === "capability_composer"
    || module?.protected === true || module?.customBehaviorId || module?.customExtensionId
    || (module?.requiredImports || []).length || String(module?.path || "").startsWith("src/extensions/"));
  const screens = (graph?.screens || []).map((screen) => ({
    path: screen.module,
    role: "mounted screen composition and application-specific visual design",
    journeyIds: (graph.journeyOwnership || []).filter((row) => row.screenId === screen.screenId)
      .map((row) => row.journeyId),
    providedBy: "scaffold_screen_slot", scaffoldScreenId: screen.screenId,
    routePath: screen.routePath,
    stateOwnership: { owns: "screen composition and ephemeral presentation state", survivesReload: false,
      durableStateOwner: "declared capability/custom extension interfaces" },
    requiredExports: ["default"],
  }));
  const extensions = (graph?.extensions || []).map((extension) => ({
    path: extension.module, role: `bounded custom extension ${extension.extensionId}`,
    journeyIds: extension.owningJourneys, requiredExports: extension.requiredExports,
    customExtensionId: extension.extensionId, stateOwnership: {
      owns: (extension.writes || []).join(", ") || "declared extension outputs",
      survivesReload: false, durableStateOwner: "capability handoff when contracted",
    },
  }));
  return [...new Map([...boundedExisting, ...screens, ...extensions].map((row) => [row.path, row])).values()];
}

export function scopeScaffoldGraph(graph, journeys = []) {
  const ids = new Set((journeys || []).map((journey) => journey?.id).filter(Boolean));
  const ownership = (graph?.journeyOwnership || []).filter((row) => ids.has(row.journeyId));
  const screenIds = new Set(ownership.map((row) => row.screenId));
  const familyIds = new Set(["scaffold:app_shell", ...ownership.flatMap((row) => row.scaffoldNodeIds || [])]);
  const extensionIds = new Set(ownership.flatMap((row) => row.extensionIds || []));
  const screens = (graph?.screens || []).filter((screen) => screenIds.has(screen.screenId));
  const routes = (graph?.routes || []).filter((route) => screenIds.has(route.screenId));
  const nodes = (graph?.families || []).filter((node) => familyIds.has(node.id));
  const endpoints = new Set([...familyIds, ...screenIds].map((id) => id.startsWith("screen:") ? id : id));
  for (const screenId of screenIds) endpoints.add(`screen:${screenId}`);
  for (const id of ids) endpoints.add(`journey:${id}`);
  for (const id of extensionIds) endpoints.add(id);
  return { ...graph, families: nodes, routes, screens, journeyOwnership: ownership,
    extensions: (graph?.extensions || []).filter((extension) => extensionIds.has(extension.extensionId)),
    edges: (graph?.edges || []).filter((edge) => endpoints.has(edge.from) && endpoints.has(edge.to)),
    dependencyOrder: (graph?.dependencyOrder || []).filter((id) => familyIds.has(id)),
    protectedFiles: unique(nodes.flatMap((node) => scaffoldEntry(node.scaffoldId)?.protectedModules || [])) };
}

export function scaffoldJourneyOwners(graph, journeyId) {
  const owner = (graph?.journeyOwnership || []).find((row) => row.journeyId === journeyId);
  if (!owner) return [];
  return unique([owner.mountedModule,
    ...(graph?.extensions || []).filter((extension) => extension.owningJourneys.includes(journeyId))
      .map((extension) => extension.module)]);
}

export function scaffoldGraphSummary(graph) {
  return {
    version: graph?.version || SCAFFOLD_GRAPH_VERSION,
    registryVersion: graph?.registryVersion || SCAFFOLD_REGISTRY_VERSION,
    families: (graph?.families || []).map((node) => ({ id: node.scaffoldId, version: node.version,
      status: node.status })),
    routes: (graph?.routes || []).map((route) => ({ path: route.routePath, screen: route.module,
      journeys: route.journeyIds || [] })),
    customExtensions: (graph?.extensions || []).map((extension) => ({ id: extension.extensionId,
      module: extension.module, owningJourneys: extension.owningJourneys })),
    expectedModuleSurface: graph?.expectedModuleSurface || null,
  };
}
