import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  assertModelDispatchAcquired, conservativeCallReservation, estimatePromptTokens,
  planCallReservation, repairOutputEnvelope,
} from "../../shell/server/lib/builderV2/modelLanes.mjs";
import {
  memoryModelReservations, reservationBudget, supabaseModelReservations,
} from "../../shell/server/lib/builderV2/modelReservations.mjs";
import { creditsForUsage } from "../../src/billing/costModel.mjs";

const options = {
  systemPrompt: "repair only the named defect",
  messages: [{ role: "user", content: "x".repeat(20_000) }],
  tools: [{ type: "function", name: "emit_patches" }],
};
const repairSizing = { retrievedFileCount: 3, retrievalTokens: 5_500, problemCount: 4 };

test("14S repair fits the confirmed 5.901-credit headroom instead of demanding the 6-credit maximum", () => {
  const plan = planCallReservation(options, "gpt-5.5", {
    requestedMaxOutputTokens: 10_000, callCeilingCredits: 6, repairAllowanceCredits: 4,
    repairSizing, budget: { approvedCeilingCredits: 12, consumedCredits: 6.099,
      reservedCredits: 0, remainingCredits: 5.901 },
  });
  assert.equal(plan.effectiveCallCeilingCredits, 5.901);
  assert.ok(plan.reservedCredits <= 5.901);
  assert.ok(plan.maxOutputTokens >= plan.outputEnvelope.minimumUsefulOutputTokens);
});

test("14S small targeted repairs do not reserve the nominal 10k output allowance", () => {
  const envelope = repairOutputEnvelope({ requestedMaxOutputTokens: 10_000,
    retrievedFileCount: 1, retrievalTokens: 2_000, problemCount: 1 });
  assert.ok(envelope.plannedOutputTokens >= envelope.minimumUsefulOutputTokens);
  assert.ok(envelope.plannedOutputTokens < 10_000);
});

test("14S configured call ceiling still caps a repair below larger build headroom", () => {
  const plan = planCallReservation(options, "gpt-5.5", {
    requestedMaxOutputTokens: 10_000, callCeilingCredits: 2.75, repairSizing,
    budget: { approvedCeilingCredits: 12, consumedCredits: 1, reservedCredits: 0, remainingCredits: 11 },
  });
  assert.equal(plan.effectiveCallCeilingCredits, 2.75);
  assert.ok(plan.reservedCredits <= 2.75);
});

test("14S genuinely insufficient headroom rejects before dispatch", () => {
  assert.throws(() => planCallReservation(options, "gpt-5.5", {
    requestedMaxOutputTokens: 10_000, callCeilingCredits: 6, repairSizing,
    budget: { approvedCeilingCredits: 12, consumedCredits: 11.95, reservedCredits: 0, remainingCredits: 0.05 },
  }), (error) => error.code === "budget_ceiling"
    && error.maximumFittingOutputTokens < error.minimumUsefulOutputTokens);
});

test("14S durable authority never permits spend plus holds past the approved build ceiling", async () => {
  const reservations = memoryModelReservations();
  const common = { owner: "owner", projectId: "project", buildId: "build", provider: "codex",
    model: "gpt-5.5", billingLane: "connected_allowance", ceilingCredits: 12,
    accountAvailableCredits: null };
  const core = await reservations.reserve({ ...common, callKey: "core", step: "core", reservedCredits: 6 });
  await reservations.settle("owner", core.id, { actualCredits: 5.5, usage: { input: 30_000, output: 25_000 } });
  await reservations.reserve({ ...common, callKey: "held", step: "repair", reservedCredits: 5 });
  await assert.rejects(reservations.reserve({ ...common, callKey: "overflow", step: "repair",
    reservedCredits: 1.5001 }), (error) => error.code === "budget_ceiling");
});

test("14S cancellation returns every unused repair hold", async () => {
  const reservations = memoryModelReservations();
  const common = { owner: "owner", projectId: "project", buildId: "build", provider: "codex",
    model: "gpt-5.5", billingLane: "connected_allowance", ceilingCredits: 12,
    accountAvailableCredits: null };
  const hold = await reservations.reserve({ ...common, callKey: "repair", step: "repair", reservedCredits: 5.5 });
  assert.equal((await reservations.budget("owner", "build", 12)).remainingCredits, 6.5);
  await reservations.release("owner", hold.id);
  assert.equal((await reservations.budget("owner", "build", 12)).remainingCredits, 12);
});

