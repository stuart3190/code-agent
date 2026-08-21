// Canonical capability graph for Builder V2.
//
// The graph is derived from the application contract and its already-canonical interaction
// contract. It never guesses implementation from generated source. A flow is either owned by a
// proven registry capability or is explicitly assigned to one bounded custom_behavior module.

import { CAPABILITIES } from "./capabilityRegistry.mjs";

export const CAPABILITY_GRAPH_VERSION = 1;

const unique = (values) => [...new Set((values || []).filter(Boolean))];
const slug = (value) => String(value || "behavior").toLowerCase()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "behavior";
const pascal = (value) => slug(value).split("-")
  .map((part) => part[0].toUpperCase() + part.slice(1)).join("") || "Behavior";
const operationKind = (operation) => String(
  operation?.kind || operation?.type || operation?.action || operation?.id || "",
).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)[0] || "";
const factoryCapability = new Map(Object.entries(CAPABILITIES).flatMap(([id, capability]) =>
  (capability.interface || []).filter((name) => /^make[A-Z]/.test(name)).map((name) => [name, id])));
const compositionCapability = new Map(Object.keys(CAPABILITIES)
  .map((id) => [`src/lib/capabilities/composed/${id}.js`, id]));

function deterministicNode(binding, contract, flows) {
  const capability = CAPABILITIES[binding.name];
  const entities = unique([
    binding.configuration?.entity,
    ...(binding.name === "crud" ? (contract?.entities || []).map((entity) => entity.name) : []),
    ...(capability.entities || []).filter((entity) => (contract?.entities || [])
      .some((candidate) => candidate.name === entity)),
  ]);
  const ownedFlows = binding.name === "interaction-primitives"
    ? flows
    : flows.filter((flow) => factoryCapability.get(flow.capability) === binding.name
      || compositionCapability.get(flow.stateOwner) === binding.name);
  return {
    id: `capability:${binding.name}`,
    type: "deterministic_capability",
    capabilityId: binding.name,
    version: capability.version,
    provenance: "platform_registry",
    proven: true,
    protected: true,
    supportedOperations: [...capability.supportedOperations],
    requiredOperations: [...(binding.requiredMethods || [])],
    requiredInputs: capability.requiredInputs,
    outputs: capability.outputs,
    stateOwnership: capability.stateOwnership,
    persistenceSemantics: capability.persistenceSemantics,
    dependencies: [...capability.dependencies],
    compatibleUiInteractionPrimitives: [...capability.compatibleUiInteractionPrimitives],
    verificationSemantics: capability.verificationSemantics,
    testContract: [...capability.testContract],
    entities,
    journeys: unique(ownedFlows.map((flow) => flow.journeyId)),
    interactions: ownedFlows.map((flow) => flow.id),
    configuration: binding.configuration || null,
    compositionModule: `src/lib/capabilities/composed/${binding.name}.js`,
  };
}

function customNode(journey, flows, operations = []) {
  const id = slug(journey.id);
  const exportName = `run${pascal(journey.id)}CustomBehavior`;
  return {
    id: `custom_behavior:${id}`,
    type: "custom_behavior",
    capabilityId: null,
    version: "1.0.0",
    provenance: "generated_extension",
    proven: false,
    protected: false,
    supportedOperations: unique([...operations.map((operation) => operation.kind || operation.type || operation.action),
      ...flows.map((flow) => flow.kind)]),
    requiredInputs: unique([...operations.flatMap((operation) => operation.inputs || operation.reads || []),
      ...flows.flatMap((flow) => flow.reads || [])]),
    outputs: unique([...operations.flatMap((operation) => operation.outputs || operation.writes || []),
      ...flows.flatMap((flow) => flow.writes || [])]),
    stateOwnership: {
      owns: unique(flows.map((flow) => flow.stateOwner)),
      journey: journey.id,
    },
    persistenceSemantics: {
      durable: flows.some((flow) => [...(flow.reads || []), ...(flow.writes || [])]
        .some((path) => String(path).includes(".durable."))),
      owner: "explicit extension module; durable writes must call a composed capability",
      browserStorage: false,
    },
    dependencies: unique(flows.flatMap((flow) => [
      factoryCapability.get(flow.capability), compositionCapability.get(flow.stateOwner),
    ]).filter(Boolean)),
    compatibleUiInteractionPrimitives: unique(flows.map((flow) => flow.kind)),
    verificationSemantics: {
      actions: unique([...operations.map((operation) => operation.kind || operation.type || operation.action),
        ...flows.map((flow) => flow.kind)]),
      stateChange: unique(flows.flatMap((flow) => flow.writes || [])),
      durableMutation: flows.some((flow) => (flow.writes || []).some((path) => String(path).includes(".durable."))),
      observe: unique(flows.map((flow) => flow.observable)),
    },
    testContract: [
      ...operations.map((operation) => ({ operationId: operation.id || operation.name, inputs: operation.inputs || operation.reads || [], outputs: operation.outputs || operation.writes || [] })),
      ...flows.map((flow) => ({ interactionId: flow.id, reads: flow.reads || [], writes: flow.writes || [], observe: flow.observable || null })),
    ],
    journeys: [journey.id],
    interactions: flows.map((flow) => flow.id),
    extension: {
      module: `src/extensions/custom/${id}.js`,
      requiredExports: [exportName],
      interface: `${exportName}(inputs, context) -> declared outputs`,
    },
  };
}

