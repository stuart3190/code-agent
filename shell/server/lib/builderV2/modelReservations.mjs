import crypto from "node:crypto";
import { serviceClient } from "../supabase.mjs";
import { FUNDING_POOL } from "./buildEnvelope.mjs";

const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
};
const stable = (value) => JSON.stringify(canonical(value));

// THE DATABASE OWNS THIS NUMBER.
//
// `bv2_builds.max_repair_dispatches` carries a CHECK constraint and `reserve_bv2_model_call_v2`
// enforces the per-build slot count from that column. A caller that computes a larger allowance
// does not get more repairs — it gets a check-constraint violation at BUILD CREATE, which is
// exactly how a budget-derived allowance of 24 stopped every build before it started.
//
// The bound was 10, set when only the essential core had a repair tier and the allowance was the
// constant 2. Every contracted journey now earns that tier, and a 60-credit build proved ten
// insufficient: the core spent all of them going green and five secondary journeys could not be
// repaired even once. 20260820090000_bv2_widen_repair_dispatch_limit.sql widened it to 40, above
// the largest allowance the derivation produces, and the approved credit ceiling remains the real
// limit. `builder-v2-repair-allowance.test.mjs` pins this constant to that migration.
// Emergency runaway guard only. Normal recovery is bounded by the contract-derived strategy
// capacity, no-progress detection and the independent Thrallo recovery credit envelope.
export const MAX_REPAIR_DISPATCHES = 1000;

const RECOVERY_RESPONSIBILITIES = new Set(["thrallo_repair", "platform_failure", "qualification"]);

