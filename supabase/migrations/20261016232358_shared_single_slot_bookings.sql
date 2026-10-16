-- Opt-in single-place reservations. Contact records stay owner-scoped in entities;
-- only an aggregate availability count crosses visitor boundaries. Existing apps/rows
-- are unchanged until their booking capability explicitly selects shared reservations.
create table public.app_booking_reservations (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null references public.projects(id) on delete cascade,
  owner uuid not null references auth.users(id) on delete cascade,
  entity_type text not null check (length(entity_type) between 1 and 80),
  booking_date date not null,
  slot_id text not null check (length(slot_id) between 1 and 120),
  entity_id uuid not null unique references public.entities(id) on delete cascade,
  request_id uuid not null,
  created_at timestamptz not null default now(),
  released_at timestamptz,
  unique (app_id, owner, request_id)
);
create unique index app_booking_one_active_slot on public.app_booking_reservations
  (app_id, entity_type, booking_date, slot_id) where released_at is null;
create index app_booking_owner_lookup on public.app_booking_reservations (owner, app_id);
alter table public.app_booking_reservations enable row level security;
revoke all on public.app_booking_reservations from public, anon, authenticated;
grant all on public.app_booking_reservations to service_role;

-- Successful retries may use a fresh client key after a reload. Persist that alias as well,
-- so reusing it with different slot inputs cannot create a second booking later.
create table public.app_booking_request_keys (
  app_id uuid not null references public.projects(id) on delete cascade,
  owner uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  reservation_id uuid not null references public.app_booking_reservations(id) on delete cascade,
  primary key (app_id, owner, request_id)
);
create index app_booking_request_reservation on public.app_booking_request_keys(reservation_id);
alter table public.app_booking_request_keys enable row level security;
revoke all on public.app_booking_request_keys from public, anon, authenticated;
grant all on public.app_booking_request_keys to service_role;

create function public.app_booking_actor(p_app_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := auth.uid();
begin
  if v_actor is null or not exists (
    select 1 from public.app_users where app_id = p_app_id::text and auth_user_id = v_actor and status = 'active'
  ) then
    raise exception 'App visitor authentication required' using errcode = '42501';
  end if;
  return v_actor;
end; $$;
revoke all on function public.app_booking_actor(uuid) from public, anon, authenticated;

create function public.app_booking_reserve(
  p_app_id uuid, p_entity_type text, p_date date, p_slot_id text,
  p_request_id uuid, p_values jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := public.app_booking_actor(p_app_id);
  v_claim public.app_booking_reservations;
  v_row public.entities;
  v_email text := lower(trim(p_values->>'email'));
  v_name text := trim(p_values->>'name');
begin
  if p_request_id is null or p_date is null or p_date <= current_date
    or p_entity_type is null or length(p_entity_type) not between 1 and 80
    or p_slot_id is null or length(p_slot_id) not between 1 and 120
    or jsonb_typeof(p_values) is distinct from 'object' or octet_length(p_values::text) > 20000
    or coalesce(v_name, '') = '' or length(v_name) > 300
    or coalesce(v_email, '') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or length(v_email) > 320 then
    return jsonb_build_object('result', 'invalid', 'record', null);
  end if;
  -- Serialize exact retries independently of the slot lock. A reused idempotency key
  -- with different slot inputs is refused instead of silently reserving a second slot.
  perform pg_advisory_xact_lock(hashtextextended(p_app_id::text || ':' || v_actor::text || ':' || p_request_id::text, 0));
  select c.* into v_claim from public.app_booking_request_keys r
    join public.app_booking_reservations c on c.id = r.reservation_id
    where r.app_id = p_app_id and r.owner = v_actor and r.request_id = p_request_id
      and c.app_id = p_app_id and c.owner = v_actor;
  if found then
    if v_claim.entity_type <> p_entity_type or v_claim.booking_date <> p_date or v_claim.slot_id <> p_slot_id
      or v_claim.released_at is not null then
      return jsonb_build_object('result', 'invalid', 'record', null);
    end if;
    select * into v_row from public.entities where id = v_claim.entity_id and owner = v_actor;
    return jsonb_build_object('result', 'ok', 'record', to_jsonb(v_row));
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_app_id::text || ':' || p_entity_type || ':' || p_date::text || ':' || p_slot_id, 1));
  select * into v_claim from public.app_booking_reservations where app_id = p_app_id
    and entity_type = p_entity_type and booking_date = p_date and slot_id = p_slot_id and released_at is null;
  if found then
    -- Recover a lost response even after a browser reload, without exposing another visitor's row.
    if v_claim.owner = v_actor then
      select * into v_row from public.entities where id = v_claim.entity_id and owner = v_actor;
      if v_row.data->>'email' = v_email and v_row.data->>'name' = v_name then
        insert into public.app_booking_request_keys(app_id, owner, request_id, reservation_id)
          values (p_app_id, v_actor, p_request_id, v_claim.id);
        return jsonb_build_object('result', 'ok', 'record', to_jsonb(v_row));
      end if;
    end if;
    return jsonb_build_object('result', 'over_capacity', 'record', null);
  end if;
  insert into public.entities(owner, app_id, type, data) values (
    v_actor, p_app_id::text, p_entity_type,
    p_values || jsonb_build_object('date', p_date::text, 'slotId', p_slot_id, 'email', v_email,
      'name', v_name, 'partySize', 1, 'status', 'Active',
      'reference', 'BK-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)),
      'createdAt', now())
  ) returning * into v_row;
  insert into public.app_booking_reservations(app_id, owner, entity_type, booking_date, slot_id, entity_id, request_id)
    values (p_app_id, v_actor, p_entity_type, p_date, p_slot_id, v_row.id, p_request_id) returning * into v_claim;
  insert into public.app_booking_request_keys(app_id, owner, request_id, reservation_id)
    values (p_app_id, v_actor, p_request_id, v_claim.id);
  return jsonb_build_object('result', 'ok', 'record', to_jsonb(v_row));
