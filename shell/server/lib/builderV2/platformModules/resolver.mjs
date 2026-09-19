// Deterministic module resolution (audit §11).
//
// Input: the capability bindings a contract needs (plus any explicitly requested modules) and the
// deployment's declared availability. Output: an explainable, dependency-complete, conflict-free
// module set in a stable order — or a list of problems that block generation. The same input
// always produces the same output; nothing here consults a clock, the environment or the model.
//
// Problems are typed so the orchestrator can distinguish a configuration gap (module_unavailable:
// the deployment does not provide a required service) from a contract defect (a range conflict
// or two modules claiming one capability). Neither is ever resolved by generating custom code.

import { MODULE_REGISTRY, moduleForCapability, moduleManifest } from "./registry.mjs";
import { baselineDeploymentAvailability, serviceAvailable } from "./availability.mjs";
import { satisfiesRange } from "./semver.mjs";
import { canonicalCapabilityId } from "../capabilityRegistry.mjs";

export const MODULE_RESOLUTION_VERSION = 1;

export const RESOLUTION_PROBLEMS = Object.freeze({
  UNKNOWN_CAPABILITY: "unknown_capability",
  UNKNOWN_MODULE: "unknown_module",
  RANGE_CONFLICT: "module_range_conflict",
  DECLARED_CONFLICT: "module_conflict",
  CAPABILITY_OWNERSHIP: "capability_ownership_conflict",
  UNAVAILABLE: "module_unavailable",
  DEPRECATED: "module_deprecated",
  CYCLE: "module_dependency_cycle",
});

const sortById = (rows) => [...rows].sort((a, b) => a.id.localeCompare(b.id));

/**
 * Resolve the module set for a contract.
 *
 * @param {object} options
 * @param {Array<{name:string, version?:string, configuration?:object}>} options.bindings capability bindings
 * @param {Array<{id:string, range?:string, reason?:string}>} options.requestedModules explicit module requests
 * @param {object} options.availability declared deployment availability
 * @param {object} options.registry module registry (id → versions)
 */
