-- C7: durable, lease-based execution authority for generated-app build work.
--
-- This migration is additive and MUST NOT be applied to production until the worker image and
-- rollback proof are approved. Builder V1 keeps using its existing build_jobs lifecycle; the
-- optional work_job_id link names the durable execution job behind that lifecycle.
--
-- Forward repair:
--   Deploy the worker and shell with THRALLO_BUILD_WORKER_ENABLED=0, apply this migration, start
--   one drained worker, then enable dispatch. Queued jobs are durable and may be retried through
--   build_work_retry after the underlying error is corrected.
--
-- Rollback before enabling dispatch:
--   Drop the build_work_* functions, view and tables, then drop build_jobs.work_job_id. No existing
--   Builder V1 data is rewritten. After dispatch has been enabled, prefer forward repair: disabling
--   the flag leaves queued jobs recoverable, whereas dropping the queue would discard authority.
--   Exact dependency order (only after proving every queue table is empty):
--     DROP VIEW public.build_work_queue_metrics;
--     DROP FUNCTION public.build_work_enqueue(uuid,uuid,uuid,text,jsonb,text,smallint,smallint,jsonb),
--       public.build_work_lease(text,text[],integer), public.build_work_start(uuid,text,uuid),
--       public.build_work_heartbeat(uuid,text,uuid,integer,jsonb),
--       public.build_work_event(uuid,text,uuid,text,jsonb),
--       public.build_work_complete(uuid,text,uuid,text,jsonb,text,integer,text,text),
--       public.build_work_fail(uuid,text,uuid,text,text,boolean,text),
--       public.build_work_request_cancel(uuid,uuid), public.build_work_retry(uuid),
--       public.build_worker_heartbeat(text,text,text,text[],uuid,jsonb);
--     ALTER TABLE public.qa_runs DROP CONSTRAINT qa_runs_worker_job_fkey,
--       DROP COLUMN worker_job_id;
--     DROP TABLE public.build_work_events, public.build_work_results,
--       public.build_work_jobs, public.build_work_payloads, public.build_worker_nodes;
--     ALTER TABLE public.build_jobs DROP COLUMN work_job_id,
--       DROP CONSTRAINT build_jobs_id_owner_unique;

alter table public.build_jobs
  add column if not exists work_job_id uuid;

alter table public.build_jobs
  add constraint build_jobs_id_owner_unique unique (id, owner);

create table public.build_work_payloads (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null,
  build_id uuid,
  job_type text not null,
  payload jsonb not null,
  payload_sha256 text not null,
  byte_size integer not null check (byte_size between 2 and 16777216),
  created_at timestamptz not null default now(),
  constraint build_work_payloads_project_owner_fkey
    foreign key (project_id, owner) references public.projects(id, owner) on delete cascade,
  constraint build_work_payloads_hash_check check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  constraint build_work_payloads_job_type_check check (job_type in (
    'builder_pipeline', 'dependency_install', 'compile', 'browser_verify', 'qa_browser',
    'image_optimise', 'publish_package', 'android_package', 'proof_slow'
  ))
);

create table public.build_work_jobs (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null,
  build_id uuid,
  job_type text not null,
  payload_ref uuid not null unique references public.build_work_payloads(id) on delete restrict,
  state text not null default 'queued',
  priority smallint not null default 0 check (priority between -100 and 100),
  attempts smallint not null default 0 check (attempts >= 0),
  max_attempts smallint not null default 3 check (max_attempts between 1 and 10),
  lease_owner text,
  lease_token uuid,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  cancel_requested boolean not null default false,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  error_classification text,
  error text,
  result_ref uuid,
  artifact_ref text,
  idempotency_key text not null,
  resource_limits jsonb not null default '{}'::jsonb,
  constraint build_work_jobs_project_owner_fkey
    foreign key (project_id, owner) references public.projects(id, owner) on delete cascade,
  constraint build_work_jobs_build_owner_fkey
    foreign key (build_id, owner) references public.build_jobs(id, owner) on delete cascade,
  constraint build_work_jobs_job_type_check check (job_type in (
    'builder_pipeline', 'dependency_install', 'compile', 'browser_verify', 'qa_browser',
    'image_optimise', 'publish_package', 'android_package', 'proof_slow'
  )),
  constraint build_work_jobs_state_check check (state in (
    'queued', 'leased', 'running', 'cancel_requested', 'succeeded', 'failed', 'cancelled', 'expired'
  )),
  constraint build_work_jobs_lease_shape_check check (
    (state in ('leased', 'running', 'cancel_requested') and lease_owner is not null and lease_token is not null and lease_expires_at is not null)
    or (state not in ('leased', 'running', 'cancel_requested'))
  ),
  constraint build_work_jobs_terminal_shape_check check (
    (state in ('succeeded', 'failed', 'cancelled') and finished_at is not null)
    or state not in ('succeeded', 'failed', 'cancelled')
  ),
  constraint build_work_jobs_idempotency_unique unique (owner, idempotency_key)
);

