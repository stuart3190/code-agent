-- C8 forward repair: expected optimistic-concurrency failures must not use PostgreSQL's
-- transaction-rollback class (40*). PostgREST and clients legitimately treat 40* as retryable;
-- production proved that using 40001 for an ordinary stale activation version can exhaust the
-- PostgREST pool and surface as PGRST003/504.
--
-- PT412 is PostgREST's explicit application Precondition Failed representation. It produces a
-- deterministic error.code of PT412 and HTTP 412, which is not in supabase-js's transient retry
-- set. Genuine PostgreSQL serialization failures remain 40001 and deadlocks remain 40P01.
--
-- This migration replaces only the five C8 functions whose expected business/precondition
-- conflicts used 40001. Ownership, validation, state-machine, CAS and idempotency behavior are
-- otherwise byte-for-byte equivalent to the latest applied definitions.
--
-- Forward repair: re-run this migration; CREATE OR REPLACE and grants are transactional and
-- idempotent. Rollback: restore these definitions from 20260807072455 and
-- 20260807174720 only after draining atomic publish intake. Reverting restores the production
-- pool-exhaustion defect, so forward repair is preferred. No table data or ledger repair is needed.

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
    raise exception 'site slug changed during release registration' using errcode = 'PT412';
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
  v_constraint text;
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
  if v_site.activation_version <> p_expected_version then raise exception 'stale activation version' using errcode = 'PT412'; end if;

  begin
    insert into public.publish_activation_intents (
      owner, site_id, project_id, operation, desired_release_id, activation_deployment_id, previous_release_id,
      expected_version, slug, state
    ) values (
      p_owner, v_site.id, v_release.project_id, p_operation, v_release.id, p_activation_deployment_id,
      v_site.active_publish_release_id, v_site.activation_version, v_site.slug, 'prepared'
    ) returning * into v_intent;
  exception when unique_violation then
    get stacked diagnostics v_constraint = CONSTRAINT_NAME;
    if v_constraint = 'publish_activation_one_pending_per_site' then
      raise exception 'publish activation already pending for site' using errcode = 'PT412';
    end if;
    raise;
  end;
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
  v_constraint text;
