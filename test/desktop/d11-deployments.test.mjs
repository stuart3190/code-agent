import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

import * as client from "../../shared/thrallo-client/src/index.mjs";
import { runGuard } from "../../desktop/d0/guard.mjs";

const require = createRequire(import.meta.url);
const {
  DEPLOYMENT_STATES, ACTIVE_DEPLOYMENT_STATES, PUBLISHING_STATES, SOURCE_IDENTITIES,
  HEALTH_STATES, DOMAIN_STATES, DEPLOYMENT_PHASES, ACTION_IDS, D11_SCENARIOS,
  createDeploymentController, createDeploymentReadOnlyAdapter, redactText,
} = require("../../editor/vscode/lib/deploymentFoundation.js");
const { createDeploymentLocalExportAdapter, safeName } = require("../../editor/vscode/lib/deploymentLocalExport.js");
const { createDesktopProductController } = require("../../editor/vscode/lib/desktopProduct.js");
const { renderDesktopProductHtml } = require("../../editor/vscode/lib/desktopProductView.js");

test("D11 declares complete deployment, publishing, source, health, domain, phase and action states", () => {
  for (const value of ["draft", "unpublished", "queued", "building", "deploying", "verifying", "live", "update_available", "failed", "canceled", "rolled_back", "unhealthy", "degraded", "unknown", "capability_unavailable"]) assert.ok(DEPLOYMENT_STATES.includes(value));
  assert.deepEqual(ACTIVE_DEPLOYMENT_STATES, ["queued", "building", "deploying", "verifying"]);
  for (const value of ["never_published", "draft", "published", "update_available", "unpublished", "publishing", "publish_failed", "update_failed", "unpublish_pending", "unpublish_failed", "rollback_available", "rollback_unavailable"]) assert.ok(PUBLISHING_STATES.includes(value));
  assert.deepEqual(SOURCE_IDENTITIES, ["fixture_source", "local_source_unverified", "future_verified_snapshot", "future_git_revision", "unknown"]);
  assert.deepEqual(HEALTH_STATES, ["healthy", "degraded", "unhealthy", "checking", "unknown", "unavailable"]);
  assert.ok(DOMAIN_STATES.includes("certificate_pending") && DOMAIN_STATES.includes("verification_failed") && DOMAIN_STATES.includes("removed"));
  assert.deepEqual(DEPLOYMENT_PHASES, ["source_preparation", "build", "verification", "release_creation", "deployment", "health_verification", "domain_activation", "completion"]);
  for (const action of ["publish", "update", "unpublish", "rollback", "retry_deployment", "configure_domain", "verify_domain", "remove_domain", "export"]) assert.ok(ACTION_IDS.includes(action));
});

test("D11 deterministic scenario catalogue covers every requested workflow", () => {
  assert.equal(D11_SCENARIOS.length, 27);
  for (const scenario of ["never-published", "first-publish-pending", "first-publish-success", "first-publish-failure", "live-healthy", "live-degraded", "update-available", "update-deploying", "update-failed", "unpublished", "unpublish-failed", "rollback-available", "rollback-simulated-success", "rollback-failed", "deployment-canceled", "domain-pending-dns", "domain-verified", "certificate-pending", "domain-active", "domain-verification-failed", "unhealthy-domain", "logs-available", "logs-unavailable", "health-unavailable", "export-available", "publishing-capability-unavailable", "future-verified-source-unavailable"]) assert.ok(D11_SCENARIOS.includes(scenario));
});

test("identical seeds produce identical deployment, release, log and domain state", () => {
  const left = createDeploymentController({ scenario: "update-available", seed: "same" });
  const right = createDeploymentController({ scenario: "update-available", seed: "same" });
  assert.deepEqual(left.snapshot(), right.snapshot());
  assert.deepEqual(left.getCalls(), right.getCalls());
});

