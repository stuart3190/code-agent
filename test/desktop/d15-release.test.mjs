import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  ARCHITECTURES, ATOMIC_UPDATE_STATES, D15_ALLOWED_CHANNELS, PRODUCT_ID, RELEASE_CHANNELS,
  SIGNING_POLICY, architectureMatrix, createAtomicUpdater, createBuildInputManifest,
  createCrashReport, createPrivateUpdateManifest, decideUpdate, evaluateReleaseEligibility,
  manifestPayload, privateUpdateService, recoverDesktopState, selectRollback, sha256, stableJson,
  validatePackagedDeepLink, validateUpdateManifest, verifyArtifactSignature, verifyPrivateDownload,
} from "../../desktop/release/releaseFoundation.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const fixtureBytes = Buffer.from("d15-private-artifact");

function updateManifest(overrides = {}) {
  return createPrivateUpdateManifest({
    version: "0.4.0", platform: "win32", architecture: "x64", releaseChannel: "internal",
    artifactUri: "private-artifacts/thrallo-win32-x64.zip", artifactSha256: sha256(fixtureBytes), artifactSignatureState: "signed_valid",
    manifestSignature: "fixture-signature", signatureAlgorithm: "fixture_sha256_not_release",
    releaseNotesRef: "private-release-notes", minimumCompatibleClient: "0.4.0",
    minimumCompatibleServerContract: "desktop-foundation-v1", rollbackEligible: true,
    publicationTimestamp: "2035-01-15T12:00:00.000Z", provenanceRef: "private-provenance", ...overrides,
  });
}

const verifyFixtureManifest = (_payload, signature, algorithm) => signature === "fixture-signature" && algorithm === "fixture_sha256_not_release";

test("release channels and signing policy fail closed for D15", () => {
  assert.deepEqual(RELEASE_CHANNELS, ["internal", "canary", "opt_in_stable", "stable"]);
  assert.deepEqual(D15_ALLOWED_CHANNELS, ["internal"]);
  assert.equal(SIGNING_POLICY.windows.requiredForCustomerRelease, true);
  assert.equal(SIGNING_POLICY.macos.requiredForCustomerRelease, true);
  assert.equal(SIGNING_POLICY.linux.requiredForCustomerRelease, true);
  assert.equal(SIGNING_POLICY.privateKeysInRepository, false);
  assert.throws(() => updateManifest({ releaseChannel: "stable" }), /internal/);
});

test("reproducible input manifests are deterministic and target constrained", () => {
  const input = { sourceCommit: "a".repeat(40), sourceTree: "b".repeat(40), desktopBranch: "desktop/foundation", codeOssCommit: "3a03d6f72d628a7741c29f456b4ddbb5ae68502c", desktopVersion: "0.4.0", nodeVersion: "24.18.0", packageManager: "npm@11.13.0", lockfileSha256: "c".repeat(64), target: "win32", architecture: "x64", operatingSystem: "windows", buildTools: { inno: "6" }, overlaySha256: "d".repeat(64), extensionSha256: "e".repeat(64) };
  assert.deepEqual(createBuildInputManifest(input), createBuildInputManifest(input));
  assert.equal(createBuildInputManifest(input).inputIdentity.length, 64);
  assert.throws(() => createBuildInputManifest({ ...input, architecture: "mips" }), /Unsupported/);
});

test("Code OSS dependency restore precedes Copilot exclusion on every install", () => {
  const build = fs.readFileSync(path.join(root, "desktop/build.mjs"), "utf8");
  const installBranch = build.slice(build.indexOf('command === "install"'), build.indexOf('command === "compile"'));
  assert.ok(installBranch.indexOf("restoreCopilotForDependencyInstall()") < installBranch.indexOf('run("npm", ["ci"])'));
  assert.ok(installBranch.indexOf('run("npm", ["ci"])') < installBranch.indexOf("applyCopilotExclusion()"));
  const bootstrap = fs.readFileSync(path.join(root, "desktop/bootstrap.mjs"), "utf8");
  assert.match(bootstrap, /git.*restore.*extensions\/copilot/s);
});

test("signature verification distinguishes every required failure state", () => {
  const base = { artifactHash: "a", expectedHash: "a", signatureState: "signed_valid", identity: "Thrallo", expectedIdentity: "Thrallo" };
  assert.equal(verifyArtifactSignature(base).state, "signed_valid");
  assert.equal(verifyArtifactSignature({ ...base, signatureState: "unsigned" }).code, "unsigned");
  assert.equal(verifyArtifactSignature({ ...base, signatureState: "signed_invalid" }).code, "signed_invalid");
  assert.equal(verifyArtifactSignature({ ...base, identity: "Other" }).code, "identity_mismatch");
  assert.equal(verifyArtifactSignature({ ...base, artifactHash: "bad" }).code, "hash_mismatch");
});

