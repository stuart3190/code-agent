-- C8 forward repair: atomic unpublish must retire the deployment that is actually live for
-- the published site's canonical deployment scope before clearing the active release pointer.
-- The same scoped lookup is used when replacing an active release: the expanded regression proof
-- demonstrated that a rollback deployment may differ from the release's immutable deployment_id.
--
-- This deliberately replaces only complete_publish_activation(uuid). The original
-- 20260807072455 migration is production history and remains immutable.
--
-- Forward repair if deployment fails:
--   Re-run this migration. CREATE OR REPLACE FUNCTION and the privilege statements are
--   idempotent, and PostgreSQL applies the migration transactionally.
--
-- Rollback guidance:
--   Restore the previous complete_publish_activation(uuid) definition from migration
--   20260807072455. Do not roll back after an unpublish has used this repair unless the live
--   deployment state is first reconciled: reverting would reintroduce the known stale-live-row
--   defect. No table data or migration-ledger repair is required by this forward repair.

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
  if v_site.activation_version <> v_intent.expected_version then raise exception 'stale activation version' using errcode = '40001'; end if;

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

    -- A rollback may use activation_deployment_id, which is intentionally different from the
    -- retained release's immutable deployment_id. Select the deployment that is actually live
    -- for the site's canonical scope; deployments_one_live_per_app guarantees at most one row.
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

revoke all on function public.complete_publish_activation(uuid) from public, anon, authenticated;
grant execute on function public.complete_publish_activation(uuid) to service_role;