end; $$;

create function public.app_booking_remaining(p_app_id uuid, p_entity_type text, p_date date, p_slot_id text)
returns integer language plpgsql security definer set search_path = '' as $$
begin
  perform public.app_booking_actor(p_app_id);
  return case when exists (select 1 from public.app_booking_reservations
    where app_id = p_app_id and entity_type = p_entity_type and booking_date = p_date
      and slot_id = p_slot_id and released_at is null) then 0 else 1 end;
end; $$;

create function public.app_booking_cancel(p_app_id uuid, p_entity_type text, p_reference text, p_email text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := public.app_booking_actor(p_app_id);
  v_claim public.app_booking_reservations;
  v_row public.entities;
begin
  select c.* into v_claim from public.app_booking_reservations c join public.entities e on e.id = c.entity_id
    where c.app_id = p_app_id and c.entity_type = p_entity_type and c.owner = v_actor
      and e.owner = v_actor and e.data->>'reference' = upper(trim(p_reference))
      and e.data->>'email' = lower(trim(p_email))
    for update of c;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found', 'record', null); end if;
  if v_claim.released_at is not null then
    select * into v_row from public.entities where id = v_claim.entity_id and owner = v_actor;
    return jsonb_build_object('ok', false, 'reason', 'already_cancelled', 'record', to_jsonb(v_row));
  end if;
  update public.entities set data = data || jsonb_build_object('status', 'Cancelled', 'cancelledAt', now())
    where id = v_claim.entity_id and owner = v_actor returning * into v_row;
  update public.app_booking_reservations set released_at = now() where id = v_claim.id;
  return jsonb_build_object('ok', true, 'record', to_jsonb(v_row));
end; $$;

revoke all on function public.app_booking_reserve(uuid,text,date,text,uuid,jsonb) from public, anon, authenticated;
revoke all on function public.app_booking_remaining(uuid,text,date,text) from public, anon, authenticated;
revoke all on function public.app_booking_cancel(uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.app_booking_reserve(uuid,text,date,text,uuid,jsonb) to authenticated, service_role;
grant execute on function public.app_booking_remaining(uuid,text,date,text) to authenticated, service_role;
grant execute on function public.app_booking_cancel(uuid,text,text,text) to authenticated, service_role;
