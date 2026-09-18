// THE CONTRACT STAGE IS FUNDED AS ONE WORKFLOW, NOT AS SEPARATE CALLS.
//
// The contract stage is: one customer-funded generation call; if that reply is rejected before it
// can be judged (not JSON, or the validator/normaliser rejects it), one Thrallo-funded PROTOCOL
// CORRECTION - a second full contract turn; then the derived-spec gate; and if the gate rejects
// the contract, one Thrallo-funded GATE REPAIR. The protocol correction and the gate repair share
// the pre-envelope Thrallo recovery pool, because no envelope can be priced before a contract
// exists.
//
// Recessed-light rerun 7e74b401 (2026-09-18, medium): attempt 1 was rejected by normalisation
// (1.60 customer credits), the protocol correction produced a contract that reached the gate
// (2.43 recovery credits of a 3.5-credit preliminary pool), the gate rejected it, and the repair
// found 1.07 credits - less than its 11.5k-token input alone. The build blocked before generation
// with a contract that, after the resolver fix in c341be5, was one repair away from valid. The
// pool had funded the correction with the money the repair needed.
//
// Policy (shared layer, existing reservation architecture):
//   1. A protocol correction is planned against the recovery pool MINUS a gate-repair reserve:
//      the reservation the planner would need to admit a gate repair on the same wire (the repair
//      prompt carries the same request, prior contract and rejection details as the correction),
//      with an output allowance sized from real gate-repair usage. runReservedDispatch enforces it
//      as `completionReserveCredits`, exactly as the customer pool protects mandatory increments.
//   2. The pre-envelope recovery ceiling is raised to what that workflow needs (correction
//      reservation + repair reserve) when the preliminary figure is short, capped at
//      CONTRACT_WORKFLOW_CEILING_MULTIPLIER x the preliminary figure so a runaway prompt cannot
//      open an unbounded platform allowance. The gate repair sees the same raised ceiling.
//   3. A correction that cannot fit beside the reserve even at the cap is refused BEFORE
//      dispatch with a typed code; nothing is spent on a call whose follow-up could not be funded.
//
// Gate-repair output allowance, from the ledger (settled contract-step calls, 30 days to
// 2026-09-18, 87 gate repairs): p50 1,694 output tokens, p90 3,782, maximum 4,798. 5,000 covers
// every observed repair. Contract output plan (runtimeComposition.stepOutputPolicy): 224 first
// calls p50 4,524, p90 8,095, maximum 12,010; 110 protocol corrections maximum 12,360 - the
// 6,000-token plan those calls reserved against understated the correction that emptied the pool.

export const CONTRACT_WORKFLOW_PHASE = Object.freeze({
  PROTOCOL_CORRECTION: "contract_protocol_correction",
  GATE_REPAIR: "contract_gate_repair",
});

export const CONTRACT_GATE_REPAIR_OUTPUT_TOKENS = 5_000;
export const CONTRACT_WORKFLOW_CEILING_MULTIPLIER = 2;

const r4 = (value) => Math.round(Number(value || 0) * 10_000) / 10_000;

/**
 * The recovery-pool authority for a pre-envelope dispatch. Bare preliminary capacity for any
 * dispatch outside the contract workflow; for the contract workflow, a ceiling that can fund the
 * correction AND the repair (bounded), and - for the correction only - the repair reserve the
 * planner must leave untouched.
 */
export function contractWorkflowRecoveryAuthority({ preliminaryRecoveryCredits, context = {} } = {}) {
  const preliminary = Math.max(0, Number(preliminaryRecoveryCredits || 0));
  const phase = context?.workflowPhase || null;
  if (![CONTRACT_WORKFLOW_PHASE.PROTOCOL_CORRECTION, CONTRACT_WORKFLOW_PHASE.GATE_REPAIR].includes(phase)) {
    return { ceilingCredits: preliminary, completionReserveCredits: 0, workflowPhase: null };
  }
  const workflowCredits = Math.max(0, Number(context?.contractWorkflowCredits || 0));
  const cap = r4(preliminary * CONTRACT_WORKFLOW_CEILING_MULTIPLIER);
  const ceilingCredits = r4(Math.min(cap, Math.max(preliminary, workflowCredits)));
  const completionReserveCredits = phase === CONTRACT_WORKFLOW_PHASE.PROTOCOL_CORRECTION
    ? r4(Math.max(0, Number(context?.gateRepairReserveCredits || 0))) : 0;
  return {
    ceilingCredits, completionReserveCredits, workflowPhase: phase,
    preliminaryRecoveryCredits: preliminary, workflowCredits: r4(workflowCredits), capCredits: cap,
  };
}
