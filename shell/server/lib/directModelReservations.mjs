import crypto from "node:crypto";

import { creditsForUsage } from "../../../src/billing/costModel.mjs";
import { createBudgetLedger } from "./appBuild/budgetLedger.mjs";
import { optionalEnv } from "./env.mjs";
import { classifyProviderFailure, replayUnsafe } from "./providerOutcome.mjs";
import { serviceClient } from "./supabase.mjs";

const roundCredits = (value) => Math.ceil(Math.max(0, Number(value || 0)) * 10_000) / 10_000;

const stableHash = (value) => crypto.createHash("sha256")
  .update(JSON.stringify(value)).digest("hex");

export function directModelCallKey({ kind, subjectId, turn, attemptOrder, provider, model }) {
  return `direct:${kind}:${turn}:${attemptOrder}:${stableHash({
    kind, subjectId, turn, attemptOrder, provider, model,
  }).slice(0, 24)}`;
}

export function normalizedDirectUsage(value = {}) {
  const usage = value.usage || value;
  const input = Number(usage.input ?? usage.inputTokens ?? 0);
  const cached = Number(usage.cached ?? usage.cachedTokens ?? 0);
  const output = Number(usage.output ?? usage.outputTokens ?? 0);
  const reasoning = Number(usage.reasoning ?? usage.reasoningTokens ?? 0);
  return {
    input, cached, output, reasoning,
    total: Number(usage.total ?? usage.totalTokens ?? input + output),
  };
}

export function directProviderRequestIds(value = {}) {
  const usage = value.usage || value;
  return [...new Set([
    ...(Array.isArray(usage.providerRequestIds) ? usage.providerRequestIds : []),
    usage.providerRequestId,
    value.providerRequestId,
    value.id,
  ].filter(Boolean).map(String))].sort();
}

export function estimateDirectReservation({ instructions, input, tools, model, maxOutputTokens }) {
  const inputTokens = Math.ceil(Buffer.byteLength(JSON.stringify({ instructions, input, tools }), "utf8") / 3);
  const outputTokens = Math.max(1, Math.floor(Number(maxOutputTokens || 0)));
  return roundCredits(creditsForUsage({
    usage: { input: inputTokens, cached: 0, output: outputTokens, reasoning: 0, total: inputTokens + outputTokens },
    model,
  }));
}

function normalize(row, acquired = undefined) {
  return {
    ...row,
    callKey: row.call_key ?? row.callKey,
    subjectId: row.subject_id ?? row.subjectId,
    runId: row.run_id ?? row.runId ?? null,
    usageResponsibility: row.usage_responsibility ?? row.usageResponsibility,
    reservedCredits: Number(row.reserved_credits ?? row.reservedCredits ?? 0),
    actualCredits: (row.actual_credits ?? row.actualCredits) == null
      ? null : Number(row.actual_credits ?? row.actualCredits),
    includedReservedCredits: Number(row.included_reserved_credits ?? row.includedReservedCredits ?? 0),
    purchasedReservedCredits: Number(row.purchased_reserved_credits ?? row.purchasedReservedCredits ?? 0),
    platformReservedCredits: Number(row.platform_reserved_credits ?? row.platformReservedCredits ?? 0),
    ...(acquired === undefined ? {} : { acquired }),
  };
}

