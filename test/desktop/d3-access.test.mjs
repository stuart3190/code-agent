import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DESKTOP_ACCESS_SCENARIO_NAMES,
  ENTITLEMENT_RESOURCE_KEYS,
  ENTITLEMENT_STATES,
  PORTAL_DESTINATIONS,
  USAGE_STATES,
  assertAccountAccessProvider,
  classifyUsage,
  composeDesktopAccessState,
  createAuthSnapshot,
  createDesktopAccessFixture,
  createDevelopmentCredentialVault,
  createDeterministicAuthProvider,
  createEntitlementModel,
  createFixtureProviderSuite,
  createHostCapabilities,
  createNativeAuthController,
  createPortalHandoff,
  createStableReadOnlyAccountAccessProvider,
  createUsageBudgetModel,
  redact,
} from "../../shared/thrallo-client/src/index.mjs";
import { createDesktopAccessPresentation, renderDesktopAccessHtml } from "../../desktop/account/presentation.mjs";
import { forbiddenReferences, runGuard } from "../../desktop/d0/guard.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function loadScenario(scenario, seed = "d3-test-seed") {
  const fixture = createDesktopAccessFixture({ scenario, seed });
  const [accountResult, entitlementResult, usageResult] = await Promise.all([
    fixture.provider.getAccount(),
    fixture.provider.getEntitlements(),
    fixture.provider.getUsage(),
  ]);
  const state = composeDesktopAccessState({
    authSnapshot: fixture.authSnapshot,
    hostCapabilities: fixture.hostCapabilities,
    accountResult,
    entitlementResult,
    usageResult,
  });
  return { fixture, accountResult, entitlementResult, usageResult, state };
}

test("account presentation exposes the current user and device without owner-resource identifiers", async () => {
  const { state } = await loadScenario("authenticated-paid");
  assert.deepEqual(state.account.identity, {
    subject: "current_account",
    displayName: "Fixture Developer",
    emailLabel: "fixture.user@example.invalid",
    avatarLabel: "FD",
  });
  assert.equal(state.account.session.state, "authenticated");
  assert.equal(state.account.session.deviceLabel, "This Windows desktop");
  assert.deepEqual(state.account.session.otherActiveSessions, { state: "known", value: 1 });
  assert.doesNotMatch(JSON.stringify(state.account), /fixture-account-alpha|ownerId|owner_id/);
});

test("all explicit entitlement states normalize resource grants without plan-name UI logic", async () => {
  const scenarios = {
    free: "authenticated-free",
    active_paid: "authenticated-paid",
    trial: "trial",
    past_due: "past-due",
    canceled: "canceled",
    suspended: "suspended",
    recovery_only: "recovery-only",
    unknown: "entitlement-unknown",
  };
  assert.deepEqual(Object.keys(scenarios), ENTITLEMENT_STATES);
  for (const [expected, scenario] of Object.entries(scenarios)) {
    const { state } = await loadScenario(scenario);
    assert.equal(state.entitlement.state, expected);
    assert.deepEqual(Object.keys(state.entitlement.resources), ENTITLEMENT_RESOURCE_KEYS);
    for (const grant of Object.values(state.entitlement.resources)) {
      assert.ok(["available", "unavailable", "unknown"].includes(grant.availability));
      assert.ok(["known", "unlimited", "unknown"].includes(grant.limit.kind));
    }
  }
});

test("usage thresholds distinguish low, normal, 80, 90, exhausted, and unavailable", () => {
  assert.equal(classifyUsage({ used: 10, limit: 100 }), "low");
  assert.equal(classifyUsage({ used: 42, limit: 100 }), "normal");
  assert.equal(classifyUsage({ used: 80, limit: 100 }), "warning_80");
  assert.equal(classifyUsage({ used: 90, limit: 100 }), "warning_90");
  assert.equal(classifyUsage({ used: 100, limit: 100 }), "exhausted");
  assert.equal(classifyUsage({ available: false }), "unavailable");
  assert.deepEqual(USAGE_STATES, ["low", "normal", "warning_80", "warning_90", "exhausted", "unavailable"]);
});