-- Deliberately no FK from build_jobs.work_job_id back to the queue: build_work_jobs already has
-- the authoritative build_id FK, and a reverse FK would create a restore-order cycle. The enqueue
-- RPC writes both references transactionally and project deletion removes queue children first.
create index build_jobs_work_job_idx on public.build_jobs (work_job_id) where work_job_id is not null;

alter table public.qa_runs add column if not exists worker_job_id uuid;
alter table public.qa_runs add constraint qa_runs_worker_job_fkey
  foreign key (worker_job_id) references public.build_work_jobs(id) on delete set null;
create index qa_runs_worker_job_idx on public.qa_runs (worker_job_id) where worker_job_id is not null;

create table public.build_work_results (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null unique references public.build_work_jobs(id) on delete cascade,
  owner uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null,
  completion_key text not null,
  result jsonb not null default '{}'::jsonb,
  result_sha256 text not null,
  artifact_ref text,
  exit_code integer,
  stdout_tail text,
  stderr_tail text,
  created_at timestamptz not null default now(),
  constraint build_work_results_project_owner_fkey
    foreign key (project_id, owner) references public.projects(id, owner) on delete cascade,
  constraint build_work_results_hash_check check (result_sha256 ~ '^[0-9a-f]{64}$'),
  constraint build_work_results_completion_unique unique (job_id, completion_key)
);

alter table public.build_work_jobs
  add constraint build_work_jobs_result_fkey
  foreign key (result_ref) references public.build_work_results(id) on delete set null;

create table public.build_work_events (
  seq bigint generated always as identity primary key,
  job_id uuid not null references public.build_work_jobs(id) on delete cascade,
  owner uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null,
  event_type text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint build_work_events_project_owner_fkey
    foreign key (project_id, owner) references public.projects(id, owner) on delete cascade,
  constraint build_work_events_type_check check (event_type in (
    'queued', 'leased', 'running', 'heartbeat', 'progress', 'stdout', 'stderr',
    'cancel_requested', 'cancelled', 'lease_expired', 'retry_queued', 'succeeded',
    'failed', 'worker_crash', 'timeout', 'resource_limit'
  )),
  constraint build_work_events_details_size check (octet_length(details::text) <= 131072)
);

create table public.build_worker_nodes (
  worker_id text primary key,
  version text not null,
  state text not null default 'active' check (state in ('active', 'paused', 'draining', 'stopped')),
  job_types text[] not null default '{}',
  current_job_id uuid references public.build_work_jobs(id) on delete set null,
  started_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  constraint build_worker_nodes_id_check check (worker_id ~ '^[A-Za-z0-9._:-]{1,128}$')
);

create index build_work_jobs_queue_idx
  on public.build_work_jobs (priority desc, next_attempt_at, created_at, id)
  where state in ('queued', 'expired') and cancel_requested = false;
create index build_work_jobs_lease_idx
  on public.build_work_jobs (lease_expires_at)
  where state in ('leased', 'running', 'cancel_requested');
create index build_work_jobs_owner_project_idx
  on public.build_work_jobs (owner, project_id, created_at desc);
