import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateLeadReservation, leadModelCallKey, memoryLeadModelReservations,
  supabaseLeadModelReservations,
} from "../../shell/server/lib/leadModelReservations.mjs";

test("Lead Agent call keys are deterministic and separate recovery/provider attempts", () => {
  const base = { conversationId: "c1", turn: 2, recoveryAttempt: 0, provider: "openai", model: "gpt", attemptOrder: 1 };
  assert.equal(leadModelCallKey(base), leadModelCallKey(base));
  assert.notEqual(leadModelCallKey(base), leadModelCallKey({ ...base, attemptOrder: 2 }));
  assert.notEqual(leadModelCallKey(base), leadModelCallKey({ ...base, recoveryAttempt: 1 }));
  assert.notEqual(leadModelCallKey({ ...base, requestIdentity: "turn-1" }),
    leadModelCallKey({ ...base, requestIdentity: "turn-2" }));
});

test("Lead Agent reservations hold before dispatch and ambiguous work transfers to platform", async () => {
  const store = memoryLeadModelReservations();
  const input = {
    owner: "owner", conversationId: "conversation", callKey: "lead:call:12345678",
    provider: "openai", model: "gpt", billingLane: "managed",
    usageResponsibility: "customer_request", reservedCredits: 2,
  };
  const hold = await store.reserve(input);
  assert.equal(hold.acquired, true);
  assert.equal((await store.reserve(input)).acquired, false);
  await store.markAmbiguous("owner", hold.id, {
    reason: "network ended after dispatch", providerRequestIds: ["request-ambiguous"],
  });
  const transferred = await store.absorbAmbiguous("owner", hold.id, "grace elapsed");
  assert.equal(transferred.usageResponsibility, "platform_failure");
  assert.equal(transferred.reconciliationState, "platform_assumed");
});

test("platform-funded Lead Agent recovery never depends on or charges customer balance", async () => {
  const recorded = [];
  const store = memoryLeadModelReservations({
    balanceResolver: async () => ({ included: 0, purchased: 0, total: 0 }),
    runStore: { recordStandaloneUsage: async (...args) => recorded.push(args) },
  });
  const hold = await store.reserve({
    owner: "owner", conversationId: "conversation", callKey: "lead:recovery:12345678",
    provider: "openai", model: "gpt", billingLane: "managed",
    usageResponsibility: "platform_failure", reservedCredits: 2,
  });
  assert.equal(hold.platformReservedCredits, 2);
  const settled = await store.settle("owner", hold.id, {
    actualCredits: 1.5, usage: { input: 10, output: 5 }, providerRequestIds: ["request-1"],
  });
  assert.equal(settled.platformActualCredits, 1.5);
  assert.equal(recorded.length, 0);
});

test("Lead Agent reservation estimates include prompt and a bounded output envelope", () => {
  const small = estimateLeadReservation({ instructions: "x", input: [], tools: [], model: "gpt", maxOutputTokens: 100 });
  const large = estimateLeadReservation({ instructions: "x".repeat(10_000), input: [], tools: [], model: "gpt", maxOutputTokens: 1_000 });
  assert.ok(small > 0);
  assert.ok(large > small);
});

test("Supabase Lead reservations send lane and ambiguity identity to exact RPC arguments", async () => {
  const calls = [];
  const row = {
    id: "reservation", conversation_id: "conversation", call_key: "lead:call:12345678",
    billing_lane: "connected_allowance", usage_responsibility: "customer_request", reserved_credits: 0,
  };
  const store = supabaseLeadModelReservations({
    client: { rpc: async (name, args) => {
      calls.push({ name, args });
      return { data: name === "reserve_ca_lead_model_call" ? { reservation: row, acquired: true } : row, error: null };
    } },
    balanceResolver: async () => { throw new Error("non-managed calls must not read customer balance"); },
  });
  const hold = await store.reserve({
    owner: "owner", conversationId: "conversation", callKey: row.call_key,
    provider: "codex", model: "gpt-5", billingLane: "connected_allowance",
    usageResponsibility: "customer_request", reservedCredits: 0,
  });
  await store.markAmbiguous("owner", hold.id, { reason: "lost", providerRequestIds: ["req_123"] });
  assert.equal(calls[0].args.p_billing_lane, "connected_allowance");
  assert.equal(calls[0].args.p_included_available_credits, null);
  assert.deepEqual(calls[1].args.p_provider_request_ids, ["req_123"]);
  assert.equal(calls[1].args.p_reason, "lost");
});

test("V2 accounting migration is service-only, cross-lane atomic, and customer-safe", async () => {
  const { readFile } = await import("node:fs/promises");
  const sql = await readFile(new URL("../../supabase/migrations/20260813095526_v2_customer_accounting_and_approvals.sql", import.meta.url), "utf8");
  assert.match(sql, /create table public\.ca_lead_model_reservations/i);
  assert.match(sql, /create table public\.bv2_build_budget_approvals/i);
  assert.match(sql, /pg_advisory_xact_lock\(hashtextextended\('bv2-model:'/i);
  assert.match(sql, /union all[\s\S]*ca_lead_model_reservations/i);
  assert.match(sql, /v_platform:=greatest\(0,p_actual_credits-v_included-v_purchased\)/i);
  assert.match(sql, /usage_responsibility=case when billing_lane='managed' then 'platform_failure'[\s\S]*included_reserved_credits=0/i);
  assert.match(sql, /revoke all on table public\.ca_lead_model_reservations from public,anon,authenticated/i);
  assert.match(sql, /revoke all on table public\.bv2_build_budget_approvals from public,anon,authenticated/i);
});
