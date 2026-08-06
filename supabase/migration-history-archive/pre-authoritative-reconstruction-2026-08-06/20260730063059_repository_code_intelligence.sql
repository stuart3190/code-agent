-- Phase 5: encrypted symbol/reference graph and durable repository refresh queue.
-- The filename matches the version recorded by the production migration service.
alter table public.ca_repository_indexes
  drop constraint ca_repository_indexes_status_check,
  add constraint ca_repository_indexes_status_check
    check (status in ('pending', 'queued', 'indexing', 'ready', 'error')),
  add column symbol_count integer not null default 0 check (symbol_count >= 0),
  add column relation_count integer not null default 0 check (relation_count >= 0),
  add column dependency_count integer not null default 0 check (dependency_count >= 0),
  add column progress_phase text,
  add column progress_current integer not null default 0 check (progress_current >= 0),
  add column progress_total integer not null default 0 check (progress_total >= 0),
  add column refresh_reason text
    check (refresh_reason is null or refresh_reason in ('manual', 'github_push', 'run')),
  add column refresh_requested_at timestamptz,
  add column refresh_requested_by uuid references auth.users(id) on delete set null,
  add column requested_head_sha text,
  add column claimed_at timestamptz;

create table public.ca_repository_symbols (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  repository_id uuid not null references public.ca_repositories(id) on delete cascade,
  file_id uuid not null references public.ca_repository_index_files(id) on delete cascade,
  index_version bigint not null,
  name_ciphertext text not null,
  name_hash text not null,
  qualified_name_ciphertext text,
  kind text not null check (
    kind in ('function', 'method', 'class', 'interface', 'type', 'enum', 'struct',
      'trait', 'module', 'variable', 'constant', 'table', 'view')
  ),
  language text,
  start_line integer not null check (start_line > 0),
  end_line integer not null check (end_line >= start_line),
  signature_ciphertext text,
  exported boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (file_id, index_version, name_hash, kind, start_line)
);

create table public.ca_repository_relations (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  repository_id uuid not null references public.ca_repositories(id) on delete cascade,
  index_version bigint not null,
  source_file_id uuid not null references public.ca_repository_index_files(id) on delete cascade,
  target_file_id uuid references public.ca_repository_index_files(id) on delete cascade,
  source_symbol_id uuid references public.ca_repository_symbols(id) on delete cascade,
  target_symbol_id uuid references public.ca_repository_symbols(id) on delete cascade,
  target_name_hash text,
  target_path_hash text,
  kind text not null check (
    kind in ('imports', 'references', 'calls', 'extends', 'implements')
  ),
  line integer not null check (line > 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (
    target_file_id is not null
    or target_symbol_id is not null
    or target_name_hash is not null
    or target_path_hash is not null
  )
);

create index ca_repository_indexes_refresh_queue_idx
  on public.ca_repository_indexes(refresh_requested_at, repository_id)
  where status = 'queued';
create index ca_repository_indexes_refresh_requested_by_idx
  on public.ca_repository_indexes(refresh_requested_by)
  where refresh_requested_by is not null;
create index ca_repository_symbols_repo_name_idx
  on public.ca_repository_symbols(repository_id, name_hash);
create index ca_repository_symbols_file_line_idx
  on public.ca_repository_symbols(file_id, start_line);
create index ca_repository_symbols_owner_idx
  on public.ca_repository_symbols(owner);
create index ca_repository_relations_repo_target_name_idx
  on public.ca_repository_relations(repository_id, target_name_hash)
  where target_name_hash is not null;
create index ca_repository_relations_repository_id_idx
  on public.ca_repository_relations(repository_id);
create index ca_repository_relations_source_file_kind_idx
  on public.ca_repository_relations(source_file_id, kind);
create index ca_repository_relations_target_file_kind_idx
  on public.ca_repository_relations(target_file_id, kind)
  where target_file_id is not null;
create index ca_repository_relations_source_symbol_idx
  on public.ca_repository_relations(source_symbol_id)
  where source_symbol_id is not null;
create index ca_repository_relations_target_symbol_idx
  on public.ca_repository_relations(target_symbol_id)
  where target_symbol_id is not null;
create index ca_repository_relations_owner_idx
  on public.ca_repository_relations(owner);

alter table public.ca_repository_symbols enable row level security;
alter table public.ca_repository_relations enable row level security;

revoke all on table public.ca_repository_symbols, public.ca_repository_relations
  from public, anon, authenticated;
grant all privileges on table public.ca_repository_symbols, public.ca_repository_relations
  to service_role;

create policy "ca_repository_symbols_browser_deny"
  on public.ca_repository_symbols
  as restrictive
  for all
  to anon, authenticated
  using (false)
  with check (false);

create policy "ca_repository_relations_browser_deny"
  on public.ca_repository_relations
  as restrictive
  for all
  to anon, authenticated
  using (false)
  with check (false);

create or replace function public.claim_repository_index_refreshes(
  p_limit integer default 1
)
returns setof public.ca_repository_indexes
language plpgsql
security invoker
set search_path = ''
as $$
begin
  return query
  with claimed as (
    select i.repository_id
    from public.ca_repository_indexes i
    where i.status = 'queued'
    order by i.refresh_requested_at nulls last, i.repository_id
    for update skip locked
    limit least(greatest(p_limit, 1), 10)
  )
  update public.ca_repository_indexes i
  set status = 'indexing',
      claimed_at = now(),
      started_at = now(),
      completed_at = null,
      last_error = null,
      progress_phase = 'provisioning',
      progress_current = 0,
      progress_total = 0,
      updated_at = now()
  from claimed
  where i.repository_id = claimed.repository_id
  returning i.*;
end;
$$;

revoke all on function public.claim_repository_index_refreshes(integer)
  from public, anon, authenticated;
grant execute on function public.claim_repository_index_refreshes(integer)
  to service_role;
