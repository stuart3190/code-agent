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
const D3 = "f0000000-0000-4000-8000-000000000003"; const D4 = "f0000000-0000-4000-8000-000000000004";
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
async function requestUnpublish(version) {
  return one(unwrap(await db.rpc("request_publish_unpublish", {
    p_owner: A, p_project_id: PA, p_expected_version: version,
  }), "unpublish request"));
}
async function siteState() {
  return one(unwrap(await db.from("published_sites")
    .select("id,active_publish_release_id,activation_version,unpublished_at")
    .eq("owner", A).single(), "site state"));
}
async function deploymentState(id) {
  return one(unwrap(await db.from("deployments").select("*").eq("id", id).single(), `deployment ${id}`));
}
async function assertStable({ release, version, live }) {
  const site = await siteState();
  assert.equal(site.active_publish_release_id, release);
  assert.equal(site.activation_version, version);
  assert.equal(Boolean(site.unpublished_at), release === null);
  const rows = unwrap(await db.from("deployments").select("id,status").eq("owner", A).eq("project_id", PA), "deployment states");
  assert.equal(rows.filter((row) => row.status === "live").length, live === null ? 0 : 1);
  if (live !== null) assert.equal(rows.find((row) => row.status === "live").id, live);
}
async function finishRace(results, observedByOperation) {
  const winners = results.filter((result) => !result.error);
  assert.equal(winners.length, 1);
  assert.equal(results.filter((result) => result.error).length, 1);
  const intent = one(winners[0].data);
  await complete(intent, observedByOperation[intent.operation]);
  return intent;
}

