-- Builder V2 recovery remains Thrallo-funded but executes through the private platform owner's
-- connected Codex allowance. Preserve legacy_v1 and managed_recovery_v1 rows exactly as historical
-- provider/accounting evidence; only reservations created after explicit deployment activation use
-- owner_connected_recovery_v1. Applying this migration alone does not activate the new transport.

alter table public.bv2_model_reservations
  drop constraint bv2_model_reservations_recovery_policy_version_check;
alter table public.bv2_model_reservations
  add constraint bv2_model_reservations_recovery_policy_version_check check (
    recovery_policy_version in ('legacy_v1','managed_recovery_v1','owner_connected_recovery_v1')
  );

alter table public.bv2_model_reservations
  drop constraint bv2_model_reservations_pool_responsibility_check;
alter table public.bv2_model_reservations
  add constraint bv2_model_reservations_pool_responsibility_check check (
    (recovery_policy_version='legacy_v1' and (
      (usage_responsibility='thrallo_repair' and billing_lane='managed' and funding_pool='thrallo_recovery')
      or (usage_responsibility='thrallo_repair' and billing_lane<>'managed' and funding_pool='customer_generation')
      or (usage_responsibility<>'thrallo_repair' and funding_pool='customer_generation')
    ))
    or (recovery_policy_version='managed_recovery_v1' and (
      (funding_pool='thrallo_recovery' and usage_responsibility='thrallo_repair' and billing_lane='managed')
      or (funding_pool='customer_generation' and usage_responsibility<>'thrallo_repair')
    ))
    or (recovery_policy_version='owner_connected_recovery_v1' and (
      (funding_pool='thrallo_recovery'
        and usage_responsibility in ('thrallo_repair','platform_failure','qualification')
        and billing_lane='connected_allowance' and provider='codex')
      or (funding_pool='customer_generation' and usage_responsibility='customer_request')
    ))
  );

create or replace function public.activate_bv2_owner_connected_recovery_policy(
  p_deployment_commit text,
  p_deployment_manifest_sha256 text,
  p_actor text
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  v_existing public.bv2_feature_flags;
  v_value jsonb;
begin
  if coalesce(p_deployment_commit,'') !~ '^[0-9a-f]{40}$'
    or coalesce(p_deployment_manifest_sha256,'') !~ '^[0-9a-f]{64}$'
    or length(trim(coalesce(p_actor,''))) not between 1 and 200 then
    raise exception 'invalid Builder V2 connected recovery policy activation identity' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('bv2-recovery-policy-activation',0));
  select * into v_existing from public.bv2_feature_flags
    where key='recovery.funding_policy.owner_connected_v1' for update;
  if found then
    if coalesce(v_existing.value->>'state','')<>'active'
      or coalesce(v_existing.value->>'policyVersion','')<>'owner_connected_recovery_v1'
      or coalesce(v_existing.value->>'deploymentCommit','')<>p_deployment_commit
      or coalesce(v_existing.value->>'deploymentManifestSha256','')<>p_deployment_manifest_sha256 then
      raise exception 'Builder V2 connected recovery policy activation identity changed' using errcode='23505';
    end if;
    return v_existing.value || jsonb_build_object('updatedBy',v_existing.updated_by);
  end if;
  v_value:=jsonb_build_object(
    'state','active',
    'policyVersion','owner_connected_recovery_v1',
    'executionTransport','platform_connected_codex',
    'fundingSource','thrallo',
    'deploymentCommit',p_deployment_commit,
    'deploymentManifestSha256',p_deployment_manifest_sha256,
    'activatedAt',clock_timestamp()
  );
  insert into public.bv2_feature_flags(key,value,updated_at,updated_by)
    values('recovery.funding_policy.owner_connected_v1',v_value,now(),trim(p_actor));
  return v_value || jsonb_build_object('updatedBy',trim(p_actor));
end $$;

