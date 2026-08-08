#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

if (process.env.BV2_RUNTIME_PROOF !== "1") throw new Error("BV2_RUNTIME_PROOF=1 is required");
const url = process.env.API_URL;
const serviceKey = process.env.SERVICE_ROLE_KEY;
const anonKey = process.env.ANON_KEY;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url || "") || !serviceKey || !anonKey) {
  throw new Error("runtime proof refuses any target except a loopback disposable Supabase stack");
}

const container = process.env.SUPABASE_DB_CONTAINER || "supabase_db_thrallo-migration-proof";
const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const browser = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
const OWNER_A = "71000000-0000-4000-8000-000000000001";
const OWNER_B = "71000000-0000-4000-8000-000000000002";
const PROJECTS = [1, 2, 3, 4, 5, 6].map((n) => `72000000-0000-4000-8000-00000000000${n}`);
const PROJECT_B = "72000000-0000-4000-8000-000000000007";
const V2_BUILDS = [1, 2, 3, 4, 5].map((n) => `73000000-0000-4000-8000-00000000000${n}`);
const V2_BUILD_B = "73000000-0000-4000-8000-000000000006";
const PUBLIC_BUILDS = [1, 2, 3, 4].map((n) => `74000000-0000-4000-8000-00000000000${n}`);
const WORK_JOBS = [1, 2, 3, 4].map((n) => `75000000-0000-4000-8000-00000000000${n}`);
const DIAG = "76000000-0000-4000-8000-000000000001";

