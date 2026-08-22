-- Builder V2 contract-derived envelopes, isolated recovery funding and terminal settlement.
-- Additive evidence tables are retained on rollback; customer routing must be disabled before
-- dropping the v4 reservation or terminal-settlement functions.

alter table public.bv2_builds
  drop constraint if exists bv2_builds_max_repair_dispatches_check;
alter table public.bv2_builds
  add constraint bv2_builds_max_repair_dispatches_check
  check (max_repair_dispatches between 0 and 1000);

alter table public.credit_ledger drop constraint if exists credit_ledger_kind_check;
alter table public.credit_ledger add constraint credit_ledger_kind_check
  check (kind in ('grant','debit','expire','refund','adjust','service_credit'));

create table public.bv2_build_envelopes (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null,
  build_id uuid not null,
  version integer not null check (version > 0),
  contract_hash text not null check (length(contract_hash)=64),
  complexity_band text not null check (complexity_band in ('basic_static','stateful_crud','complex_interactive')),
  envelope jsonb not null,
  created_at timestamptz not null default now(),
  constraint bv2_build_envelopes_build_owner_project_fkey
    foreign key(build_id,owner,project_id) references public.bv2_builds(id,owner,project_id) on delete cascade,
  constraint bv2_build_envelopes_build_version_unique unique(owner,build_id,version),
  constraint bv2_build_envelopes_contract_unique unique(owner,build_id,contract_hash)
);
create index bv2_build_envelopes_project_idx on public.bv2_build_envelopes(owner,project_id,created_at desc);

create table public.bv2_build_progress (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  build_id uuid not null,
  kind text not null check (length(kind) between 1 and 120),
  details jsonb not null default '{}',
  progressed_at timestamptz not null default now(),
  constraint bv2_build_progress_build_owner_fkey
    foreign key(build_id,owner) references public.bv2_builds(id,owner) on delete cascade
);
create index bv2_build_progress_build_idx on public.bv2_build_progress(owner,build_id,progressed_at);

create table public.bv2_recovery_approvals (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  build_id uuid not null,
  actor text not null check (length(actor) between 1 and 200),
  reason text not null check (length(reason) between 1 and 2000),
  previous_ceiling numeric not null check (previous_ceiling >= 0),
  additional_allowance numeric not null check (additional_allowance > 0),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint bv2_recovery_approvals_build_owner_fkey
    foreign key(build_id,owner) references public.bv2_builds(id,owner) on delete cascade
);
create index bv2_recovery_approvals_build_idx on public.bv2_recovery_approvals(owner,build_id,created_at desc);

create table public.bv2_duration_extensions (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  build_id uuid not null,
  actor text not null check (length(actor) between 1 and 200),
  reason text not null check (length(reason) between 1 and 2000),
  previous_expected_duration_ms bigint not null check (previous_expected_duration_ms > 0),
  revised_expected_duration_ms bigint not null check (revised_expected_duration_ms > previous_expected_duration_ms),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint bv2_duration_extensions_build_owner_fkey
    foreign key(build_id,owner) references public.bv2_builds(id,owner) on delete cascade
);
create index bv2_duration_extensions_build_idx on public.bv2_duration_extensions(owner,build_id,created_at desc);

create table public.bv2_verification_defects (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null,
  build_id uuid not null,
  defect_id text not null,
  version integer not null check (version > 0),
  classification text not null check (classification in ('interaction','behaviour','durability','platform','contract','unknown')),
  journey_id text,
  step_id text,
  source_tree_hash text not null,
  candidate_snapshot_id uuid,
  defect jsonb not null,
  created_at timestamptz not null default now(),
  constraint bv2_verification_defects_build_owner_project_fkey
    foreign key(build_id,owner,project_id) references public.bv2_builds(id,owner,project_id) on delete cascade,
  constraint bv2_verification_defects_identity_unique
    unique(owner,build_id,defect_id,version,source_tree_hash)
);
create index bv2_verification_defects_build_idx
  on public.bv2_verification_defects(owner,build_id,created_at);

