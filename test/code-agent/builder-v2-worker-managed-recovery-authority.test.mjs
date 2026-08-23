import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertWorkerCredentialAuthority,
  workerManagedRecoveryConfiguration,
} from "../../build-worker/runtimeConfig.mjs";
import { createPreviewIsolationReadiness } from "../../build-worker/previewIsolationReadiness.mjs";
import { safeChildEnvironment } from "../../build-worker/sandboxRunner.mjs";
import { resolveBuildContext, resolveManagedRecoveryContext } from "../../shell/server/lib/appBuild/buildContext.mjs";
import { redactDiagnosticText } from "../../shell/server/lib/appBuild/buildDiagnostics.mjs";
import { requireFreshWorkerAdmission } from "../../shell/server/lib/builderV2/workerAdmission.mjs";

const NOW = Date.parse("2026-08-23T08:00:00.000Z");
const JOB_TYPES = ["builder_pipeline", "compile", "browser_verify"];
const ADMISSION_ENV = { THRALLO_BUILD_WORKER_ENABLED: "1", THRALLO_BUILD_WORKER_VERSION: "release-1" };
const PRIVATE_ENV = Object.freeze({
  PREVIEW_MODE: "vps",
  PROVISIOND_URL: "http://127.0.0.1:8791",
  PROVISIOND_TOKEN: "preview-private-test-token",
  CODE_AGENT_STORE: "supabase",
  PLATFORM_ENC_KEY: "platform-private-test-key",
});

function passingProof() {
  return {
    status: "passed", checkedAt: new Date(NOW).toISOString(), resolvedMode: "vps",
    health: { reachable: true, capacity: 4 },
    preview: { mode: "vps", markerMatched: true }, teardown: { stopped: true, absent: true },
  };
}

function clientFor(node) {
  return { from: () => ({ select: async () => ({ data: [node], error: null }) }) };
}

test("managed recovery authority is required before a worker can advertise Builder V2", async () => {
  assert.throws(
    () => assertWorkerCredentialAuthority(JOB_TYPES, PRIVATE_ENV),
    (error) => error.code === "managed_recovery_credential_required"
      && /no customer state was created/.test(error.message),
  );

  let node;
  let readiness;
  readiness = createPreviewIsolationReadiness({
    enabled: true,
    prove: async () => {
      assertWorkerCredentialAuthority(JOB_TYPES, PRIVATE_ENV);
      return passingProof();
    },
    publish: async (proof) => {
      node = {
        worker_id: "worker-1", version: "release-1", state: "active", current_job_id: null,
        heartbeat_at: new Date(NOW).toISOString(), job_types: readiness.jobTypes(JOB_TYPES),
        metadata: { configuredJobTypes: JOB_TYPES, previewIsolation: proof },
      };
    },
    refreshMs: 240_000, retryMs: 30_000, jitterMs: 0, now: () => NOW,
    setTimer: () => ({ unref() {} }), clearTimer: () => {},
  });
  await readiness.start();
  assert.equal(node.metadata.previewIsolation.code, "managed_recovery_credential_required");
  assert.ok(!node.job_types.includes("builder_pipeline"));
  await assert.rejects(
    requireFreshWorkerAdmission({ client: clientFor(node), env: ADMISSION_ENV, now: NOW }),
    (error) => error.code === "managed_recovery_credential_required",
  );
  readiness.stop();
});

test("present managed recovery authority permits zero-model worker admission", async () => {
  const secret = "sk-test-managed-recovery-private-123456789";
  const env = { ...PRIVATE_ENV, OPENAI_API_KEY: secret };
  assert.deepEqual(workerManagedRecoveryConfiguration(env), {
    available: true, provider: "openai", billingLane: "managed", fundingPool: "thrallo_recovery",
  });
  assert.deepEqual(assertWorkerCredentialAuthority(JOB_TYPES, env), {
    available: true, provider: "openai", billingLane: "managed", fundingPool: "thrallo_recovery",
  });

  let node;
  let readiness;
  readiness = createPreviewIsolationReadiness({
    enabled: true,
    prove: async () => {
      assertWorkerCredentialAuthority(JOB_TYPES, env);
      return passingProof();
    },
    publish: async (proof) => {
      node = {
        worker_id: "worker-1", version: "release-1", state: "active", current_job_id: null,
        heartbeat_at: new Date(NOW).toISOString(), job_types: readiness.jobTypes(JOB_TYPES),
        metadata: { configuredJobTypes: JOB_TYPES, previewIsolation: proof },
      };
    },
    refreshMs: 240_000, retryMs: 30_000, jitterMs: 0, now: () => NOW,
    setTimer: () => ({ unref() {} }), clearTimer: () => {},
  });
  await readiness.start();
  assert.equal((await requireFreshWorkerAdmission({
    client: clientFor(node), env: ADMISSION_ENV, now: NOW,
  })).workerId, "worker-1");
  assert.doesNotMatch(JSON.stringify(node), new RegExp(secret));
  readiness.stop();
});

test("customer provider lanes remain isolated from managed recovery", async () => {
  const connected = await resolveBuildContext("owner", { credentialResolver: async () => ({
    provider: "codex", secret: "owner-scoped-codex-auth",
  }) });
  const byok = await resolveBuildContext("owner", { credentialResolver: async () => ({
    provider: "anthropic", secret: "owner-scoped-anthropic-key",
  }) });
  const recovery = resolveManagedRecoveryContext();

  assert.equal(connected.policy.billingLane, "connected_allowance");
  assert.equal(connected.byok, true);
  assert.equal(byok.policy.billingLane, "byok_api");
  assert.equal(byok.byok, true);
  assert.equal(recovery.policy.billingLane, "managed");
  assert.equal(recovery.byok, false);
  assert.equal(recovery.providerLabel, "openai-managed");
});

test("managed recovery secret stays out of sandboxes, diagnostics, output, and service argv", async () => {
  const secret = "sk-test-managed-recovery-private-123456789";
  const child = safeChildEnvironment({ PATH: "/usr/bin", OPENAI_API_KEY: secret,
    VITE_OPENAI_API_KEY: secret, PROVISIOND_TOKEN: "private-preview-token" });
  assert.deepEqual(child, { PATH: "/usr/bin" });
  assert.doesNotMatch(redactDiagnosticText(`OPENAI_API_KEY=${secret}`, {
    env: { OPENAI_API_KEY: secret },
  }), new RegExp(secret));

  const authority = await readFile(new URL("../../ops/configure-package14-worker-authority.mjs", import.meta.url), "utf8");
  const unit = await readFile(new URL("../../build-worker/thrallo-build-worker.service", import.meta.url), "utf8");
  const verify = await readFile(new URL("../../ops/verify-build-worker-release.mjs", import.meta.url), "utf8");
  assert.match(authority, /updates\.set\("OPENAI_API_KEY", managedRecoveryCredential\)/);
  assert.match(authority, /managedRecoveryAuthorityPresent: true/);
  assert.doesNotMatch(authority, /console\.log\([^\n]*(?:managedRecoveryCredential|source\.values)/);
  assert.match(unit, /ExecStartPre=.*process\.env\.OPENAI_API_KEY/);
  assert.doesNotMatch(unit, /\$\{?OPENAI_API_KEY/,
    "systemd must not expand the credential into the service command line");
  assert.match(verify, /managedRecoveryAuthorityAvailable: true/);
  assert.doesNotMatch(`${authority}\n${unit}\n${verify}`, new RegExp(secret));
});
