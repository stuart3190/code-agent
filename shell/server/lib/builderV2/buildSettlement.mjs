import { FUNDING_POOL } from "./buildEnvelope.mjs";
import { serviceClient } from "../supabase.mjs";

const keyFor = (row) => `${row.fundingPool || row.funding_pool}:${row.usageResponsibility || row.usage_responsibility}:${row.billingLane || row.billing_lane}`;

export function memoryBuildSettlements({ reservations }) {
  const rows = new Map();
  return {
    async settle({ owner, buildId, terminalState, failureClassification = null,
      greenPreview = false, compensationEligible = true }) {
      const key = `${owner}:${buildId}`;
      if (rows.has(key)) {
        const existing = rows.get(key);
        if (existing.terminalState !== terminalState || existing.greenPreview !== greenPreview) {
          throw Object.assign(new Error("terminal settlement identity changed for this build"), {
            code: "terminal_settlement_identity_conflict",
          });
        }
        return existing;
      }
      await reservations.releaseAll?.(owner, buildId);
      const settled = (reservations.rows?.() || []).filter((row) => row.owner === owner
        && row.buildId === buildId && row.state === "settled");
      const spentBreakdown = {};
      for (const row of settled) spentBreakdown[keyFor(row)] = (spentBreakdown[keyFor(row)] || 0)
        + Number(row.actualCredits || 0);
      const customer = settled.filter((row) => (row.fundingPool || FUNDING_POOL.CUSTOMER) === FUNDING_POOL.CUSTOMER
        && (row.usageResponsibility || "customer_request") === "customer_request");
      const managedRefundCredits = !greenPreview && compensationEligible
        ? customer.filter((row) => row.billingLane === "managed").reduce((sum, row) => sum + Number(row.actualCredits || 0), 0) : 0;
      const serviceCreditCredits = !greenPreview && compensationEligible
        ? customer.filter((row) => ["byok_api", "connected_allowance"].includes(row.billingLane))
          .reduce((sum, row) => sum + Number(row.actualCredits || 0), 0) : 0;
      const result = { owner, buildId, terminalState, failureClassification, greenPreview,
        spentBreakdown, managedRefundCredits, serviceCreditCredits, compensationEligible };
      rows.set(key, result); return result;
    },
    rows: () => [...rows.values()].map((row) => ({ ...row })),
  };
}

export function supabaseBuildSettlements(client = serviceClient()) {
  return {
    async settle({ owner, buildId, terminalState, failureClassification = null,
      greenPreview = false, compensationEligible = true }) {
      const { data, error } = await client.rpc("settle_bv2_build_terminal", {
        p_owner: owner, p_build_id: buildId, p_terminal_state: terminalState,
        p_failure_classification: failureClassification, p_green_preview: greenPreview,
        p_compensation_eligible: compensationEligible,
      });
      if (error) throw new Error(`settle Builder V2 terminal accounting: ${error.message}`);
      return Array.isArray(data) ? data[0] : data;
    },
  };
}
