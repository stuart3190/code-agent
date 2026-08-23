import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  PREVIEW_ISOLATION_START_TIMEOUT_MS,
  proveWorkerPreviewIsolation,
  resolvePreviewIsolationRunId,
  requireFreshWorkerPreviewProof,
} from "../../build-worker/previewIsolationPreflight.mjs";
import { assertWorkerCredentialAuthority } from "../../build-worker/runtimeConfig.mjs";

const AUTHORITY = {
  CODE_AGENT_STORE: "supabase",
  PLATFORM_ENC_KEY: "present",
  PREVIEW_MODE: "vps",
  PROVISIOND_URL: "http://127.0.0.1:8790",
  PROVISIOND_TOKEN: "present",
  OPENAI_API_KEY: "sk-test-managed-recovery-authority",
};

test("14S exact shell-present worker-absent regression fails closed with preview_isolation_required", () => {
  const shellEnv = { PREVIEW_MODE: "vps", PROVISIOND_URL: "http://127.0.0.1:8790" };
  const workerEnv = { CODE_AGENT_STORE: "supabase", PLATFORM_ENC_KEY: "present" };
  assert.equal(shellEnv.PREVIEW_MODE, "vps");
  assert.ok(shellEnv.PROVISIOND_URL);
  assert.throws(() => assertWorkerCredentialAuthority(["builder_pipeline"], workerEnv),
    (error) => error.code === "preview_isolation_required" && /resolved to local/.test(error.message));
});

test("14S worker preview configuration requires the isolated mode, valid URL and token", () => {
  for (const changed of [
    { PREVIEW_MODE: "local" }, { PROVISIOND_URL: "not-a-url" }, { PROVISIOND_URL: "file:///tmp/x" },
    { PROVISIOND_TOKEN: "" },
  ]) {
    assert.throws(() => assertWorkerCredentialAuthority(["builder_pipeline"], { ...AUTHORITY, ...changed }),
      (error) => error.code === "preview_isolation_required");
  }
  assert.doesNotThrow(() => assertWorkerCredentialAuthority(["builder_pipeline"], AUTHORITY));
});

test("14S preview identity is stable across restarts and supports an issued identity", () => {
  const first = resolvePreviewIsolationRunId({ nodeIdentity: "vps-worker-1" });
  const second = resolvePreviewIsolationRunId({ nodeIdentity: "vps-worker-1" });
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assert.notEqual(first, resolvePreviewIsolationRunId({ nodeIdentity: "vps-worker-2" }));
  assert.equal(resolvePreviewIsolationRunId({
    configured: "ec9972d8-ef9d-4105-a2c7-946c19dd6438",
    nodeIdentity: "ignored",
  }), "ec9972d8-ef9d-4105-a2c7-946c19dd6438");
  assert.throws(() => resolvePreviewIsolationRunId({ configured: "unsafe/id" }),
    (error) => error.code === "preview_isolation_identity_invalid");
});

test("14S actual-worker smoke verifies health, identity, marker and clean teardown", async () => {
  const projectId = "worker-preflight-abc-def";
  const calls = [];
  let live = false;
  const preview = {
    mode: "vps",
    async start(id, tree) {
      calls.push(["start", id, tree]); live = true;
      return { id: "pworkerpreflightabcdef", url: "https://pworkerpreflightabcdef.preview.test/", mode: "vps" };
    },
    async get() { calls.push(["get"]); return live ? { url: "https://pworkerpreflightabcdef.preview.test/", mode: "vps" } : null; },
    async stop() { calls.push(["stop"]); live = false; return { stopped: true }; },
  };
  const fetchImpl = async (url) => url.endsWith("/health")
    ? new Response(JSON.stringify({ ok: true, capacity: 12 }), { status: 200 })
    : new Response("thrallo-isolated-preview-preflight", { status: 200 });
  const proof = await proveWorkerPreviewIsolation({ env: AUTHORITY, preview, fetchImpl,
    randomUUID: () => "abc-def" });
  assert.equal(proof.status, "passed");
  assert.equal(proof.resolvedMode, "vps");
  assert.deepEqual(proof.teardown, { stopped: true, absent: true });
  assert.deepEqual(calls.map((row) => row[0]), ["start", "get", "stop", "get"]);
  assert.ok(PREVIEW_ISOLATION_START_TIMEOUT_MS > 240_000,
    "the client must outlive provisiond's documented 240-second readiness window");
  const accepted = requireFreshWorkerPreviewProof([{
    worker_id: "worker-1", state: "active", job_types: ["builder_pipeline"],
    heartbeat_at: new Date().toISOString(), metadata: { previewIsolation: proof },
  }]);
  assert.equal(accepted.workerId, "worker-1");
});

test("14S official preflight rejects stale, dark or incomplete worker proof", () => {
  const base = { worker_id: "worker-1", state: "active", job_types: ["builder_pipeline"],
    heartbeat_at: new Date().toISOString(), metadata: { previewIsolation: { status: "passed" } } };
  for (const row of [base, { ...base, job_types: ["proof_slow"] },
    { ...base, heartbeat_at: new Date(Date.now() - 60_000).toISOString() }]) {
    assert.throws(() => requireFreshWorkerPreviewProof([row]),
      (error) => error.code === "preview_isolation_required");
  }
});

test("14S official preflight checks actual worker proof before project creation or queue dispatch", async () => {
  const source = await readFile(new URL("../../ops/run-package14s-live-booking.mjs", import.meta.url), "utf8");
  const workerCheck = source.indexOf("workerPreview = await workerPreviewPreflight()");
  const projectCreate = source.indexOf('client.from("projects").insert', workerCheck);
  const bookingBranch = source.indexOf('STAGE === "booking"', workerCheck);
  assert.ok(workerCheck > 0 && projectCreate > workerCheck && bookingBranch > projectCreate);
  assert.match(source, /preflight_failed[\s\S]*code: "preview_isolation_required"[\s\S]*providerCalls: 0/);
});

test("14S worker startup and periodic refresh publish fail-closed readiness without exiting", async () => {
  const source = await readFile(new URL("../../build-worker/index.mjs", import.meta.url), "utf8");
  const controller = await readFile(new URL("../../build-worker/previewIsolationReadiness.mjs", import.meta.url), "utf8");
  assert.match(source, /createPreviewIsolationReadiness\(\{/);
  assert.match(source, /prove: async \(\) => \{[\s\S]*assertWorkerCredentialAuthority\(JOB_TYPES\)/);
  assert.match(source, /publish: publishWorkerNode/);
  assert.match(source, /configuredJobTypes: JOB_TYPES/);
  assert.match(source, /resolvePreviewIsolationRunId\(\{/);
  assert.match(source, /THRALLO_PREVIEW_ISOLATION_RUN_ID/);
  assert.match(source, /randomUUID: \(\) => PREVIEW_ISOLATION_RUN_ID/,
    "all refreshes in one worker process must reuse one isolated-preview hostname");
  assert.match(controller, /proof\.status === "passed" \? jitterMs : 0/);
  assert.match(controller, /failedPreviewIsolationProof/);
  assert.doesNotMatch(source, /throw error;[\s\S]*worker_preview_isolation_preflight/,
    "a transient readiness failure must not terminate the worker recovery loop");
});
