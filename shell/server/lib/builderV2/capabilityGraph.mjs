// Canonical capability graph for Builder V2.
//
// The graph is derived from the application contract and its already-canonical interaction
// contract. It never guesses implementation from generated source. A flow is either owned by a
// proven registry capability or is explicitly assigned to one bounded custom_behavior module.

import { CAPABILITIES, canonicalCapabilityId } from "./capabilityRegistry.mjs";
import { validateBuildProfileGraph } from "../../../shared/buildProfile.mjs";
import { functionalOutputEffect } from "../../../shared/implementationContract.mjs";

export const CAPABILITY_GRAPH_VERSION = 2;

const unique = (values) => [...new Set((values || []).filter(Boolean))];
const slug = (value) => String(value || "behavior").toLowerCase()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "behavior";
const pascal = (value) => slug(value).split("-")
  .map((part) => part[0].toUpperCase() + part.slice(1)).join("") || "Behavior";
const operationKind = (operation) => String(
  operation?.kind || operation?.type || operation?.action || operation?.id || "",
).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)[0] || "";
const PERSISTENCE_METHOD = Object.freeze({
  create: "create", insert: "create", add: "create",
  read: "get", get: "get", find: "get", lookup: "get", view: "get", fetch: "get",
  list: "list", search: "list", query: "list",
  update: "update", edit: "update",
  delete: "remove", remove: "remove", destroy: "remove",
});
const PERSISTENCE_SOURCE_METHODS = new Set(["get", "list", "count", "subscribe"]);
const list = (value) => (Array.isArray(value) ? unique(value.map(String)) : []);
const normalized = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const tokens = (value) => String(value || "").toLowerCase().match(/[a-z0-9]+/g) || [];
const capabilitySupports = (capabilityId, method, responsibility) => {
  const supported = CAPABILITIES[canonicalCapabilityId(capabilityId)]?.responsibilitySemantics?.[responsibility] || [];
  return Boolean(method) && supported.includes(method);
};

function persistenceCapabilityMethod(operation, responsibility, declaredReads, capabilityId) {
  const requested = responsibility?.capabilityMethod || responsibility?.method || responsibility?.operation || null;
  if (capabilitySupports(capabilityId, requested, "persistence")) return requested;
  if (capabilityId !== "crud") return requested;

  const alias = operationKind({ kind: requested || operationKind(operation) });
  const canonical = alias === "read"
    ? (declaredReads.length ? "get" : "list")
    : PERSISTENCE_METHOD[alias] || null;
  return capabilitySupports(capabilityId, canonical, "persistence") ? canonical : requested;
}

function fieldCatalog(contract, entityName = null) {
  const fields = new Map();
  for (const entity of contract?.entities || []) {
    if (entityName && entity.name !== entityName) continue;
    for (const field of entity.fields || []) {
      const key = normalized(field?.name);
      if (key && !fields.has(key)) fields.set(key, { entity: entity.name, field: field.name });
    }
  }
  return fields;
}

function declaredFields(values, fields) {
  return unique(list(values).map((value) => fields.get(normalized(String(value).split(".").at(-1)))?.field));
}

function descriptionFields(operation, fields) {
  const body = normalized(operation?.description);
  return unique([...fields.entries()]
    .filter(([key]) => key.length >= 4 && body.includes(key))
    .map(([, value]) => value.field));
}

