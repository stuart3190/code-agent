-- V2-only customer accounting, explicit funding responsibility, and approval authority.
-- All money-like writes are service-role-only. Browser clients receive no direct table/RPC access.

create table if not exists public.credit_ledger (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  ts timestamptz not null default now(),
  delta numeric(14,4) not null,
  bucket text not null check (bucket in ('bundle','topup')),
  kind text not null check (kind in ('grant','debit','expire','refund','adjust')),
  model text,
  tokens integer,
  weight numeric(6,4),
  cycle text,
  ref text not null,
  created_at timestamptz not null default now()
);
create unique index if not exists credit_ledger_ref_kind_uq
  on public.credit_ledger(owner,ref,kind,bucket);
create index if not exists credit_ledger_owner_ts on public.credit_ledger(owner,ts);
alter table public.credit_ledger enable row level security;
revoke all on table public.credit_ledger from public, anon, authenticated;
grant select,insert on table public.credit_ledger to service_role;

-- Every usage writer participates in the same per-owner serialization boundary as model-call
-- reservations. This makes a client allowance snapshot safe against concurrent legacy consumers.
create or replace function public.lock_ca_usage_owner() returns trigger
language plpgsql set search_path='' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('bv2-model:'||new.owner::text,0));
  return new;
end $$;
drop trigger if exists ca_usage_records_owner_model_lock on public.ca_usage_records;
create trigger ca_usage_records_owner_model_lock before insert on public.ca_usage_records
  for each row execute function public.lock_ca_usage_owner();
drop trigger if exists credit_ledger_owner_model_lock on public.credit_ledger;
create trigger credit_ledger_owner_model_lock before insert on public.credit_ledger
  for each row execute function public.lock_ca_usage_owner();

alter table public.bv2_model_reservations
  add column usage_responsibility text not null default 'customer_request'
    check (usage_responsibility in ('customer_request','thrallo_repair','platform_failure','qualification')),
  add column included_reserved_credits numeric not null default 0 check (included_reserved_credits >= 0),
  add column purchased_reserved_credits numeric not null default 0 check (purchased_reserved_credits >= 0),
  add column platform_reserved_credits numeric not null default 0 check (platform_reserved_credits >= 0),
  add column included_actual_credits numeric check (included_actual_credits is null or included_actual_credits >= 0),
  add column purchased_actual_credits numeric check (purchased_actual_credits is null or purchased_actual_credits >= 0),
  add column platform_actual_credits numeric check (platform_actual_credits is null or platform_actual_credits >= 0),
  add column reconciliation_state text not null default 'none'
    check (reconciliation_state in ('none','pending','provider_settled','provider_rejected','platform_assumed')),
  add column reconciliation_reason text,
  add column ambiguous_at timestamptz,
  add column reconciled_at timestamptz;

-- Existing rows pre-date allocation accounting. Treat their historical cost as platform cost;
-- never retroactively debit a customer's new included or purchased balances.
update public.bv2_model_reservations set
  platform_reserved_credits=case when billing_lane='managed' then reserved_credits else 0 end,
  platform_actual_credits=case when actual_credits is not null
    then case when billing_lane='managed' then actual_credits else 0 end else null end,
  included_actual_credits=case when actual_credits is not null then 0 else null end,
  purchased_actual_credits=case when actual_credits is not null then 0 else null end,
  usage_responsibility=case when billing_lane='managed' then 'platform_failure' else 'customer_request' end,
  reconciliation_state=case when state='settled' then 'provider_settled'
    when state='released' then 'provider_rejected' else reconciliation_state end,
  reconciled_at=case when state in ('settled','released') then coalesce(settled_at,released_at,now()) else null end;

alter table public.bv2_model_reservations
  add constraint bv2_model_reservations_reserved_allocation_check check (
    (billing_lane='managed' and included_reserved_credits+purchased_reserved_credits+platform_reserved_credits=reserved_credits)
    or (billing_lane<>'managed' and included_reserved_credits=0 and purchased_reserved_credits=0 and platform_reserved_credits=0)
  ),
  add constraint bv2_model_reservations_actual_allocation_check check (
    actual_credits is null or
    (billing_lane='managed' and included_actual_credits+purchased_actual_credits+platform_actual_credits=actual_credits)
    or (billing_lane<>'managed' and included_actual_credits=0 and purchased_actual_credits=0 and platform_actual_credits=0)
  ),
  add constraint bv2_model_reservations_customer_allocation_check check (
    usage_responsibility='customer_request' or
    (included_reserved_credits=0 and purchased_reserved_credits=0 and
      coalesce(included_actual_credits,0)=0 and coalesce(purchased_actual_credits,0)=0)
  );

alter table public.ca_conversations
  add constraint ca_conversations_id_owner_unique unique (id,owner);

create table public.ca_lead_model_reservations (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null,
  call_key text not null check (length(call_key) between 8 and 240),
  provider text not null check (length(provider) between 1 and 80),
  model text not null check (length(model) between 1 and 200),
  billing_lane text not null check (billing_lane in ('managed','byok_api','connected_allowance')),
  state text not null default 'held' check (state in ('held','settled','released')),
  usage_responsibility text not null default 'customer_request'
    check (usage_responsibility in ('customer_request','platform_failure','qualification')),
  reserved_credits numeric not null check (reserved_credits >= 0),
  actual_credits numeric,
  included_reserved_credits numeric not null default 0 check (included_reserved_credits >= 0),
  purchased_reserved_credits numeric not null default 0 check (purchased_reserved_credits >= 0),
  platform_reserved_credits numeric not null default 0 check (platform_reserved_credits >= 0),
  included_actual_credits numeric,
  purchased_actual_credits numeric,
  platform_actual_credits numeric,
  usage jsonb,
  provider_request_ids jsonb,
  provider_request_fingerprint text,
  reconciliation_state text not null default 'none'
    check (reconciliation_state in ('none','pending','provider_settled','provider_rejected','platform_assumed')),
  reconciliation_reason text,
  ambiguous_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  released_at timestamptz,
  reconciled_at timestamptz,
  constraint ca_lead_model_reservations_conversation_owner_fkey
    foreign key (conversation_id,owner) references public.ca_conversations(id,owner) on delete cascade,
  constraint ca_lead_model_reservations_owner_call_unique unique (owner,conversation_id,call_key),
  constraint ca_lead_model_reservations_terminal_shape check (
    (state = 'held' and settled_at is null and released_at is null and actual_credits is null)
    or (state = 'settled' and settled_at is not null and released_at is null and actual_credits is not null)
    or (state = 'released' and released_at is not null and settled_at is null and actual_credits is null)
  ),
  constraint ca_lead_model_reservations_reserved_allocation_check check (
    (billing_lane='managed' and included_reserved_credits+purchased_reserved_credits+platform_reserved_credits=reserved_credits)
    or (billing_lane<>'managed' and included_reserved_credits=0 and purchased_reserved_credits=0 and platform_reserved_credits=0)
  ),
  constraint ca_lead_model_reservations_actual_allocation_check check (
    actual_credits is null
    or (billing_lane='managed' and included_actual_credits+purchased_actual_credits+platform_actual_credits=actual_credits)
    or (billing_lane<>'managed' and included_actual_credits=0 and purchased_actual_credits=0 and platform_actual_credits=0)
  ),
  constraint ca_lead_model_reservations_customer_allocation_check check (
    usage_responsibility='customer_request' or
    (included_reserved_credits=0 and purchased_reserved_credits=0 and
      coalesce(included_actual_credits,0)=0 and coalesce(purchased_actual_credits,0)=0)
  )
);
create index ca_lead_model_reservations_active_idx
  on public.ca_lead_model_reservations(owner,created_at) where state = 'held';
create unique index ca_lead_model_reservations_provider_request_unique
  on public.ca_lead_model_reservations(provider_request_fingerprint)
  where provider_request_fingerprint is not null;
alter table public.ca_lead_model_reservations enable row level security;
revoke all on table public.ca_lead_model_reservations from public,anon,authenticated;
grant select,insert,update,delete on table public.ca_lead_model_reservations to service_role;

