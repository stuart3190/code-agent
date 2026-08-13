import crypto from "node:crypto";
import { serviceClient } from "./supabase.mjs";
import { createBudgetLedger } from "./appBuild/budgetLedger.mjs";
import { creditsForUsage } from "../../../src/billing/costModel.mjs";
import { optionalEnv } from "./env.mjs";

const stableHash = (value) => crypto.createHash("sha256")
  .update(JSON.stringify(value)).digest("hex");

export function leadModelCallKey({ conversationId, requestIdentity = null, turn, recoveryAttempt, provider, model, attemptOrder }) {
  return `lead:${turn}:${attemptOrder}:${stableHash({
    conversationId, requestIdentity, turn, recoveryAttempt, provider, model, attemptOrder,
  }).slice(0, 24)}`;
}

export function estimateLeadReservation({ instructions, input, tools, model, maxOutputTokens }) {
  const inputTokens = Math.ceil(Buffer.byteLength(JSON.stringify({ instructions, input, tools }), "utf8") / 3);
  const outputTokens = Math.max(1, Math.floor(Number(maxOutputTokens || 0)));
  return Math.ceil(creditsForUsage({
    usage: { input: inputTokens, cached: 0, output: outputTokens, reasoning: 0, total: inputTokens + outputTokens },
    model,
  }) * 10_000) / 10_000;
}

function normalize(row, acquired = undefined) {
  return {
    ...row,
    conversationId: row.conversation_id,
    callKey: row.call_key,
    billingLane: row.billing_lane,
    usageResponsibility: row.usage_responsibility,
    reservedCredits: Number(row.reserved_credits || 0),
    actualCredits: row.actual_credits == null ? null : Number(row.actual_credits),
    ...(acquired === undefined ? {} : { acquired }),
  };
}

export function supabaseLeadModelReservations({
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
        const customerManaged = input.billingLane === "managed"
          && (input.usageResponsibility || "customer_request") === "customer_request";
        const balance = customerManaged ? await balanceResolver(input.owner) : null;
        try {
          const result = unwrap(await client.rpc("reserve_ca_lead_model_call", {
            p_owner: input.owner,
            p_conversation_id: input.conversationId,
            p_call_key: input.callKey,
            p_provider: input.provider,
            p_model: input.model,
            p_billing_lane: input.billingLane,
            p_usage_responsibility: input.usageResponsibility || "customer_request",
            p_reserved_credits: input.reservedCredits,
            p_included_available_credits: customerManaged ? Number(balance.included ?? balance.bundle ?? 0) : null,
            p_usage_period_start: customerManaged ? balance.periodStart : null,
            p_usage_row_count: customerManaged ? Number(balance.usageRowCount || 0) : null,
            p_metadata: input.metadata || {},
          }), "reserve Lead Agent model call");
          return normalize(result.reservation, result.acquired === true);
        } catch (error) {
          if (!customerManaged || error.code !== "allowance_snapshot_stale" || attempt > 0) throw error;
        }
      }
      throw new Error("Lead Agent allowance reservation did not complete");
    },
    async settle(owner, id, input) {
      return normalize(unwrap(await client.rpc("settle_ca_lead_model_call", {
        p_owner: owner,
        p_reservation_id: id,
        p_actual_credits: input.actualCredits,
        p_usage: input.usage || {},
        p_provider_request_ids: input.providerRequestIds || [],
      }), "settle Lead Agent model call"));
    },
    async release(owner, id) {
      return normalize(unwrap(await client.rpc("release_ca_lead_model_call", {
        p_owner: owner, p_reservation_id: id,
      }), "release Lead Agent model call"));
    },
    async markAmbiguous(owner, id, { reason = null, providerRequestIds = [] } = {}) {
      return normalize(unwrap(await client.rpc("mark_ca_lead_model_call_ambiguous", {
        p_owner: owner, p_reservation_id: id, p_reason: reason,
        p_provider_request_ids: providerRequestIds,
      }), "mark Lead Agent model call ambiguous"));
    },
    async absorbAmbiguous(owner, id, reason = null) {
      return normalize(unwrap(await client.rpc("absorb_ambiguous_ca_lead_model_call", {
        p_owner: owner, p_reservation_id: id, p_reason: reason,
      }), "transfer Lead Agent model call to platform"));
    },
  };
}

