import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { resolveWorkerReleaseIdentity } from "../../shell/server/lib/builderV2/workerReleaseIdentity.mjs";

const COMMIT = "a".repeat(40);
const OLD = "b".repeat(40);
const MANIFEST = { gitCommit: COMMIT, manifestSha256: "c".repeat(64) };

test("durable worker identity comes from the deployment manifest, never a stale private env", async () => {
  const resolved = await resolveWorkerReleaseIdentity({
    env: { CODE_AGENT_STORE: "supabase", THRALLO_BUILD_WORKER_VERSION: OLD },
    readIdentity: async () => MANIFEST,
  });
  assert.equal(resolved.version, COMMIT);
  assert.equal(resolved.source, "deployment_manifest");
  assert.equal(resolved.configuredVersionDrift, true);
  assert.equal(resolved.manifestSha256, MANIFEST.manifestSha256);
});

test("durable workers fail closed without a validated manifest while local development can fall back", async () => {
  const missing = async () => { throw new Error("missing deployment manifest"); };
  await assert.rejects(resolveWorkerReleaseIdentity({
    env: { CODE_AGENT_STORE: "supabase", THRALLO_BUILD_WORKER_VERSION: OLD }, readIdentity: missing,
  }), (error) => error.code === "worker_release_identity_required");
  const local = await resolveWorkerReleaseIdentity({
    env: { CODE_AGENT_STORE: "memory", THRALLO_BUILD_WORKER_VERSION: OLD }, readIdentity: missing,
  });
  assert.equal(local.version, OLD);
  assert.equal(local.source, "development_environment");
});

test("worker startup, sandbox pin and post-restart gate share the manifest authority", async () => {
  const worker = await readFile(new URL("../../build-worker/index.mjs", import.meta.url), "utf8");
  const pin = await readFile(new URL("../../ops/pin-build-sandbox-image.mjs", import.meta.url), "utf8");
  const verify = await readFile(new URL("../../ops/verify-build-worker-release.mjs", import.meta.url), "utf8");
  assert.match(worker, /const RELEASE_IDENTITY = await resolveWorkerReleaseIdentity\(\)/);
  assert.match(worker, /const VERSION = RELEASE_IDENTITY\.version/);
  assert.match(pin, /const deployment = await readDeploymentIdentity/);
  assert.match(pin, /requestedCommit !== deployment\.gitCommit/);
  assert.match(verify, /requireFreshWorkerAdmission\(\{ client \}\)/);
  assert.match(verify, /zeroModel: true/);
});