create table public.ca_direct_model_reservations (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  run_id uuid references public.ca_runs(id) on delete set null,
  kind text not null check (kind in ('completion','coding_agent','model_evaluation','diagnostic_explanation')),
  subject_id text not null check (length(subject_id) between 1 and 240),
  call_key text not null check (length(call_key) between 8 and 240),
  provider text not null check (length(provider) between 1 and 80),
  model text not null check (length(model) between 1 and 200),
  state text not null default 'held' check (state in ('held','settled','released')),
  usage_responsibility text not null default 'customer_request'
    check (usage_responsibility in ('customer_request','platform_failure','qualification')),
  reserved_credits numeric not null check (reserved_credits >= 0),
  actual_credits numeric check (actual_credits is null or actual_credits >= 0),
  included_reserved_credits numeric not null default 0 check (included_reserved_credits >= 0),
  purchased_reserved_credits numeric not null default 0 check (purchased_reserved_credits >= 0),
  platform_reserved_credits numeric not null default 0 check (platform_reserved_credits >= 0),
  included_actual_credits numeric check (included_actual_credits is null or included_actual_credits >= 0),
  purchased_actual_credits numeric check (purchased_actual_credits is null or purchased_actual_credits >= 0),
  platform_actual_credits numeric check (platform_actual_credits is null or platform_actual_credits >= 0),
  usage jsonb,
  provider_request_ids jsonb,
  provider_request_fingerprint text,
  reconciliation_state text not null default 'none'
    check (reconciliation_state in ('none','pending','provider_settled','provider_rejected','platform_assumed')),
  reconciliation_reason text,
  ambiguous_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  released_at timestamptz,
  reconciled_at timestamptz,
  constraint ca_direct_model_reservations_owner_call_unique unique (owner,call_key),
  constraint ca_direct_model_reservations_terminal_shape check (
    (state='held' and settled_at is null and released_at is null and actual_credits is null)
    or (state='settled' and settled_at is not null and released_at is null and actual_credits is not null)
    or (state='released' and released_at is not null and settled_at is null and actual_credits is null)
  ),
  constraint ca_direct_model_reservations_reserved_allocation_check check (
    included_reserved_credits+purchased_reserved_credits+platform_reserved_credits=reserved_credits
  ),
  constraint ca_direct_model_reservations_actual_allocation_check check (
    actual_credits is null or included_actual_credits+purchased_actual_credits+platform_actual_credits=actual_credits
  ),
  constraint ca_direct_model_reservations_customer_allocation_check check (
    usage_responsibility='customer_request' or
    (included_reserved_credits=0 and purchased_reserved_credits=0 and
      coalesce(included_actual_credits,0)=0 and coalesce(purchased_actual_credits,0)=0)
  )
);
create index ca_direct_model_reservations_active_idx
  on public.ca_direct_model_reservations(owner,created_at) where state='held';
create unique index ca_direct_model_reservations_provider_request_unique
  on public.ca_direct_model_reservations(provider_request_fingerprint)
  where provider_request_fingerprint is not null;
alter table public.ca_direct_model_reservations enable row level security;
revoke all on table public.ca_direct_model_reservations from public,anon,authenticated;
grant select,insert,update,delete on table public.ca_direct_model_reservations to service_role;

-- One provider response may fund exactly one Thrallo call, regardless of whether the caller
-- was Builder V2, Lead Agent, completion, or a repository agent. Per-table unique indexes cannot
-- enforce that boundary.
create table public.ca_model_call_identities (
  provider_request_fingerprint text primary key check (length(provider_request_fingerprint)=64),
  provider text not null check (length(provider) between 1 and 80),
  reservation_kind text not null check (reservation_kind in ('builder_v2','lead','direct')),
  reservation_id uuid not null,
  owner uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
insert into public.ca_model_call_identities(
  provider_request_fingerprint,provider,reservation_kind,reservation_id,owner
)
select provider_request_fingerprint,provider,'builder_v2',id,owner
  from public.bv2_model_reservations where provider_request_fingerprint is not null
on conflict (provider_request_fingerprint) do nothing;
alter table public.ca_model_call_identities enable row level security;
revoke all on table public.ca_model_call_identities from public,anon,authenticated;
grant select,insert,delete on table public.ca_model_call_identities to service_role;

create table public.bv2_build_budget_approvals (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null,
  request_hash text not null check (length(request_hash) = 64),
  request_summary text not null check (length(request_summary) between 1 and 500),
  request_payload jsonb not null default '{}'::jsonb,
  complexity text not null check (complexity = 'advanced'),
  ceiling_credits numeric not null check (ceiling_credits > 0),
  status text not null default 'pending' check (status in ('pending','approved','declined','expired','consumed')),
  approved_by uuid references auth.users(id) on delete set null,
  expires_at timestamptz not null,
  resolved_at timestamptz,
  consumed_at timestamptz,
  dispatch_project_id uuid references public.projects(id) on delete set null,
  dispatch_job_id uuid,
  created_at timestamptz not null default now(),
  constraint bv2_build_budget_approvals_conversation_owner_fkey
    foreign key (conversation_id,owner) references public.ca_conversations(id,owner) on delete cascade
);
create unique index bv2_build_budget_approvals_pending_request_uq
  on public.bv2_build_budget_approvals(owner,conversation_id,request_hash) where status = 'pending';
create index bv2_build_budget_approvals_owner_idx
  on public.bv2_build_budget_approvals(owner,created_at desc);
alter table public.bv2_build_budget_approvals enable row level security;
revoke all on table public.bv2_build_budget_approvals from public,anon,authenticated;
grant select,insert,update,delete on table public.bv2_build_budget_approvals to service_role;

alter table public.build_jobs
  add column budget_approval_id uuid references public.bv2_build_budget_approvals(id) on delete set null;
alter table public.projects
  add column budget_approval_id uuid references public.bv2_build_budget_approvals(id) on delete set null;
alter table public.bv2_build_budget_approvals
  add constraint bv2_build_budget_approvals_dispatch_job_fkey
  foreign key (dispatch_job_id) references public.build_jobs(id) on delete set null;
create index build_jobs_budget_approval_idx on public.build_jobs(budget_approval_id)
  where budget_approval_id is not null;
create index projects_budget_approval_idx on public.projects(budget_approval_id)
  where budget_approval_id is not null;

create or replace function public.reserve_bv2_model_call_v3(
  p_owner uuid, p_project_id uuid, p_build_id uuid, p_call_key text, p_step text,
  p_provider text, p_model text, p_billing_lane text, p_usage_responsibility text,
  p_reserved_credits numeric, p_ceiling_credits numeric,
  p_included_available_credits numeric default null,
  p_usage_period_start timestamptz default null,
  p_usage_row_count bigint default null,
  p_metadata jsonb default '{}'::jsonb
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_existing public.bv2_model_reservations;
  v_row public.bv2_model_reservations;
  v_spent numeric; v_held numeric; v_max_repairs integer; v_repairs integer;
  v_included_held numeric; v_purchased_held numeric; v_included numeric := 0; v_purchased numeric := 0;
  v_available numeric; v_purchased_available numeric; v_current_usage_rows bigint;
begin
  if p_reserved_credits is null or p_reserved_credits < 0 or p_ceiling_credits is null or p_ceiling_credits <= 0
     or p_usage_responsibility not in ('customer_request','thrallo_repair','platform_failure','qualification')
     or p_billing_lane not in ('managed','byok_api','connected_allowance') then
    raise exception 'invalid Builder V2 reservation input' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('bv2-model:' || p_owner::text,0));
  select b.max_repair_dispatches into v_max_repairs from public.bv2_builds b
    where b.id=p_build_id and b.owner=p_owner and b.project_id=p_project_id for update;
  if not found then raise exception 'Builder V2 build is not owned by owner/project' using errcode='42501'; end if;

  select * into v_existing from public.bv2_model_reservations r
    where r.owner=p_owner and r.build_id=p_build_id and r.call_key=p_call_key;
  if found then
    if v_existing.project_id<>p_project_id or v_existing.step<>p_step or v_existing.provider<>p_provider
       or v_existing.model<>p_model or v_existing.billing_lane<>p_billing_lane
       or v_existing.usage_responsibility<>p_usage_responsibility
       or v_existing.reserved_credits<>p_reserved_credits then
      raise exception 'Builder V2 call key was reused with different reservation identity' using errcode='23505';
    end if;
  end if;
  if found and v_existing.state <> 'released' then
    select count(*)::integer into v_repairs from public.bv2_model_reservations r
      where r.owner=p_owner and r.build_id=p_build_id and r.step='repair' and r.state in ('held','settled');
    return jsonb_build_object('reservation',to_jsonb(v_existing),'acquired',false,
      'repair_dispatch_count',v_repairs,'max_repairs',v_max_repairs);
  end if;

  select coalesce(sum(actual_credits),0) into v_spent from public.bv2_model_reservations
    where owner=p_owner and build_id=p_build_id and state='settled';
  select coalesce(sum(reserved_credits),0) into v_held from public.bv2_model_reservations
    where owner=p_owner and build_id=p_build_id and state='held';
  if v_spent+v_held+p_reserved_credits>p_ceiling_credits then
    raise exception 'Builder V2 model-call ceiling exceeded' using errcode='P14C1';
  end if;
  select count(*)::integer into v_repairs from public.bv2_model_reservations
    where owner=p_owner and build_id=p_build_id and step='repair' and state in ('held','settled');
  if p_step='repair' and v_repairs>=v_max_repairs then
    raise exception 'Builder V2 repair provider-call limit reached' using errcode='P14R1';
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
        select included_reserved_credits,purchased_reserved_credits from public.bv2_model_reservations
          where owner=p_owner and state='held'
        union all
        select included_reserved_credits,purchased_reserved_credits from public.ca_lead_model_reservations
          where owner=p_owner and state='held'
        union all
        select included_reserved_credits,purchased_reserved_credits from public.ca_direct_model_reservations
          where owner=p_owner and state='held'
      ) holds;
    v_available := greatest(0,p_included_available_credits-v_included_held);
    v_included := least(p_reserved_credits,v_available);
    v_purchased := p_reserved_credits-v_included;
    select greatest(0,coalesce(sum(delta),0)) into v_purchased_available
      from public.credit_ledger where owner=p_owner and bucket='topup';
    if v_purchased > greatest(0,v_purchased_available-v_purchased_held) then
      raise exception 'Builder V2 managed account reservation exceeds availability' using errcode='P14A1';
    end if;
  end if;

  if v_existing.id is not null then
    update public.bv2_model_reservations set state='held',released_at=null,
      usage_responsibility=p_usage_responsibility,
      included_reserved_credits=v_included,purchased_reserved_credits=v_purchased,
      platform_reserved_credits=case when p_billing_lane='managed' and p_usage_responsibility<>'customer_request'
        then p_reserved_credits else 0 end,
      reconciliation_state='none',reconciliation_reason=null,reconciled_at=null,
      metadata=coalesce(p_metadata,'{}'::jsonb)||jsonb_build_object('reacquired_at',now())
      where id=v_existing.id returning * into v_row;
  else
    insert into public.bv2_model_reservations(
      owner,project_id,build_id,call_key,step,provider,model,billing_lane,usage_responsibility,
      reserved_credits,included_reserved_credits,purchased_reserved_credits,platform_reserved_credits,metadata
    ) values (
      p_owner,p_project_id,p_build_id,p_call_key,p_step,p_provider,p_model,p_billing_lane,p_usage_responsibility,
      p_reserved_credits,v_included,v_purchased,
      case when p_billing_lane='managed' and p_usage_responsibility<>'customer_request' then p_reserved_credits else 0 end,
      coalesce(p_metadata,'{}'::jsonb)
    ) returning * into v_row;
  end if;
  if p_step='repair' then v_repairs:=v_repairs+1; end if;
  return jsonb_build_object('reservation',to_jsonb(v_row),'acquired',true,
    'repair_dispatch_count',v_repairs,'max_repairs',v_max_repairs);
