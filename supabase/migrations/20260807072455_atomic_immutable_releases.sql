-- C8: immutable publish releases and a durable activation outbox.
--
-- Filesystem activation is performed by provisiond. These rows are the durable intent and the
-- compare-and-swap authority used to reconcile the unavoidable filesystem/Postgres boundary.

create table public.publish_releases (
  id                    uuid primary key,
  owner                 uuid not null references auth.users(id) on delete cascade,
  site_id               uuid not null references public.published_sites(id) on delete cascade,
  project_id            text not null,
  product_id            uuid,
  build_id              uuid,
  source_snapshot_id    uuid,
  deployment_id         uuid references public.deployments(id) on delete set null,
  artifact_hash         text not null check (artifact_hash ~ '^[0-9a-f]{64}$'),
  manifest_hash         text not null check (manifest_hash ~ '^[0-9a-f]{64}$'),
  artifact_path         text not null unique,
  artifact_bytes        bigint not null check (artifact_bytes >= 0),
  file_count            integer not null check (file_count > 0),
  immutable_manifest    jsonb not null check (jsonb_typeof(immutable_manifest) = 'object'),
  health_state          text not null default 'verified'
                          check (health_state in ('pending','verified','failed','corrupt')),
  activation_state      text not null default 'ready'
                          check (activation_state in ('building','verified','ready','activating','active','failed','superseded','rolled_back')),
  deployment_metadata   jsonb not null default '{}'::jsonb,
  custom_domain_bindings jsonb not null default '[]'::jsonb,
  previous_release_id   uuid references public.publish_releases(id) on delete set null,
  rollback_eligible     boolean not null default true,
  created_at            timestamptz not null default now(),
  verified_at           timestamptz,
  activated_at          timestamptz,
  superseded_at         timestamptz,
  failed_at             timestamptz,
  failure_reason        text
);

alter table public.published_sites
  add column active_publish_release_id uuid references public.publish_releases(id) on delete set null,
  add column activation_version bigint not null default 0 check (activation_version >= 0);

create table public.publish_activation_intents (
  id                    uuid primary key default gen_random_uuid(),
  owner                 uuid not null references auth.users(id) on delete cascade,
  site_id               uuid not null references public.published_sites(id) on delete cascade,
  project_id            text not null,
  operation             text not null check (operation in ('activate','rollback','unpublish')),
  desired_release_id    uuid references public.publish_releases(id) on delete restrict,
  activation_deployment_id uuid references public.deployments(id) on delete set null,
  previous_release_id   uuid references public.publish_releases(id) on delete set null,
  expected_version      bigint not null check (expected_version >= 0),
  slug                  text not null,
  state                 text not null default 'prepared'
                          check (state in ('prepared','pointer_switched','retrying','completed','failed','rolled_back','stuck')),
  observed_release_id   uuid,
  attempts              integer not null default 0 check (attempts >= 0),
  max_attempts          integer not null default 8 check (max_attempts between 1 and 100),
  next_attempt_at       timestamptz not null default now(),
  lease_owner           text,
  lease_expires_at      timestamptz,
  last_error            text,
  created_at            timestamptz not null default now(),
  pointer_switched_at   timestamptz,
  completed_at          timestamptz,
  updated_at            timestamptz not null default now(),
  check ((operation = 'unpublish' and desired_release_id is null)
      or (operation in ('activate','rollback') and desired_release_id is not null))
);

create unique index publish_releases_one_active_per_site
  on public.publish_releases (site_id) where activation_state = 'active';
create index publish_releases_owner_project_created_idx
  on public.publish_releases (owner, project_id, created_at desc);
create index publish_releases_site_created_idx
  on public.publish_releases (site_id, created_at desc);
create index publish_releases_previous_idx on public.publish_releases (previous_release_id);
create index publish_releases_deployment_idx on public.publish_releases (deployment_id);
create unique index publish_activation_one_pending_per_site
  on public.publish_activation_intents (site_id)
  where state in ('prepared','pointer_switched','retrying','stuck');
create index publish_activation_reconcile_idx
  on public.publish_activation_intents (next_attempt_at, created_at)
  where state in ('prepared','pointer_switched','retrying');
create index publish_activation_owner_project_idx
  on public.publish_activation_intents (owner, project_id, created_at desc);

alter table public.publish_releases enable row level security;
alter table public.publish_activation_intents enable row level security;

revoke all on table public.publish_releases, public.publish_activation_intents
  from public, anon, authenticated;
