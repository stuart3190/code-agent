-- Builder V2 production composition lifecycle links.
--
-- These columns preserve the existing build_jobs status/SSE API while making its pipeline
-- identity explicit. A V2 job may only be consumed by the durable worker; there is no in-process
-- or V1 fallback. projects.tree remains a temporary compatibility projection of the verified
-- green snapshot until all readers have moved to the snapshot pointer.
--
-- Forward repair: a V2 build job with no bv2_build_id is either not yet leased or failed before
-- the orchestrator created its durable build row. Inspect build_work_jobs/events; never relabel it
-- V1. A project marked v2 must have a ready, owner-matching green snapshot before preview/export.
--
-- Rollback (only before V2 cutover): disable V2 dispatch, wait for V2 jobs to reach a terminal
-- state, drop the two indexes and FKs below, then drop the added columns. Existing V1 rows retain
-- their default pipeline_version='v1' and are otherwise byte-identical.

alter table public.build_jobs
  add column pipeline_version text not null default 'v1'
    check (pipeline_version in ('v1', 'v2')),
  add column bv2_build_id uuid references public.bv2_builds(id) on delete set null,
  add column diag_run_id uuid references public.diag_runs(id) on delete set null;

alter table public.projects
  add column builder_version text not null default 'v1'
    check (builder_version in ('v1', 'v2')),
  add column bv2_green_snapshot_id uuid;

alter table public.bv2_builds
  add constraint bv2_builds_project_owner_fkey
    foreign key (project_id, owner) references public.projects(id, owner) on delete cascade;

-- The C4 migration already created projects(id, owner). Complete the runtime links with composite
-- identities so even a compromised service-role caller cannot attach another tenant's build or
-- snapshot to a project/job row.
alter table public.bv2_snapshots
  add constraint bv2_snapshots_id_owner_project_unique unique (id, owner, project_id);

alter table public.bv2_contracts
  add constraint bv2_contracts_id_owner_project_unique unique (id, owner, project_id),
  add constraint bv2_contracts_owner_project_version_unique unique (owner, project_id, version);

alter table public.bv2_builds
  add constraint bv2_builds_id_owner_unique unique (id, owner);

alter table public.diag_runs
  add constraint diag_runs_id_owner_project_unique unique (id, owner, project_id);

alter table public.build_jobs
  add constraint build_jobs_bv2_build_owner_project_fkey
    foreign key (bv2_build_id, owner, project_id)
    references public.bv2_builds(id, owner, project_id) on delete set null (bv2_build_id),
  add constraint build_jobs_diag_run_owner_project_fkey
    foreign key (diag_run_id, owner, project_id)
    references public.diag_runs(id, owner, project_id) on delete set null (diag_run_id);

alter table public.projects
  add constraint projects_bv2_green_snapshot_owner_fkey
    foreign key (bv2_green_snapshot_id, owner, id)
    references public.bv2_snapshots(id, owner, project_id) on delete set null (bv2_green_snapshot_id);

-- Foundation tables originally relied on service-code owner filters. Make the production
-- composition relationally owner-safe and make project erasure cascade through every canonical
-- V2 row. Existing drift causes this migration to fail rather than legitimising orphaned data.
alter table public.bv2_migration_state
  add constraint bv2_migration_state_project_owner_fkey
    foreign key (project_id, owner) references public.projects(id, owner) on delete cascade;

alter table public.bv2_project_knowledge
  add constraint bv2_project_knowledge_project_owner_fkey
    foreign key (project_id, owner) references public.projects(id, owner) on delete cascade,
  add constraint bv2_project_knowledge_source_build_owner_fkey
    foreign key (source_build, owner) references public.bv2_builds(id, owner) on delete set null (source_build);

alter table public.bv2_snapshots
  add constraint bv2_snapshots_project_owner_fkey
    foreign key (project_id, owner) references public.projects(id, owner) on delete cascade,
  add constraint bv2_snapshots_build_owner_project_fkey
    foreign key (build_id, owner, project_id)
    references public.bv2_builds(id, owner, project_id) on delete set null (build_id),
  add constraint bv2_snapshots_parent_owner_project_fkey
    foreign key (parent_snapshot, owner, project_id)
    references public.bv2_snapshots(id, owner, project_id) on delete set null (parent_snapshot);

alter table public.bv2_project_pointers
  add constraint bv2_project_pointers_project_owner_fkey
    foreign key (project_id, owner) references public.projects(id, owner) on delete cascade,
  add constraint bv2_project_pointers_snapshot_owner_project_fkey
    foreign key (snapshot_id, owner, project_id)
    references public.bv2_snapshots(id, owner, project_id) on delete cascade;

alter table public.bv2_contracts
  add constraint bv2_contracts_project_owner_fkey
    foreign key (project_id, owner) references public.projects(id, owner) on delete cascade,
  add constraint bv2_contracts_build_owner_project_fkey
    foreign key (build_id, owner, project_id)
    references public.bv2_builds(id, owner, project_id) on delete set null (build_id);

alter table public.bv2_retrieval_traces
  add constraint bv2_retrieval_traces_build_owner_fkey
    foreign key (build_id, owner) references public.bv2_builds(id, owner) on delete cascade;

alter table public.bv2_patches
  add constraint bv2_patches_build_owner_fkey
    foreign key (build_id, owner) references public.bv2_builds(id, owner) on delete cascade;

