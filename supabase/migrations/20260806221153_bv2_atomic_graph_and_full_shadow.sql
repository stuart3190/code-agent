-- Builder V2 atomic graph persistence and complete shadow evidence (C4/H3).
--
-- This migration is additive and is NOT safe to apply remotely without the normal production
-- backup, upgrade-dry-run, and approval gates. Historical migrations remain immutable.
--
-- Forward repair:
--   Re-run public.bv2_persist_file_revision for every manifest entry. Rows quarantined in
--   state=building are replaced atomically; a conflicting ready graph fails closed.
--
-- Rollback before customer V2 rollout:
--   1. Stop the shadow timer/call site (Builder V1 remains unaffected).
--   2. Drop the five bv2_* RPCs below, then bv2_shadow_checks, bv2_shadow_run_files and
--      bv2_shadow_runs.
--   3. Drop the added composite constraints/indexes and graph metadata columns only after
--      confirming no newer code reads them. Existing revision/symbol/ref/edge rows remain.
-- A forward repair is preferred after deployment because dropping state/count metadata would
-- remove the proof that readers use to reject incomplete revisions.

alter table public.projects
  add constraint projects_id_owner_unique unique (id, owner);

alter table public.bv2_file_revisions
  add column state text not null default 'building',
  add column indexer_version text,
  add column graph_hash text,
  add column symbol_count integer not null default 0,
  add column ref_count integer not null default 0,
  add column edge_count integer not null default 0,
  add column completed_at timestamptz;

-- A row written by the old multi-request path cannot prove that its children completed. Keep it
-- invisible until the atomic RPC repairs it. Production had zero graph rows at baseline, but this
-- also makes upgrades from any non-empty test environment fail closed.
update public.bv2_file_revisions
set state = 'building', graph_hash = null, completed_at = null;

alter table public.bv2_file_revisions
  add constraint bv2_file_revisions_state_check check (state in ('building', 'ready')),
  add constraint bv2_file_revisions_hash_check check (content_hash ~ '^[0-9a-f]{64}$'),
  add constraint bv2_file_revisions_graph_hash_check
    check (graph_hash is null or graph_hash ~ '^[0-9a-f]{64}$'),
  add constraint bv2_file_revisions_counts_check
    check (symbol_count >= 0 and ref_count >= 0 and edge_count >= 0),
  add constraint bv2_file_revisions_ready_check
    check (
      (state = 'building' and completed_at is null)
      or
      (state = 'ready' and graph_hash is not null and indexer_version is not null and completed_at is not null)
    ),
  add constraint bv2_file_revisions_id_owner_project_path_unique
    unique (id, owner, project_id, path),
  add constraint bv2_file_revisions_id_owner_project_unique
    unique (id, owner, project_id),
  add constraint bv2_file_revisions_id_owner_project_path_hash_unique
    unique (id, owner, project_id, path, content_hash),
  add constraint bv2_file_revisions_project_owner_fkey
    foreign key (project_id, owner) references public.projects(id, owner) on delete cascade;

create index bv2_file_revisions_owner_project_state_path
  on public.bv2_file_revisions (owner, project_id, state, path, indexed_at desc);

alter table public.bv2_symbols add column ordinal integer;
with numbered as (
  select id, row_number() over (partition by revision_id order by start_offset, id) - 1 as ordinal
  from public.bv2_symbols
)
update public.bv2_symbols as symbol
set ordinal = numbered.ordinal
from numbered
where numbered.id = symbol.id;
alter table public.bv2_symbols
  alter column ordinal set not null,
  add constraint bv2_symbols_ordinal_check check (ordinal >= 0),
  add constraint bv2_symbols_revision_ordinal_unique unique (revision_id, ordinal),
  add constraint bv2_symbols_id_revision_owner_project_unique
    unique (id, revision_id, owner, project_id),
  add constraint bv2_symbols_revision_owner_project_path_fkey
    foreign key (revision_id, owner, project_id, path)
    references public.bv2_file_revisions(id, owner, project_id, path) on delete cascade;

alter table public.bv2_symbol_refs add column ordinal integer;
with numbered as (
  select id, row_number() over (partition by revision_id order by id) - 1 as ordinal
  from public.bv2_symbol_refs
)
update public.bv2_symbol_refs as ref
set ordinal = numbered.ordinal
from numbered
where numbered.id = ref.id;
alter table public.bv2_symbol_refs
  alter column ordinal set not null,
  add constraint bv2_symbol_refs_ordinal_check check (ordinal >= 0),
  add constraint bv2_symbol_refs_revision_ordinal_unique unique (revision_id, ordinal),
  add constraint bv2_symbol_refs_revision_owner_project_fkey
    foreign key (revision_id, owner, project_id)
    references public.bv2_file_revisions(id, owner, project_id) on delete cascade,
  add constraint bv2_symbol_refs_symbol_revision_owner_project_fkey
    foreign key (from_symbol, revision_id, owner, project_id)
    references public.bv2_symbols(id, revision_id, owner, project_id) on delete cascade;

