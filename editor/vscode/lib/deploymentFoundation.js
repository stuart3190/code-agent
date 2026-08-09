// Host-neutral D11 deployment/release presentation. It has deterministic fixture actions,
// accepts only an injected D1 read-only provider, and has no origin or live mutation fallback.

"use strict";

const DEPLOYMENT_STATES = Object.freeze([
  "draft", "unpublished", "queued", "building", "deploying", "verifying", "live",
  "update_available", "failed", "canceled", "rolled_back", "unhealthy", "degraded",
  "unknown", "capability_unavailable",
]);
const ACTIVE_DEPLOYMENT_STATES = Object.freeze(["queued", "building", "deploying", "verifying"]);
const PUBLISHING_STATES = Object.freeze([
  "never_published", "draft", "published", "update_available", "unpublished", "publishing",
  "publish_failed", "update_failed", "unpublish_pending", "unpublish_failed",
  "rollback_available", "rollback_unavailable",
]);
const SOURCE_IDENTITIES = Object.freeze(["fixture_source", "local_source_unverified", "future_verified_snapshot", "future_git_revision", "unknown"]);
const HEALTH_STATES = Object.freeze(["healthy", "degraded", "unhealthy", "checking", "unknown", "unavailable"]);
const DOMAIN_STATES = Object.freeze([
  "none", "pending_dns", "verification_required", "verifying", "verified", "certificate_pending",
  "active", "verification_failed", "certificate_failed", "unhealthy", "removed", "unavailable",
]);
const DEPLOYMENT_PHASES = Object.freeze([
  "source_preparation", "build", "verification", "release_creation", "deployment",
  "health_verification", "domain_activation", "completion",
]);
const ACTION_IDS = Object.freeze([
  "publish", "update", "unpublish", "rollback", "retry_deployment", "configure_domain",
  "verify_domain", "activate_domain", "remove_domain", "copy_dns_instructions", "export",
]);
const D11_FIXTURE_SEED = "thrallo-desktop-d11-foundation";
const D11_FIXTURE_CLOCK = "2032-11-04T16:00:00.000Z";

const BASE_SCENARIO = Object.freeze({
  publishing: "published", deployment: "live", health: "healthy", domain: "active",
  source: "fixture_source", history: 3, logs: "available", export: true,
});
const SCENARIOS = Object.freeze({
  "never-published": { publishing: "never_published", deployment: "unpublished", health: "unknown", domain: "none", history: 0 },
  "first-publish-pending": { publishing: "publishing", deployment: "queued", health: "checking", domain: "none", history: 1 },
  "first-publish-success": { publishing: "published", deployment: "live", history: 1 },
  "first-publish-failure": { publishing: "publish_failed", deployment: "failed", health: "unhealthy", history: 1 },
  "live-healthy": {},
  "live-degraded": { deployment: "degraded", health: "degraded" },
  "update-available": { publishing: "update_available", deployment: "update_available" },
  "update-deploying": { publishing: "publishing", deployment: "deploying", health: "checking" },
  "update-failed": { publishing: "update_failed", deployment: "failed", health: "degraded" },
  unpublished: { publishing: "unpublished", deployment: "unpublished", health: "unknown", domain: "removed" },
  "unpublish-failed": { publishing: "unpublish_failed", deployment: "live", health: "healthy" },
  "rollback-available": { publishing: "rollback_available" },
  "rollback-simulated-success": { publishing: "published", deployment: "rolled_back" },
  "rollback-failed": { publishing: "rollback_available", deployment: "failed", health: "degraded" },
  "deployment-canceled": { publishing: "draft", deployment: "canceled", health: "unknown", history: 1 },
  "domain-pending-dns": { domain: "pending_dns" },
  "domain-verified": { domain: "verified" },
  "certificate-pending": { domain: "certificate_pending" },
  "domain-active": { domain: "active" },
  "domain-verification-failed": { domain: "verification_failed" },
  "unhealthy-domain": { domain: "unhealthy", health: "degraded" },
  "logs-available": { logs: "available" },
  "logs-unavailable": { logs: "unavailable" },
  "health-unavailable": { health: "unavailable" },
  "export-available": { export: true },
  "publishing-capability-unavailable": { publishing: "rollback_unavailable", deployment: "capability_unavailable", health: "unavailable", domain: "unavailable", export: false },
  "future-verified-source-unavailable": { source: "future_verified_snapshot", publishing: "draft", deployment: "capability_unavailable", health: "unavailable", domain: "unavailable", export: false },
});
const D11_SCENARIOS = Object.freeze(Object.keys(SCENARIOS));