grant all privileges on table public.publish_releases, public.publish_activation_intents
  to service_role;

create policy publish_releases_browser_deny on public.publish_releases
  as restrictive for all to anon, authenticated using (false) with check (false);
create policy publish_activation_intents_browser_deny on public.publish_activation_intents
  as restrictive for all to anon, authenticated using (false) with check (false);

create or replace function public.publish_release_immutable_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.health_state = 'verified' and (
       new.owner is distinct from old.owner
    or new.site_id is distinct from old.site_id
    or new.project_id is distinct from old.project_id
    or new.product_id is distinct from old.product_id
    or new.build_id is distinct from old.build_id
    or new.source_snapshot_id is distinct from old.source_snapshot_id
    or new.deployment_id is distinct from old.deployment_id
    or new.artifact_hash is distinct from old.artifact_hash
    or new.manifest_hash is distinct from old.manifest_hash
    or new.artifact_path is distinct from old.artifact_path
    or new.artifact_bytes is distinct from old.artifact_bytes
    or new.file_count is distinct from old.file_count
    or new.immutable_manifest is distinct from old.immutable_manifest
    or new.custom_domain_bindings is distinct from old.custom_domain_bindings
  ) then
    raise exception 'verified publish release % is immutable', old.id using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger publish_release_immutable
  before update on public.publish_releases
  for each row execute function public.publish_release_immutable_guard();

create or replace function public.register_verified_publish_release(
  p_release_id uuid,
  p_owner uuid,
  p_project_id text,
  p_product_id uuid,
  p_slug text,
  p_url text,
  p_build_id uuid,
  p_snapshot_id uuid,
  p_deployment_id uuid,
  p_artifact_hash text,
  p_manifest_hash text,
  p_artifact_path text,
  p_artifact_bytes bigint,
  p_file_count integer,
  p_manifest jsonb,
  p_domains jsonb default '[]'::jsonb,
  p_metadata jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_site public.published_sites%rowtype;
  v_existing public.publish_releases%rowtype;
begin
  if current_user <> 'service_role' then raise exception 'service role required' using errcode = '42501'; end if;
  if not exists (select 1 from public.projects where id::text = p_project_id and owner = p_owner) then
    raise exception 'project ownership mismatch' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_owner::text || ':' || lower(p_slug), 0));

  select * into v_existing from public.publish_releases where id = p_release_id;
  if found then
    if v_existing.owner <> p_owner or v_existing.project_id <> p_project_id
       or v_existing.artifact_hash <> p_artifact_hash or v_existing.manifest_hash <> p_manifest_hash then
      raise exception 'release id conflicts with different immutable content' using errcode = '23505';
    end if;
    select * into v_site from public.published_sites where id = v_existing.site_id;
    return jsonb_build_object('release_id', v_existing.id, 'site_id', v_site.id,
      'activation_version', v_site.activation_version, 'active_release_id', v_site.active_publish_release_id);
  end if;

  select * into v_site
    from public.published_sites
   where owner = p_owner
     and (project_id = p_project_id or (p_product_id is not null and product_id = p_product_id))
   order by (project_id = p_project_id) desc, updated_at desc
   limit 1 for update;

  if not found then
    if exists (select 1 from public.published_sites where slug = lower(p_slug)) then
      raise exception 'slug is owned by another site' using errcode = '23505';
    end if;
    insert into public.published_sites (owner, project_id, product_id, slug, url, unpublished_at)
      values (p_owner, p_project_id, p_product_id, lower(p_slug), p_url, now()) returning * into v_site;
  elsif v_site.slug <> lower(p_slug) then
    raise exception 'site slug changed during release registration' using errcode = '40001';
  end if;

  insert into public.publish_releases (
    id, owner, site_id, project_id, product_id, build_id, source_snapshot_id, deployment_id,
    artifact_hash, manifest_hash, artifact_path, artifact_bytes, file_count, immutable_manifest,
    health_state, activation_state, custom_domain_bindings, deployment_metadata, previous_release_id,
    rollback_eligible, verified_at
  ) values (
    p_release_id, p_owner, v_site.id, p_project_id, p_product_id, p_build_id, p_snapshot_id, p_deployment_id,
    p_artifact_hash, p_manifest_hash, p_artifact_path, p_artifact_bytes, p_file_count, p_manifest,
    'verified', 'ready', coalesce(p_domains, '[]'::jsonb), coalesce(p_metadata, '{}'::jsonb),
    v_site.active_publish_release_id, true, now()
  );

  return jsonb_build_object('release_id', p_release_id, 'site_id', v_site.id,
    'activation_version', v_site.activation_version, 'active_release_id', v_site.active_publish_release_id);