function operationStep(operation, journey) {
  const steps = journey?.steps || [];
  const direct = steps.findIndex((step) => list(step?.operates).some((value) => normalized(value) === normalized(operation?.id)));
  if (direct >= 0) return direct;

  // Some structured contracts place an operation identity in `reads` on a step that also operates
  // input fields. That means the step depends on/performs the declared operation while its fields
  // remain browser controls. The previous fallback discarded every such step merely because it
  // had field operands, leaving the operation at synthetic index -1 while borrowing draft state
  // from step zero. Exact operation identity is authoritative and needs no prose inference.
  const referenced = steps.findIndex((step) => list(step?.reads)
    .some((value) => normalized(value) === normalized(operation?.id)));
  if (referenced >= 0) return referenced;

  // Backward-compatible structural recovery for contracts produced before operation
  // responsibilities existed. Identifier overlap only LINKS an operation to a step; it never
  // decides that the step is custom. The custom decision below additionally requires declared
  // input dependencies and declared output fields.
  const excluded = new Set([
    ...tokens(operationKind(operation)),
    ...tokens(operation?.entity),
  ]);
  const identity = tokens(operation?.id).filter((token) => !excluded.has(token));
  if (!identity.length) return -1;
  return steps.findIndex((step) => {
    if (!Array.isArray(step?.reads) || !step.reads.length || list(step?.operates).length) return false;
    const surface = new Set(tokens(`${step.action || ""} ${step.target || ""}`));
    return identity.some((token) => surface.has(token));
  });
}

function statePathForInput(journey, field, flows, stepIndex) {
  const suffix = `.draft.${field}`;
  const producer = flows.filter((flow) => flow.stepIndex <= stepIndex)
    .flatMap((flow) => flow.writes || []).findLast((path) => String(path).endsWith(suffix));
  return producer || `${journey.id}.input.${field}`;
}

function statePathForOutput(journey, field) {
  return `${journey.id}.custom.${field}`;
}

function downstreamInteractions(journey, flows, stepIndex, outputFields, fields) {
  if (stepIndex < 0 || !outputFields.length) return [];
  return unique((journey.steps || []).flatMap((candidate, index) => {
    if (index <= stepIndex) return [];
    const consumes = declaredFields(candidate?.reads, fields);
    if (!consumes.some((field) => outputFields.includes(field))) return [];
    return flows.filter((flow) => flow.stepIndex === index).map((flow) => flow.id);
  }));
}

function capabilityInputPaths(journey, capabilityId, method) {
  const inputs = CAPABILITIES[canonicalCapabilityId(capabilityId)]?.requiredInputs?.operations?.[method] || [];
  return unique(inputs.map((input) => `${journey.id}.input.${input}`));
}

function capabilityOutputPaths(journey, capabilityId, method) {
  const id = canonicalCapabilityId(capabilityId);
  const outputs = CAPABILITIES[id]?.operationOutputs?.[method] || [];
  return unique(outputs.map((output) => `${journey.id}.capability.${id}.${output}`));
}

function operationInteractionIds(operation, flows, stepIndex) {
  const exact = flows.filter((flow) => flow.operationId === operation.id).map((flow) => flow.id);
  if (exact.length || stepIndex < 0) return exact;
  return flows.filter((flow) => flow.stepIndex === stepIndex).map((flow) => flow.id);
}

function persistenceResponsibility(operation, journey) {
  const method = PERSISTENCE_METHOD[operationKind(operation)] || null;
  if (!method) return null;
  const result = method === "remove" ? `${journey.id}.durable.deleted`
    : method === "list" ? `${journey.id}.durable.records`
      : `${journey.id}.durable.record`;
  return {
    id: `${operation.id}:persistence`, operationId: operation.id, type: "persistence",
    semanticOperation: method,
    behavior: operation.description || `${method} ${operation.entity || "record"}`,
    entity: operation.entity || null, capabilityId: "crud", capabilityMethod: method,
    reads: capabilityInputPaths(journey, "crud", method), writes: [result],
    declaredReads: [], declaredWrites: [],
    owner: "capability:crud", customBehavior: null, requiresTransformation: false,
    interactionIds: [], downstreamDependencies: [], persistenceHandoff: null,
  };
}