function getD11Scenario(name = "live-healthy") {
  if (!D11_SCENARIOS.includes(name)) throw new TypeError(`Unknown D11 fixture scenario: ${name}`);
  return Object.freeze({ name, ...BASE_SCENARIO, ...SCENARIOS[name] });
}

function createDeploymentController({
  scenario = "live-healthy",
  seed = D11_FIXTURE_SEED,
  providerDeployments = null,
  exportAdapter = null,
  sourceClassification = null,
  now = fixtureNow,
} = {}) {
  if (sourceClassification != null && !SOURCE_IDENTITIES.includes(sourceClassification)) throw new TypeError(`Unknown D11 source classification: ${sourceClassification}`);
  const definition = Object.freeze({ ...getD11Scenario(scenario), ...(sourceClassification ? { source: sourceClassification } : {}) });
  const calls = [];
  let sequence = 0;
  let state = initialState(definition, seed, providerDeployments, now);

  async function dispatch(action) {
    if (!action || typeof action.type !== "string") throw new TypeError("D11 actions require an explicit type");
    sequence += 1;
    const call = recordCall(calls, sequence, action, seed, now);
    let result;
    if (action.type === "select_deployment") result = selectDeployment(action.deploymentId);
    else if (action.type === "select_release") result = selectRelease(action.releaseId);
    else if (action.type === "filter_logs") result = filterLogs(action);
    else if (action.type === "load_older_logs") result = loadOlderLogs();
    else if (action.type === "toggle_log_follow") result = toggleLogFollow(action.follow);
    else if (action.type === "review_action") result = reviewAction(action.actionId, action.releaseId);
    else if (action.type === "cancel_review") result = cancelReview();
    else if (action.type === "confirm_action") result = await confirmAction(action);
    else if (action.type === "copy_dns_instructions") result = copyDnsInstructions();
    else if (action.type === "export_fixture") result = await exportFixture(action);
    else return unavailable("unsupported_deployment_action", action.type);
    state.lastAction = Object.freeze({ requestId: call.requestId, type: action.type, result: clone(result) });
    refreshDerived();
    return Object.freeze({ result, state: snapshot() });
  }

  function selectDeployment(deploymentId) {
    if (!state.deployments.some((item) => item.id === deploymentId)) return unavailable("deployment_unknown", "deployment");
    state.selectedDeploymentId = deploymentId;
    return ok("deployment_selected", { deploymentId });
  }

  function selectRelease(releaseId) {
    if (!state.releases.some((item) => item.id === releaseId)) return unavailable("release_unknown", "release");
    state.selectedReleaseId = releaseId;
    return ok("release_selected", { releaseId });
  }

  function filterLogs({ phase = state.logs.filter.phase, severity = state.logs.filter.severity, search = state.logs.filter.search } = {}) {
    if (phase !== "all" && !DEPLOYMENT_PHASES.includes(phase)) return unavailable("log_phase_unknown", "logs");
    if (!["all", "info", "warning", "error"].includes(severity)) return unavailable("log_severity_unknown", "logs");
    state.logs = Object.freeze({ ...state.logs, filter: Object.freeze({ phase, severity, search: bounded(search, 120) }) });
    return ok("log_filter_updated");
  }

  function loadOlderLogs() {
    if (!state.logs.available || !state.logs.hasOlder) return unavailable("older_logs_unavailable", "logs");
    const older = createOlderLogs(now).map(redactLog);
    state.logs = Object.freeze({ ...state.logs, items: Object.freeze([...older, ...state.logs.items]), hasOlder: false });
    return ok("older_logs_loaded", { count: older.length });
  }

  function toggleLogFollow(follow) {
    state.logs = Object.freeze({ ...state.logs, follow: follow === true });
    return ok("log_follow_updated", { follow: state.logs.follow });
  }

  function reviewAction(actionId, releaseId) {
    const descriptor = state.actions.find((item) => item.id === actionId);
    if (!descriptor) return unavailable("deployment_action_unknown", actionId);
    if (!descriptor.enabled) return unavailable(descriptor.availability, actionId);
    const selectedRelease = releaseId || (actionId === "rollback" ? state.previousReleaseId : null);
    if (actionId === "rollback" && !state.releases.some((item) => item.id === selectedRelease)) return unavailable("rollback_release_required", "rollback");
    state.pendingReview = Object.freeze({ actionId, releaseId: selectedRelease, confirmationRequired: ["unpublish", "rollback", "publish", "update"].includes(actionId), fixtureOnly: true, consequences: consequencesFor(actionId, state) });
    return ok("action_review_ready", { actionId, confirmationRequired: state.pendingReview.confirmationRequired });
  }

  function cancelReview() {
    state.pendingReview = null;
    return ok("action_review_canceled");
  }

  async function confirmAction(action) {
    const review = state.pendingReview;
    if (!review || review.actionId !== action.actionId) return unavailable("typed_action_review_required", action.actionId);
    if (review.confirmationRequired && action.confirmed !== true) return unavailable("explicit_confirmation_required", action.actionId);
    const descriptor = state.actions.find((item) => item.id === action.actionId);
    if (!descriptor?.enabled || descriptor.mode !== "fixture_only") return unavailable(descriptor?.availability || "capability_unavailable", action.actionId);
    const result = simulateFixtureAction(review, now);
    state.pendingReview = null;
    return result;
  }

  function simulateFixtureAction(review, clock) {
    if (review.actionId === "rollback") {
      const target = state.releases.find((item) => item.id === review.releaseId);
      if (!target || target.id === state.activeReleaseId) return unavailable("rollback_candidate_unavailable", "rollback");
      const from = state.activeReleaseId;
      state.activeReleaseId = target.id;
      state.selectedReleaseId = target.id;
      state.activations = Object.freeze([...state.activations, activation(`fixture-activation-${sequence}`, target.id, "rollback", clock)]);
      state.publishing = Object.freeze({ ...state.publishing, state: "published", summary: "Fixture rollback activated an immutable previous release." });
      const rollbackDeployment = fixtureDeployment({ id: `fixture-deployment-rollback-${sequence}`, releaseId: target.id, status: "rolled_back", clock });
      state.deployments = Object.freeze([rollbackDeployment, ...state.deployments]);
      state.selectedDeploymentId = rollbackDeployment.id;
      state.phases = Object.freeze(createPhases("rolled_back", clock));
      state.health = Object.freeze({ ...state.health, state: target.health, activeReleaseId: target.id, recovered: true });
      return ok("fixture_rollback_simulated", { fromReleaseId: from, activeReleaseId: target.id, fixtureOnly: true });
    }
    if (review.actionId === "unpublish") {
      const deactivatedReleaseId = state.activeReleaseId;
      state.activeReleaseId = null;
      state.selectedReleaseId = deactivatedReleaseId;
      state.publishing = Object.freeze({ ...state.publishing, state: "unpublished", summary: "Fixture application is unpublished; project and immutable release history remain." });
      const unpublishDeployment = fixtureDeployment({ id: `fixture-deployment-unpublish-${sequence}`, releaseId: deactivatedReleaseId, status: "unpublished", clock });
      state.deployments = Object.freeze([unpublishDeployment, ...state.deployments]);
      state.selectedDeploymentId = unpublishDeployment.id;
      state.phases = Object.freeze(createPhases("unpublished", clock));
      state.domain = Object.freeze({ ...state.domain, state: "removed" });
      state.health = Object.freeze({ ...state.health, state: "unknown", result: "Fixture application is unpublished.", activeReleaseId: null, consecutiveFailures: 0 });
      return ok("fixture_unpublish_simulated", { deactivatedReleaseId, fixtureOnly: true });
    }
    if (["publish", "update", "retry_deployment"].includes(review.actionId)) {
      const release = fixtureRelease(state.releases.length + 1, clock);
      state.releases = Object.freeze([...state.releases, release]);
      state.activeReleaseId = release.id;
      state.selectedReleaseId = release.id;
      state.activations = Object.freeze([...state.activations, activation(`fixture-activation-${sequence}`, release.id, review.actionId, clock)]);
      const liveDeployment = fixtureDeployment({ id: `fixture-deployment-${sequence}`, releaseId: release.id, status: "live", clock });
      state.deployments = Object.freeze([liveDeployment, ...state.deployments]);
      state.selectedDeploymentId = liveDeployment.id;
      state.phases = Object.freeze(createPhases("live", clock));
      state.publishing = Object.freeze({ ...state.publishing, state: "published", summary: "Fixture release is active. No production deployment occurred." });
      state.health = Object.freeze({ ...state.health, state: "healthy", activeReleaseId: release.id, recovered: true });
      return ok(`fixture_${review.actionId}_simulated`, { releaseId: release.id, fixtureOnly: true });
    }
    if (review.actionId === "configure_domain") { state.domain = Object.freeze({ ...state.domain, state: "pending_dns" }); return ok("fixture_domain_added", { fixtureOnly: true }); }
    if (review.actionId === "verify_domain") { state.domain = Object.freeze({ ...state.domain, state: "verified", lastCheckedAt: clock().toISOString() }); return ok("fixture_domain_verified", { fixtureOnly: true }); }
    if (review.actionId === "activate_domain") { state.domain = Object.freeze({ ...state.domain, state: "active", lastCheckedAt: clock().toISOString() }); return ok("fixture_domain_activated", { fixtureOnly: true }); }
    if (review.actionId === "remove_domain") { state.domain = Object.freeze({ ...state.domain, state: "removed" }); return ok("fixture_domain_removed", { fixtureOnly: true }); }
    return unavailable("capability_unavailable", review.actionId);
  }

  function copyDnsInstructions() {
    if (!["pending_dns", "verification_required", "verification_failed"].includes(state.domain.state)) return unavailable("dns_instructions_unavailable", "domain");
    return ok("fixture_dns_instructions_ready", { instructions: clone(state.domain.instructions), fixtureOnly: true });
  }

  async function exportFixture(action) {
    const descriptor = state.actions.find((item) => item.id === "export");
    if (!descriptor?.enabled) return unavailable(descriptor?.availability || "capability_unavailable", "export");
    const payload = createSafeExport(state, now);
    let artifact = Object.freeze({ id: payload.id, kind: "fixture_deployment_export", storage: "fixture_memory", localOnly: true, uploaded: false, bytes: Buffer.byteLength(payload.content), content: payload.content });
    if (exportAdapter?.write) artifact = await exportAdapter.write(payload);
    if (artifact?.ok === false) return artifact;
    state.exports = Object.freeze([...state.exports, clone(artifact)]);
    return ok("fixture_export_created", { artifact: clone(artifact), fixtureOnly: true });
  }

  function refreshDerived() {
    const active = state.releases.find((item) => item.id === state.activeReleaseId) || null;
    const ordered = [...state.releases].sort((a, b) => b.order - a.order);
    const previous = ordered.find((item) => item.id !== state.activeReleaseId && item.outcome === "succeeded") || null;
    state.previousReleaseId = previous?.id || null;
    state.releasePresentation = Object.freeze(state.releases.map((release) => Object.freeze({
      ...release,
      activationState: release.id === state.activeReleaseId ? "current" : release.id === previous?.id ? "previous" : "historical",
      rollbackCandidate: Boolean(active && release.id !== active.id && release.outcome === "succeeded"),
    })));
    state.actions = createActions(state);
    state.currentDeploymentActive = ACTIVE_DEPLOYMENT_STATES.includes(state.deployments[0]?.status);
    state.filteredLogs = Object.freeze(filterLogItems(state.logs));
    state.selectedDeployment = state.deployments.find((item) => item.id === state.selectedDeploymentId) || state.deployments[0] || null;
    state.selectedRelease = state.releases.find((item) => item.id === state.selectedReleaseId) || active || previous || null;
    state.health = Object.freeze({ ...state.health, activeReleaseId: state.activeReleaseId });
    state.publishing = Object.freeze({ ...state.publishing, currentActivatedReleaseId: state.activeReleaseId });
  }

  function snapshot() { refreshDerived(); return clone(state); }
  function getCalls() { return Object.freeze(calls.map(clone)); }
  refreshDerived();
  return Object.freeze({ dispatch, snapshot, getCalls });
}

