import assert from "node:assert/strict";
import {
  architectureMatrix, createAtomicUpdater, createCrashReport, createPrivateUpdateManifest,
  decideUpdate, evaluateReleaseEligibility, privateUpdateService, recoverDesktopState,
  sha256, validatePackagedDeepLink, validateUpdateManifest, verifyPrivateDownload,
} from "./releaseFoundation.mjs";

const bytes = Buffer.from("private-d15-artifact");
const manifest = createPrivateUpdateManifest({
  version: "0.4.0", platform: "win32", architecture: "x64", releaseChannel: "internal",
  artifactUri: "private-artifacts/thrallo-win32-x64.zip", artifactSha256: sha256(bytes), artifactSignatureState: "signed_valid",
  manifestSignature: "fixture-valid", signatureAlgorithm: "fixture_sha256_not_release",
  minimumCompatibleClient: "0.4.0", minimumCompatibleServerContract: "desktop-foundation-v1",
  rollbackEligible: true, publicationTimestamp: "2035-01-15T12:00:00.000Z", provenanceRef: "d15-private",
});

assert.equal(validateUpdateManifest(manifest, { verifyManifestSignature: (_payload, signature, algorithm) => signature === "fixture-valid" && algorithm === "fixture_sha256_not_release" }).ok, true);
assert.equal(decideUpdate({ currentVersion: "0.3.0", platform: "win32", architecture: "x64", clientContract: "0.4.0", serverContract: "desktop-foundation-v1", manifest }).state, "mandatory_compatibility_update");
assert.equal(verifyPrivateDownload({ manifest, bytes, platform: "win32", architecture: "x64", allowedArtifactRoot: "private-artifacts", signatureState: "signed_valid", signatureIdentity: "Thrallo Development Fixture", expectedSignatureIdentity: "Thrallo Development Fixture" }).ok, true);

const updater = createAtomicUpdater({ previousVersion: "0.3.0", targetVersion: "0.4.0" });
for (const state of ["downloading", "verifying", "staged", "restart_required", "applying", "validating_startup", "startup_failed"]) updater.transition(state);
assert.equal(updater.rollback("startup validation failed").state, "rolled_back");
assert.equal(recoverDesktopState({ terminalWasRunning: true, previewWasRunning: true, updateState: "applying" }).projectSourceModified, false);
assert.doesNotMatch(JSON.stringify(createCrashReport({ consent: true, stack: "Bearer fake-secret-token at C:\\fixture\\app.js", desktopVersion: "0.4.0" })), /fake-secret-token|C:\\fixture/);
assert.equal(validatePackagedDeepLink("thrallo://auth/callback?code=fixture-code&state=fixture-state").ok, true);
assert.equal(architectureMatrix()["darwin-arm64"].built, false);
assert.equal(evaluateReleaseEligibility({ sourceProvenance: true }).eligible, false);
const service = privateUpdateService();
assert.equal(service.request("publish").code, "production_publication_forbidden");
assert.equal(service.calls().length, 1);

console.log("D15 release foundation smoke passed (12/12; private/fixture only).");
