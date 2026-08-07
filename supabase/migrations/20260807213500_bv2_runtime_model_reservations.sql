-- Builder V2 runtime composition: durable, atomic pre-dispatch model reservations.
--
-- Forward deployment:
--   Apply before enabling Builder V2 composition. The application must reserve one row before
--   every provider call and reconcile it to measured usage after the call. Browser roles receive
--   no table or RPC access.
--
-- Forward repair:
--   A held row whose worker lease is no longer live is evidence requiring reconciliation. Do not
--   delete it to make a budget available; settle it from provider telemetry or release it only
--   after proving the provider was never dispatched.
--
-- Rollback (only while Builder V2 customer dispatch remains disabled):
--   drop the three RPCs, drop bv2_model_reservations, then remove the composite unique constraint.
--   Historical ai_requests/diagnostics and the existing Builder V1 path are unaffected.

alter table public.bv2_builds
  add constraint bv2_builds_id_owner_project_unique unique (id, owner, project_id);

create table public.bv2_model_reservations (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null,
  build_id uuid not null,
  call_key text not null check (length(call_key) between 8 and 240),
  step text not null check (length(step) between 1 and 120),
  provider text not null check (length(provider) between 1 and 80),
  model text not null check (length(model) between 1 and 200),
  billing_lane text not null check (billing_lane in ('managed', 'byok_api', 'connected_allowance')),
  state text not null default 'held' check (state in ('held', 'settled', 'released')),
  reserved_credits numeric not null check (reserved_credits >= 0),
  actual_credits numeric,
  usage jsonb,
  provider_request_ids jsonb,
  provider_request_fingerprint text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  released_at timestamptz,
  constraint bv2_model_reservations_build_owner_fkey
    foreign key (build_id, owner, project_id)
    references public.bv2_builds(id, owner, project_id) on delete cascade,
  constraint bv2_model_reservations_owner_call_unique unique (owner, build_id, call_key),
  constraint bv2_model_reservations_terminal_shape check (
    (state = 'held' and settled_at is null and released_at is null and actual_credits is null)
    or (state = 'settled' and settled_at is not null and released_at is null and actual_credits is not null)
    or (state = 'released' and released_at is not null and settled_at is null and actual_credits is null)
  )
);

create index bv2_model_reservations_active_idx
  on public.bv2_model_reservations (owner, build_id, created_at)
  where state = 'held';
create index bv2_model_reservations_owner_managed_holds_idx
  on public.bv2_model_reservations (owner, billing_lane, created_at)
  where state = 'held';
create index bv2_model_reservations_project_idx
  on public.bv2_model_reservations (owner, project_id, created_at desc);
create index bv2_model_reservations_routing_history_idx
  on public.bv2_model_reservations (owner, created_at desc)
  where state = 'settled';
create unique index bv2_model_reservations_provider_request_unique
  on public.bv2_model_reservations (provider_request_fingerprint)
  where provider_request_fingerprint is not null;

alter table public.bv2_model_reservations enable row level security;
revoke all on table public.bv2_model_reservations from public, anon, authenticated;
grant select, insert, update, delete on table public.bv2_model_reservations to service_role;

create policy bv2_model_reservations_browser_deny on public.bv2_model_reservations
  for all to anon, authenticated using (false) with check (false);

create or replace function public.reserve_bv2_model_call(
  p_owner uuid,
  p_project_id uuid,
  p_build_id uuid,
  p_call_key text,
  p_step text,
  p_provider text,
  p_model text,
  p_billing_lane text,
  p_reserved_credits numeric,
  p_ceiling_credits numeric,
  p_account_available_credits numeric default null,
  p_metadata jsonb default '{}'::jsonb
) returns public.bv2_model_reservations
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_existing public.bv2_model_reservations;
  v_row public.bv2_model_reservations;
  v_spent numeric;
  v_held numeric;
  v_owner_held numeric;