test("deployment model separates workspace, active release and execution state", () => {
  const state = createDeploymentController({ scenario: "live-healthy" }).snapshot();
  assert.equal(state.publishing.workspaceState, "fixture_ready");
  assert.equal(state.publishing.currentActivatedReleaseId, state.activeReleaseId);
  assert.equal(state.selectedDeployment.releaseId, state.activeReleaseId);
  assert.equal(state.selectedDeployment.environment, "fixture");
  assert.equal(state.sourceIdentity.canonicalSnapshotId, null);
  assert.equal(state.sourceIdentity.gitRevision, null);
  const pending = createDeploymentController({ scenario: "first-publish-pending" }).snapshot();
  assert.equal(pending.activeReleaseId, null);
  assert.equal(pending.releases.at(-1).outcome, "pending");
  const failedUpdate = createDeploymentController({ scenario: "update-failed" }).snapshot();
  assert.notEqual(failedUpdate.activeReleaseId, failedUpdate.selectedDeployment.releaseId);
  assert.equal(failedUpdate.releases.at(-1).outcome, "failed");
  assert.equal(failedUpdate.releasePresentation.find((item) => item.id === failedUpdate.activeReleaseId).activationState, "current");
  assert.equal(failedUpdate.releases.find((item) => item.id === failedUpdate.previousReleaseId).outcome, "succeeded");
  assert.equal(state.actions.find((item) => item.id === "update").enabled, false);
  assert.equal(createDeploymentController({ scenario: "unpublished" }).snapshot().activeReleaseId, null);
});

test("terminal historical deployments never display false current activity", () => {
  for (const scenario of ["live-healthy", "first-publish-failure", "deployment-canceled", "rollback-simulated-success", "unpublished"]) {
    const state = createDeploymentController({ scenario }).snapshot();
    assert.equal(state.currentDeploymentActive, false, scenario);
    assert.equal(state.deployments[0]?.active || false, false, scenario);
    assert.equal(state.logs.follow, false, scenario);
  }
  for (const scenario of ["first-publish-pending", "update-deploying"]) assert.equal(createDeploymentController({ scenario }).snapshot().currentDeploymentActive, true, scenario);
});

test("release entries are immutable and current, previous and rollback identities are derived", () => {
  const state = createDeploymentController({ scenario: "rollback-available" }).snapshot();
  assert.ok(Object.isFrozen(state.releases) && state.releases.every(Object.isFrozen));
  assert.equal(state.releasePresentation.find((item) => item.id === state.activeReleaseId).activationState, "current");
  assert.equal(state.releasePresentation.find((item) => item.id === state.previousReleaseId).activationState, "previous");
  assert.equal(state.releasePresentation.find((item) => item.id === state.previousReleaseId).rollbackCandidate, true);
});

test("fixture rollback requires typed review and confirmation and never mutates the target release", async () => {
  const controller = createDeploymentController({ scenario: "rollback-available" });
  const before = controller.snapshot();
  const releasesBefore = before.releases;
  const target = before.previousReleaseId;
  assert.equal((await controller.dispatch({ type: "confirm_action", actionId: "rollback", confirmed: true })).result.code, "typed_action_review_required");
  assert.equal((await controller.dispatch({ type: "review_action", actionId: "rollback", releaseId: target })).result.state, "action_review_ready");
  assert.equal((await controller.dispatch({ type: "confirm_action", actionId: "rollback", confirmed: false })).result.code, "explicit_confirmation_required");
  const rolledBack = await controller.dispatch({ type: "confirm_action", actionId: "rollback", confirmed: true });
  assert.equal(rolledBack.result.state, "fixture_rollback_simulated");
  assert.equal(controller.snapshot().activeReleaseId, target);
  assert.equal(controller.snapshot().selectedRelease.id, target);
  assert.equal(controller.snapshot().selectedDeployment.status, "rolled_back");
  assert.ok(controller.snapshot().phases.every((phase) => phase.state === "completed"));
  assert.deepEqual(controller.snapshot().releases, releasesBefore);
  assert.equal(controller.snapshot().activations.length, before.activations.length + 1);
  assert.equal(controller.snapshot().activations.at(-1).reason, "rollback");
});