const proof = {};
try {
  for (const [owner, project, suffix] of [[A, PA, "a"], [B, PB, "b"]]) {
    const created = await db.auth.admin.createUser({ id: owner, email: `atomic-publish-${suffix}@example.invalid`, password: "Disposable-C8-Proof!42", email_confirm: true });
    if (created.error && !/already/i.test(created.error.message)) throw created.error;
    unwrap(await db.from("projects").insert({ id: project, owner, name: `C8 proof ${suffix}`, tree: {} }), "project");
  }
  for (const [id, number] of [[D1, 1], [D2, 2], [D3, 3], [D4, 4]]) {
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

  const unpublish = await requestUnpublish(3);
  await complete(unpublish, null);
  await assertStable({ release: null, version: 4, live: null });
  assert.equal((await deploymentState(D3)).status, "superseded");
  const replay = one(unwrap(await db.rpc("complete_publish_activation", { p_intent_id: unpublish.id }), "unpublish replay"));
  assert.equal(replay.id, unpublish.id);
  await assertStable({ release: null, version: 4, live: null });
  proof.unpublishRetiresRollbackDeployment = true;
  proof.unpublishCompletionIdempotent = true;

  // B: rollback -> unpublish -> reactivate retained release. The live rollback deployment is D3,
  // while release A's immutable deployment_id remains D1; this is the production-proven defect.
  const reactivateAfterRollbackUnpublish = await request(R1, 4, "rollback", D3);
  await complete(reactivateAfterRollbackUnpublish, R1);
  await assertStable({ release: R1, version: 5, live: D3 });
  proof.rollbackUnpublishReactivate = true;

  // A: publish A -> unpublish -> republish A.
  const unpublishA = await requestUnpublish(5); await complete(unpublishA, null);
  await assertStable({ release: null, version: 6, live: null });
  const republishA = await request(R1, 6, "activate", D3); await complete(republishA, R1);
  await assertStable({ release: R1, version: 7, live: D3 });
  proof.unpublishRepublishSameRelease = true;

  // C: publish A -> unpublish -> publish B.
  const unpublishBeforeB = await requestUnpublish(7); await complete(unpublishBeforeB, null);
  await assertStable({ release: null, version: 8, live: null });
  const publishBAfterUnpublish = await request(R2, 8, "activate", D2); await complete(publishBAfterUnpublish, R2);
  await assertStable({ release: R2, version: 9, live: D2 });
  proof.unpublishPublishDifferentRelease = true;

  // F: fail after deployment retirement. An AFTER UPDATE proof trigger aborts the statement and
  // therefore the entire complete_publish_activation transaction.
  const faultAfterRetirement = await requestUnpublish(9);
  unwrap(await db.rpc("mark_publish_pointer_switched", { p_intent_id: faultAfterRetirement.id, p_observed_release_id: null }), "fault F pointer");
  const beforeF = { site: await siteState(), deployment: await deploymentState(D2) };
  sql(`
    create or replace function public.c8_proof_fail_after_deployment_retirement()
    returns trigger language plpgsql as $$ begin
      if old.owner = '${A}' and old.status = 'live' and new.status = 'superseded' then
        raise exception 'c8 proof fault after deployment retirement';
      end if;
      return new;
    end $$;
    create trigger c8_proof_fail_after_deployment_retirement
      after update on public.deployments for each row
      execute function public.c8_proof_fail_after_deployment_retirement();
  `);
  const failedF = await db.rpc("complete_publish_activation", { p_intent_id: faultAfterRetirement.id });
  assert.ok(failedF.error);
  sql("drop trigger c8_proof_fail_after_deployment_retirement on public.deployments; drop function public.c8_proof_fail_after_deployment_retirement();");
  assert.deepEqual(await siteState(), beforeF.site);
  assert.deepEqual(await deploymentState(D2), beforeF.deployment);
  one(unwrap(await db.rpc("complete_publish_activation", { p_intent_id: faultAfterRetirement.id }), "fault F retry"));
  await assertStable({ release: null, version: 10, live: null });
  proof.failureAfterDeploymentRetirementAtomic = true;

  const restoreB = await request(R2, 10, "activate", D2); await complete(restoreB, R2);
  await assertStable({ release: R2, version: 11, live: D2 });

  // G: fail after pointer-clear logic but before the intent completion update can commit.
  const faultBeforeCommit = await requestUnpublish(11);
  unwrap(await db.rpc("mark_publish_pointer_switched", { p_intent_id: faultBeforeCommit.id, p_observed_release_id: null }), "fault G pointer");
  const beforeG = { site: await siteState(), deployment: await deploymentState(D2) };
  sql(`
    create or replace function public.c8_proof_fail_before_completion_commit()
    returns trigger language plpgsql as $$ begin
      if old.owner = '${A}' and old.operation = 'unpublish' and new.state = 'completed' then
        raise exception 'c8 proof fault before completion commit';
      end if;
      return new;
    end $$;
    create trigger c8_proof_fail_before_completion_commit
      before update on public.publish_activation_intents for each row
      execute function public.c8_proof_fail_before_completion_commit();
  `);
  const failedG = await db.rpc("complete_publish_activation", { p_intent_id: faultBeforeCommit.id });
  assert.ok(failedG.error);
  sql("drop trigger c8_proof_fail_before_completion_commit on public.publish_activation_intents; drop function public.c8_proof_fail_before_completion_commit();");
  assert.deepEqual(await siteState(), beforeG.site);
  assert.deepEqual(await deploymentState(D2), beforeG.deployment);
  one(unwrap(await db.rpc("complete_publish_activation", { p_intent_id: faultBeforeCommit.id }), "fault G retry"));
  await assertStable({ release: null, version: 12, live: null });
  proof.failureBeforeCommitAtomic = true;

  const restoreA = await request(R1, 12, "rollback", D3); await complete(restoreA, R1);
  await assertStable({ release: R1, version: 13, live: D3 });

  // D: simultaneous unpublish/publish request. The site-row lock and CAS admit exactly one intent.
  const publishUnpublishRace = await Promise.all([
    db.rpc("request_publish_unpublish", { p_owner: A, p_project_id: PA, p_expected_version: 13 }),
    db.rpc("request_publish_activation", { p_owner: A, p_release_id: R2, p_expected_version: 13,
      p_operation: "activate", p_activation_deployment_id: D2 }),
  ]);
  const raceD = await finishRace(publishUnpublishRace, { unpublish: null, activate: R2 });
  await assertStable({
    release: raceD.operation === "unpublish" ? null : R2,
    version: 14,
    live: raceD.operation === "unpublish" ? null : D2,
  });
  proof.publishUnpublishRaceSingleCasWinner = true;

  // Make A active for H regardless of which D winner completed.
  let version = 14;
  site = await siteState();
  if (site.active_publish_release_id !== null) {
    const makeUnpublished = await requestUnpublish(version); await complete(makeUnpublished, null); version += 1;
  }
  const makeAActive = await request(R1, version, "activate", D3); await complete(makeAActive, R1); version += 1;
  await assertStable({ release: R1, version, live: D3 });

  // H: rollback/unpublish request race is deterministic under the same CAS.
  const rollbackUnpublishRace = await Promise.all([
    db.rpc("request_publish_unpublish", { p_owner: A, p_project_id: PA, p_expected_version: version }),
    db.rpc("request_publish_activation", { p_owner: A, p_release_id: R2, p_expected_version: version,
      p_operation: "rollback", p_activation_deployment_id: D4 }),
  ]);
  const raceH = await finishRace(rollbackUnpublishRace, { unpublish: null, rollback: R2 });
  version += 1;
  await assertStable({
    release: raceH.operation === "unpublish" ? null : R2,
    version,
    live: raceH.operation === "unpublish" ? null : D4,
  });
  proof.rollbackUnpublishRaceSingleCasWinner = true;

  const otherOwner = await db.rpc("request_publish_activation", { p_owner: B, p_release_id: R1,
    p_expected_version: version, p_operation: "activate", p_activation_deployment_id: null });
  assert.ok(otherOwner.error);
  const browserRows = await browser.from("publish_releases").select("id");
  if (browserRows.error) assert.equal(browserRows.error.code, "42501"); else assert.deepEqual(browserRows.data, []);
  proof.ownerIsolation = true;

  await register(R3, "c".repeat(64), null); await register(R4, "d".repeat(64), null);
  // A completed or pending active state must never permit two active releases or live deployments.
  assert.ok(Number(sql(`select count(*) from public.publish_releases where owner='${A}' and activation_state='active';`)) <= 1);
  assert.ok(Number(sql(`select count(*) from public.deployments where owner='${A}' and status='live';`)) <= 1);
  console.log(JSON.stringify({ ok: true, ...proof }, null, 2));
} finally {
  sql("drop trigger if exists c8_proof_fail_after_deployment_retirement on public.deployments; drop function if exists public.c8_proof_fail_after_deployment_retirement(); drop trigger if exists c8_proof_fail_before_completion_commit on public.publish_activation_intents; drop function if exists public.c8_proof_fail_before_completion_commit();");
  sql(`delete from auth.users where id in ('${A}','${B}');`);
  sql(`delete from public.deployments where owner in ('${A}','${B}');`);
  assert.equal(Number(sql(`select count(*) from public.publish_releases where owner in ('${A}','${B}');`)), 0);
  assert.equal(Number(sql(`select count(*) from public.publish_activation_intents where owner in ('${A}','${B}');`)), 0);
  assert.equal(Number(sql(`select count(*) from public.deployments where owner in ('${A}','${B}');`)), 0);
}