function initialState(definition, seed, providerDeployments, now) {
  let releases = createReleases(definition.history, now);
  const latestOutcome = ACTIVE_DEPLOYMENT_STATES.includes(definition.deployment) ? "pending" : definition.deployment === "failed" ? "failed" : definition.deployment === "canceled" ? "canceled" : "succeeded";
  if (releases.length && latestOutcome !== "succeeded") releases = Object.freeze(releases.map((release, index) => index === releases.length - 1 ? Object.freeze({ ...release, outcome: latestOutcome, health: latestOutcome === "failed" ? "unhealthy" : "unknown" }) : release));
  const latestReleaseId = releases.at(-1)?.id || null;
  const activeReleaseId = ["first-publish-pending", "first-publish-failure", "deployment-canceled", "unpublished"].includes(definition.name)
    ? null
    : ["update-deploying", "update-failed", "rollback-simulated-success", "rollback-failed"].includes(definition.name)
      ? releases.at(-2)?.id || null
      : latestReleaseId;
  const executionReleaseId = definition.name === "rollback-simulated-success" ? activeReleaseId : latestReleaseId;
  const deployment = definition.history || definition.deployment !== "unpublished"
    ? fixtureDeployment({ id: "fixture-deployment-current", releaseId: executionReleaseId, status: definition.deployment, clock: now })
    : null;
  const deployments = deployment ? [deployment, ...createHistoricalDeployments(releases, now)] : [];
  const logsAvailable = definition.logs === "available";
  return {
    schemaVersion: 1, source: "deterministic_fixture", seed, scenario: definition.name, observedAt: now().toISOString(),
    project: Object.freeze({ id: "fixture-project-0001", name: "Fixture storefront", applicationName: "Fixture storefront", presentationIdentity: "Fixture project" }),
    sourceIdentity: sourceIdentity(definition.source),
    publishing: Object.freeze({ state: definition.publishing, workspaceState: definition.source === "fixture_source" ? "fixture_ready" : "source_pending_verification", summary: publishingSummary(definition.publishing), currentActivatedReleaseId: activeReleaseId }),
    deployments: Object.freeze(deployments), releases: Object.freeze(releases), activeReleaseId, previousReleaseId: null,
    selectedDeploymentId: deployments[0]?.id || null, selectedReleaseId: activeReleaseId,
    phases: Object.freeze(createPhases(definition.deployment, now)),
    logs: Object.freeze({ available: logsAvailable, state: logsAvailable ? "available" : "unavailable", items: Object.freeze(logsAvailable ? createLogs(now).map(redactLog) : []), filter: Object.freeze({ phase: "all", severity: "all", search: "" }), follow: ACTIVE_DEPLOYMENT_STATES.includes(definition.deployment), hasOlder: logsAvailable, retention: logsAvailable ? "Fixture evidence retained for this deterministic session." : "Retention unavailable." }),
    filteredLogs: Object.freeze([]), health: health(definition.health, activeReleaseId, now), domain: domain(definition.domain, now),
    actions: Object.freeze([]), pendingReview: null, activations: Object.freeze(activeReleaseId ? [activation("fixture-activation-current", activeReleaseId, "publish", now)] : []),
    exports: Object.freeze([]), exportAvailable: definition.export, providerRead: normalizeProviderRead(providerDeployments), currentDeploymentActive: false,
    selectedDeployment: null, selectedRelease: null, releasePresentation: Object.freeze([]), lastAction: null,
    boundaries: Object.freeze({ canonicalSource: "integration_pending_D7", builderV2PublishSource: "integration_pending_track_b", productionMutations: "capability_unavailable", productionDomains: "capability_unavailable", productionRollback: "capability_unavailable", productionExport: "capability_unavailable", buildr101Routes: "forbidden" }),
  };
}