export function supabaseDirectModelReservations({
  client = serviceClient(),
  balanceResolver = (owner) => createBudgetLedger({ client }).getBalance(owner),
} = {}) {
  const unwrap = ({ data, error }, action) => {
    if (error) throw Object.assign(new Error(`${action}: ${error.message}`), {
      code: ({ P14S1: "allowance_snapshot_stale", P14A1: "account_budget" })[error.code] || error.code,
      databaseCode: error.code,
    });
    return data;
  };
  return {
    async reserve(input) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const customerFunded = (input.usageResponsibility || "customer_request") === "customer_request";
        const balance = customerFunded ? await balanceResolver(input.owner) : {};
        try {
          const result = unwrap(await client.rpc("reserve_ca_direct_model_call", {
            p_owner: input.owner,
            p_run_id: input.runId || null,
            p_kind: input.kind,
            p_subject_id: input.subjectId,
            p_call_key: input.callKey,
            p_provider: input.provider,
            p_model: input.model,
            p_usage_responsibility: input.usageResponsibility || "customer_request",
            p_reserved_credits: input.reservedCredits,
            p_included_available_credits: customerFunded
              ? Number(balance.included ?? balance.bundle ?? 0) : null,
            p_usage_period_start: customerFunded ? balance.periodStart : null,
            p_usage_row_count: customerFunded ? Number(balance.usageRowCount || 0) : null,
            p_metadata: input.metadata || {},
          }), "reserve direct managed model call");
          return normalize(result.reservation, result.acquired === true);
        } catch (error) {
          if (error.code !== "allowance_snapshot_stale" || attempt > 0) throw error;
        }
      }
      throw new Error("Direct managed allowance reservation did not complete");
    },
    async settle(owner, id, input) {
      return normalize(unwrap(await client.rpc("settle_ca_direct_model_call", {
        p_owner: owner,
        p_reservation_id: id,
        p_actual_credits: input.actualCredits,
        p_usage: input.usage || {},
        p_provider_request_ids: input.providerRequestIds || [],
      }), "settle direct managed model call"));
    },
    async release(owner, id) {
      return normalize(unwrap(await client.rpc("release_ca_direct_model_call", {
        p_owner: owner, p_reservation_id: id,
      }), "release direct managed model call"));
    },
    async markAmbiguous(owner, id, { reason = null, providerRequestIds = [] } = {}) {
      return normalize(unwrap(await client.rpc("mark_ca_direct_model_call_ambiguous", {
        p_owner: owner, p_reservation_id: id, p_reason: reason,
        p_provider_request_ids: providerRequestIds,
      }), "mark direct managed model call ambiguous"));
    },
    async absorbAmbiguous(owner, id, reason = null) {
      return normalize(unwrap(await client.rpc("absorb_ambiguous_ca_direct_model_call", {
        p_owner: owner, p_reservation_id: id, p_reason: reason,
      }), "transfer direct managed model call to platform"));
    },
  };
}