test("14S planning is conservative while cached and uncached usage reconcile at canonical prices", () => {
  const reserved = conservativeCallReservation(options, "gpt-5.5", { maxOutputTokens: 3_000 });
  const uncached = creditsForUsage({ model: "gpt-5.5",
    usage: { input: 8_000, cached: 0, output: 3_000 } });
  const cached = creditsForUsage({ model: "gpt-5.5",
    usage: { input: 8_000, cached: 6_000, output: 3_000 } });
  assert.ok(reserved >= uncached);
  assert.ok(cached < uncached);
});

test("14S retained 1.991-of-15 reservation state leaves exactly 13.009 credits", () => {
  const rows = [
    { owner: "owner", build_id: "live-build", state: "settled", reserved_credits: 1.1611, actual_credits: 0.4717 },
    { owner: "owner", build_id: "live-build", state: "settled", reserved_credits: 4.3536, actual_credits: 1.5193 },
    { owner: "owner", build_id: "live-build", state: "released", reserved_credits: 4, actual_credits: null },
    { owner: "owner", build_id: "historic-build", state: "held", reserved_credits: 99, actual_credits: null },
  ];
  const budget = reservationBudget(rows, { owner: "owner", buildId: "live-build", ceilingCredits: 15 });
  assert.deepEqual(budget, {
    approvedCeilingCredits: 15, consumedCredits: 1.991, reservedCredits: 0, remainingCredits: 13.009,
  });
});

test("14S live-sized repair prompt fits the real per-call ceiling after token estimation correction", () => {
  const retainedShape = {
    systemPrompt: "Repair only the exact failed booking journeys. Preserve the module plan.",
    messages: [{ role: "user", content: [
      "TARGETS: BookingFlow BookingStatus BookingConfirmation HomePage",
      "const bookingState = selectedDate + selectedSlot + selectedParty + contactDetails;\n".repeat(1_400),
    ].join("\n") }],
    tools: [{ type: "function", name: "emit_patches", parameters: { type: "object" } }],
  };
  const byteCount = Buffer.byteLength(JSON.stringify(retainedShape), "utf8");
  const estimatedInput = estimatePromptTokens(retainedShape);
  assert.ok(byteCount > 60_000, "the former one-byte-per-token hold exceeded the six-credit call ceiling");
  assert.ok(estimatedInput < byteCount * 0.7, "structured code/text is no longer charged as one token per byte");
  const plan = planCallReservation(retainedShape, "gpt-5.5", {
    requestedMaxOutputTokens: 10_000, callCeilingCredits: 6, repairAllowanceCredits: 4,
    repairSizing: { retrievedFileCount: 4, retrievalTokens: 8_997, problemCount: 10 },
    budget: { approvedCeilingCredits: 15, consumedCredits: 1.991,
      reservedCredits: 0, remainingCredits: 13.009 },
  });
  assert.equal(plan.remainingCredits, 13.009);
  assert.equal(plan.effectiveCallCeilingCredits, 6, "the per-call ceiling remains independently strict");
  assert.ok(plan.reservedCredits <= 6);
  assert.ok(plan.maxOutputTokens >= plan.outputEnvelope.minimumUsefulOutputTokens);
  assert.ok(plan.maxOutputTokens < 10_000, "a targeted repair still receives a proportionate envelope");
});

test("14S only genuinely active holds reduce repair headroom", () => {
  const rows = [
    { owner: "owner", buildId: "build", state: "settled", actualCredits: 1.991, reservedCredits: 5.5 },
    { owner: "owner", buildId: "build", state: "released", actualCredits: null, reservedCredits: 4 },
    { owner: "owner", buildId: "build", state: "held", actualCredits: null, reservedCredits: 1.5 },
  ];
  assert.deepEqual(reservationBudget(rows, { owner: "owner", buildId: "build", ceilingCredits: 15 }), {
    approvedCeilingCredits: 15, consumedCredits: 1.991, reservedCredits: 1.5, remainingCredits: 11.509,
  });
});

const dispatchInput = (overrides = {}) => ({
  owner: "owner", projectId: "project", buildId: "build", provider: "codex",
  model: "gpt-5.5", billingLane: "connected_allowance", ceilingCredits: 15,
  accountAvailableCredits: null, reservedCredits: 1, maxRepairs: 1,
  ...overrides,
});

test("14S maxRepairs zero permits no repair provider hold", async () => {
  const reservations = memoryModelReservations();
  await assert.rejects(reservations.reserve(dispatchInput({
    callKey: "repair-1", step: "repair", maxRepairs: 0,
  })), (error) => error.code === "repair_limit_reached"
    && error.repairsDispatched === 0 && error.maxRepairs === 0);
});

test("14S maxRepairs one atomically permits the first repair and rejects the second", async () => {
  const reservations = memoryModelReservations();
  const first = await reservations.reserve(dispatchInput({ callKey: "repair-1", step: "repair" }));
  assert.equal(first.acquired, true);
  assert.equal(first.repairDispatchCount, 1);
  await assert.rejects(reservations.reserve(dispatchInput({
    callKey: "repair-2", step: "repair",
  })), (error) => error.code === "repair_limit_reached");
});