function explicitResponsibilities(operation, journey, flows, contract) {
  if (!Array.isArray(operation?.responsibilities) || !operation.responsibilities.length) return [];
  // Functional transformations may consume one entity and produce another. The operation's
  // entity is the output/state owner, so it remains authoritative for declared writes; reads are
  // dependencies and may legitimately come from any entity in the same structured contract.
  // Scoping both sides to the output entity discarded valid cross-entity inputs before the graph
  // could bind them into the interaction contract (for example, source record -> export artifact).
  const fields = fieldCatalog(contract);
  const outputFields = fieldCatalog(contract, operation.entity);
  const stepIndex = operationStep(operation, journey);
  const interactionIds = operationInteractionIds(operation, flows, stepIndex);
  return operation.responsibilities.map((responsibility, index) => {
    const declaredReads = declaredFields(responsibility?.reads || responsibility?.inputs, fields);
    const declaredWrites = declaredFields(responsibility?.writes || responsibility?.outputs, outputFields);
    const reads = declaredReads.map((field) => statePathForInput(journey, field, flows, stepIndex));
    const outputEffect = responsibility?.outputEffect || functionalOutputEffect(operation, responsibility);
    const effectWrites = outputEffect ? [`${journey.id}.effect.${slug(operation.id)}`] : [];
    const writes = unique([...declaredWrites.map((field) => statePathForOutput(journey, field)), ...effectWrites]);
    const downstreamDependencies = downstreamInteractions(journey, flows, stepIndex, declaredWrites, fields);
    const requestedCapability = responsibility?.capabilityId || responsibility?.capability || null;
    const resolvedCapability = canonicalCapabilityId(requestedCapability);
    const requestedMethod = responsibility?.capabilityMethod || responsibility?.method || responsibility?.operation || null;
    const persistence = responsibility?.type === "persistence";
    const automaticPersistence = persistence ? persistenceResponsibility(operation, journey) : null;
    const capabilityId = persistence ? (resolvedCapability || requestedCapability || "crud")
      : (resolvedCapability || requestedCapability);
    const capabilityMethod = persistence
      ? persistenceCapabilityMethod(operation, responsibility, declaredReads, capabilityId)
      : (capabilitySupports(capabilityId, requestedMethod, "functional") ? requestedMethod : null);
    const type = persistence ? "persistence" : capabilityMethod ? "capability_functional" : "custom_functional";
    const capabilityOutputs = type === "custom_functional"
      ? [] : capabilityOutputPaths(journey, capabilityId, capabilityMethod);
    return {
      id: responsibility.id || `${operation.id}:${persistence ? "persistence" : `functional-${index + 1}`}`,
      operationId: operation.id, type,
      semanticOperation: requestedMethod || operationKind(operation),
      behavior: responsibility.behavior || operation.description || operation.id,
      entity: operation.entity || null,
      capabilityId: type === "custom_functional" ? null : capabilityId,
      capabilityMethod,
      requestedCapability: type === "custom_functional" ? requestedCapability : null,
      requestedCapabilityMethod: requestedMethod && requestedMethod !== capabilityMethod ? requestedMethod : null,
      reads: persistence ? unique([...reads, ...(automaticPersistence?.reads || []),
        ...capabilityInputPaths(journey, capabilityId, capabilityMethod)]) : reads,
      writes: persistence ? unique([...(automaticPersistence?.writes || writes), ...capabilityOutputs])
        : unique([...writes, ...capabilityOutputs]),
      declaredReads, declaredWrites,
      outputEffect: outputEffect ? { ...outputEffect, statePath: effectWrites[0] } : null,
      owner: type === "custom_functional" ? null : `capability:${capabilityId}`,
      customBehavior: null, requiresTransformation: !persistence,
      interactionIds, downstreamDependencies, persistenceHandoff: null, persistenceSource: null,
    };
  });
}

