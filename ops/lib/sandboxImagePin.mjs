// Pin provenance must describe the image that will grade builds, not the checkout that
// built it. On 2026-10-06 a noimage deploy left a stale sandbox in place while the pin
// record stamped the host identity, so the skew was invisible until sandbox_version_mismatch.
//
// The probe is the same sandbox_provenance job ops/prove-sandbox-provenance.mjs runs.
// --pin is refused unless that probed identity is compatible with the host.

import { compareSandboxIdentity } from "../../shell/server/lib/builderV2/sandboxProvenance.mjs";

export function sandboxProvenanceProbeJob(now = Date.now()) {
  return {
    id: `provenance-${now.toString(36)}`,
    job_type: "sandbox_provenance",
    attempts: 1,
    payload: {},
    resource_limits: { wallSeconds: 60, cpu: 1, memoryMb: 512, pids: 64, outputBytes: 256 * 1024 },
  };
}

/**
 * Run the provenance job inside `image` and return the identity that image reports.
 * Docker is forced: a THRALLO_BUILD_SANDBOX=process setting would hash the host and
 * recreate the bug this probe exists to catch.
 */
export async function probeImageSandboxIdentity({ image, runSandboxJob, artifactRoot = null, now = Date.now() } = {}) {
  if (!image) throw new Error("refusing to probe a sandbox image without a tag or digest");
  if (typeof runSandboxJob !== "function") throw new Error("sandbox probe requires runSandboxJob");
  const options = { image, docker: true };
  if (artifactRoot) options.artifactRoot = artifactRoot;
  const outcome = await runSandboxJob(sandboxProvenanceProbeJob(now), options);
  return outcome?.provenance || null;
}

export function deploymentProvenanceRecord({
  commit, deployment, imageCommit, tag, digest, created, imageIdentity, pinnedAt,
}) {
  return {
    sourceCommit: commit,
    deploymentManifestSha256: deployment.manifestSha256,
    sandboxImageSourceCommit: imageCommit,
    sandboxImageTag: tag,
    sandboxImageDigest: digest,
    sandboxImageCreated: created,
    sandboxIdentity: imageIdentity?.identity || null,
    verifierHash: imageIdentity?.verifier || null,
    files: imageIdentity?.files || null,
    pinnedAt: pinnedAt || new Date().toISOString(),
  };
}

/**
 * Host vs image, using the same comparison as prove-sandbox-provenance, plus the full
 * identity hash. compareSandboxIdentity checks the hand-listed verdict files; the hash
 * also covers their import closure. A closure-only skew is still incompatible.
 */
export function sandboxPinDecision(host, imageIdentity, { imageDigest = null } = {}) {
  const report = compareSandboxIdentity(host, {
    ...(imageIdentity || {}),
    imageDigest: imageDigest || imageIdentity?.imageDigest || null,
  });
  if (report.compatible && host?.identity !== imageIdentity?.identity) {
    return {
      ...report,
      compatible: false,
      code: "sandbox_version_mismatch",
      mismatches: [...report.mismatches, { file: "*", reason: "identity hash differs" }],
      detail: "the sandbox image identity hash differs from the host verdict-deciding closure",
    };
  }
  return report;
}

export function assertSandboxPinAllowed(decision) {
  if (decision?.compatible) return decision;
  const error = new Error(`refusing --pin: ${decision?.detail || "sandbox image is incompatible with the host"}`);
  error.code = decision?.code || "sandbox_version_mismatch";
  throw error;
}
