// Module manifest schema (audit §6.1).
//
// A module is a logical, versioned capability boundary: what it provides, what it requires, the
// artefacts it protects, the operations it owns and how each is verified. The registry validates
// every manifest with this file before it can be resolved, and the lock records the exact
// version and artefact hashes a snapshot was built from. Nothing about a manifest is prose the
// model reads; it is data the compiler checks.

import { parseVersion, satisfiesRange } from "./semver.mjs";

export const MANIFEST_SCHEMA_VERSION = 1;

export const MODULE_STATUSES = Object.freeze(["experimental", "qualified", "deprecated"]);
export const OPERATION_EXECUTIONS = Object.freeze(["client", "server"]);
export const OPERATION_EFFECTS = Object.freeze(["query", "mutation", "session", "artifact", "external"]);
export const OPERATION_IDEMPOTENCY = Object.freeze(["none", "required", "supported"]);
export const OPERATION_CONCURRENCY = Object.freeze(["versioned", "transactional"]);
export const MODULE_ID = /^thrallo\.[a-zA-Z][a-zA-Z0-9]*$/;
export const OPERATION_ID = /^[a-zA-Z][a-zA-Z0-9_]*$/;

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
const isSchema = (value) => isObject(value) && typeof value.type === "string";

/** Validate one OperationDefinition. Returns problems prefixed with the operation id. */
export function validateOperationDefinition(operation, { prefix = "" } = {}) {
  const problems = [];
  const label = `${prefix}operation ${operation?.id || "<unnamed>"}`;
  if (!isObject(operation)) return [`${prefix}operation must be an object`];
  if (typeof operation.id !== "string" || !OPERATION_ID.test(operation.id)) problems.push(`${label}: invalid id`);
  if (!isSchema(operation.input)) problems.push(`${label}: input must be a JSON schema object`);
  if (!isSchema(operation.output)) problems.push(`${label}: output must be a JSON schema object`);
  if (!OPERATION_EXECUTIONS.includes(operation.execution)) problems.push(`${label}: execution must be client|server`);
  if (!OPERATION_EFFECTS.includes(operation.effect)) problems.push(`${label}: effect must be one of ${OPERATION_EFFECTS.join("|")}`);
  if (typeof operation.stateOwner !== "string" || !operation.stateOwner) problems.push(`${label}: stateOwner required`);
  if (operation.authorization !== undefined && operation.authorization !== null && typeof operation.authorization !== "string") {
    problems.push(`${label}: authorization must be a policy reference string`);
  }
  if (!OPERATION_IDEMPOTENCY.includes(operation.idempotency)) problems.push(`${label}: idempotency must be none|required|supported`);
  if (operation.concurrency !== undefined && operation.concurrency !== null && !OPERATION_CONCURRENCY.includes(operation.concurrency)) {
    problems.push(`${label}: concurrency must be versioned|transactional`);
  }
  if (!isStringArray(operation.errors ?? [])) problems.push(`${label}: errors must be a string list`);
  if (!isStringArray(operation.verificationHooks ?? [])) problems.push(`${label}: verificationHooks must be a string list`);
  if (operation.effect === "mutation" && operation.execution === "server" && !operation.authorization) {
    problems.push(`${label}: a server mutation must name its authorization policy`);
  }
  return problems;
}

