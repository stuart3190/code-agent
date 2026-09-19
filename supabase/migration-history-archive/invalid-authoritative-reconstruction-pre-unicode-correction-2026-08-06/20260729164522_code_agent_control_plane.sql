-- Code Agent control plane.
-- This migration is intentionally separate from the imported Buildr101 schema. The web client
-- receives owner-scoped read access to safe metadata only; orchestration writes use the service
-- role through the control-plane API. Secrets, embeddings and tool payloads remain server-only.

create extension if not exists vector with schema extensions;

create table if not exists public.ca_repositories (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  provider text not null default 'github' check (provider in ('github')),
  external_id bigint,
  installation_id bigint,
  full_name text not null,
  clone_url text not null,
  default_branch text not null default 'main',
  private boolean not null default true,
  permissions jsonb not null default '{}'::jsonb,
  status text not null default 'ready' check (status in ('connecting','ready','indexing','error','disconnected')),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner, provider, full_name)
);

create table if not exists public.ca_agents (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  repository_id uuid not null references public.ca_repositories(id) on delete cascade,
  name text not null default 'New agent',
  mode text not null default 'agent' check (mode in ('ask','plan','agent','review')),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ca_runs (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  agent_id uuid not null references public.ca_agents(id) on delete cascade,
  repository_id uuid not null references public.ca_repositories(id) on delete cascade,
  prompt text not null,
  mode text not null default 'agent' check (mode in ('ask','plan','agent','review')),
  model text not null default 'auto',
  base_branch text not null,
  work_branch text,
  state text not null default 'queued' check (
    state in ('queued','provisioning','indexing','running','waiting_for_approval',
      'waiting_for_user','succeeded','failed','cancelled','interrupted')
  ),
  sandbox_id text,
  snapshot_id text,
  result jsonb,
  usage jsonb not null default '{}'::jsonb,
  error_code text,
  error text,
  cancel_requested_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ca_run_events (
  id bigint generated always as identity primary key,
  owner uuid not null references auth.users(id) on delete cascade,
  run_id uuid not null references public.ca_runs(id) on delete cascade,
  sequence bigint not null,
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (run_id, sequence)
);

create table if not exists public.ca_tool_calls (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  run_id uuid not null references public.ca_runs(id) on delete cascade,
  provider_call_id text,
  name text not null,
  state text not null default 'requested' check (state in ('requested','approved','running','succeeded','failed','denied')),
  arguments jsonb not null default '{}'::jsonb,
  output jsonb,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.ca_checkpoints (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  run_id uuid not null references public.ca_runs(id) on delete cascade,
  sequence bigint not null,
  label text not null,
  git_sha text,
  snapshot_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (run_id, sequence)
);

create table if not exists public.ca_artifacts (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  run_id uuid not null references public.ca_runs(id) on delete cascade,
  type text not null check (type in ('diff','log','screenshot','video','report','archive','link')),
  name text not null,
  storage_key text,
  url text,
  content text,
  content_type text,
  size_bytes bigint,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.ca_repository_index_files (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  repository_id uuid not null references public.ca_repositories(id) on delete cascade,
  index_version bigint not null,
  path_ciphertext text not null,
  content_hash text not null,
  language text,
  size_bytes bigint not null default 0,
  created_at timestamptz not null default now(),
  unique (repository_id, index_version, path_ciphertext)
);

create table if not exists public.ca_repository_index_chunks (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  repository_id uuid not null references public.ca_repositories(id) on delete cascade,
  file_id uuid not null references public.ca_repository_index_files(id) on delete cascade,
  chunk_hash text not null,
  start_line integer not null,
  end_line integer not null,
  embedding extensions.vector(1536),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (file_id, chunk_hash, start_line)
);

create table if not exists public.ca_usage_records (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  run_id uuid references public.ca_runs(id) on delete set null,
  provider text not null,
  model text,
  input_tokens bigint not null default 0,
  cached_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  reasoning_tokens bigint not null default 0,
  compute_seconds numeric not null default 0,
  amount_gbp numeric not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists ca_repositories_owner_updated_idx on public.ca_repositories(owner, updated_at desc);
create index if not exists ca_agents_owner_updated_idx on public.ca_agents(owner, updated_at desc);
create index if not exists ca_runs_owner_created_idx on public.ca_runs(owner, created_at desc);
create index if not exists ca_runs_queue_idx on public.ca_runs(state, created_at) where state = 'queued';
create index if not exists ca_run_events_run_sequence_idx on public.ca_run_events(run_id, sequence);
create index if not exists ca_tool_calls_run_idx on public.ca_tool_calls(run_id, created_at);
create index if not exists ca_artifacts_run_idx on public.ca_artifacts(run_id, created_at);
create index if not exists ca_index_files_repo_hash_idx on public.ca_repository_index_files(repository_id, content_hash);
create index if not exists ca_index_chunks_repo_idx on public.ca_repository_index_chunks(repository_id);
create index if not exists ca_usage_owner_created_idx on public.ca_usage_records(owner, created_at desc);

alter table public.ca_repositories enable row level security;
alter table public.ca_agents enable row level security;
alter table public.ca_runs enable row level security;
alter table public.ca_run_events enable row level security;
alter table public.ca_tool_calls enable row level security;
alter table public.ca_checkpoints enable row level security;
alter table public.ca_artifacts enable row level security;
alter table public.ca_repository_index_files enable row level security;
alter table public.ca_repository_index_chunks enable row level security;
alter table public.ca_usage_records enable row level security;

-- The browser may read only presentation-safe owner metadata. All writes and all sensitive
-- payload reads flow through the service-role control plane.
grant usage on schema public to authenticated, service_role;
grant select on public.ca_repositories, public.ca_agents, public.ca_runs,
  public.ca_run_events, public.ca_checkpoints, public.ca_artifacts, public.ca_usage_records
  to authenticated;
grant all privileges on public.ca_repositories, public.ca_agents, public.ca_runs,
  public.ca_run_events, public.ca_tool_calls, public.ca_checkpoints, public.ca_artifacts,
  public.ca_repository_index_files, public.ca_repository_index_chunks, public.ca_usage_records
  to service_role;
grant usage, select on sequence public.ca_run_events_id_seq to service_role;
revoke all on public.ca_tool_calls, public.ca_repository_index_files,
  public.ca_repository_index_chunks from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

create policy "ca_repositories_owner_read" on public.ca_repositories
  for select to authenticated using ((select auth.uid()) = owner);
create policy "ca_agents_owner_read" on public.ca_agents
  for select to authenticated using ((select auth.uid()) = owner);
create policy "ca_runs_owner_read" on public.ca_runs
  for select to authenticated using ((select auth.uid()) = owner);
create policy "ca_run_events_owner_read" on public.ca_run_events
  for select to authenticated using ((select auth.uid()) = owner);
create policy "ca_checkpoints_owner_read" on public.ca_checkpoints
  for select to authenticated using ((select auth.uid()) = owner);
create policy "ca_artifacts_owner_read" on public.ca_artifacts
  for select to authenticated using ((select auth.uid()) = owner);
create policy "ca_usage_owner_read" on public.ca_usage_records
  for select to authenticated using ((select auth.uid()) = owner);

create or replace function public.claim_code_agent_runs(p_limit integer default 1)
returns setof public.ca_runs
language plpgsql
security invoker
set search_path = public
as $$
begin
  return query
  with claimed as (
    select id
    from public.ca_runs
    where state = 'queued'
    order by created_at
    for update skip locked
    limit least(greatest(p_limit, 1), 20)
  )
  update public.ca_runs r
  set state = 'provisioning', started_at = coalesce(started_at, now()), updated_at = now()
  from claimed
  where r.id = claimed.id
  returning r.*;
end;
$$;

revoke all on function public.claim_code_agent_runs(integer) from public, anon, authenticated;
grant execute on function public.claim_code_agent_runs(integer) to service_role;
