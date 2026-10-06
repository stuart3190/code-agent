import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertSandboxPinAllowed, deploymentProvenanceRecord, probeImageSandboxIdentity, sandboxPinDecision,
} from "../../ops/lib/sandboxImagePin.mjs";
import {
  SANDBOX_IDENTITY_FILES, VERIFIER_PATH, computeSandboxIdentity,
} from "../../shell/server/lib/builderV2/sandboxProvenance.mjs";

async function fixtureTree(overrides = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "thrallo-sandbox-pin-"));
  for (const relative of SANDBOX_IDENTITY_FILES) {
    await mkdir(path.join(dir, path.dirname(relative)), { recursive: true });
    await writeFile(path.join(dir, relative), overrides[relative] ?? `contents of ${relative}\n`, "utf8");
  }
  return dir;
}

const deployment = { manifestSha256: "a".repeat(64) };

test("provenance records the probed image identity, not the host identity", () => {
  const record = deploymentProvenanceRecord({
    commit: "c".repeat(40),
    deployment,
    imageCommit: "i".repeat(40),
    tag: "thrallo-build-sandbox:test",
    digest: "sha256:image",
    created: "2026-10-06T00:00:00.000Z",
    imageIdentity: { identity: "image-identity", verifier: "image-verifier", files: { [VERIFIER_PATH]: "image" } },
    pinnedAt: "2026-10-06T00:00:00.000Z",
  });
  assert.equal(record.sandboxIdentity, "image-identity");
  assert.equal(record.verifierHash, "image-verifier");
  assert.equal(record.files[VERIFIER_PATH], "image");
  assert.equal(record.sandboxImageSourceCommit, "i".repeat(40));
});

test("a missing image probe is stored as no identity and cannot be pinned", () => {
  const record = deploymentProvenanceRecord({
    commit: "c", deployment, imageCommit: "i", tag: "t", digest: "sha256:x", created: "now",
    imageIdentity: null, pinnedAt: "now",
  });
  assert.equal(record.sandboxIdentity, null);
  const decision = sandboxPinDecision({ identity: "host", verifier: "v", files: {} }, null, { imageDigest: "sha256:x" });
  assert.equal(decision.compatible, false);
  assert.equal(decision.code, "sandbox_version_mismatch");
  assert.throws(() => assertSandboxPinAllowed(decision), /refusing --pin/);
});

test("the probe runs sandbox_provenance inside the named image with docker forced", async () => {
  const provenance = { identity: "from-image", verifier: "v", files: {} };
  let seen;
  const result = await probeImageSandboxIdentity({
    image: "sha256:deadbeef",
    now: 1_700_000_000_000,
    runSandboxJob: async (job, options) => {
      seen = { job, options };
      return { provenance };
    },
  });
  assert.equal(result, provenance);
  assert.equal(seen.job.job_type, "sandbox_provenance");
  assert.equal(seen.job.id, `provenance-${(1_700_000_000_000).toString(36)}`);
  assert.equal(seen.options.image, "sha256:deadbeef");
  assert.equal(seen.options.docker, true);
  await assert.rejects(() => probeImageSandboxIdentity({ runSandboxJob: async () => ({}) }), /without a tag or digest/);
});

test("--pin is refused when the image verifier differs from the host", async () => {
  const host = await fixtureTree();
  const image = await fixtureTree({ [VERIFIER_PATH]: "stale verifier\n" });
  try {
    const decision = sandboxPinDecision(
      await computeSandboxIdentity({ root: host, commit: "host" }),
      await computeSandboxIdentity({ root: image, commit: "image" }),
      { imageDigest: "sha256:stale" },
    );
    assert.equal(decision.compatible, false);
    assert.equal(decision.code, "sandbox_version_mismatch");
    assert.ok(decision.mismatches.some((row) => row.file === VERIFIER_PATH));
    assert.throws(() => assertSandboxPinAllowed(decision), /refusing --pin/);
  } finally {
    await rm(host, { recursive: true, force: true });
    await rm(image, { recursive: true, force: true });
  }
});

test("--pin is allowed when the probed image matches the host, and a closure-only hash mismatch is refused", async () => {
  const hostDir = await fixtureTree();
  const imageDir = await fixtureTree();
  try {
    const host = await computeSandboxIdentity({ root: hostDir });
    const image = await computeSandboxIdentity({ root: imageDir });
    const decision = sandboxPinDecision(host, image, { imageDigest: "sha256:same" });
    assert.equal(decision.compatible, true);
    assert.equal(assertSandboxPinAllowed(decision).compatible, true);
    const closureSkew = sandboxPinDecision(
      { ...host, identity: "host-closure" },
      { ...image, identity: "image-closure" },
      { imageDigest: "sha256:same" },
    );
    assert.equal(closureSkew.compatible, false);
    assert.match(closureSkew.detail, /identity hash differs/);
    assert.throws(() => assertSandboxPinAllowed(closureSkew), /refusing --pin/);
  } finally {
    await rm(hostDir, { recursive: true, force: true });
    await rm(imageDir, { recursive: true, force: true });
  }
});