alter table public.bv2_verification_cache
  add constraint bv2_verification_cache_project_owner_fkey
    foreign key (project_id, owner) references public.projects(id, owner) on delete cascade,
  add constraint bv2_verification_cache_snapshot_owner_project_fkey
    foreign key (snapshot_id, owner, project_id)
    references public.bv2_snapshots(id, owner, project_id) on delete cascade;

alter table public.bv2_assets
  add constraint bv2_assets_project_owner_fkey
    foreign key (project_id, owner) references public.projects(id, owner) on delete cascade;

alter table public.bv2_builds
  add constraint bv2_builds_contract_owner_project_fkey
    foreign key (contract_id, owner, project_id)
    references public.bv2_contracts(id, owner, project_id) on delete set null (contract_id),
  add constraint bv2_builds_snapshot_owner_project_fkey
    foreign key (final_snapshot, owner, project_id)
    references public.bv2_snapshots(id, owner, project_id) on delete set null (final_snapshot);

create index build_jobs_pipeline_status_idx
  on public.build_jobs (pipeline_version, status, created_at);
create index build_jobs_bv2_build_idx
  on public.build_jobs (bv2_build_id) where bv2_build_id is not null;
create index build_jobs_diag_run_idx
  on public.build_jobs (diag_run_id) where diag_run_id is not null;
create unique index build_jobs_one_active_project_idx
  on public.build_jobs (owner, project_id)
  where status in ('queued', 'running');
create index projects_bv2_green_snapshot_idx
  on public.projects (owner, bv2_green_snapshot_id)
  where bv2_green_snapshot_id is not null;
create index bv2_project_knowledge_source_build_idx
  on public.bv2_project_knowledge (source_build) where source_build is not null;
create index bv2_snapshots_build_idx
  on public.bv2_snapshots (build_id) where build_id is not null;
create index bv2_snapshots_parent_idx
  on public.bv2_snapshots (parent_snapshot) where parent_snapshot is not null;
create index bv2_project_pointers_snapshot_idx
  on public.bv2_project_pointers (snapshot_id);
create index bv2_contracts_build_idx
  on public.bv2_contracts (build_id) where build_id is not null;
create index bv2_retrieval_traces_build_idx
  on public.bv2_retrieval_traces (build_id);
create index bv2_patches_build_idx
  on public.bv2_patches (build_id);
create index bv2_verification_cache_snapshot_idx
  on public.bv2_verification_cache (snapshot_id);

comment on column public.build_jobs.pipeline_version is
  'Immutable orchestration identity. V2 jobs fail closed unless leased by the durable worker.';
comment on column public.projects.bv2_green_snapshot_id is
  'Authoritative verified Builder V2 snapshot; projects.tree is only a compatibility projection.';

-- A durable worker lease may be reclaimed, but replaying a provider call without a provider-level
-- idempotency guarantee could duplicate spend. This guard serialises a pipeline retry with the
-- public job and permits only three honest outcomes:
--   * recover a result already durably projected to build_jobs;
--   * restart before provider dispatch when the abandoned V2 build has zero reservations; or
--   * fail closed for operator reconciliation once any reservation exists.
create or replace function public.prepare_bv2_pipeline_retry(
  p_owner uuid,
  p_public_build_id uuid,
  p_work_job_id uuid
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_public public.build_jobs;
  v_reservation_count bigint := 0;
  v_reservation_states jsonb := '{}'::jsonb;
begin
  select * into v_public
  from public.build_jobs b
  where b.id = p_public_build_id
    and b.owner = p_owner
    and b.pipeline_version = 'v2'
    and b.work_job_id = p_work_job_id
  for update;

  if not found then
    raise exception 'Builder V2 public/work job identity mismatch' using errcode = '42501';
  end if;

  if v_public.status = 'complete' and v_public.result is not null then
    return jsonb_build_object(
      'action', 'recovered',
      'result', v_public.result,
      'stopReason', v_public.stop_reason
    );
  end if;

  if v_public.status in ('failed', 'interrupted') then
    return jsonb_build_object('action', 'terminal_public_job', 'status', v_public.status);
  end if;

  if v_public.bv2_build_id is null then
    return jsonb_build_object('action', 'restart_before_provider', 'abandonedBuildId', null);
  end if;

  select coalesce(sum(x.count), 0), coalesce(jsonb_object_agg(x.state, x.count), '{}'::jsonb)
  into v_reservation_count, v_reservation_states
  from (
    select r.state, count(*) as count
    from public.bv2_model_reservations r
    where r.owner = p_owner and r.build_id = v_public.bv2_build_id
    group by r.state
  ) x;

  if v_reservation_count > 0 then
    return jsonb_build_object(
      'action', 'provider_replay_unsafe',
      'abandonedBuildId', v_public.bv2_build_id,
      'reservationCount', v_reservation_count,
      'reservationStates', v_reservation_states
    );
  end if;

  update public.bv2_builds set
    state = 'failed',
    error = 'worker_crash_before_provider_dispatch',
    finished_at = coalesce(finished_at, now())
  where id = v_public.bv2_build_id
    and owner = p_owner
    and state not in ('green', 'failed', 'cancelled', 'blocked');

  update public.build_jobs set
    bv2_build_id = null,
    status = 'running',
    phase = 'running',
    error = null,
    stop_reason = null,
    updated_at = now()
  where id = v_public.id and owner = p_owner;

  return jsonb_build_object(
    'action', 'restart_before_provider',
    'abandonedBuildId', v_public.bv2_build_id
  );
end;
$$;

revoke execute on function public.prepare_bv2_pipeline_retry(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.prepare_bv2_pipeline_retry(uuid, uuid, uuid)
  to service_role;
