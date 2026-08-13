-- Builder V2 is now the exclusive application builder.
--
-- This migration intentionally preserves all historical V1/shadow evidence tables. It only
-- closes active write paths: new projects and public build jobs must identify as V2, and the
-- retired shadow recorder RPCs are no longer callable by the application service role.

do $$
declare
  v_v1_projects bigint;
  v_v1_jobs bigint;
begin
  select count(*) into v_v1_projects
    from public.projects
    where builder_version is distinct from 'v2';
  if v_v1_projects <> 0 then
    raise exception 'V2-only contract refused: % non-V2 projects remain', v_v1_projects;
  end if;

  select count(*) into v_v1_jobs
    from public.build_jobs
    where pipeline_version is distinct from 'v2';
  if v_v1_jobs <> 0 then
    raise exception 'V2-only contract refused: % non-V2 build jobs remain', v_v1_jobs;
  end if;
end
$$;

alter table public.projects
  alter column builder_version set default 'v2';
alter table public.projects
  drop constraint if exists projects_builder_version_check;
alter table public.projects
  add constraint projects_builder_version_v2_only_check
  check (builder_version = 'v2') not valid;
alter table public.projects
  validate constraint projects_builder_version_v2_only_check;

alter table public.build_jobs
  alter column pipeline_version set default 'v2';
alter table public.build_jobs
  drop constraint if exists build_jobs_pipeline_version_check;
alter table public.build_jobs
  add constraint build_jobs_pipeline_version_v2_only_check
  check (pipeline_version = 'v2') not valid;
alter table public.build_jobs
  validate constraint build_jobs_pipeline_version_v2_only_check;

revoke execute on function public.bv2_begin_shadow_run(uuid, uuid, text, text, jsonb)
  from service_role;
revoke execute on function public.bv2_record_shadow_check(uuid, uuid, uuid, text, jsonb)
  from service_role;

comment on column public.projects.builder_version is
  'Compatibility discriminator constrained to v2 after the V1 project retirement.';
comment on column public.build_jobs.pipeline_version is
  'Compatibility discriminator constrained to v2 after the V1 job retirement.';
comment on table public.bv2_feature_flags is
  'Historical V1-to-V2 rollout evidence; no active Builder dispatch reads this table.';
comment on table public.bv2_shadow_runs is
  'Historical V1 shadow-run evidence retained read-only after V2-only cutover.';
comment on table public.bv2_shadow_checks is
  'Historical V1 shadow-check evidence retained read-only after V2-only cutover.';