test("fixture unpublish requires confirmation and preserves project and release history", async () => {
  const controller = createDeploymentController({ scenario: "live-healthy" });
  const before = controller.snapshot();
  await controller.dispatch({ type: "review_action", actionId: "unpublish" });
  const result = await controller.dispatch({ type: "confirm_action", actionId: "unpublish", confirmed: true });
  const after = controller.snapshot();
  assert.equal(result.result.state, "fixture_unpublish_simulated");
  assert.equal(after.publishing.state, "unpublished");
  assert.equal(after.activeReleaseId, null);
  assert.equal(after.selectedDeployment.status, "unpublished");
  assert.equal(after.domain.state, "removed");
  assert.equal(after.health.state, "unknown");
  assert.deepEqual(after.releases, before.releases);
  assert.equal(after.project.id, before.project.id);
});

test("fixture publish and update create new immutable releases without production identity", async () => {
  for (const [scenario, action] of [["never-published", "publish"], ["update-available", "update"]]) {
    const controller = createDeploymentController({ scenario });
    const count = controller.snapshot().releases.length;
    await controller.dispatch({ type: "review_action", actionId: action });
    const result = await controller.dispatch({ type: "confirm_action", actionId: action, confirmed: true });
    assert.equal(result.result.state, `fixture_${action}_simulated`);
    assert.equal(controller.snapshot().releases.length, count + 1);
    assert.equal(controller.snapshot().selectedRelease.id, controller.snapshot().activeReleaseId);
    assert.equal(controller.snapshot().selectedDeployment.status, "live");
    assert.equal(controller.snapshot().sourceIdentity.canonicalSnapshotId, null);
  }
});

test("future verified source and unavailable publishing fail closed", async () => {
  for (const scenario of ["future-verified-source-unavailable", "publishing-capability-unavailable"]) {
    const controller = createDeploymentController({ scenario });
    const publish = controller.snapshot().actions.find((item) => item.id === "publish");
    assert.equal(publish.enabled, false);
    const result = await controller.dispatch({ type: "review_action", actionId: "publish" });
    assert.equal(result.result.ok, false);
    assert.equal(result.result.sideEffects, false);
  }
});

test("local, future Git and unknown source identities remain unverified and cannot publish", async () => {
  for (const classification of ["local_source_unverified", "future_git_revision", "unknown"]) {
    const controller = createDeploymentController({ scenario: "never-published", sourceClassification: classification });
    const state = controller.snapshot();
    assert.equal(state.sourceIdentity.classification, classification);
    assert.equal(state.sourceIdentity.verified, false);
    assert.equal(state.sourceIdentity.canonicalSnapshotId, null);
    assert.equal(state.actions.find((item) => item.id === "publish").enabled, false);
    assert.equal((await controller.dispatch({ type: "review_action", actionId: "publish" })).result.sideEffects, false);
  }
  assert.throws(() => createDeploymentController({ sourceClassification: "invented_snapshot" }), /Unknown D11 source classification/);
});

test("logs support phase, severity and search filters plus older entries", async () => {
  const controller = createDeploymentController({ scenario: "logs-available" });
  await controller.dispatch({ type: "filter_logs", phase: "verification", severity: "warning", search: "redacted" });
  assert.equal(controller.snapshot().filteredLogs.length, 1);
  assert.equal(controller.snapshot().filteredLogs[0].phase, "verification");
  await controller.dispatch({ type: "filter_logs", phase: "all", severity: "all", search: "" });
  const count = controller.snapshot().logs.items.length;
  assert.equal((await controller.dispatch({ type: "load_older_logs" })).result.state, "older_logs_loaded");
  assert.equal(controller.snapshot().logs.items.length, count + 1);
  assert.equal(controller.snapshot().logs.hasOlder, false);
});

