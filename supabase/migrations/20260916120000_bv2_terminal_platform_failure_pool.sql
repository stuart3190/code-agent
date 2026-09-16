-- A held customer reservation that a build's terminal settlement reclassifies as a platform
-- failure must also move to the platform's pool under the owner-connected recovery policy.
--
-- 20260823101752 restricted owner_connected_recovery_v1 rows so that usage_responsibility
-- 'platform_failure' is legal only with funding_pool 'thrallo_recovery'. settle_bv2_build_terminal
-- was not changed with it: for a still-held customer row it set usage_responsibility to
-- 'platform_failure' and left funding_pool as 'customer_generation', so the UPDATE violated
-- bv2_model_reservations_pool_responsibility_check. Every build that failed with a held
-- reservation on 2026-09-16 (an expired Codex credential; two mid-stream socket closures) then
-- ended as "Builder V2 failed and terminal accounting could not be completed", the job was
-- marked replay-unsafe, and the hold was left unreconciled. The platform assumes the ambiguous
-- call: the row moves to thrallo_recovery, as the policy requires. legacy_v1 and
-- managed_recovery_v1 rows keep their existing treatment exactly.

create or replace function public.settle_bv2_build_terminal(
  p_owner uuid,p_build_id uuid,p_terminal_state text,p_failure_classification text,
  p_green_preview boolean,p_compensation_eligible boolean
) returns public.bv2_build_settlements language plpgsql security invoker set search_path='' as $$
declare
  v_existing public.bv2_build_settlements; v_row public.bv2_build_settlements;
  v_breakdown jsonb; v_total numeric:=0; v_included numeric:=0; v_purchased numeric:=0;
  v_service numeric:=0;
begin
  perform pg_advisory_xact_lock(hashtextextended('bv2-model:'||p_owner::text,0));
  perform 1 from public.bv2_builds where id=p_build_id and owner=p_owner for update;
  if not found then raise exception 'Builder V2 build not found for terminal settlement' using errcode='42501'; end if;
  select * into v_existing from public.bv2_build_settlements where owner=p_owner and build_id=p_build_id;
  if found then
    if v_existing.terminal_state<>p_terminal_state or v_existing.green_preview<>p_green_preview then
      raise exception 'Builder V2 terminal settlement identity changed' using errcode='23505';
    end if;
    return v_existing;
  end if;

  update public.bv2_model_reservations set state='released',released_at=now(),
    usage_responsibility=case when reconciliation_state='pending' and funding_pool='customer_generation'
      then 'platform_failure' else usage_responsibility end,
    -- The platform assumes a pending customer call under the owner-connected policy: the pool
    -- follows the responsibility, or the row cannot satisfy the policy's own check constraint.
    funding_pool=case when reconciliation_state='pending' and funding_pool='customer_generation'
      and recovery_policy_version='owner_connected_recovery_v1'
      then 'thrallo_recovery' else funding_pool end,
    included_reserved_credits=case when reconciliation_state='pending' then 0 else included_reserved_credits end,
    purchased_reserved_credits=case when reconciliation_state='pending' then 0 else purchased_reserved_credits end,
    platform_reserved_credits=case when reconciliation_state='pending' and billing_lane='managed'
      then reserved_credits else platform_reserved_credits end,
    reconciliation_state=case when reconciliation_state='pending' then 'platform_assumed' else 'provider_rejected' end,
    reconciled_at=now()
  where owner=p_owner and build_id=p_build_id and state='held';

  select coalesce(jsonb_object_agg(key,credits),'{}'::jsonb),coalesce(sum(credits),0)
    into v_breakdown,v_total from (
      select funding_pool||':'||usage_responsibility||':'||billing_lane as key,
        sum(actual_credits)::numeric as credits
      from public.bv2_model_reservations
      where owner=p_owner and build_id=p_build_id and state='settled'
      group by funding_pool,usage_responsibility,billing_lane
    ) totals;

  if not p_green_preview and p_compensation_eligible then
    select coalesce(sum(included_actual_credits),0),coalesce(sum(purchased_actual_credits),0)
      into v_included,v_purchased from public.bv2_model_reservations
      where owner=p_owner and build_id=p_build_id and state='settled'
        and funding_pool='customer_generation' and usage_responsibility='customer_request'
        and billing_lane='managed';
    if v_included>0 then
      insert into public.credit_ledger(owner,delta,bucket,kind,ref)
        values(p_owner,v_included,'bundle','refund','bv2-terminal:'||p_build_id::text)
        on conflict(owner,ref,kind,bucket) do nothing;
    end if;
    if v_purchased>0 then
      insert into public.credit_ledger(owner,delta,bucket,kind,ref)
        values(p_owner,v_purchased,'topup','refund','bv2-terminal:'||p_build_id::text)
        on conflict(owner,ref,kind,bucket) do nothing;
    end if;
    select coalesce(sum(actual_credits),0) into v_service from public.bv2_model_reservations
      where owner=p_owner and build_id=p_build_id and state='settled'
        and funding_pool='customer_generation' and usage_responsibility='customer_request'
        and billing_lane in ('byok_api','connected_allowance')
        and reconciliation_state='provider_settled';
    if v_service>0 then
      insert into public.credit_ledger(owner,delta,bucket,kind,ref)
        values(p_owner,v_service,'bundle','service_credit','bv2-terminal:'||p_build_id::text)
        on conflict(owner,ref,kind,bucket) do nothing;
    end if;
  end if;

  insert into public.bv2_build_settlements(owner,build_id,terminal_state,failure_classification,
    green_preview,spent_breakdown,managed_refund_credits,service_credit_credits,compensation_eligible)
  values(p_owner,p_build_id,p_terminal_state,p_failure_classification,p_green_preview,v_breakdown,
    v_included+v_purchased,v_service,p_compensation_eligible) returning * into v_row;
  update public.bv2_builds set spent_credits=v_total,spent_breakdown=v_breakdown where id=p_build_id and owner=p_owner;
  return v_row;
end $$;