const one = (value) => Array.isArray(value) ? value[0] : value;
function unwrap(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}
function sql(statement) {
  return execFileSync("docker", ["exec", "-i", container, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres", "-At"], {
    input: statement, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}
async function reserve({ build = V2_BUILDS[0], project = PROJECTS[0], key, lane = "byok_api", credits = 1, ceiling = 10, available = null }) {
  return db.rpc("reserve_bv2_model_call", {
    p_owner: OWNER_A, p_project_id: project, p_build_id: build, p_call_key: key,
    p_step: "generate", p_provider: "openai", p_model: "proof-model", p_billing_lane: lane,
    p_reserved_credits: credits, p_ceiling_credits: ceiling,
    p_account_available_credits: available, p_metadata: { proof: true },
  });
}
async function release(id) {
  return one(unwrap(await db.rpc("release_bv2_model_call", {
    p_owner: OWNER_A, p_reservation_id: id,
  }), "release"));
}
async function createPrincipal(id, suffix) {
  const created = await db.auth.admin.createUser({
    id, email: `bv2-runtime-${suffix}@example.invalid`, password: "Disposable-V2-Runtime-Proof!42",
    email_confirm: true,
  });
  if (created.error && !/already/i.test(created.error.message)) throw created.error;
}
async function insertPublicBuild(index, project, values = {}) {
  unwrap(await db.from("build_jobs").insert({
    id: PUBLIC_BUILDS[index], owner: OWNER_A, project_id: project, mode: "build",
    status: "running", phase: "running", server_id: "runtime-proof", pipeline_version: "v2",
    work_job_id: WORK_JOBS[index], ...values,
  }), `public build ${index}`);
}

const proof = {};
try {
  await createPrincipal(OWNER_A, "a");
  await createPrincipal(OWNER_B, "b");
  unwrap(await db.from("projects").insert([
    ...PROJECTS.map((id, index) => ({ id, owner: OWNER_A, name: `runtime proof ${index}`, tree: {} })),
    { id: PROJECT_B, owner: OWNER_B, name: "runtime proof owner b", tree: {} },
  ]), "projects");
  unwrap(await db.from("bv2_builds").insert([
    { id: V2_BUILDS[0], owner: OWNER_A, project_id: PROJECTS[0], profile: "proof", request: "proof 1" },
    { id: V2_BUILDS[1], owner: OWNER_A, project_id: PROJECTS[1], profile: "proof", request: "proof 2" },
    { id: V2_BUILDS[2], owner: OWNER_A, project_id: PROJECTS[2], profile: "proof", request: "proof 3" },
    { id: V2_BUILDS[3], owner: OWNER_A, project_id: PROJECTS[3], profile: "proof", request: "proof 4" },
    { id: V2_BUILDS[4], owner: OWNER_A, project_id: PROJECTS[4], profile: "proof", request: "proof 5" },
    { id: V2_BUILD_B, owner: OWNER_B, project_id: PROJECT_B, profile: "proof", request: "proof b" },
  ]), "V2 builds");

  const first = one(unwrap(await reserve({ key: "proof-idempotent" }), "first reservation"));
  const duplicate = one(unwrap(await reserve({ key: "proof-idempotent" }), "duplicate reservation"));
  assert.equal(duplicate.id, first.id);
  const conflict = await reserve({ key: "proof-idempotent", credits: 2 });
  assert.ok(conflict.error);
  await release(first.id);
  proof.reservationIdempotency = true;

  const ceilingRace = await Promise.all([
    reserve({ key: "proof-ceiling-race-a", credits: 6, ceiling: 10 }),
    reserve({ key: "proof-ceiling-race-b", credits: 6, ceiling: 10 }),
  ]);
  assert.equal(ceilingRace.filter((result) => !result.error).length, 1);
  assert.equal(ceilingRace.filter((result) => result.error).length, 1);
  await release(one(ceilingRace.find((result) => !result.error).data).id);
  proof.concurrentBuildCeiling = "one_winner";

  const ownerRace = await Promise.all([
    reserve({ build: V2_BUILDS[0], project: PROJECTS[0], key: "proof-owner-race-a", lane: "managed", credits: 6, available: 10 }),
    reserve({ build: V2_BUILDS[1], project: PROJECTS[1], key: "proof-owner-race-b", lane: "managed", credits: 6, available: 10 }),
  ]);
  assert.equal(ownerRace.filter((result) => !result.error).length, 1);
  assert.equal(ownerRace.filter((result) => result.error).length, 1);
  const managed = one(ownerRace.find((result) => !result.error).data);
  const settled = one(unwrap(await db.rpc("settle_bv2_model_call", {
    p_owner: OWNER_A, p_reservation_id: managed.id, p_actual_credits: 2.25,
    p_usage: { input: 100, cached: 40, output: 20, reasoning: 5 },
    p_provider_request_ids: ["proof-provider-request-1"],
  }), "settlement"));
  assert.equal(settled.state, "settled");
  const settledAgain = one(unwrap(await db.rpc("settle_bv2_model_call", {
    p_owner: OWNER_A, p_reservation_id: managed.id, p_actual_credits: 2.25,
    p_usage: { input: 100, cached: 40, output: 20, reasoning: 5 },
    p_provider_request_ids: ["proof-provider-request-1"],
  }), "duplicate settlement"));
  assert.equal(settledAgain.id, managed.id);
  const usageRows = unwrap(await db.from("ca_usage_records").select("id").eq("id", managed.id), "usage rows");
  assert.equal(usageRows.length, 1);
  proof.ownerWideReservation = "one_winner";
  proof.settlementExactlyOnce = true;

  const collision = one(unwrap(await reserve({
    build: V2_BUILDS[1], project: PROJECTS[1], key: "proof-provider-collision",
    lane: "managed", credits: 1, available: 10,
  }), "collision reservation"));
  const duplicateProvider = await db.rpc("settle_bv2_model_call", {
    p_owner: OWNER_A, p_reservation_id: collision.id, p_actual_credits: 1,
    p_usage: { input: 1, cached: 0, output: 1, reasoning: 0 },
    p_provider_request_ids: ["proof-provider-request-1"],
  });
  assert.ok(duplicateProvider.error);
  await release(collision.id);
  proof.providerTelemetryDeduplicated = true;

  const crossOwner = await db.rpc("settle_bv2_model_call", {
    p_owner: OWNER_B, p_reservation_id: managed.id, p_actual_credits: 2.25,
    p_usage: {}, p_provider_request_ids: [],
  });
  assert.ok(crossOwner.error);

  unwrap(await browser.auth.signInWithPassword({
    email: "bv2-runtime-a@example.invalid", password: "Disposable-V2-Runtime-Proof!42",
  }), "browser sign-in");
  const browserRead = await browser.from("bv2_model_reservations").select("id");
  assert.ok(browserRead.error);
  const browserReserve = await browser.rpc("reserve_bv2_model_call", {
    p_owner: OWNER_A, p_project_id: PROJECTS[0], p_build_id: V2_BUILDS[0],
    p_call_key: "proof-browser-denied", p_step: "generate", p_provider: "openai",
    p_model: "proof-model", p_billing_lane: "byok_api", p_reserved_credits: 1,
    p_ceiling_credits: 10, p_account_available_credits: null, p_metadata: {},
  });
  assert.ok(browserReserve.error);
  proof.ownerAndBrowserIsolation = true;

  await insertPublicBuild(0, PROJECTS[0]);
  const beforeProvider = one(unwrap(await db.rpc("prepare_bv2_pipeline_retry", {
    p_owner: OWNER_A, p_public_build_id: PUBLIC_BUILDS[0], p_work_job_id: WORK_JOBS[0],
  }), "retry before provider"));
  assert.equal(beforeProvider.action, "restart_before_provider");

  await insertPublicBuild(1, PROJECTS[2], { bv2_build_id: V2_BUILDS[2] });
  const abandoned = one(unwrap(await db.rpc("prepare_bv2_pipeline_retry", {
    p_owner: OWNER_A, p_public_build_id: PUBLIC_BUILDS[1], p_work_job_id: WORK_JOBS[1],
  }), "retry abandoned build"));
  assert.equal(abandoned.action, "restart_before_provider");
  const abandonedRow = one(unwrap(await db.from("build_jobs").select("bv2_build_id").eq("id", PUBLIC_BUILDS[1]).single(), "abandoned public row"));
  assert.equal(abandonedRow.bv2_build_id, null);

  await insertPublicBuild(2, PROJECTS[3], { bv2_build_id: V2_BUILDS[3] });
  unwrap(await reserve({ build: V2_BUILDS[3], project: PROJECTS[3], key: "proof-replay-unsafe" }), "unsafe reservation");
  const unsafe = one(unwrap(await db.rpc("prepare_bv2_pipeline_retry", {
    p_owner: OWNER_A, p_public_build_id: PUBLIC_BUILDS[2], p_work_job_id: WORK_JOBS[2],
  }), "unsafe replay"));
  assert.equal(unsafe.action, "provider_replay_unsafe");
  assert.equal(unsafe.reservationCount, 1);

  await insertPublicBuild(3, PROJECTS[4], {
    status: "complete", phase: "complete", result: { ok: true, snapshot: "green" },
    bv2_build_id: V2_BUILDS[4],
  });
  const recovered = one(unwrap(await db.rpc("prepare_bv2_pipeline_retry", {
    p_owner: OWNER_A, p_public_build_id: PUBLIC_BUILDS[3], p_work_job_id: WORK_JOBS[3],
  }), "durable recovery"));
  assert.equal(recovered.action, "recovered");
  assert.equal(recovered.result.snapshot, "green");
  proof.retryBoundary = [beforeProvider.action, abandoned.action, unsafe.action, recovered.action];

  const wrongProjectLink = await db.from("build_jobs").update({ bv2_build_id: V2_BUILDS[1] }).eq("id", PUBLIC_BUILDS[0]);
  assert.ok(wrongProjectLink.error);
  unwrap(await db.from("diag_runs").insert({
    id: DIAG, owner: OWNER_A, project_id: PROJECTS[1], kind: "proof", status: "complete",
  }), "diagnostic row");
  const wrongDiagnosticLink = await db.from("build_jobs").update({ diag_run_id: DIAG }).eq("id", PUBLIC_BUILDS[0]);
  assert.ok(wrongDiagnosticLink.error);
  const browserRetry = await browser.rpc("prepare_bv2_pipeline_retry", {
    p_owner: OWNER_A, p_public_build_id: PUBLIC_BUILDS[0], p_work_job_id: WORK_JOBS[0],
  });
  assert.ok(browserRetry.error);
  proof.relationalOwnerProjectIsolation = true;

  proof.catalog = JSON.parse(sql(`select json_build_object(
    'reservations', (select count(*) from public.bv2_model_reservations where owner='${OWNER_A}'),
    'usage', (select count(*) from public.ca_usage_records where owner='${OWNER_A}'),
    'v2PublicJobs', (select count(*) from public.build_jobs where owner='${OWNER_A}' and pipeline_version='v2'),
    'runtimeFunction', to_regprocedure('public.prepare_bv2_pipeline_retry(uuid,uuid,uuid)') is not null,
    'reservationFunction', to_regprocedure('public.reserve_bv2_model_call(uuid,uuid,uuid,text,text,text,text,text,numeric,numeric,numeric,jsonb)') is not null
  );`));
  console.log(JSON.stringify({ ok: true, ...proof }, null, 2));
} finally {
  sql(`
    delete from public.diag_runs where owner in ('${OWNER_A}','${OWNER_B}');
    delete from auth.users where id in ('${OWNER_A}','${OWNER_B}');
  `);
}