/** Derive one graph. All unsupported behavior is explicit rather than silently model-owned. */
export function deriveCapabilityGraph(contract, { bindings = [], interactionContract = null } = {}) {
  const flows = interactionContract?.flows || [];
  const normalizedBindings = [...bindings];
  if (!normalizedBindings.some((binding) => binding.name === "interaction-primitives")) {
    normalizedBindings.push({ name: "interaction-primitives", version: CAPABILITIES["interaction-primitives"].version });
  }
  const nodes = normalizedBindings.map((binding) => deterministicNode(binding, contract, flows));
  const nodeForFactory = new Map(nodes.map((node) => [
    (CAPABILITIES[node.capabilityId]?.interface || []).find((name) => /^make[A-Z]/.test(name)), node.id,
  ]).filter(([factory]) => factory));
  const nodeForStateOwner = new Map(nodes.map((node) => [node.compositionModule, node.id]));
  const nodeForFlow = (flow) => nodeForFactory.get(flow.capability) || nodeForStateOwner.get(flow.stateOwner);
  const interactionNode = "capability:interaction-primitives";
  const customByJourney = new Map();
  const journeys = [];

  for (const journey of contract?.journeys || []) {
    const journeyFlows = flows.filter((flow) => flow.journeyId === journey.id);
    const uncovered = journeyFlows.filter((flow) => !nodeForFlow(flow));
    const journeyOperations = (contract?.operations || []).filter((operation) => operation.journey === journey.id);
    const genericOperations = new Set(["create", "insert", "add", "read", "get", "list", "find", "lookup", "search", "query", "view", "fetch", "update", "edit", "delete", "remove", "destroy"]);
    const unsupportedOperations = journeyOperations.filter((operation) => !genericOperations.has(operationKind(operation)));
    const uncoveredDurable = uncovered.filter((flow) => [...(flow.reads || []), ...(flow.writes || [])]
      .some((path) => String(path).includes(".durable.")));
    const customFlows = unsupportedOperations.length ? uncovered : uncoveredDurable;
    if (customFlows.length || unsupportedOperations.length) {
      const node = customNode(journey, customFlows, unsupportedOperations);
      nodes.push(node);
      customByJourney.set(journey.id, node);
    }
    const capabilityNodes = unique(journeyFlows.map(nodeForFlow));
    const dependencyNodes = capabilityNodes.flatMap((nodeId) => {
      const node = nodes.find((candidate) => candidate.id === nodeId);
      return (node?.dependencies || []).map((dependency) => `capability:${dependency}`);
    });
    const requiredNodeIds = unique([interactionNode, ...capabilityNodes, ...dependencyNodes,
      customByJourney.get(journey.id)?.id]);
    const entityNames = unique([
      ...journeyOperations.map((operation) => operation.entity),
      ...journeyFlows.flatMap((flow) => [...(flow.reads || []), ...(flow.writes || [])])
        .map((path) => String(path).split(".")[0])
        .filter((name) => (contract?.entities || []).some((entity) => entity.name === name)),
    ]);
    journeys.push({
      journeyId: journey.id,
      requiredNodeIds,
      entities: entityNames,
      state: unique(journeyFlows.flatMap((flow) => [...(flow.reads || []), ...(flow.writes || [])])),
      dataFlows: journeyFlows.map((flow) => ({ interactionId: flow.id, reads: flow.reads || [], writes: flow.writes || [] })),
      uiInteractionRequirements: journeyFlows.filter((flow) => flow.control).map((flow) => ({
        interactionId: flow.id, kind: flow.kind, machineId: flow.control.machineId || null,
        primitive: flow.control.inputTypes?.[0] || flow.control.roles?.[0] || flow.kind,
      })),
      durableStateOwner: journeyFlows.find((flow) => (flow.writes || []).some((path) => String(path).includes(".durable.")))?.capability
        || journeyFlows.find((flow) => flow.durableLifecycle)?.capability || null,
      customBehavior: customByJourney.get(journey.id)?.id || null,
    });
  }

  const edges = [];
  for (const flow of flows) {
    for (const candidate of flows) {
      const shared = (flow.writes || []).filter((path) => (candidate.reads || []).includes(path));
      if (!shared.length) continue;
      edges.push({ from: flow.id, to: candidate.id, type: "data_flow", state: shared });
    }
  }
  for (const node of nodes) {
    for (const dependency of node.dependencies || []) {
      if (nodes.some((candidate) => candidate.id === `capability:${dependency}`)) {
        edges.push({ from: node.id, to: `capability:${dependency}`, type: "depends_on", state: [] });
      }
    }
  }

  return {
    version: CAPABILITY_GRAPH_VERSION,
    registryVersions: Object.fromEntries(Object.entries(CAPABILITIES).map(([id, entry]) => [id, entry.version])),
    nodes,
    edges,
    journeys,
    customBehavior: nodes.filter((node) => node.type === "custom_behavior").map((node) => node.id),
  };
}