test("deterministic usage scenarios carry warnings, hard limits, freshness, and period metadata", async () => {
  const expected = {
    "usage-low": "low",
    "authenticated-paid": "normal",
    "usage-warning-80": "warning_80",
    "usage-warning-90": "warning_90",
    "exhausted-ai-budget": "exhausted",
    "usage-unavailable": "unavailable",
  };
  for (const [scenario, stateName] of Object.entries(expected)) {
    const { state } = await loadScenario(scenario);
    assert.equal(state.usage.resources.aiModel.state, stateName);
  }
  const exhausted = (await loadScenario("exhausted-ai-budget")).state;
  assert.equal(exhausted.usage.resources.aiModel.hardLimitReached, true);
  assert.equal(exhausted.usage.resources.builds.state, "normal");
  assert.equal(exhausted.usage.hardLimitReached, true);
  assert.equal(exhausted.capabilities.managedAi.availability, "unavailable");
  assert.equal(exhausted.usage.resources.aiModel.period.resetsAt, "2032-06-01T00:00:00.000Z");
});

test("D3 fixture catalogue includes every required account, recovery, capability, and stale scenario", () => {
  for (const required of [
    "signed-out-free", "authenticated-free", "authenticated-paid", "past-due", "canceled",
    "suspended", "recovery-only", "exhausted-ai-budget", "cloud-desktop-unavailable",
    "publishing-unavailable", "offline-cached", "entitlement-provider-failure", "stale-usage",
  ]) assert.ok(DESKTOP_ACCESS_SCENARIO_NAMES.includes(required), required);
});

test("D1 host capabilities and D3 entitlements compose into one access layer", async () => {
  const paid = (await loadScenario("authenticated-paid")).state;
  assert.equal(paid.capabilities.localWorkspace.availability, "available");
  assert.equal(paid.capabilities.localTerminal.availability, "available");
  assert.equal(paid.capabilities.localGit.availability, "available");
  assert.equal(paid.capabilities.nativeManagedServices.availability, "available");
  assert.equal(paid.capabilities.cloudWorkspace.availability, "unavailable");
  assert.equal(paid.capabilities.publishing.availability, "available");

  const unavailable = (await loadScenario("publishing-unavailable")).state;
  assert.equal(unavailable.capabilities.publishing.availability, "unavailable");
  assert.equal(unavailable.capabilities.publishing.reason, "publishing_not_included");
});

test("launch decisions allow local work but centrally gate managed and cloud actions", async () => {
  const signedOut = (await loadScenario("signed-out-free")).state;
  assert.equal(signedOut.launchActions.open_local_workspace.state, "allowed");
  assert.equal(signedOut.launchActions.open_installed_desktop_project.state, "blocked_auth");

  const paid = (await loadScenario("authenticated-paid")).state;
  assert.equal(paid.launchActions.open_installed_desktop_project.state, "allowed");
  assert.equal(paid.launchActions.open_cloud_workspace.state, "capability_unavailable");
  assert.equal(paid.launchActions.manage_subscription.state, "requires_portal");

  const eligibleFixture = await loadScenario("future-cloud-eligible");
  assert.equal(eligibleFixture.state.launchActions.open_cloud_workspace.state, "allowed");
  assert.equal(eligibleFixture.fixture.source, "fixture");

  const notIncluded = (await loadScenario("cloud-desktop-unavailable")).state;
  assert.equal(notIncluded.launchActions.open_cloud_workspace.state, "capability_unavailable");
  const withCloudHost = composeDesktopAccessState({
    authSnapshot: eligibleFixture.fixture.authSnapshot,
    hostCapabilities: eligibleFixture.fixture.hostCapabilities,
    accountResult: eligibleFixture.accountResult,
    entitlementResult: (await loadScenario("cloud-desktop-unavailable")).entitlementResult,
    usageResult: eligibleFixture.usageResult,
  });
  assert.equal(withCloudHost.launchActions.open_cloud_workspace.state, "blocked_entitlement");
});

