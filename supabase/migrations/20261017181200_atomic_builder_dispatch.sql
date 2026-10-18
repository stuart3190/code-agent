-- Keep the public build and its execution payload in the same transaction. A shell
-- restart must not leave an uncancellable queued build with no work_job_id.
-- Additive rollout: install before the caller update. Rollback the caller first;
-- leave this unused function in place. No queued work or customer rows are rewritten.
create or replace function public.build_pipeline_dispatch(
  p_owner uuid, p_project_id uuid, p_build_id uuid, p_mode text,
  p_diag_run_id uuid, p_budget_approval_id uuid, p_payload jsonb,
  p_priority smallint, p_resource_limits jsonb
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_build public.build_jobs;
  v_work public.build_work_jobs;
begin
  if p_build_id is null or p_mode is null or p_mode = '' then
    raise exception 'build identity and mode required' using errcode='22023';
  end if;
  if not exists(select 1 from public.projects p where p.id=p_project_id and p.owner=p_owner) then
    raise exception 'project not owned by owner' using errcode='42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'builder-dispatch:' || p_owner::text || ':' || p_project_id::text, 0));
  select * into v_build from public.build_jobs
    where owner=p_owner and project_id=p_project_id::text and status in ('queued','running')
    order by created_at desc limit 1 for update;
  if found then
    select * into v_work from public.build_work_jobs
      where id=v_build.work_job_id and owner=p_owner and project_id=p_project_id;
    return jsonb_build_object('job',to_jsonb(v_build),'work',to_jsonb(v_work),'existing',true);
  end if;
  begin
    insert into public.build_jobs(id,owner,project_id,mode,status,phase,pipeline_version,diag_run_id,budget_approval_id)
      values(p_build_id,p_owner,p_project_id::text,p_mode,'queued','queued','v2',p_diag_run_id,p_budget_approval_id)
      returning * into v_build;
  exception when unique_violation then
    -- An older caller can still race during a rolling deployment; preserve its winner.
    select * into v_build from public.build_jobs
      where owner=p_owner and project_id=p_project_id::text and status in ('queued','running')
      order by created_at desc limit 1;
    if not found then raise; end if;
    select * into v_work from public.build_work_jobs
      where id=v_build.work_job_id and owner=p_owner and project_id=p_project_id;
    return jsonb_build_object('job',to_jsonb(v_build),'work',to_jsonb(v_work),'existing',true);
  end;
  v_work := public.build_work_enqueue(p_owner,p_project_id,p_build_id,'builder_pipeline',p_payload,
    'builder-pipeline:' || p_build_id::text,p_priority,2::smallint,p_resource_limits);
  select * into v_build from public.build_jobs where id=p_build_id and owner=p_owner;
  return jsonb_build_object('job',to_jsonb(v_build),'work',to_jsonb(v_work),'existing',false);
end $$;
revoke execute on function public.build_pipeline_dispatch(uuid,uuid,uuid,text,uuid,uuid,jsonb,smallint,jsonb)
  from public,anon,authenticated;
grant execute on function public.build_pipeline_dispatch(uuid,uuid,uuid,text,uuid,uuid,jsonb,smallint,jsonb)
  to service_role;