end $$;

create or replace function public.settle_bv2_model_call_v2(
  p_owner uuid,p_reservation_id uuid,p_actual_credits numeric,
  p_usage jsonb default '{}'::jsonb,p_provider_request_ids jsonb default '[]'::jsonb
) returns public.bv2_model_reservations language plpgsql security invoker set search_path='' as $$
declare
  v_row public.bv2_model_reservations; v_fingerprint text;
  v_included numeric:=0; v_purchased numeric:=0; v_platform numeric:=0;
begin
  if p_actual_credits is null or p_actual_credits<0 then raise exception 'invalid actual Builder V2 model cost' using errcode='22023'; end if;
  if jsonb_typeof(coalesce(p_usage,'{}'::jsonb))<>'object'
     or jsonb_typeof(coalesce(p_provider_request_ids,'[]'::jsonb))<>'array' then
    raise exception 'invalid Builder V2 usage or provider request ids' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('bv2-model:'||p_owner::text,0));
  select * into v_row from public.bv2_model_reservations where id=p_reservation_id and owner=p_owner for update;
  if not found then raise exception 'Builder V2 reservation not found' using errcode='42501'; end if;
  if v_row.state='settled' then
    if v_row.actual_credits<>p_actual_credits or coalesce(v_row.usage,'{}'::jsonb)<>coalesce(p_usage,'{}'::jsonb)
       or coalesce(v_row.provider_request_ids,'[]'::jsonb)<>coalesce(p_provider_request_ids,'[]'::jsonb) then
      raise exception 'duplicate Builder V2 settlement disagrees with canonical telemetry' using errcode='23505';
    end if;
    return v_row;
  end if;
  if v_row.state<>'held' then raise exception 'released Builder V2 reservation cannot settle' using errcode='55000'; end if;
  if jsonb_array_length(coalesce(p_provider_request_ids,'[]'::jsonb))>0 then
    v_fingerprint:=encode(extensions.digest(convert_to(v_row.provider||':'||coalesce(p_provider_request_ids,'[]'::jsonb)::text,'utf8'),'sha256'),'hex');
  end if;
  if v_row.billing_lane='managed' then
    if v_row.usage_responsibility='customer_request' then
      v_included:=least(p_actual_credits,v_row.included_reserved_credits);
      v_purchased:=least(p_actual_credits-v_included,v_row.purchased_reserved_credits);
      v_platform:=greatest(0,p_actual_credits-v_included-v_purchased);
    else
      v_platform:=p_actual_credits;
    end if;
  end if;
  if v_fingerprint is not null then
    insert into public.ca_model_call_identities(
      provider_request_fingerprint,provider,reservation_kind,reservation_id,owner
    ) values(v_fingerprint,v_row.provider,'builder_v2',v_row.id,v_row.owner)
    on conflict (provider_request_fingerprint) do nothing;
    if not exists(select 1 from public.ca_model_call_identities i
      where i.provider_request_fingerprint=v_fingerprint and i.reservation_kind='builder_v2'
        and i.reservation_id=v_row.id and i.owner=v_row.owner) then
      raise exception 'provider request telemetry is already settled to another reservation' using errcode='23505';
    end if;
  end if;
  update public.bv2_model_reservations set state='settled',actual_credits=p_actual_credits,
    included_actual_credits=v_included,purchased_actual_credits=v_purchased,platform_actual_credits=v_platform,
    usage=coalesce(p_usage,'{}'::jsonb),provider_request_ids=coalesce(p_provider_request_ids,'[]'::jsonb),
    provider_request_fingerprint=v_fingerprint,settled_at=now(),
    reconciliation_state='provider_settled',reconciled_at=now()
    where id=v_row.id returning * into v_row;
  if v_row.billing_lane='managed' and v_included>0 then
    insert into public.ca_usage_records(
      id,owner,run_id,provider,model,input_tokens,cached_tokens,output_tokens,reasoning_tokens,
      compute_seconds,amount_gbp,billing_source,metadata
    ) values (
      v_row.id,v_row.owner,null,v_row.provider,v_row.model,
      coalesce((p_usage->>'input')::bigint,(p_usage->>'inputTokens')::bigint,0),
      coalesce((p_usage->>'cached')::bigint,(p_usage->>'cachedTokens')::bigint,0),
      coalesce((p_usage->>'output')::bigint,(p_usage->>'outputTokens')::bigint,0),
      coalesce((p_usage->>'reasoning')::bigint,(p_usage->>'reasoningTokens')::bigint,0),
      0,0,'managed',jsonb_build_object('kind','app_build_v2','reservation_id',v_row.id,
        'project_id',v_row.project_id,'build_id',v_row.build_id,'step',v_row.step,
        'charge_credits',v_included,'actual_credits',p_actual_credits,
        'usage_responsibility',v_row.usage_responsibility,'provider_request_ids',coalesce(p_provider_request_ids,'[]'::jsonb))
    ) on conflict (id) do nothing;
  end if;
  if v_purchased>0 then
    insert into public.credit_ledger(owner,delta,bucket,kind,model,tokens,ref)
      values(v_row.owner,-v_purchased,'topup','debit',v_row.model,
        coalesce((p_usage->>'total')::integer,(p_usage->>'totalTokens')::integer,0),
        'bv2-reservation:'||v_row.id::text)
      on conflict (owner,ref,kind,bucket) do nothing;
  end if;
  return v_row;