begin
  if p_reserved_credits is null or p_reserved_credits < 0
     or p_ceiling_credits is null or p_ceiling_credits <= 0 then
    raise exception 'invalid Builder V2 reservation amount or ceiling' using errcode = '22023';
  end if;
  if p_billing_lane not in ('managed', 'byok_api', 'connected_allowance') then
    raise exception 'invalid Builder V2 billing lane' using errcode = '22023';
  end if;
  if p_billing_lane = 'managed'
     and (p_account_available_credits is null or p_account_available_credits < 0) then
    raise exception 'managed Builder V2 calls require current account availability'
      using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.bv2_builds b
    where b.id = p_build_id and b.owner = p_owner and b.project_id = p_project_id
  ) then
    raise exception 'Builder V2 build is not owned by owner/project' using errcode = '42501';
  end if;

  -- Owner-wide lock prevents two concurrent builds from reserving the same remaining balance.
  perform pg_advisory_xact_lock(hashtextextended('bv2-model:' || p_owner::text, 0));

  select * into v_existing from public.bv2_model_reservations r
    where r.owner = p_owner and r.build_id = p_build_id and r.call_key = p_call_key;
  if found then
    if v_existing.project_id <> p_project_id or v_existing.step <> p_step
       or v_existing.provider <> p_provider or v_existing.model <> p_model
       or v_existing.billing_lane <> p_billing_lane
       or v_existing.reserved_credits <> p_reserved_credits then
      raise exception 'Builder V2 call key was reused with different reservation identity'
        using errcode = '23505';
    end if;
    return v_existing;
  end if;

  select coalesce(sum(r.actual_credits), 0) into v_spent
    from public.bv2_model_reservations r
    where r.owner = p_owner and r.build_id = p_build_id and r.state = 'settled';
  select coalesce(sum(r.reserved_credits), 0) into v_held
    from public.bv2_model_reservations r
    where r.owner = p_owner and r.build_id = p_build_id and r.state = 'held';

  if v_spent + v_held + p_reserved_credits > p_ceiling_credits then
    raise exception 'Builder V2 model-call ceiling exceeded: spent %, held %, requested %, ceiling %',
      v_spent, v_held, p_reserved_credits, p_ceiling_credits using errcode = 'P0001';
  end if;

  if p_billing_lane = 'managed' then
    select coalesce(sum(r.reserved_credits), 0) into v_owner_held
      from public.bv2_model_reservations r
      where r.owner = p_owner and r.billing_lane = 'managed' and r.state = 'held';
    if v_owner_held + p_reserved_credits > p_account_available_credits then
      raise exception 'Builder V2 managed account reservation exceeds availability: held %, requested %, available %',
        v_owner_held, p_reserved_credits, p_account_available_credits using errcode = 'P0001';
    end if;
  end if;

  insert into public.bv2_model_reservations (
    owner, project_id, build_id, call_key, step, provider, model, billing_lane,
    reserved_credits, metadata
  ) values (
    p_owner, p_project_id, p_build_id, p_call_key, p_step, p_provider, p_model,
    p_billing_lane, p_reserved_credits, coalesce(p_metadata, '{}'::jsonb)
  ) returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.settle_bv2_model_call(
  p_owner uuid,
  p_reservation_id uuid,
  p_actual_credits numeric,
  p_usage jsonb default '{}'::jsonb,
  p_provider_request_ids jsonb default '[]'::jsonb
) returns public.bv2_model_reservations
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.bv2_model_reservations;
  v_request_fingerprint text;