test("log follow is explicit and terminal deployments remain settled", async () => {
  const controller = createDeploymentController({ scenario: "live-healthy" });
  assert.equal(controller.snapshot().logs.follow, false);
  await controller.dispatch({ type: "toggle_log_follow", follow: true });
  assert.equal(controller.snapshot().logs.follow, true);
  assert.equal(controller.snapshot().currentDeploymentActive, false);
});

test("log, export and snapshot redaction removes every fake secret class", async () => {
  const secretText = "sk_test_fixture_secret_123456 Authorization: Bearer abcdefghijklmnopqrstuvwxyz token=fake-token cookie=fake-cookie github_pat_fakevalue123456 postgresql://user:pass@db.fixture.invalid/app https://fixture.invalid/x?signature=fake-signature";
  const redacted = redactText(secretText);
  for (const secret of ["sk_test", "abcdefghijklmnopqrstuvwxyz", "fake-token", "fake-cookie", "github_pat", "user:pass", "db.fixture", "fake-signature"]) assert.doesNotMatch(redacted, new RegExp(secret, "i"));
  const controller = createDeploymentController({ scenario: "export-available" });
  const snapshot = JSON.stringify(controller.snapshot());
  const exported = (await controller.dispatch({ type: "export_fixture" })).result.artifact.content;
  for (const value of [snapshot, exported]) assert.doesNotMatch(value, /fake-|db\.fixture|abcdefghijklmnopqrstuvwxyz|github_pat_|service.?role|stripe.*secret/i);
  assert.doesNotMatch(exported, /requestBody|responseBody|authorizationHeaders|cookies/i);
});

test("logs unavailable, health unavailable and every health state are honest", () => {
  assert.equal(createDeploymentController({ scenario: "logs-unavailable" }).snapshot().logs.available, false);
  assert.equal(createDeploymentController({ scenario: "health-unavailable" }).snapshot().health.state, "unavailable");
  for (const scenario of ["live-healthy", "live-degraded", "first-publish-failure", "update-deploying", "health-unavailable"]) assert.ok(HEALTH_STATES.includes(createDeploymentController({ scenario }).snapshot().health.state));
});

test("domain states and synthetic DNS instructions are presentation-safe", async () => {
  for (const scenario of ["domain-pending-dns", "domain-verified", "certificate-pending", "domain-active", "domain-verification-failed", "unhealthy-domain"]) assert.ok(DOMAIN_STATES.includes(createDeploymentController({ scenario }).snapshot().domain.state));
  const controller = createDeploymentController({ scenario: "domain-pending-dns" });
  const result = await controller.dispatch({ type: "copy_dns_instructions" });
  assert.equal(result.result.state, "fixture_dns_instructions_ready");
  assert.equal(result.result.instructions.recordType, "CNAME");
  assert.match(result.result.instructions.verificationValue, /\[synthetic\]/);
  assert.doesNotMatch(JSON.stringify(result.result), /secret|credential/i);
});

test("fixture domain verification simulates state without a DNS provider", async () => {
  const controller = createDeploymentController({ scenario: "domain-pending-dns" });
  await controller.dispatch({ type: "review_action", actionId: "verify_domain" });
  const result = await controller.dispatch({ type: "confirm_action", actionId: "verify_domain", confirmed: true });
  assert.equal(result.result.state, "fixture_domain_verified");
  assert.equal(controller.snapshot().domain.state, "verified");
  assert.equal(controller.getCalls().some((item) => item.operation === "confirm_action"), true);
});

test("local fixture export writes only below the injected desktop storage root", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "thrallo-d11-export-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const adapter = createDeploymentLocalExportAdapter({ root });
  const controller = createDeploymentController({ scenario: "export-available", exportAdapter: adapter });
  const result = await controller.dispatch({ type: "export_fixture" });
  assert.equal(result.result.state, "fixture_export_created");
  const file = result.result.artifact.localPath;
  assert.equal(path.dirname(file), path.resolve(root));
  const content = await fsp.readFile(file, "utf8");
  assert.equal(JSON.parse(content).kind, "thrallo-fixture-deployment-export");
  assert.equal(result.result.artifact.uploaded, false);
  assert.equal(safeName("../../secret.json"), "..-..-secret.json");
  assert.equal(safeName("not-json.txt"), null);
});

