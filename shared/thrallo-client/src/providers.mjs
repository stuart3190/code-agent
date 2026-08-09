import { capabilityUnavailableResult } from "./capabilities.mjs";
import { PROVIDER_FAMILIES, assertProviderConformance } from "./contracts.mjs";
import { consumeEventStream } from "./eventStream.mjs";

async function* unavailableStream(result) {
  yield Object.freeze({
    id: null,
    type: "capability_unavailable",
    data: Object.freeze({ ...result, terminal: true }),
    retry: null,
    cursor: null,
  });
}

export function createStableReadOnlyProvider({ providerKey, transport, operationMap = {} } = {}) {
  const definition = PROVIDER_FAMILIES[providerKey];
  if (!definition) throw new TypeError(`Unknown Thrallo provider family: ${providerKey}`);
  if (!transport?.request || !transport?.openEventStream) throw new TypeError("Read-only provider requires an explicit transport");

  for (const [operationId, route] of Object.entries(operationMap)) {
    if (!definition.operations[operationId]) throw new TypeError(`Unknown ${providerKey} operation: ${operationId}`);
    if (definition.operations[operationId] === "mutation") throw new TypeError(`Read-only adapter cannot map mutation ${operationId}`);
    if (!route?.path) throw new TypeError(`${operationId} requires an explicit path`);
    if (route.method && !["GET", "HEAD"].includes(route.method.toUpperCase())) {
      throw new TypeError(`Read-only adapter refuses ${route.method} for ${operationId}`);
    }
  }

  const provider = {};
  for (const [operationId, kind] of Object.entries(definition.operations)) {
    if (kind === "mutation") {
      provider[operationId] = async () => capabilityUnavailableResult({
        capability: "stableReadOnly",
        operationId: `${definition.id}.${operationId}`,
      });
      continue;
    }
    const route = operationMap[operationId];
    if (!route) {
      provider[operationId] = kind === "stream"
        ? () => unavailableStream(capabilityUnavailableResult({ capability: "stableReadOnly", operationId: `${definition.id}.${operationId}` }))
        : async () => capabilityUnavailableResult({ capability: "stableReadOnly", operationId: `${definition.id}.${operationId}` });
      continue;
    }
    if (kind === "read") {
      provider[operationId] = async (input = {}) => transport.request({
        method: route.method || "GET",
        path: typeof route.path === "function" ? route.path(input) : route.path,
        headers: route.headers,
        signal: input.signal,
        operationId: `${definition.id}.${operationId}`,
      });
    } else {
      provider[operationId] = (input = {}) => consumeEventStream({
        initialCursor: input.cursor || null,
        signal: input.signal,
        connect: ({ cursor, signal }) => transport.openEventStream({
          path: typeof route.path === "function" ? route.path(input) : route.path,
          cursor,
          headers: route.headers,
          signal,
          operationId: `${definition.id}.${operationId}`,
        }),
      });
    }
  }
  return Object.freeze(assertProviderConformance(providerKey, provider));
}
