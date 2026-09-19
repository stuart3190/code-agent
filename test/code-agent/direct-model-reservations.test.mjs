import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createManagedDirectDispatchAccounting,
  directModelCallKey,
  estimateDirectReservation,
  memoryDirectModelReservations,
  supabaseDirectModelReservations,
} from "../../shell/server/lib/directModelReservations.mjs";
import { DISPATCH_STATES, providerFailure } from "../../shell/server/lib/providerOutcome.mjs";

test("direct call identities are deterministic and isolate kind, turn, and provider attempt", () => {
  const base = {
    kind: "completion", subjectId: "request", turn: 1, attemptOrder: 1,
    provider: "openai", model: "gpt-5.6-luna",
  };
  assert.equal(directModelCallKey(base), directModelCallKey(base));
  assert.notEqual(directModelCallKey(base), directModelCallKey({ ...base, turn: 2 }));
  assert.notEqual(directModelCallKey(base), directModelCallKey({ ...base, attemptOrder: 2 }));
  assert.notEqual(directModelCallKey(base), directModelCallKey({ ...base, kind: "model_evaluation" }));
});

test("customer direct calls reserve included then top-up allowance and settle once", async () => {
  const usageRecords = [];
  const store = memoryDirectModelReservations({
    balanceResolver: async () => ({ included: 5, purchased: 3 }),
    runStore: { recordStandaloneUsage: async (...args) => usageRecords.push(args) },
  });
  const input = {
    owner: "owner", kind: "completion", subjectId: "request", runId: null,
    callKey: "direct:completion:12345678", provider: "openai", model: "gpt-5.6-luna",
    usageResponsibility: "customer_request", reservedCredits: 6,
  };
  const hold = await store.reserve(input);
  assert.equal(hold.includedReservedCredits, 5);
  assert.equal(hold.purchasedReservedCredits, 1);
  assert.equal((await store.reserve(input)).acquired, false);
  const settled = await store.settle("owner", hold.id, {
    actualCredits: 4,
    usage: { input: 20, cached: 2, output: 10, reasoning: 1, total: 30 },
    providerRequestIds: ["req_direct_1"],
  });
  assert.equal(settled.includedActualCredits, 4);
  assert.equal(settled.purchasedActualCredits, 0);
  assert.equal(usageRecords.length, 1);
  await store.settle("owner", hold.id, {
    actualCredits: 4,
    usage: { input: 20, cached: 2, output: 10, reasoning: 1, total: 30 },
    providerRequestIds: ["req_direct_1"],
  });
  assert.equal(usageRecords.length, 1, "idempotent settlement cannot write duplicate usage");
});

test("platform-funded direct work neither reads nor charges customer allowance", async () => {
  let balanceReads = 0;
  const usageRecords = [];
  const store = memoryDirectModelReservations({
    balanceResolver: async () => { balanceReads += 1; throw new Error("must not read customer balance"); },
    runStore: { recordStandaloneUsage: async (...args) => usageRecords.push(args) },
  });
  const hold = await store.reserve({
    owner: "owner", kind: "diagnostic_explanation", subjectId: "diag", runId: null,
    callKey: "direct:diagnostic:12345678", provider: "openai", model: "gpt-5.6-luna",
    usageResponsibility: "platform_failure", reservedCredits: 2,
  });
  assert.equal(balanceReads, 0);
  assert.equal(hold.platformReservedCredits, 2);
  const settled = await store.settle("owner", hold.id, {
    actualCredits: 1.25, usage: { input: 10, output: 5, total: 15 }, providerRequestIds: ["req_diag"],
  });
  assert.equal(settled.platformActualCredits, 1.25);
  assert.equal(usageRecords.length, 0);
});

test("dispatch failures release only explicit safe outcomes and retain ambiguous identities", async () => {
  const store = memoryDirectModelReservations();
  const accounting = createManagedDirectDispatchAccounting({
    owner: "owner", kind: "completion", subjectId: "request", reservations: store,
    maxOutputTokens: 200,
  });
  const candidate = { provider: "openai", model: "gpt-5.6-luna" };
  const args = { instructions: "complete", input: [], tools: [], maxOutputTokens: 200 };

  const safeHooks = accounting.forTurn(1);
  const safeHold = await safeHooks.beforeDispatch(candidate, { attemptOrder: 1, args });
  const rejected = providerFailure(new Error("provider rejected before work"), {
    state: DISPATCH_STATES.rejected,
  });
  await safeHooks.dispatchFailed(safeHold, candidate, rejected);
  assert.equal(store.rows().find((row) => row.id === safeHold.id).state, "released");

  const ambiguousHooks = accounting.forTurn(2);
  const ambiguousHold = await ambiguousHooks.beforeDispatch(candidate, { attemptOrder: 1, args });
  const ambiguous = providerFailure(new Error("socket closed"), {
    state: DISPATCH_STATES.ambiguous,
    providerRequestId: "req_ambiguous",
  });
  await assert.rejects(
    ambiguousHooks.dispatchFailed(ambiguousHold, candidate, ambiguous),
    (error) => error.code === "provider_replay_unsafe",
  );
  const pending = store.rows().find((row) => row.id === ambiguousHold.id);
  assert.equal(pending.state, "held");
  assert.equal(pending.reconciliationState, "pending");
  assert.deepEqual(pending.providerRequestIds, ["req_ambiguous"]);
  await assert.rejects(store.release("owner", ambiguousHold.id), /unambiguous held/);
});