/** Validate a complete ModuleManifest. Never throws; the registry decides what to do. */
export function validateModuleManifest(manifest) {
  const problems = [];
  if (!isObject(manifest)) return { ok: false, problems: ["manifest must be an object"] };
  const prefix = `${manifest.id || "<unnamed>"}: `;
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) problems.push(`${prefix}schemaVersion must be ${MANIFEST_SCHEMA_VERSION}`);
  if (typeof manifest.id !== "string" || !MODULE_ID.test(manifest.id)) problems.push(`${prefix}id must match ${MODULE_ID}`);
  if (!parseVersion(manifest.version)) problems.push(`${prefix}version must be semantic`);
  if (!MODULE_STATUSES.includes(manifest.status)) problems.push(`${prefix}status must be experimental|qualified|deprecated`);

  const compatibility = manifest.compatibility;
  if (!isObject(compatibility)) problems.push(`${prefix}compatibility required`);
  else {
    if (!Array.isArray(compatibility.contractVersions) || !compatibility.contractVersions.every(Number.isInteger)
      || !compatibility.contractVersions.length) problems.push(`${prefix}compatibility.contractVersions must list integer contract versions`);
    if (typeof compatibility.clientAbi !== "string" && compatibility.clientAbi !== null) problems.push(`${prefix}compatibility.clientAbi must be a string or null`);
    if (typeof compatibility.serverAbi !== "string" && compatibility.serverAbi !== null) problems.push(`${prefix}compatibility.serverAbi must be a string or null`);
    if (typeof compatibility.runtimeRange !== "string") problems.push(`${prefix}compatibility.runtimeRange must be a range string`);
    else { try { satisfiesRange("1.0.0", compatibility.runtimeRange); } catch { problems.push(`${prefix}compatibility.runtimeRange is not a valid range`); } }
  }

  const requires = manifest.requires;
  if (!isObject(requires)) problems.push(`${prefix}requires required`);
  else {
    if (!Array.isArray(requires.modules)) problems.push(`${prefix}requires.modules must be a list`);
    else for (const dependency of requires.modules) {
      if (!isObject(dependency) || typeof dependency.id !== "string" || !MODULE_ID.test(dependency.id)) {
        problems.push(`${prefix}requires.modules entries need a module id`); continue;
      }
      if (typeof dependency.range !== "string") problems.push(`${prefix}requires.modules ${dependency.id} needs a range`);
      else { try { satisfiesRange("1.0.0", dependency.range); } catch { problems.push(`${prefix}requires.modules ${dependency.id} range is invalid`); } }
      if (dependency.id === manifest.id) problems.push(`${prefix}a module cannot require itself`);
    }
    if (!isStringArray(requires.capabilities ?? [])) problems.push(`${prefix}requires.capabilities must be a string list`);
    if (!isStringArray(requires.services ?? [])) problems.push(`${prefix}requires.services must be a string list`);
  }

  const provides = manifest.provides;
  if (!isObject(provides)) problems.push(`${prefix}provides required`);
  else {
    if (!isStringArray(provides.capabilities ?? [])) problems.push(`${prefix}provides.capabilities must be a string list`);
    if (!Array.isArray(provides.operations)) problems.push(`${prefix}provides.operations must be a list`);
    else {
      const ids = new Set();
      for (const operation of provides.operations) {
        problems.push(...validateOperationDefinition(operation, { prefix }));
        if (operation?.id) {
          if (ids.has(operation.id)) problems.push(`${prefix}duplicate operation ${operation.id}`);
          ids.add(operation.id);
        }
      }
    }
  }

  if (!Array.isArray(manifest.conflicts)) problems.push(`${prefix}conflicts must be a list`);
  else for (const conflict of manifest.conflicts) {
    if (!isObject(conflict) || typeof conflict.module !== "string") problems.push(`${prefix}conflict entries name a module`);
    else if (conflict.range !== undefined) { try { satisfiesRange("1.0.0", conflict.range); } catch { problems.push(`${prefix}conflict ${conflict.module} range is invalid`); } }
  }
  if (!isSchema(manifest.configSchema)) problems.push(`${prefix}configSchema must be a JSON schema object`);
  for (const key of ["entityContributions", "routeContributions", "surfaceBindings", "permissions", "migrations"]) {
    if (!Array.isArray(manifest[key])) problems.push(`${prefix}${key} must be a list`);
  }

  const runtime = manifest.runtime;
  if (!isObject(runtime)) problems.push(`${prefix}runtime required`);
  else {
    for (const key of ["clientEntrypoints", "serverHandlers", "protectedArtifacts", "packageDependencies"]) {
      if (!Array.isArray(runtime[key])) problems.push(`${prefix}runtime.${key} must be a list`);
    }
    for (const artifact of runtime.protectedArtifacts || []) {
      if (!isObject(artifact) || typeof artifact.path !== "string" || !artifact.path.startsWith("src/")) {
        problems.push(`${prefix}protected artefacts are src/ paths`);
      }
    }
    for (const entry of runtime.clientEntrypoints || []) {
      if (!isObject(entry) || typeof entry.module !== "string" || !isStringArray(entry.exports)) {
        problems.push(`${prefix}client entrypoints name a module and its exports`);
      }
    }
    for (const dependency of runtime.packageDependencies || []) {
      if (!isObject(dependency) || typeof dependency.package !== "string" || !parseVersion(dependency.version)) {
        problems.push(`${prefix}package dependencies are pinned to exact versions`);
      }
    }
  }

  const lifecycle = manifest.lifecycle;
  if (!isObject(lifecycle) || typeof lifecycle.install !== "string" || typeof lifecycle.uninstall !== "string") {
    problems.push(`${prefix}lifecycle needs install and uninstall strategies`);
  } else if (lifecycle.uninstall !== "retain_data") {
    problems.push(`${prefix}removing a module never implicitly deletes its data (uninstall must be retain_data)`);
  }
  const verification = manifest.verification;
  if (!isObject(verification) || !isStringArray(verification.deterministicTests ?? []) || !isStringArray(verification.browserEvidence ?? [])) {
    problems.push(`${prefix}verification needs deterministicTests and browserEvidence lists`);
  }
  if (manifest.status === "qualified" && !isObject(manifest.qualification)) {
    problems.push(`${prefix}a qualified module records its qualification basis`);
  }
  return { ok: problems.length === 0, problems };
}

/** Freeze a manifest after validation; throws on an invalid one so a bad module never registers. */
export function defineModule(manifest) {
  const verdict = validateModuleManifest(manifest);
  if (!verdict.ok) throw new Error(`invalid module manifest: ${verdict.problems.join("; ")}`);
  return deepFreeze(manifest);
}

export function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** The public shape of an operation for prompts and static checks: no implementation detail. */
export function operationSignature(manifest, operationId) {
  const operation = (manifest?.provides?.operations || []).find((row) => row.id === operationId);
  if (!operation) return null;
  return {
    module: manifest.id, id: operation.id, execution: operation.execution, effect: operation.effect,
    input: operation.input, output: operation.output, errors: operation.errors || [],
    idempotency: operation.idempotency, concurrency: operation.concurrency || null,
  };
}
