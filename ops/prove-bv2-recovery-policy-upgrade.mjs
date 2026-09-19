#!/usr/bin/env node

// Two-phase, zero-provider proof for the production-shaped 79 -> 80 -> 81 upgrade.
// Run `seed` after resetting to migration 79, apply 80 and 81, then run `verify`.

import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

if (process.env.BV2_RECOVERY_POLICY_UPGRADE_PROOF !== "1") {
  throw new Error("BV2_RECOVERY_POLICY_UPGRADE_PROOF=1 is required");
}
const url = process.env.API_URL;
const serviceKey = process.env.SERVICE_ROLE_KEY;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url || "") || !serviceKey) {
  throw new Error("recovery policy upgrade proof refuses any target except loopback disposable Supabase");
}
const phase = process.argv[2];
if (!new Set(["seed", "verify", "cleanup"]).has(phase)) {
  throw new Error("usage: prove-bv2-recovery-policy-upgrade.mjs <seed|verify|cleanup>");
}

const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const OWNER = "81000000-0000-4000-8000-000000000001";
const PROJECT = "82000000-0000-4000-8000-000000000001";
const BUILD = "83000000-0000-4000-8000-000000000001";
const COMMIT = "c".repeat(40);
const MANIFEST = "d".repeat(64);

function unwrap(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}
const one = (value) => Array.isArray(value) ? value[0] : value;
const at = (minute, second = 0) => `2026-08-22T18:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`;
const connectedActual = Array.from({ length: 20 }, (_, index) => index === 19 ? 3.34536 : 1);
const settledShape = ({ key, lane, responsibility, actual, createdAt, providerId, allocations = {} }) => ({
  owner: OWNER, project_id: PROJECT, build_id: BUILD, call_key: key, step: "repair",
  provider: lane === "connected_allowance" ? "anthropic" : "openai", model: "historical-model",
  billing_lane: lane, usage_responsibility: responsibility, state: "settled",
  reserved_credits: actual + 0.5, actual_credits: actual,
  included_reserved_credits: allocations.includedReserved || 0,
  purchased_reserved_credits: allocations.purchasedReserved || 0,
  platform_reserved_credits: allocations.platformReserved || 0,
  included_actual_credits: allocations.includedActual || 0,
  purchased_actual_credits: allocations.purchasedActual || 0,
  platform_actual_credits: allocations.platformActual || 0,
  usage: { input: 100, output: 20, proof: key }, provider_request_ids: [providerId],
  provider_request_fingerprint: `fingerprint-${key}`, reconciliation_state: "provider_settled",
  created_at: createdAt, settled_at: createdAt, reconciled_at: createdAt,
  metadata: { compatibilityProof: true, originalKey: key },
});