create index build_work_jobs_build_idx on public.build_work_jobs (build_id) where build_id is not null;
create index build_work_events_job_seq_idx on public.build_work_events (job_id, seq);
create index build_work_events_created_idx on public.build_work_events (created_at);
create index build_work_payloads_build_idx on public.build_work_payloads (build_id) where build_id is not null;

alter table public.build_work_payloads enable row level security;
alter table public.build_work_jobs enable row level security;
alter table public.build_work_results enable row level security;
alter table public.build_work_events enable row level security;
alter table public.build_worker_nodes enable row level security;

revoke all on table public.build_work_payloads, public.build_work_jobs,
  public.build_work_results, public.build_work_events, public.build_worker_nodes
  from public, anon, authenticated;
revoke all on sequence public.build_work_events_seq_seq from public, anon, authenticated;
grant select, insert, update, delete on table public.build_work_payloads, public.build_work_jobs,
  public.build_work_results, public.build_work_events, public.build_worker_nodes to service_role;
grant usage, select on sequence public.build_work_events_seq_seq to service_role;

create policy build_work_payloads_browser_deny on public.build_work_payloads
  as restrictive for all to anon, authenticated using (false) with check (false);
create policy build_work_jobs_browser_deny on public.build_work_jobs
  as restrictive for all to anon, authenticated using (false) with check (false);
create policy build_work_results_browser_deny on public.build_work_results
  as restrictive for all to anon, authenticated using (false) with check (false);
create policy build_work_events_browser_deny on public.build_work_events
  as restrictive for all to anon, authenticated using (false) with check (false);
create policy build_worker_nodes_browser_deny on public.build_worker_nodes
  as restrictive for all to anon, authenticated using (false) with check (false);

create or replace function public.build_work_enqueue(
  p_owner uuid,
  p_project_id uuid,
  p_build_id uuid,
  p_job_type text,
  p_payload jsonb,
  p_idempotency_key text,
  p_priority smallint default 0,
  p_max_attempts smallint default 3,
  p_resource_limits jsonb default '{}'::jsonb
) returns public.build_work_jobs
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_existing public.build_work_jobs;
  v_payload_id uuid := gen_random_uuid();
  v_job public.build_work_jobs;
  v_payload_text text := coalesce(p_payload, '{}'::jsonb)::text;
begin
  if p_job_type not in ('builder_pipeline', 'dependency_install', 'compile', 'browser_verify',
    'qa_browser', 'image_optimise', 'publish_package', 'android_package', 'proof_slow') then
    raise exception 'unsupported build work type' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 8 and 200 then
    raise exception 'invalid idempotency key' using errcode = '22023';
  end if;
  if octet_length(v_payload_text) > 16777216 then
    raise exception 'build work payload exceeds 16 MiB' using errcode = '22001';
  end if;
  if not exists (select 1 from public.projects p where p.id = p_project_id and p.owner = p_owner) then
    raise exception 'project not owned by owner' using errcode = '42501';
  end if;
  if p_build_id is not null and not exists (
    select 1 from public.build_jobs b where b.id = p_build_id and b.owner = p_owner and b.project_id = p_project_id::text
  ) then
    raise exception 'build not owned by project owner' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_owner::text || ':' || p_idempotency_key, 0));
  select * into v_existing from public.build_work_jobs
    where owner = p_owner and idempotency_key = p_idempotency_key;
  if found then return v_existing; end if;

  insert into public.build_work_payloads (
    id, owner, project_id, build_id, job_type, payload, payload_sha256, byte_size
  ) values (
    v_payload_id, p_owner, p_project_id, p_build_id, p_job_type, coalesce(p_payload, '{}'::jsonb),
    encode(extensions.digest(convert_to(v_payload_text, 'UTF8'), 'sha256'), 'hex'), octet_length(v_payload_text)
  );

  insert into public.build_work_jobs (
    owner, project_id, build_id, job_type, payload_ref, priority, max_attempts,
    idempotency_key, resource_limits
  ) values (
    p_owner, p_project_id, p_build_id, p_job_type, v_payload_id, p_priority, p_max_attempts,
    p_idempotency_key, coalesce(p_resource_limits, '{}'::jsonb)
  ) returning * into v_job;

  insert into public.build_work_events (job_id, owner, project_id, event_type, details)
    values (v_job.id, p_owner, p_project_id, 'queued', jsonb_build_object('jobType', p_job_type));
  if p_build_id is not null then
    update public.build_jobs set work_job_id = v_job.id, updated_at = now()
      where id = p_build_id and owner = p_owner;
  end if;
  return v_job;