end;
$$;

create or replace function public.request_publish_activation(
  p_owner uuid,
  p_release_id uuid,
  p_expected_version bigint,
  p_operation text default 'activate',
  p_activation_deployment_id uuid default null
) returns public.publish_activation_intents
language plpgsql security invoker set search_path = '' as $$
declare
  v_release public.publish_releases%rowtype;
  v_site public.published_sites%rowtype;
  v_intent public.publish_activation_intents%rowtype;
begin
  if current_user <> 'service_role' then raise exception 'service role required' using errcode = '42501'; end if;
  if p_operation not in ('activate','rollback') then raise exception 'invalid activation operation' using errcode = '22023'; end if;
  select * into v_release from public.publish_releases where id = p_release_id and owner = p_owner for update;
  if not found then raise exception 'release not found' using errcode = 'P0002'; end if;
  if v_release.health_state <> 'verified' or v_release.activation_state not in ('ready','superseded','rolled_back')
     or not v_release.rollback_eligible then
    raise exception 'release is not activation eligible' using errcode = '55000';
  end if;
  if p_activation_deployment_id is not null and not exists (
    select 1 from public.deployments d
     where d.id = p_activation_deployment_id and d.owner = p_owner
       and (d.project_id = v_release.project_id
         or (v_release.product_id is not null and d.product_id = v_release.product_id))
  ) then
    raise exception 'activation deployment ownership mismatch' using errcode = '42501';
  end if;
  select * into v_site from public.published_sites where id = v_release.site_id and owner = p_owner for update;
  if v_site.activation_version <> p_expected_version then raise exception 'stale activation version' using errcode = '40001'; end if;

  insert into public.publish_activation_intents (
    owner, site_id, project_id, operation, desired_release_id, activation_deployment_id, previous_release_id,
    expected_version, slug, state
  ) values (
    p_owner, v_site.id, v_release.project_id, p_operation, v_release.id, p_activation_deployment_id,
    v_site.active_publish_release_id, v_site.activation_version, v_site.slug, 'prepared'
  ) returning * into v_intent;
  update public.publish_releases set activation_state = 'activating' where id = v_release.id;
  return v_intent;
end;
$$;

create or replace function public.request_publish_unpublish(
  p_owner uuid,
  p_project_id text,
  p_expected_version bigint
) returns public.publish_activation_intents
language plpgsql security invoker set search_path = '' as $$
declare
  v_site public.published_sites%rowtype;
  v_intent public.publish_activation_intents%rowtype;
begin
  if current_user <> 'service_role' then raise exception 'service role required' using errcode = '42501'; end if;
  select * into v_site from public.published_sites
    where owner = p_owner and project_id = p_project_id for update;
  if not found then raise exception 'site not found' using errcode = 'P0002'; end if;
  if v_site.activation_version <> p_expected_version then raise exception 'stale activation version' using errcode = '40001'; end if;
  insert into public.publish_activation_intents (
    owner, site_id, project_id, operation, desired_release_id, previous_release_id,
    expected_version, slug, state
  ) values (
    p_owner, v_site.id, p_project_id, 'unpublish', null, v_site.active_publish_release_id,
    v_site.activation_version, v_site.slug, 'prepared'
  ) returning * into v_intent;
  return v_intent;
end;
$$;

create or replace function public.mark_publish_pointer_switched(
  p_intent_id uuid,
  p_observed_release_id uuid
) returns public.publish_activation_intents
language plpgsql security invoker set search_path = '' as $$
declare v_intent public.publish_activation_intents%rowtype;
begin
  if current_user <> 'service_role' then raise exception 'service role required' using errcode = '42501'; end if;
  update public.publish_activation_intents
     set state = 'pointer_switched', observed_release_id = p_observed_release_id,
         pointer_switched_at = coalesce(pointer_switched_at, now()), attempts = attempts + 1,
         lease_owner = null, lease_expires_at = null, updated_at = now()
   where id = p_intent_id
     and state in ('prepared','retrying','pointer_switched')
     and (observed_release_id is null or observed_release_id is not distinct from p_observed_release_id)
  returning * into v_intent;
  if not found then raise exception 'intent observation conflicts' using errcode = '40001'; end if;
  return v_intent;