function createActions(state) {
  const fixture = state.sourceIdentity.classification === "fixture_source";
  const sourceBlocked = ["future_verified_snapshot", "future_git_revision"].includes(state.sourceIdentity.classification);
  const publishingUnavailable = state.deployments[0]?.status === "capability_unavailable";
  const canPublish = ["never_published", "draft", "unpublished", "publish_failed"].includes(state.publishing.state);
  const canUpdate = ["update_available", "update_failed"].includes(state.publishing.state);
  const canUnpublish = !["never_published", "unpublished"].includes(state.publishing.state) && Boolean(state.activeReleaseId);
  const canRollback = Boolean(state.previousReleaseId && state.activeReleaseId);
  const domainMutable = fixture && !publishingUnavailable;
  const descriptors = [
    descriptor("publish", "Publish", canPublish), descriptor("update", "Update release", canUpdate),
    descriptor("unpublish", "Unpublish application", canUnpublish, true), descriptor("rollback", "Rollback release", canRollback, true),
    descriptor("retry_deployment", "Retry deployment", ["failed", "canceled"].includes(state.deployments[0]?.status)),
    descriptor("configure_domain", "Add domain", ["none", "removed"].includes(state.domain.state) && domainMutable),
    descriptor("verify_domain", "Verify domain", ["pending_dns", "verification_required", "verification_failed"].includes(state.domain.state) && domainMutable),
    descriptor("activate_domain", "Activate domain", ["verified", "certificate_pending"].includes(state.domain.state) && domainMutable),
    descriptor("remove_domain", "Remove domain", !["none", "removed", "unavailable"].includes(state.domain.state) && domainMutable, true),
    descriptor("copy_dns_instructions", "Copy DNS instructions", ["pending_dns", "verification_required", "verification_failed"].includes(state.domain.state), false, "local_safe"),
    descriptor("export", "Export fixture evidence", state.exportAvailable, false, "local_safe"),
  ];
  return Object.freeze(descriptors.map((item) => {
    if (sourceBlocked) return Object.freeze({ ...item, enabled: false, mode: "integration_pending", availability: "verified_source_required", explanation: "D7 verified source identity is required before production publishing." });
    if (!fixture || publishingUnavailable) return Object.freeze({ ...item, enabled: false, mode: "unavailable", availability: "capability_unavailable", explanation: "Production deployment mutations are unavailable in D11 Foundation." });
    return item;
  }));
}