test("D1 deployment read-only adapter accepts only injected origin-relative GET/HEAD routes", async () => {
  const requests = [];
  const transport = { async request(input) { requests.push(input); return { ok: true, data: [] }; }, async openEventStream() { throw new Error("not used"); } };
  const provider = createDeploymentReadOnlyAdapter({ createStableReadOnlyProvider: client.createStableReadOnlyProvider, transport, routes: { listDeployments: { method: "GET", path: "/fixture/deployments" }, getDomainStatus: { method: "HEAD", path: "/fixture/domain" } } });
  await provider.listDeployments();
  assert.equal(requests[0].method, "GET");
  assert.equal((await provider.publish()).code, "capability_unavailable");
  assert.equal(requests.length, 1);
  assert.throws(() => createDeploymentReadOnlyAdapter({ createStableReadOnlyProvider: client.createStableReadOnlyProvider, transport, routes: { listDeployments: { method: "POST", path: "/deployments" } } }), /refuses POST/);
  assert.throws(() => createDeploymentReadOnlyAdapter({ createStableReadOnlyProvider: client.createStableReadOnlyProvider, transport, routes: { listDeployments: { path: "https:\/\/app.thrallo.com/api" } } }), /origin-relative/);
  assert.throws(() => createDeploymentReadOnlyAdapter({ createStableReadOnlyProvider: client.createStableReadOnlyProvider, transport, routes: { publish: { path: "/publish" } } }), /route rejected/);
});

test("D9 navigation exposes D11 while D10 preview remains available", async () => {
  const controller = await createDesktopProductController({ client, localRegistry: { recent: async () => [] }, deploymentScenario: "update-available" });
  assert.equal(controller.snapshot().navigation.items.find((item) => item.id === "deployments").enabled, true);
  assert.equal(controller.snapshot().navigation.items.find((item) => item.id === "domains").enabled, true);
  assert.equal(controller.snapshot().navigation.items.find((item) => item.id === "preview").enabled, true);
  await controller.dispatch({ type: "navigate", destination: "deployments" });
  assert.equal(controller.snapshot().navigation.current, "deployments");
  assert.equal(controller.snapshot().preview.boundaries.builderV2Mutation, "capability_unavailable");
  assert.equal(controller.snapshot().deployment.publishing.state, "update_available");
  assert.equal(controller.snapshot().deployment.providerRead.items[0].sourceIdentityAccepted, false);
  assert.doesNotMatch(JSON.stringify(controller.snapshot().deployment.providerRead), /snapshot|revision/i);
});