end;
$$;

create or replace function public.complete_publish_activation(p_intent_id uuid)
returns public.publish_activation_intents
language plpgsql security invoker set search_path = '' as $$
declare
  v_intent public.publish_activation_intents%rowtype;
  v_site public.published_sites%rowtype;
  v_release public.publish_releases%rowtype;
  v_retired text;
begin
  if current_user <> 'service_role' then raise exception 'service role required' using errcode = '42501'; end if;
  select * into v_intent from public.publish_activation_intents where id = p_intent_id for update;
  if not found then raise exception 'intent not found' using errcode = 'P0002'; end if;
  if v_intent.state = 'completed' then return v_intent; end if;
  if v_intent.state <> 'pointer_switched' then raise exception 'pointer switch is not proven' using errcode = '55000'; end if;
  if v_intent.observed_release_id is distinct from v_intent.desired_release_id then
    raise exception 'filesystem pointer does not match intent' using errcode = '55000';
  end if;
  select * into v_site from public.published_sites where id = v_intent.site_id for update;
  if v_site.activation_version <> v_intent.expected_version then raise exception 'stale activation version' using errcode = '40001'; end if;

  if v_intent.operation = 'unpublish' then
    if v_site.active_publish_release_id is not null then
      update public.publish_releases set activation_state = 'superseded', superseded_at = now()
       where id = v_site.active_publish_release_id and activation_state = 'active';
    end if;
    update public.published_sites
       set active_publish_release_id = null, activation_version = activation_version + 1,
           unpublished_at = now(), updated_at = now()
     where id = v_site.id;
  else
    select * into v_release from public.publish_releases where id = v_intent.desired_release_id for update;
    if v_release.health_state <> 'verified' then raise exception 'release health is not verified' using errcode = '55000'; end if;
    v_retired := case when v_intent.operation = 'rollback' then 'rolled_back' else 'superseded' end;
    if v_site.active_publish_release_id is not null and v_site.active_publish_release_id <> v_release.id then
      update public.publish_releases
         set activation_state = v_retired, superseded_at = now()
       where id = v_site.active_publish_release_id;
      update public.deployments
         set status = v_retired, updated_at = now()
       where id = (select deployment_id from public.publish_releases where id = v_site.active_publish_release_id)
         and status = 'live';
    end if;
    update public.publish_releases
       set activation_state = 'active', activated_at = now(), failed_at = null, failure_reason = null
     where id = v_release.id;
    update public.published_sites
       set project_id = v_release.project_id, product_id = v_release.product_id,
           active_publish_release_id = v_release.id, activation_version = activation_version + 1,
           unpublished_at = null, updated_at = now()
     where id = v_site.id;
    update public.custom_domains
       set project_id = v_release.project_id, slug = v_site.slug, updated_at = now()
     where owner = v_release.owner and project_id = v_site.project_id;
    if coalesce(v_intent.activation_deployment_id, v_release.deployment_id) is not null then
      update public.deployments
         set status = 'live', url = 'https://' || v_site.slug || '.app.thrallo.com/', slug = v_site.slug,
             deployed_at = now(), failure_reason = null, updated_at = now()
       where id = coalesce(v_intent.activation_deployment_id, v_release.deployment_id);
    end if;
  end if;

  update public.publish_activation_intents
     set state = 'completed', completed_at = now(), updated_at = now(), last_error = null
   where id = v_intent.id returning * into v_intent;
  return v_intent;
end;
$$;

create or replace function public.fail_publish_activation(
  p_intent_id uuid,
  p_error text,
  p_terminal boolean default false
) returns public.publish_activation_intents
language plpgsql security invoker set search_path = '' as $$
declare v_intent public.publish_activation_intents%rowtype;
begin
  if current_user <> 'service_role' then raise exception 'service role required' using errcode = '42501'; end if;
  update public.publish_activation_intents
     set attempts = attempts + 1,
         state = case when p_terminal or attempts + 1 >= max_attempts then 'stuck' else 'retrying' end,
         last_error = left(coalesce(p_error, 'activation failed'), 2000),
         next_attempt_at = now() + make_interval(secs => least(300, (2 ^ least(attempts, 8))::integer)),
         lease_owner = null, lease_expires_at = null, updated_at = now()
   where id = p_intent_id and state <> 'completed' returning * into v_intent;
  if not found then raise exception 'intent not found or already complete' using errcode = 'P0002'; end if;
  return v_intent;