test("D2 expired authentication requires reauthentication before managed launch", async () => {
  const paid = await loadScenario("authenticated-paid");
  const expired = createAuthSnapshot({
    state: "expired",
    method: "native_browser_pkce",
    accountId: "fixture-account-alpha",
    deviceId: "fixture-device-windows",
    expiresAt: Date.parse("2032-05-01T00:00:00.000Z"),
  });
  const state = composeDesktopAccessState({
    authSnapshot: expired,
    hostCapabilities: paid.fixture.hostCapabilities,
    accountResult: paid.accountResult,
    entitlementResult: paid.entitlementResult,
    usageResult: paid.usageResult,
  });
  assert.equal(state.launchActions.open_installed_desktop_project.state, "requires_reauthentication");
  assert.equal(state.launchActions.open_installed_desktop_project.portalDestination, "account");
});

test("past-due billing and suspended workspaces expose recovery without mutating billing", async () => {
  const pastDue = (await loadScenario("past-due")).state;
  assert.equal(pastDue.account.recovery.billingRequired, true);
  assert.equal(pastDue.launchActions.open_installed_desktop_project.state, "blocked_billing");
  assert.equal(pastDue.launchActions.recover_billing.state, "requires_portal");
  assert.equal(pastDue.launchActions.recover_billing.portalDestination, "recovery");

  for (const scenario of ["suspended", "recovery-only"]) {
    const state = (await loadScenario(scenario)).state;
    assert.equal(state.launchActions.recover_suspended_workspace.state, "requires_portal");
    assert.equal(state.launchActions.open_installed_desktop_project.state, "requires_portal");
  }
});

test("unknown, failed, and stale entitlements fail closed for managed and cloud actions", async () => {
  for (const scenario of ["entitlement-unknown", "entitlement-provider-failure", "offline-cached"]) {
    const { state } = await loadScenario(scenario);
    if (scenario === "offline-cached") assert.equal(state.entitlement.freshness, "stale");
    else assert.equal(state.entitlement.state, "unknown", scenario);
    assert.notEqual(state.capabilities.managedAi.availability, "available");
    assert.notEqual(state.launchActions.open_installed_desktop_project.state, "allowed");
    assert.notEqual(state.launchActions.open_cloud_workspace.state, "allowed");
  }
});

test("offline cached account state remains visible but read-only", async () => {
  const { state } = await loadScenario("offline-cached");
  assert.equal(state.account.session.state, "offline");
  assert.equal(state.account.freshness, "stale");
  assert.equal(state.entitlement.freshness, "stale");
  assert.equal(state.usage.freshness, "stale");
  assert.equal(state.launchActions.open_local_workspace.state, "allowed");
  assert.equal(state.launchActions.open_installed_desktop_project.state, "capability_unavailable");
});

test("stale usage is labeled read-only and cannot silently clear hard-limit uncertainty", async () => {
  const stale = await loadScenario("stale-usage");
  const { state } = stale;
  assert.equal(state.usage.freshness, "stale");
  assert.equal(state.usage.resources.aiModel.freshness, "stale");
  assert.equal(state.capabilities.builds.availability, "unknown");
  const presentation = createDesktopAccessPresentation(state);
  assert.ok(presentation.sections.usage.some((row) => row.detail === "Read-only cached data"));

  const cloudFixture = await loadScenario("future-cloud-eligible");
  const cloudWithStaleUsage = composeDesktopAccessState({
    authSnapshot: cloudFixture.fixture.authSnapshot,
    hostCapabilities: cloudFixture.fixture.hostCapabilities,
    accountResult: cloudFixture.accountResult,
    entitlementResult: cloudFixture.entitlementResult,
    usageResult: stale.usageResult,
  });
  assert.equal(cloudWithStaleUsage.launchActions.open_cloud_workspace.state, "capability_unavailable");
  assert.equal(cloudWithStaleUsage.launchActions.open_cloud_workspace.reason, "workspace_compute_usage_not_fresh");
});

test("portal handoff accepts only allowlisted actions and records token-free system-browser opens", async () => {
  const opened = [];
  const handoff = createPortalHandoff({ openExternal: async (value) => opened.push(value) });
  for (const destination of PORTAL_DESTINATIONS) await handoff.open(destination);
  assert.deepEqual(handoff.getCalls().map((call) => call.destination), PORTAL_DESTINATIONS);
  assert.equal(opened.length, PORTAL_DESTINATIONS.length);
  for (const value of opened) {
    const parsed = new URL(value);
    assert.equal(parsed.origin, "https://app.thrallo.com");
    assert.equal(parsed.search, "");
    assert.equal(parsed.hash, "");
    assert.equal(parsed.username, "");
    assert.equal(parsed.password, "");
    assert.doesNotMatch(value, /token|bearer|session|credential/i);
  }
  await assert.rejects(handoff.open("https://evil.invalid/steal"), (error) => error.code === "portal_destination_rejected");
  await assert.rejects(handoff.open({ destination: "billing", url: "https://evil.invalid" }), (error) => error.code === "portal_destination_rejected");
});