test("private update manifest is versioned, signed, and customer-inert", () => {
  const manifest = updateManifest();
  assert.equal(manifest.product, PRODUCT_ID);
  assert.equal(manifest.classification, "PRIVATE_NOT_CUSTOMER_RELEASED");
  assert.equal(validateUpdateManifest(manifest, { verifyManifestSignature: verifyFixtureManifest }).ok, true);
  assert.equal(validateUpdateManifest({ ...manifest, manifestSignature: "bad" }, { verifyManifestSignature: verifyFixtureManifest }).code, "bad_signature");
  assert.ok(!manifestPayload(manifest).includes("manifestSignature"));
});

test("update decision engine covers availability, compatibility, withdrawal and rollback", () => {
  const base = { currentVersion: "0.4.0", platform: "win32", architecture: "x64", clientContract: "0.4.0", serverContract: "desktop-foundation-v1", manifest: updateManifest({ version: "0.5.0" }) };
  assert.equal(decideUpdate(base).state, "upgrade_available");
  assert.equal(decideUpdate({ ...base, currentVersion: "0.5.0" }).state, "no_update");
  assert.equal(decideUpdate({ ...base, currentVersion: "0.3.0" }).state, "mandatory_compatibility_update");
  assert.equal(decideUpdate({ ...base, online: false }).state, "offline");
  assert.equal(decideUpdate({ ...base, manifest: null }).state, "manifest_unavailable");
  assert.equal(decideUpdate({ ...base, signatureValid: false }).state, "bad_signature");
  assert.equal(decideUpdate({ ...base, artifactHashValid: false }).state, "bad_hash");
  assert.equal(decideUpdate({ ...base, architecture: "arm64" }).state, "incompatible_client");
  assert.equal(decideUpdate({ ...base, serverContract: "other" }).state, "incompatible_server_contract");
  assert.equal(decideUpdate({ ...base, manifest: updateManifest({ rolloutEligible: false }) }).state, "staged_rollout_unavailable");
  assert.equal(decideUpdate({ ...base, manifest: updateManifest({ withdrawn: true }), previousCompatibleVersion: "0.3.0" }).state, "rollback_available");
  assert.equal(decideUpdate({ ...base, currentVersion: "0.6.0" }).state, "downgrade_blocked");
});

test("private download rejects arbitrary references and verifies before execution", () => {
  const base = { manifest: updateManifest(), bytes: fixtureBytes, platform: "win32", architecture: "x64", allowedArtifactRoot: "private-artifacts", signatureState: "signed_valid", signatureIdentity: "Thrallo", expectedSignatureIdentity: "Thrallo" };
  assert.equal(verifyPrivateDownload(base).ok, true);
  assert.equal(verifyPrivateDownload({ ...base, bytes: Buffer.from("tampered") }).code, "hash_mismatch");
  assert.equal(verifyPrivateDownload({ ...base, manifest: updateManifest({ artifactUri: "other/location.zip" }) }).code, "artifact_reference_rejected");
  assert.equal(verifyPrivateDownload({ ...base, manifest: updateManifest({ artifactUri: "private-artifacts/a.zip?token=fake" }) }).code, "artifact_reference_rejected");
  assert.equal(verifyPrivateDownload({ ...base, signatureState: "unsigned" }).code, "unsigned");
});

test("atomic updater retains the prior release and rolls back startup failure", () => {
  assert.ok(ATOMIC_UPDATE_STATES.includes("validating_startup"));
  const updater = createAtomicUpdater({ previousVersion: "0.3.0", targetVersion: "0.4.0" });
  for (const state of ["downloading", "verifying", "staged", "restart_required", "applying", "validating_startup", "startup_failed"]) updater.transition(state);
  assert.equal(updater.snapshot().priorReleaseRetained, true);
  assert.equal(updater.rollback("failed").state, "rolled_back");
  assert.throws(() => updater.transition("succeeded"), /Invalid/);
});

test("rollback selection blocks incompatible or unsigned persistent state", () => {
  const candidates = [
    { version: "0.3.0", stateFormatVersion: 1, signatureState: "unsigned" },
    { version: "0.2.0", stateFormatVersion: 2, signatureState: "signed_valid" },
    { version: "0.1.0", stateFormatVersion: 1, signatureState: "signed_valid" },
  ];
  assert.equal(selectRollback({ currentVersion: "0.4.0", candidates, stateFormatVersion: 1 }).version, "0.1.0");
  assert.equal(selectRollback({ currentVersion: "0.4.0", candidates: [], stateFormatVersion: 1 }).code, "rollback_unavailable");
});

