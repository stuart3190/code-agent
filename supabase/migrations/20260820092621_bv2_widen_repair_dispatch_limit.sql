-- Widen the per-build repair-dispatch ceiling so the allowance can follow the approved budget.
--
-- WHY. `max_repair_dispatches` was capped at 10 when a repair tier existed only for the essential
-- core and the allowance was the constant 2. Every contracted journey now earns the same tier, and
-- the count is derived from the credits the customer actually approved. On 2026-08-20 a 60-credit
-- build spent all ten dispatches taking the core green and then had nothing left: five secondary
-- journeys — a dead viewMode control, a missing create-account entry, three absent export formats —
-- each failed once and could not be repaired at all. The build stopped at 36.35 of 60 credits.
--
-- Sixty credits buys roughly thirty dispatches at observed prices, so ten is an accounting limit
-- that no longer matches the money. Forty leaves headroom above the largest allowance the code will
-- derive (`floor(ceiling / 2.5)`, itself clamped to MAX_REPAIR_DISPATCHES).
--
-- SAFETY. This only widens an existing CHECK: it accepts strictly more values than before, rewrites
-- no rows, and changes no data. `reserve_bv2_model_call_v2` keeps enforcing the per-build slot count
-- from the same column, and the approved credit ceiling remains the real limit — it fails closed
-- whatever this constraint permits. Reversal is re-narrowing the bound.

alter table public.bv2_builds
  drop constraint if exists bv2_builds_max_repair_dispatches_check;

alter table public.bv2_builds
  add constraint bv2_builds_max_repair_dispatches_check
    check (max_repair_dispatches between 0 and 40);

comment on column public.bv2_builds.max_repair_dispatches is
  'Build-level provider repair-call limit, derived from the approved credit ceiling and clamped to '
  'MAX_REPAIR_DISPATCHES in shell/server/lib/builderV2/modelReservations.mjs. Enforced atomically by '
  'reserve_bv2_model_call_v2; builder-v2-repair-allowance.test.mjs pins the constant to this CHECK.';