export function memoryDirectModelReservations({
  balanceResolver = async () => ({ included: 1_000_000, purchased: 0 }),
  runStore = null,
} = {}) {
  const rows = new Map();
  let serial = 0;
  return {
    async reserve(input) {
      const key = `${input.owner}:${input.callKey}`;
      const existing = rows.get(key);
      if (existing) {
        const same = ["kind", "subjectId", "runId", "provider", "model", "reservedCredits"]
          .every((field) => (existing[field] ?? null) === (input[field] ?? null));
        if (!same || existing.usageResponsibility !== (input.usageResponsibility || "customer_request")) {
          throw new Error("Direct managed call key was reused with different reservation identity");
        }
        if (existing.state !== "released") return { ...existing, acquired: false };
      }
      const usageResponsibility = input.usageResponsibility || "customer_request";
      let includedReservedCredits = 0;
      let purchasedReservedCredits = 0;
      let platformReservedCredits = Number(input.reservedCredits);
      if (usageResponsibility === "customer_request") {
        const balance = await balanceResolver(input.owner);
        const held = [...rows.values()].filter((row) => row.owner === input.owner && row.state === "held")
          .reduce((sum, row) => ({
            included: sum.included + Number(row.includedReservedCredits || 0),
            purchased: sum.purchased + Number(row.purchasedReservedCredits || 0),
          }), { included: 0, purchased: 0 });
        const includedAvailable = Math.max(0, Number(balance.included ?? balance.bundle ?? 0) - held.included);
        const purchasedAvailable = Math.max(0, Number(balance.purchased ?? balance.topup ?? 0) - held.purchased);
        includedReservedCredits = Math.min(Number(input.reservedCredits), includedAvailable);
        purchasedReservedCredits = Number(input.reservedCredits) - includedReservedCredits;
        platformReservedCredits = 0;
        if (purchasedReservedCredits > purchasedAvailable + 1e-9) {
          throw Object.assign(new Error("Direct managed account reservation exceeds availability"), { code: "account_budget" });
        }
      }
      const row = {
        id: existing?.id || `direct-reservation-${++serial}`,
        ...input,
        usageResponsibility,
        state: "held",
        actualCredits: null,
        includedReservedCredits,
        purchasedReservedCredits,
        platformReservedCredits,
      };
      rows.set(key, row);
      return { ...row, acquired: true };
    },
    async settle(owner, id, input) {
      const row = [...rows.values()].find((item) => item.owner === owner && item.id === id);
      if (!row) throw new Error("Direct managed reservation not found");
      if (row.state === "settled") {
        if (row.actualCredits !== input.actualCredits
          || JSON.stringify(row.usage || {}) !== JSON.stringify(input.usage || {})
          || JSON.stringify(row.providerRequestIds || []) !== JSON.stringify(input.providerRequestIds || [])) {
          throw new Error("duplicate direct managed settlement disagrees with canonical telemetry");
        }
        return { ...row };
      }
      if (row.state !== "held") throw new Error("released direct managed reservation cannot settle");
      const duplicate = input.providerRequestIds?.length && [...rows.values()].find((candidate) =>
        candidate.id !== row.id && candidate.state === "settled" && candidate.provider === row.provider
        && candidate.providerRequestIds?.some((requestId) => input.providerRequestIds.includes(requestId)));
      if (duplicate) throw new Error("provider request telemetry is already settled to another reservation");
      const includedActualCredits = row.usageResponsibility === "customer_request"
        ? Math.min(input.actualCredits, row.includedReservedCredits) : 0;
      const purchasedActualCredits = row.usageResponsibility === "customer_request"
        ? Math.min(input.actualCredits - includedActualCredits, row.purchasedReservedCredits) : 0;
      const platformActualCredits = Math.max(0, input.actualCredits - includedActualCredits - purchasedActualCredits);
      Object.assign(row, {
        state: "settled", ...input,
        includedActualCredits, purchasedActualCredits, platformActualCredits,
        reconciliationState: "provider_settled",
      });
      if (runStore && includedActualCredits > 0) {
        const record = {
          provider: row.provider,
          model: row.model,
          input_tokens: input.usage?.input || 0,
          cached_tokens: input.usage?.cached || 0,
          output_tokens: input.usage?.output || 0,
          reasoning_tokens: input.usage?.reasoning || 0,
          compute_seconds: 0,
          amount_gbp: 0,
          billing_source: "managed",
          metadata: {
            kind: row.kind, charge_credits: includedActualCredits,
            actual_credits: input.actualCredits, reservation_id: row.id,
          },
        };
        if (row.runId) await runStore.recordUsage({ owner, id: row.runId }, record);
        else await runStore.recordStandaloneUsage(owner, record);
      }
      return { ...row };
    },
    async release(owner, id) {
      const row = [...rows.values()].find((item) => item.owner === owner && item.id === id);
      if (!row) throw new Error("Direct managed reservation not found");
      if (row.state === "released") return { ...row };
      if (row.state !== "held" || ![undefined, null, "none"].includes(row.reconciliationState)
        || row.providerRequestIds?.length) {
        throw new Error("only an unambiguous held direct managed reservation can release");
      }
      Object.assign(row, { state: "released", reconciliationState: "provider_rejected" });
      return { ...row };
    },
    async markAmbiguous(owner, id, { reason = null, providerRequestIds = [] } = {}) {
      const row = [...rows.values()].find((item) => item.owner === owner && item.id === id);
      if (!row || row.state !== "held") throw new Error("held direct managed reservation not found");
      Object.assign(row, {
        reconciliationState: "pending", reconciliationReason: reason,
        providerRequestIds, ambiguousAt: new Date().toISOString(),
      });
      return { ...row };
    },
    async absorbAmbiguous(owner, id, reason = null) {
      const row = [...rows.values()].find((item) => item.owner === owner && item.id === id);
      if (!row || row.state !== "held" || !["none", "pending"].includes(row.reconciliationState || "none")) {
        throw new Error("unresolved direct managed reservation not found");
      }
      Object.assign(row, {
        usageResponsibility: "platform_failure",
        includedReservedCredits: 0,
        purchasedReservedCredits: 0,
        platformReservedCredits: row.reservedCredits,
        reconciliationState: "platform_assumed",
        reconciliationReason: reason,
      });
      return { ...row };
    },
    rows: () => [...rows.values()].map((row) => ({ ...row })),
  };
}

