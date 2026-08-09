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

const total = (rows, state, field) => rows.filter((row) => row.state === state)
  .reduce((sum, row) => sum + Number(row[field] || 0), 0);

/**
 * Read-only planning view. The reserve RPC remains the atomic authority; this view lets a caller
 * size its next call to actual remaining build headroom instead of treating a stage target as a
 * second build ceiling.
 */
export function reservationBudget(rows, { owner, buildId, ceilingCredits }) {
  const siblings = (rows || []).filter((row) => row.owner === owner
    && (row.buildId || row.build_id) === buildId);
  const consumedCredits = total(siblings, "settled", "actualCredits")
    + total(siblings.filter((row) => row.actualCredits == null), "settled", "actual_credits");
  const reservedCredits = total(siblings, "held", "reservedCredits")
    + total(siblings.filter((row) => row.reservedCredits == null), "held", "reserved_credits");
  const approvedCeilingCredits = Number(ceilingCredits);
  return {
    approvedCeilingCredits,
    consumedCredits,
    reservedCredits,
    remainingCredits: Math.max(0, approvedCeilingCredits - consumedCredits - reservedCredits),
  };
}

export function memoryModelReservations() {
  const rows = new Map();
  const repairLimits = new Map();
  const correctionLimits = new Map();
  let serial = 0;
  return {
    async budget(owner, buildId, ceilingCredits) {
      return reservationBudget([...rows.values()], { owner, buildId, ceilingCredits });
    },
    async reserve(input) {
      const key = `${input.owner}:${input.buildId}:${input.callKey}`;
      const buildKey = `${input.owner}:${input.buildId}`;
      const requestedLimit = Number.isInteger(input.maxRepairs) ? input.maxRepairs : 2;
      if (!repairLimits.has(buildKey)) repairLimits.set(buildKey, requestedLimit);
      const maxRepairs = repairLimits.get(buildKey);
      if (maxRepairs !== requestedLimit) {
        throw Object.assign(new Error("Builder V2 repair limit changed after build creation"), {
          code: "repair_limit_identity_conflict", maxRepairs, requestedLimit,
        });
      }
      const requestedCorrections = Number.isInteger(input.maxCorrections) ? input.maxCorrections : 2;
      if (!correctionLimits.has(buildKey)) correctionLimits.set(buildKey, requestedCorrections);
      const maxCorrections = correctionLimits.get(buildKey);
      if (maxCorrections !== requestedCorrections) {
        throw Object.assign(new Error("Builder V2 correction limit changed after build creation"), {
          code: "correction_limit_identity_conflict", maxCorrections, requestedCorrections,
        });
      }
      const existing = rows.get(key);
      if (existing) {
        const same = ["projectId", "step", "provider", "model", "billingLane", "reservedCredits"]
          .every((field) => existing[field] === input[field]);
        if (!same) throw new Error("Builder V2 call key was reused with different reservation identity");
        if (existing.state !== "released") {
          const dispatched = (step) => [...rows.values()].filter((row) => row.owner === input.owner
            && row.buildId === input.buildId && row.step === step
            && ["held", "settled"].includes(row.state)).length;
          return { ...existing, acquired: false, maxRepairs, maxCorrections,
            repairDispatchCount: dispatched("repair"), correctionDispatchCount: dispatched("correction") };
        }
      }
      const siblings = [...rows.values()].filter((row) => row.owner === input.owner && row.buildId === input.buildId);
      // `repair` = a round briefed by OBSERVED browser failure. `correction` = a deterministic
      // pre-compile fix. They are counted separately: a correction used to consume the one
      // browser-informed repair slot, so a build could reach verification with no repair left.
      const repairDispatchCount = siblings.filter((row) => row.step === "repair"
        && ["held", "settled"].includes(row.state)).length;
      const correctionDispatchCount = siblings.filter((row) => row.step === "correction"
        && ["held", "settled"].includes(row.state)).length;
      if (input.step === "repair" && repairDispatchCount >= maxRepairs) {
        throw Object.assign(new Error("Builder V2 repair provider-call limit reached"), {
          code: "repair_limit_reached", repairsDispatched: repairDispatchCount, maxRepairs,
        });
      }
      if (input.step === "correction" && correctionDispatchCount >= maxCorrections) {
        throw Object.assign(new Error("Builder V2 pre-compile correction limit reached"), {
          code: "correction_limit_reached", correctionsDispatched: correctionDispatchCount, maxCorrections,
        });
      }
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
      const row = existing || { id: `reservation-${++serial}`, actualCredits: null, ...input };
      Object.assign(row, { state: "held", releasedAt: null });
      rows.set(key, row);
      return { ...row, acquired: true,
        repairDispatchCount: repairDispatchCount + (input.step === "repair" ? 1 : 0), maxRepairs,
        correctionDispatchCount: correctionDispatchCount + (input.step === "correction" ? 1 : 0), maxCorrections };
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
    if (error) throw Object.assign(new Error(`${action}: ${error.message}`), {
      code: error.code === "P14R1" ? "repair_limit_reached" : error.code,
      databaseCode: error.code,
    });
    return data;
  };
  return {
    async budget(owner, buildId, ceilingCredits) {
      const result = await client.from("bv2_model_reservations")
        .select("owner,build_id,state,reserved_credits,actual_credits")
        .eq("owner", owner).eq("build_id", buildId);
      const rows = unwrap(result, "read Builder V2 reservation budget");
      return reservationBudget(rows, { owner, buildId, ceilingCredits });
    },
    async reserve(input) {
      const result = unwrap(await client.rpc("reserve_bv2_model_call_v2", {
        p_owner: input.owner, p_project_id: input.projectId, p_build_id: input.buildId,
        p_call_key: input.callKey, p_step: input.step, p_provider: input.provider,
        p_model: input.model, p_billing_lane: input.billingLane,
        p_reserved_credits: input.reservedCredits, p_ceiling_credits: input.ceilingCredits,
        p_account_available_credits: input.accountAvailableCredits ?? null,
        p_metadata: input.metadata || {},
      }), "reserve Builder V2 model call");
      const row = result.reservation;
      return {
        ...row, buildId: row.build_id, projectId: row.project_id, callKey: row.call_key,
        billingLane: row.billing_lane, reservedCredits: Number(row.reserved_credits),
        actualCredits: row.actual_credits == null ? null : Number(row.actual_credits),
        acquired: result.acquired === true,
        repairDispatchCount: Number(result.repair_dispatch_count || 0),
        maxRepairs: Number(result.max_repairs),
        // Corrections dispatch under step "correction", so the durable repair counter no longer
        // sees them at all — that IS the separation. The correction cap itself is enforced by
        // the orchestrator; giving it its own database counter needs a migration and is
        // deliberately not bundled with this change.
        correctionDispatchCount: Number(result.correction_dispatch_count || 0),
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
