export const USAGE_RESOURCE_KEYS = Object.freeze([
  "aiModel",
  "builds",
  "agents",
  "storage",
  "workspaceCompute",
  "browserTesting",
]);

export const USAGE_STATES = Object.freeze([
  "low",
  "normal",
  "warning_80",
  "warning_90",
  "exhausted",
  "unavailable",
]);

export function classifyUsage({ used, limit, available = true } = {}) {
  if (!available || !Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return "unavailable";
  const percent = (used / limit) * 100;
  if (percent >= 100) return "exhausted";
  if (percent >= 90) return "warning_90";
  if (percent >= 80) return "warning_80";
  if (percent <= 25) return "low";
  return "normal";
}

export function createUsageMeter({
  used = null,
  limit = null,
  unit = null,
  available = true,
  hardLimit = false,
  freshness = "fresh",
  observedAt = null,
  period = null,
} = {}) {
  if (!["fresh", "stale", "unavailable"].includes(freshness)) throw new TypeError(`Unknown usage freshness: ${freshness}`);
  const state = classifyUsage({ used, limit, available: available && freshness !== "unavailable" });
  const percent = state === "unavailable" ? null : Math.min(100, Math.max(0, (used / limit) * 100));
  return Object.freeze({
    state,
    used: state === "unavailable" ? null : used,
    limit: state === "unavailable" ? null : limit,
    remaining: state === "unavailable" ? null : Math.max(0, limit - used),
    percent,
    unit: unit || null,
    hardLimit: hardLimit === true,
    hardLimitReached: hardLimit === true && state === "exhausted",
    freshness,
    observedAt,
    period: Object.freeze({
      startsAt: period?.startsAt || null,
      endsAt: period?.endsAt || null,
      resetsAt: period?.resetsAt || null,
    }),
  });
}

export function createUsageBudgetModel({ resources = {}, freshness = "unavailable", observedAt = null } = {}) {
  if (!["fresh", "stale", "unavailable"].includes(freshness)) throw new TypeError(`Unknown usage freshness: ${freshness}`);
  const unknownKeys = Object.keys(resources).filter((key) => !USAGE_RESOURCE_KEYS.includes(key));
  if (unknownKeys.length) throw new TypeError(`Unknown usage resources: ${unknownKeys.join(", ")}`);
  const meters = Object.fromEntries(USAGE_RESOURCE_KEYS.map((key) => [
    key,
    resources[key]
      ? createUsageMeter({ ...resources[key], freshness: resources[key].freshness || freshness, observedAt: resources[key].observedAt || observedAt })
      : createUsageMeter({ available: false, freshness: "unavailable" }),
  ]));
  const warnings = Object.entries(meters)
    .filter(([, meter]) => ["warning_80", "warning_90", "exhausted"].includes(meter.state))
    .map(([resource, meter]) => Object.freeze({ resource, state: meter.state, percent: meter.percent, hardLimitReached: meter.hardLimitReached }));
  return Object.freeze({
    schemaVersion: "1.0",
    resources: Object.freeze(meters),
    warnings: Object.freeze(warnings),
    hardLimitReached: Object.values(meters).some((meter) => meter.hardLimitReached),
    freshness,
    observedAt,
  });
}

export function createUnavailableUsageBudgetModel() {
  return createUsageBudgetModel({ freshness: "unavailable" });
}
