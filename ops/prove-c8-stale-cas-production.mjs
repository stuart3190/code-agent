#!/usr/bin/env node

// Production-safe Package 10E-F stress proof. It is deliberately pinned to the Thrallo
// production project and fixed disposable identities, never invokes provisiond/Caddy, and makes
// no provider or Stripe call. Every mutation is owner-scoped and removed in finally.

import assert from "node:assert/strict";
import crypto from "node:crypto";

import { serviceClient } from "../shell/server/lib/supabase.mjs";

const PROJECT_REF = "zczgvcsokfafuyognvwx";
const OWNER = "10f00000-0000-4000-8000-000000000001";
const PROJECT = "10f10000-0000-4000-8000-000000000001";
const DEPLOYMENT_A = "10f20000-0000-4000-8000-000000000001";
const DEPLOYMENT_B = "10f20000-0000-4000-8000-000000000002";
const RELEASE_A = "10f30000-0000-4000-8000-000000000001";
const RELEASE_B = "10f30000-0000-4000-8000-000000000002";
const ATTEMPTS = 80;

if (process.env.THRALLO_C8_CAS_STRESS !== "1") throw new Error("THRALLO_C8_CAS_STRESS=1 is required");
if (process.env.THRALLO_PROCESS_ROLE !== "package10ef-cas-stress") throw new Error("isolated stress process role is required");
if (process.env.THRALLO_MANAGED_SETTLEMENT_PAUSED !== "1") throw new Error("managed settlement must remain paused");
if (process.env.THRALLO_BUILD_WORKER_ENABLED === "1") throw new Error("customer worker dispatch must remain disabled");
if (process.env.THRALLO_ATOMIC_PUBLISH_ENABLED === "1") throw new Error("customer atomic publishing must remain disabled");
if (!String(process.env.SUPABASE_URL || "").includes(PROJECT_REF)) throw new Error("stress target is not Thrallo production");

const client = serviceClient();
const one = (value) => Array.isArray(value) ? value[0] : value;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const unwrap = (result, label) => {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
};

async function cleanup() {
  await client.from("publish_activation_intents").delete().eq("owner", OWNER);
  await client.from("publish_releases").delete().eq("owner", OWNER);
  await client.from("published_sites").delete().eq("owner", OWNER);
  await client.from("deployments").delete().eq("owner", OWNER);
  await client.from("projects").delete().eq("id", PROJECT).eq("owner", OWNER);
  await client.auth.admin.deleteUser(OWNER).catch(() => {});
}

async function register(releaseId, deploymentId, hash) {
  return one(unwrap(await client.rpc("register_verified_publish_release", {
    p_release_id: releaseId, p_owner: OWNER, p_project_id: PROJECT, p_product_id: null,
    p_slug: "package10ef-cas-stress", p_url: "https://package10ef-cas-stress.app.thrallo.com/",
    p_build_id: null, p_snapshot_id: null, p_deployment_id: deploymentId,
    p_artifact_hash: hash, p_manifest_hash: hash,
    p_artifact_path: `.thrallo/releases/${OWNER}/${PROJECT}/${releaseId}`,
    p_artifact_bytes: 1, p_file_count: 1,
    p_manifest: { version: "thrallo-release-v1", artifactHash: hash, bytes: 1, fileCount: 1,
      files: [{ path: "index.html", bytes: 1, sha256: hash }] },
    p_domains: [], p_metadata: { package10ef: true, databaseOnly: true },
  }), `register ${releaseId}`));
}

async function activate(releaseId, deploymentId, version) {
  const intent = one(unwrap(await client.rpc("request_publish_activation", {
    p_owner: OWNER, p_release_id: releaseId, p_expected_version: version,
    p_operation: "activate", p_activation_deployment_id: deploymentId,
  }), "request activation"));
  unwrap(await client.rpc("mark_publish_pointer_switched", {
    p_intent_id: intent.id, p_observed_release_id: releaseId,
  }), "mark pointer switched");
  return one(unwrap(await client.rpc("complete_publish_activation", {
    p_intent_id: intent.id,
  }), "complete activation"));
}

await cleanup();
let primaryError = null;
const startedAt = new Date().toISOString();
const latencies = [];
let healthyProbes = 0;
try {
  const auth = await client.auth.admin.createUser({
    id: OWNER, email: "package10ef-cas-stress@example.invalid",
    password: `Package10EF-${crypto.randomBytes(18).toString("hex")}!`, email_confirm: true,
  });
  if (auth.error) throw auth.error;
  unwrap(await client.from("projects").insert({ id: PROJECT, owner: OWNER, name: "Package 10E-F CAS stress", tree: {} }), "project");
  unwrap(await client.from("deployments").insert([
    { id: DEPLOYMENT_A, owner: OWNER, project_id: PROJECT, number: 1, status: "deploying", triggered_by_kind: "user" },
    { id: DEPLOYMENT_B, owner: OWNER, project_id: PROJECT, number: 2, status: "deploying", triggered_by_kind: "user" },
  ]), "deployments");
  await register(RELEASE_A, DEPLOYMENT_A, "a".repeat(64));
  await activate(RELEASE_A, DEPLOYMENT_A, 0);
  await register(RELEASE_B, DEPLOYMENT_B, "b".repeat(64));

  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const started = performance.now();
    const stale = await client.rpc("request_publish_activation", {
      p_owner: OWNER, p_release_id: RELEASE_B, p_expected_version: 0,
      p_operation: "activate", p_activation_deployment_id: DEPLOYMENT_B,
    });
    latencies.push(performance.now() - started);
    assert.equal(stale.error?.code, "PT412");
    if (attempt % 5 === 0) {
      const healthy = one(unwrap(await client.from("published_sites").select("activation_version")
        .eq("owner", OWNER).eq("project_id", PROJECT).single(), "healthy lookup"));
      assert.equal(healthy.activation_version, 1);
      healthyProbes += 1;
    }
    await sleep(100);
  }

  await activate(RELEASE_B, DEPLOYMENT_B, 1);
  const final = one(unwrap(await client.from("published_sites")
    .select("active_publish_release_id,activation_version")
    .eq("owner", OWNER).eq("project_id", PROJECT).single(), "final site"));
  assert.equal(final.active_publish_release_id, RELEASE_B);
  assert.equal(final.activation_version, 2);
} catch (error) {
  primaryError = error;
}

await cleanup();
const residue = one(unwrap(await client.from("projects").select("id").eq("id", PROJECT).maybeSingle(), "cleanup probe"));
assert.equal(residue, null);
if (primaryError) throw primaryError;

latencies.sort((a, b) => a - b);
console.log(JSON.stringify({
  ok: true, startedAt, finishedAt: new Date().toISOString(), attempts: ATTEMPTS,
  applicationConflictCode: "PT412", httpStatus: 412, pgrst003: 0, http504: 0,
  unexpected5xx: 0, healthyProbes,
  p50Ms: Number(latencies[Math.floor(latencies.length * 0.50)].toFixed(2)),
  p95Ms: Number(latencies[Math.floor(latencies.length * 0.95)].toFixed(2)),
  maxMs: Number(latencies.at(-1).toFixed(2)), cleanup: true,
}));
