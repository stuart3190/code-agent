import { optionalEnv } from "./env.mjs";
import { serviceClient } from "./supabase.mjs";

const TABLES = Object.freeze([
  { table: "bv2_model_reservations", rpc: "absorb_ambiguous_bv2_model_call" },
  { table: "ca_lead_model_reservations", rpc: "absorb_ambiguous_ca_lead_model_call" },
  { table: "ca_direct_model_reservations", rpc: "absorb_ambiguous_ca_direct_model_call" },
]);

export async function reconcileAmbiguousModelReservations({
  client = serviceClient(),
  now = Date.now(),
  graceMs = Math.max(Number(optionalEnv("MODEL_RESERVATION_RECONCILE_GRACE_MS", "900000")), 60_000),
  orphanGraceMs = Math.max(Number(optionalEnv("MODEL_RESERVATION_ORPHAN_GRACE_MS", "86400000")), 60 * 60_000),
  limit = 100,
} = {}) {
  const cutoff = new Date(now - graceMs).toISOString();
  const orphanCutoff = new Date(now - orphanGraceMs).toISOString();
  const resolved = [];
  for (const definition of TABLES) {
    const queries = [
      { state: "pending", ageColumn: "ambiguous_at", boundary: cutoff },
      // A call that died between durable reserve and outcome classification has no ambiguity
      // timestamp. It is orphaned only after a deliberately much longer safety boundary.
      { state: "none", ageColumn: "created_at", boundary: orphanCutoff },
    ];
    const candidates = new Map();
    for (const query of queries) {
      const { data, error } = await client.from(definition.table)
        .select("id,owner,created_at,ambiguous_at,reconciliation_state")
        .eq("state", "held")
        .eq("reconciliation_state", query.state)
        .lte(query.ageColumn, query.boundary)
        .order(query.ageColumn, { ascending: true })
        .limit(limit);
      if (error) throw new Error(`read ${definition.table} reconciliation queue: ${error.message}`);
      for (const row of data || []) candidates.set(row.id, row);
    }
    for (const row of candidates.values()) {
      const outcome = await client.rpc(definition.rpc, {
        p_owner: row.owner,
        p_reservation_id: row.id,
        p_reason: "provider telemetry remained ambiguous beyond the reconciliation grace period",
      });
      if (outcome.error) {
        // Another shell may have settled/released/transferred it after our read. Re-read failures
        // are harmless; unexpected database failures remain visible to the next timer pass.
        if (!["42501", "PGRST116"].includes(outcome.error.code)) {
          throw new Error(`${definition.rpc}: ${outcome.error.message}`);
        }
        continue;
      }
      resolved.push({ table: definition.table, id: row.id, owner: row.owner });
    }
  }
  return resolved;
}

let timer = null;
export function startModelReservationReconciler() {
  if (timer || optionalEnv("CODE_AGENT_STORE", "memory") !== "supabase") return;
  const interval = Math.max(Number(optionalEnv("MODEL_RESERVATION_RECONCILE_MS", "60000")), 10_000);
  const tick = () => reconcileAmbiguousModelReservations()
    .then((rows) => { if (rows.length) console.warn(`[model-reservations] transferred ${rows.length} ambiguous holds to platform`); })
    .catch((error) => console.error(`[model-reservations] reconciliation failed: ${error.message}`));
  timer = setInterval(tick, interval);
  timer.unref?.();
  tick();
}

export function stopModelReservationReconciler() {
  if (timer) clearInterval(timer);
  timer = null;
}
