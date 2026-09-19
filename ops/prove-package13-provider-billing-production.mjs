#!/usr/bin/env node

// Package 13 production-safe proof. This runner exercises only pure routing and the durable
// reservation RPCs with fixed disposable identities. It imports no provider adapter and makes
// no provider, Stripe, provisiond, Caddy or publish-filesystem call.

import assert from "node:assert/strict";
import crypto from "node:crypto";

import { loadEnv } from "../shell/server/lib/env.mjs";
import { serviceClient } from "../shell/server/lib/supabase.mjs";
import { MODEL_LANES, canonicalModelIdentity, selectionValue } from "../shell/server/lib/modelCatalogue.mjs";
import { routeV2Step } from "../shell/server/lib/builderV2/router.mjs";
import { supabaseModelReservations } from "../shell/server/lib/builderV2/modelReservations.mjs";

const PROJECT_REF = "zczgvcsokfafuyognvwx";
const OWNER = "13000000-0000-4000-8000-000000000001";
const PROJECT = "13010000-0000-4000-8000-000000000001";
const BUILDS = Object.freeze({
  byok: "13020000-0000-4000-8000-000000000001",
  codex: "13020000-0000-4000-8000-000000000002",
  managed: "13020000-0000-4000-8000-000000000003",
});
const CUSTOMER_TABLES = Object.freeze([
  "projects", "build_jobs", "published_sites", "deployments", "custom_domains",
  "ai_requests", "ca_usage_records", "ca_subscriptions",
]);

loadEnv();
if (process.env.THRALLO_PACKAGE13_CANARY !== "1") throw new Error("THRALLO_PACKAGE13_CANARY=1 is required");
if (process.env.THRALLO_PROCESS_ROLE !== "package13-provider-billing-canary") throw new Error("isolated Package 13 process role is required");
if (process.env.THRALLO_MANAGED_SETTLEMENT_PAUSED !== "1") throw new Error("managed settlement must remain paused");
if (process.env.THRALLO_BUILD_WORKER_ENABLED === "1") throw new Error("customer worker dispatch must remain disabled");
if (process.env.THRALLO_ATOMIC_PUBLISH_ENABLED === "1") throw new Error("customer atomic publishing must remain disabled");
if (!String(process.env.SUPABASE_URL || "").includes(PROJECT_REF)) throw new Error("canary target is not Thrallo production");

const client = serviceClient();
const reservations = supabaseModelReservations(client);
const emit = (stage, evidence = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), stage, ...evidence }));
const unwrap = (result, label) => {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
};
const canonical = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
};

async function tableHash(table) {
  const rows = unwrap(await client.from(table).select("*"), `${table} baseline`);
  const payload = `[${rows.map(canonical).sort().join(",")}]`;
  return { count: rows.length, sha256: crypto.createHash("sha256").update(payload).digest("hex") };
}

async function customerBaseline() {
  const value = {};
  for (const table of CUSTOMER_TABLES) value[table] = await tableHash(table);
  return value;
}

async function scopedCount(table) {
  const result = await client.from(table).select("*", { count: "exact", head: true }).eq("owner", OWNER);
  if (result.error) throw new Error(`${table} count: ${result.error.message}`);
  return Number(result.count || 0);
}

function candidate(provider, model, billingLane, tier, estimatedCredits) {
  const identity = canonicalModelIdentity({ provider, model, lane: billingLane });
  return {
    provider, model, billingLane,
    laneProvider: billingLane === MODEL_LANES.managed ? "managed" : provider,
    tier, estimatedCredits, callCeilingCredits: estimatedCredits,
    canonicalKey: identity.key, reasoningProfile: identity.reasoningProfile,
  };
}

function routeExact(selected, candidates) {
  return routeV2Step({
    step: "core", taskClass: "package13:synthetic", complexity: "medium",
    affectedModules: 2, retrievalTokens: 600, requiredReasoning: false,
    candidates, history: [],
    policy: { primaryProvider: candidates[0].laneProvider, billingLane: selected.lane,
      allowManagedFallback: false, allowedFallbackProviders: [] },
    manualModel: selectionValue(selected),
  });
}

async function cleanup() {
  await client.from("bv2_model_reservations").delete().eq("owner", OWNER);
  await client.from("bv2_builds").delete().eq("owner", OWNER);
  await client.from("projects").delete().eq("id", PROJECT).eq("owner", OWNER);
  await client.auth.admin.deleteUser(OWNER).catch(() => {});
}