test("crash and restart recovery never rewrite project source", () => {
  const recovery = recoverDesktopState({ workspaceExists: true, terminalWasRunning: true, previewWasRunning: true, updateState: "applying", metadataCorrupt: true });
  assert.equal(recovery.projectSourceModified, false);
  assert.equal(recovery.terminal, "stale_cleared");
  assert.equal(recovery.preview, "stale_cleared");
  assert.equal(recovery.update, "rollback_previous_release");
  assert.equal(recovery.metadata, "quarantine_and_recreate");
});

test("opt-in crash reports contain only allowed redacted metadata", () => {
  const report = createCrashReport({ consent: true, desktopVersion: "0.4.0", codeOssVersion: "1.131.0", platform: "win32", architecture: "x64", workspaceMode: "local_folder", component: "renderer", classification: "unexpected_exit", correlationId: "fixture-correlation", stack: "Bearer fake-token-value\n at C:\\Users\\Fixture\\secret.js\npassword=hunter22", fileContents: "must-not-appear", environment: { SECRET: "must-not-appear" } });
  const serialized = JSON.stringify(report);
  assert.equal(report.uploadEnabled, false);
  assert.doesNotMatch(serialized, /fake-token-value|hunter22|must-not-appear|Users\\\\Fixture/);
  assert.ok(serialized.includes("[REDACTED]"));
});

test("packaged deep-link boundary accepts only the D2 callback route", () => {
  assert.equal(validatePackagedDeepLink("thrallo://auth/callback?code=fixture&state=fixture-state").state, "forward_to_d2_controller");
  for (const uri of ["thrallo://other/callback?code=a&state=b", "thrallo://auth/callback?code=a", "thrallo://auth/callback?code=a&state=b&token=x", "not a url"]) assert.equal(validatePackagedDeepLink(uri).ok, false);
});

test("architecture matrix never confuses configuration with qualification", () => {
  const matrix = architectureMatrix({ "win32-x64": { buildAttempted: true, built: true, packaged: true, smokeTested: true } });
  assert.deepEqual(Object.keys(matrix), ARCHITECTURES);
  assert.equal(matrix["win32-x64"].signed, false);
  assert.equal(matrix["win32-x64"].releaseEligible, false);
  for (const id of ["darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"]) {
    assert.equal(matrix[id].configured, true);
    assert.equal(matrix[id].built, false);
  }
});

test("release eligibility requires every gate and never authorizes publication", () => {
  const green = Object.fromEntries(["sourceProvenance", "protectedPaths", "build", "tests", "packageSmoke", "artifactHash", "signing", "updateManifest", "securityRedaction", "platformQualification", "rollbackArtifact", "noBlockingDefect"].map((key) => [key, true]));
  assert.equal(evaluateReleaseEligibility(green).eligible, true);
  assert.equal(evaluateReleaseEligibility(green).publicationAuthorized, false);
  const unsigned = evaluateReleaseEligibility({ ...green, signing: false });
  assert.equal(unsigned.eligible, false);
  assert.deepEqual(unsigned.failedGates, ["signing"]);
});

test("private update service is deterministic and forbids customer publication", () => {
  const a = privateUpdateService("same-seed");
  const b = privateUpdateService("same-seed");
  assert.equal(a.request("check", { version: "0.4.0" }).state, "fixture_recorded");
  assert.equal(b.request("check", { version: "0.4.0" }).state, "fixture_recorded");
  assert.deepEqual(a.calls(), b.calls());
  assert.equal(a.request("publish").code, "production_publication_forbidden");
  assert.equal(a.request("activate_customer_channel").code, "production_publication_forbidden");
});

test("D15 has no production release, Builder V2, Buildr101 or credential dependency", () => {
  const source = fs.readFileSync(path.join(root, "desktop/release/releaseFoundation.mjs"), "utf8");
  assert.doesNotMatch(source, /fetch\s*\(|XMLHttpRequest|WebSocket\s*\(/);
  assert.doesNotMatch(source, /shell\/server|builderV2|runtime-worker|projectSecrets|capabilityRuntime/);
  assert.doesNotMatch(source, /process\.env/);
  assert.doesNotMatch(source, /-----BEGIN PRIVATE KEY-----\r?\nMII/);
  assert.doesNotMatch(stableJson(privateUpdateService().calls()), /credential|token|secret/i);
});

test("public 0.4.0 comparison inputs are outside the D15 write set", () => {
  const baseline = JSON.parse(fs.readFileSync(path.join(root, "desktop/release/public-0.4.0-baseline.json"), "utf8"));
  assert.equal(baseline.changedByD15, false);
  for (const item of baseline.files) {
    const bytes = fs.readFileSync(path.join(root, item.path));
    assert.equal(bytes.length, item.sizeBytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), item.sha256);
  }
});