test("Code OSS manifest and host register the typed D11 deployment entry point", async () => {
  const manifest = JSON.parse(await fsp.readFile(path.join(process.cwd(), "editor/vscode/package.json"), "utf8"));
  assert.ok(manifest.contributes.commands.some((item) => item.command === "thrallo.openDeployments"));
  const hostSource = await fsp.readFile(path.join(process.cwd(), "editor/vscode/lib/desktopProductHost.js"), "utf8");
  assert.match(hostSource, /registerCommand\("thrallo\.openDeployments"/);
  assert.match(hostSource, /message\.type === "deploymentAction"/);
  assert.match(hostSource, /fixture_dns_instructions_ready/);
});

test("project launcher shows compact fixture publishing and health status", async () => {
  const controller = await createDesktopProductController({ client, localRegistry: { recent: async () => [] }, deploymentScenario: "live-degraded" });
  const project = controller.snapshot().projects.items.find((item) => item.workspaceType === "fixture_thrallo_project");
  assert.equal(project.deploymentState, "published");
  assert.equal(project.healthState, "degraded");
});

test("D11 view renders deployment history, releases, logs, health and domains accessibly", async () => {
  const controller = await createDesktopProductController({ client, localRegistry: { recent: async () => [] }, deploymentScenario: "domain-pending-dns" });
  await controller.dispatch({ type: "navigate", destination: "deployments" });
  const html = renderDesktopProductHtml(controller.snapshot(), { nonce: "d11-test", cspSource: "vscode-webview://fixture" });
  for (const marker of ["Release and publishing", "Project/workspace", "Published release", "Deployment execution", "Deployment history", "Diagnostic summary", "Immutable history", "Deployment logs", "Current active release", "Custom domain", "Copy fixture DNS instructions"]) assert.match(html, new RegExp(marker));
  assert.match(html, /role="log"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /prefers-reduced-motion:reduce/);
  assert.match(html, /focus-visible/);
  assert.match(html, /@media\(max-width:650px\)/);
  assert.doesNotMatch(html, /fake-|Bearer abc|db\.fixture|service.?role|Cookie:/i);
});

test("rollback and unpublish reviews have accessible explicit confirmation language", async () => {
  const controller = await createDesktopProductController({ client, localRegistry: { recent: async () => [] }, deploymentScenario: "rollback-available" });
  await controller.dispatch({ type: "navigate", destination: "deployments" });
  await controller.dispatch({ type: "deployment_action", action: { type: "review_action", actionId: "rollback" } });
  let html = renderDesktopProductHtml(controller.snapshot(), { nonce: "review", cspSource: "vscode-webview://fixture" });
  assert.match(html, /<dialog[^>]+open[^>]+aria-labelledby/);
  assert.match(html, /Confirm fixture action/);
  assert.match(html, /Does not modify the prior release/);
  assert.match(html, /Health history/);
  assert.match(html, /New fixture activation event/);
  assert.match(html, /deploymentDialog\.showModal\(\)/);
  assert.match(html, /deploymentDialog\.querySelector\('button'\)\?\.focus\(\)/);
  await controller.dispatch({ type: "deployment_action", action: { type: "cancel_review" } });
  await controller.dispatch({ type: "deployment_action", action: { type: "review_action", actionId: "unpublish" } });
  html = renderDesktopProductHtml(controller.snapshot(), { nonce: "unpublish", cspSource: "vscode-webview://fixture" });
  assert.match(html, /Unpublish application/);
  assert.match(html, /Project and release history remain/);
});

test("D11 controller and view contain no production, Builder V2, Buildr101 or hidden mutation fallback", async () => {
  const files = ["deploymentFoundation.js", "deploymentLocalExport.js", "deploymentView.js"].map((file) => path.join(process.cwd(), "editor/vscode/lib", file));
  const source = (await Promise.all(files.map((file) => fsp.readFile(file, "utf8")))).join("\n");
  assert.doesNotMatch(source, /shell\/server\/routes\/(?:publish|domains|environments)|runtime-worker|buildr-runtime-worker|createHttpTransport|defaultOrigin|fetch\s*\(|axios|\/api\/v\d|builderV2Mutation:\s*true/i);
  assert.doesNotMatch(source, /\.(?:post|put|patch|delete)\s*\(/i);
});

test("every recorded D11 action is bounded and contains no project data or secrets", async () => {
  const controller = createDeploymentController({ scenario: "domain-pending-dns", seed: "calls" });
  await controller.dispatch({ type: "copy_dns_instructions", secret: "must-not-record" });
  await controller.dispatch({ type: "filter_logs", phase: "all", severity: "all", search: "private" });
  const calls = JSON.stringify(controller.getCalls());
  assert.doesNotMatch(calls, /must-not-record|private|hostname|expectedValue|message/);
  assert.match(calls, /copy_dns_instructions/);
});

test("D0 protected-path, Buildr101 and fixture-network guards remain green", () => {
  assert.equal(runGuard().phase, "desktop-foundation");
});
