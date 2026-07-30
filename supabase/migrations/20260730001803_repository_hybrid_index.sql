-- Privacy-first incremental repository index. Paths and source chunks are
-- encrypted by the control plane before storage. Only deterministic HMAC
-- token hashes and model embeddings are searchable.
create extension if not exists pgcrypto with schema extensions;

create table public.ca_repository_indexes (
  repository_id uuid primary key references public.ca_repositories(id) on delete cascade,
  owner uuid not null references auth.users(id) on delete cascade,
  version bigint not null default 0,
  head_sha text,
  status text not null default 'pending'
    check (status in ('pending', 'indexing', 'ready', 'error')),
  file_count integer not null default 0 check (file_count >= 0),
  chunk_count integer not null default 0 check (chunk_count >= 0),
  indexed_bytes bigint not null default 0 check (indexed_bytes >= 0),
  embedding_model text,
  last_error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.ca_repository_index_files
  add column path_hash text;
update public.ca_repository_index_files
  set path_hash = encode(extensions.digest(path_ciphertext, 'sha256'), 'hex')
  where path_hash is null;
alter table public.ca_repository_index_files
  alter column path_hash set not null;

alter table public.ca_repository_index_chunks
  add column content_ciphertext text;
update public.ca_repository_index_chunks
  set content_ciphertext = ''
  where content_ciphertext is null;
alter table public.ca_repository_index_chunks
  alter column content_ciphertext set not null,
  add column token_hashes text[] not null default '{}'::text[],
  add column symbol_hashes text[] not null default '{}'::text[],
  add column embedding_model text;

create unique index ca_index_files_repo_path_idx
  on public.ca_repository_index_files(repository_id, path_hash);
create index ca_repository_indexes_owner_idx
  on public.ca_repository_indexes(owner);
create index ca_index_chunks_file_lines_idx
  on public.ca_repository_index_chunks(file_id, start_line);
create index ca_index_chunks_token_hashes_idx
  on public.ca_repository_index_chunks using gin(token_hashes);
create index ca_index_chunks_embedding_hnsw_idx
  on public.ca_repository_index_chunks
  using hnsw (embedding extensions.vector_cosine_ops)
  where embedding is not null;

alter table public.ca_repository_indexes enable row level security;
revoke all on table public.ca_repository_indexes from public, anon, authenticated;
grant all privileges on table public.ca_repository_indexes to service_role;

create policy "ca_repository_indexes_browser_deny"
  on public.ca_repository_indexes
  as restrictive
  for all
  to anon, authenticated
  using (false)
  with check (false);

create or replace function public.search_repository_index(
  p_owner uuid,
  p_repository_id uuid,
  p_query_embedding extensions.vector(1536),
  p_token_hashes text[],
  p_match_count integer default 12
)
returns table (
  chunk_id uuid,
  file_id uuid,
  keyword_rank bigint,
  semantic_rank bigint,
  score double precision
)
language sql
security invoker
set search_path = ''
as $$
  with keyword_candidates as (
    select
      c.id,
      row_number() over (
        order by cardinality(array(
          select unnest(c.token_hashes)
          intersect
          select unnest(coalesce(p_token_hashes, '{}'::text[]))
        )) desc, c.start_line
      ) as rank_ix
    from public.ca_repository_index_chunks c
    where c.owner = p_owner
      and c.repository_id = p_repository_id
      and cardinality(coalesce(p_token_hashes, '{}'::text[])) > 0
      and c.token_hashes && p_token_hashes
    order by rank_ix
    limit least(greatest(p_match_count, 1), 30) * 2
  ),
  semantic_candidates as (
    select
      c.id,
      row_number() over (
        order by c.embedding operator(extensions.<=>) p_query_embedding
      ) as rank_ix
    from public.ca_repository_index_chunks c
    where c.owner = p_owner
      and c.repository_id = p_repository_id
      and p_query_embedding is not null
      and c.embedding is not null
    order by rank_ix
    limit least(greatest(p_match_count, 1), 30) * 2
  )
  select
    c.id as chunk_id,
    c.file_id,
    keyword_candidates.rank_ix as keyword_rank,
    semantic_candidates.rank_ix as semantic_rank,
    (
      coalesce(1.0 / (50 + keyword_candidates.rank_ix), 0.0) * 1.35
      + coalesce(1.0 / (50 + semantic_candidates.rank_ix), 0.0)
    )::double precision as score
  from keyword_candidates
  full outer join semantic_candidates
    on keyword_candidates.id = semantic_candidates.id
  join public.ca_repository_index_chunks c
    on c.id = coalesce(keyword_candidates.id, semantic_candidates.id)
  order by score desc, c.start_line
  limit least(greatest(p_match_count, 1), 30);
$$;

revoke all on function public.search_repository_index(
  uuid, uuid, extensions.vector, text[], integer
) from public, anon, authenticated;
grant execute on function public.search_repository_index(
  uuid, uuid, extensions.vector, text[], integer
) to service_role;