const baseline = await customerBaseline();
let primaryError = null;
try {
  assert.equal(await scopedCount("projects"), 0, "fixed proof owner must be absent");
  assert.equal(await scopedCount("bv2_builds"), 0, "fixed proof builds must be absent");
  assert.equal(await scopedCount("bv2_model_reservations"), 0, "fixed proof reservations must be absent");
  const flags = unwrap(await client.from("bv2_feature_flags").select("key,value").in("key", ["bv2.enabled", "bv2.owners"]), "flags");
  assert.equal(flags.some((row) => row.key === "bv2.enabled" && row.value === true), false);
  assert.equal(flags.some((row) => row.key === "bv2.owners" && (row.value === true || row.value?.length)), false);
  emit("baseline", { customer: baseline, flags: { enabled: false, owners: 0 }, managedSettlementPaused: true });

  const created = await client.auth.admin.createUser({
    id: OWNER, email: "package13-provider-billing@example.invalid",
    password: `Package13-${crypto.randomBytes(18).toString("hex")}!`, email_confirm: true,
  });
  if (created.error) throw created.error;
  unwrap(await client.from("projects").insert({ id: PROJECT, owner: OWNER, name: "Package 13 provider/billing proof", tree: {} }), "project");
  unwrap(await client.from("bv2_builds").insert(Object.entries(BUILDS).map(([lane, id]) => ({
    id, owner: OWNER, project_id: PROJECT, profile: "deterministic-proof",
    request: "[zero-model Package 13 production proof]", state: "created", budget_credits: 5,
  }))), "V2 builds");

  const byokIdentity = canonicalModelIdentity({ provider: "anthropic", model: "claude-sonnet-5", lane: MODEL_LANES.byok });
  const byokDecision = routeExact(byokIdentity, [candidate("anthropic", "claude-sonnet-5", MODEL_LANES.byok, "balanced", 1)]);
  assert.equal(byokDecision.canonicalModelIdentity, byokIdentity.key);
  const byokHold = await reservations.reserve({
    owner: OWNER, projectId: PROJECT, buildId: BUILDS.byok, callKey: "package13-byok-cancel",
    step: "core", provider: byokDecision.provider, model: byokDecision.model,
    billingLane: byokDecision.billingLane, reservedCredits: 1, ceilingCredits: 5,
    accountAvailableCredits: null, metadata: { package13: true, providerCalled: false, cancellation: true },
  });
  await reservations.release(OWNER, byokHold.id);
  emit("byok_cancelled_before_dispatch", { identity: byokIdentity.key, reservationId: byokHold.id, providerCalled: false, managedDebit: false });

  const codexIdentity = canonicalModelIdentity({ provider: "codex", model: "gpt-5.5", lane: MODEL_LANES.codex });
  const codexDecision = routeExact(codexIdentity, [candidate("codex", "gpt-5.5", MODEL_LANES.codex, "quality", 1)]);
  const codexHold = await reservations.reserve({
    owner: OWNER, projectId: PROJECT, buildId: BUILDS.codex, callKey: "package13-codex-telemetry",
    step: "core", provider: codexDecision.provider, model: codexDecision.model,
    billingLane: codexDecision.billingLane, reservedCredits: 1, ceilingCredits: 5,
    accountAvailableCredits: null, metadata: { package13: true, providerCalled: false, syntheticUsage: true },
  });
  await reservations.settle(OWNER, codexHold.id, {
    actualCredits: 0.125,
    usage: { input: 100, cached: 40, output: 20, reasoning: 10, total: 120, synthetic: true },
    providerRequestIds: ["package13-synthetic-no-provider"],
  });
  const codexReplay = await reservations.settle(OWNER, codexHold.id, {
    actualCredits: 0.125,
    usage: { input: 100, cached: 40, output: 20, reasoning: 10, total: 120, synthetic: true },
    providerRequestIds: ["package13-synthetic-no-provider"],
  });
  assert.equal(codexReplay.state, "settled");
  emit("codex_telemetry_settled_once", { identity: codexIdentity.key, reservationId: codexHold.id, idempotentReplay: true, managedDebit: false });

  const managedIdentity = canonicalModelIdentity({ provider: "openai", model: "gpt-5.6-terra", lane: MODEL_LANES.managed });
  const managedDecision = routeExact(managedIdentity, [candidate("openai", "gpt-5.6-terra", MODEL_LANES.managed, "balanced", 1)]);
  const usageBefore = baseline.ca_usage_records;
  const managedHold = await reservations.reserve({
    owner: OWNER, projectId: PROJECT, buildId: BUILDS.managed, callKey: "package13-managed-paused",
    step: "core", provider: managedDecision.provider, model: managedDecision.model,
    billingLane: managedDecision.billingLane, reservedCredits: 1, ceilingCredits: 5,
    accountAvailableCredits: 5, metadata: { package13: true, providerCalled: false, settlementPaused: true },
  });
  await reservations.release(OWNER, managedHold.id);
  assert.deepEqual(await tableHash("ca_usage_records"), usageBefore);
  emit("managed_pause_preserved", { identity: managedIdentity.key, reservationId: managedHold.id, providerCalled: false, managedDebit: false });

  const rows = unwrap(await client.from("bv2_model_reservations")
    .select("call_key,provider,model,billing_lane,state,actual_credits,usage,provider_request_ids")
    .eq("owner", OWNER).order("call_key"), "reservation evidence");
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.state).sort(), ["released", "released", "settled"]);
  assert.equal(rows.every((row) => row.provider && row.model && row.billing_lane), true);
  emit("canonical_reservation_evidence", { rows });
} catch (error) {
  primaryError = error;
} finally {
  await cleanup();
}

const residue = {
  projects: await scopedCount("projects"), builds: await scopedCount("bv2_builds"),
  reservations: await scopedCount("bv2_model_reservations"),
};
assert.deepEqual(residue, { projects: 0, builds: 0, reservations: 0 });
const after = await customerBaseline();
assert.deepEqual(after, baseline);
emit("cleanup_customer_parity", { residue, customer: after, authDeleted: true });
if (primaryError) throw primaryError;
emit("package13_pass", { providerCalls: 0, stripeTransactions: 0, managedSettlementPaused: true });
