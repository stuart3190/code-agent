import { capabilityUnavailableResult } from "../capabilities.mjs";

export const ACCOUNT_ACCESS_OPERATIONS = Object.freeze(["getAccount", "getEntitlements", "getUsage"]);

export function assertAccountAccessProvider(provider) {
  if (!provider || typeof provider !== "object") throw new TypeError("Account access provider must be an object");
  const missing = ACCOUNT_ACCESS_OPERATIONS.filter((operation) => typeof provider[operation] !== "function");
  if (missing.length) throw new TypeError(`Account access provider is missing: ${missing.join(", ")}`);
  return provider;
}

export function createStableReadOnlyAccountAccessProvider({ transport, routeMap = {} } = {}) {
  if (!transport || typeof transport.request !== "function") throw new TypeError("Account access adapter requires an injected transport");
  const unknown = Object.keys(routeMap).filter((key) => !ACCOUNT_ACCESS_OPERATIONS.includes(key));
  if (unknown.length) throw new TypeError(`Unknown account access routes: ${unknown.join(", ")}`);
  for (const [operation, route] of Object.entries(routeMap)) {
    if (!route?.path || typeof route.path !== "string" || !route.path.startsWith("/") || route.path.startsWith("//")
      || route.path.includes("\\") || route.path.includes("://") || route.path.includes("?") || route.path.includes("#")) {
      throw new TypeError(`${operation} requires an explicit origin-relative path`);
    }
    const method = String(route.method || "GET").toUpperCase();
    if (!["GET", "HEAD"].includes(method)) throw new TypeError(`Read-only account adapter refuses ${method} for ${operation}`);
    if (route.map != null && typeof route.map !== "function") throw new TypeError(`${operation} map must be a function`);
  }

  const provider = { kind: "stable-read-only-account-access", capabilities: Object.freeze({ readOnly: true, productionMutation: false }) };
  for (const operation of ACCOUNT_ACCESS_OPERATIONS) {
    const route = routeMap[operation];
    provider[operation] = route ? async (input = {}) => {
      const result = await transport.request({
        method: route.method || "GET",
        path: route.path,
        signal: input.signal,
        operationId: `desktop-account-access.${operation}`,
      });
      if (!route.map || result.ok !== true) return result;
      return Object.freeze({ ...result, data: route.map(result.data) });
    } : async () => capabilityUnavailableResult({ capability: "stableReadOnlyAccountAccess", operationId: operation });
  }
  return Object.freeze(assertAccountAccessProvider(provider));
}