function descriptor(id, label, enabled, destructive = false, mode = "fixture_only") { return Object.freeze({ id, label, enabled: Boolean(enabled), destructive, mode, availability: enabled ? mode : "capability_unavailable", explanation: enabled ? (mode === "fixture_only" ? "Deterministic fixture transition only; production is never contacted." : "Local-safe fixture action.") : "Unavailable for the current fixture state." }); }
function sourceIdentity(classification) { return Object.freeze({ classification, label: classification === "fixture_source" ? "Deterministic fixture source" : classification === "local_source_unverified" ? "Local source is unverified" : classification === "future_verified_snapshot" ? "Verified snapshot required" : classification === "future_git_revision" ? "Git revision integration pending" : "Source identity unavailable", verified: classification === "fixture_source", canonicalSnapshotId: null, gitRevision: null, dirty: classification === "local_source_unverified", reason: classification === "fixture_source" ? "fixture_only" : "source_pending_verification" }); }

function createReleases(count, now) { const releases = []; for (let index = 1; index <= count; index += 1) releases.push(fixtureRelease(index, () => new Date(now().getTime() - (count - index) * 86400000))); return releases; }
function fixtureRelease(order, clock) { return Object.freeze({ id: `fixture-release-${String(order).padStart(4, "0")}`, version: `r${order}`, order, source: sourceIdentity("fixture_source"), outcome: "succeeded", createdAt: clock().toISOString(), health: order % 3 === 1 ? "healthy" : order % 3 === 2 ? "degraded" : "healthy", domainHostname: "fixture.invalid", logsAvailable: true, testEvidenceAvailable: true }); }
function fixtureDeployment({ id, releaseId, status, clock }) { const active = ACTIVE_DEPLOYMENT_STATES.includes(status); const startedAt = clock().toISOString(); return Object.freeze({ id, releaseId, projectId: "fixture-project-0001", applicationName: "Fixture storefront", sourceClassification: "fixture_source", environment: "fixture", status, active, createdAt: startedAt, startedAt, completedAt: active ? null : startedAt, durationMs: active ? null : 18420, targetUrl: status === "live" || status === "degraded" || status === "unhealthy" || status === "update_available" ? "https://fixture.invalid" : null, healthState: status === "live" ? "healthy" : status === "degraded" ? "degraded" : status === "unhealthy" || status === "failed" ? "unhealthy" : "unknown", domainState: "fixture_only", logsAvailable: true, rollbackAvailable: Boolean(releaseId), updateAvailable: status === "update_available", unpublishAvailable: ["live", "degraded", "unhealthy", "update_available"].includes(status), exportAvailable: true }); }
function createHistoricalDeployments(releases, now) { return releases.slice(0, -1).reverse().map((release, index) => fixtureDeployment({ id: `fixture-deployment-history-${index + 1}`, releaseId: release.id, status: "live", clock: () => new Date(now().getTime() - (index + 1) * 86400000) })); }
function activation(id, releaseId, reason, clock) { return Object.freeze({ id, releaseId, reason, activatedAt: clock().toISOString(), fixtureOnly: true }); }
function createPhases(status, now) { const activeIndex = ({ queued: 0, building: 1, verifying: 2, deploying: 4 })[status]; return DEPLOYMENT_PHASES.map((phase, index) => Object.freeze({ id: phase, label: phase.replaceAll("_", " "), state: status === "failed" && index >= 2 ? (index === 2 ? "failed" : "not_started") : status === "canceled" && index >= 2 ? (index === 2 ? "canceled" : "not_started") : activeIndex != null ? index < activeIndex ? "completed" : index === activeIndex ? "active" : "pending" : ["live", "degraded", "unhealthy", "update_available", "rolled_back"].includes(status) ? "completed" : "not_started", timestamp: index <= (activeIndex ?? 7) ? new Date(now().getTime() + index * 1000).toISOString() : null })); }