end $$;

create or replace function public.release_bv2_model_call(
  p_owner uuid,p_reservation_id uuid
) returns public.bv2_model_reservations language plpgsql security invoker set search_path='' as $$
declare v_row public.bv2_model_reservations;
begin
  perform pg_advisory_xact_lock(hashtextextended('bv2-model:'||p_owner::text,0));
  select * into v_row from public.bv2_model_reservations
    where id=p_reservation_id and owner=p_owner for update;
  if not found then raise exception 'Builder V2 reservation not found' using errcode='42501'; end if;
  if v_row.state='released' then return v_row; end if;
  if v_row.state<>'held' then raise exception 'settled Builder V2 reservation cannot release' using errcode='55000'; end if;
  update public.bv2_model_reservations set state='released',released_at=now(),
    reconciliation_state='provider_rejected',reconciled_at=now()
    where id=v_row.id returning * into v_row;
  return v_row;
end $$;

create or replace function public.mark_bv2_model_call_ambiguous(
  p_owner uuid,p_reservation_id uuid,p_reason text default null,
  p_provider_request_ids jsonb default '[]'::jsonb
) returns public.bv2_model_reservations language plpgsql security invoker set search_path='' as $$
declare v_row public.bv2_model_reservations; v_fingerprint text;
begin
  if jsonb_typeof(coalesce(p_provider_request_ids,'[]'::jsonb))<>'array' then
    raise exception 'invalid Builder V2 provider request ids' using errcode='22023';
  end if;
  select * into v_row from public.bv2_model_reservations
    where id=p_reservation_id and owner=p_owner and state='held' for update;
  if not found then raise exception 'held Builder V2 reservation not found' using errcode='42501'; end if;
  if jsonb_array_length(coalesce(p_provider_request_ids,'[]'::jsonb))>0 then
    v_fingerprint:=encode(extensions.digest(convert_to(v_row.provider||':'||coalesce(p_provider_request_ids,'[]'::jsonb)::text,'utf8'),'sha256'),'hex');
    insert into public.ca_model_call_identities(
      provider_request_fingerprint,provider,reservation_kind,reservation_id,owner
    ) values(v_fingerprint,v_row.provider,'builder_v2',v_row.id,v_row.owner)
    on conflict (provider_request_fingerprint) do nothing;
    if not exists(select 1 from public.ca_model_call_identities i
      where i.provider_request_fingerprint=v_fingerprint and i.reservation_kind='builder_v2'
        and i.reservation_id=v_row.id and i.owner=v_row.owner) then
      raise exception 'provider request telemetry is already assigned to another reservation' using errcode='23505';
    end if;
  end if;
  update public.bv2_model_reservations set reconciliation_state='pending',
    reconciliation_reason=left(coalesce(p_reason,'provider dispatch ambiguous'),500),
    provider_request_ids=coalesce(p_provider_request_ids,'[]'::jsonb),
    provider_request_fingerprint=v_fingerprint,ambiguous_at=now()
    where id=p_reservation_id and owner=p_owner and state='held' returning * into v_row;
  return v_row;
end $$;

create or replace function public.absorb_ambiguous_bv2_model_call(
  p_owner uuid,p_reservation_id uuid,p_reason text default null
) returns public.bv2_model_reservations language plpgsql security invoker set search_path='' as $$
declare v_row public.bv2_model_reservations;
begin
  perform pg_advisory_xact_lock(hashtextextended('bv2-model:'||p_owner::text,0));
  update public.bv2_model_reservations set
    usage_responsibility=case when billing_lane='managed' then 'platform_failure' else usage_responsibility end,
    included_reserved_credits=0,purchased_reserved_credits=0,
    platform_reserved_credits=case when billing_lane='managed' then reserved_credits else 0 end,
    reconciliation_state='platform_assumed',reconciliation_reason=left(coalesce(p_reason,'customer hold transferred to platform'),500),
    reconciled_at=now()
    where id=p_reservation_id and owner=p_owner and state='held' and reconciliation_state in ('none','pending')
    returning * into v_row;
  if not found then raise exception 'unresolved Builder V2 reservation not found' using errcode='42501'; end if;
  return v_row;
end $$;