test("identical D3 seeds yield identical provider results, calls, portal actions, and decisions", async () => {
  const left = await loadScenario("usage-warning-90", "identical-seed");
  const right = await loadScenario("usage-warning-90", "identical-seed");
  await left.fixture.portal.open("usage");
  await right.fixture.portal.open("usage");
  assert.deepEqual(left.accountResult, right.accountResult);
  assert.deepEqual(left.entitlementResult, right.entitlementResult);
  assert.deepEqual(left.usageResult, right.usageResult);
  assert.deepEqual(left.fixture.getCalls(), right.fixture.getCalls());
  assert.deepEqual(left.fixture.portal.getCalls(), right.fixture.portal.getCalls());
  assert.deepEqual(left.state, right.state);
});

test("stable account adapter requires explicit read-only routes and has no mutation fallback", async () => {
  const calls = [];
  const transport = {
    request: async (input) => {
      calls.push(input);
      return { ok: true, requestId: "read-only-1", data: { source: input.path }, observedAt: null, source: "http", revision: null };
    },
  };
  const provider = createStableReadOnlyAccountAccessProvider({
    transport,
    routeMap: {
      getAccount: { method: "GET", path: "/desktop/account", map: (data) => ({ ...data, normalized: true }) },
      getEntitlements: { method: "HEAD", path: "/desktop/entitlements" },
    },
  });
  assertAccountAccessProvider(provider);
  assert.equal((await provider.getAccount()).data.normalized, true);
  assert.equal((await provider.getEntitlements()).ok, true);
  assert.equal((await provider.getUsage()).code, "capability_unavailable");
  assert.equal(calls.length, 2);
  assert.equal(provider.capabilities.productionMutation, false);
  assert.equal("changeSubscription" in provider, false);
  assert.throws(() => createStableReadOnlyAccountAccessProvider({ transport, routeMap: { getUsage: { method: "POST", path: "/mutation" } } }), /refuses POST/);
  assert.throws(() => createStableReadOnlyAccountAccessProvider({ transport, routeMap: { getUsage: { path: "https://example.invalid/usage" } } }), /origin-relative/);
  assert.throws(() => createStableReadOnlyAccountAccessProvider({ transport, routeMap: { getUsage: { path: "//example.invalid/usage" } } }), /origin-relative/);
  assert.throws(() => createStableReadOnlyAccountAccessProvider({ transport, routeMap: { getUsage: { path: "/\\example.invalid/usage" } } }), /origin-relative/);
  assert.throws(() => createStableReadOnlyAccountAccessProvider({ transport, routeMap: { getUsage: { path: "/usage?token=secret" } } }), /origin-relative/);
  assert.throws(() => createStableReadOnlyAccountAccessProvider({ transport, routeMap: { cancelSubscription: { path: "/mutation" } } }), /Unknown account access routes/);
});

test("a real D2 deterministic authenticated snapshot composes with D3 without changing auth contracts", async () => {
  const authProvider = createDeterministicAuthProvider();
  const vault = createDevelopmentCredentialVault();
  const controller = createNativeAuthController({
    provider: authProvider,
    vault,
    capabilities: createHostCapabilities({ nativeKeychain: true }),
    deviceId: "fixture-d3-auth-device",
    now: authProvider.now,
    browser: { openExternal: async () => {} },
  });
  const authorization = await controller.startAuthorization();
  await controller.handleCallback(authProvider.completeAuthorization(authorization.authorizationId));
  const d3 = await loadScenario("authenticated-paid");
  const composed = composeDesktopAccessState({
    authSnapshot: controller.getSnapshot(),
    hostCapabilities: d3.fixture.hostCapabilities,
    accountResult: d3.accountResult,
    entitlementResult: d3.entitlementResult,
    usageResult: d3.usageResult,
  });
  assert.equal(composed.account.session.state, "authenticated");
  assert.equal(composed.launchActions.open_installed_desktop_project.state, "allowed");
});

