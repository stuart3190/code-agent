import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  composeDesktopAccessState,
  createDesktopAccessFixture,
} from "../../shared/thrallo-client/src/index.mjs";
import { createDesktopAccessPresentation, renderDesktopAccessHtml } from "./presentation.mjs";

async function accessState(scenario) {
  const fixture = createDesktopAccessFixture({ scenario });
  const [accountResult, entitlementResult, usageResult] = await Promise.all([
    fixture.provider.getAccount(),
    fixture.provider.getEntitlements(),
    fixture.provider.getUsage(),
  ]);
  return { fixture, state: composeDesktopAccessState({
    authSnapshot: fixture.authSnapshot,
    hostCapabilities: fixture.hostCapabilities,
    accountResult,
    entitlementResult,
    usageResult,
  }) };
}

let checks = 0;
const paid = await accessState("authenticated-paid");
const presentation = createDesktopAccessPresentation(paid.state);
const html = renderDesktopAccessHtml(presentation);
assert.match(html, /Fixture Developer/);
assert.match(html, /Thrallo account and access/);
checks += 1;

assert.equal(paid.state.launchActions.open_local_workspace.state, "allowed");
assert.equal(paid.state.launchActions.open_installed_desktop_project.state, "allowed");
checks += 1;

assert.equal(paid.state.launchActions.open_cloud_workspace.state, "capability_unavailable");
checks += 1;

const pastDue = await accessState("past-due");
assert.equal(pastDue.state.launchActions.open_installed_desktop_project.state, "blocked_billing");
assert.equal(pastDue.state.launchActions.recover_billing.state, "requires_portal");
checks += 1;

const offline = await accessState("offline-cached");
assert.equal(offline.state.capabilities.managedAi.availability, "unknown");
assert.equal(offline.state.launchActions.open_installed_desktop_project.state, "capability_unavailable");
checks += 1;

await paid.fixture.portal.open("billing");
assert.deepEqual(paid.fixture.portal.getCalls().map((call) => call.destination), ["billing"]);
assert.deepEqual(paid.fixture.getPortalOpens().map((call) => call.pathname), ["/settings/billing"]);
checks += 1;

const evidencePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "evidence.json");
const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
assert.equal(evidence.fixtureRuntimeVerified, true);
assert.equal(evidence.productionEntitlementVerified, false);
assert.equal(evidence.cloudWorkspaceLaunchImplemented, false);
checks += 1;

assert.equal(checks, 7);
console.log(`Thrallo deterministic desktop account/access smoke: ${checks}/7`);