end;
$$;

create or replace function public.lease_publish_activation_intents(
  p_worker text,
  p_limit integer default 10,
  p_lease_seconds integer default 30
) returns setof public.publish_activation_intents
language plpgsql security invoker set search_path = '' as $$
begin
  if current_user <> 'service_role' then raise exception 'service role required' using errcode = '42501'; end if;
  return query
  with candidates as (
    select id from public.publish_activation_intents
     where state in ('prepared','pointer_switched','retrying')
       and next_attempt_at <= now()
       and (lease_expires_at is null or lease_expires_at < now())
     order by created_at
     for update skip locked
     limit greatest(1, least(coalesce(p_limit, 10), 100))
  )
  update public.publish_activation_intents i
     set lease_owner = left(p_worker, 200),
         lease_expires_at = now() + make_interval(secs => greatest(5, least(p_lease_seconds, 300))),
         updated_at = now()
    from candidates c where i.id = c.id
  returning i.*;
end;
$$;

create or replace function public.mark_publish_activation_rolled_back(
  p_intent_id uuid,
  p_observed_release_id uuid,
  p_reason text
) returns public.publish_activation_intents
language plpgsql security invoker set search_path = '' as $$
declare v_intent public.publish_activation_intents%rowtype;
begin
  if current_user <> 'service_role' then raise exception 'service role required' using errcode = '42501'; end if;
  update public.publish_activation_intents
     set state = 'rolled_back', observed_release_id = p_observed_release_id,
         last_error = left(coalesce(p_reason, 'activation reverted'), 2000), completed_at = now(),
         lease_owner = null, lease_expires_at = null, updated_at = now()
   where id = p_intent_id and state <> 'completed' returning * into v_intent;
  if not found then raise exception 'intent not found or already complete' using errcode = 'P0002'; end if;
  update public.publish_releases set activation_state = 'ready'
   where id = v_intent.desired_release_id and activation_state = 'activating';
  return v_intent;
end;
$$;

revoke all on function public.register_verified_publish_release(uuid,uuid,text,uuid,text,text,uuid,uuid,uuid,text,text,text,bigint,integer,jsonb,jsonb,jsonb) from public, anon, authenticated;
revoke all on function public.request_publish_activation(uuid,uuid,bigint,text,uuid) from public, anon, authenticated;
revoke all on function public.request_publish_unpublish(uuid,text,bigint) from public, anon, authenticated;
revoke all on function public.mark_publish_pointer_switched(uuid,uuid) from public, anon, authenticated;
revoke all on function public.complete_publish_activation(uuid) from public, anon, authenticated;
revoke all on function public.fail_publish_activation(uuid,text,boolean) from public, anon, authenticated;
revoke all on function public.lease_publish_activation_intents(text,integer,integer) from public, anon, authenticated;
revoke all on function public.mark_publish_activation_rolled_back(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.register_verified_publish_release(uuid,uuid,text,uuid,text,text,uuid,uuid,uuid,text,text,text,bigint,integer,jsonb,jsonb,jsonb) to service_role;
grant execute on function public.request_publish_activation(uuid,uuid,bigint,text,uuid) to service_role;
grant execute on function public.request_publish_unpublish(uuid,text,bigint) to service_role;
grant execute on function public.mark_publish_pointer_switched(uuid,uuid) to service_role;
grant execute on function public.complete_publish_activation(uuid) to service_role;
grant execute on function public.fail_publish_activation(uuid,text,boolean) to service_role;
grant execute on function public.lease_publish_activation_intents(text,integer,integer) to service_role;
grant execute on function public.mark_publish_activation_rolled_back(uuid,uuid,text) to service_role;

comment on table public.publish_releases is
  'Immutable verified publish artifacts. Artifact identity and manifest cannot change after verification; activation state may advance through the outbox.';
comment on table public.publish_activation_intents is
  'Durable activation/unpublish outbox. expected_version is the site CAS token; observed_release_id is provisiond filesystem evidence.';

-- Forward repair: leave the tables/RPCs installed and reconcile any non-terminal intent by
-- observing the slug pointer before completing or reverting it. Never delete an intent to repair.
-- Rollback (only while the dark flag is disabled and no release was activated): drop the six RPCs,
-- trigger/function, intent table, published_sites columns, then release table. If any intent or
-- active_publish_release_id exists, forward repair is mandatory; destructive rollback is unsafe.