test("D1 provider suite remains compatible beside the D3 account provider", () => {
  assert.equal(createFixtureProviderSuite().contractVersion, "1.0");
  assertAccountAccessProvider(createDesktopAccessFixture().provider);
});

test("D3 deterministic fixtures never access a production network", async () => {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => { networkCalls += 1; throw new Error("D3 fixtures must not access a network"); };
  try {
    const fixture = createDesktopAccessFixture({ scenario: "past-due" });
    await fixture.provider.getAccount();
    await fixture.provider.getEntitlements();
    await fixture.provider.getUsage();
    await fixture.portal.open("recovery");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(networkCalls, 0);
});

test("D3 fixture source has no payment data, service credentials, or production configuration", () => {
  const source = readFileSync(path.join(ROOT, "shared/thrallo-client/src/access/fixtures/createDesktopAccessFixture.mjs"), "utf8");
  assert.doesNotMatch(source, /stripe|supabase|service[_-]?role|paymentMethod|cardNumber|ownerId|process\.env|app\.thrallo\.com|https?:\/\//i);
});

test("D3 errors and call evidence redact session and account secrets", () => {
  const rendered = JSON.stringify(redact({
    session: "private-session-value",
    authorization: "Bearer private-token-value",
    account: { credential: "private-account-credential" },
  }));
  assert.doesNotMatch(rendered, /private-session-value|private-token-value|private-account-credential/);
});

test("bounded workbench presentation shows access state and escapes untrusted identity text", async () => {
  const scenario = await loadScenario("authenticated-paid");
  const maliciousAccount = {
    ...scenario.accountResult,
    data: {
      ...scenario.accountResult.data,
      profile: { displayName: "<script>steal()</script>", emailLabel: "safe@example.invalid", avatarLabel: "X" },
    },
  };
  const state = composeDesktopAccessState({
    authSnapshot: scenario.fixture.authSnapshot,
    hostCapabilities: scenario.fixture.hostCapabilities,
    accountResult: maliciousAccount,
    entitlementResult: scenario.entitlementResult,
    usageResult: scenario.usageResult,
  });
  const presentation = createDesktopAccessPresentation(state);
  const html = renderDesktopAccessHtml(presentation);
  assert.equal(presentation.kind, "thrallo-desktop-access-foundation");
  assert.equal(presentation.launchActions.length, 7);
  assert.equal(presentation.portalActions.length, 7);
  assert.doesNotMatch(html, /<script>steal/);
  assert.match(html, /&lt;script&gt;steal\(\)&lt;\/script&gt;/);
  assert.match(html, /data-launch-action="open_local_workspace"/);
  assert.match(html, /data-portal-destination="billing"/);
});

test("D3 evidence does not overclaim production entitlement or cloud launch", () => {
  const evidence = JSON.parse(readFileSync(path.join(ROOT, "desktop/account/evidence.json"), "utf8"));
  assert.equal(evidence.classification, "fixture-verified-foundation");
  assert.equal(evidence.productionEntitlementVerified, false);
  assert.equal(evidence.productionBillingMutationImplemented, false);
  assert.equal(evidence.cloudWorkspaceLaunchImplemented, false);
  assert.equal(evidence.portalRoutesModified, false);
});

test("D3 source has no Builder V2 or retired Buildr101 dependency and still passes the D0 guard", () => {
  const denylist = JSON.parse(readFileSync(path.join(ROOT, "desktop/d0/buildr101-denylist.json"), "utf8"));
  const roots = [path.join(ROOT, "shared/thrallo-client/src/access"), path.join(ROOT, "desktop/account")];
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (/\.(?:mjs|js)$/.test(entry.name)) files.push(target);
    }
  };
  roots.forEach(visit);
  const source = files.map((file) => readFileSync(file, "utf8")).join("\n");
  assert.deepEqual(forbiddenReferences(source, denylist), []);
  assert.doesNotMatch(source, /shell\/server|builderV2|supabase|build-worker|provisiond|runtime-worker|\bfetch\s*\(/i);
  assert.doesNotThrow(() => runGuard({ phase: "desktop-foundation" }));
});
