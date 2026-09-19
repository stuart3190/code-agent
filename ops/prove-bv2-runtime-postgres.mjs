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
const PROJECTS = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `72000000-0000-4000-8000-00000000000${n}`);
const PROJECT_B = "72000000-0000-4000-8000-000000000009";
const V2_BUILDS = [1, 2, 3, 4, 5, 6, 7].map((n) => `73000000-0000-4000-8000-00000000000${n}`);
const V2_BUILD_B = "73000000-0000-4000-8000-000000000009";
const SETTLEMENT_PROJECTS = [
  "72000000-0000-4000-8000-000000000010",
  "72000000-0000-4000-8000-000000000011",
];
const SETTLEMENT_BUILDS = [
  "73000000-0000-4000-8000-000000000010",
  "73000000-0000-4000-8000-000000000011",
];
const PUBLIC_BUILDS = [1, 2, 3, 4, 5, 6, 7].map((n) => `74000000-0000-4000-8000-00000000000${n}`);
const MISSING_WORK_JOB = "75000000-0000-4000-8000-000000000099";
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
  const periodStart = "2000-01-01T00:00:00.000Z";
  const usage = lane === "managed"
    ? await db.from("ca_usage_records").select("id", { count: "exact", head: true })
      .eq("owner", OWNER_A).gte("created_at", periodStart)
    : { count: null, error: null };
  if (usage.error) throw new Error(`usage snapshot: ${usage.error.message}`);
  const result = await db.rpc("reserve_bv2_model_call_v4", {
    p_owner: OWNER_A, p_project_id: project, p_build_id: build, p_call_key: key,
    p_step: "generate", p_provider: "openai", p_model: "proof-model", p_billing_lane: lane,
    p_usage_responsibility: "customer_request", p_funding_pool: "customer_generation",
    p_reserved_credits: credits, p_ceiling_credits: ceiling, p_included_available_credits: available,
    p_usage_period_start: lane === "managed" ? periodStart : null,
    p_usage_row_count: lane === "managed" ? usage.count : null,
    p_metadata: { proof: true, logicalDispatchId: key, continuationIndex: 0, causalFiles: [] },
  });
  if (result.error) return result;
  return { ...result, data: one(result.data)?.reservation || one(result.data) };
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
    status: "running", phase: "running", pipeline_version: "v2", ...values,
  }), `public build ${index}`);
  const payload = {
    pipelineVersion: "v2", mode: "resume_repair",
    input: { prompt: `retry proof ${index}`, sourceBuildId: values.bv2_build_id || V2_BUILDS[index] || null },
    checkpointId: `77000000-0000-4000-8000-00000000000${index + 1}`,
    logicalDispatchId: `retry-dispatch-${index}`, continuationIndex: index + 1,
  };
  return one(unwrap(await db.rpc("build_work_enqueue", {
    p_owner: OWNER_A, p_project_id: project, p_build_id: PUBLIC_BUILDS[index],
    p_job_type: "builder_pipeline", p_payload: payload,
    p_idempotency_key: `runtime-retry-proof:${PUBLIC_BUILDS[index]}`,
    p_priority: 20, p_max_attempts: 2, p_resource_limits: {},
  }), `work job ${index}`));
}