begin
  if current_user <> 'service_role' then raise exception 'service role required' using errcode = '42501'; end if;
  select * into v_site from public.published_sites
    where owner = p_owner and project_id = p_project_id for update;
  if not found then raise exception 'site not found' using errcode = 'P0002'; end if;
  if v_site.activation_version <> p_expected_version then raise exception 'stale activation version' using errcode = 'PT412'; end if;
  begin
    insert into public.publish_activation_intents (
      owner, site_id, project_id, operation, desired_release_id, previous_release_id,
      expected_version, slug, state
    ) values (
      p_owner, v_site.id, p_project_id, 'unpublish', null, v_site.active_publish_release_id,
      v_site.activation_version, v_site.slug, 'prepared'
    ) returning * into v_intent;
  exception when unique_violation then
    get stacked diagnostics v_constraint = CONSTRAINT_NAME;
    if v_constraint = 'publish_activation_one_pending_per_site' then
      raise exception 'publish activation already pending for site' using errcode = 'PT412';
    end if;
    raise;
  end;
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
  if not found then raise exception 'intent observation conflicts' using errcode = 'PT412'; end if;
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
  v_active_release public.publish_releases%rowtype;
  v_live_deployment public.deployments%rowtype;
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
  select * into v_site
    from public.published_sites
   where id = v_intent.site_id
     and owner = v_intent.owner
   for update;
  if not found then raise exception 'site ownership mismatch' using errcode = '42501'; end if;
  if v_site.activation_version <> v_intent.expected_version then raise exception 'stale activation version' using errcode = 'PT412'; end if;

  if v_intent.operation = 'unpublish' then
    if v_site.project_id is distinct from v_intent.project_id then
      raise exception 'unpublish project mismatch' using errcode = '42501';
    end if;
    if v_site.active_publish_release_id is null then
      raise exception 'site is already unpublished' using errcode = '55000';
    end if;

    select * into v_active_release
      from public.publish_releases
     where id = v_site.active_publish_release_id
       and owner = v_intent.owner
       and site_id = v_site.id
     for update;
    if not found then raise exception 'active release ownership mismatch' using errcode = '42501'; end if;

    select * into v_live_deployment
      from public.deployments
     where owner = v_intent.owner
       and status = 'live'
       and public.deployment_scope(product_id, project_id)
           = public.deployment_scope(v_site.product_id, v_site.project_id)
     for update;

    if found then
      update public.deployments
         set status = 'superseded', updated_at = now()
       where id = v_live_deployment.id
         and owner = v_intent.owner
         and status = 'live';
    end if;

    update public.publish_releases
       set activation_state = 'superseded', superseded_at = now()
     where id = v_active_release.id
       and owner = v_intent.owner
       and activation_state = 'active';

    update public.published_sites
       set active_publish_release_id = null, activation_version = activation_version + 1,
           unpublished_at = now(), updated_at = now()
     where id = v_site.id
       and owner = v_intent.owner;
  else
    select * into v_release
      from public.publish_releases
     where id = v_intent.desired_release_id
       and owner = v_intent.owner
       and site_id = v_site.id
     for update;
    if not found then raise exception 'release ownership mismatch' using errcode = '42501'; end if;
    if v_release.health_state <> 'verified' then raise exception 'release health is not verified' using errcode = '55000'; end if;
    v_retired := case when v_intent.operation = 'rollback' then 'rolled_back' else 'superseded' end;
    if v_site.active_publish_release_id is not null and v_site.active_publish_release_id <> v_release.id then
      select * into v_active_release
        from public.publish_releases
       where id = v_site.active_publish_release_id
         and owner = v_intent.owner
         and site_id = v_site.id
       for update;
      if not found then raise exception 'active release ownership mismatch' using errcode = '42501'; end if;

      select * into v_live_deployment
        from public.deployments
       where owner = v_intent.owner
         and status = 'live'
         and public.deployment_scope(product_id, project_id)
             = public.deployment_scope(v_site.product_id, v_site.project_id)
       for update;

      update public.publish_releases
         set activation_state = v_retired, superseded_at = now()
       where id = v_active_release.id
         and owner = v_intent.owner;
      if v_live_deployment.id is not null then
        update public.deployments
           set status = v_retired, updated_at = now()
         where id = v_live_deployment.id
           and owner = v_intent.owner
           and status = 'live';
      end if;
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
       where id = coalesce(v_intent.activation_deployment_id, v_release.deployment_id)
         and owner = v_intent.owner;
    end if;
  end if;

  update public.publish_activation_intents
     set state = 'completed', completed_at = now(), updated_at = now(), last_error = null
   where id = v_intent.id returning * into v_intent;
  return v_intent;
end;
$$;

revoke all on function public.register_verified_publish_release(uuid,uuid,text,uuid,text,text,uuid,uuid,uuid,text,text,text,bigint,integer,jsonb,jsonb,jsonb) from public, anon, authenticated;
revoke all on function public.request_publish_activation(uuid,uuid,bigint,text,uuid) from public, anon, authenticated;
revoke all on function public.request_publish_unpublish(uuid,text,bigint) from public, anon, authenticated;
revoke all on function public.mark_publish_pointer_switched(uuid,uuid) from public, anon, authenticated;
revoke all on function public.complete_publish_activation(uuid) from public, anon, authenticated;

grant execute on function public.register_verified_publish_release(uuid,uuid,text,uuid,text,text,uuid,uuid,uuid,text,text,text,bigint,integer,jsonb,jsonb,jsonb) to service_role;
grant execute on function public.request_publish_activation(uuid,uuid,bigint,text,uuid) to service_role;
grant execute on function public.request_publish_unpublish(uuid,text,bigint) to service_role;
grant execute on function public.mark_publish_pointer_switched(uuid,uuid) to service_role;
grant execute on function public.complete_publish_activation(uuid) to service_role;
