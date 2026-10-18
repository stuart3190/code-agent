-- Reconciliation can transfer the liability of an already-dispatched customer call to Thrallo.
-- Preserve the original transport/pool; this is not admission for managed recovery dispatch.
-- Existing allocation constraints enforce zero customer charges and valid platform allocations.
alter table public.bv2_model_reservations drop constraint bv2_model_reservations_pool_responsibility_check;
alter table public.bv2_model_reservations add constraint bv2_model_reservations_pool_responsibility_check check (
(((recovery_policy_version = 'legacy_v1'::text) AND (((usage_responsibility = 'thrallo_repair'::text) AND (billing_lane = 'managed'::text) AND (funding_pool = 'thrallo_recovery'::text)) OR ((usage_responsibility = 'thrallo_repair'::text) AND (billing_lane <> 'managed'::text) AND (funding_pool = 'customer_generation'::text)) OR ((usage_responsibility <> 'thrallo_repair'::text) AND (funding_pool = 'customer_generation'::text)))) OR ((recovery_policy_version = 'managed_recovery_v1'::text) AND (((funding_pool = 'thrallo_recovery'::text) AND (usage_responsibility = 'thrallo_repair'::text) AND (billing_lane = 'managed'::text)) OR ((funding_pool = 'customer_generation'::text) AND (usage_responsibility <> 'thrallo_repair'::text)))) OR ((recovery_policy_version = 'owner_connected_recovery_v1'::text) AND (((funding_pool = 'thrallo_recovery'::text) AND (usage_responsibility = ANY (ARRAY['thrallo_repair'::text, 'platform_failure'::text, 'qualification'::text])) AND (billing_lane = 'connected_allowance'::text) AND (provider = 'codex'::text)) OR ((funding_pool = 'customer_generation'::text) AND (usage_responsibility = 'customer_request'::text)))))
 OR (recovery_policy_version='owner_connected_recovery_v1'
    and funding_pool='customer_generation' and usage_responsibility='platform_failure'
    and reconciliation_state in ('platform_assumed','provider_settled')
    and included_reserved_credits=0 and purchased_reserved_credits=0
    and coalesce(included_actual_credits,0)=0 and coalesce(purchased_actual_credits,0)=0)
);

CREATE OR REPLACE FUNCTION public.absorb_ambiguous_bv2_model_call(p_owner uuid, p_reservation_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS bv2_model_reservations
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v_row public.bv2_model_reservations;
begin
  perform pg_advisory_xact_lock(hashtextextended('bv2-model:'||p_owner::text,0));
  update public.bv2_model_reservations set
    usage_responsibility=case when funding_pool='customer_generation'
      then 'platform_failure' else usage_responsibility end,
    included_reserved_credits=0,purchased_reserved_credits=0,
    platform_reserved_credits=case when billing_lane='managed' then reserved_credits else 0 end,
    reconciliation_state='platform_assumed',
    reconciliation_reason=left(coalesce(p_reason,'customer hold transferred to platform'),500),
    reconciled_at=now()
    where id=p_reservation_id and owner=p_owner and state='held'
      and reconciliation_state in ('none','pending') returning * into v_row;
  if not found then raise exception 'unresolved Builder V2 reservation not found' using errcode='42501'; end if;
  return v_row;
end $function$;

CREATE OR REPLACE FUNCTION public.release_held_bv2_model_calls(p_owner uuid, p_build_id uuid)
 RETURNS SETOF bv2_model_reservations
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  perform pg_advisory_xact_lock(hashtextextended('bv2-model:'||p_owner::text,0));
  return query update public.bv2_model_reservations set
    state='released',released_at=now(),
    usage_responsibility=case when reconciliation_state='pending' and funding_pool='customer_generation'
      then 'platform_failure' else usage_responsibility end,
    included_reserved_credits=case when reconciliation_state='pending' then 0 else included_reserved_credits end,
    purchased_reserved_credits=case when reconciliation_state='pending' then 0 else purchased_reserved_credits end,
    platform_reserved_credits=case when reconciliation_state='pending' and billing_lane='managed'
      then reserved_credits else platform_reserved_credits end,
    reconciliation_state=case when reconciliation_state in ('pending','platform_assumed') then 'platform_assumed' else 'provider_rejected' end,
    reconciled_at=now()
  where owner=p_owner and build_id=p_build_id and state='held'
  returning *;
end $function$;

CREATE OR REPLACE FUNCTION public.settle_bv2_build_terminal(p_owner uuid, p_build_id uuid, p_terminal_state text, p_failure_classification text, p_green_preview boolean, p_compensation_eligible boolean)
 RETURNS bv2_build_settlements
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
    included_reserved_credits=case when reconciliation_state='pending' then 0 else included_reserved_credits end,
    purchased_reserved_credits=case when reconciliation_state='pending' then 0 else purchased_reserved_credits end,
    platform_reserved_credits=case when reconciliation_state='pending' and billing_lane='managed'
      then reserved_credits else platform_reserved_credits end,
    reconciliation_state=case when reconciliation_state in ('pending','platform_assumed') then 'platform_assumed' else 'provider_rejected' end,
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
end $function$;