begin
  if p_actual_credits is null or p_actual_credits < 0 then
    raise exception 'invalid actual Builder V2 model cost' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_usage, '{}'::jsonb)) <> 'object'
     or jsonb_typeof(coalesce(p_provider_request_ids, '[]'::jsonb)) <> 'array' then
    raise exception 'invalid Builder V2 usage or provider request ids' using errcode = '22023';
  end if;
  select * into v_row from public.bv2_model_reservations
    where id = p_reservation_id and owner = p_owner for update;
  if not found then raise exception 'Builder V2 reservation not found' using errcode = '42501'; end if;
  if v_row.state = 'settled' then
    if v_row.actual_credits <> p_actual_credits
       or coalesce(v_row.usage, '{}'::jsonb) <> coalesce(p_usage, '{}'::jsonb)
       or coalesce(v_row.provider_request_ids, '[]'::jsonb) <> coalesce(p_provider_request_ids, '[]'::jsonb) then
      raise exception 'duplicate Builder V2 settlement disagrees with canonical telemetry'
        using errcode = '23505';
    end if;
    return v_row;
  end if;
  if v_row.state <> 'held' then
    raise exception 'released Builder V2 reservation cannot settle' using errcode = '55000';
  end if;
  if jsonb_array_length(coalesce(p_provider_request_ids, '[]'::jsonb)) > 0 then
    v_request_fingerprint := encode(extensions.digest(
      convert_to(v_row.provider || ':' || coalesce(p_provider_request_ids, '[]'::jsonb)::text, 'utf8'),
      'sha256'
    ), 'hex');
  end if;
  update public.bv2_model_reservations set
    state = 'settled', actual_credits = p_actual_credits, usage = coalesce(p_usage, '{}'::jsonb),
    provider_request_ids = coalesce(p_provider_request_ids, '[]'::jsonb),
    provider_request_fingerprint = v_request_fingerprint, settled_at = now()
  where id = v_row.id returning * into v_row;

  -- Managed usage is charged exactly once in the same transaction as reservation settlement.
  -- The reservation id is the usage-record id, so a replay can never double-charge. BYOK and
  -- connected-allowance calls retain telemetry but never enter the managed budget ledger.
  if v_row.billing_lane = 'managed' then
    insert into public.ca_usage_records (
      id, owner, run_id, provider, model, input_tokens, cached_tokens, output_tokens,
      reasoning_tokens, compute_seconds, amount_gbp, billing_source, metadata
    ) values (
      v_row.id, v_row.owner, null, v_row.provider, v_row.model,
      coalesce((p_usage->>'input')::bigint, (p_usage->>'inputTokens')::bigint, 0),
      coalesce((p_usage->>'cached')::bigint, (p_usage->>'cachedTokens')::bigint, 0),
      coalesce((p_usage->>'output')::bigint, (p_usage->>'outputTokens')::bigint, 0),
      coalesce((p_usage->>'reasoning')::bigint, (p_usage->>'reasoningTokens')::bigint, 0),
      0, 0, 'managed',
      jsonb_build_object(
        'kind', 'app_build_v2',
        'ref', 'bv2-reservation:' || v_row.id::text,
        'reservation_id', v_row.id,
        'project_id', v_row.project_id,
        'build_id', v_row.build_id,
        'step', v_row.step,
        'routing', v_row.metadata->'routing',
        'outcome', 'settled',
        'actual_credits', p_actual_credits,
        'provider_request_ids', coalesce(p_provider_request_ids, '[]'::jsonb)
      )
    );
  end if;
  return v_row;
end;
$$;

create or replace function public.release_bv2_model_call(
  p_owner uuid,
  p_reservation_id uuid
) returns public.bv2_model_reservations
language plpgsql
security invoker
set search_path = ''
as $$
declare v_row public.bv2_model_reservations;
begin
  select * into v_row from public.bv2_model_reservations
    where id = p_reservation_id and owner = p_owner for update;
  if not found then raise exception 'Builder V2 reservation not found' using errcode = '42501'; end if;
  if v_row.state = 'released' then return v_row; end if;
  if v_row.state <> 'held' then
    raise exception 'settled Builder V2 reservation cannot release' using errcode = '55000';
  end if;
  update public.bv2_model_reservations set state = 'released', released_at = now()
    where id = v_row.id returning * into v_row;
  return v_row;
end;
$$;

revoke execute on function public.reserve_bv2_model_call(uuid,uuid,uuid,text,text,text,text,text,numeric,numeric,numeric,jsonb)
  from public, anon, authenticated;
revoke execute on function public.settle_bv2_model_call(uuid,uuid,numeric,jsonb,jsonb)
  from public, anon, authenticated;
revoke execute on function public.release_bv2_model_call(uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.reserve_bv2_model_call(uuid,uuid,uuid,text,text,text,text,text,numeric,numeric,numeric,jsonb)
  to service_role;
grant execute on function public.settle_bv2_model_call(uuid,uuid,numeric,jsonb,jsonb) to service_role;
grant execute on function public.release_bv2_model_call(uuid,uuid) to service_role;

comment on table public.bv2_model_reservations is
  'Durable pre-dispatch authority for every Builder V2 model call. Duplicate call keys and settlements are idempotent; browser roles have no access.';
