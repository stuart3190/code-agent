import { createAccountPresentationModel } from "./account.mjs";
import { createUnknownEntitlementModel } from "./entitlements.mjs";
import { evaluateDesktopLaunchActions } from "./launch.mjs";
import { createUnavailableUsageBudgetModel } from "./usage.mjs";

const EFFECTIVE_CAPABILITIES = Object.freeze({
  localWorkspace: Object.freeze({ host: "localFilesystem", resource: null }),
  localTerminal: Object.freeze({ host: "localTerminal", resource: null }),
  localGit: Object.freeze({ host: "localGit", resource: null }),
  nativeManagedServices: Object.freeze({ host: "localFilesystem", resource: "nativeManagedServices" }),
  cloudWorkspace: Object.freeze({ host: "cloudWorkspace", resource: "cloudDesktop", usage: "workspaceCompute" }),
  managedAi: Object.freeze({ host: "managedBuild", resource: "managedAi", usage: "aiModel" }),
  builds: Object.freeze({ host: "managedBuild", resource: "builds", usage: "builds" }),
  previewTesting: Object.freeze({ host: "preview", resource: "previewTesting", usage: "browserTesting" }),
  publishing: Object.freeze({ host: "publishing", resource: "publishing" }),
  integrations: Object.freeze({ host: "integrations", resource: "integrations" }),
});

function unwrap(result) {
  if (!result) return null;
  if (result.ok === true) return result.data;
  if (result.ok === false) return null;
  return result;
}

function effectiveCapability(definition, hostCapabilities, entitlement, usage) {
  if (hostCapabilities[definition.host] !== true) {
    return Object.freeze({ availability: "unavailable", reason: `${definition.host}_unavailable`, hostCapability: definition.host, entitlementResource: definition.resource });
  }
  if (!definition.resource) {
    return Object.freeze({ availability: "available", reason: "host_capability_available", hostCapability: definition.host, entitlementResource: null });
  }
  if (entitlement.freshness !== "fresh" || entitlement.state === "unknown") {
    return Object.freeze({ availability: "unknown", reason: "entitlement_not_fresh", hostCapability: definition.host, entitlementResource: definition.resource });
  }
  const grant = entitlement.resources[definition.resource];
  const meter = definition.usage ? usage.resources[definition.usage] : null;
  if (meter?.hardLimitReached) {
    return Object.freeze({ availability: "unavailable", reason: `${definition.usage}_limit_reached`, hostCapability: definition.host, entitlementResource: definition.resource });
  }
  if (meter?.hardLimit && meter.freshness !== "fresh") {
    return Object.freeze({ availability: "unknown", reason: `${definition.usage}_usage_not_fresh`, hostCapability: definition.host, entitlementResource: definition.resource });
  }
  return Object.freeze({
    availability: grant?.availability || "unknown",
    reason: grant?.reason || (grant?.availability === "available" ? "entitled" : "entitlement_unavailable"),
    hostCapability: definition.host,
    entitlementResource: definition.resource,
  });
}

export function composeDesktopAccessState({ authSnapshot, hostCapabilities, accountResult, entitlementResult, usageResult } = {}) {
  if (!authSnapshot || !hostCapabilities) throw new TypeError("Desktop access composition requires D2 auth and D1 host capabilities");
  const accountData = unwrap(accountResult);
  const entitlement = unwrap(entitlementResult) || createUnknownEntitlementModel(entitlementResult?.code || "entitlement_unavailable");
  const usage = unwrap(usageResult) || createUnavailableUsageBudgetModel();
  const account = createAccountPresentationModel({
    authSnapshot,
    profile: accountData?.profile,
    device: accountData?.device,
    recovery: accountData?.recovery,
    observedAt: accountData?.observedAt || null,
    freshness: accountData?.freshness || "unavailable",
  });
  const capabilities = Object.freeze(Object.fromEntries(Object.entries(EFFECTIVE_CAPABILITIES).map(([key, definition]) => [
    key,
    effectiveCapability(definition, hostCapabilities, entitlement, usage),
  ])));
  const launchContext = { authSnapshot, hostCapabilities, entitlement, usage };
  return Object.freeze({
    schemaVersion: "1.0",
    account,
    entitlement,
    usage,
    capabilities,
    launchActions: evaluateDesktopLaunchActions(launchContext),
  });
}