end;
$$;

create or replace function public.build_work_lease(
  p_worker_id text,
  p_job_types text[],
  p_lease_seconds integer default 45
) returns table (
  id uuid, owner uuid, project_id uuid, build_id uuid, job_type text, payload_ref uuid,
  payload jsonb, payload_sha256 text, state text, attempts smallint, max_attempts smallint,
  lease_token uuid, lease_expires_at timestamptz, cancel_requested boolean, resource_limits jsonb
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_job public.build_work_jobs;
begin
  if p_worker_id !~ '^[A-Za-z0-9._:-]{1,128}$' then
    raise exception 'invalid worker id' using errcode = '22023';
  end if;
  if p_lease_seconds not between 15 and 300 then
    raise exception 'lease seconds outside 15..300' using errcode = '22023';
  end if;

  insert into public.build_worker_nodes (worker_id, version, state, job_types)
    values (p_worker_id, 'unknown', 'active', coalesce(p_job_types, '{}'))
  on conflict (worker_id) do update set heartbeat_at = now(), job_types = excluded.job_types;
  if (select n.state from public.build_worker_nodes n where n.worker_id = p_worker_id) <> 'active' then
    return;
  end if;

  with stale as (
    select j.id from public.build_work_jobs j
    where j.state in ('leased', 'running', 'cancel_requested') and j.lease_expires_at <= now()
    order by j.id for update skip locked
  ), expired as (
  update public.build_work_jobs j set
    state = case when j.cancel_requested then 'cancelled' when j.attempts >= j.max_attempts then 'failed' else 'expired' end,
    finished_at = case when j.cancel_requested or j.attempts >= j.max_attempts then now() else null end,
    error_classification = case when j.cancel_requested then 'cancelled' when j.attempts >= j.max_attempts then 'worker_crash' else 'lease_expired' end,
    error = case when j.cancel_requested then 'Cancelled after worker lease expired.'
                 when j.attempts >= j.max_attempts then 'Worker lease expired after the final attempt.'
                 else 'Worker lease expired.' end,
    lease_owner = null, lease_token = null, lease_expires_at = null, heartbeat_at = null, updated_at = now()
  from stale where j.id = stale.id
  returning j.*
  ), customer_terminal as (
    update public.build_jobs b set
      status = 'failed', phase = 'failed',
      stop_reason = case when e.state = 'cancelled' then 'cancelled' else 'worker_crash' end,
      error = case when e.state = 'cancelled' then 'Cancelled by user.'
                   else 'The build worker stopped before this job could finish.' end,
      updated_at = now()
    from expired e
    where b.id = e.build_id and e.state in ('failed', 'cancelled')
      and b.status not in ('complete', 'failed', 'interrupted')
    returning b.id
  )
  insert into public.build_work_events (job_id, owner, project_id, event_type, details)
  select e.id, e.owner, e.project_id,
    case when e.state = 'cancelled' then 'cancelled' when e.state = 'failed' then 'worker_crash' else 'lease_expired' end,
    jsonb_build_object('classification', e.error_classification, 'attempt', e.attempts)
  from expired e;

  with candidate as (
    select j.id from public.build_work_jobs j
    where j.state in ('queued', 'expired')
      and j.cancel_requested = false
      and j.attempts < j.max_attempts
      and j.next_attempt_at <= now()
      and (coalesce(array_length(p_job_types, 1), 0) = 0 or j.job_type = any(p_job_types))
    order by j.priority desc, j.next_attempt_at, j.created_at, j.id
    limit 1 for update skip locked
  )
  update public.build_work_jobs j set
    state = 'leased', attempts = j.attempts + 1, lease_owner = p_worker_id,
    lease_token = gen_random_uuid(), lease_expires_at = now() + make_interval(secs => p_lease_seconds),
    heartbeat_at = now(), started_at = coalesce(j.started_at, now()), finished_at = null,
    error_classification = null, error = null, updated_at = now()
  from candidate where j.id = candidate.id returning j.* into v_job;

  if v_job.id is null then return; end if;
  update public.build_worker_nodes set current_job_id = v_job.id, heartbeat_at = now()
    where worker_id = p_worker_id;
  insert into public.build_work_events (job_id, owner, project_id, event_type, details)
    values (v_job.id, v_job.owner, v_job.project_id, 'leased',
      jsonb_build_object('worker', p_worker_id, 'attempt', v_job.attempts, 'leaseExpiresAt', v_job.lease_expires_at));

  return query select v_job.id, v_job.owner, v_job.project_id, v_job.build_id, v_job.job_type,
    v_job.payload_ref, p.payload, p.payload_sha256, v_job.state, v_job.attempts,
    v_job.max_attempts, v_job.lease_token, v_job.lease_expires_at,
    v_job.cancel_requested, v_job.resource_limits
  from public.build_work_payloads p where p.id = v_job.payload_ref;
end;
$$;

create or replace function public.build_work_start(
  p_job_id uuid, p_worker_id text, p_lease_token uuid
) returns public.build_work_jobs
language plpgsql security invoker set search_path = '' as $$
declare v_job public.build_work_jobs;
begin
  update public.build_work_jobs set
    state = case when cancel_requested then 'cancel_requested' else 'running' end,
    heartbeat_at = now(), updated_at = now()
  where id = p_job_id and lease_owner = p_worker_id and lease_token = p_lease_token
    and state in ('leased', 'cancel_requested') and lease_expires_at > now()
  returning * into v_job;
  if v_job.id is null then raise exception 'lease lost' using errcode = '40001'; end if;
  insert into public.build_work_events (job_id, owner, project_id, event_type, details)
    values (v_job.id, v_job.owner, v_job.project_id,
      case when v_job.cancel_requested then 'cancel_requested' else 'running' end,
      jsonb_build_object('worker', p_worker_id));
  return v_job;
end; $$;

create or replace function public.build_work_heartbeat(
  p_job_id uuid, p_worker_id text, p_lease_token uuid, p_lease_seconds integer default 45,
  p_details jsonb default '{}'::jsonb
) returns table (state text, cancel_requested boolean, lease_expires_at timestamptz)
language plpgsql security invoker set search_path = '' as $$
declare v_job public.build_work_jobs;
begin
  update public.build_work_jobs as j set
    heartbeat_at = now(), lease_expires_at = now() + make_interval(secs => greatest(15, least(p_lease_seconds, 300))),
    state = case when j.cancel_requested then 'cancel_requested' else j.state end, updated_at = now()
  where j.id = p_job_id and j.lease_owner = p_worker_id and j.lease_token = p_lease_token
    and j.state in ('leased', 'running', 'cancel_requested') and j.lease_expires_at > now()
  returning j.* into v_job;
  if v_job.id is null then raise exception 'lease lost' using errcode = '40001'; end if;
  update public.build_worker_nodes set heartbeat_at = now(), current_job_id = p_job_id where worker_id = p_worker_id;
  insert into public.build_work_events (job_id, owner, project_id, event_type, details)
    values (v_job.id, v_job.owner, v_job.project_id, 'heartbeat', coalesce(p_details, '{}'::jsonb));
  return query select v_job.state, v_job.cancel_requested, v_job.lease_expires_at;
end; $$;

create or replace function public.build_work_event(
  p_job_id uuid, p_worker_id text, p_lease_token uuid, p_event_type text, p_details jsonb
) returns bigint
language plpgsql security invoker set search_path = '' as $$
declare v_job public.build_work_jobs; v_seq bigint;
begin
  select * into v_job from public.build_work_jobs where id = p_job_id
    and lease_owner = p_worker_id and lease_token = p_lease_token
    and state in ('leased', 'running', 'cancel_requested');
  if v_job.id is null then raise exception 'lease lost' using errcode = '40001'; end if;
  if p_event_type not in ('progress', 'stdout', 'stderr') then
    raise exception 'unsupported worker event type' using errcode = '22023';
  end if;
  insert into public.build_work_events (job_id, owner, project_id, event_type, details)
    values (v_job.id, v_job.owner, v_job.project_id, p_event_type, coalesce(p_details, '{}'::jsonb))
    returning seq into v_seq;
  return v_seq;
end; $$;

create or replace function public.build_work_complete(
  p_job_id uuid, p_worker_id text, p_lease_token uuid, p_completion_key text,
  p_result jsonb default '{}'::jsonb, p_artifact_ref text default null,
  p_exit_code integer default 0, p_stdout_tail text default null, p_stderr_tail text default null
) returns public.build_work_jobs
language plpgsql security invoker set search_path = '' as $$
declare v_job public.build_work_jobs; v_result public.build_work_results; v_text text := coalesce(p_result, '{}'::jsonb)::text;
begin
  select * into v_job from public.build_work_jobs where id = p_job_id for update;
  if v_job.id is null then raise exception 'job not found' using errcode = 'P0002'; end if;
  if v_job.state = 'succeeded' then
    select * into v_result from public.build_work_results where id = v_job.result_ref;
    if v_result.completion_key = p_completion_key then return v_job; end if;
    raise exception 'conflicting duplicate completion' using errcode = '23505';
  end if;
  if v_job.lease_owner <> p_worker_id or v_job.lease_token <> p_lease_token
    or v_job.state not in ('leased', 'running', 'cancel_requested') then
    raise exception 'lease lost' using errcode = '40001';
  end if;
  if v_job.cancel_requested then raise exception 'completion rejected after cancellation request' using errcode = '57014'; end if;

  insert into public.build_work_results (
    job_id, owner, project_id, completion_key, result, result_sha256, artifact_ref,
    exit_code, stdout_tail, stderr_tail
  ) values (
    v_job.id, v_job.owner, v_job.project_id, p_completion_key, coalesce(p_result, '{}'::jsonb),
    encode(extensions.digest(convert_to(v_text, 'UTF8'), 'sha256'), 'hex'), p_artifact_ref,
    p_exit_code, left(p_stdout_tail, 65536), left(p_stderr_tail, 65536)
  ) returning * into v_result;

  update public.build_work_jobs set state = 'succeeded', result_ref = v_result.id,
    artifact_ref = p_artifact_ref, finished_at = now(), updated_at = now(),
    error = null, error_classification = null, lease_owner = null, lease_token = null,
    lease_expires_at = null, heartbeat_at = null
  where id = v_job.id returning * into v_job;
  update public.build_worker_nodes set current_job_id = null, heartbeat_at = now() where worker_id = p_worker_id;
  insert into public.build_work_events (job_id, owner, project_id, event_type, details)
    values (v_job.id, v_job.owner, v_job.project_id, 'succeeded',
      jsonb_build_object('resultRef', v_result.id, 'artifactRef', p_artifact_ref, 'exitCode', p_exit_code));
  return v_job;
end; $$;

create or replace function public.build_work_fail(
  p_job_id uuid, p_worker_id text, p_lease_token uuid, p_error_classification text,
  p_error text, p_retryable boolean default false, p_event_type text default 'failed'
) returns public.build_work_jobs
language plpgsql security invoker set search_path = '' as $$
declare v_job public.build_work_jobs; v_retry boolean;
begin
  select * into v_job from public.build_work_jobs where id = p_job_id for update;
  if v_job.id is null or v_job.lease_owner <> p_worker_id or v_job.lease_token <> p_lease_token
    or v_job.state not in ('leased', 'running', 'cancel_requested') then
    raise exception 'lease lost' using errcode = '40001';
  end if;
  v_retry := p_retryable and not v_job.cancel_requested and v_job.attempts < v_job.max_attempts;
  update public.build_work_jobs set
    state = case when v_job.cancel_requested then 'cancelled' when v_retry then 'queued' else 'failed' end,
    finished_at = case when v_retry then null else now() end,
    next_attempt_at = case when v_retry then now() + make_interval(secs => least(300, (2 ^ v_job.attempts)::integer)) else next_attempt_at end,
    error_classification = left(coalesce(p_error_classification, 'worker_error'), 100),
    error = left(coalesce(p_error, 'Worker job failed.'), 4000),
    lease_owner = null, lease_token = null, lease_expires_at = null, heartbeat_at = null, updated_at = now()
  where id = v_job.id returning * into v_job;
  update public.build_worker_nodes set current_job_id = null, heartbeat_at = now() where worker_id = p_worker_id;
  insert into public.build_work_events (job_id, owner, project_id, event_type, details)
    values (v_job.id, v_job.owner, v_job.project_id,
      case when v_job.state = 'queued' then 'retry_queued'
           when v_job.state = 'cancelled' then 'cancelled'
           when p_event_type in ('timeout', 'resource_limit', 'worker_crash') then p_event_type
           else 'failed' end,
      jsonb_build_object('classification', v_job.error_classification, 'attempt', v_job.attempts, 'retryable', v_retry));
  return v_job;
end; $$;

create or replace function public.build_work_request_cancel(p_owner uuid, p_job_id uuid)
returns public.build_work_jobs
language plpgsql security invoker set search_path = '' as $$
declare v_job public.build_work_jobs;
begin
  update public.build_work_jobs set cancel_requested = true,
    state = case when state in ('queued', 'expired') then 'cancelled'
                 when state in ('leased', 'running') then 'cancel_requested' else state end,
    finished_at = case when state in ('queued', 'expired') then now() else finished_at end,
    error_classification = case when state in ('queued', 'expired') then 'cancelled' else error_classification end,
    error = case when state in ('queued', 'expired') then 'Cancelled before execution.' else error end,
    updated_at = now()
  where id = p_job_id and owner = p_owner returning * into v_job;
  if v_job.id is null then raise exception 'job not found' using errcode = 'P0002'; end if;
  if v_job.state = 'cancelled' and v_job.build_id is not null then
    update public.build_jobs set status = 'failed', phase = 'failed',
      stop_reason = 'cancelled', error = 'Cancelled by user.', updated_at = now()
    where id = v_job.build_id and owner = v_job.owner
      and status not in ('complete', 'failed', 'interrupted');
  end if;
  if v_job.state in ('cancelled', 'cancel_requested') then
    insert into public.build_work_events (job_id, owner, project_id, event_type, details)
      values (v_job.id, v_job.owner, v_job.project_id,
        case when v_job.state = 'cancelled' then 'cancelled' else 'cancel_requested' end, '{}'::jsonb);
  end if;
  return v_job;
end; $$;

create or replace function public.build_work_retry(p_job_id uuid)
returns public.build_work_jobs
language plpgsql security invoker set search_path = '' as $$
declare v_job public.build_work_jobs;
begin
  update public.build_work_jobs set state = 'queued', cancel_requested = false,
    max_attempts = greatest(max_attempts, least(10, attempts::integer + 1)::smallint),
    next_attempt_at = now(), finished_at = null, error = null, error_classification = null,
    lease_owner = null, lease_token = null, lease_expires_at = null, heartbeat_at = null, updated_at = now()
  where id = p_job_id and state in ('failed', 'cancelled', 'expired') and attempts < 10
  returning * into v_job;
  if v_job.id is null then raise exception 'job is not retryable' using errcode = '55000'; end if;
  insert into public.build_work_events (job_id, owner, project_id, event_type, details)
    values (v_job.id, v_job.owner, v_job.project_id, 'retry_queued', jsonb_build_object('operator', true));
  return v_job;
end; $$;

create or replace function public.build_worker_heartbeat(
  p_worker_id text, p_version text, p_state text, p_job_types text[], p_current_job_id uuid,
  p_metadata jsonb default '{}'::jsonb
) returns public.build_worker_nodes
language plpgsql security invoker set search_path = '' as $$
declare v_node public.build_worker_nodes;
begin
  if p_state not in ('active', 'paused', 'draining', 'stopped') then
    raise exception 'invalid worker state' using errcode = '22023';
  end if;
  insert into public.build_worker_nodes (worker_id, version, state, job_types, current_job_id, metadata)
    values (p_worker_id, p_version, p_state, coalesce(p_job_types, '{}'), p_current_job_id, coalesce(p_metadata, '{}'::jsonb))
  on conflict (worker_id) do update set version = excluded.version, state = excluded.state,
    job_types = excluded.job_types, current_job_id = excluded.current_job_id,
    heartbeat_at = now(), metadata = excluded.metadata
  returning * into v_node;
  return v_node;
end; $$;

create view public.build_work_queue_metrics
with (security_invoker = true)
as select
  count(*) filter (where state in ('queued', 'expired')) as queue_depth,
  extract(epoch from (now() - min(created_at) filter (where state in ('queued', 'expired'))))::bigint as oldest_queue_age_seconds,
  count(*) filter (where state in ('leased', 'running', 'cancel_requested')) as active_jobs,
  count(*) filter (where state = 'failed') as failed_jobs,
  count(*) filter (where state = 'cancelled') as cancelled_jobs,
  count(*) filter (where state = 'succeeded') as succeeded_jobs
from public.build_work_jobs;

revoke all on public.build_work_queue_metrics from public, anon, authenticated;
grant select on public.build_work_queue_metrics to service_role;

revoke execute on function public.build_work_enqueue(uuid, uuid, uuid, text, jsonb, text, smallint, smallint, jsonb) from public, anon, authenticated;
revoke execute on function public.build_work_lease(text, text[], integer) from public, anon, authenticated;
revoke execute on function public.build_work_start(uuid, text, uuid) from public, anon, authenticated;
revoke execute on function public.build_work_heartbeat(uuid, text, uuid, integer, jsonb) from public, anon, authenticated;
revoke execute on function public.build_work_event(uuid, text, uuid, text, jsonb) from public, anon, authenticated;
revoke execute on function public.build_work_complete(uuid, text, uuid, text, jsonb, text, integer, text, text) from public, anon, authenticated;
revoke execute on function public.build_work_fail(uuid, text, uuid, text, text, boolean, text) from public, anon, authenticated;
revoke execute on function public.build_work_request_cancel(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.build_work_retry(uuid) from public, anon, authenticated;
revoke execute on function public.build_worker_heartbeat(text, text, text, text[], uuid, jsonb) from public, anon, authenticated;

grant execute on function public.build_work_enqueue(uuid, uuid, uuid, text, jsonb, text, smallint, smallint, jsonb) to service_role;
grant execute on function public.build_work_lease(text, text[], integer) to service_role;
grant execute on function public.build_work_start(uuid, text, uuid) to service_role;
grant execute on function public.build_work_heartbeat(uuid, text, uuid, integer, jsonb) to service_role;
grant execute on function public.build_work_event(uuid, text, uuid, text, jsonb) to service_role;
grant execute on function public.build_work_complete(uuid, text, uuid, text, jsonb, text, integer, text, text) to service_role;
grant execute on function public.build_work_fail(uuid, text, uuid, text, text, boolean, text) to service_role;
grant execute on function public.build_work_request_cancel(uuid, uuid) to service_role;
grant execute on function public.build_work_retry(uuid) to service_role;
grant execute on function public.build_worker_heartbeat(text, text, text, text[], uuid, jsonb) to service_role;

comment on table public.build_work_jobs is
  'Durable execution authority for generated-app CPU/memory-heavy work. One atomic lease is held by one worker; browser roles have no access.';
comment on column public.build_work_jobs.resource_limits is
  'Requested and policy-capped wallSeconds, cpu, memoryMb, pids and outputBytes recorded with the job.';
comment on table public.build_work_events is
  'Append-only bounded worker evidence and operational events; never a payload or secret store.';