alter table public.bv2_dependency_edges add column ordinal integer;
with numbered as (
  select id, row_number() over (partition by revision_id order by id) - 1 as ordinal
  from public.bv2_dependency_edges
)
update public.bv2_dependency_edges as edge
set ordinal = numbered.ordinal
from numbered
where numbered.id = edge.id;
alter table public.bv2_dependency_edges
  alter column ordinal set not null,
  add constraint bv2_dependency_edges_ordinal_check check (ordinal >= 0),
  add constraint bv2_dependency_edges_revision_ordinal_unique unique (revision_id, ordinal),
  add constraint bv2_dependency_edges_revision_owner_project_path_fkey
    foreign key (revision_id, owner, project_id, from_path)
    references public.bv2_file_revisions(id, owner, project_id, path) on delete cascade;

create table public.bv2_shadow_runs (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null,
  project_id uuid not null,
  build_id text,
  tree_hash text not null check (tree_hash ~ '^[0-9a-f]{64}$'),
  file_count integer not null check (file_count > 0),
  status text not null default 'validating'
    check (status in ('validating', 'clean', 'drift', 'failed', 'stale')),
  indexed_at timestamptz not null default now(),
  validated_at timestamptz,
  unique (id, owner, project_id),
  foreign key (project_id, owner) references public.projects(id, owner) on delete cascade
);
create index bv2_shadow_runs_owner_project_indexed
  on public.bv2_shadow_runs (owner, project_id, indexed_at desc);

create table public.bv2_shadow_run_files (
  shadow_run_id uuid not null,
  owner uuid not null,
  project_id uuid not null,
  path text not null,
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  revision_id uuid not null,
  primary key (shadow_run_id, path),
  foreign key (shadow_run_id, owner, project_id)
    references public.bv2_shadow_runs(id, owner, project_id) on delete cascade,
  foreign key (revision_id, owner, project_id, path, content_hash)
    references public.bv2_file_revisions(id, owner, project_id, path, content_hash)
    on delete no action deferrable initially deferred
);
create index bv2_shadow_run_files_revision on public.bv2_shadow_run_files (revision_id);

create table public.bv2_shadow_checks (
  id uuid primary key default gen_random_uuid(),
  shadow_run_id uuid not null,
  owner uuid not null,
  project_id uuid not null,
  status text not null check (status in ('clean', 'drift', 'failed', 'stale')),
  evidence jsonb not null,
  checked_at timestamptz not null default now(),
  foreign key (shadow_run_id, owner, project_id)
    references public.bv2_shadow_runs(id, owner, project_id) on delete cascade
);
create index bv2_shadow_checks_run_checked
  on public.bv2_shadow_checks (shadow_run_id, checked_at desc);

alter table public.bv2_shadow_runs enable row level security;
alter table public.bv2_shadow_run_files enable row level security;
alter table public.bv2_shadow_checks enable row level security;
revoke all on table
  public.bv2_shadow_runs,
  public.bv2_shadow_run_files,
  public.bv2_shadow_checks
from public, anon, authenticated;
grant all privileges on table
  public.bv2_shadow_runs,
  public.bv2_shadow_run_files,
  public.bv2_shadow_checks
to service_role;