const productionConnected = connectedActual.map((actual, index) => settledShape({
  key: `prod-connected-repair-${String(index + 1).padStart(2, "0")}`,
  lane: "connected_allowance", responsibility: "thrallo_repair", actual,
  createdAt: at(25 + Math.floor(index / 4), index % 4), providerId: `connected-request-${index + 1}`,
}));
const historicalRows = [
  ...productionConnected,
  settledShape({ key: "historical-managed-repair", lane: "managed", responsibility: "thrallo_repair",
    actual: 1.25, createdAt: at(31), providerId: "managed-repair-request",
    allocations: { platformReserved: 1.75, platformActual: 1.25 } }),
  {
    owner: OWNER, project_id: PROJECT, build_id: BUILD, call_key: "historical-released-repair",
    step: "repair", provider: "anthropic", model: "historical-model", billing_lane: "connected_allowance",
    usage_responsibility: "thrallo_repair", state: "released", reserved_credits: 0.75,
    included_reserved_credits: 0, purchased_reserved_credits: 0, platform_reserved_credits: 0,
    reconciliation_state: "provider_rejected", created_at: at(32), released_at: at(33), reconciled_at: at(33),
    metadata: { compatibilityProof: true, originalKey: "historical-released-repair" },
  },
  {
    owner: OWNER, project_id: PROJECT, build_id: BUILD, call_key: "historical-ambiguous-repair",
    step: "repair", provider: "anthropic", model: "historical-model", billing_lane: "connected_allowance",
    usage_responsibility: "thrallo_repair", state: "held", reserved_credits: 0.9,
    included_reserved_credits: 0, purchased_reserved_credits: 0, platform_reserved_credits: 0,
    provider_request_ids: ["ambiguous-request"], provider_request_fingerprint: "fingerprint-historical-ambiguous",
    reconciliation_state: "pending", reconciliation_reason: "historical provider result pending",
    ambiguous_at: at(34), created_at: at(34), metadata: { compatibilityProof: true, originalKey: "historical-ambiguous-repair" },
  },
  settledShape({ key: "historical-connected-customer", lane: "connected_allowance", responsibility: "customer_request",
    actual: 0.8, createdAt: at(35), providerId: "connected-customer-request" }),
  settledShape({ key: "historical-managed-customer", lane: "managed", responsibility: "customer_request",
    actual: 1, createdAt: at(36), providerId: "managed-customer-request",
    allocations: { includedReserved: 1.5, includedActual: 1 } }),
];

const preserved = (row) => ({
  owner: row.owner, project_id: row.project_id, build_id: row.build_id, call_key: row.call_key,
  provider: row.provider, model: row.model, billing_lane: row.billing_lane,
  usage_responsibility: row.usage_responsibility, state: row.state,
  reserved_credits: Number(row.reserved_credits), actual_credits: row.actual_credits == null ? null : Number(row.actual_credits),
  provider_request_ids: row.provider_request_ids || null,
  provider_request_fingerprint: row.provider_request_fingerprint || null,
  reconciliation_state: row.reconciliation_state,
});

async function reserveV3({ key, lane = "connected_allowance", responsibility = "thrallo_repair" }) {
  return db.rpc("reserve_bv2_model_call_v3", {
    p_owner: OWNER, p_project_id: PROJECT, p_build_id: BUILD, p_call_key: key,
    p_step: responsibility === "thrallo_repair" ? "correction" : "generate",
    p_provider: "proof-provider", p_model: "proof-model", p_billing_lane: lane,
    p_usage_responsibility: responsibility, p_reserved_credits: 0.2, p_ceiling_credits: 1000,
    p_included_available_credits: null, p_usage_period_start: null, p_usage_row_count: null,
    p_metadata: { compatibilityProof: true },
  });
}

async function reserveV4({ key, lane, responsibility, pool }) {
  const managedCustomer = lane === "managed" && responsibility === "customer_request";
  const periodStart = "2000-01-01T00:00:00.000Z";
  const usage = managedCustomer
    ? await db.from("ca_usage_records").select("id", { count: "exact", head: true }).eq("owner", OWNER).gte("created_at", periodStart)
    : { count: null, error: null };
  if (usage.error) throw usage.error;
  return db.rpc("reserve_bv2_model_call_v4", {
    p_owner: OWNER, p_project_id: PROJECT, p_build_id: BUILD, p_call_key: key,
    p_step: responsibility === "thrallo_repair" ? "repair" : "generate",
    p_provider: "proof-provider", p_model: "proof-model", p_billing_lane: lane,
    p_usage_responsibility: responsibility, p_funding_pool: pool,
    p_reserved_credits: 0.2, p_ceiling_credits: 1000,
    p_included_available_credits: managedCustomer ? 100 : null,
    p_usage_period_start: managedCustomer ? periodStart : null,
    p_usage_row_count: managedCustomer ? usage.count : null,
    p_metadata: { compatibilityProof: true, logicalDispatchId: key },
  });
}