test("14S replay of an acquired repair cannot cross the final provider boundary", async () => {
  const reservations = memoryModelReservations();
  const input = dispatchInput({ callKey: "repair-replay", step: "repair" });
  assertModelDispatchAcquired(await reservations.reserve(input));
  const replay = await reservations.reserve(input);
  assert.equal(replay.acquired, false);
  assert.throws(() => assertModelDispatchAcquired(replay), (error) => error.code === "provider_replay_unsafe");
});

test("14S concurrent repair planners cannot both acquire the last repair slot", async () => {
  const reservations = memoryModelReservations();
  const outcomes = await Promise.allSettled([
    reservations.reserve(dispatchInput({ callKey: "repair-a", step: "repair" })),
    reservations.reserve(dispatchInput({ callKey: "repair-b", step: "repair" })),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected"
    && outcome.reason.code === "repair_limit_reached").length, 1);
});

test("14S released pre-dispatch repair returns the slot while settled usage consumes it", async () => {
  const reservations = memoryModelReservations();
  const first = await reservations.reserve(dispatchInput({ callKey: "repair-first", step: "repair" }));
  await reservations.release("owner", first.id);
  const retry = await reservations.reserve(dispatchInput({ callKey: "repair-retry", step: "repair" }));
  assert.equal(retry.acquired, true, "a proven before-dispatch release is retry-safe");
  await reservations.settle("owner", retry.id, { actualCredits: 0.4, usage: { input: 1, output: 1 } });
  await assert.rejects(reservations.reserve(dispatchInput({
    callKey: "repair-after-settlement", step: "repair",
  })), (error) => error.code === "repair_limit_reached");
});

test("14S contract and core calls never consume the canonical repair allowance", async () => {
  const reservations = memoryModelReservations();
  await reservations.reserve(dispatchInput({ callKey: "contract", step: "contract" }));
  await reservations.reserve(dispatchInput({ callKey: "core", step: "core" }));
  const repair = await reservations.reserve(dispatchInput({ callKey: "repair", step: "repair" }));
  assert.equal(repair.repairDispatchCount, 1);
});

test("14S Supabase reservation adapter uses the atomic customer-accounting dispatch authority", async () => {
  const calls = [];
  const client = { rpc: async (name, args) => {
    calls.push({ name, args });
    return { data: { acquired: true, repair_dispatch_count: 1, max_repairs: 1,
      reservation: { id: "r1", owner: "owner", project_id: "project", build_id: "build",
        call_key: "repair-key", step: "repair", provider: "codex", model: "gpt-5.5",
        billing_lane: "connected_allowance", state: "held", reserved_credits: 1 } }, error: null };
  } };
  const row = await supabaseModelReservations(client).reserve(dispatchInput({
    callKey: "repair-key", step: "repair",
  }));
  assert.equal(calls[0].name, "reserve_bv2_model_call_v4");
  assert.equal(calls[0].args.p_usage_responsibility, "customer_request");
  assert.equal(calls[0].args.p_funding_pool, "customer_generation");
  assert.equal(row.acquired, true);
  assert.equal(row.repairDispatchCount, 1);
  assert.equal(row.maxRepairs, 1);
});

test("14S additive migration pins and atomically enforces the durable repair count", async () => {
  const sql = await readFile(new URL(
    "../../supabase/migrations/20260809155622_bv2_repair_dispatch_limit.sql", import.meta.url,
  ), "utf8");
  assert.match(sql, /add column max_repair_dispatches integer not null default 2/i);
  assert.match(sql, /pg_advisory_xact_lock/i);
  assert.match(sql, /r\.step = 'repair'[\s\S]+r\.state in \('held', 'settled'\)/i);
  assert.match(sql, /errcode = 'P14R1'/i);
  assert.match(sql, /'code', 'repair_limit_reached'/i);
  assert.match(sql, /revoke execute on function public\.reserve_bv2_model_call\([\s\S]+from service_role/i);
  assert.match(sql, /grant execute on function public\.reserve_bv2_model_call_v2/i);

  const accountingSql = await readFile(new URL(
    "../../supabase/migrations/20260813095526_v2_customer_accounting_and_approvals.sql", import.meta.url,
  ), "utf8");
  assert.match(accountingSql, /create or replace function public\.reserve_bv2_model_call_v3/i);
  assert.match(accountingSql, /p_usage_responsibility text/i);
  assert.match(accountingSql, /grant execute on function public\.reserve_bv2_model_call_v3[\s\S]+to service_role/i);
});