create or replace function public.bv2_persist_file_revision(
  p_owner uuid,
  p_project_id uuid,
  p_file jsonb,
  p_symbols jsonb,
  p_refs jsonb,
  p_edges jsonb,
  p_graph_hash text,
  p_indexer_version text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_revision public.bv2_file_revisions%rowtype;
  v_revision_id uuid;
  v_existing boolean := false;
  v_actual_symbols integer;
  v_actual_refs integer;
  v_actual_edges integer;
  v_symbol_count integer;
  v_ref_count integer;
  v_edge_count integer;
  v_path text := p_file->>'path';
  v_content_hash text := p_file->>'content_hash';
begin
  if not exists (
    select 1 from public.projects where id = p_project_id and owner = p_owner
  ) then
    raise exception 'project does not belong to owner' using errcode = '42501';
  end if;
  if jsonb_typeof(p_symbols) <> 'array'
    or jsonb_typeof(p_refs) <> 'array'
    or jsonb_typeof(p_edges) <> 'array' then
    raise exception 'symbols, refs and edges must be arrays' using errcode = '22023';
  end if;
  if coalesce(v_path, '') = ''
    or v_content_hash !~ '^[0-9a-f]{64}$'
    or p_graph_hash !~ '^[0-9a-f]{64}$'
    or coalesce(p_indexer_version, '') = '' then
    raise exception 'invalid file revision identity' using errcode = '22023';
  end if;

  v_symbol_count := jsonb_array_length(p_symbols);
  v_ref_count := jsonb_array_length(p_refs);
  v_edge_count := jsonb_array_length(p_edges);

  -- One transaction-scoped lock per immutable identity makes two simultaneous RPC calls converge
  -- on one row without holding locks outside this short database-only transaction.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_owner::text || ':' || p_project_id::text || ':' || v_path || ':' || v_content_hash, 0)
  );

  select * into v_revision
  from public.bv2_file_revisions
  where owner = p_owner and project_id = p_project_id
    and path = v_path and content_hash = v_content_hash
  for update;

  if found then
    v_existing := true;
    v_revision_id := v_revision.id;
    select count(*) into v_actual_symbols from public.bv2_symbols where revision_id = v_revision_id;
    select count(*) into v_actual_refs from public.bv2_symbol_refs where revision_id = v_revision_id;
    select count(*) into v_actual_edges from public.bv2_dependency_edges where revision_id = v_revision_id;

    if v_revision.state = 'ready' then
      if v_revision.graph_hash <> p_graph_hash
        or v_revision.indexer_version <> p_indexer_version
        or v_revision.size_bytes <> (p_file->>'size_bytes')::integer
        or v_revision.tokens <> (p_file->>'tokens')::integer
        or v_revision.opaque <> (p_file->>'opaque')::boolean then
        raise exception 'conflicting graph for immutable file revision' using errcode = '23505';
      end if;
      if v_revision.symbol_count = v_symbol_count
        and v_revision.ref_count = v_ref_count
        and v_revision.edge_count = v_edge_count
        and v_actual_symbols = v_symbol_count
        and v_actual_refs = v_ref_count
        and v_actual_edges = v_edge_count then
        return jsonb_build_object('revision_id', v_revision_id, 'written', false, 'repaired', false);
      end if;
    end if;

    update public.bv2_file_revisions
    set state = 'building', graph_hash = null, completed_at = null,
        indexer_version = p_indexer_version,
        size_bytes = (p_file->>'size_bytes')::integer,
        tokens = (p_file->>'tokens')::integer,
        opaque = (p_file->>'opaque')::boolean,
        symbol_count = 0, ref_count = 0, edge_count = 0
    where id = v_revision_id;
    delete from public.bv2_symbols where revision_id = v_revision_id;
    delete from public.bv2_dependency_edges where revision_id = v_revision_id;
  else
    insert into public.bv2_file_revisions (
      owner, project_id, path, content_hash, size_bytes, tokens, opaque, state, indexer_version
    ) values (
      p_owner, p_project_id, v_path, v_content_hash,
      (p_file->>'size_bytes')::integer, (p_file->>'tokens')::integer,
      (p_file->>'opaque')::boolean, 'building', p_indexer_version
    ) returning id into v_revision_id;
  end if;

  insert into public.bv2_symbols (
    owner, project_id, revision_id, path, ordinal, name, kind, exported, is_default,
    start_offset, end_offset, block_hash, meta
  )
  select p_owner, p_project_id, v_revision_id, v_path, (item.ordinality - 1)::integer,
    item.value->>'name', item.value->>'kind',
    coalesce((item.value->>'exported')::boolean, false),
    coalesce((item.value->>'is_default')::boolean, false),
    (item.value->>'start_offset')::integer, (item.value->>'end_offset')::integer,
    item.value->>'block_hash', coalesce(item.value->'meta', '{}'::jsonb)
  from jsonb_array_elements(p_symbols) with ordinality as item(value, ordinality);

  if exists (
    select 1
    from jsonb_array_elements(p_refs) as ref(value)
    where not exists (
      select 1 from public.bv2_symbols as symbol
      where symbol.revision_id = v_revision_id
        and symbol.ordinal = (ref.value->>'from_symbol_ordinal')::integer
    )
  ) then
    raise exception 'reference points to a missing source symbol' using errcode = '23503';
  end if;

  insert into public.bv2_symbol_refs (
    owner, project_id, revision_id, ordinal, from_symbol, ref_name, resolved_path, count
  )
  select p_owner, p_project_id, v_revision_id, (item.ordinality - 1)::integer,
    symbol.id, item.value->>'ref_name', item.value->>'resolved_path',
    coalesce((item.value->>'count')::integer, 1)
  from jsonb_array_elements(p_refs) with ordinality as item(value, ordinality)
  join public.bv2_symbols as symbol
    on symbol.revision_id = v_revision_id
   and symbol.ordinal = (item.value->>'from_symbol_ordinal')::integer;

  insert into public.bv2_dependency_edges (
    owner, project_id, revision_id, ordinal, from_path, to_path, specifier
  )
  select p_owner, p_project_id, v_revision_id, (item.ordinality - 1)::integer,
    v_path, item.value->>'to_path', item.value->>'specifier'
  from jsonb_array_elements(p_edges) with ordinality as item(value, ordinality);

  update public.bv2_file_revisions
  set state = 'ready', graph_hash = p_graph_hash,
      symbol_count = v_symbol_count, ref_count = v_ref_count, edge_count = v_edge_count,
      completed_at = pg_catalog.clock_timestamp()
  where id = v_revision_id;

  return jsonb_build_object(
    'revision_id', v_revision_id,
    'written', true,
    'repaired', v_existing
  );
