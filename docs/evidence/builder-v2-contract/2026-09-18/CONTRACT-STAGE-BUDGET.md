# Contract-stage budget policy (recessed-light rerun 7e74b401, 2026-09-18)

## The live sequence, as accounted (bv2_model_reservations)

| call | logical dispatch | pool | pool ceiling | reserved | planned output | actual | outcome |
|---|---|---|---|---|---|---|---|
| 1 | contract:1 | customer_generation | 30 | 1.1451 | 6,000 | 1.6006 (3,996 in / 12,010 out) | rejected by the validator (undeclared operated field) |
| 2 | contract_protocol_correction:1 | thrallo_recovery | 3.5 | 2.1295 | 6,000 | 2.4277 (11,917 in / 12,360 out) | reached the gate; gate rejected it |
| 3 | gate repair | thrallo_recovery | 3.5 | - | - | - | refused before dispatch: 1.07 remaining, 11,552-token input alone exceeds it |

Total contract-stage allocation: no stage-specific allocation exists. Attempt 1 is customer-funded
(30-credit build approval). The protocol correction and the gate repair are both Thrallo-funded
from the PRE-ENVELOPE recovery pool, `preliminaryRecoveryCredits = max(3, 1.5 + band)`: 3.0
simple, 3.5 medium, 5.5 advanced. No envelope exists before a contract, so no `contract_protocol_correction`
strategy allowance (0.75 + 0.08/journey) applies yet. The recovery pool carried no completion
reserve: the correction was admitted against the whole pool.

Why the second full call was admitted while leaving 1.07: planning saw 3.5 remaining, a 4.5 per-call
ceiling and a 6,000-token output plan, reserved 2.13, and nothing protected the repair. The
correction then produced 12,360 output tokens (2.43 actual), more than its plan.

## Ledger evidence used for sizing (settled contract-step calls, 30 days to 2026-09-18)

| kind | calls | p50 out | p90 out | max out | p90 in | max in | max actual |
|---|---|---|---|---|---|---|---|
| first call | 224 | 4,524 | 8,095 | 12,010 | 2,441 | 3,996 | 1.601 |
| protocol correction | 110 | 3,141 | 5,730 | 12,360 | 7,232 | 11,917 | 2.428 |
| gate repair | 87 | 1,694 | 3,782 | 4,798 | 7,289 | 8,975 | 1.222 |

## Policy (contractStageBudget.mjs, modelLanes.mjs, runtimeComposition.mjs)

1. Before a protocol correction is dispatched, the lane prices the workflow on the correction's own
   wire with the production planner: `correctionCredits` (input estimate + the contract output
   plan) and `gateRepairReserveCredits` (same input + 5,000 output tokens, above every observed
   gate repair). The correction is planned against the recovery pool minus the reserve
   (`completionReserveCredits`, the same mechanism that protects mandatory increments in the
   customer pool) and must run with its full output plan or not at all.
2. The pre-envelope recovery ceiling becomes `min(2 x preliminary, max(preliminary, correction + reserve))`.
   The gate repair is planned under a ceiling at least as high as the correction's admission.
3. A correction that cannot fit beside the reserve even at the cap is refused before dispatch with
   code `recovery_completion_reserve`; nothing is spent.
4. The contract output plan is 12,000 tokens (max observed 12,360 over 334 calls), so reservations
   are upper bounds again.

## The live sequence under the policy (offline, scripted replies with live usage)

| | figure |
|---|---|
| attempt 1 | customer, reserved 1.7453, actual 1.6006 - runs unchanged |
| workflow price on the correction wire | 15,244 input tokens; correction 2.7244; repair reserve 2.0244; total 4.7488 |
| recovery ceiling for the workflow | raised 3.5 -> 4.7488 (cap 7) |
| protected for the gate repair | 2.0244 |
| correction | admitted, reserved 2.7244 with the full 12,000 output plan, actual 2.4277 |
| recovery remaining after the correction | 2.3211 (>= the 2.0244 reserve) |
| gate repair | affordable; largest observed repair (1.3773) fits |
| customer spend | 1.6006, unchanged |
| Thrallo recovery spend | 2.4277, unchanged (the repair was not needed: under c341be5 the corrected contract passes the gate) |
| build | continues to core generation |

Under the old preliminary pool alone (3.5) the correction would have been refused before dispatch
by the same policy, saving 2.43 Thrallo credits but blocking the build after attempt 1. The bounded
raise is what preserves completion probability.
