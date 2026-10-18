-- Keep absorbed transport liabilities durable without reserving the build envelope twice.
-- No historical rows or account balances are changed. Existing invoker privileges are retained.

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

CREATE OR REPLACE FUNCTION public.reserve_bv2_model_call_v4(p_owner uuid, p_project_id uuid, p_build_id uuid, p_call_key text, p_step text, p_provider text, p_model text, p_billing_lane text, p_usage_responsibility text, p_funding_pool text, p_reserved_credits numeric, p_ceiling_credits numeric, p_included_available_credits numeric DEFAULT NULL::numeric, p_usage_period_start timestamp with time zone DEFAULT NULL::timestamp with time zone, p_usage_row_count bigint DEFAULT NULL::bigint, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_existing public.bv2_model_reservations; v_row public.bv2_model_reservations;
  v_policy jsonb; v_policy_version text;
  v_spent numeric; v_held numeric; v_repairs integer; v_max_repairs integer;
  v_included_held numeric; v_purchased_held numeric; v_included numeric:=0; v_purchased numeric:=0;
  v_available numeric; v_purchased_available numeric; v_current_usage_rows bigint;
begin
  select value into v_policy from public.bv2_feature_flags
    where key='recovery.funding_policy.owner_connected_v1';
  if v_policy is not null and v_policy->>'state'='active'
      and v_policy->>'policyVersion'='owner_connected_recovery_v1'
      and v_policy->>'executionTransport'='platform_connected_codex'
      and v_policy->>'fundingSource'='thrallo'
      and coalesce(v_policy->>'deploymentCommit','') ~ '^[0-9a-f]{40}$'
      and coalesce(v_policy->>'deploymentManifestSha256','') ~ '^[0-9a-f]{64}$' then
    v_policy_version:='owner_connected_recovery_v1';
  else
    select value into v_policy from public.bv2_feature_flags where key='recovery.funding_policy';
    if v_policy is not null and v_policy->>'state'='active'
        and v_policy->>'policyVersion'='managed_recovery_v1'
        and coalesce(v_policy->>'deploymentCommit','') ~ '^[0-9a-f]{40}$'
        and coalesce(v_policy->>'deploymentManifestSha256','') ~ '^[0-9a-f]{64}$' then
      v_policy_version:='managed_recovery_v1';
    end if;
  end if;
  if v_policy_version is null then
    raise exception 'Builder V2 recovery policy is not activated' using errcode='P14P1';
  end if;

  if p_reserved_credits is null or p_reserved_credits<0 or p_ceiling_credits is null or p_ceiling_credits<=0
    or p_usage_responsibility not in ('customer_request','thrallo_repair','platform_failure','qualification')
    or p_billing_lane not in ('managed','byok_api','connected_allowance')
    or p_funding_pool not in ('customer_generation','thrallo_recovery')
    or (p_funding_pool='customer_generation' and p_usage_responsibility='thrallo_repair')
    or (v_policy_version='owner_connected_recovery_v1' and p_funding_pool='customer_generation'
      and p_usage_responsibility<>'customer_request')
    or (p_funding_pool='thrallo_recovery'
      and p_usage_responsibility not in ('thrallo_repair','platform_failure','qualification'))
    or (v_policy_version='managed_recovery_v1' and p_funding_pool='thrallo_recovery'
      and (p_usage_responsibility<>'thrallo_repair' or p_billing_lane<>'managed'))
    or (v_policy_version='owner_connected_recovery_v1' and p_funding_pool='thrallo_recovery'
      and (p_billing_lane<>'connected_allowance' or p_provider<>'codex')) then
    raise exception 'invalid Builder V2 v4 reservation input' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('bv2-model:'||p_owner::text,0));
  select max_repair_dispatches into v_max_repairs from public.bv2_builds
    where id=p_build_id and owner=p_owner and project_id=p_project_id for update;
  if not found then raise exception 'Builder V2 build is not owned by owner/project' using errcode='42501'; end if;

  select * into v_existing from public.bv2_model_reservations
    where owner=p_owner and build_id=p_build_id and call_key=p_call_key;
  if found then
    if v_existing.project_id<>p_project_id or v_existing.step<>p_step or v_existing.provider<>p_provider
      or v_existing.model<>p_model or v_existing.billing_lane<>p_billing_lane
      or v_existing.usage_responsibility<>p_usage_responsibility or v_existing.funding_pool<>p_funding_pool
      or v_existing.recovery_policy_version<>v_policy_version
      or v_existing.reserved_credits<>p_reserved_credits then
      raise exception 'Builder V2 call key was reused with different reservation identity' using errcode='23505';
    end if;
  end if;
  select count(*)::integer into v_repairs from public.bv2_model_reservations
    where owner=p_owner and build_id=p_build_id and funding_pool='thrallo_recovery'
      and step in ('repair','repair:headroom') and state in ('held','settled');
  if v_existing.id is not null and v_existing.state<>'released' then
    return jsonb_build_object('reservation',to_jsonb(v_existing),'acquired',false,
      'repair_dispatch_count',v_repairs,'max_repairs',v_max_repairs);
  end if;

  select coalesce(sum(actual_credits),0) into v_spent from public.bv2_model_reservations
    where owner=p_owner and build_id=p_build_id and funding_pool=p_funding_pool and state='settled';
  select coalesce(sum(reserved_credits),0) into v_held from public.bv2_model_reservations
    where owner=p_owner and build_id=p_build_id and funding_pool=p_funding_pool and state='held'
      and reconciliation_state<>'platform_assumed';
  if v_spent+v_held+p_reserved_credits>p_ceiling_credits then
    raise exception 'Builder V2 funding-pool ceiling exceeded' using errcode='P14C1';
  end if;

  if p_billing_lane='managed' and p_usage_responsibility='customer_request' then
    if p_included_available_credits is null or p_usage_period_start is null or p_usage_row_count is null
      or p_included_available_credits<0 then
      raise exception 'managed customer calls require a current allowance snapshot' using errcode='22023';
    end if;
    select count(*) into v_current_usage_rows from public.ca_usage_records
      where owner=p_owner and created_at>=p_usage_period_start;
    if v_current_usage_rows<>p_usage_row_count then
      raise exception 'managed allowance snapshot is stale' using errcode='P14S1';
    end if;
    select coalesce(sum(included_reserved_credits),0),coalesce(sum(purchased_reserved_credits),0)
      into v_included_held,v_purchased_held from (
        select included_reserved_credits,purchased_reserved_credits from public.bv2_model_reservations where owner=p_owner and state='held'
        union all select included_reserved_credits,purchased_reserved_credits from public.ca_lead_model_reservations where owner=p_owner and state='held'
        union all select included_reserved_credits,purchased_reserved_credits from public.ca_direct_model_reservations where owner=p_owner and state='held'
      ) holds;
    v_available:=greatest(0,p_included_available_credits-v_included_held);
    v_included:=least(p_reserved_credits,v_available);
    v_purchased:=p_reserved_credits-v_included;
    select greatest(0,coalesce(sum(delta),0)) into v_purchased_available
      from public.credit_ledger where owner=p_owner and bucket='topup';
    if v_purchased>greatest(0,v_purchased_available-v_purchased_held) then
      raise exception 'Builder V2 managed account reservation exceeds availability' using errcode='P14A1';
    end if;
  end if;

  if v_existing.id is not null then
    update public.bv2_model_reservations set state='held',released_at=null,
      usage_responsibility=p_usage_responsibility,funding_pool=p_funding_pool,
      recovery_policy_version=v_policy_version,
      included_reserved_credits=v_included,purchased_reserved_credits=v_purchased,
      platform_reserved_credits=case when p_billing_lane='managed' and p_usage_responsibility<>'customer_request' then p_reserved_credits else 0 end,
      reconciliation_state='none',reconciliation_reason=null,reconciled_at=null,
      logical_dispatch_id=p_metadata->>'logicalDispatchId',
      continuation_index=coalesce((p_metadata->>'continuationIndex')::integer,0),
      causal_files=coalesce(p_metadata->'causalFiles','[]'::jsonb),
      checkpoint_id=nullif(p_metadata->>'checkpointId','')::uuid,
      metadata=coalesce(p_metadata,'{}'::jsonb)||jsonb_build_object('reacquired_at',now())
      where id=v_existing.id returning * into v_row;
  else
    insert into public.bv2_model_reservations(
      owner,project_id,build_id,call_key,step,provider,model,billing_lane,usage_responsibility,funding_pool,
      recovery_policy_version,
      reserved_credits,included_reserved_credits,purchased_reserved_credits,platform_reserved_credits,
      logical_dispatch_id,continuation_index,causal_files,checkpoint_id,metadata
    ) values (
      p_owner,p_project_id,p_build_id,p_call_key,p_step,p_provider,p_model,p_billing_lane,p_usage_responsibility,p_funding_pool,
      v_policy_version,
      p_reserved_credits,v_included,v_purchased,
      case when p_billing_lane='managed' and p_usage_responsibility<>'customer_request' then p_reserved_credits else 0 end,
      p_metadata->>'logicalDispatchId',coalesce((p_metadata->>'continuationIndex')::integer,0),
      coalesce(p_metadata->'causalFiles','[]'::jsonb),nullif(p_metadata->>'checkpointId','')::uuid,
      coalesce(p_metadata,'{}'::jsonb)
    ) returning * into v_row;
  end if;
  if p_step in ('repair','repair:headroom') then v_repairs:=v_repairs+1; end if;
  return jsonb_build_object('reservation',to_jsonb(v_row),'acquired',true,
    'repair_dispatch_count',v_repairs,'max_repairs',v_max_repairs);
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
    -- The platform assumes a pending customer call under the owner-connected policy: the pool
    -- follows the responsibility, or the row cannot satisfy the policy's own check constraint.
    funding_pool=case when reconciliation_state='pending' and funding_pool='customer_generation'
      and recovery_policy_version='owner_connected_recovery_v1'
      then 'thrallo_recovery' else funding_pool end,
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