create or replace function public.reserve_ca_lead_model_call(
  p_owner uuid,p_conversation_id uuid,p_call_key text,p_provider text,p_model text,
  p_billing_lane text,p_usage_responsibility text,p_reserved_credits numeric,
  p_included_available_credits numeric,p_usage_period_start timestamptz,p_usage_row_count bigint,
  p_metadata jsonb default '{}'::jsonb
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  v_existing public.ca_lead_model_reservations; v_row public.ca_lead_model_reservations;
  v_included_held numeric; v_purchased_held numeric; v_included numeric:=0; v_purchased numeric:=0;
  v_purchased_available numeric; v_current_usage_rows bigint;
begin
  if p_reserved_credits is null or p_reserved_credits<0
     or p_billing_lane not in ('managed','byok_api','connected_allowance')
     or p_usage_responsibility not in ('customer_request','platform_failure','qualification') then
    raise exception 'invalid Lead Agent reservation input' using errcode='22023';
  end if;
  if not exists(select 1 from public.ca_conversations c where c.id=p_conversation_id and c.owner=p_owner) then
    raise exception 'Lead Agent conversation is not owned by owner' using errcode='42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('bv2-model:'||p_owner::text,0));
  select * into v_existing from public.ca_lead_model_reservations
    where owner=p_owner and conversation_id=p_conversation_id and call_key=p_call_key;
  if found then
    if v_existing.provider<>p_provider or v_existing.model<>p_model or v_existing.billing_lane<>p_billing_lane
       or v_existing.usage_responsibility<>p_usage_responsibility
       or v_existing.reserved_credits<>p_reserved_credits then
      raise exception 'Lead Agent call key was reused with different reservation identity' using errcode='23505';
    end if;
    if v_existing.state<>'released' then
      return jsonb_build_object('reservation',to_jsonb(v_existing),'acquired',false);
    end if;
  end if;
  if p_billing_lane='managed' and p_usage_responsibility='customer_request' then
    if p_included_available_credits is null or p_usage_period_start is null or p_usage_row_count is null then
      raise exception 'managed Lead Agent calls require a current allowance snapshot' using errcode='22023';
    end if;
    select count(*) into v_current_usage_rows from public.ca_usage_records
      where owner=p_owner and created_at>=p_usage_period_start;
    if v_current_usage_rows<>p_usage_row_count then
      raise exception 'managed allowance snapshot is stale' using errcode='P14S1';
    end if;
    select coalesce(sum(included_reserved_credits),0),coalesce(sum(purchased_reserved_credits),0)
      into v_included_held,v_purchased_held from (
        select included_reserved_credits,purchased_reserved_credits from public.bv2_model_reservations
          where owner=p_owner and state='held'
        union all
        select included_reserved_credits,purchased_reserved_credits from public.ca_lead_model_reservations
          where owner=p_owner and state='held'
        union all
        select included_reserved_credits,purchased_reserved_credits from public.ca_direct_model_reservations
          where owner=p_owner and state='held'
      ) holds;
    v_included:=least(p_reserved_credits,greatest(0,p_included_available_credits-v_included_held));
    v_purchased:=p_reserved_credits-v_included;
    select greatest(0,coalesce(sum(delta),0)) into v_purchased_available
      from public.credit_ledger where owner=p_owner and bucket='topup';
    if v_purchased>greatest(0,v_purchased_available-v_purchased_held) then
      raise exception 'Lead Agent managed account reservation exceeds availability' using errcode='P14A1';
    end if;
  end if;
  if v_existing.id is not null then
    update public.ca_lead_model_reservations set state='held',released_at=null,
      usage_responsibility=p_usage_responsibility,
      included_reserved_credits=v_included,purchased_reserved_credits=v_purchased,
      platform_reserved_credits=case when p_billing_lane='managed' and p_usage_responsibility<>'customer_request'
        then p_reserved_credits else 0 end,
      reconciliation_state='none',reconciliation_reason=null,provider_request_ids=null,
      provider_request_fingerprint=null,ambiguous_at=null,reconciled_at=null,
      metadata=coalesce(p_metadata,'{}'::jsonb)||jsonb_build_object('reacquired_at',now())
      where id=v_existing.id returning * into v_row;
  else
    insert into public.ca_lead_model_reservations(
      owner,conversation_id,call_key,provider,model,billing_lane,usage_responsibility,reserved_credits,
      included_reserved_credits,purchased_reserved_credits,platform_reserved_credits,metadata
    ) values (
      p_owner,p_conversation_id,p_call_key,p_provider,p_model,p_billing_lane,p_usage_responsibility,p_reserved_credits,
      v_included,v_purchased,
      case when p_billing_lane='managed' and p_usage_responsibility<>'customer_request' then p_reserved_credits else 0 end,
      coalesce(p_metadata,'{}'::jsonb)
    ) returning * into v_row;
  end if;
  return jsonb_build_object('reservation',to_jsonb(v_row),'acquired',true);
end $$;

create or replace function public.settle_ca_lead_model_call(
  p_owner uuid,p_reservation_id uuid,p_actual_credits numeric,
  p_usage jsonb default '{}'::jsonb,p_provider_request_ids jsonb default '[]'::jsonb
) returns public.ca_lead_model_reservations language plpgsql security invoker set search_path='' as $$
declare
  v_row public.ca_lead_model_reservations; v_fingerprint text;
  v_included numeric:=0; v_purchased numeric:=0; v_platform numeric:=0;
begin
  if p_actual_credits is null or p_actual_credits<0
     or jsonb_typeof(coalesce(p_usage,'{}'::jsonb))<>'object'
     or jsonb_typeof(coalesce(p_provider_request_ids,'[]'::jsonb))<>'array' then
    raise exception 'invalid Lead Agent settlement' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('bv2-model:'||p_owner::text,0));
  select * into v_row from public.ca_lead_model_reservations where id=p_reservation_id and owner=p_owner for update;
  if not found then raise exception 'Lead Agent reservation not found' using errcode='42501'; end if;
  if v_row.state='settled' then
    if v_row.actual_credits<>p_actual_credits or coalesce(v_row.usage,'{}'::jsonb)<>coalesce(p_usage,'{}'::jsonb)
       or coalesce(v_row.provider_request_ids,'[]'::jsonb)<>coalesce(p_provider_request_ids,'[]'::jsonb) then
      raise exception 'duplicate Lead Agent settlement disagrees with canonical telemetry' using errcode='23505';
    end if;
    return v_row;
  end if;
  if v_row.state<>'held' then
    raise exception 'invalid Lead Agent settlement' using errcode='P0001';
  end if;
  if jsonb_array_length(coalesce(p_provider_request_ids,'[]'::jsonb))>0 then
    v_fingerprint:=encode(extensions.digest(convert_to(v_row.provider||':'||coalesce(p_provider_request_ids,'[]'::jsonb)::text,'utf8'),'sha256'),'hex');
    insert into public.ca_model_call_identities(
      provider_request_fingerprint,provider,reservation_kind,reservation_id,owner
    ) values(v_fingerprint,v_row.provider,'lead',v_row.id,v_row.owner)
    on conflict (provider_request_fingerprint) do nothing;
    if not exists(select 1 from public.ca_model_call_identities i
      where i.provider_request_fingerprint=v_fingerprint and i.reservation_kind='lead'
        and i.reservation_id=v_row.id and i.owner=v_row.owner) then
      raise exception 'provider request telemetry is already assigned to another reservation' using errcode='23505';
    end if;
  end if;
  if v_row.billing_lane='managed' then
    if v_row.usage_responsibility='customer_request' then
      v_included:=least(p_actual_credits,v_row.included_reserved_credits);
      v_purchased:=least(p_actual_credits-v_included,v_row.purchased_reserved_credits);
      v_platform:=greatest(0,p_actual_credits-v_included-v_purchased);
    else v_platform:=p_actual_credits; end if;
  end if;
  update public.ca_lead_model_reservations set state='settled',actual_credits=p_actual_credits,
    included_actual_credits=v_included,purchased_actual_credits=v_purchased,platform_actual_credits=v_platform,
    usage=coalesce(p_usage,'{}'::jsonb),provider_request_ids=coalesce(p_provider_request_ids,'[]'::jsonb),
    provider_request_fingerprint=v_fingerprint,settled_at=now(),reconciliation_state='provider_settled',reconciled_at=now()
    where id=v_row.id returning * into v_row;
  if v_included>0 then
    insert into public.ca_usage_records(
      id,owner,run_id,provider,model,input_tokens,cached_tokens,output_tokens,reasoning_tokens,
      compute_seconds,amount_gbp,billing_source,metadata
    ) values (
      v_row.id,v_row.owner,null,v_row.provider,v_row.model,
      coalesce((p_usage->>'input')::bigint,(p_usage->>'inputTokens')::bigint,0),
      coalesce((p_usage->>'cached')::bigint,(p_usage->>'cachedTokens')::bigint,0),
      coalesce((p_usage->>'output')::bigint,(p_usage->>'outputTokens')::bigint,0),
      coalesce((p_usage->>'reasoning')::bigint,(p_usage->>'reasoningTokens')::bigint,0),
      0,0,'managed',jsonb_build_object('kind','conversation','reservation_id',v_row.id,
        'conversation_id',v_row.conversation_id,'charge_credits',v_included,
        'actual_credits',p_actual_credits,'usage_responsibility',v_row.usage_responsibility,
        'provider_request_ids',coalesce(p_provider_request_ids,'[]'::jsonb))
    ) on conflict(id) do nothing;
  end if;
  if v_purchased>0 then
    insert into public.credit_ledger(owner,delta,bucket,kind,model,tokens,ref)
      values(v_row.owner,-v_purchased,'topup','debit',v_row.model,
        coalesce((p_usage->>'total')::integer,(p_usage->>'totalTokens')::integer,0),
        'lead-reservation:'||v_row.id::text)
      on conflict(owner,ref,kind,bucket) do nothing;
  end if;
  return v_row;
end $$;

create or replace function public.release_ca_lead_model_call(
  p_owner uuid,p_reservation_id uuid
) returns public.ca_lead_model_reservations language plpgsql security invoker set search_path='' as $$
declare v_row public.ca_lead_model_reservations;
begin
  perform pg_advisory_xact_lock(hashtextextended('bv2-model:'||p_owner::text,0));
  update public.ca_lead_model_reservations set state='released',released_at=now(),
    reconciliation_state='provider_rejected',reconciled_at=now()
    where id=p_reservation_id and owner=p_owner and state='held' returning * into v_row;
  if not found then
    select * into v_row from public.ca_lead_model_reservations where id=p_reservation_id and owner=p_owner;
    if not found or v_row.state<>'released' then raise exception 'held Lead Agent reservation not found' using errcode='42501'; end if;
  end if;
  return v_row;
end $$;

