export const DESKTOP_ACCESS_FIXTURE_CLOCK = "2032-05-06T10:00:00.000Z";
export const DESKTOP_ACCESS_FIXTURE_SEED = "thrallo-desktop-access-d3";

export const DESKTOP_ACCESS_SCENARIO_NAMES = Object.freeze([
  "signed-out-free",
  "authenticated-free",
  "authenticated-paid",
  "trial",
  "past-due",
  "canceled",
  "suspended",
  "recovery-only",
  "exhausted-ai-budget",
  "cloud-desktop-unavailable",
  "publishing-unavailable",
  "offline-cached",
  "entitlement-provider-failure",
  "stale-usage",
  "usage-low",
  "usage-warning-80",
  "usage-warning-90",
  "usage-unavailable",
  "entitlement-unknown",
  "future-cloud-eligible",
]);

export function assertDesktopAccessScenario(value) {
  if (!DESKTOP_ACCESS_SCENARIO_NAMES.includes(value)) throw new TypeError(`Unknown desktop access fixture scenario: ${value}`);
  return value;
}