export function validateCapabilityGraph(graph, contract, interactionContract = contract?.interactionContract) {
  const problems = [];
  const nodes = new Map((graph?.nodes || []).map((node) => [node.id, node]));
  const journeys = new Map((graph?.journeys || []).map((journey) => [journey.journeyId, journey]));
  for (const journey of contract?.journeys || []) {
    const mapped = journeys.get(journey.id);
    if (!mapped) { problems.push(`journey ${journey.id} has no capability graph mapping`); continue; }
    if (!mapped.requiredNodeIds.length) problems.push(`journey ${journey.id} has no required capability or custom behavior`);
    for (const nodeId of mapped.requiredNodeIds) if (!nodes.has(nodeId)) problems.push(`journey ${journey.id} references missing node ${nodeId}`);
  }
  const mappedInteractions = new Set((graph?.nodes || []).flatMap((node) => node.interactions || []));
  for (const flow of interactionContract?.flows || []) {
    if (!mappedInteractions.has(flow.id)) {
      problems.push(`interaction ${flow.id} is not owned by a capability or custom behavior`);
    }
  }
  for (const node of graph?.nodes || []) {
    if (node.type !== "deterministic_capability") continue;
    const registry = CAPABILITIES[node.capabilityId];
    if (!registry) problems.push(`deterministic node ${node.id} is absent from the registry`);
    else if (registry.version !== node.version) problems.push(`${node.id} wants ${node.version}, registry ships ${registry.version}`);
  }
  return { ok: problems.length === 0, problems };
}

/** Final module ownership: composer-owned adapters plus independently replaceable UI/custom modules. */
export function capabilityModulePlan(graph, legacyPlan = []) {
  const capabilityByFactory = new Map(Object.entries(CAPABILITIES).flatMap(([id, entry]) =>
    (entry.interface || []).filter((name) => /^make[A-Z]/.test(name)).map((factory) => [factory, id])));
  const planned = legacyPlan.map((module) => {
    const capabilityId = capabilityByFactory.get(module.factory);
    if (!capabilityId) return module;
    return {
      ...module,
      path: `src/lib/capabilities/composed/${capabilityId}.js`,
      role: `${capabilityId} deterministic capability composition`,
      providedBy: "capability_composer",
      protected: true,
    };
  });
  for (const node of graph?.nodes || []) {
    if (node.type !== "custom_behavior") continue;
    if (planned.some((module) => module.path === node.extension.module)) continue;
    planned.push({
      path: node.extension.module,
      role: `bounded custom behavior for ${node.journeys.join(", ")}`,
      requiredExports: node.extension.requiredExports,
      customBehaviorId: node.id,
      stateOwnership: {
        owns: node.stateOwnership.owns.join(", ") || "declared custom outputs",
        survivesReload: node.persistenceSemantics.durable,
        durableStateOwner: node.dependencies.map((id) => `capability:${id}`).join(" + ") || null,
      },
    });
  }
  return [...new Map(planned.map((module) => [module.path, module])).values()];
}

export function scopeCapabilityGraph(graph, journeys = []) {
  const ids = new Set((journeys || []).map((journey) => journey?.id).filter(Boolean));
  const scopedJourneys = (graph?.journeys || []).filter((journey) => ids.has(journey.journeyId));
  const requiredNodes = new Set(scopedJourneys.flatMap((journey) => journey.requiredNodeIds));
  const nodes = (graph?.nodes || []).filter((node) => requiredNodes.has(node.id)
    || (node.type === "deterministic_capability" && ["session", "crud", "interaction-primitives"].includes(node.capabilityId)));
  const nodeIds = new Set(nodes.map((node) => node.id));
  return {
    ...graph,
    nodes,
    journeys: scopedJourneys,
    edges: (graph?.edges || []).filter((edge) => (nodeIds.has(edge.from) || !String(edge.from).startsWith("capability:"))
      && (nodeIds.has(edge.to) || !String(edge.to).startsWith("capability:"))),
    customBehavior: nodes.filter((node) => node.type === "custom_behavior").map((node) => node.id),
  };
}
