#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

if (process.env.ATOMIC_PUBLISH_DB_PROOF !== "1") throw new Error("ATOMIC_PUBLISH_DB_PROOF=1 is required");
const url = process.env.API_URL; const serviceKey = process.env.SERVICE_ROLE_KEY; const anonKey = process.env.ANON_KEY;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url || "") || !serviceKey || !anonKey) {
  throw new Error("atomic publish proof refuses any target except a loopback disposable Supabase stack");
}
const container = process.env.SUPABASE_DB_CONTAINER || "supabase_db_thrallo-migration-proof";
const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const browser = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
const A = "d0000000-0000-4000-8000-000000000001"; const B = "d0000000-0000-4000-8000-000000000002";
const PA = "e0000000-0000-4000-8000-000000000001"; const PB = "e0000000-0000-4000-8000-000000000002";
const D1 = "f0000000-0000-4000-8000-000000000001"; const D2 = "f0000000-0000-4000-8000-000000000002";
const D3 = "f0000000-0000-4000-8000-000000000003";
const R1 = "10000000-0000-4000-8000-000000000001"; const R2 = "10000000-0000-4000-8000-000000000002";
const R3 = "10000000-0000-4000-8000-000000000003"; const R4 = "10000000-0000-4000-8000-000000000004";
const HASH = "a".repeat(64); const HASH2 = "b".repeat(64);
const one = (value) => Array.isArray(value) ? value[0] : value;
function unwrap(result, label) { if (result.error) throw new Error(`${label}: ${result.error.message}`); return result.data; }
function sql(statement) {
  return execFileSync("docker", ["exec", "-i", container, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres", "-At"],
    { input: statement, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}
async function register(release, hash, deployment, owner = A, project = PA, slug = "atomic-proof") {
  return unwrap(await db.rpc("register_verified_publish_release", {
    p_release_id: release, p_owner: owner, p_project_id: project, p_product_id: null,
    p_slug: slug, p_url: `https://${slug}.app.thrallo.com/`, p_build_id: null,
    p_snapshot_id: null, p_deployment_id: deployment, p_artifact_hash: hash,
    p_manifest_hash: hash, p_artifact_path: `.thrallo/releases/${owner}/${project}/${release}`,
    p_artifact_bytes: 42, p_file_count: 1,
    p_manifest: { version: "thrallo-release-v1", artifactHash: hash, fileCount: 1, bytes: 42, files: [{ path: "index.html", bytes: 42, sha256: hash }] },
    p_domains: [], p_metadata: { proof: true },
  }), "register");
}
async function request(release, version, operation = "activate", deployment = null) {
  return one(unwrap(await db.rpc("request_publish_activation", {
    p_owner: A, p_release_id: release, p_expected_version: version,
    p_operation: operation, p_activation_deployment_id: deployment,
  }), "request"));
}
async function complete(intent, observed) {
  unwrap(await db.rpc("mark_publish_pointer_switched", { p_intent_id: intent.id, p_observed_release_id: observed }), "pointer");
  return one(unwrap(await db.rpc("complete_publish_activation", { p_intent_id: intent.id }), "complete"));
}

const proof = {};
try {
  for (const [owner, project, suffix] of [[A, PA, "a"], [B, PB, "b"]]) {
    const created = await db.auth.admin.createUser({ id: owner, email: `atomic-publish-${suffix}@example.invalid`, password: "Disposable-C8-Proof!42", email_confirm: true });
    if (created.error && !/already/i.test(created.error.message)) throw created.error;
    unwrap(await db.from("projects").insert({ id: project, owner, name: `C8 proof ${suffix}`, tree: {} }), "project");
  }
  for (const [id, number] of [[D1, 1], [D2, 2], [D3, 3]]) {
    unwrap(await db.from("deployments").insert({ id, owner: A, project_id: PA, number,
      status: "deploying", triggered_by_kind: number === 3 ? "rollback" : "user" }), "deployment");
  }

  const first = await register(R1, HASH, D1);
  const duplicate = await register(R1, HASH, D1);
  assert.equal(duplicate.release_id, first.release_id); proof.registrationIdempotent = true;
  const conflict = await db.rpc("register_verified_publish_release", {
    p_release_id: R1, p_owner: A, p_project_id: PA, p_product_id: null, p_slug: "atomic-proof",
    p_url: "https://atomic-proof.app.thrallo.com/", p_build_id: null, p_snapshot_id: null,
    p_deployment_id: D1, p_artifact_hash: HASH2, p_manifest_hash: HASH2,
    p_artifact_path: "different", p_artifact_bytes: 1, p_file_count: 1, p_manifest: {}, p_domains: [], p_metadata: {},
  });
  assert.ok(conflict.error); proof.conflictingRetryRejected = true;

  const intent1 = await request(R1, 0, "activate", D1);
  assert.equal(intent1.state, "prepared"); await complete(intent1, R1);
  let site = one(unwrap(await db.from("published_sites").select("active_publish_release_id,activation_version,unpublished_at").eq("owner", A).single(), "site1"));
  assert.equal(site.active_publish_release_id, R1); assert.equal(site.activation_version, 1); assert.equal(site.unpublished_at, null);
  proof.firstActivation = true;

  await register(R2, HASH2, D2);
  const stale = await db.rpc("request_publish_activation", { p_owner: A, p_release_id: R2,
    p_expected_version: 0, p_operation: "activate", p_activation_deployment_id: D2 });
  assert.ok(stale.error); proof.staleCasRejected = true;

  const intent2 = await request(R2, 1, "activate", D2);
  const leased = one(unwrap(await db.rpc("lease_publish_activation_intents", { p_worker: "proof-a", p_limit: 1, p_lease_seconds: 30 }), "lease"));
  const secondLease = unwrap(await db.rpc("lease_publish_activation_intents", { p_worker: "proof-b", p_limit: 1, p_lease_seconds: 30 }), "second lease");
  assert.equal(leased.id, intent2.id); assert.equal(secondLease.length, 0); proof.singleReconcilerLease = true;
  await complete(intent2, R2);
  const rows = unwrap(await db.from("publish_releases").select("id,activation_state").in("id", [R1, R2]), "states");
  assert.equal(rows.find((row) => row.id === R1).activation_state, "superseded");
  assert.equal(rows.find((row) => row.id === R2).activation_state, "active"); proof.oneActiveRelease = true;

  const immutable = await db.from("publish_releases").update({ artifact_hash: HASH2 }).eq("id", R1);
  assert.ok(immutable.error); proof.verifiedBytesImmutable = true;

  const rollback = await request(R1, 2, "rollback", D3); await complete(rollback, R1);
  site = one(unwrap(await db.from("published_sites").select("active_publish_release_id,activation_version").eq("owner", A).single(), "rollback site"));
  assert.equal(site.active_publish_release_id, R1); assert.equal(site.activation_version, 3);
  const rollbackDeployment = one(unwrap(await db.from("deployments").select("status").eq("id", D3).single(), "rollback deployment"));
  assert.equal(rollbackDeployment.status, "live"); proof.rollbackWithoutBuild = true;

  const unpublish = one(unwrap(await db.rpc("request_publish_unpublish", { p_owner: A, p_project_id: PA, p_expected_version: 3 }), "unpublish request"));
  await complete(unpublish, null);
  site = one(unwrap(await db.from("published_sites").select("active_publish_release_id,activation_version,unpublished_at").eq("owner", A).single(), "unpublished site"));
  assert.equal(site.active_publish_release_id, null); assert.equal(site.activation_version, 4); assert.ok(site.unpublished_at);
  proof.unpublishCas = true;

  const otherOwner = await db.rpc("request_publish_activation", { p_owner: B, p_release_id: R1,
    p_expected_version: 4, p_operation: "activate", p_activation_deployment_id: null });
  assert.ok(otherOwner.error);
  const browserRows = await browser.from("publish_releases").select("id");
  if (browserRows.error) assert.equal(browserRows.error.code, "42501"); else assert.deepEqual(browserRows.data, []);
  proof.ownerIsolation = true;

  await register(R3, "c".repeat(64), null); await register(R4, "d".repeat(64), null);
  const race = await Promise.all([
    db.rpc("request_publish_activation", { p_owner: A, p_release_id: R3, p_expected_version: 4, p_operation: "activate", p_activation_deployment_id: null }),
    db.rpc("request_publish_activation", { p_owner: A, p_release_id: R4, p_expected_version: 4, p_operation: "activate", p_activation_deployment_id: null }),
  ]);
  assert.equal(race.filter((result) => !result.error).length, 1);
  assert.equal(race.filter((result) => result.error).length, 1); proof.concurrentIntentRace = true;

  assert.equal(Number(sql("select count(*) from public.publish_releases where activation_state='active';")), 0);
  console.log(JSON.stringify({ ok: true, ...proof }, null, 2));
} finally {
  sql(`delete from auth.users where id in ('${A}','${B}');`);
  assert.equal(Number(sql(`select count(*) from public.publish_releases where owner in ('${A}','${B}');`)), 0);
  assert.equal(Number(sql(`select count(*) from public.publish_activation_intents where owner in ('${A}','${B}');`)), 0);
}
