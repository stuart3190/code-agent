-- Package 12A: durable, content-free evidence for cross-store project/account erasure.
--
-- The mutable job row is the retry/recovery authority while an erasure is running. The event
-- ledger is append-only and deliberately stores only references, hashes and counts: deleted
-- prompts, source bytes, credentials and user content never become "audit evidence" by accident.

create table public.data_erasure_jobs (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('project', 'account')),
  subject_ref text not null check (length(subject_ref) = 64),
  owner_id uuid,
  project_id uuid,
  status text not null default 'planned'
    check (status in ('planned', 'executing', 'blocked', 'succeeded')),
  manifest_sha256 text not null check (length(manifest_sha256) = 64),
  manifest_counts jsonb not null default '{}'::jsonb,
  deleted_counts jsonb not null default '{}'::jsonb,
  storage_counts jsonb not null default '{}'::jsonb,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_error_code text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  check ((scope = 'project' and project_id is not null) or scope = 'account'),
  check (status <> 'succeeded' or (finished_at is not null and owner_id is null))
);

create unique index data_erasure_jobs_active_subject
  on public.data_erasure_jobs (scope, subject_ref, coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where status <> 'succeeded';
create index data_erasure_jobs_recovery
  on public.data_erasure_jobs (status, updated_at)
  where status in ('executing', 'blocked');

create table public.data_erasure_events (
  seq bigint generated always as identity primary key,
  job_id uuid not null references public.data_erasure_jobs(id) on delete restrict,
  event_type text not null check (event_type in (
    'planned', 'attempt_started', 'store_verified', 'rows_deleted', 'blocked', 'completed'
  )),
  store text,
  reference_hash text,
  item_count bigint not null default 0 check (item_count >= 0),
  byte_count bigint not null default 0 check (byte_count >= 0),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (reference_hash is null or length(reference_hash) = 64)
);
create index data_erasure_events_job on public.data_erasure_events (job_id, seq);

create or replace function public.prevent_data_erasure_event_mutation()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  raise exception using errcode = 'PT409', message = 'erasure audit events are append-only';
end;
$$;
create trigger data_erasure_events_append_only
  before update or delete on public.data_erasure_events
  for each row execute function public.prevent_data_erasure_event_mutation();

alter table public.data_erasure_jobs enable row level security;
alter table public.data_erasure_events enable row level security;
revoke all on public.data_erasure_jobs, public.data_erasure_events from public, anon, authenticated;
grant select, insert, update on public.data_erasure_jobs to service_role;
grant select, insert on public.data_erasure_events to service_role;
grant usage, select on sequence public.data_erasure_events_seq_seq to service_role;
revoke all on function public.prevent_data_erasure_event_mutation() from public, anon, authenticated;

comment on table public.data_erasure_jobs is
  'Retry authority for bounded cross-store erasure. Owner UUID is cleared on success; subject_ref is an application-HMAC.';
comment on table public.data_erasure_events is
  'Append-only content-free erasure proof. References/hashes/counts only; never deleted content.';

-- All database rows for one project are removed in one transaction. External filesystem,
-- Storage and Auth deletion happens before this call under the durable data_erasure_jobs retry
-- authority. A failure here rolls back every table delete, so the same manifest remains retryable.
create or replace function public.erase_project_runtime_rows(p_owner uuid, p_project uuid)
returns jsonb language plpgsql security invoker set search_path = pg_catalog, public as $$
declare v_owner uuid;
begin
  select owner into v_owner from public.projects where id = p_project for update;
  if not found then return jsonb_build_object('alreadyAbsent', true); end if;
  if v_owner <> p_owner then raise exception using errcode = '42501', message = 'project owner mismatch'; end if;

  delete from public.build_signals where owner = p_owner and build_id in
    (select id from public.diag_runs where owner = p_owner and project_id::text = p_project::text);
  delete from public.entities where app_id = p_project::text;
  delete from public.app_notifications where app_id = p_project::text;
  delete from public.app_auth_events where app_id = p_project::text;
  delete from public.app_password_resets where app_id = p_project::text;
  delete from public.app_users where app_id = p_project::text;
  delete from public.analytics_events where owner = p_owner and project_id::text = p_project::text;
  delete from public.analytics_daily where owner = p_owner and project_id::text = p_project::text;
  delete from public.project_logs where owner = p_owner and project_id::text = p_project::text;
  delete from public.health_checks where owner = p_owner and project_id::text = p_project::text;
  delete from public.health_status where owner = p_owner and project_id::text = p_project::text;
  delete from public.custom_domains where owner = p_owner and project_id::text = p_project::text;
  delete from public.publish_activation_intents where owner = p_owner and project_id = p_project::text;
  delete from public.publish_releases where owner = p_owner and project_id = p_project::text;
  delete from public.published_sites where owner = p_owner and project_id::text = p_project::text;
  delete from public.deployments where owner = p_owner and project_id::text = p_project::text;
  delete from public.build_checkpoints where owner = p_owner and project_id::text = p_project::text;
  delete from public.ai_requests where owner = p_owner and project_id::text = p_project::text;
  delete from public.build_work_events where owner = p_owner and project_id = p_project;
  delete from public.build_work_results where owner = p_owner and project_id = p_project;
  delete from public.build_work_jobs where owner = p_owner and project_id = p_project;
  delete from public.build_work_payloads where owner = p_owner and project_id = p_project;
  delete from public.build_jobs where owner = p_owner and project_id::text = p_project::text;
  delete from public.diag_runs where owner = p_owner and project_id::text = p_project::text;
  delete from public.bv2_migration_state where owner = p_owner and project_id = p_project;
  delete from public.bv2_project_knowledge where owner = p_owner and project_id = p_project;
  delete from public.bv2_shadow_runs where owner = p_owner and project_id = p_project;
  delete from public.bv2_file_revisions where owner = p_owner and project_id = p_project;
  delete from public.bv2_project_pointers where owner = p_owner and project_id = p_project;
  -- Blobs are content-addressed per owner. Remove only hashes referenced by this project and by
  -- no other snapshot owned by the same tenant. This runs before snapshots disappear so the
  -- proof and row removal share this transaction.
  delete from public.bv2_blobs b
   where b.owner = p_owner
     and exists (
       select 1 from public.bv2_snapshot_files sf
       join public.bv2_snapshots s on s.id = sf.snapshot_id
       where s.owner = p_owner and s.project_id = p_project and sf.content_hash = b.content_hash
     )
     and not exists (
       select 1 from public.bv2_snapshot_files sf
       join public.bv2_snapshots s on s.id = sf.snapshot_id
       where s.owner = p_owner and s.project_id <> p_project and sf.content_hash = b.content_hash
     );
  delete from public.bv2_snapshots where owner = p_owner and project_id = p_project;
  delete from public.bv2_contracts where owner = p_owner and project_id = p_project;
  delete from public.bv2_verification_cache where owner = p_owner and project_id = p_project;
  delete from public.bv2_model_reservations where owner = p_owner and project_id = p_project;
  delete from public.bv2_builds where owner = p_owner and project_id = p_project;
  delete from public.bv2_assets where owner = p_owner and project_id = p_project;
  delete from public.projects where id = p_project and owner = p_owner;
  return jsonb_build_object('alreadyAbsent', false, 'projectId', p_project);
end;
$$;
revoke all on function public.erase_project_runtime_rows(uuid,uuid) from public, anon, authenticated;
grant execute on function public.erase_project_runtime_rows(uuid,uuid) to service_role;

-- Auth deletion cascades rows carrying a proper auth.users FK. These older diagnostic/accounting
-- tables intentionally lack that FK, so account erasure removes their owner linkage explicitly.
-- Project-scoped content has already gone through erase_project_runtime_rows before this call.
create or replace function public.erase_account_runtime_rows(p_owner uuid)
returns jsonb language plpgsql security invoker set search_path = pg_catalog, public as $$
declare v_projects bigint;
begin
  select count(*) into v_projects from public.projects where owner = p_owner;
  if v_projects <> 0 then
    raise exception using errcode = 'PT409', message = 'account still owns projects';
  end if;
  delete from public.build_signals where owner = p_owner;
  delete from public.diag_incidents where owner = p_owner;
  delete from public.diag_runs where owner = p_owner;
  delete from public.diag_prefs where owner = p_owner;
  delete from public.ai_requests where owner = p_owner;
  delete from public.ca_github_webhook_deliveries where owner = p_owner;
  update public.data_erasure_jobs set owner_id = null, updated_at = now()
    where owner_id = p_owner and scope = 'project';
  return jsonb_build_object('ownerCleared', true);
end;
$$;
revoke all on function public.erase_account_runtime_rows(uuid) from public, anon, authenticated;
grant execute on function public.erase_account_runtime_rows(uuid) to service_role;

-- Forward repair: a blocked job may be safely retried only after regenerating the live manifest
-- and proving its SHA-256 matches manifest_sha256. Do not manually mark jobs succeeded.
-- Rollback: keep both tables as forensic evidence and disable writers first. Dropping them would
-- destroy required erasure evidence, so production rollback is an application rollback, not DROP.