function legacyFunctionalResponsibility(operation, journey, flows, contract) {
  const fields = fieldCatalog(contract, operation.entity);
  const stepIndex = operationStep(operation, journey);
  const step = journey?.steps?.[stepIndex] || null;
  const persistenceOnlyKind = Boolean(PERSISTENCE_METHOD[operationKind(operation)]);
  const declaredReads = declaredFields(step?.reads, fields);
  const laterReads = stepIndex < 0 ? [] : declaredFields((journey.steps || []).slice(stepIndex + 1)
    .flatMap((candidate) => candidate?.reads || []), fields);
  const declaredWrites = unique([...laterReads, ...descriptionFields(operation, fields)])
    .filter((field) => !declaredReads.includes(field));
  const structurallyDeclaredTransformation = stepIndex >= 0 && declaredReads.length > 0 && declaredWrites.length > 0;
  if (persistenceOnlyKind && !structurallyDeclaredTransformation) return null;

  const priorFields = stepIndex < 0 ? [] : unique(flows.filter((flow) => flow.stepIndex < stepIndex)
    .flatMap((flow) => flow.writes || []).filter((path) => String(path).includes(".draft."))
    .map((path) => String(path).split(".").at(-1)));
  const semanticReads = declaredReads.length ? declaredReads : priorFields;
  const semanticWrites = declaredWrites.length ? declaredWrites : [`${slug(operation.id)}Result`];
  const interactionIds = stepIndex < 0 ? [] : flows.filter((flow) => flow.stepIndex === stepIndex).map((flow) => flow.id);
  const downstreamDependencies = downstreamInteractions(journey, flows, stepIndex, semanticWrites, fields);
  return {
    id: `${operation.id}:functional`, operationId: operation.id, type: "custom_functional",
    semanticOperation: operationKind(operation),
    behavior: operation.description || step?.action || operation.id,
    entity: operation.entity || null, capabilityId: null, capabilityMethod: null,
    requestedCapability: null, requestedCapabilityMethod: null,
    reads: semanticReads.map((field) => statePathForInput(journey, field, flows, stepIndex)),
    writes: semanticWrites.map((field) => statePathForOutput(journey, field)),
    declaredReads: semanticReads, declaredWrites: semanticWrites,
    owner: null, customBehavior: null, requiresTransformation: true,
    interactionIds, downstreamDependencies, persistenceHandoff: null, persistenceSource: null,
  };
}

function deriveOperationResponsibilities(operation, journey, flows, contract) {
  const stepIndex = operationStep(operation, journey);
  const explicit = explicitResponsibilities(operation, journey, flows, contract);
  const automaticPersistence = persistenceResponsibility(operation, journey);
  const responsibilities = explicit.length
    ? [...(automaticPersistence && !explicit.some((responsibility) => responsibility.type === "persistence")
      ? [automaticPersistence] : []), ...explicit]
    : [automaticPersistence, legacyFunctionalResponsibility(operation, journey, flows, contract)].filter(Boolean);
  const persistence = responsibilities.find((responsibility) => responsibility.type === "persistence");
  const functional = responsibilities.filter((responsibility) => responsibility.requiresTransformation);
  const linkedInteractionIds = operationInteractionIds(operation, flows, stepIndex);
  if (persistence) {
    persistence.interactionIds = functional.length ? []
      : unique([...(persistence.interactionIds || []), ...linkedInteractionIds]);
  }
  for (const responsibility of responsibilities) {
    if (!responsibility.requiresTransformation || !persistence) continue;
    if (PERSISTENCE_SOURCE_METHODS.has(persistence.capabilityMethod)) {
      responsibility.persistenceSource = {
        responsibilityId: persistence.id, capabilityId: persistence.capabilityId,
        capabilityMethod: persistence.capabilityMethod, entity: persistence.entity,
        reads: [...persistence.reads], writes: [...persistence.writes],
      };
      continue;
    }
    persistence.reads = unique([...persistence.reads, ...responsibility.writes]);
    responsibility.persistenceHandoff = {
      responsibilityId: persistence.id, capabilityId: persistence.capabilityId,
      capabilityMethod: persistence.capabilityMethod, entity: persistence.entity,
      reads: [...persistence.reads], writes: [...persistence.writes],
    };
  }
  return {
    operationId: operation.id, journeyId: journey.id, entity: operation.entity || null,
    stepIndex, responsibilities,
  };
}
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