test("a completed provider response becomes ambiguous when atomic settlement fails", async () => {
  const base = memoryDirectModelReservations();
  const store = {
    ...base,
    settle: async () => { throw new Error("database unavailable"); },
  };
  const accounting = createManagedDirectDispatchAccounting({
    owner: "owner", kind: "completion", subjectId: "request", reservations: store,
    maxOutputTokens: 200,
  });
  const candidate = { provider: "openai", model: "gpt-5.6-luna" };
  const hooks = accounting.forTurn(1);
  const hold = await hooks.beforeDispatch(candidate, {
    attemptOrder: 1,
    args: { instructions: "complete", input: [], tools: [], maxOutputTokens: 200 },
  });
  await assert.rejects(
    hooks.afterDispatch(hold, candidate, {
      id: "req_completed", usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    }),
    (error) => error.code === "provider_replay_unsafe" && error.reservationId === hold.id,
  );
  const pending = base.rows().find((row) => row.id === hold.id);
  assert.equal(pending.reconciliationState, "pending");
  assert.deepEqual(pending.providerRequestIds, ["req_completed"]);
});

test("Supabase direct reservations use exact RPC arguments and migration is service-only", async () => {
  const calls = [];
  const row = {
    id: "reservation", kind: "completion", subject_id: "request",
    call_key: "direct:completion:12345678", provider: "openai", model: "gpt-5.6-luna",
    usage_responsibility: "customer_request", reserved_credits: 1,
  };
  const store = supabaseDirectModelReservations({
    client: { rpc: async (name, args) => {
      calls.push({ name, args });
      return { data: name === "reserve_ca_direct_model_call" ? { reservation: row, acquired: true } : row, error: null };
    } },
    balanceResolver: async () => ({
      included: 7, purchased: 2, periodStart: "2026-08-01T00:00:00.000Z", usageRowCount: 3,
    }),
  });
  const hold = await store.reserve({
    owner: "owner", runId: null, kind: "completion", subjectId: "request",
    callKey: row.call_key, provider: row.provider, model: row.model,
    usageResponsibility: "customer_request", reservedCredits: 1,
  });
  await store.markAmbiguous("owner", hold.id, { reason: "lost", providerRequestIds: ["req_1"] });
  assert.equal(calls[0].name, "reserve_ca_direct_model_call");
  assert.equal(calls[0].args.p_included_available_credits, 7);
  assert.equal(calls[0].args.p_usage_row_count, 3);
  assert.deepEqual(calls[1].args.p_provider_request_ids, ["req_1"]);

  const sql = await readFile(new URL(
    "../../supabase/migrations/20260813095526_v2_customer_accounting_and_approvals.sql",
    import.meta.url,
  ), "utf8");
  assert.match(sql, /create table public\.ca_direct_model_reservations/i);
  assert.match(sql, /kind in \('completion','coding_agent','model_evaluation','diagnostic_explanation'\)/i);
  assert.match(sql, /create or replace function public\.reserve_ca_direct_model_call/i);
  assert.match(sql, /create or replace function public\.settle_ca_direct_model_call/i);
  assert.match(sql, /ca_model_call_identities[\s\S]*'direct'/i);
  assert.match(sql, /union all[\s\S]*ca_direct_model_reservations/i);
  assert.match(sql, /revoke all on table public\.ca_direct_model_reservations from public,anon,authenticated/i);
  assert.match(sql, /revoke execute on function public\.reserve_ca_direct_model_call[\s\S]*from public,anon,authenticated/i);
  assert.ok(estimateDirectReservation({
    instructions: "x", input: [], tools: [], model: "gpt-5.6-luna", maxOutputTokens: 200,
  }) > 0);
});

test("Supabase platform-funded direct reservations bypass allowance snapshots", async () => {
  const calls = [];
  const row = {
    id: "platform-reservation", kind: "diagnostic_explanation", subject_id: "diag",
    call_key: "direct:diagnostic:12345678", provider: "openai", model: "gpt-5.6-luna",
    usage_responsibility: "platform_failure", reserved_credits: 1,
  };
  const store = supabaseDirectModelReservations({
    client: { rpc: async (name, args) => {
      calls.push({ name, args });
      return { data: { reservation: row, acquired: true }, error: null };
    } },
    balanceResolver: async () => { throw new Error("platform work must not resolve customer allowance"); },
  });
  await store.reserve({
    owner: "owner", runId: null, kind: row.kind, subjectId: row.subject_id,
    callKey: row.call_key, provider: row.provider, model: row.model,
    usageResponsibility: "platform_failure", reservedCredits: 1,
  });
  assert.equal(calls[0].args.p_included_available_credits, null);
  assert.equal(calls[0].args.p_usage_period_start, null);
  assert.equal(calls[0].args.p_usage_row_count, null);
});
