export const ENTITLEMENT_STATES = Object.freeze([
  "free",
  "active_paid",
  "trial",
  "past_due",
  "canceled",
  "suspended",
  "recovery_only",
  "unknown",
]);

export const ENTITLEMENT_RESOURCE_KEYS = Object.freeze([
  "managedAi",
  "cloudDesktop",
  "nativeManagedServices",
  "concurrentAgents",
  "builds",
  "previewTesting",
  "storage",
  "workspaceCompute",
  "publishing",
  "integrations",
]);

export const RESOURCE_AVAILABILITY = Object.freeze(["available", "unavailable", "unknown"]);

export function unknownResourceGrant(reason = "entitlement_unavailable") {
  return Object.freeze({
    availability: "unknown",
    reason,
    limit: Object.freeze({ kind: "unknown", value: null, unit: null }),
  });
}

export function createResourceGrant({ availability = "unknown", reason = null, limit = null } = {}) {
  if (!RESOURCE_AVAILABILITY.includes(availability)) throw new TypeError(`Unknown resource availability: ${availability}`);
  const normalizedLimit = !limit || limit.kind === "unknown"
    ? Object.freeze({ kind: "unknown", value: null, unit: null })
    : limit.kind === "unlimited"
      ? Object.freeze({ kind: "unlimited", value: null, unit: limit.unit || null })
      : limit.kind === "known" && Number.isFinite(limit.value) && limit.value >= 0
        ? Object.freeze({ kind: "known", value: limit.value, unit: limit.unit || null })
        : null;
  if (!normalizedLimit) throw new TypeError("Resource limit must be known, unlimited, or unknown");
  return Object.freeze({ availability, reason: reason || null, limit: normalizedLimit });
}

export function createEntitlementModel({ state = "unknown", resources = {}, freshness = "unavailable", observedAt = null, period = null } = {}) {
  if (!ENTITLEMENT_STATES.includes(state)) throw new TypeError(`Unknown entitlement state: ${state}`);
  if (!["fresh", "stale", "unavailable"].includes(freshness)) throw new TypeError(`Unknown entitlement freshness: ${freshness}`);
  const unknownKeys = Object.keys(resources).filter((key) => !ENTITLEMENT_RESOURCE_KEYS.includes(key));
  if (unknownKeys.length) throw new TypeError(`Unknown entitlement resources: ${unknownKeys.join(", ")}`);
  const normalized = Object.fromEntries(ENTITLEMENT_RESOURCE_KEYS.map((key) => [
    key,
    resources[key] ? createResourceGrant(resources[key]) : unknownResourceGrant(),
  ]));
  return Object.freeze({
    schemaVersion: "1.0",
    state,
    resources: Object.freeze(normalized),
    freshness,
    observedAt,
    period: Object.freeze({
      startsAt: period?.startsAt || null,
      endsAt: period?.endsAt || null,
      resetsAt: period?.resetsAt || null,
    }),
  });
}

export function createUnknownEntitlementModel(reason = "entitlement_unavailable") {
  return createEntitlementModel({
    state: "unknown",
    freshness: "unavailable",
    resources: Object.fromEntries(ENTITLEMENT_RESOURCE_KEYS.map((key) => [key, unknownResourceGrant(reason)])),
  });
}