create or replace function public.mark_ca_lead_model_call_ambiguous(
  p_owner uuid,p_reservation_id uuid,p_reason text default null,
  p_provider_request_ids jsonb default '[]'::jsonb
) returns public.ca_lead_model_reservations language plpgsql security invoker set search_path='' as $$
declare v_row public.ca_lead_model_reservations; v_fingerprint text;
begin
  if jsonb_typeof(coalesce(p_provider_request_ids,'[]'::jsonb))<>'array' then
    raise exception 'invalid Lead Agent provider request ids' using errcode='22023';
  end if;
  select * into v_row from public.ca_lead_model_reservations
    where id=p_reservation_id and owner=p_owner and state='held' for update;
  if not found then raise exception 'held Lead Agent reservation not found' using errcode='42501'; end if;
  if jsonb_array_length(coalesce(p_provider_request_ids,'[]'::jsonb))>0 then
    v_fingerprint:=encode(extensions.digest(convert_to(v_row.provider||':'||coalesce(p_provider_request_ids,'[]'::jsonb)::text,'utf8'),'sha256'),'hex');
    insert into public.ca_model_call_identities(
      provider_request_fingerprint,provider,reservation_kind,reservation_id,owner
    ) values(v_fingerprint,v_row.provider,'lead',v_row.id,v_row.owner)
    on conflict (provider_request_fingerprint) do nothing;
    if not exists(select 1 from public.ca_model_call_identities i
      where i.provider_request_fingerprint=v_fingerprint and i.reservation_kind='lead'
        and i.reservation_id=v_row.id and i.owner=v_row.owner) then
      raise exception 'provider request telemetry is already assigned to another reservation' using errcode='23505';
    end if;
  end if;
  update public.ca_lead_model_reservations set reconciliation_state='pending',
    reconciliation_reason=left(coalesce(p_reason,'provider dispatch ambiguous'),500),
    provider_request_ids=coalesce(p_provider_request_ids,'[]'::jsonb),
    provider_request_fingerprint=v_fingerprint,ambiguous_at=now()
    where id=p_reservation_id and owner=p_owner and state='held' returning * into v_row;
  if not found then raise exception 'held Lead Agent reservation not found' using errcode='42501'; end if;
  return v_row;
end $$;

create or replace function public.absorb_ambiguous_ca_lead_model_call(
  p_owner uuid,p_reservation_id uuid,p_reason text default null
) returns public.ca_lead_model_reservations language plpgsql security invoker set search_path='' as $$
declare v_row public.ca_lead_model_reservations;
begin
  perform pg_advisory_xact_lock(hashtextextended('bv2-model:'||p_owner::text,0));
  update public.ca_lead_model_reservations set
    usage_responsibility=case when billing_lane='managed' then 'platform_failure' else usage_responsibility end,
    included_reserved_credits=0,purchased_reserved_credits=0,
    platform_reserved_credits=case when billing_lane='managed' then reserved_credits else 0 end,
    reconciliation_state='platform_assumed',reconciliation_reason=left(coalesce(p_reason,'customer hold transferred to platform'),500),
    reconciled_at=now()
    where id=p_reservation_id and owner=p_owner and state='held' and reconciliation_state in ('none','pending')
    returning * into v_row;
  if not found then raise exception 'unresolved Lead Agent reservation not found' using errcode='42501'; end if;
  return v_row;
end $$;

create or replace function public.reserve_ca_direct_model_call(
  p_owner uuid,p_run_id uuid,p_kind text,p_subject_id text,p_call_key text,
  p_provider text,p_model text,p_usage_responsibility text,p_reserved_credits numeric,
  p_included_available_credits numeric,p_usage_period_start timestamptz,p_usage_row_count bigint,
  p_metadata jsonb default '{}'::jsonb
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  v_existing public.ca_direct_model_reservations; v_row public.ca_direct_model_reservations;
  v_included_held numeric; v_purchased_held numeric; v_included numeric:=0; v_purchased numeric:=0;
  v_platform numeric:=0; v_purchased_available numeric; v_current_usage_rows bigint;
begin
  if p_reserved_credits is null or p_reserved_credits<0
     or p_kind not in ('completion','coding_agent','model_evaluation','diagnostic_explanation')
     or length(coalesce(p_subject_id,'')) not between 1 and 240
     or p_usage_responsibility not in ('customer_request','platform_failure','qualification')
     or (p_kind='coding_agent' and p_run_id is null)
     or (p_kind<>'coding_agent' and p_run_id is not null) then
    raise exception 'invalid direct managed reservation input' using errcode='22023';
  end if;
  if p_run_id is not null and not exists(
    select 1 from public.ca_runs r where r.id=p_run_id and r.owner=p_owner
  ) then
    raise exception 'direct managed run is not owned by owner' using errcode='42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('bv2-model:'||p_owner::text,0));
  select * into v_existing from public.ca_direct_model_reservations r
    where r.owner=p_owner and r.call_key=p_call_key;
  if found then
    if v_existing.run_id is distinct from p_run_id or v_existing.kind<>p_kind
       or v_existing.subject_id<>p_subject_id or v_existing.provider<>p_provider
       or v_existing.model<>p_model or v_existing.usage_responsibility<>p_usage_responsibility
       or v_existing.reserved_credits<>p_reserved_credits then
      raise exception 'direct managed call key was reused with different reservation identity' using errcode='23505';
    end if;
    if v_existing.state<>'released' then
      return jsonb_build_object('reservation',to_jsonb(v_existing),'acquired',false);
    end if;
  end if;

  if p_usage_responsibility='customer_request' then
    if p_included_available_credits is null or p_usage_period_start is null or p_usage_row_count is null
       or p_included_available_credits<0 then
      raise exception 'direct managed calls require a current allowance snapshot' using errcode='22023';
    end if;
    select count(*) into v_current_usage_rows from public.ca_usage_records
      where owner=p_owner and created_at>=p_usage_period_start;
    if v_current_usage_rows<>p_usage_row_count then
      raise exception 'managed allowance snapshot is stale' using errcode='P14S1';
    end if;
    select coalesce(sum(included_reserved_credits),0),coalesce(sum(purchased_reserved_credits),0)
      into v_included_held,v_purchased_held from (
        select included_reserved_credits,purchased_reserved_credits from public.bv2_model_reservations
          where owner=p_owner and state='held'
        union all
        select included_reserved_credits,purchased_reserved_credits from public.ca_lead_model_reservations
          where owner=p_owner and state='held'
        union all
        select included_reserved_credits,purchased_reserved_credits from public.ca_direct_model_reservations
          where owner=p_owner and state='held'
      ) holds;
    v_included:=least(p_reserved_credits,greatest(0,p_included_available_credits-v_included_held));
    v_purchased:=p_reserved_credits-v_included;
    select greatest(0,coalesce(sum(delta),0)) into v_purchased_available
      from public.credit_ledger where owner=p_owner and bucket='topup';
    if v_purchased>greatest(0,v_purchased_available-v_purchased_held) then
      raise exception 'direct managed account reservation exceeds availability' using errcode='P14A1';
    end if;
  else
    v_platform:=p_reserved_credits;
  end if;

  if v_existing.id is not null then
    update public.ca_direct_model_reservations set state='held',released_at=null,settled_at=null,
      actual_credits=null,usage=null,provider_request_ids=null,provider_request_fingerprint=null,
      included_reserved_credits=v_included,purchased_reserved_credits=v_purchased,
      platform_reserved_credits=v_platform,included_actual_credits=null,purchased_actual_credits=null,
      platform_actual_credits=null,reconciliation_state='none',reconciliation_reason=null,
      ambiguous_at=null,reconciled_at=null,
      metadata=coalesce(p_metadata,'{}'::jsonb)||jsonb_build_object('reacquired_at',now())
      where id=v_existing.id returning * into v_row;
  else
    insert into public.ca_direct_model_reservations(
      owner,run_id,kind,subject_id,call_key,provider,model,usage_responsibility,reserved_credits,
      included_reserved_credits,purchased_reserved_credits,platform_reserved_credits,metadata
    ) values (
      p_owner,p_run_id,p_kind,p_subject_id,p_call_key,p_provider,p_model,p_usage_responsibility,p_reserved_credits,
      v_included,v_purchased,v_platform,coalesce(p_metadata,'{}'::jsonb)
    ) returning * into v_row;
  end if;
  return jsonb_build_object('reservation',to_jsonb(v_row),'acquired',true);
end $$;

create or replace function public.settle_ca_direct_model_call(
  p_owner uuid,p_reservation_id uuid,p_actual_credits numeric,
  p_usage jsonb default '{}'::jsonb,p_provider_request_ids jsonb default '[]'::jsonb
) returns public.ca_direct_model_reservations language plpgsql security invoker set search_path='' as $$
declare
  v_row public.ca_direct_model_reservations; v_fingerprint text;
  v_included numeric:=0; v_purchased numeric:=0; v_platform numeric:=0;
begin
  if p_actual_credits is null or p_actual_credits<0
     or jsonb_typeof(coalesce(p_usage,'{}'::jsonb))<>'object'
     or jsonb_typeof(coalesce(p_provider_request_ids,'[]'::jsonb))<>'array' then
    raise exception 'invalid direct managed settlement' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('bv2-model:'||p_owner::text,0));
  select * into v_row from public.ca_direct_model_reservations
    where id=p_reservation_id and owner=p_owner for update;
  if not found then raise exception 'direct managed reservation not found' using errcode='42501'; end if;
  if v_row.state='settled' then
    if v_row.actual_credits<>p_actual_credits or coalesce(v_row.usage,'{}'::jsonb)<>coalesce(p_usage,'{}'::jsonb)
       or coalesce(v_row.provider_request_ids,'[]'::jsonb)<>coalesce(p_provider_request_ids,'[]'::jsonb) then
      raise exception 'duplicate direct managed settlement disagrees with canonical telemetry' using errcode='23505';
    end if;
    return v_row;
  end if;
  if v_row.state<>'held' then
    raise exception 'released direct managed reservation cannot settle' using errcode='55000';
  end if;
  if jsonb_array_length(coalesce(p_provider_request_ids,'[]'::jsonb))>0 then
    v_fingerprint:=encode(extensions.digest(convert_to(v_row.provider||':'||coalesce(p_provider_request_ids,'[]'::jsonb)::text,'utf8'),'sha256'),'hex');
    insert into public.ca_model_call_identities(
      provider_request_fingerprint,provider,reservation_kind,reservation_id,owner
    ) values(v_fingerprint,v_row.provider,'direct',v_row.id,v_row.owner)
    on conflict(provider_request_fingerprint) do nothing;
    if not exists(select 1 from public.ca_model_call_identities i
      where i.provider_request_fingerprint=v_fingerprint and i.reservation_kind='direct'
        and i.reservation_id=v_row.id and i.owner=v_row.owner) then
      raise exception 'provider request telemetry is already assigned to another reservation' using errcode='23505';
    end if;
  end if;
  if v_row.usage_responsibility='customer_request' then
    v_included:=least(p_actual_credits,v_row.included_reserved_credits);
    v_purchased:=least(p_actual_credits-v_included,v_row.purchased_reserved_credits);
    v_platform:=greatest(0,p_actual_credits-v_included-v_purchased);
  else
    v_platform:=p_actual_credits;
  end if;
  update public.ca_direct_model_reservations set state='settled',actual_credits=p_actual_credits,
    included_actual_credits=v_included,purchased_actual_credits=v_purchased,platform_actual_credits=v_platform,
    usage=coalesce(p_usage,'{}'::jsonb),provider_request_ids=coalesce(p_provider_request_ids,'[]'::jsonb),
    provider_request_fingerprint=v_fingerprint,settled_at=now(),reconciliation_state='provider_settled',
    reconciliation_reason=null,reconciled_at=now()
    where id=v_row.id returning * into v_row;
  if v_included>0 then
    insert into public.ca_usage_records(
      id,owner,run_id,provider,model,input_tokens,cached_tokens,output_tokens,reasoning_tokens,
      compute_seconds,amount_gbp,billing_source,metadata
    ) values (
      v_row.id,v_row.owner,v_row.run_id,v_row.provider,v_row.model,
      coalesce((p_usage->>'input')::bigint,(p_usage->>'inputTokens')::bigint,0),
      coalesce((p_usage->>'cached')::bigint,(p_usage->>'cachedTokens')::bigint,0),
      coalesce((p_usage->>'output')::bigint,(p_usage->>'outputTokens')::bigint,0),
      coalesce((p_usage->>'reasoning')::bigint,(p_usage->>'reasoningTokens')::bigint,0),
      0,0,'managed',coalesce(v_row.metadata,'{}'::jsonb)||jsonb_build_object(
        'kind',v_row.kind,'reservation_id',v_row.id,'charge_credits',v_included,
        'actual_credits',p_actual_credits,'usage_responsibility',v_row.usage_responsibility,
        'provider_request_ids',coalesce(p_provider_request_ids,'[]'::jsonb))
    ) on conflict(id) do nothing;
  end if;
  if v_purchased>0 then
    insert into public.credit_ledger(owner,delta,bucket,kind,model,tokens,ref)
      values(v_row.owner,-v_purchased,'topup','debit',v_row.model,
        coalesce((p_usage->>'total')::integer,(p_usage->>'totalTokens')::integer,0),
        'direct-reservation:'||v_row.id::text)
      on conflict(owner,ref,kind,bucket) do nothing;
  end if;
  return v_row;
