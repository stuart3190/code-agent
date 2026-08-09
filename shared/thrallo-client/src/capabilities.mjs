import { CapabilityUnavailableError } from "./errors.mjs";

export const HOST_CAPABILITY_KEYS = Object.freeze([
  "localFilesystem",
  "localTerminal",
  "localGit",
  "cloudWorkspace",
  "managedBuild",
  "builderV2Mutation",
  "preview",
  "browserDiagnostics",
  "publishing",
  "integrations",
  "nativeKeychain",
  "nativeUpdates",
]);

export function createHostCapabilities(overrides = {}) {
  const unknown = Object.keys(overrides).filter((key) => !HOST_CAPABILITY_KEYS.includes(key));
  if (unknown.length) throw new TypeError(`Unknown host capabilities: ${unknown.join(", ")}`);
  return Object.freeze(Object.fromEntries(HOST_CAPABILITY_KEYS.map((key) => [key, overrides[key] === true])));
}

export function negotiateCapabilities(offered, required = []) {
  const normalized = createHostCapabilities(offered);
  const unknown = required.filter((key) => !HOST_CAPABILITY_KEYS.includes(key));
  if (unknown.length) throw new TypeError(`Unknown required capabilities: ${unknown.join(", ")}`);
  const missing = required.filter((key) => normalized[key] !== true);
  return Object.freeze({
    compatible: missing.length === 0,
    required: Object.freeze([...required]),
    missing: Object.freeze(missing),
    offered: normalized,
  });
}

export function requireCapability(capabilities, capability, context = {}) {
  const result = negotiateCapabilities(capabilities, [capability]);
  if (!result.compatible) throw new CapabilityUnavailableError({ capability, ...context });
  return true;
}

export function capabilityUnavailableResult({ capability, operationId, requestId = null, message = null } = {}) {
  return Object.freeze({
    ok: false,
    requestId,
    code: "capability_unavailable",
    message: message || `${operationId || "operation"} requires unavailable capability ${capability || "unknown"}.`,
    retryable: false,
    details: Object.freeze({ capability: capability || null, operationId: operationId || null }),
  });
}