end;
$$;

create or replace function public.bv2_load_graph(
  p_owner uuid,
  p_project_id uuid,
  p_manifest jsonb
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not exists (
    select 1 from public.projects where id = p_project_id and owner = p_owner
  ) then
    raise exception 'project does not belong to owner' using errcode = '42501';
  end if;
  if jsonb_typeof(p_manifest) <> 'object' then
    raise exception 'manifest must be an object' using errcode = '22023';
  end if;

  with requested as (
    select key as path, value as content_hash from jsonb_each_text(p_manifest)
  ), selected as (
    select revision.*
    from public.bv2_file_revisions as revision
    join requested using (path, content_hash)
    where revision.owner = p_owner and revision.project_id = p_project_id
  )
  select jsonb_build_object(
    'revisions', coalesce((select jsonb_agg(to_jsonb(row) order by row.path) from selected as row), '[]'::jsonb),
    'symbols', coalesce((
      select jsonb_agg(to_jsonb(symbol) order by symbol.revision_id, symbol.ordinal)
      from public.bv2_symbols as symbol join selected on selected.id = symbol.revision_id
    ), '[]'::jsonb),
    'refs', coalesce((
      select jsonb_agg(to_jsonb(ref) order by ref.revision_id, ref.ordinal)
      from public.bv2_symbol_refs as ref join selected on selected.id = ref.revision_id
    ), '[]'::jsonb),
    'edges', coalesce((
      select jsonb_agg(to_jsonb(edge) order by edge.revision_id, edge.ordinal)
      from public.bv2_dependency_edges as edge join selected on selected.id = edge.revision_id
    ), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;

create or replace function public.bv2_begin_shadow_run(
  p_owner uuid,
  p_project_id uuid,
  p_build_id text,
  p_tree_hash text,
  p_manifest jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_run_id uuid;
  v_expected integer;
  v_inserted integer;
begin
  if not exists (
    select 1 from public.projects where id = p_project_id and owner = p_owner
  ) then
    raise exception 'project does not belong to owner' using errcode = '42501';
  end if;
  if jsonb_typeof(p_manifest) <> 'object' or p_tree_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid shadow manifest' using errcode = '22023';
  end if;
  v_expected := (select count(*) from jsonb_each_text(p_manifest));
  if v_expected = 0 then
    raise exception 'shadow manifest cannot be empty' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('bv2-shadow:' || p_owner::text || ':' || p_project_id::text, 0)
  );
  insert into public.bv2_shadow_runs (owner, project_id, build_id, tree_hash, file_count)
  values (p_owner, p_project_id, p_build_id, p_tree_hash, v_expected)
  returning id into v_run_id;

  insert into public.bv2_shadow_run_files (
    shadow_run_id, owner, project_id, path, content_hash, revision_id
  )
  select v_run_id, p_owner, p_project_id, requested.path, requested.content_hash, revision.id
  from jsonb_each_text(p_manifest) as requested(path, content_hash)
  join public.bv2_file_revisions as revision
    on revision.owner = p_owner and revision.project_id = p_project_id
   and revision.path = requested.path and revision.content_hash = requested.content_hash
   and revision.state = 'ready';
  get diagnostics v_inserted = row_count;
  if v_inserted <> v_expected then
    raise exception 'shadow manifest references missing or incomplete revisions' using errcode = '23503';
  end if;

  insert into public.bv2_migration_state (owner, project_id, state, last_shadow_at, notes)
  values (
    p_owner, p_project_id, 'shadow', pg_catalog.clock_timestamp(),
    jsonb_build_object(
      'buildId', p_build_id, 'treeHash', p_tree_hash, 'files', v_expected,
      'shadowRunId', v_run_id, 'status', 'validating'
    )
  )
  on conflict (owner, project_id) do update
    set state = 'shadow', last_shadow_at = excluded.last_shadow_at, notes = excluded.notes;
  return v_run_id;
end;
$$;

create or replace function public.bv2_record_shadow_check(
  p_owner uuid,
  p_project_id uuid,
  p_shadow_run_id uuid,
  p_status text,
  p_evidence jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_check_id uuid;
begin
  if p_status not in ('clean', 'drift', 'failed', 'stale')
    or jsonb_typeof(p_evidence) <> 'object' then
    raise exception 'invalid shadow check' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.bv2_shadow_runs
    where id = p_shadow_run_id and owner = p_owner and project_id = p_project_id
  ) then
    raise exception 'shadow run does not belong to owner/project' using errcode = '42501';
  end if;

  insert into public.bv2_shadow_checks (
    shadow_run_id, owner, project_id, status, evidence
  ) values (
    p_shadow_run_id, p_owner, p_project_id, p_status, p_evidence
  ) returning id into v_check_id;

  update public.bv2_shadow_runs
  set status = p_status, validated_at = pg_catalog.clock_timestamp()
  where id = p_shadow_run_id and owner = p_owner and project_id = p_project_id;
  update public.bv2_migration_state
  set notes = notes || jsonb_build_object(
    'shadowRunId', p_shadow_run_id, 'status', p_status,
    'lastCheckId', v_check_id, 'lastCheckAt', pg_catalog.clock_timestamp()
  )
  where owner = p_owner and project_id = p_project_id;
  return v_check_id;
end;
$$;

create or replace function public.bv2_gc_file_revisions(
  p_owner uuid,
  p_project_id uuid,
  p_before timestamptz
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if not exists (
    select 1 from public.projects where id = p_project_id and owner = p_owner
  ) then
    raise exception 'project does not belong to owner' using errcode = '42501';
  end if;
  with ranked as (
    select revision.id,
      row_number() over (partition by revision.path order by revision.indexed_at desc, revision.id desc) as recency
    from public.bv2_file_revisions as revision
    where revision.owner = p_owner and revision.project_id = p_project_id
  ), candidates as (
    select revision.id
    from public.bv2_file_revisions as revision
    join ranked on ranked.id = revision.id and ranked.recency > 1
    where revision.owner = p_owner and revision.project_id = p_project_id
      and revision.indexed_at < p_before
      and not exists (
        select 1 from public.bv2_shadow_run_files as shadow_file
        where shadow_file.revision_id = revision.id
      )
      and not exists (
        select 1
        from public.bv2_snapshot_files as snapshot_file
        join public.bv2_snapshots as snapshot on snapshot.id = snapshot_file.snapshot_id
        where snapshot.owner = revision.owner and snapshot.project_id = revision.project_id
          and snapshot.state in ('building', 'ready')
          and snapshot_file.path = revision.path
          and snapshot_file.content_hash = revision.content_hash
      )
  )
  delete from public.bv2_file_revisions as revision
  using candidates
  where revision.id = candidates.id;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.bv2_persist_file_revision(uuid, uuid, jsonb, jsonb, jsonb, jsonb, text, text)
  from public, anon, authenticated;
revoke all on function public.bv2_load_graph(uuid, uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.bv2_begin_shadow_run(uuid, uuid, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.bv2_record_shadow_check(uuid, uuid, uuid, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.bv2_gc_file_revisions(uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.bv2_persist_file_revision(uuid, uuid, jsonb, jsonb, jsonb, jsonb, text, text)
  to service_role;
grant execute on function public.bv2_load_graph(uuid, uuid, jsonb)
  to service_role;
grant execute on function public.bv2_begin_shadow_run(uuid, uuid, text, text, jsonb)
  to service_role;
grant execute on function public.bv2_record_shadow_check(uuid, uuid, uuid, text, jsonb)
  to service_role;
grant execute on function public.bv2_gc_file_revisions(uuid, uuid, timestamptz)
  to service_role;