function createLogs(now) { const raw = [
  ["source_preparation", "info", "Fixture source prepared without a canonical snapshot."],
  ["build", "info", "Build completed for deterministic fixture source."],
  ["verification", "warning", "Authorization: Bearer fake-bearer-token-abcdefghijklmnopqrstuvwxyz was redacted."],
  ["release_creation", "info", "Immutable fixture release metadata created."],
  ["deployment", "info", "Target https://fixture.invalid/callback?signature=fake-signed-value&view=safe is ready."],
  ["health_verification", "error", "Database postgresql://fixture_user:fake-password@db.fixture.invalid/app is unavailable."],
  ["domain_activation", "info", "DNS verification token=fake-dns-verification-secret accepted in fixture mode."],
  ["completion", "info", "Fixture deployment settled in a terminal state."],
]; return raw.map(([phase, severity, message], index) => Object.freeze({ id: `fixture-log-${index + 1}`, timestamp: new Date(now().getTime() + index * 1000).toISOString(), phase, severity, message, category: "fixture_deployment", metadata: Object.freeze({ attempt: 1, source: "fixture" }) })); }
function createOlderLogs(now) { return [Object.freeze({ id: "fixture-log-older-1", timestamp: new Date(now().getTime() - 3600000).toISOString(), phase: "source_preparation", severity: "info", message: "Older fixture source preparation record.", category: "fixture_history", metadata: Object.freeze({ retained: true }) })]; }
function redactLog(item) { return Object.freeze({ ...item, message: redactText(item.message), metadata: sanitizeMetadata(item.metadata) }); }
function filterLogItems(logs) { if (!logs.available) return []; const search = logs.filter.search.toLowerCase(); return logs.items.filter((item) => (logs.filter.phase === "all" || item.phase === logs.filter.phase) && (logs.filter.severity === "all" || item.severity === logs.filter.severity) && (!search || `${item.message} ${item.category}`.toLowerCase().includes(search))); }