export function modelCallKey({ buildId, step, sequence, purpose = "dispatch" }) {
  const identity = `${buildId}:${step}:${sequence}:${purpose}`;
  return `${step}:${sequence}:${crypto.createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}

const total = (rows, state, field) => rows.filter((row) => row.state === state)
  .reduce((sum, row) => sum + Number(row[field] || 0), 0);

const responsibilityFor = (input) => input.usageResponsibility || "customer_request";
export const fundingPoolFor = (input) => input.fundingPool
  || (RECOVERY_RESPONSIBILITIES.has(responsibilityFor(input))
    ? FUNDING_POOL.RECOVERY : FUNDING_POOL.CUSTOMER);
const customerFunded = (input) => input.billingLane === "managed"
  && responsibilityFor(input) === "customer_request";

function allocationFor(input, ownerHeld = { included: 0, purchased: 0 }) {
  if (!customerFunded(input)) {
    return {
      includedReservedCredits: 0,
      purchasedReservedCredits: 0,
      platformReservedCredits: input.billingLane === "managed" ? Number(input.reservedCredits) : 0,
    };
  }
  const balance = input.accountBalance || {
    included: input.accountAvailableCredits,
    purchased: 0,
  };
  const includedAvailable = Math.max(0, Number(balance.included ?? balance.bundle ?? 0) - ownerHeld.included);
  const purchasedAvailable = Math.max(0, Number(balance.purchased ?? balance.topup ?? 0) - ownerHeld.purchased);
  const includedReservedCredits = Math.min(Number(input.reservedCredits), includedAvailable);
  const purchasedReservedCredits = Number(input.reservedCredits) - includedReservedCredits;
  if (purchasedReservedCredits > purchasedAvailable + 1e-9) {
    throw Object.assign(new Error("Builder V2 managed account reservation exceeds available credits"), {
      code: "account_budget", requested: input.reservedCredits,
      ownerHeld: ownerHeld.included + ownerHeld.purchased,
      available: includedAvailable + purchasedAvailable,
    });
  }
  return { includedReservedCredits, purchasedReservedCredits, platformReservedCredits: 0 };
}

/**
 * Read-only planning view. The reserve RPC remains the atomic authority; this view lets a caller
 * size its next call to actual remaining build headroom instead of treating a stage target as a
 * second build ceiling.
 */
export function reservationBudget(rows, { owner, buildId, ceilingCredits, fundingPool = null }) {
  const siblings = (rows || []).filter((row) => row.owner === owner
    && (row.buildId || row.build_id) === buildId
    && (!fundingPool || fundingPoolFor({
      fundingPool: row.fundingPool || row.funding_pool,
      usageResponsibility: row.usageResponsibility || row.usage_responsibility,
    }) === fundingPool));
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
    async budget(owner, buildId, ceilingCredits, fundingPool = null) {
      return reservationBudget([...rows.values()], { owner, buildId, ceilingCredits, fundingPool });
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
        if (!same || responsibilityFor(existing) !== responsibilityFor(input)
            || fundingPoolFor(existing) !== fundingPoolFor(input)
            || existing.logicalDispatchId !== input.logicalDispatchId
            || Number(existing.continuationIndex || 0) !== Number(input.continuationIndex || 0)) {
          throw new Error("Builder V2 call key was reused with different reservation identity");
        }
        if (existing.state !== "released") {
          const dispatched = (step) => [...rows.values()].filter((row) => row.owner === input.owner
            && row.buildId === input.buildId && row.step === step
            && ["held", "settled"].includes(row.state)).length;
          return { ...existing, acquired: false, maxRepairs, maxCorrections,
            repairDispatchCount: dispatched("repair"), correctionDispatchCount: dispatched("correction") };
        }
      }
      const fundingPool = fundingPoolFor(input);
      const siblings = [...rows.values()].filter((row) => row.owner === input.owner
        && row.buildId === input.buildId && fundingPoolFor(row) === fundingPool);
      // `repair` = a round briefed by OBSERVED browser failure. `correction` = a deterministic
      // pre-compile fix. They are counted separately: a correction used to consume the one
      // browser-informed repair slot, so a build could reach verification with no repair left.
      const repairDispatchCount = siblings.filter((row) => row.step === "repair"
        && ["held", "settled"].includes(row.state)).length;
      const correctionDispatchCount = siblings.filter((row) => row.step === "correction"
        && ["held", "settled"].includes(row.state)).length;
      // New recovery envelopes are credit/strategy bounded. Keep the historical count guard only
      // for legacy customer-pool callers that have not supplied the recovery funding identity.
      if (input.step === "repair" && fundingPool !== FUNDING_POOL.RECOVERY
          && repairDispatchCount >= maxRepairs) {
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
      const ownerHeld = [...rows.values()]
        .filter((row) => row.owner === input.owner && row.billingLane === "managed" && row.state === "held")
        .reduce((sum, row) => ({
          included: sum.included + Number(row.includedReservedCredits || 0),
          purchased: sum.purchased + Number(row.purchasedReservedCredits || 0),
        }), { included: 0, purchased: 0 });
      const allocation = allocationFor(input, ownerHeld);
      const normalized = { ...input, usageResponsibility: responsibilityFor(input), fundingPool, ...allocation };
      const row = existing || { id: `reservation-${++serial}`, actualCredits: null, ...normalized };
      Object.assign(row, normalized);
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
      const includedActualCredits = row.billingLane === "managed" && row.usageResponsibility === "customer_request"
        ? Math.min(actualCredits, Number(row.includedReservedCredits || 0)) : 0;
      const purchasedActualCredits = row.billingLane === "managed" && row.usageResponsibility === "customer_request"
        ? Math.min(actualCredits - includedActualCredits, Number(row.purchasedReservedCredits || 0)) : 0;
      const platformActualCredits = row.billingLane === "managed"
        ? Math.max(0, actualCredits - includedActualCredits - purchasedActualCredits) : 0;
      Object.assign(row, {
        state: "settled", actualCredits, usage, providerRequestIds,
        includedActualCredits, purchasedActualCredits, platformActualCredits,
        reconciliationState: "provider_settled",
      });
      return row;
    },
    async release(owner, id) {
      const row = [...rows.values()].find((candidate) => candidate.id === id && candidate.owner === owner);
      if (!row) throw new Error("Builder V2 reservation not found");
      if (row.state === "released") return row;
      if (row.state !== "held") throw new Error("settled Builder V2 reservation cannot release");
      row.state = "released";
      row.reconciliationState = "provider_rejected";
      return row;
    },
    async markAmbiguous(owner, id, { reason = null, providerRequestIds = [] } = {}) {
      const row = [...rows.values()].find((candidate) => candidate.id === id && candidate.owner === owner);
      if (!row || row.state !== "held") throw new Error("held Builder V2 reservation not found");
      row.reconciliationState = "pending";
      row.reconciliationReason = reason;
      row.providerRequestIds = providerRequestIds;
      row.ambiguousAt = new Date().toISOString();
      return row;
    },
    async absorbAmbiguous(owner, id, reason = null) {
      const row = [...rows.values()].find((candidate) => candidate.id === id && candidate.owner === owner);
      if (!row || row.state !== "held" || row.reconciliationState !== "pending") {
        throw new Error("pending Builder V2 reservation not found");
      }
      Object.assign(row, {
        usageResponsibility: row.billingLane === "managed" && fundingPoolFor(row) === FUNDING_POOL.CUSTOMER
          ? "platform_failure" : row.usageResponsibility,
        includedReservedCredits: 0,
        purchasedReservedCredits: 0,
        platformReservedCredits: row.billingLane === "managed" ? row.reservedCredits : 0,
        reconciliationState: "platform_assumed",
        reconciliationReason: reason,
      });
      return row;
    },
    async releaseAll(owner, buildId) {
      const released = [];
      for (const row of rows.values()) {
        if (row.owner !== owner || row.buildId !== buildId || row.state !== "held") continue;
        row.state = "released";
        row.releasedAt = new Date().toISOString();
        if (row.reconciliationState === "pending") {
          if (fundingPoolFor(row) === FUNDING_POOL.CUSTOMER) row.usageResponsibility = "platform_failure";
          row.includedReservedCredits = 0;
          row.purchasedReservedCredits = 0;
          row.platformReservedCredits = row.billingLane === "managed" ? row.reservedCredits : 0;
          row.reconciliationState = "platform_assumed";
        } else {
          row.reconciliationState = "provider_rejected";
        }
        released.push({ ...row });
      }
      return released;
    },
    rows: () => [...rows.values()].map((row) => ({ ...row })),
  };
}

export function supabaseModelReservations(client = serviceClient()) {
  const publicCode = (code) => ({
    P14R1: "repair_limit_reached",
    P14S1: "allowance_snapshot_stale",
    P14A1: "account_budget",
    P14C1: "budget_ceiling",
  })[code] || code;
  const unwrap = ({ data, error }, action) => {
    if (error) throw Object.assign(new Error(`${action}: ${error.message}`), {
      code: publicCode(error.code),
      databaseCode: error.code,
    });
    return data;
  };
  return {
    async budget(owner, buildId, ceilingCredits, fundingPool = null) {
      const result = await client.from("bv2_model_reservations")
        .select("owner,build_id,state,reserved_credits,actual_credits,funding_pool,usage_responsibility")
        .eq("owner", owner).eq("build_id", buildId);
      const rows = unwrap(result, "read Builder V2 reservation budget");
      return reservationBudget(rows, { owner, buildId, ceilingCredits, fundingPool });
    },
    async reserve(input) {
      const balance = input.accountBalance || {};
      const result = unwrap(await client.rpc("reserve_bv2_model_call_v4", {
        p_owner: input.owner, p_project_id: input.projectId, p_build_id: input.buildId,
        p_call_key: input.callKey, p_step: input.step, p_provider: input.provider,
        p_model: input.model, p_billing_lane: input.billingLane,
        p_reserved_credits: input.reservedCredits, p_ceiling_credits: input.ceilingCredits,
        p_usage_responsibility: responsibilityFor(input),
        p_funding_pool: fundingPoolFor(input),
        p_included_available_credits: customerFunded(input)
          ? Number(balance.included ?? balance.bundle ?? input.accountAvailableCredits) : null,
        p_usage_period_start: customerFunded(input) ? balance.periodStart : null,
        p_usage_row_count: customerFunded(input) ? Number(balance.usageRowCount) : null,
        p_metadata: input.metadata || {},
      }), "reserve Builder V2 model call");
      const row = result.reservation;
      return {
        ...row, buildId: row.build_id, projectId: row.project_id, callKey: row.call_key,
        billingLane: row.billing_lane, reservedCredits: Number(row.reserved_credits),
        usageResponsibility: row.usage_responsibility,
        fundingPool: row.funding_pool,
        includedReservedCredits: Number(row.included_reserved_credits || 0),
        purchasedReservedCredits: Number(row.purchased_reserved_credits || 0),
        platformReservedCredits: Number(row.platform_reserved_credits || 0),
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
      return unwrap(await client.rpc("settle_bv2_model_call_v2", {
        p_owner: owner, p_reservation_id: id, p_actual_credits: actualCredits,
        p_usage: usage, p_provider_request_ids: providerRequestIds,
      }), "settle Builder V2 model call");
    },
    async release(owner, id) {
      return unwrap(await client.rpc("release_bv2_model_call", {
        p_owner: owner, p_reservation_id: id,
      }), "release Builder V2 model call");
    },
    async markAmbiguous(owner, id, { reason = null, providerRequestIds = [] } = {}) {
      return unwrap(await client.rpc("mark_bv2_model_call_ambiguous", {
        p_owner: owner, p_reservation_id: id, p_reason: reason,
        p_provider_request_ids: providerRequestIds,
      }), "mark Builder V2 model call ambiguous");
    },
    async absorbAmbiguous(owner, id, reason = null) {
      return unwrap(await client.rpc("absorb_ambiguous_bv2_model_call", {
        p_owner: owner, p_reservation_id: id, p_reason: reason,
      }), "transfer ambiguous Builder V2 model call to platform");
    },
    async releaseAll(owner, buildId) {
      return unwrap(await client.rpc("release_held_bv2_model_calls", {
        p_owner: owner, p_build_id: buildId,
      }), "release held Builder V2 model calls");
    },
  };
}
