-- Package 14S: one durable repair-dispatch authority per Builder V2 build.
-- A held reservation owns a repair slot, a settled reservation consumes it, and a released
-- pre-dispatch reservation returns it. Core/contract calls never enter this count.

alter table public.bv2_builds
  add column max_repair_dispatches integer not null default 2
    check (max_repair_dispatches between 0 and 10);

comment on column public.bv2_builds.max_repair_dispatches is
  'Build-level provider repair-call limit. Enforced atomically by reserve_bv2_model_call_v2.';

create or replace function public.reserve_bv2_model_call_v2(
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
) returns jsonb
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
  v_max_repairs integer;
  v_repairs_dispatched integer;
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

  -- One owner lock serialises budget and repair-slot decisions across workers and retries.
  perform pg_advisory_xact_lock(hashtextextended('bv2-model:' || p_owner::text, 0));
  select b.max_repair_dispatches into v_max_repairs
    from public.bv2_builds b
    where b.id = p_build_id and b.owner = p_owner and b.project_id = p_project_id
    for update;
  if not found then
    raise exception 'Builder V2 build is not owned by owner/project' using errcode = '42501';
  end if;

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
    if v_existing.state <> 'released' then
      select count(*)::integer into v_repairs_dispatched
        from public.bv2_model_reservations r
        where r.owner = p_owner and r.build_id = p_build_id and r.step = 'repair'
          and r.state in ('held', 'settled');
      return jsonb_build_object('reservation', to_jsonb(v_existing), 'acquired', false,
        'repair_dispatch_count', v_repairs_dispatched, 'max_repairs', v_max_repairs);
    end if;
  end if;

  select count(*)::integer into v_repairs_dispatched
    from public.bv2_model_reservations r
    where r.owner = p_owner and r.build_id = p_build_id and r.step = 'repair'
      and r.state in ('held', 'settled');
  if p_step = 'repair' and v_repairs_dispatched >= v_max_repairs then
    raise exception 'Builder V2 repair provider-call limit reached'
      using errcode = 'P14R1',
        detail = jsonb_build_object('code', 'repair_limit_reached',
          'repairsDispatched', v_repairs_dispatched, 'maxRepairs', v_max_repairs)::text;
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

  if v_existing.id is not null then
    update public.bv2_model_reservations set
      state = 'held', released_at = null,
      metadata = coalesce(p_metadata, '{}'::jsonb)
        || jsonb_build_object('reacquired_at', now())
    where id = v_existing.id returning * into v_row;
  else
    insert into public.bv2_model_reservations (
      owner, project_id, build_id, call_key, step, provider, model, billing_lane,
      reserved_credits, metadata
    ) values (
      p_owner, p_project_id, p_build_id, p_call_key, p_step, p_provider, p_model,
      p_billing_lane, p_reserved_credits, coalesce(p_metadata, '{}'::jsonb)
    ) returning * into v_row;
  end if;

  if p_step = 'repair' then v_repairs_dispatched := v_repairs_dispatched + 1; end if;
  return jsonb_build_object('reservation', to_jsonb(v_row), 'acquired', true,
    'repair_dispatch_count', v_repairs_dispatched, 'max_repairs', v_max_repairs);
end;
$$;

revoke execute on function public.reserve_bv2_model_call(
  uuid,uuid,uuid,text,text,text,text,text,numeric,numeric,numeric,jsonb
) from service_role;
revoke execute on function public.reserve_bv2_model_call_v2(
  uuid,uuid,uuid,text,text,text,text,text,numeric,numeric,numeric,jsonb
) from public, anon, authenticated;
grant execute on function public.reserve_bv2_model_call_v2(
  uuid,uuid,uuid,text,text,text,text,text,numeric,numeric,numeric,jsonb
) to service_role;

comment on function public.reserve_bv2_model_call_v2(
  uuid,uuid,uuid,text,text,text,text,text,numeric,numeric,numeric,jsonb
) is 'Atomic model reservation and canonical build-level repair-dispatch limit authority.';

-- Forward repair: deploy the matching runtime before enabling V2 dispatch. Rollback while V2 is
-- dark by re-granting the original reserve RPC, dropping this RPC, then dropping the new column.
