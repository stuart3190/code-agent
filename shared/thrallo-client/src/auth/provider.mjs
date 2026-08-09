import { CapabilityUnavailableError } from "../errors.mjs";

export const NATIVE_AUTH_PROVIDER_METHODS = Object.freeze([
  "beginAuthorization",
  "exchangeAuthorizationCode",
  "refreshDeviceSession",
  "revokeDeviceSession",
]);

export function assertNativeAuthProvider(provider) {
  if (!provider || typeof provider !== "object") throw new TypeError("Native auth provider must be an object");
  const missing = NATIVE_AUTH_PROVIDER_METHODS.filter((method) => typeof provider[method] !== "function");
  if (missing.length) throw new TypeError(`Native auth provider is missing: ${missing.join(", ")}`);
  return provider;
}

export function createUnavailableServerAuthProvider() {
  const unavailable = async () => { throw new CapabilityUnavailableError({ capability: "approvedServerAuthorization", operationId: "native-auth" }); };
  return Object.freeze({
    kind: "server-auth-boundary",
    capabilities: Object.freeze({ browserAuthorization: false, productionMutation: false }),
    beginAuthorization: unavailable,
    exchangeAuthorizationCode: unavailable,
    refreshDeviceSession: unavailable,
    revokeDeviceSession: unavailable,
  });
}
