import { createAuthSnapshot } from "../../auth/states.mjs";
import { createHostCapabilities } from "../../capabilities.mjs";
import { redact } from "../../errors.mjs";
import { createEntitlementModel } from "../entitlements.mjs";
import { createPortalHandoff } from "../portalHandoff.mjs";
import { assertAccountAccessProvider } from "../provider.mjs";
import { createUsageBudgetModel } from "../usage.mjs";
import {
  DESKTOP_ACCESS_FIXTURE_CLOCK,
  DESKTOP_ACCESS_FIXTURE_SEED,
  DESKTOP_ACCESS_SCENARIO_NAMES,
  assertDesktopAccessScenario,
} from "./scenarios.mjs";

const PERIOD = Object.freeze({
  startsAt: "2032-05-01T00:00:00.000Z",
  endsAt: "2032-06-01T00:00:00.000Z",
  resetsAt: "2032-06-01T00:00:00.000Z",
});

function grant(availability, reason = null) {
  return Object.freeze({ availability, reason, limit: Object.freeze({ kind: "unknown" }) });
}

function resourcesFor(state, overrides = {}) {
  const available = grant("available");
  const notIncluded = grant("unavailable", "not_included");
  const unavailable = grant("unavailable", `${state}_restricted`);
  const unknown = grant("unknown", "entitlement_unavailable");
  let resources;
  if (["active_paid", "trial"].includes(state)) {
    resources = {
      managedAi: available,
      cloudDesktop: available,
      nativeManagedServices: available,
      concurrentAgents: available,
      builds: available,
      previewTesting: available,
      storage: available,
      workspaceCompute: available,
      publishing: available,
      integrations: available,
    };
  } else if (["free", "past_due"].includes(state)) {
    resources = {
      managedAi: available,
      cloudDesktop: notIncluded,
      nativeManagedServices: available,
      concurrentAgents: available,
      builds: available,
      previewTesting: available,
      storage: available,
      workspaceCompute: available,
      publishing: notIncluded,
      integrations: available,
    };
  } else if (["canceled", "suspended", "recovery_only"].includes(state)) {
    resources = Object.fromEntries([
      "managedAi", "cloudDesktop", "nativeManagedServices", "concurrentAgents", "builds",
      "previewTesting", "storage", "workspaceCompute", "publishing", "integrations",
    ].map((key) => [key, unavailable]));
  } else {
    resources = Object.fromEntries([
      "managedAi", "cloudDesktop", "nativeManagedServices", "concurrentAgents", "builds",
      "previewTesting", "storage", "workspaceCompute", "publishing", "integrations",
    ].map((key) => [key, unknown]));
  }
  return { ...resources, ...overrides };
}

function usageResources(percent, { freshness = "fresh", exhaustedAi = false, available = true } = {}) {
  const meter = (unit, hardLimit = false, meterPercent = percent) => available
    ? { used: meterPercent, limit: 100, unit, hardLimit, freshness, period: PERIOD }
    : { available: false, freshness: "unavailable", unit };
  return {
    aiModel: meter("fixture_ai_units", exhaustedAi, exhaustedAi ? 100 : percent),
    builds: meter("fixture_build_units", true, exhaustedAi ? 42 : percent),
    agents: meter("fixture_agent_units", false, exhaustedAi ? 42 : percent),
    storage: { available: false, freshness: "unavailable", unit: "bytes" },
    workspaceCompute: meter("fixture_compute_units", true, exhaustedAi ? 42 : percent),
    browserTesting: meter("fixture_test_units", true, exhaustedAi ? 42 : percent),
  };
}

function scenarioDefinition(name) {
  const base = {
    authState: "authenticated",
    entitlementState: "active_paid",
    accountFreshness: "fresh",
    entitlementFreshness: "fresh",
    usageFreshness: "fresh",
    usagePercent: 42,
    recoveryState: "none",
    hostOverrides: {
      localFilesystem: true,
      localTerminal: true,
      localGit: true,
      managedBuild: true,
      preview: true,
      publishing: true,
      integrations: true,
      nativeKeychain: true,
    },
    resourceOverrides: {},
  };
  const variants = {
    "signed-out-free": { authState: "signed_out", entitlementState: "free" },
    "authenticated-free": { entitlementState: "free" },
    "authenticated-paid": {},
    trial: { entitlementState: "trial" },
    "past-due": { entitlementState: "past_due", recoveryState: "billing_recovery_required" },
    canceled: { entitlementState: "canceled" },
    suspended: { entitlementState: "suspended", recoveryState: "workspace_recovery_required" },
    "recovery-only": { entitlementState: "recovery_only", recoveryState: "multiple" },
    "exhausted-ai-budget": { usagePercent: 100, exhaustedAi: true },
    "cloud-desktop-unavailable": { resourceOverrides: { cloudDesktop: grant("unavailable", "cloud_desktop_not_included") } },
    "publishing-unavailable": { resourceOverrides: { publishing: grant("unavailable", "publishing_not_included") } },
    "offline-cached": { authState: "offline", accountFreshness: "stale", entitlementFreshness: "stale", usageFreshness: "stale" },
    "entitlement-provider-failure": { entitlementFailure: true },
    "stale-usage": { usageFreshness: "stale" },
    "usage-low": { usagePercent: 10 },
    "usage-warning-80": { usagePercent: 80 },
    "usage-warning-90": { usagePercent: 90 },
    "usage-unavailable": { usageAvailable: false, usageFreshness: "unavailable" },
    "entitlement-unknown": { entitlementState: "unknown", entitlementFreshness: "unavailable" },
    "future-cloud-eligible": { hostOverrides: { ...base.hostOverrides, cloudWorkspace: true } },
  };
  return Object.freeze({ ...base, ...variants[name] });
}