export function resolveModules({
  bindings = [], requestedModules = [], availability = baselineDeploymentAvailability(),
  registry = MODULE_REGISTRY, allowExperimental = false,
} = {}) {
  const problems = [];
  const explanations = [];
  // 1. every request, with the ranges it imposes and why.
  const requests = new Map(); // id → { ranges: Set, reasons: Set }
  const request = (id, range, reason) => {
    if (!requests.has(id)) requests.set(id, { ranges: new Set(), reasons: new Set() });
    const entry = requests.get(id);
    if (range) entry.ranges.add(range);
    entry.reasons.add(reason);
  };
  request("thrallo.core", "^1.0.0", "runtime core");
  for (const binding of bindings) {
    const capabilityId = canonicalCapabilityId(binding?.name) || String(binding?.name || "");
    const manifest = moduleForCapability(capabilityId, registry);
    if (!manifest) {
      problems.push({ code: RESOLUTION_PROBLEMS.UNKNOWN_CAPABILITY, capability: capabilityId,
        message: `no module provides capability "${capabilityId}"` });
      continue;
    }
    const wanted = binding?.version ? `^${binding.version}` : `^${manifest.version}`;
    request(manifest.id, wanted, `capability:${capabilityId}`);
    explanations.push(`${capabilityId} → ${manifest.id} (${wanted})`);
  }
  for (const wanted of requestedModules) {
    if (!wanted?.id) continue;
    if (!registry[wanted.id]) {
      problems.push({ code: RESOLUTION_PROBLEMS.UNKNOWN_MODULE, module: wanted.id, message: `module ${wanted.id} is not registered` });
      continue;
    }
    request(wanted.id, wanted.range || null, wanted.reason || "requested");
  }

  // 2. expand dependencies to a fixpoint, choosing the highest version satisfying every range.
  const selected = new Map(); // id → manifest
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, entry] of [...requests.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const ranges = [...entry.ranges];
      const manifest = moduleManifest(id, ranges, registry);
      if (!manifest) {
        if (!problems.some((problem) => problem.code === RESOLUTION_PROBLEMS.RANGE_CONFLICT && problem.module === id)) {
          problems.push({ code: RESOLUTION_PROBLEMS.RANGE_CONFLICT, module: id, ranges,
            available: (registry[id] || []).map((row) => row.version),
            message: `no registered version of ${id} satisfies ${ranges.join(" and ")}` });
        }
        continue;
      }
      if (selected.get(id) !== manifest) { selected.set(id, manifest); changed = true; }
      for (const dependency of manifest.requires.modules || []) {
        const before = requests.get(dependency.id);
        const beforeSize = before ? before.ranges.size + before.reasons.size : -1;
        request(dependency.id, dependency.range, `required by ${id}`);
        const after = requests.get(dependency.id);
        if (after.ranges.size + after.reasons.size !== beforeSize) changed = true;
        if (!registry[dependency.id]) {
          problems.push({ code: RESOLUTION_PROBLEMS.UNKNOWN_MODULE, module: dependency.id,
            message: `${id} requires unregistered module ${dependency.id}` });
        }
      }
    }
  }

  const modules = sortById([...selected.values()]);

  // 3. conflicts: declared, capability ownership, deprecated/experimental status.
  const providers = new Map();
  for (const manifest of modules) {
    for (const conflict of manifest.conflicts || []) {
      const other = selected.get(conflict.module);
      if (other && (!conflict.range || satisfiesRange(other.version, conflict.range))) {
        problems.push({ code: RESOLUTION_PROBLEMS.DECLARED_CONFLICT, module: manifest.id, conflictsWith: other.id,
          message: `${manifest.id}@${manifest.version} conflicts with ${other.id}@${other.version}` });
      }
    }
    for (const capability of manifest.provides.capabilities || []) {
      const owner = providers.get(capability);
      if (owner && owner !== manifest.id) {
        problems.push({ code: RESOLUTION_PROBLEMS.CAPABILITY_OWNERSHIP, capability, modules: [owner, manifest.id].sort(),
          message: `capability ${capability} is claimed by both ${owner} and ${manifest.id}` });
      }
      providers.set(capability, manifest.id);
    }
    if (manifest.status === "deprecated") {
      problems.push({ code: RESOLUTION_PROBLEMS.DEPRECATED, module: manifest.id, message: `${manifest.id}@${manifest.version} is deprecated` });
    }
    if (manifest.status === "experimental" && !allowExperimental) {
      problems.push({ code: RESOLUTION_PROBLEMS.UNAVAILABLE, module: manifest.id, service: null,
        message: `${manifest.id}@${manifest.version} is experimental and not qualified for this build` });
    }
  }

  // 4. availability: a required service the deployment does not declare blocks the module.
  for (const manifest of modules) {
    for (const service of manifest.requires.services || []) {
      if (!serviceAvailable(availability, service)) {
        problems.push({ code: RESOLUTION_PROBLEMS.UNAVAILABLE, module: manifest.id, service,
          requestedBy: [...(requests.get(manifest.id)?.reasons || [])].sort(),
          message: `${manifest.id} requires deployment service "${service}", which this deployment does not provide`,
          configurationRequired: true });
      }
    }
  }

  // 5. stable dependency order (dependencies first, id tie-break), cycle detection.
  const order = [];
  const state = new Map();
  const visit = (id, trail) => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "active") {
      problems.push({ code: RESOLUTION_PROBLEMS.CYCLE, module: id, trail: [...trail, id],
        message: `module dependency cycle: ${[...trail, id].join(" → ")}` });
      return;
    }
    state.set(id, "active");
    const manifest = selected.get(id);
    for (const dependency of sortById(manifest?.requires?.modules || [])) {
      if (selected.has(dependency.id)) visit(dependency.id, [...trail, id]);
    }
    state.set(id, "done");
    order.push(id);
  };
  for (const manifest of modules) visit(manifest.id, []);

  return {
    version: MODULE_RESOLUTION_VERSION,
    ok: problems.length === 0,
    availability: { version: availability?.version ?? null, source: availability?.source ?? null },
    modules: order.map((id) => {
      const manifest = selected.get(id);
      return {
        id, version: manifest.version, status: manifest.status,
        provides: [...(manifest.provides.capabilities || [])],
        requires: (manifest.requires.modules || []).map((row) => row.id),
        services: [...(manifest.requires.services || [])],
        reasons: [...(requests.get(id)?.reasons || [])].sort(),
        legacyCapabilityId: manifest.legacyCapabilityId || null,
      };
    }),
    problems: problems.sort((a, b) => `${a.code}:${a.module || a.capability || ""}`.localeCompare(`${b.code}:${b.module || b.capability || ""}`)),
    explanations: explanations.sort(),
  };
}

/** The ids a resolution selected — the unit a lock records. */
export function resolvedModuleIds(resolution) {
  return (resolution?.modules || []).map((row) => row.id);
}

/** Problems that mean "configure the deployment", as opposed to "fix the contract". */
export function configurationRequiredProblems(resolution) {
  return (resolution?.problems || []).filter((problem) => problem.configurationRequired === true);
}
