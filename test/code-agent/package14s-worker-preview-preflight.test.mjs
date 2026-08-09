import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { proveWorkerPreviewIsolation, requireFreshWorkerPreviewProof } from "../../build-worker/previewIsolationPreflight.mjs";
import { assertWorkerCredentialAuthority } from "../../build-worker/runtimeConfig.mjs";

const AUTHORITY = {
  CODE_AGENT_STORE: "supabase",
  PLATFORM_ENC_KEY: "present",
  PREVIEW_MODE: "vps",
  PROVISIOND_URL: "http://127.0.0.1:8790",
  PROVISIOND_TOKEN: "present",
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

test("14S worker startup emits the machine-readable isolation failure around authority validation", async () => {
  const source = await readFile(new URL("../../build-worker/index.mjs", import.meta.url), "utf8");
  const guard = source.indexOf("assertWorkerCredentialAuthority(JOB_TYPES)");
  const caught = source.indexOf('event: "worker_preview_isolation_preflight", status: "failed"', guard);
  assert.ok(source.lastIndexOf("try {", guard) > 0 && caught > guard);
  assert.match(source.slice(guard, caught + 200), /code: error\.code/);
});