function result(data, sequence, observedAt) {
  return Object.freeze({ ok: true, requestId: `fixture-access-${String(sequence).padStart(4, "0")}`, data, observedAt, source: "fixture", revision: `fixture-${sequence}` });
}

function failure(code, sequence) {
  return Object.freeze({ ok: false, requestId: `fixture-access-${String(sequence).padStart(4, "0")}`, code, message: "Deterministic account-access data is unavailable.", retryable: false, details: null });
}

export function createDesktopAccessFixture({ scenario = "authenticated-paid", seed = DESKTOP_ACCESS_FIXTURE_SEED } = {}) {
  assertDesktopAccessScenario(scenario);
  const definition = scenarioDefinition(scenario);
  const observedAt = definition.accountFreshness === "stale" || definition.usageFreshness === "stale"
    ? "2032-04-01T10:00:00.000Z"
    : DESKTOP_ACCESS_FIXTURE_CLOCK;
  const authSnapshot = createAuthSnapshot({
    state: definition.authState,
    method: definition.authState === "signed_out" ? null : "native_browser_pkce",
    accountId: definition.authState === "signed_out" ? null : "fixture-account-alpha",
    deviceId: "fixture-device-windows",
    expiresAt: definition.authState === "signed_out" ? null : Date.parse("2032-05-06T10:30:00.000Z"),
  });
  const accountData = Object.freeze({
    profile: definition.authState === "signed_out" ? null : Object.freeze({ displayName: "Fixture Developer", emailLabel: "fixture.user@example.invalid", avatarLabel: "FD" }),
    device: Object.freeze({ label: "This Windows desktop", platform: "windows", otherActiveSessions: 1 }),
    recovery: Object.freeze({ state: definition.recoveryState, reason: definition.recoveryState === "none" ? null : "Fixture recovery state" }),
    freshness: definition.accountFreshness,
    observedAt,
  });
  const entitlementData = createEntitlementModel({
    state: definition.entitlementState,
    resources: resourcesFor(definition.entitlementState, definition.resourceOverrides),
    freshness: definition.entitlementFreshness,
    observedAt,
    period: PERIOD,
  });
  const usageData = createUsageBudgetModel({
    resources: usageResources(definition.usagePercent, {
      freshness: definition.usageFreshness,
      exhaustedAi: definition.exhaustedAi,
      available: definition.usageAvailable !== false,
    }),
    freshness: definition.usageFreshness,
    observedAt,
  });
  const hostCapabilities = createHostCapabilities(definition.hostOverrides);
  const calls = [];
  let callSequence = 0;
  function call(operation, producer) {
    return async () => {
      callSequence += 1;
      calls.push(Object.freeze({ sequence: callSequence, operation, seed, scenario, observedAt }));
      return producer(callSequence);
    };
  }
  const provider = Object.freeze(assertAccountAccessProvider({
    kind: "deterministic-account-access",
    capabilities: Object.freeze({ readOnly: true, productionMutation: false }),
    getAccount: call("getAccount", (sequence) => result(accountData, sequence, observedAt)),
    getEntitlements: call("getEntitlements", (sequence) => definition.entitlementFailure
      ? failure("entitlement_unavailable", sequence)
      : result(entitlementData, sequence, observedAt)),
    getUsage: call("getUsage", (sequence) => result(usageData, sequence, observedAt)),
  }));
  const opened = [];
  const portal = createPortalHandoff({
    openExternal: async (value) => {
      const parsed = new URL(value);
      opened.push(Object.freeze({ origin: parsed.origin, pathname: parsed.pathname }));
    },
  });
  return Object.freeze({
    schemaVersion: "1.0",
    source: "fixture",
    seed,
    scenario,
    authSnapshot,
    hostCapabilities,
    provider,
    portal,
    getCalls: () => Object.freeze(calls.map((entry) => redact(entry))),
    getPortalOpens: () => Object.freeze(opened.map((entry) => Object.freeze({ ...entry }))),
  });
}

export {
  DESKTOP_ACCESS_FIXTURE_CLOCK,
  DESKTOP_ACCESS_FIXTURE_SEED,
  DESKTOP_ACCESS_SCENARIO_NAMES,
};