const proof = {};
try {
  const activation = one(unwrap(await db.rpc("activate_bv2_owner_connected_recovery_policy", {
    p_deployment_commit: "a".repeat(40),
    p_deployment_manifest_sha256: "b".repeat(64),
    p_actor: "disposable_runtime_proof",
  }), "activate platform connected recovery policy"));
  assert.equal(activation.policyVersion, "owner_connected_recovery_v1");
  assert.equal(activation.executionTransport, "platform_connected_codex");
  assert.equal(activation.fundingSource, "thrallo");
  assert.equal(activation.deploymentCommit, "a".repeat(40));
  proof.recoveryPolicyActivation = "deployment_manifest_bound";
  await createPrincipal(OWNER_A, "a");
  await createPrincipal(OWNER_B, "b");
  unwrap(await db.from("projects").insert([
    ...PROJECTS.map((id, index) => ({ id, owner: OWNER_A, name: `runtime proof ${index}`, tree: {} })),
    ...SETTLEMENT_PROJECTS.map((id, index) => ({ id, owner: OWNER_A, name: `settlement proof ${index}`, tree: {} })),
    { id: PROJECT_B, owner: OWNER_B, name: "runtime proof owner b", tree: {} },
  ]), "projects");
  unwrap(await db.from("bv2_builds").insert([
    { id: V2_BUILDS[0], owner: OWNER_A, project_id: PROJECTS[0], profile: "proof", request: "proof 1" },
    { id: V2_BUILDS[1], owner: OWNER_A, project_id: PROJECTS[1], profile: "proof", request: "proof 2" },
    { id: V2_BUILDS[2], owner: OWNER_A, project_id: PROJECTS[2], profile: "proof", request: "proof 3" },
    { id: V2_BUILDS[3], owner: OWNER_A, project_id: PROJECTS[3], profile: "proof", request: "proof 4" },
    { id: V2_BUILDS[4], owner: OWNER_A, project_id: PROJECTS[4], profile: "proof", request: "proof 5" },
    { id: V2_BUILDS[5], owner: OWNER_A, project_id: PROJECTS[5], profile: "proof", request: "proof 6" },
    { id: V2_BUILDS[6], owner: OWNER_A, project_id: PROJECTS[6], profile: "proof", request: "proof 7" },
    { id: SETTLEMENT_BUILDS[0], owner: OWNER_A, project_id: SETTLEMENT_PROJECTS[0], profile: "proof", request: "refund proof" },
    { id: SETTLEMENT_BUILDS[1], owner: OWNER_A, project_id: SETTLEMENT_PROJECTS[1], profile: "proof", request: "service credit proof" },
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
  const settled = one(unwrap(await db.rpc("settle_bv2_model_call_v2", {
    p_owner: OWNER_A, p_reservation_id: managed.id, p_actual_credits: 2.25,
    p_usage: { input: 100, cached: 40, output: 20, reasoning: 5 },
    p_provider_request_ids: ["proof-provider-request-1"],
  }), "settlement"));
  assert.equal(settled.state, "settled");
  const settledAgain = one(unwrap(await db.rpc("settle_bv2_model_call_v2", {
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
  const duplicateProvider = await db.rpc("settle_bv2_model_call_v2", {
    p_owner: OWNER_A, p_reservation_id: collision.id, p_actual_credits: 1,
    p_usage: { input: 1, cached: 0, output: 1, reasoning: 0 },
    p_provider_request_ids: ["proof-provider-request-1"],
  });
  assert.ok(duplicateProvider.error);
  await release(collision.id);
  proof.providerTelemetryDeduplicated = true;

  const crossOwner = await db.rpc("settle_bv2_model_call_v2", {
    p_owner: OWNER_B, p_reservation_id: managed.id, p_actual_credits: 2.25,
    p_usage: {}, p_provider_request_ids: [],
  });
  assert.ok(crossOwner.error);

  unwrap(await browser.auth.signInWithPassword({
    email: "bv2-runtime-a@example.invalid", password: "Disposable-V2-Runtime-Proof!42",
  }), "browser sign-in");
  const browserActivation = await browser.rpc("activate_bv2_owner_connected_recovery_policy", {
    p_deployment_commit: "a".repeat(40), p_deployment_manifest_sha256: "b".repeat(64),
    p_actor: "browser_must_not_activate",
  });
  assert.ok(browserActivation.error);
  const browserRead = await browser.from("bv2_model_reservations").select("id");
  assert.ok(browserRead.error);
  const browserReserve = await browser.rpc("reserve_bv2_model_call_v4", {
    p_owner: OWNER_A, p_project_id: PROJECTS[0], p_build_id: V2_BUILDS[0],
    p_call_key: "proof-browser-denied", p_step: "generate", p_provider: "openai",
    p_model: "proof-model", p_billing_lane: "byok_api", p_usage_responsibility: "customer_request",
    p_funding_pool: "customer_generation", p_reserved_credits: 1, p_ceiling_credits: 10,
    p_included_available_credits: null, p_usage_period_start: null, p_usage_row_count: null, p_metadata: {},
  });
  assert.ok(browserReserve.error);
  proof.ownerAndBrowserIsolation = true;

  const managedRefundReservation = one(unwrap(await reserve({
    build: SETTLEMENT_BUILDS[0], project: SETTLEMENT_PROJECTS[0], key: "proof-managed-terminal-refund",
    lane: "managed", credits: 3, available: 10,
  }), "managed terminal reservation"));
  unwrap(await db.rpc("settle_bv2_model_call_v2", {
    p_owner: OWNER_A, p_reservation_id: managedRefundReservation.id, p_actual_credits: 2,
    p_usage: { input: 10, output: 2 }, p_provider_request_ids: ["proof-managed-terminal-refund"],
  }), "managed terminal usage settlement");
  const managedTerminal = one(unwrap(await db.rpc("settle_bv2_build_terminal", {
    p_owner: OWNER_A, p_build_id: SETTLEMENT_BUILDS[0], p_terminal_state: "failed",
    p_failure_classification: "generated_app", p_green_preview: false, p_compensation_eligible: true,
  }), "managed terminal settlement"));
  const managedTerminalAgain = one(unwrap(await db.rpc("settle_bv2_build_terminal", {
    p_owner: OWNER_A, p_build_id: SETTLEMENT_BUILDS[0], p_terminal_state: "failed",
    p_failure_classification: "generated_app", p_green_preview: false, p_compensation_eligible: true,
  }), "managed terminal settlement replay"));
  assert.equal(managedTerminalAgain.id, managedTerminal.id);
  assert.equal(Number(managedTerminal.managed_refund_credits), 2);
  assert.equal(Number(managedTerminal.service_credit_credits), 0);
  assert.equal(unwrap(await db.from("credit_ledger").select("id").eq("owner", OWNER_A)
    .eq("ref", `bv2-terminal:${SETTLEMENT_BUILDS[0]}`).eq("kind", "refund"), "managed refund ledger").length, 1);

  const connectedReservation = one(unwrap(await reserve({
    build: SETTLEMENT_BUILDS[1], project: SETTLEMENT_PROJECTS[1], key: "proof-connected-terminal-credit",
    lane: "connected_allowance", credits: 2,
  }), "connected terminal reservation"));
  unwrap(await db.rpc("settle_bv2_model_call_v2", {
    p_owner: OWNER_A, p_reservation_id: connectedReservation.id, p_actual_credits: 1.5,
    p_usage: { input: 8, output: 2 }, p_provider_request_ids: ["proof-connected-terminal-credit"],
  }), "connected terminal usage settlement");
  for (const [lane, provider] of [["managed", "openai"], ["byok_api", "openai"]]) {
    const forbiddenRecovery = await db.rpc("reserve_bv2_model_call_v4", {
      p_owner: OWNER_A, p_project_id: SETTLEMENT_PROJECTS[1], p_build_id: SETTLEMENT_BUILDS[1],
      p_call_key: `proof-forbidden-recovery-${lane}`, p_step: "repair", p_provider: provider,
      p_model: "proof-model", p_billing_lane: lane, p_usage_responsibility: "thrallo_repair",
      p_funding_pool: "thrallo_recovery", p_reserved_credits: 1, p_ceiling_credits: 10,
      p_included_available_credits: null, p_usage_period_start: null, p_usage_row_count: null,
      p_metadata: { proof: true, logicalDispatchId: `proof-forbidden-recovery-${lane}` },
    });
    assert.ok(forbiddenRecovery.error, `${lane} recovery must be rejected before dispatch`);
  }
  for (const responsibility of ["platform_failure", "qualification"]) {
    const forbiddenCustomerFunding = await db.rpc("reserve_bv2_model_call_v4", {
      p_owner: OWNER_A, p_project_id: SETTLEMENT_PROJECTS[1], p_build_id: SETTLEMENT_BUILDS[1],
      p_call_key: `proof-forbidden-customer-funding-${responsibility}`, p_step: "repair", p_provider: "codex",
      p_model: "proof-model", p_billing_lane: "connected_allowance", p_usage_responsibility: responsibility,
      p_funding_pool: "customer_generation", p_reserved_credits: 1, p_ceiling_credits: 10,
      p_included_available_credits: null, p_usage_period_start: null, p_usage_row_count: null,
      p_metadata: { proof: true, logicalDispatchId: `proof-forbidden-customer-funding-${responsibility}` },
    });
    assert.ok(forbiddenCustomerFunding.error,
      `${responsibility} cannot consume the customer generation pool`);
  }
  const recoveryReservation = one(unwrap(await db.rpc("reserve_bv2_model_call_v4", {
    p_owner: OWNER_A, p_project_id: SETTLEMENT_PROJECTS[1], p_build_id: SETTLEMENT_BUILDS[1],
    p_call_key: "proof-connected-recovery-not-compensated", p_step: "repair", p_provider: "codex",
    p_model: "proof-model", p_billing_lane: "connected_allowance", p_usage_responsibility: "thrallo_repair",
    p_funding_pool: "thrallo_recovery", p_reserved_credits: 1, p_ceiling_credits: 10,
    p_included_available_credits: null, p_usage_period_start: null, p_usage_row_count: null,
    p_metadata: { proof: true, logicalDispatchId: "proof-connected-recovery-not-compensated" },
  }), "platform connected recovery reservation"));
  unwrap(await db.rpc("settle_bv2_model_call_v2", {
    p_owner: OWNER_A, p_reservation_id: recoveryReservation.reservation.id, p_actual_credits: 0.75,
    p_usage: { input: 4, output: 1 }, p_provider_request_ids: ["proof-connected-recovery-not-compensated"],
  }), "platform connected recovery usage settlement");
  const connectedTerminal = one(unwrap(await db.rpc("settle_bv2_build_terminal", {
    p_owner: OWNER_A, p_build_id: SETTLEMENT_BUILDS[1], p_terminal_state: "failed",
    p_failure_classification: "generated_app", p_green_preview: false, p_compensation_eligible: true,
  }), "connected terminal settlement"));
  const connectedTerminalAgain = one(unwrap(await db.rpc("settle_bv2_build_terminal", {
    p_owner: OWNER_A, p_build_id: SETTLEMENT_BUILDS[1], p_terminal_state: "failed",
    p_failure_classification: "generated_app", p_green_preview: false, p_compensation_eligible: true,
  }), "connected terminal settlement replay"));
  assert.equal(connectedTerminalAgain.id, connectedTerminal.id);
  assert.equal(Number(connectedTerminal.managed_refund_credits), 0);
  assert.equal(Number(connectedTerminal.service_credit_credits), 1.5);
  assert.equal(Number(connectedTerminal.spent_breakdown["thrallo_recovery:thrallo_repair:connected_allowance"]), 0.75);
  assert.equal(unwrap(await db.from("credit_ledger").select("id").eq("owner", OWNER_A)
    .eq("ref", `bv2-terminal:${SETTLEMENT_BUILDS[1]}`).eq("kind", "service_credit"), "service credit ledger").length, 1);
  proof.terminalSettlement = { managedRefundIdempotent: true, serviceCreditIdempotent: true,
    recoveryCompensated: false };

  const beforeWork = await insertPublicBuild(0, PROJECTS[0]);
  const beforeProvider = one(unwrap(await db.rpc("prepare_bv2_pipeline_retry", {
    p_owner: OWNER_A, p_public_build_id: PUBLIC_BUILDS[0], p_work_job_id: beforeWork.id,
  }), "retry before provider"));
  assert.equal(beforeProvider.action, "restart_before_provider");
  assert.equal(beforeProvider.payloadRef, beforeWork.payload_ref);
  assert.equal(beforeProvider.payload.checkpointId, "77000000-0000-4000-8000-000000000001");
  assert.equal(beforeProvider.payload.logicalDispatchId, "retry-dispatch-0");
  assert.equal(beforeProvider.payload.continuationIndex, 1);

  const abandonedWork = await insertPublicBuild(1, PROJECTS[2], { bv2_build_id: V2_BUILDS[2] });
  const abandoned = one(unwrap(await db.rpc("prepare_bv2_pipeline_retry", {
    p_owner: OWNER_A, p_public_build_id: PUBLIC_BUILDS[1], p_work_job_id: abandonedWork.id,
  }), "retry abandoned build"));
  assert.equal(abandoned.action, "restart_before_provider");
  assert.equal(abandoned.payload.usageResponsibility, "platform_failure");
  assert.equal(abandoned.payload.recoveryOfBuildId, V2_BUILDS[2]);
  assert.equal(abandoned.payload.input.sourceBuildId, V2_BUILDS[2]);
  assert.equal(abandoned.payload.checkpointId, "77000000-0000-4000-8000-000000000002");
  assert.equal(abandoned.payload.logicalDispatchId, "retry-dispatch-1");
  assert.equal(abandoned.payload.continuationIndex, 2);
  const abandonedRow = one(unwrap(await db.from("build_jobs")
    .select("id,owner,project_id,work_job_id,bv2_build_id").eq("id", PUBLIC_BUILDS[1]).single(), "abandoned public row"));
  assert.equal(abandonedRow.bv2_build_id, null);
  assert.deepEqual({ id: abandonedRow.id, owner: abandonedRow.owner, project: abandonedRow.project_id,
    work: abandonedRow.work_job_id }, {
    id: PUBLIC_BUILDS[1], owner: OWNER_A, project: PROJECTS[2], work: abandonedWork.id,
  });
  const abandonedPayload = one(unwrap(await db.from("build_work_payloads")
    .select("id,owner,project_id,build_id,payload,payload_sha256,byte_size")
    .eq("id", abandonedWork.payload_ref).single(), "abandoned durable payload"));
  assert.equal(abandonedPayload.id, abandonedWork.payload_ref);
  assert.equal(abandonedPayload.owner, OWNER_A); assert.equal(abandonedPayload.project_id, PROJECTS[2]);
  assert.equal(abandonedPayload.build_id, PUBLIC_BUILDS[1]);
  assert.deepEqual(abandonedPayload.payload, abandoned.payload);
  assert.equal(abandonedPayload.payload_sha256, abandoned.payloadSha256);
  assert.equal(sql(`select payload_sha256=encode(extensions.digest(convert_to(payload::text,'UTF8'),'sha256'),'hex')
    and byte_size=octet_length(payload::text) from public.build_work_payloads where id='${abandonedWork.payload_ref}';`), "t");
  proof.durableRetryPayload = true;

  const unsafeWork = await insertPublicBuild(2, PROJECTS[3], { bv2_build_id: V2_BUILDS[3] });
  const unresolved = one(unwrap(await reserve({
    build: V2_BUILDS[3], project: PROJECTS[3], key: "proof-replay-unsafe",
  }), "unsafe reservation"));
  const unsafe = one(unwrap(await db.rpc("prepare_bv2_pipeline_retry", {
    p_owner: OWNER_A, p_public_build_id: PUBLIC_BUILDS[2], p_work_job_id: unsafeWork.id,
  }), "unsafe replay"));
  assert.equal(unsafe.action, "provider_replay_unsafe");
  assert.equal(unsafe.reservationCount, 1);
  assert.equal(unsafe.unresolvedReservationCount, 1);
  await release(unresolved.id);

  const recoveredWork = await insertPublicBuild(3, PROJECTS[4], {
    status: "complete", phase: "complete", result: { ok: true, snapshot: "green" },
    bv2_build_id: V2_BUILDS[4],
  });
  const recovered = one(unwrap(await db.rpc("prepare_bv2_pipeline_retry", {
    p_owner: OWNER_A, p_public_build_id: PUBLIC_BUILDS[3], p_work_job_id: recoveredWork.id,
  }), "durable recovery"));
  assert.equal(recovered.action, "recovered");
  assert.equal(recovered.result.snapshot, "green");

  const settledWork = await insertPublicBuild(4, PROJECTS[5], { bv2_build_id: V2_BUILDS[5] });
  const reconciled = one(unwrap(await reserve({
    build: V2_BUILDS[5], project: PROJECTS[5], key: "proof-retry-settled",
  }), "reconciled reservation"));
  unwrap(await db.rpc("settle_bv2_model_call_v2", {
    p_owner: OWNER_A, p_reservation_id: reconciled.id, p_actual_credits: 1,
    p_usage: { input: 1, cached: 0, output: 1, reasoning: 0 },
    p_provider_request_ids: ["proof-provider-retry-settled"],
  }), "reconciled settlement");
  const afterSettlement = one(unwrap(await db.rpc("prepare_bv2_pipeline_retry", {
    p_owner: OWNER_A, p_public_build_id: PUBLIC_BUILDS[4], p_work_job_id: settledWork.id,
  }), "retry after settled provider result"));
  assert.equal(afterSettlement.action, "restart_before_provider");
  assert.equal(afterSettlement.platformFunded, true);
  assert.equal(afterSettlement.payload.usageResponsibility, "platform_failure");

  const ambiguousWork = await insertPublicBuild(5, PROJECTS[6], { bv2_build_id: V2_BUILDS[6] });
  const ambiguousReservation = one(unwrap(await reserve({
    build: V2_BUILDS[6], project: PROJECTS[6], key: "proof-retry-ambiguous",
  }), "ambiguous reservation"));
  unwrap(await db.rpc("mark_bv2_model_call_ambiguous", {
    p_owner: OWNER_A, p_reservation_id: ambiguousReservation.id,
    p_reason: "disposable proof", p_provider_request_ids: ["proof-provider-retry-ambiguous"],
  }), "mark ambiguous");
  const ambiguousBlocked = one(unwrap(await db.rpc("prepare_bv2_pipeline_retry", {
    p_owner: OWNER_A, p_public_build_id: PUBLIC_BUILDS[5], p_work_job_id: ambiguousWork.id,
  }), "ambiguous retry blocked"));
  assert.equal(ambiguousBlocked.action, "provider_replay_unsafe");
  unwrap(await db.rpc("absorb_ambiguous_bv2_model_call", {
    p_owner: OWNER_A, p_reservation_id: ambiguousReservation.id, p_reason: "proof reconciliation",
  }), "absorb ambiguous");
  const ambiguousReconciled = one(unwrap(await db.rpc("prepare_bv2_pipeline_retry", {
    p_owner: OWNER_A, p_public_build_id: PUBLIC_BUILDS[5], p_work_job_id: ambiguousWork.id,
  }), "ambiguous retry reconciled"));
  assert.equal(ambiguousReconciled.action, "restart_before_provider");
  assert.equal(ambiguousReconciled.platformFunded, true);

  unwrap(await db.from("build_jobs").insert({
    id: PUBLIC_BUILDS[6], owner: OWNER_A, project_id: PROJECTS[7], mode: "build",
    status: "running", phase: "running", pipeline_version: "v2", work_job_id: MISSING_WORK_JOB,
  }), "missing retry-state public build");
  const missing = one(unwrap(await db.rpc("prepare_bv2_pipeline_retry", {
    p_owner: OWNER_A, p_public_build_id: PUBLIC_BUILDS[6], p_work_job_id: MISSING_WORK_JOB,
  }), "missing retry state"));
  assert.equal(missing.action, "retry_state_missing");
  assert.equal(missing.code, "durable_retry_state_missing");
  assert.equal(missing.reason, "work_job_missing");
  proof.retryBoundary = [beforeProvider.action, abandoned.action, unsafe.action, recovered.action,
    afterSettlement.action, ambiguousBlocked.action, ambiguousReconciled.action, missing.action];

  const wrongProjectLink = await db.from("build_jobs").update({ bv2_build_id: V2_BUILDS[1] }).eq("id", PUBLIC_BUILDS[0]);
  assert.ok(wrongProjectLink.error);
  unwrap(await db.from("diag_runs").insert({
    id: DIAG, owner: OWNER_A, project_id: PROJECTS[1], kind: "proof", status: "complete",
  }), "diagnostic row");
  const wrongDiagnosticLink = await db.from("build_jobs").update({ diag_run_id: DIAG }).eq("id", PUBLIC_BUILDS[0]);
  assert.ok(wrongDiagnosticLink.error);
  const browserRetry = await browser.rpc("prepare_bv2_pipeline_retry", {
    p_owner: OWNER_A, p_public_build_id: PUBLIC_BUILDS[0], p_work_job_id: beforeWork.id,
  });
  assert.ok(browserRetry.error);
  const crossOwnerRetry = await db.rpc("prepare_bv2_pipeline_retry", {
    p_owner: OWNER_B, p_public_build_id: PUBLIC_BUILDS[0], p_work_job_id: beforeWork.id,
  });
  assert.ok(crossOwnerRetry.error);
  proof.relationalOwnerProjectIsolation = true;

  const retryFunction = sql("select pg_get_functiondef('public.prepare_bv2_pipeline_retry(uuid,uuid,uuid)'::regprocedure);");
  assert.doesNotMatch(retryFunction, /update public\.build_work_jobs set\s+payload/i);
  assert.match(retryFunction, /update public\.build_work_payloads set/i);

  proof.catalog = JSON.parse(sql(`select json_build_object(
    'reservations', (select count(*) from public.bv2_model_reservations where owner='${OWNER_A}'),
    'usage', (select count(*) from public.ca_usage_records where owner='${OWNER_A}'),
    'v2PublicJobs', (select count(*) from public.build_jobs where owner='${OWNER_A}' and pipeline_version='v2'),
    'runtimeFunction', to_regprocedure('public.prepare_bv2_pipeline_retry(uuid,uuid,uuid)') is not null,
    'reservationFunction', to_regprocedure('public.reserve_bv2_model_call_v4(uuid,uuid,uuid,text,text,text,text,text,text,text,numeric,numeric,numeric,timestamptz,bigint,jsonb)') is not null
  );`));
  console.log(JSON.stringify({ ok: true, ...proof }, null, 2));
} finally {
  sql(`
    delete from public.diag_runs where owner in ('${OWNER_A}','${OWNER_B}');
    delete from auth.users where id in ('${OWNER_A}','${OWNER_B}');
  `);
}