create or replace function public.enforce_bv2_recovery_policy_activation()
returns trigger language plpgsql security invoker set search_path='' as $$
declare
  v_managed_active boolean;
  v_connected_active boolean;
  v_starts_dispatch boolean;
begin
  select exists(
    select 1 from public.bv2_feature_flags f
    where f.key='recovery.funding_policy'
      and f.value->>'state'='active'
      and f.value->>'policyVersion'='managed_recovery_v1'
      and f.value->>'deploymentCommit' ~ '^[0-9a-f]{40}$'
      and f.value->>'deploymentManifestSha256' ~ '^[0-9a-f]{64}$'
  ) into v_managed_active;
  select exists(
    select 1 from public.bv2_feature_flags f
    where f.key='recovery.funding_policy.owner_connected_v1'
      and f.value->>'state'='active'
      and f.value->>'policyVersion'='owner_connected_recovery_v1'
      and f.value->>'executionTransport'='platform_connected_codex'
      and f.value->>'fundingSource'='thrallo'
      and f.value->>'deploymentCommit' ~ '^[0-9a-f]{40}$'
      and f.value->>'deploymentManifestSha256' ~ '^[0-9a-f]{64}$'
  ) into v_connected_active;
  v_starts_dispatch:=tg_op='INSERT'
    or (tg_op='UPDATE' and old.state='released' and new.state='held');
  if tg_op='UPDATE' and new.recovery_policy_version<>old.recovery_policy_version then
    raise exception 'Builder V2 recovery policy identity is immutable' using errcode='23505';
  end if;
  if new.recovery_policy_version='legacy_v1' then
    if (v_managed_active or v_connected_active) and v_starts_dispatch
        and new.usage_responsibility='thrallo_repair' then
      raise exception 'legacy Builder V2 repair dispatch is disabled after recovery policy activation'
        using errcode='P14P1';
    end if;
    new.funding_pool:=case
      when new.usage_responsibility='thrallo_repair' and new.billing_lane='managed'
        then 'thrallo_recovery'
      else 'customer_generation'
    end;
  elsif new.recovery_policy_version='managed_recovery_v1' then
    if v_starts_dispatch and new.funding_pool='thrallo_recovery' and v_connected_active then
      raise exception 'managed Builder V2 recovery dispatch is disabled after connected recovery activation'
        using errcode='P14P1';
    end if;
    if v_starts_dispatch and not v_managed_active then
      raise exception 'Builder V2 managed recovery policy is not activated' using errcode='P14P1';
    end if;
  elsif new.recovery_policy_version='owner_connected_recovery_v1'
      and v_starts_dispatch and not v_connected_active then
    raise exception 'Builder V2 connected recovery policy is not activated' using errcode='P14P1';
  end if;
  return new;
end $$;

create or replace function public.reserve_bv2_model_call_v4(
  p_owner uuid,p_project_id uuid,p_build_id uuid,p_call_key text,p_step text,
  p_provider text,p_model text,p_billing_lane text,p_usage_responsibility text,p_funding_pool text,
  p_reserved_credits numeric,p_ceiling_credits numeric,
  p_included_available_credits numeric default null,p_usage_period_start timestamptz default null,
  p_usage_row_count bigint default null,p_metadata jsonb default '{}'::jsonb
) returns jsonb language plpgsql security invoker set search_path='' as $$
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
    where owner=p_owner and build_id=p_build_id and funding_pool=p_funding_pool and state='held';
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
end $$;

revoke execute on function public.activate_bv2_owner_connected_recovery_policy(text,text,text)
  from public,anon,authenticated;
grant execute on function public.activate_bv2_owner_connected_recovery_policy(text,text,text)
  to service_role;

comment on column public.bv2_model_reservations.recovery_policy_version is
  'legacy_v1 and managed_recovery_v1 preserve historical execution evidence; owner_connected_recovery_v1 is admitted only after manifest-bound activation and keeps Thrallo recovery separate while executing through platform Codex.';
