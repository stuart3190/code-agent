// The Capability Registry — Platform Architecture item 1 (docs/PRINCIPLES.md).
//
// Every Thrallo ability is a registered capability; the Lead Agent's tool list is GENERATED
// from this registry at conversation time, so adding a capability never means changing the
// Lead Agent. A capability that fails its requirements() check is excluded from the tool
// list for that owner rather than failing at invocation.
//
// Contract:
//   {
//     id:           snake_case tool name the model calls
//     description:  what it does, written for the model
//     specialist:   display identity ("Planner", "Builder", …) — Principle 4/11: specialists
//                   are disposable presentation entities the Lead Agent spawns per task
//     statusText:   plain-English working line ("Planning architecture…")
//     inputSchema:  JSON Schema for the tool arguments (strict)
//     costProfile:  "free" | "model" | "run" — used for budget expectations
//     requirements: (ctx) => ({ ok, reason? })  — env/plan/connection gating
//     invoke:       async (ctx, input) => result  — ctx carries owner, conversation, emit,
//                   services; the returned value goes back to the Lead Agent as tool output
//   }

const registry = new Map();

export function registerCapability(definition) {
  const required = ["id", "description", "specialist", "inputSchema", "invoke"];
  for (const key of required) {
    if (!definition?.[key]) throw new Error(`capability is missing ${key}`);
  }
  if (!/^[a-z][a-z0-9_]{1,60}$/.test(definition.id)) {
    throw new Error(`capability id must be snake_case: ${definition.id}`);
  }
  if (registry.has(definition.id)) {
    throw new Error(`capability ${definition.id} is already registered`);
  }
  registry.set(definition.id, {
    statusText: `${definition.specialist} is working…`,
    costProfile: "model",
    requirements: () => ({ ok: true }),
    ...definition,
  });
  return definition.id;
}

export function getCapability(id) {
  return registry.get(id) || null;
}

export function listCapabilities() {
  return [...registry.values()];
}

// The Lead Agent's tool list, filtered by per-owner requirements.
export async function capabilityToolDefs(ctx) {
  const tools = [];
  for (const capability of registry.values()) {
    const requirement = await capability.requirements(ctx);
    if (!requirement.ok) continue;
    tools.push({
      type: "function",
      name: capability.id,
      description: `[${capability.specialist}] ${capability.description}`,
      strict: true,
      parameters: capability.inputSchema,
    });
  }
  return tools;
}

export async function invokeCapability(id, ctx, input) {
  const capability = registry.get(id);
  if (!capability) {
    const error = new Error(`Unknown capability: ${id}`);
    error.code = "unknown_capability";
    throw error;
  }
  const requirement = await capability.requirements(ctx);
  if (!requirement.ok) {
    const error = new Error(requirement.reason || `${id} is not available`);
    error.code = "capability_unavailable";
    throw error;
  }
  return capability.invoke(ctx, input);
}

export function resetCapabilityRegistryForTests() {
  registry.clear();
}