export function memoryLeadModelReservations({
  balanceResolver = async () => ({ included: 1_000_000, purchased: 0 }),
  runStore = null,
} = {}) {
  const rows = new Map();
  let serial = 0;
  return {
    async reserve(input) {
      const key = `${input.owner}:${input.conversationId}:${input.callKey}`;
      const existing = rows.get(key);
      if (existing) {
        const same = ["provider", "model", "billingLane", "usageResponsibility", "reservedCredits"]
          .every((field) => existing[field] === (field === "usageResponsibility"
            ? input[field] || "customer_request" : input[field]));
        if (!same) throw new Error("Lead Agent call key was reused with different reservation identity");
        if (existing.state !== "released") return { ...existing, acquired: false };
      }
      const managed = input.billingLane === "managed";
      const customerFunded = managed
        && (input.usageResponsibility || "customer_request") === "customer_request";
      const balance = customerFunded ? await balanceResolver(input.owner) : { included: 0, purchased: 0 };
      const held = [...rows.values()].filter((row) => row.owner === input.owner && row.state === "held")
        .reduce((sum, row) => ({
          included: sum.included + Number(row.includedReservedCredits || 0),
          purchased: sum.purchased + Number(row.purchasedReservedCredits || 0),
        }), { included: 0, purchased: 0 });
      const includedAvailable = Math.max(0, Number(balance.included ?? balance.bundle ?? 0) - held.included);
      const purchasedAvailable = Math.max(0, Number(balance.purchased ?? balance.topup ?? 0) - held.purchased);
      const includedReservedCredits = customerFunded ? Math.min(input.reservedCredits, includedAvailable) : 0;
      const purchasedReservedCredits = customerFunded ? input.reservedCredits - includedReservedCredits : 0;
      if (purchasedReservedCredits > purchasedAvailable + 1e-9) {
        throw Object.assign(new Error("Lead Agent managed account reservation exceeds availability"), { code: "account_budget" });
      }
      const row = {
        id: existing?.id || `lead-reservation-${++serial}`,
        ...input,
        usageResponsibility: input.usageResponsibility || "customer_request",
        state: "held",
        actualCredits: null,
        includedReservedCredits,
        purchasedReservedCredits,
        platformReservedCredits: managed && !customerFunded ? input.reservedCredits : 0,
      };
      rows.set(key, row);
      return { ...row, acquired: true };
    },
    async settle(owner, id, input) {
      const row = [...rows.values()].find((item) => item.owner === owner && item.id === id);
      if (!row) throw new Error("Lead Agent reservation not found");
      if (row.state === "settled") {
        if (row.actualCredits !== input.actualCredits
            || stableHash(row.usage || {}) !== stableHash(input.usage || {})
            || stableHash(row.providerRequestIds || []) !== stableHash(input.providerRequestIds || [])) {
          throw new Error("duplicate Lead Agent settlement disagrees with canonical telemetry");
        }
        return { ...row };
      }
      if (row.state !== "held") throw new Error("held Lead Agent reservation not found");
      if ((input.providerRequestIds || []).length) {
        const duplicate = [...rows.values()].find((item) => item.id !== id && item.provider === row.provider
          && item.state === "settled"
          && stableHash(item.providerRequestIds || []) === stableHash(input.providerRequestIds));
        if (duplicate) throw new Error("provider request telemetry is already settled to another reservation");
      }
      const includedActualCredits = row.billingLane === "managed" && row.usageResponsibility === "customer_request"
        ? Math.min(input.actualCredits, row.includedReservedCredits) : 0;
      const purchasedActualCredits = row.billingLane === "managed" && row.usageResponsibility === "customer_request"
        ? Math.min(input.actualCredits - includedActualCredits, row.purchasedReservedCredits) : 0;
      const platformActualCredits = row.billingLane === "managed"
        ? Math.max(0, input.actualCredits - includedActualCredits - purchasedActualCredits) : 0;
      Object.assign(row, {
        state: "settled", ...input,
        includedActualCredits, purchasedActualCredits, platformActualCredits,
      });
      if (runStore && row.billingLane === "managed" && row.usageResponsibility === "customer_request") {
        await runStore.recordStandaloneUsage(owner, {
          provider: row.provider,
          model: row.model,
          input_tokens: input.usage?.input || 0,
          cached_tokens: input.usage?.cached || 0,
          output_tokens: input.usage?.output || 0,
          reasoning_tokens: input.usage?.reasoning || 0,
          compute_seconds: 0,
          amount_gbp: 0,
          billing_source: "managed",
          metadata: { kind: "conversation", charge_credits: includedActualCredits, reservation_id: row.id },
        });
      }
      return { ...row };
    },
    async release(owner, id) {
      const row = [...rows.values()].find((item) => item.owner === owner && item.id === id);
      if (!row) throw new Error("Lead Agent reservation not found");
      if (row.state === "released") return { ...row };
      if (row.state !== "held") throw new Error("held Lead Agent reservation not found");
      row.state = "released";
      return { ...row };
    },
    async markAmbiguous(owner, id, { reason = null, providerRequestIds = [] } = {}) {
      const row = [...rows.values()].find((item) => item.owner === owner && item.id === id);
      if (!row || row.state !== "held") throw new Error("held Lead Agent reservation not found");
      Object.assign(row, {
        reconciliationState: "pending", reconciliationReason: reason,
        providerRequestIds, ambiguousAt: new Date().toISOString(),
      });
      return { ...row };
    },
    async absorbAmbiguous(owner, id, reason = null) {
      const row = [...rows.values()].find((item) => item.owner === owner && item.id === id);
      if (!row || row.reconciliationState !== "pending") throw new Error("pending Lead Agent reservation not found");
      Object.assign(row, {
        usageResponsibility: row.billingLane === "managed" ? "platform_failure" : row.usageResponsibility,
        includedReservedCredits: 0,
        purchasedReservedCredits: 0,
        platformReservedCredits: row.billingLane === "managed" ? row.reservedCredits : 0,
        reconciliationState: "platform_assumed", reconciliationReason: reason,
      });
      return { ...row };
    },
    rows: () => [...rows.values()].map((row) => ({ ...row })),
  };
}

export function leadModelReservations(options = {}) {
  return optionalEnv("CODE_AGENT_STORE", "memory") === "supabase"
    ? supabaseLeadModelReservations(options)
    : memoryLeadModelReservations(options);
}