function customNode(journey, flows, responsibilities = []) {
  const id = slug(journey.id);
  const exportName = `run${pascal(journey.id)}CustomBehavior`;
  const handoffs = responsibilities.map((responsibility) => responsibility.persistenceHandoff).filter(Boolean);
  const sources = responsibilities.map((responsibility) => responsibility.persistenceSource).filter(Boolean);
  return {
    id: `custom_behavior:${id}`,
    type: "custom_behavior",
    capabilityId: null,
    version: "1.0.0",
    provenance: "generated_extension",
    proven: false,
    protected: false,
    supportedOperations: unique([...responsibilities.map((responsibility) => responsibility.semanticOperation
      || responsibility.behavior || responsibility.operationId),
      ...flows.map((flow) => flow.kind)]),
    requiredInputs: unique([...responsibilities.flatMap((responsibility) => responsibility.reads || []),
      ...flows.flatMap((flow) => flow.reads || [])]),
    outputs: unique([...responsibilities.flatMap((responsibility) => responsibility.writes || []),
      ...flows.flatMap((flow) => flow.writes || [])]),
    stateOwnership: {
      owns: unique(responsibilities.flatMap((responsibility) => responsibility.writes || [])),
      journey: journey.id,
    },
    persistenceSemantics: {
      durable: false,
      owner: "bounded custom transformation; durable state is read from or handed off to composed capabilities",
      handoffs,
      sources,
      browserStorage: false,
    },
    dependencies: unique([
      ...handoffs.map((handoff) => handoff.capabilityId),
      ...sources.map((source) => source.capabilityId),
      ...flows.flatMap((flow) => [
        factoryCapability.get(flow.capability), compositionCapability.get(flow.stateOwner),
      ]),
    ].filter(Boolean)),
    compatibleUiInteractionPrimitives: unique(flows.map((flow) => flow.kind)),
    verificationSemantics: {
      actions: unique([...responsibilities.map((responsibility) => responsibility.behavior || responsibility.operationId),
        ...flows.map((flow) => flow.kind)]),
      stateChange: unique(responsibilities.flatMap((responsibility) => responsibility.writes || [])),
      durableMutation: false,
      persistenceHandoff: handoffs,
      observe: unique([...flows.map((flow) => flow.observable),
        ...responsibilities.flatMap((responsibility) => responsibility.downstreamDependencies || [])]),
    },
    testContract: [
      ...responsibilities.map((responsibility) => ({
        responsibilityId: responsibility.id, operationId: responsibility.operationId,
        behavior: responsibility.behavior, inputs: responsibility.reads, outputs: responsibility.writes,
        persistenceHandoff: responsibility.persistenceHandoff,
        persistenceSource: responsibility.persistenceSource,
      })),
      ...flows.map((flow) => ({ interactionId: flow.id, reads: flow.reads || [], writes: flow.writes || [], observe: flow.observable || null })),
    ],
    operationResponsibilities: responsibilities,
    journeys: [journey.id],
    interactions: unique([...flows.map((flow) => flow.id),
      ...responsibilities.flatMap((responsibility) => responsibility.interactionIds || [])]),
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
  for (const operation of contract?.operations || []) {
    for (const responsibility of operation?.responsibilities || []) {
      const declaredCapability = responsibility?.capabilityId || responsibility?.capability;
      const capabilityId = canonicalCapabilityId(declaredCapability) || declaredCapability;
      const method = responsibility?.capabilityMethod || responsibility?.method || responsibility?.operation;
      if (!capabilitySupports(capabilityId, method, "functional")) continue;
      if (!normalizedBindings.some((binding) => binding.name === capabilityId)) {
        normalizedBindings.push({ name: capabilityId, version: CAPABILITIES[capabilityId].version, requiredMethods: [method] });
      }
    }
  }
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
  const operationResponsibilities = [];

  for (const journey of contract?.journeys || []) {
    const journeyFlows = flows.filter((flow) => flow.journeyId === journey.id);
    const uncovered = journeyFlows.filter((flow) => !nodeForFlow(flow));
    const journeyOperations = (contract?.operations || []).filter((operation) => operation.journey === journey.id);
    const mappedOperations = journeyOperations.map((operation) => (
      deriveOperationResponsibilities(operation, journey, journeyFlows, contract)
    ));
    operationResponsibilities.push(...mappedOperations);
    const responsibilities = mappedOperations.flatMap((operation) => operation.responsibilities);
    const customResponsibilities = responsibilities.filter((responsibility) => responsibility.type === "custom_functional");
    const uncoveredDurable = uncovered.filter((flow) => [...(flow.reads || []), ...(flow.writes || [])]
      .some((path) => String(path).includes(".durable.")));
    const customInteractionIds = new Set(customResponsibilities.flatMap((responsibility) => responsibility.interactionIds));
    const customFlows = unique([...journeyFlows.filter((flow) => customInteractionIds.has(flow.id)), ...uncoveredDurable]);
    if (customFlows.length || customResponsibilities.length) {
      const node = customNode(journey, customFlows, customResponsibilities);
      nodes.push(node);
      customByJourney.set(journey.id, node);
      for (const responsibility of customResponsibilities) {
        responsibility.owner = node.id;
        responsibility.customBehavior = node.id;
      }
      // The interaction primitive still owns how the action is driven. A deterministic data
      // capability must not simultaneously claim the domain transformation itself.
      for (const deterministic of nodes.filter((candidate) => candidate.type === "deterministic_capability"
        && candidate.capabilityId !== "interaction-primitives")) {
        deterministic.interactions = (deterministic.interactions || []).filter((id) => !customInteractionIds.has(id));
      }
    }
    for (const responsibility of responsibilities.filter((candidate) => candidate.type !== "custom_functional")) {
      const node = nodes.find((candidate) => candidate.id === `capability:${responsibility.capabilityId}`);
      if (!node) continue;
      responsibility.owner = node.id;
      node.requiredOperations = unique([...(node.requiredOperations || []), responsibility.capabilityMethod]);
      node.operationResponsibilities = [...(node.operationResponsibilities || []), responsibility];
      node.journeys = unique([...(node.journeys || []), journey.id]);
    }
    const capabilityNodes = unique([
      ...journeyFlows.map(nodeForFlow),
      ...responsibilities.filter((responsibility) => responsibility.type !== "custom_functional")
        .map((responsibility) => responsibility.owner),
    ]);
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
    const semanticByInteraction = new Map();
    for (const responsibility of responsibilities) {
      for (const interactionId of responsibility.interactionIds || []) {
        const current = semanticByInteraction.get(interactionId) || { reads: [], writes: [], responsibilities: [] };
        current.reads.push(...responsibility.reads);
        current.writes.push(...responsibility.writes);
        current.responsibilities.push(responsibility.id);
        current.capabilityMethod ||= responsibility.capabilityMethod;
        current.customBehavior ||= responsibility.customBehavior;
        current.owner ||= responsibility.owner;
        current.downstreamDependencies = unique([...(current.downstreamDependencies || []),
          ...(responsibility.downstreamDependencies || [])]);
        semanticByInteraction.set(interactionId, current);
      }
    }
    const dataFlows = journeyFlows.map((flow) => {
      const semantic = semanticByInteraction.get(flow.id);
      return {
        interactionId: flow.id,
        reads: unique([...(flow.reads || []), ...(semantic?.reads || [])]),
        writes: unique([...(flow.writes || []), ...(semantic?.writes || [])]),
        capabilityMethod: semantic?.capabilityMethod || null,
        customBehavior: semantic?.customBehavior || null,
        semanticOwner: semantic?.owner || nodeForFlow(flow) || null,
        responsibilities: semantic?.responsibilities || [],
        downstreamDependencies: semantic?.downstreamDependencies || [],
      };
    });
    journeys.push({
      journeyId: journey.id,
      requiredNodeIds,
      entities: entityNames,
      state: unique(dataFlows.flatMap((flow) => [...flow.reads, ...flow.writes])),
      dataFlows,
      operationResponsibilities: mappedOperations,
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
  const semanticFlows = journeys.flatMap((journey) => journey.dataFlows || []);
  for (const flow of semanticFlows) {
    for (const candidate of semanticFlows) {
      const shared = (flow.writes || []).filter((path) => (candidate.reads || []).includes(path));
      if (!shared.length) continue;
      edges.push({ from: flow.interactionId, to: candidate.interactionId, type: "data_flow", state: shared });
    }
  }
  for (const operation of operationResponsibilities) {
    for (const responsibility of operation.responsibilities) {
      for (const interactionId of responsibility.interactionIds || []) {
        for (const downstream of responsibility.downstreamDependencies || []) {
          edges.push({ from: interactionId, to: downstream, type: "semantic_data_flow", state: [...responsibility.writes] });
        }
      }
      if (responsibility.persistenceHandoff) {
        edges.push({ from: responsibility.customBehavior || responsibility.owner,
          to: `capability:${responsibility.persistenceHandoff.capabilityId}`,
          type: "persistence_handoff", state: [...responsibility.persistenceHandoff.reads] });
      }
      if (responsibility.persistenceSource) {
        edges.push({ from: `capability:${responsibility.persistenceSource.capabilityId}`,
          to: responsibility.customBehavior || responsibility.owner,
          type: "persistence_source", state: [...responsibility.persistenceSource.writes] });
      }
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
    buildProfile: contract?.buildProfile || null,
    registryVersions: Object.fromEntries(Object.entries(CAPABILITIES).map(([id, entry]) => [id, entry.version])),
    nodes,
    edges,
    journeys,
    operationResponsibilities,
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
  const operations = new Map((graph?.operationResponsibilities || []).map((operation) => [operation.operationId, operation]));
  for (const operation of contract?.operations || []) {
    if (!operation?.journey) continue;
    const mapped = operations.get(operation.id);
    if (!mapped) {
      problems.push(`operation ${operation.id} has no semantic responsibility mapping`);
      continue;
    }
    for (const responsibility of mapped.responsibilities || []) {
      const prefix = `operation ${operation.id} responsibility ${responsibility.id}`;
      if (responsibility.type === "persistence") {
        if (!capabilitySupports(responsibility.capabilityId, responsibility.capabilityMethod, "persistence")) {
          problems.push(`${prefix} is not implemented by the declared persistence capability method`);
        }
      } else if (responsibility.type === "capability_functional") {
        if (!capabilitySupports(responsibility.capabilityId, responsibility.capabilityMethod, "functional")) {
          problems.push(`${prefix} is not functionally implemented by the declared capability method`);
        }
      } else if (responsibility.type === "custom_functional") {
        const owner = nodes.get(responsibility.customBehavior);
        if (!owner || owner.type !== "custom_behavior") problems.push(`${prefix} has no bounded custom_behavior owner`);
        const missingSemanticFields = [
          ...(!(responsibility.reads || []).length ? ["reads"] : []),
          ...(!(responsibility.writes || []).length ? ["writes"] : []),
        ];
        if (missingSemanticFields.length) {
          problems.push(`capability_graph_semantics_incomplete operation=${operation.id} `
            + `responsibility=${responsibility.id} missing=${missingSemanticFields.join(",")}`);
        }
        if (!Array.isArray(responsibility.downstreamDependencies)) {
          problems.push(`${prefix} has no declared downstream dependency contract`);
        }
        if (owner && !(responsibility.writes || []).every((path) => owner.stateOwnership?.owns?.includes(path))) {
          problems.push(`${prefix} outputs are not owned by its bounded custom_behavior node`);
        }
        if (!owner?.extension?.module || !(owner?.extension?.requiredExports || []).length) {
          problems.push(`${prefix} has no bounded extension contract`);
        }
        if (!owner?.verificationSemantics?.actions?.length
          || !(responsibility.writes || []).every((path) => owner.verificationSemantics?.stateChange?.includes(path))) {
          problems.push(`${prefix} has no authoritative verification semantics for its state transformation`);
        }
        const persistenceMethod = PERSISTENCE_METHOD[operationKind(operation)];
        if (persistenceMethod && PERSISTENCE_SOURCE_METHODS.has(persistenceMethod)
          && !responsibility.persistenceSource) {
          problems.push(`${prefix} has no persistence source for its durable ${operationKind(operation)} input`);
        } else if (persistenceMethod && !PERSISTENCE_SOURCE_METHODS.has(persistenceMethod)
          && !responsibility.persistenceHandoff) {
          problems.push(`${prefix} has no persistence handoff for its durable ${operationKind(operation)} effect`);
        }
      } else {
        problems.push(`${prefix} has unknown semantic type ${responsibility.type || "(missing)"}`);
      }
      if (responsibility.requiresTransformation
        && !responsibility.capabilityMethod && !responsibility.customBehavior
        && !(responsibility.reads || []).length && !(responsibility.writes || []).length) {
        problems.push(`${prefix} is a state transformation with no capability method, custom behavior, reads, or writes`);
      }
    }
  }
  const profileVerdict = validateBuildProfileGraph(graph, contract?.buildProfile || graph?.buildProfile);
  problems.push(...profileVerdict.problems);
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
      journeyIds: [...node.journeys],
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
  const scopedResponsibilities = (graph?.operationResponsibilities || [])
    .filter((operation) => ids.has(operation.journeyId));
  const scopedInteractionIds = new Set(scopedJourneys.flatMap((journey) => [
    ...(journey.dataFlows || []).map((flow) => flow.interactionId),
    ...(journey.uiInteractionRequirements || []).map((requirement) => requirement.interactionId),
    ...(journey.operationResponsibilities || []).flatMap((operation) => (operation.responsibilities || [])
      .flatMap((responsibility) => responsibility.interactionIds || [])),
  ]).filter(Boolean));
  const scopedEntities = new Set(scopedJourneys.flatMap((journey) => journey.entities || []));
  const requiredNodes = new Set(scopedJourneys.flatMap((journey) => journey.requiredNodeIds || []));
  const nodes = (graph?.nodes || []).filter((node) => requiredNodes.has(node.id)
    || (node.type === "deterministic_capability" && ["session", "crud", "interaction-primitives"].includes(node.capabilityId)))
    .map((node) => {
      const nodeResponsibilities = scopedResponsibilities.flatMap((operation) => operation.responsibilities || [])
        .filter((responsibility) => responsibility.owner === node.id
          || responsibility.customBehavior === node.id);
      const requiredOperations = unique([
        ...nodeResponsibilities.map((responsibility) => responsibility.capabilityMethod),
        ...scopedJourneys.flatMap((journey) => (journey.dataFlows || [])
          .filter((flow) => flow.semanticOwner === node.id)
          .map((flow) => flow.capabilityMethod)),
      ]);
      return {
        ...node,
        ...(Array.isArray(node.requiredOperations)
          ? { requiredOperations: requiredOperations.length ? requiredOperations : node.requiredOperations }
          : {}),
        ...(Array.isArray(node.entities)
          ? { entities: node.entities.filter((entity) => scopedEntities.has(entity)) }
          : {}),
        ...(Array.isArray(node.journeys)
          ? { journeys: node.journeys.filter((journeyId) => ids.has(journeyId)) }
          : {}),
        ...(Array.isArray(node.interactions)
          ? { interactions: node.interactions.filter((interactionId) => scopedInteractionIds.has(interactionId)) }
          : {}),
        ...(Array.isArray(node.operationResponsibilities)
          ? { operationResponsibilities: nodeResponsibilities }
          : {}),
      };
    });
  const nodeIds = new Set(nodes.map((node) => node.id));
  const retainedEndpoint = (endpoint) => nodeIds.has(endpoint) || scopedInteractionIds.has(endpoint);
  return {
    ...graph,
    nodes,
    journeys: scopedJourneys,
    operationResponsibilities: scopedResponsibilities,
    edges: (graph?.edges || []).filter((edge) => retainedEndpoint(edge.from) && retainedEndpoint(edge.to)),
    customBehavior: nodes.filter((node) => node.type === "custom_behavior").map((node) => node.id),
  };
}