if (phase === "seed") {
  const created = await db.auth.admin.createUser({ id: OWNER, email: "bv2-policy-upgrade@example.invalid",
    password: "Disposable-Recovery-Policy-Proof!42", email_confirm: true });
  if (created.error && !/already/i.test(created.error.message)) throw created.error;
  unwrap(await db.from("projects").insert({ id: PROJECT, owner: OWNER, name: "recovery policy upgrade proof", tree: {} }), "project");
  unwrap(await db.from("bv2_builds").insert({ id: BUILD, owner: OWNER, project_id: PROJECT,
    profile: "proof", request: "production-shaped recovery policy upgrade" }), "build");
  unwrap(await db.from("bv2_model_reservations").insert(historicalRows), "historical reservations");
  unwrap(await db.from("credit_ledger").insert({ owner: OWNER, delta: 5, bucket: "bundle", kind: "grant",
    ref: "recovery-policy-upgrade-baseline" }), "credit baseline");
  const rows = unwrap(await db.from("bv2_model_reservations").select("*").eq("owner", OWNER), "seed readback");
  assert.equal(rows.length, historicalRows.length);
  assert.equal(rows.filter((row) => row.call_key.startsWith("prod-connected-repair-")).length, 20);
  assert.ok(Math.abs(rows.filter((row) => row.call_key.startsWith("prod-connected-repair-"))
    .reduce((sum, row) => sum + Number(row.actual_credits), 0) - 22.34536) < 1e-9);
  console.log(JSON.stringify({ ok: true, phase, rows: rows.length, productionRows: 20, actualCredits: 22.34536 }));
}