end $$;

create or replace function public.release_ca_direct_model_call(
  p_owner uuid,p_reservation_id uuid
) returns public.ca_direct_model_reservations language plpgsql security invoker set search_path='' as $$
declare v_row public.ca_direct_model_reservations;
begin
  perform pg_advisory_xact_lock(hashtextextended('bv2-model:'||p_owner::text,0));
  update public.ca_direct_model_reservations set state='released',released_at=now(),
    reconciliation_state='provider_rejected',reconciled_at=now()
    where id=p_reservation_id and owner=p_owner and state='held'
      and reconciliation_state='none' and provider_request_fingerprint is null
    returning * into v_row;
  if not found then
    select * into v_row from public.ca_direct_model_reservations where id=p_reservation_id and owner=p_owner;
    if not found or v_row.state<>'released' then
      raise exception 'held direct managed reservation not found' using errcode='42501';
    end if;
  end if;
  return v_row;
end $$;

create or replace function public.mark_ca_direct_model_call_ambiguous(
  p_owner uuid,p_reservation_id uuid,p_reason text default null,
  p_provider_request_ids jsonb default '[]'::jsonb
) returns public.ca_direct_model_reservations language plpgsql security invoker set search_path='' as $$
declare v_row public.ca_direct_model_reservations; v_fingerprint text;
begin
  if jsonb_typeof(coalesce(p_provider_request_ids,'[]'::jsonb))<>'array' then
    raise exception 'invalid direct managed provider request ids' using errcode='22023';
  end if;
  select * into v_row from public.ca_direct_model_reservations
    where id=p_reservation_id and owner=p_owner and state='held' for update;
  if not found then raise exception 'held direct managed reservation not found' using errcode='42501'; end if;
  if jsonb_array_length(coalesce(p_provider_request_ids,'[]'::jsonb))>0 then
    v_fingerprint:=encode(extensions.digest(convert_to(v_row.provider||':'||coalesce(p_provider_request_ids,'[]'::jsonb)::text,'utf8'),'sha256'),'hex');
    insert into public.ca_model_call_identities(
      provider_request_fingerprint,provider,reservation_kind,reservation_id,owner
    ) values(v_fingerprint,v_row.provider,'direct',v_row.id,v_row.owner)
    on conflict(provider_request_fingerprint) do nothing;
    if not exists(select 1 from public.ca_model_call_identities i
      where i.provider_request_fingerprint=v_fingerprint and i.reservation_kind='direct'
        and i.reservation_id=v_row.id and i.owner=v_row.owner) then
      raise exception 'provider request telemetry is already assigned to another reservation' using errcode='23505';
    end if;
  end if;
  update public.ca_direct_model_reservations set reconciliation_state='pending',
    reconciliation_reason=left(coalesce(p_reason,'provider dispatch ambiguous'),500),
    provider_request_ids=coalesce(p_provider_request_ids,'[]'::jsonb),
    provider_request_fingerprint=v_fingerprint,ambiguous_at=now()
    where id=p_reservation_id and owner=p_owner and state='held' returning * into v_row;
  return v_row;
end $$;

create or replace function public.absorb_ambiguous_ca_direct_model_call(
  p_owner uuid,p_reservation_id uuid,p_reason text default null
) returns public.ca_direct_model_reservations language plpgsql security invoker set search_path='' as $$
declare v_row public.ca_direct_model_reservations;
begin
  perform pg_advisory_xact_lock(hashtextextended('bv2-model:'||p_owner::text,0));
  update public.ca_direct_model_reservations set usage_responsibility='platform_failure',
    included_reserved_credits=0,purchased_reserved_credits=0,platform_reserved_credits=reserved_credits,
    reconciliation_state='platform_assumed',
    reconciliation_reason=left(coalesce(p_reason,'customer hold transferred to platform'),500),
    reconciled_at=now()
    where id=p_reservation_id and owner=p_owner and state='held'
      and reconciliation_state in ('none','pending') returning * into v_row;
  if not found then raise exception 'unresolved direct managed reservation not found' using errcode='42501'; end if;
  return v_row;
