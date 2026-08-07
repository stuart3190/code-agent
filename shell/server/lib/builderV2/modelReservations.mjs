import crypto from "node:crypto";
import { serviceClient } from "../supabase.mjs";

const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
};
const stable = (value) => JSON.stringify(canonical(value));

export function modelCallKey({ buildId, step, sequence, purpose = "dispatch" }) {
  const identity = `${buildId}:${step}:${sequence}:${purpose}`;
  return `${step}:${sequence}:${crypto.createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}

export function memoryModelReservations() {
  const rows = new Map();
  let serial = 0;
  return {
    async reserve(input) {
      const key = `${input.owner}:${input.buildId}:${input.callKey}`;
      const existing = rows.get(key);
      if (existing) {
        const same = ["projectId", "step", "provider", "model", "billingLane", "reservedCredits"]
          .every((field) => existing[field] === input[field]);
        if (!same) throw new Error("Builder V2 call key was reused with different reservation identity");
        return existing;
      }
      const siblings = [...rows.values()].filter((row) => row.owner === input.owner && row.buildId === input.buildId);
      const spent = siblings.filter((row) => row.state === "settled").reduce((sum, row) => sum + row.actualCredits, 0);
      const held = siblings.filter((row) => row.state === "held").reduce((sum, row) => sum + row.reservedCredits, 0);
      if (spent + held + input.reservedCredits > input.ceilingCredits) {
        throw Object.assign(new Error("Builder V2 model-call ceiling exceeded"), {
          code: "budget_ceiling", spent, held, requested: input.reservedCredits, ceiling: input.ceilingCredits,
        });
      }
      if (input.billingLane === "managed") {
        const ownerHeld = [...rows.values()]
          .filter((row) => row.owner === input.owner && row.billingLane === "managed" && row.state === "held")
          .reduce((sum, row) => sum + row.reservedCredits, 0);
        if (!(input.accountAvailableCredits >= 0)
            || ownerHeld + input.reservedCredits > input.accountAvailableCredits) {
          throw Object.assign(new Error("Builder V2 managed account reservation exceeds available credits"), {
            code: "account_budget", ownerHeld, requested: input.reservedCredits,
            available: input.accountAvailableCredits,
          });
        }
      }
      const row = { id: `reservation-${++serial}`, state: "held", actualCredits: null, ...input };
      rows.set(key, row);
      return row;
    },
    async settle(owner, id, { actualCredits, usage = {}, providerRequestIds = [] }) {
      const row = [...rows.values()].find((candidate) => candidate.id === id && candidate.owner === owner);
      if (!row) throw new Error("Builder V2 reservation not found");
      if (row.state === "settled") {
        if (row.actualCredits !== actualCredits || stable(row.usage) !== stable(usage)
            || stable(row.providerRequestIds) !== stable(providerRequestIds)) {
          throw new Error("duplicate Builder V2 settlement disagrees with canonical telemetry");
        }
        return row;
      }
      if (row.state !== "held") throw new Error("released Builder V2 reservation cannot settle");
      if (providerRequestIds.length) {
        const duplicate = [...rows.values()].find((candidate) => candidate.id !== row.id
          && candidate.provider === row.provider && candidate.state === "settled"
          && stable(candidate.providerRequestIds) === stable(providerRequestIds));
        if (duplicate) throw new Error("provider request telemetry is already settled to another reservation");
      }
      Object.assign(row, { state: "settled", actualCredits, usage, providerRequestIds });
      return row;
    },
    async release(owner, id) {
      const row = [...rows.values()].find((candidate) => candidate.id === id && candidate.owner === owner);
      if (!row) throw new Error("Builder V2 reservation not found");
      if (row.state === "released") return row;
      if (row.state !== "held") throw new Error("settled Builder V2 reservation cannot release");
      row.state = "released";
      return row;
    },
    rows: () => [...rows.values()].map((row) => ({ ...row })),
  };
}

export function supabaseModelReservations(client = serviceClient()) {
  const unwrap = ({ data, error }, action) => {
    if (error) throw Object.assign(new Error(`${action}: ${error.message}`), { code: error.code });
    return data;
  };
  return {
    async reserve(input) {
      const row = unwrap(await client.rpc("reserve_bv2_model_call", {
        p_owner: input.owner, p_project_id: input.projectId, p_build_id: input.buildId,
        p_call_key: input.callKey, p_step: input.step, p_provider: input.provider,
        p_model: input.model, p_billing_lane: input.billingLane,
        p_reserved_credits: input.reservedCredits, p_ceiling_credits: input.ceilingCredits,
        p_account_available_credits: input.accountAvailableCredits ?? null,
        p_metadata: input.metadata || {},
      }), "reserve Builder V2 model call");
      return {
        ...row, buildId: row.build_id, projectId: row.project_id, callKey: row.call_key,
        billingLane: row.billing_lane, reservedCredits: Number(row.reserved_credits),
        actualCredits: row.actual_credits == null ? null : Number(row.actual_credits),
      };
    },
    async settle(owner, id, { actualCredits, usage = {}, providerRequestIds = [] }) {
      return unwrap(await client.rpc("settle_bv2_model_call", {
        p_owner: owner, p_reservation_id: id, p_actual_credits: actualCredits,
        p_usage: usage, p_provider_request_ids: providerRequestIds,
      }), "settle Builder V2 model call");
    },
    async release(owner, id) {
      return unwrap(await client.rpc("release_bv2_model_call", {
        p_owner: owner, p_reservation_id: id,
      }), "release Builder V2 model call");
    },
  };
}