if (phase === "verify") {
  const rows = unwrap(await db.from("bv2_model_reservations").select("*")
    .eq("owner", OWNER).contains("metadata", { compatibilityProof: true }), "upgraded reservations");
  assert.equal(rows.length, historicalRows.length);
  const expected = new Map(historicalRows.map((row) => [row.call_key, preserved(row)]));
  for (const row of rows) {
    assert.deepEqual(preserved(row), expected.get(row.call_key), `historical evidence changed for ${row.call_key}`);
    assert.equal(row.recovery_policy_version, "legacy_v1");
    const expectedPool = row.usage_responsibility === "thrallo_repair" && row.billing_lane === "managed"
      ? "thrallo_recovery" : "customer_generation";
    assert.equal(row.funding_pool, expectedPool);
  }
  const productionRows = rows.filter((row) => row.call_key.startsWith("prod-connected-repair-"));
  assert.equal(productionRows.length, 20);
  assert.ok(Math.abs(productionRows.reduce((sum, row) => sum + Number(row.actual_credits), 0) - 22.34536) < 1e-9);
  assert.ok(productionRows.every((row) => row.billing_lane === "connected_allowance"));

  const ledgerBefore = unwrap(await db.from("credit_ledger").select("kind,delta").eq("owner", OWNER), "ledger after migration");
  assert.deepEqual(ledgerBefore.map((row) => row.kind), ["grant"]);
  assert.equal(unwrap(await db.from("bv2_build_settlements").select("id").eq("owner", OWNER), "settlements after migration").length, 0);
  assert.equal(unwrap(await db.from("bv2_feature_flags").select("key").eq("key", "recovery.funding_policy"), "activation before release").length, 0);

  const beforeActivation = await reserveV4({ key: "v4-before-activation", lane: "managed",
    responsibility: "thrallo_repair", pool: "thrallo_recovery" });
  assert.equal(beforeActivation.error?.code, "P14P1");
  const transitional = one(unwrap(await reserveV3({ key: "legacy-transition-repair" }), "legacy transition reserve"));
  assert.equal(transitional.reservation.recovery_policy_version, "legacy_v1");
  assert.equal(transitional.reservation.funding_pool, "customer_generation");
  unwrap(await db.rpc("release_bv2_model_call", { p_owner: OWNER,
    p_reservation_id: transitional.reservation.id }), "release transition reserve");

  const activation = one(unwrap(await db.rpc("activate_bv2_managed_recovery_policy", {
    p_deployment_commit: COMMIT, p_deployment_manifest_sha256: MANIFEST,
    p_actor: "production_shape_upgrade_proof",
  }), "activate policy"));
  assert.equal(activation.deploymentCommit, COMMIT);
  assert.equal(activation.deploymentManifestSha256, MANIFEST);
  const activationAgain = one(unwrap(await db.rpc("activate_bv2_managed_recovery_policy", {
    p_deployment_commit: COMMIT, p_deployment_manifest_sha256: MANIFEST,
    p_actor: "production_shape_upgrade_proof",
  }), "activate policy idempotently"));
  assert.equal(activationAgain.activatedAt, activation.activatedAt);
  const conflictingActivation = await db.rpc("activate_bv2_managed_recovery_policy", {
    p_deployment_commit: COMMIT, p_deployment_manifest_sha256: "e".repeat(64),
    p_actor: "production_shape_upgrade_proof",
  });
  assert.equal(conflictingActivation.error?.code, "23505");

  assert.equal((await reserveV3({ key: "legacy-post-activation-repair" })).error?.code, "P14P1");
  assert.equal((await reserveV3({ key: "legacy-transition-repair" })).error?.code, "P14P1");
  for (const lane of ["connected_allowance", "byok_api"]) {
    const rejected = await reserveV4({ key: `recovery-rejected-${lane}`, lane,
      responsibility: "thrallo_repair", pool: "thrallo_recovery" });
    assert.ok(rejected.error, `${lane} repair must be rejected`);
  }
  const customerPoolRepair = await reserveV4({ key: "recovery-rejected-customer-pool", lane: "managed",
    responsibility: "thrallo_repair", pool: "customer_generation" });
  assert.ok(customerPoolRepair.error);

  const managedRecovery = one(unwrap(await reserveV4({ key: "managed-recovery-accepted", lane: "managed",
    responsibility: "thrallo_repair", pool: "thrallo_recovery" }), "managed recovery"));
  assert.equal(managedRecovery.reservation.billing_lane, "managed");
  assert.equal(managedRecovery.reservation.funding_pool, "thrallo_recovery");
  assert.equal(managedRecovery.reservation.recovery_policy_version, "managed_recovery_v1");
  const customerIds = [];
  for (const lane of ["managed", "connected_allowance", "byok_api"]) {
    const customer = one(unwrap(await reserveV4({ key: `customer-accepted-${lane}`, lane,
      responsibility: "customer_request", pool: "customer_generation" }), `${lane} customer request`));
    assert.equal(customer.reservation.usage_responsibility, "customer_request");
    assert.equal(customer.reservation.funding_pool, "customer_generation");
    customerIds.push(customer.reservation.id);
  }
  for (const id of [managedRecovery.reservation.id, ...customerIds]) {
    unwrap(await db.rpc("release_bv2_model_call", { p_owner: OWNER, p_reservation_id: id }), "release accepted proof reservation");
  }

  const ledgerAfter = unwrap(await db.from("credit_ledger").select("kind,delta").eq("owner", OWNER), "final ledger");
  assert.deepEqual(ledgerAfter, ledgerBefore);
  console.log(JSON.stringify({ ok: true, phase, productionRows: 20, actualCredits: 22.34536,
    historicalEvidencePreserved: true, migrationCompensationWrites: 0,
    activationIdentity: `${COMMIT}:${MANIFEST}`, managedOnlyRecovery: true, customerRequestLanes: 3 }));
}

if (phase === "cleanup") {
  const removed = await db.auth.admin.deleteUser(OWNER);
  if (removed.error && !/not found/i.test(removed.error.message)) throw removed.error;
  unwrap(await db.from("bv2_feature_flags").delete().eq("key", "recovery.funding_policy"), "activation cleanup");
  console.log(JSON.stringify({ ok: true, phase }));
}