function health(value, activeReleaseId, now) { return Object.freeze({ state: HEALTH_STATES.includes(value) ? value : "unknown", lastCheckedAt: value === "unavailable" ? null : now().toISOString(), endpoint: value === "unavailable" ? null : "/health", result: value === "healthy" ? "200 fixture response" : value === "degraded" ? "Fixture latency warning" : value === "unhealthy" ? "Fixture health check failed" : "No authoritative result", consecutiveFailures: value === "unhealthy" ? 3 : value === "degraded" ? 1 : 0, recovered: false, activeReleaseId }); }
function domain(value, now) { const state = DOMAIN_STATES.includes(value) ? value : "unavailable"; return Object.freeze({ id: "fixture-domain-0001", hostname: state === "none" ? null : "preview.fixture.invalid", state, instructions: Object.freeze({ recordType: "CNAME", recordName: "preview", expectedValue: "routing.fixture.invalid", verificationValue: "thrallo-verify-[synthetic]" }), lastCheckedAt: ["none", "unavailable"].includes(state) ? null : now().toISOString(), certificateState: state === "active" ? "active" : state === "certificate_failed" ? "failed" : "pending", fixtureOnly: true }); }
function publishingSummary(value) { return ({ never_published: "This fixture project has never been published.", draft: "Fixture source is a draft and is not public.", published: "A deterministic fixture release is active.", update_available: "Fixture workspace state differs from the active release.", unpublished: "The public fixture application is unavailable; history remains.", publishing: "A deterministic fixture deployment is active.", publish_failed: "The fixture first publish failed.", update_failed: "The fixture update failed; the previous release remains active.", unpublish_pending: "Fixture unpublish is pending.", unpublish_failed: "Fixture unpublish failed; the active release remains public.", rollback_available: "A prior immutable fixture release can be reviewed.", rollback_unavailable: "No rollback capability is available." })[value] || "Publishing state is unavailable."; }
function consequencesFor(actionId, state) { const map = { publish: ["Creates a new fixture release", "Does not contact production"], update: ["Creates a new immutable fixture release", "Keeps prior releases"], unpublish: ["Fixture public application becomes unavailable", "Project and release history remain", "Fixture domain is removed"], rollback: [`Activates ${state.previousReleaseId || "a prior release"}`, "Does not modify the prior release", "Records a new fixture activation event"], retry_deployment: ["Creates a new fixture attempt", "Does not reuse a production route"], configure_domain: ["Adds a synthetic fixture hostname"], verify_domain: ["Simulates DNS verification only"], activate_domain: ["Simulates fixture domain activation"], remove_domain: ["Removes only the fixture domain state"] }; return Object.freeze((map[actionId] || ["Fixture-only action"]).map(String)); }