create table public.bv2_repair_strategies (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null,
  build_id uuid not null,
  strategy_id text not null,
  sequence integer not null check (sequence > 0),
  targeted_owners jsonb not null default '[]',
  targeted_files jsonb not null default '[]',
  pre_tree_hash text not null,
  post_tree_hash text,
  pre_binding_hash text,
  post_binding_hash text,
  defect_signature_before text not null,
  defect_signature_after text,
  settled_recovery_cost numeric not null default 0 check (settled_recovery_cost >= 0),
  outcome text not null check (outcome in ('started','success','progress','no_progress','escalated','rejected','failed','error')),
  reason text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint bv2_repair_strategies_build_owner_project_fkey
    foreign key(build_id,owner,project_id) references public.bv2_builds(id,owner,project_id) on delete cascade,
  constraint bv2_repair_strategies_sequence_unique unique(owner,build_id,sequence)
);
create index bv2_repair_strategies_build_idx on public.bv2_repair_strategies(owner,build_id,created_at);

create table public.bv2_build_settlements (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  build_id uuid not null,
  terminal_state text not null,
  failure_classification text,
  green_preview boolean not null,
  spent_breakdown jsonb not null,
  managed_refund_credits numeric not null default 0 check (managed_refund_credits >= 0),
  service_credit_credits numeric not null default 0 check (service_credit_credits >= 0),
  compensation_eligible boolean not null,
  created_at timestamptz not null default now(),
  constraint bv2_build_settlements_build_owner_fkey
    foreign key(build_id,owner) references public.bv2_builds(id,owner) on delete cascade,
  constraint bv2_build_settlements_build_unique unique(owner,build_id)
);

alter table public.bv2_builds
  add column envelope_version integer,
  add column customer_state text not null default 'building'
    check (customer_state in ('building','checking','finishing','ready','action_required','failed')),
  add column spent_breakdown jsonb not null default '{}',
  add column failure jsonb,
  add column last_durable_progress_at timestamptz,
  add column expected_duration_ms bigint,
  add column hard_safety_duration_ms bigint;

alter table public.bv2_model_reservations
  add column funding_pool text not null default 'customer_generation'
    check (funding_pool in ('customer_generation','thrallo_recovery')),
  add column logical_dispatch_id text,
  add column continuation_index integer not null default 0 check (continuation_index >= 0),
  add column causal_files jsonb not null default '[]',
  add column checkpoint_id uuid;

update public.bv2_model_reservations set funding_pool='thrallo_recovery'
where usage_responsibility='thrallo_repair' and billing_lane='managed';

alter table public.bv2_model_reservations add constraint bv2_model_reservations_pool_responsibility_check check (
  (funding_pool='thrallo_recovery' and usage_responsibility='thrallo_repair' and billing_lane='managed')
  or (funding_pool='customer_generation' and usage_responsibility<>'thrallo_repair')
  or (funding_pool='customer_generation' and usage_responsibility='thrallo_repair'
    and billing_lane<>'managed' and created_at<'2026-08-22T16:00:00Z'::timestamptz)
);
create index bv2_model_reservations_pool_budget_idx
  on public.bv2_model_reservations(owner,build_id,funding_pool,state);

alter table public.bv2_build_envelopes enable row level security;
alter table public.bv2_build_progress enable row level security;
alter table public.bv2_recovery_approvals enable row level security;
alter table public.bv2_duration_extensions enable row level security;
alter table public.bv2_verification_defects enable row level security;
alter table public.bv2_repair_strategies enable row level security;
alter table public.bv2_build_settlements enable row level security;
revoke all on public.bv2_build_envelopes,public.bv2_build_progress,public.bv2_recovery_approvals,public.bv2_duration_extensions,
  public.bv2_verification_defects,public.bv2_repair_strategies,public.bv2_build_settlements
  from public,anon,authenticated;