end $$;

-- Retry only blocks while dispatch truth is genuinely unresolved. Once reconciliation transfers
-- an ambiguous hold to Thrallo, a fresh build may restart from the last green snapshot and the
-- work-job payload forces all repeated model work onto platform responsibility.
create or replace function public.prepare_bv2_pipeline_retry(
  p_owner uuid,p_public_build_id uuid,p_work_job_id uuid
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  v_public public.build_jobs; v_unresolved bigint:=0; v_total bigint:=0;
begin
  select * into v_public from public.build_jobs b
    where b.id=p_public_build_id and b.owner=p_owner and b.pipeline_version='v2'
      and b.work_job_id=p_work_job_id for update;
  if not found then raise exception 'Builder V2 public/work job identity mismatch' using errcode='42501'; end if;
  if v_public.status='complete' and v_public.result is not null then
    return jsonb_build_object('action','recovered','result',v_public.result,'stopReason',v_public.stop_reason);
  end if;
  if v_public.status in ('failed','interrupted') then
    return jsonb_build_object('action','terminal_public_job','status',v_public.status);
  end if;
  if v_public.bv2_build_id is null then
    return jsonb_build_object('action','restart_before_provider','abandonedBuildId',null);
  end if;
  select count(*),count(*) filter(where state='held' and reconciliation_state in ('none','pending'))
    into v_total,v_unresolved from public.bv2_model_reservations
    where owner=p_owner and build_id=v_public.bv2_build_id;
  if v_unresolved>0 then
    return jsonb_build_object('action','provider_replay_unsafe','abandonedBuildId',v_public.bv2_build_id,
      'reservationCount',v_total,'unresolvedReservationCount',v_unresolved);
  end if;
  update public.bv2_builds set state='failed',error='worker_crash_reconciled_platform_retry',
    finished_at=coalesce(finished_at,now())
    where id=v_public.bv2_build_id and owner=p_owner and state not in ('green','failed','cancelled','blocked');
  update public.build_work_jobs set payload=coalesce(payload,'{}'::jsonb)||jsonb_build_object(
      'usageResponsibility','platform_failure','recoveryOfBuildId',v_public.bv2_build_id)
    where id=p_work_job_id and owner=p_owner;
  update public.build_jobs set bv2_build_id=null,status='running',phase='running',error=null,
    stop_reason=null,updated_at=now() where id=v_public.id and owner=p_owner;
  return jsonb_build_object('action','restart_before_provider','abandonedBuildId',v_public.bv2_build_id,
    'platformFunded',v_total>0);
end $$;

revoke execute on function public.reserve_bv2_model_call_v3(uuid,uuid,uuid,text,text,text,text,text,text,numeric,numeric,numeric,timestamptz,bigint,jsonb)
  from public,anon,authenticated;
revoke execute on function public.settle_bv2_model_call_v2(uuid,uuid,numeric,jsonb,jsonb)
  from public,anon,authenticated;
revoke execute on function public.release_bv2_model_call(uuid,uuid)
  from public,anon,authenticated;
revoke execute on function public.mark_bv2_model_call_ambiguous(uuid,uuid,text,jsonb)
  from public,anon,authenticated;
revoke execute on function public.absorb_ambiguous_bv2_model_call(uuid,uuid,text)
  from public,anon,authenticated;
revoke execute on function public.reserve_ca_lead_model_call(uuid,uuid,text,text,text,text,text,numeric,numeric,timestamptz,bigint,jsonb)
  from public,anon,authenticated;
revoke execute on function public.settle_ca_lead_model_call(uuid,uuid,numeric,jsonb,jsonb)
  from public,anon,authenticated;
revoke execute on function public.release_ca_lead_model_call(uuid,uuid)
  from public,anon,authenticated;
revoke execute on function public.mark_ca_lead_model_call_ambiguous(uuid,uuid,text,jsonb)
  from public,anon,authenticated;
revoke execute on function public.absorb_ambiguous_ca_lead_model_call(uuid,uuid,text)
  from public,anon,authenticated;
revoke execute on function public.reserve_ca_direct_model_call(uuid,uuid,text,text,text,text,text,text,numeric,numeric,timestamptz,bigint,jsonb)
  from public,anon,authenticated;
revoke execute on function public.settle_ca_direct_model_call(uuid,uuid,numeric,jsonb,jsonb)
  from public,anon,authenticated;
revoke execute on function public.release_ca_direct_model_call(uuid,uuid)
  from public,anon,authenticated;
revoke execute on function public.mark_ca_direct_model_call_ambiguous(uuid,uuid,text,jsonb)
  from public,anon,authenticated;
revoke execute on function public.absorb_ambiguous_ca_direct_model_call(uuid,uuid,text)
  from public,anon,authenticated;
revoke execute on function public.prepare_bv2_pipeline_retry(uuid,uuid,uuid)
  from public,anon,authenticated;

grant execute on function public.reserve_bv2_model_call_v3(uuid,uuid,uuid,text,text,text,text,text,text,numeric,numeric,numeric,timestamptz,bigint,jsonb)
  to service_role;
grant execute on function public.settle_bv2_model_call_v2(uuid,uuid,numeric,jsonb,jsonb) to service_role;
grant execute on function public.release_bv2_model_call(uuid,uuid) to service_role;
grant execute on function public.mark_bv2_model_call_ambiguous(uuid,uuid,text,jsonb) to service_role;
grant execute on function public.absorb_ambiguous_bv2_model_call(uuid,uuid,text) to service_role;
grant execute on function public.reserve_ca_lead_model_call(uuid,uuid,text,text,text,text,text,numeric,numeric,timestamptz,bigint,jsonb)
  to service_role;
grant execute on function public.settle_ca_lead_model_call(uuid,uuid,numeric,jsonb,jsonb) to service_role;
grant execute on function public.release_ca_lead_model_call(uuid,uuid) to service_role;
grant execute on function public.mark_ca_lead_model_call_ambiguous(uuid,uuid,text,jsonb) to service_role;
grant execute on function public.absorb_ambiguous_ca_lead_model_call(uuid,uuid,text) to service_role;
grant execute on function public.reserve_ca_direct_model_call(uuid,uuid,text,text,text,text,text,text,numeric,numeric,timestamptz,bigint,jsonb)
  to service_role;
grant execute on function public.settle_ca_direct_model_call(uuid,uuid,numeric,jsonb,jsonb) to service_role;
grant execute on function public.release_ca_direct_model_call(uuid,uuid) to service_role;
grant execute on function public.mark_ca_direct_model_call_ambiguous(uuid,uuid,text,jsonb) to service_role;
grant execute on function public.absorb_ambiguous_ca_direct_model_call(uuid,uuid,text) to service_role;
grant execute on function public.prepare_bv2_pipeline_retry(uuid,uuid,uuid) to service_role;

-- Reconcile approval state after a process death. Consumed approvals with no durable job are
-- reusable; those attached to a durable job are canonical and remain consumed.
create or replace function public.reconcile_bv2_build_budget_approvals(
  p_older_than timestamptz
) returns setof public.bv2_build_budget_approvals language plpgsql security invoker set search_path='' as $$
begin
  return query
    with candidates as materialized (
      select a.id from public.bv2_build_budget_approvals a
        where a.status='consumed' and a.consumed_at<p_older_than and a.dispatch_job_id is null
          and not exists(select 1 from public.build_jobs j where j.budget_approval_id=a.id)
        for update
    ), removed_orphan_projects as (
      delete from public.projects p using candidates c
        where p.budget_approval_id=c.id
          and not exists(select 1 from public.build_jobs j where j.project_id=p.id::text)
        returning p.id
    )
    update public.bv2_build_budget_approvals a set
      status='approved',consumed_at=null,dispatch_project_id=null,dispatch_job_id=null
      from candidates c where a.id=c.id
    returning a.*;
end $$;
revoke execute on function public.reconcile_bv2_build_budget_approvals(timestamptz)
  from public,anon,authenticated;
grant execute on function public.reconcile_bv2_build_budget_approvals(timestamptz) to service_role;