function createSafeExport(state, now) { const content = JSON.stringify({ schemaVersion: 1, kind: "thrallo-fixture-deployment-export", exportedAt: now().toISOString(), project: state.project, sourceIdentity: state.sourceIdentity, publishing: state.publishing, deployments: state.deployments, releases: state.releases, activations: state.activations, logs: state.logs.items, health: state.health, domain: state.domain, boundaries: state.boundaries }, null, 2); return Object.freeze({ id: `fixture-export-${digest(`${state.seed}:${state.exports.length + 1}`)}`, name: `thrallo-fixture-deployment-${state.exports.length + 1}.json`, content: redactText(content, 500000), mimeType: "application/json" }); }
function normalizeProviderRead(value) { const items = Array.isArray(value) ? value : []; return Object.freeze({ classification: "stable_read_only_representation", items: Object.freeze(items.slice(0, 100).map((item) => Object.freeze({ id: bounded(item?.id, 120), status: bounded(item?.state || item?.status || "unknown", 80), sourceIdentityAccepted: false }))) }); }
function createDeploymentReadOnlyAdapter({ createStableReadOnlyProvider, transport, routes = {} } = {}) { if (typeof createStableReadOnlyProvider !== "function") throw new TypeError("D11 read-only adapter requires the D1 provider factory"); if (!transport?.request || !transport?.openEventStream) throw new TypeError("D11 read-only adapter requires injected transport"); const allowed = new Set(["listDeployments", "getDeployment", "getDomainStatus"]); for (const [operation, route] of Object.entries(routes)) { if (!allowed.has(operation)) throw new TypeError(`D11 read-only route rejected: ${operation}`); const method = String(route?.method || "GET").toUpperCase(); if (!["GET", "HEAD"].includes(method)) throw new TypeError(`D11 read-only route refuses ${method}`); const routePath = String(route?.path || ""); if (!routePath.startsWith("/") || routePath.startsWith("//") || /^https?:/i.test(routePath)) throw new TypeError("D11 routes must be origin-relative"); } return createStableReadOnlyProvider({ providerKey: "deployments", transport, operationMap: routes }); }

function redactText(value, limit = 4000) { return String(value ?? "")
  .replace(/\bbearer\s+[a-z0-9._~-]{12,}/gi, "Bearer [REDACTED]")
  .replace(/\b(?:sk|pk|sb|ghp|github_pat)_[a-z0-9_-]{8,}\b/gi, "[REDACTED]")
  .replace(/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s"']+/gi, "[REDACTED_DATABASE_URL]")
  .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@")
  .replace(/((?:token|secret|password|api[_-]?key|authorization|cookie|verification)\s*[:=]\s*)[^\s,;"}]+/gi, "$1[REDACTED]")
  .replace(/([?&](?:signature|sig|token|secret|key|auth|code|credential|session)=)[^&#\s]+/gi, "$1[REDACTED]")
  .slice(0, limit); }
function sanitizeMetadata(value) { if (!value || typeof value !== "object") return Object.freeze({}); return Object.freeze(Object.fromEntries(Object.entries(value).filter(([key]) => !/secret|token|cookie|authorization|credential|password|header|body/i.test(key)).map(([key, item]) => [bounded(key, 80), typeof item === "string" ? redactText(item, 500) : Number.isFinite(item) || typeof item === "boolean" ? item : "[REDACTED]"]))); }
function recordCall(calls, sequence, action, seed, now) { const entry = Object.freeze({ sequence, requestId: `fixture-d11-${digest(`${seed}:${sequence}:${action.type}`)}`, operation: action.type, observedAt: now().toISOString(), input: Object.freeze({ actionId: bounded(action.actionId, 80), deploymentId: bounded(action.deploymentId, 100), releaseId: bounded(action.releaseId, 100), confirmed: action.confirmed === true }) }); calls.push(entry); return entry; }
function fixtureNow() { return new Date(D11_FIXTURE_CLOCK); }
function digest(value) { let hash = 0x811c9dc5; for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193) >>> 0; return hash.toString(16).padStart(8, "0"); }
function bounded(value, limit = 500) { return String(value ?? "").replace(/[\r\n\0]/g, " ").slice(0, limit); }
function ok(state, data = {}) { return Object.freeze({ ok: true, state, sideEffects: true, source: "deterministic_fixture", ...data }); }
function unavailable(code, capability) { return Object.freeze({ ok: false, code, state: "capability_unavailable", capability, sideEffects: false }); }
function clone(value) { if (Array.isArray(value)) return Object.freeze(value.map(clone)); if (value && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).filter(([key]) => !/^(headers|cookies|authorization|requestBody|responseBody)$/i.test(key)).map(([key, item]) => [key, clone(typeof item === "string" ? redactText(item, 500000) : item)]))); return value; }

module.exports = {
  DEPLOYMENT_STATES, ACTIVE_DEPLOYMENT_STATES, PUBLISHING_STATES, SOURCE_IDENTITIES,
  HEALTH_STATES, DOMAIN_STATES, DEPLOYMENT_PHASES, ACTION_IDS, D11_FIXTURE_SEED,
  D11_FIXTURE_CLOCK, D11_SCENARIOS, getD11Scenario, createDeploymentController,
  createDeploymentReadOnlyAdapter, redactText,
};