grant select,insert,update,delete on public.bv2_build_envelopes,public.bv2_build_progress,
  public.bv2_recovery_approvals,public.bv2_duration_extensions,public.bv2_verification_defects,public.bv2_repair_strategies,
  public.bv2_build_settlements to service_role;

create or replace function public.reserve_bv2_model_call_v4(
  p_owner uuid,p_project_id uuid,p_build_id uuid,p_call_key text,p_step text,
  p_provider text,p_model text,p_billing_lane text,p_usage_responsibility text,p_funding_pool text,
  p_reserved_credits numeric,p_ceiling_credits numeric,
  p_included_available_credits numeric default null,p_usage_period_start timestamptz default null,
  p_usage_row_count bigint default null,p_metadata jsonb default '{}'::jsonb
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  v_existing public.bv2_model_reservations; v_row public.bv2_model_reservations;
  v_spent numeric; v_held numeric; v_repairs integer; v_max_repairs integer;
  v_included_held numeric; v_purchased_held numeric; v_included numeric:=0; v_purchased numeric:=0;
  v_available numeric; v_purchased_available numeric; v_current_usage_rows bigint;
begin
  if p_reserved_credits is null or p_reserved_credits<0 or p_ceiling_credits is null or p_ceiling_credits<=0
    or p_usage_responsibility not in ('customer_request','thrallo_repair','platform_failure','qualification')
    or p_billing_lane not in ('managed','byok_api','connected_allowance')
    or p_funding_pool not in ('customer_generation','thrallo_recovery')
    or (p_funding_pool='thrallo_recovery' and (p_usage_responsibility<>'thrallo_repair' or p_billing_lane<>'managed'))
    or (p_funding_pool='customer_generation' and p_usage_responsibility='thrallo_repair') then
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
      reserved_credits,included_reserved_credits,purchased_reserved_credits,platform_reserved_credits,
      logical_dispatch_id,continuation_index,causal_files,checkpoint_id,metadata
    ) values (
      p_owner,p_project_id,p_build_id,p_call_key,p_step,p_provider,p_model,p_billing_lane,p_usage_responsibility,p_funding_pool,
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

create or replace function public.release_held_bv2_model_calls(p_owner uuid,p_build_id uuid)
returns setof public.bv2_model_reservations language plpgsql security invoker set search_path='' as $$
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
    reconciliation_state=case when reconciliation_state='pending' then 'platform_assumed' else 'provider_rejected' end,
    reconciled_at=now()
  where owner=p_owner and build_id=p_build_id and state='held'
  returning *;
end $$;

create or replace function public.absorb_ambiguous_bv2_model_call(
  p_owner uuid,p_reservation_id uuid,p_reason text default null
) returns public.bv2_model_reservations language plpgsql security invoker set search_path='' as $$
declare v_row public.bv2_model_reservations;
begin
  perform pg_advisory_xact_lock(hashtextextended('bv2-model:'||p_owner::text,0));
  update public.bv2_model_reservations set
    usage_responsibility=case when funding_pool='customer_generation' and billing_lane='managed'
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
end $$;

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

create or replace function public.promote_bv2_green_projection(
  p_owner uuid,p_project_id uuid,p_build_id uuid,p_snapshot_id uuid,p_preview_url text
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_snapshot public.bv2_snapshots; v_settlement public.bv2_build_settlements;
begin
  if nullif(trim(p_preview_url),'') is null then
    raise exception 'verified preview URL is required' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('bv2-promote:'||p_owner::text||':'||p_project_id::text,0));
  perform 1 from public.bv2_builds where id=p_build_id and owner=p_owner and project_id=p_project_id for update;
  if not found then raise exception 'Builder V2 build not found for green projection' using errcode='42501'; end if;
  select * into v_snapshot from public.bv2_snapshots
    where id=p_snapshot_id and owner=p_owner and project_id=p_project_id and build_id=p_build_id
      and state='ready' for update;
  if not found or v_snapshot.reason not like 'working:%' then
    raise exception 'only a verified working snapshot may be promoted' using errcode='55000';
  end if;
  insert into public.bv2_project_pointers(owner,project_id,label,snapshot_id,updated_at)
    values(p_owner,p_project_id,'green',p_snapshot_id,now()),
      (p_owner,p_project_id,'preview',p_snapshot_id,now())
    on conflict(owner,project_id,label) do update set snapshot_id=excluded.snapshot_id,updated_at=excluded.updated_at;
  update public.projects set builder_version='v2',bv2_green_snapshot_id=p_snapshot_id,
    preview_ref=p_preview_url,updated_at=now() where id=p_project_id and owner=p_owner;
  if not found then raise exception 'project not found for green projection' using errcode='42501'; end if;
  update public.bv2_builds set state='green',final_snapshot=p_snapshot_id,customer_state='ready',
    finished_at=coalesce(finished_at,now()) where id=p_build_id and owner=p_owner;
  v_settlement:=public.settle_bv2_build_terminal(p_owner,p_build_id,'green',null,true,true);
  return jsonb_build_object('buildId',p_build_id,'snapshotId',p_snapshot_id,
    'previewUrl',p_preview_url,'state','ready','settlement',to_jsonb(v_settlement));
end $$;

revoke execute on function public.reserve_bv2_model_call_v4(uuid,uuid,uuid,text,text,text,text,text,text,text,numeric,numeric,numeric,timestamptz,bigint,jsonb)
  from public,anon,authenticated;
revoke execute on function public.release_held_bv2_model_calls(uuid,uuid) from public,anon,authenticated;
revoke execute on function public.settle_bv2_build_terminal(uuid,uuid,text,text,boolean,boolean) from public,anon,authenticated;
revoke execute on function public.promote_bv2_green_projection(uuid,uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.reserve_bv2_model_call_v4(uuid,uuid,uuid,text,text,text,text,text,text,text,numeric,numeric,numeric,timestamptz,bigint,jsonb)
  to service_role;
grant execute on function public.release_held_bv2_model_calls(uuid,uuid) to service_role;
grant execute on function public.settle_bv2_build_terminal(uuid,uuid,text,text,boolean,boolean) to service_role;
grant execute on function public.promote_bv2_green_projection(uuid,uuid,uuid,uuid,text) to service_role;

-- Worker failures carry a structured, internal-only record before the terminal work-item
-- transition. Preserve that evidence through the existing durable event stream.
alter table public.build_work_events drop constraint if exists build_work_events_type_check;
alter table public.build_work_events add constraint build_work_events_type_check check (
  event_type in ('queued','leased','running','heartbeat','progress','stdout','stderr',
    'structured_failure','cancel_requested','cancelled','lease_expired','retry_queued',
    'succeeded','failed','worker_crash','timeout','resource_limit')
);

create or replace function public.build_work_event(
  p_job_id uuid,p_worker_id text,p_lease_token uuid,p_event_type text,p_details jsonb
) returns bigint language plpgsql security invoker set search_path='' as $$
declare v_job public.build_work_jobs; v_seq bigint;
begin
  select * into v_job from public.build_work_jobs where id=p_job_id
    and lease_owner=p_worker_id and lease_token=p_lease_token
    and state in ('leased','running','cancel_requested');
  if v_job.id is null then raise exception 'lease lost' using errcode='40001'; end if;
  if p_event_type not in ('progress','stdout','stderr','structured_failure') then
    raise exception 'unsupported worker event type' using errcode='22023';
  end if;
  insert into public.build_work_events(job_id,owner,project_id,event_type,details)
    values(v_job.id,v_job.owner,v_job.project_id,p_event_type,coalesce(p_details,'{}'::jsonb))
    returning seq into v_seq;
  return v_seq;
end $$;

create or replace view public.bv2_timing_samples with (security_invoker=true) as
select b.owner,b.project_id,b.id as build_id,e.version as envelope_version,e.complexity_band,
  case when jsonb_array_length(e.envelope->'stages')<=6 then 'small'
    when jsonb_array_length(e.envelope->'stages')<=12 then 'medium' else 'large' end as contract_size_range,
  b.started_at,b.finished_at,
  case when b.finished_at is not null then floor(extract(epoch from (b.finished_at-b.started_at))*1000)::bigint end
    as total_duration_ms,
  b.expected_duration_ms,(e.envelope#>>'{execution,softTargetDurationMs}')::bigint as soft_target_duration_ms,
  b.hard_safety_duration_ms,b.spent_credits,b.spent_breakdown,
  coalesce(r.calls,0) as model_calls,coalesce(r.input_tokens,0) as input_tokens,
  coalesce(r.output_tokens,0) as output_tokens,coalesce(r.provider_routes,'[]'::jsonb) as provider_routes,
  coalesce(p.browser_passes,0) as browser_passes,coalesce(s.repair_strategies,0) as repair_strategies
from public.bv2_builds b join public.bv2_build_envelopes e on e.build_id=b.id and e.owner=b.owner
left join lateral (
  select count(*)::integer as calls,
    coalesce(sum(coalesce((usage->>'input')::bigint,(usage->>'inputTokens')::bigint,0)),0)::bigint as input_tokens,
    coalesce(sum(coalesce((usage->>'output')::bigint,(usage->>'outputTokens')::bigint,0)),0)::bigint as output_tokens,
    jsonb_agg(distinct jsonb_build_object('provider',provider,'model',model,'billingLane',billing_lane,
      'fundingPool',funding_pool)) as provider_routes
  from public.bv2_model_reservations where owner=b.owner and build_id=b.id and state='settled'
) r on true
left join lateral (
  select count(*)::integer as browser_passes from public.bv2_build_progress
  where owner=b.owner and build_id=b.id and kind='browser_verification_pass'
) p on true
left join lateral (
  select count(*)::integer as repair_strategies from public.bv2_repair_strategies
  where owner=b.owner and build_id=b.id and outcome<>'started'
) s on true
where b.state='green';

create or replace view public.bv2_operational_monitoring with (security_invoker=true) as
select b.owner,b.project_id,b.id as build_id,b.state,b.customer_state,
  coalesce(b.failure->>'classification','none') as terminal_classification,
  b.spent_breakdown,b.expected_duration_ms,b.hard_safety_duration_ms,b.last_durable_progress_at,
  coalesce(s.repair_strategies,0) as repair_strategies,
  coalesce(s.no_progress_strategies,0) as no_progress_strategies,
  coalesce(p.preflight_failures,0) as preflight_failures,
  coalesce(p.browser_passes,0) as browser_passes,
  st.managed_refund_credits,st.service_credit_credits,st.green_preview
from public.bv2_builds b
left join public.bv2_build_settlements st on st.owner=b.owner and st.build_id=b.id
left join lateral (
  select count(*)::integer as repair_strategies,
    count(*) filter(where outcome in ('no_progress','rejected','failed','error'))::integer as no_progress_strategies
  from public.bv2_repair_strategies where owner=b.owner and build_id=b.id and outcome<>'started'
) s on true
left join lateral (
  select count(*) filter(where kind='capability_preflight_result' and coalesce((details->>'ok')::boolean,true)=false)::integer
      as preflight_failures,
    count(*) filter(where kind='browser_verification_pass')::integer as browser_passes
  from public.bv2_build_progress where owner=b.owner and build_id=b.id
) p on true;

revoke all on public.bv2_timing_samples,public.bv2_operational_monitoring from public,anon,authenticated;
grant select on public.bv2_timing_samples,public.bv2_operational_monitoring to service_role;

comment on table public.bv2_build_envelopes is
  'Immutable contract-hash-bound Builder V2 customer generation, Thrallo recovery and duration envelope.';
comment on table public.bv2_build_settlements is
  'One idempotent terminal settlement per build, including customer refund or BYOK service credit.';
