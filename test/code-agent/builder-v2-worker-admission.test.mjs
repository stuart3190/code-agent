import assert from "node:assert/strict";
import test from "node:test";

import { requireFreshWorkerAdmission } from "../../shell/server/lib/builderV2/workerAdmission.mjs";

const now = Date.parse("2026-08-13T12:00:00.000Z");
const proof = {
  status: "passed", checkedAt: "2026-08-13T11:55:00.000Z", resolvedMode: "vps",
  health: { reachable: true, capacity: 4 }, preview: { mode: "vps", markerMatched: true },
  teardown: { stopped: true, absent: true },
};

const clientFor = (nodes, error = null) => ({
  from(table) {
    assert.equal(table, "build_worker_nodes");
    return { select: async () => ({ data: nodes, error }) };
  },
});

test("customer admission accepts only an active matching worker with fresh preview proof", async () => {
  const result = await requireFreshWorkerAdmission({
    client: clientFor([{
      worker_id: "worker-1", version: "release-1", state: "active",
      job_types: ["builder_pipeline"], heartbeat_at: "2026-08-13T11:59:50.000Z",
      metadata: { previewIsolation: proof },
    }]),
    env: { THRALLO_BUILD_WORKER_ENABLED: "1", THRALLO_BUILD_WORKER_VERSION: "release-1" }, now,
  });
  assert.equal(result.workerId, "worker-1");
  assert.equal(result.version, "release-1");
});

test("customer admission rejects draining, stale, and release-skewed workers", async () => {
  const base = {
    worker_id: "worker-1", version: "old", state: "active", job_types: ["builder_pipeline"],
    heartbeat_at: "2026-08-13T11:59:50.000Z", metadata: { previewIsolation: proof },
  };
  await assert.rejects(requireFreshWorkerAdmission({
    client: clientFor([base]), env: { THRALLO_BUILD_WORKER_ENABLED: "1", THRALLO_BUILD_WORKER_VERSION: "new" }, now,
  }), (error) => error.code === "worker_version_mismatch");
  await assert.rejects(requireFreshWorkerAdmission({
    client: clientFor([{ ...base, version: "new", state: "draining" }]),
    env: { THRALLO_BUILD_WORKER_ENABLED: "1", THRALLO_BUILD_WORKER_VERSION: "new" }, now,
  }), (error) => error.code === "worker_required");
  await assert.rejects(requireFreshWorkerAdmission({
    client: clientFor([{ ...base, version: "new", heartbeat_at: "2026-08-13T11:58:00.000Z" }]),
    env: { THRALLO_BUILD_WORKER_ENABLED: "1", THRALLO_BUILD_WORKER_VERSION: "new" }, now,
  }), (error) => error.code === "worker_required");
});

test("non-pipeline capability admission still requires heartbeat and release identity", async () => {
  const result = await requireFreshWorkerAdmission({
    client: clientFor([{
      worker_id: "worker-2", version: "release-2", state: "active",
      job_types: ["qa_browser"], heartbeat_at: "2026-08-13T11:59:55.000Z", metadata: {},
    }]),
    jobType: "qa_browser",
    env: { THRALLO_BUILD_WORKER_ENABLED: "1", THRALLO_BUILD_WORKER_VERSION: "release-2" }, now,
  });
  assert.equal(result.jobType, "qa_browser");
});

test("a healthy compatible worker remains selectable when a newer heartbeat reports isolation failure", async () => {
  const failed = {
    worker_id: "worker-failed", version: "release-1", state: "active", job_types: ["compile"],
    heartbeat_at: "2026-08-13T11:59:59.000Z",
    metadata: { configuredJobTypes: ["builder_pipeline", "compile"], previewIsolation: {
      status: "failed", checkedAt: "2026-08-13T11:59:58.000Z",
      code: "preview_isolation_required", message: "isolated provisioner failed its marker probe",
    } },
  };
  const healthy = {
    worker_id: "worker-healthy", version: "release-1", state: "active", job_types: ["builder_pipeline"],
    heartbeat_at: "2026-08-13T11:59:55.000Z", metadata: { previewIsolation: proof },
  };
  const result = await requireFreshWorkerAdmission({
    client: clientFor([failed, healthy]),
    env: { THRALLO_BUILD_WORKER_ENABLED: "1", THRALLO_BUILD_WORKER_VERSION: "release-1" }, now,
  });
  assert.equal(result.workerId, "worker-healthy");
});

test("an isolation-failed worker surfaces its recorded reason while remaining unavailable", async () => {
  const failed = {
    worker_id: "worker-failed", version: "release-1", state: "active", job_types: ["compile"],
    heartbeat_at: "2026-08-13T11:59:59.000Z",
    metadata: { configuredJobTypes: ["builder_pipeline", "compile"], previewIsolation: {
      status: "failed", checkedAt: "2026-08-13T11:59:58.000Z",
      code: "preview_isolation_required", message: "isolated provisioner failed its marker probe",
    } },
  };
  await assert.rejects(requireFreshWorkerAdmission({
    client: clientFor([failed]),
    env: { THRALLO_BUILD_WORKER_ENABLED: "1", THRALLO_BUILD_WORKER_VERSION: "release-1" }, now,
  }), (error) => error.code === "preview_isolation_required"
    && /isolated provisioner failed its marker probe/.test(error.message));
});

test("a stale environment value cannot override the deployed manifest revision", async () => {
  const manifestVersion = "manifest-release";
  const result = await requireFreshWorkerAdmission({
    client: clientFor([{
      worker_id: "worker-manifest", version: manifestVersion, state: "active",
      job_types: ["builder_pipeline"], heartbeat_at: "2026-08-13T11:59:55.000Z",
      metadata: { previewIsolation: proof },
    }]),
    env: { THRALLO_BUILD_WORKER_ENABLED: "1", THRALLO_BUILD_WORKER_VERSION: "stale-private-env",
      CODE_AGENT_STORE: "supabase" },
    releaseIdentityResolver: async () => ({ version: manifestVersion, source: "deployment_manifest" }),
    now,
  });
  assert.equal(result.version, manifestVersion);
  assert.equal(result.releaseIdentitySource, "deployment_manifest");
});
