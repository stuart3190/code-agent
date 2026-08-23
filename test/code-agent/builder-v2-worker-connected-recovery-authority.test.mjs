// Platform-connected recovery authority and customer-lane isolation.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertWorkerCredentialAuthority,
  workerConnectedRecoveryConfiguration,
} from "../../build-worker/runtimeConfig.mjs";
import { createPreviewIsolationReadiness } from "../../build-worker/previewIsolationReadiness.mjs";
import { safeChildEnvironment } from "../../build-worker/sandboxRunner.mjs";
import { resolveBuildContext, resolveConnectedRecoveryContext } from "../../shell/server/lib/appBuild/buildContext.mjs";
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
const RECOVERY_OWNER_ID = "00000000-0000-4000-8000-000000000123";

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

test("platform connected recovery identity is required before a worker can advertise Builder V2", async () => {
  assert.throws(
    () => assertWorkerCredentialAuthority(JOB_TYPES, PRIVATE_ENV),
    (error) => error.code === "recovery_provider_unavailable"
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
  assert.equal(node.metadata.previewIsolation.code, "recovery_provider_unavailable");
  assert.ok(!node.job_types.includes("builder_pipeline"));
  await assert.rejects(
    requireFreshWorkerAdmission({ client: clientFor(node), env: ADMISSION_ENV, now: NOW }),
    (error) => error.code === "recovery_provider_unavailable",
  );
  readiness.stop();
});

test("present platform connected recovery identity permits zero-model worker admission", async () => {
  const env = { ...PRIVATE_ENV, THRALLO_BV2_RECOVERY_OWNER_ID: RECOVERY_OWNER_ID };
  assert.deepEqual(workerConnectedRecoveryConfiguration(env), {
    available: true, provider: "codex", billingLane: "connected_allowance",
    fundingPool: "thrallo_recovery", policyVersion: "owner_connected_recovery_v1",
  });
  assert.deepEqual(assertWorkerCredentialAuthority(JOB_TYPES, env), {
    available: true, provider: "codex", billingLane: "connected_allowance",
    fundingPool: "thrallo_recovery", policyVersion: "owner_connected_recovery_v1",
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
  assert.doesNotMatch(JSON.stringify(node), new RegExp(RECOVERY_OWNER_ID));
  readiness.stop();
});

test("configured recovery identity without an active platform Codex credential fails closed", async () => {
  await assert.rejects(resolveConnectedRecoveryContext({
    env: { THRALLO_BV2_RECOVERY_OWNER_ID: RECOVERY_OWNER_ID },
    credentialResolver: async () => ({ provider: "managed", secret: null }),
  }), (error) => error.code === "recovery_provider_unavailable"
    && error.classification === "platform"
    && error.dispatchState === "before_dispatch"
    && error.customerActionRequired === false);
});

test("customer provider lanes remain isolated from platform connected recovery", async () => {
  const connected = await resolveBuildContext("owner", { credentialResolver: async () => ({
    provider: "codex", secret: "owner-scoped-codex-auth",
  }) });
  const byok = await resolveBuildContext("owner", { credentialResolver: async () => ({
    provider: "anthropic", secret: "owner-scoped-anthropic-key",
  }) });
  const managed = await resolveBuildContext("owner", { credentialResolver: async () => ({
    provider: "managed", secret: null,
  }) });
  const recoverySecret = "platform-owner-codex-auth-private";
  const recovery = await resolveConnectedRecoveryContext({
    env: { THRALLO_BV2_RECOVERY_OWNER_ID: RECOVERY_OWNER_ID },
    credentialResolver: async (owner) => {
      assert.equal(owner, RECOVERY_OWNER_ID);
      return { provider: "codex", secret: recoverySecret };
    },
    owner: "browser-supplied-owner-is-ignored",
  });

  assert.equal(connected.policy.billingLane, "connected_allowance");
  assert.equal(connected.byok, true);
  assert.equal(byok.policy.billingLane, "byok_api");
  assert.equal(byok.byok, true);
  assert.equal(managed.policy.billingLane, "managed");
  assert.equal(managed.byok, false);
  assert.equal(recovery.policy.billingLane, "connected_allowance");
  assert.equal(recovery.policy.primaryProvider, "codex");
  assert.equal(recovery.policy.selectedBy, "thrallo_recovery_authority");
  assert.equal(recovery.policy.executionAuthority, "platform_connected_codex");
  assert.equal(recovery.byok, true);
  assert.equal(recovery.providerLabel, "codex-platform-recovery");
  assert.doesNotMatch(JSON.stringify(recovery), new RegExp(recoverySecret));
});

test("platform recovery identity and stored Codex secret stay out of sandboxes and diagnostics", async () => {
  const secret = "platform-owner-codex-auth-private";
  const child = safeChildEnvironment({ PATH: "/usr/bin", THRALLO_BV2_RECOVERY_OWNER_ID: RECOVERY_OWNER_ID,
    CODEX_ACCESS_TOKEN: secret, VITE_CODEX_ACCESS_TOKEN: secret, PROVISIOND_TOKEN: "private-preview-token" });
  assert.deepEqual(child, { PATH: "/usr/bin" });
  assert.doesNotMatch(redactDiagnosticText(`CODEX_ACCESS_TOKEN=${secret}`, {
    env: { CODEX_ACCESS_TOKEN: secret },
  }), new RegExp(secret));

  const authority = await readFile(new URL("../../ops/configure-package14-worker-authority.mjs", import.meta.url), "utf8");
  const unit = await readFile(new URL("../../build-worker/thrallo-build-worker.service", import.meta.url), "utf8");
  const verify = await readFile(new URL("../../ops/verify-build-worker-release.mjs", import.meta.url), "utf8");
  assert.match(authority, /updates\.set\("THRALLO_BV2_RECOVERY_OWNER_ID", connectedRecoveryOwnerId\)/);
  assert.match(authority, /connectedRecoveryAuthorityPresent: true/);
  assert.match(authority, /updates\.set\("OPENAI_API_KEY", managedCustomerCredential\)/,
    "the private managed credential remains available only for customer-selected managed generation");
  assert.doesNotMatch(authority,
    /console\.log\([^\n]*(?:connectedRecoveryOwnerId|managedCustomerCredential|source\.values)/);
  assert.match(unit, /ExecStartPre=.*process\.env\.THRALLO_BV2_RECOVERY_OWNER_ID/);
  assert.doesNotMatch(unit, /\$\{?THRALLO_BV2_RECOVERY_OWNER_ID/,
    "systemd must not expand the recovery identity into the service command line");
  assert.match(verify, /connectedRecoveryAuthorityAvailable: true/);
  assert.match(verify, /recoveryTransport: "platform_connected_codex"/);
  assert.doesNotMatch(`${authority}\n${unit}\n${verify}`, new RegExp(secret));
});