export function directModelReservations(options = {}) {
  return optionalEnv("CODE_AGENT_STORE", "memory") === "supabase"
    ? supabaseDirectModelReservations(options)
    : memoryDirectModelReservations(options);
}

export function createManagedDirectDispatchAccounting({
  owner,
  kind,
  subjectId,
  runId = null,
  reservations,
  maxOutputTokens,
  usageResponsibility = "customer_request",
  metadata = {},
}) {
  let settledCalls = 0;
  const settleOrRetainAmbiguous = async (hold, candidate, value) => {
    const usage = normalizedDirectUsage(value);
    const providerRequestIds = directProviderRequestIds(value);
    try {
      await reservations.settle(owner, hold.id, {
        actualCredits: roundCredits(creditsForUsage({ usage, model: candidate.model })),
        usage,
        providerRequestIds,
      });
    } catch (error) {
      try {
        await reservations.markAmbiguous(owner, hold.id, {
          reason: `provider completed but settlement failed: ${error?.message || "unknown error"}`,
          providerRequestIds,
        });
      } catch (reconciliationError) {
        error.reconciliationError = reconciliationError;
      }
      throw replayUnsafe(error, {
        reservationId: hold.id,
        providerRequestId: providerRequestIds[0] || null,
      });
    }
    settledCalls += 1;
  };
  return {
    forTurn(turn) {
      return {
        beforeDispatch: async (candidate, { attemptOrder = 1, args = {} } = {}) => {
          const provider = candidate.provider || candidate.id;
          const model = candidate.model;
          const hold = await reservations.reserve({
            owner, runId, kind, subjectId,
            callKey: directModelCallKey({ kind, subjectId, turn, attemptOrder, provider, model }),
            provider, model, usageResponsibility,
            reservedCredits: estimateDirectReservation({
              instructions: args.instructions,
              input: args.input,
              tools: args.tools,
              model,
              maxOutputTokens: args.maxOutputTokens || maxOutputTokens,
            }),
            metadata: { ...metadata, turn, attemptOrder },
          });
          if (hold.acquired === false) {
            throw replayUnsafe(new Error("Direct managed provider dispatch identity was already used"), {
              reservationId: hold.id,
            });
          }
          return hold;
        },
        afterDispatch: async (hold, candidate, response) => {
          await settleOrRetainAmbiguous(hold, candidate, response);
        },
        dispatchFailed: async (hold, candidate, error) => {
          const failure = classifyProviderFailure(error);
          if (failure.hasUsage) {
            await settleOrRetainAmbiguous(hold, candidate, error);
            throw replayUnsafe(error, { reservationId: hold.id, providerRequestId: error?.providerRequestId || null });
          }
          if (["before_dispatch", "provider_rejected"].includes(failure.state)) {
            await reservations.release(owner, hold.id);
            return;
          }
          await reservations.markAmbiguous(owner, hold.id, {
            reason: error?.message || "provider dispatch ambiguous",
            providerRequestIds: directProviderRequestIds(error),
          });
          throw replayUnsafe(error, { reservationId: hold.id, providerRequestId: error?.providerRequestId || null });
        },
      };
    },
    hasSettledCalls: () => settledCalls > 0,
  };
}
