-- BUILDER V2 FOUNDATION (docs/BUILDER-V2-MASTER-PLAN.md Part 3, corrections C1/C2 applied).
-- Entirely ADDITIVE; rollback = reverse drops in the repo migration header.

create table if not exists public.bv2_feature_flags (
  key text primary key,
  value jsonb not null default 'false',
  updated_at timestamptz not null default now(),
  updated_by text
);

create table if not exists public.bv2_migration_state (
  owner uuid not null,
  project_id uuid not null,
  state text not null default 'v1',
  adopted_at timestamptz,
  last_shadow_at timestamptz,
  notes jsonb not null default '{}',
  primary key (owner, project_id)
);

create table if not exists public.bv2_project_knowledge (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null,
  project_id uuid not null,
  kind text not null,
  key text not null,
  value jsonb not null,
  source_build uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner, project_id, kind, key)
);
create index if not exists bv2_project_knowledge_project_kind
  on public.bv2_project_knowledge (project_id, kind);

create table if not exists public.bv2_file_revisions (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null,
  project_id uuid not null,
  path text not null,
  content_hash text not null,
  size_bytes int not null,
  tokens int not null,
  opaque boolean not null default false,
  indexed_at timestamptz not null default now(),
  unique (owner, project_id, path, content_hash)
);
create index if not exists bv2_file_revisions_project_path
  on public.bv2_file_revisions (project_id, path);

create table if not exists public.bv2_symbols (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null,
  project_id uuid not null,
  revision_id uuid not null references public.bv2_file_revisions(id) on delete cascade,
  path text not null,
  name text not null,
  kind text not null,
  exported boolean not null default false,
  is_default boolean not null default false,
  start_offset int not null,
  end_offset int not null,
  block_hash text not null,
  meta jsonb not null default '{}'
);
create index if not exists bv2_symbols_revision on public.bv2_symbols (revision_id);
create index if not exists bv2_symbols_project_name on public.bv2_symbols (project_id, name);

create table if not exists public.bv2_symbol_refs (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null,
  project_id uuid not null,
  revision_id uuid not null references public.bv2_file_revisions(id) on delete cascade,
  from_symbol uuid not null references public.bv2_symbols(id) on delete cascade,
  ref_name text not null,
  resolved_path text,
  count int not null default 1
);
create index if not exists bv2_symbol_refs_project_ref
  on public.bv2_symbol_refs (project_id, ref_name);

create table if not exists public.bv2_dependency_edges (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null,
  project_id uuid not null,
  revision_id uuid not null references public.bv2_file_revisions(id) on delete cascade,
  from_path text not null,
  to_path text,
  specifier text not null
);
create index if not exists bv2_dependency_edges_from
  on public.bv2_dependency_edges (project_id, from_path);
create index if not exists bv2_dependency_edges_to
  on public.bv2_dependency_edges (project_id, to_path);

create table if not exists public.bv2_snapshots (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null,
  project_id uuid not null,
  build_id uuid,
  parent_snapshot uuid references public.bv2_snapshots(id),
  tree_hash text not null,
  label text,
  reason text not null,
  file_count int not null,
  total_tokens int not null,
  asset_manifest jsonb not null default '[]',
  state text not null default 'building',
  created_at timestamptz not null default now()
);
create index if not exists bv2_snapshots_project_created
  on public.bv2_snapshots (project_id, created_at);
create unique index if not exists bv2_snapshots_project_tree
  on public.bv2_snapshots (project_id, tree_hash);

create table if not exists public.bv2_project_pointers (
  owner uuid not null,
  project_id uuid not null,
  label text not null,
  snapshot_id uuid not null references public.bv2_snapshots(id),
  updated_at timestamptz not null default now(),
  primary key (owner, project_id, label)
);

create table if not exists public.bv2_snapshot_files (
  snapshot_id uuid not null references public.bv2_snapshots(id) on delete cascade,
  path text not null,
  content_hash text not null,
  primary key (snapshot_id, path)
);

create table if not exists public.bv2_blobs (
  owner uuid not null,
  content_hash text not null,
  content text,
  storage_path text,
  size_bytes int not null,
  created_at timestamptz not null default now(),
  primary key (owner, content_hash)
);

create table if not exists public.bv2_contracts (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null,
  project_id uuid not null,
  build_id uuid,
  version int not null,
  contract jsonb not null,
  capabilities jsonb not null default '[]',
  created_at timestamptz not null default now()
);

create table if not exists public.bv2_retrieval_traces (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null,
  build_id uuid not null,
  step text not null,
  snapshot_id uuid,
  query jsonb not null,
  included jsonb not null,
  omitted_count int not null,
  tokens int not null,
  created_at timestamptz not null default now()
);

create table if not exists public.bv2_patches (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null,
  build_id uuid not null,
  step text not null,
  model_call_id uuid,
  patch jsonb not null,
  outcome text not null,
  reject_reason text,
  files_changed jsonb not null default '[]',
  created_at timestamptz not null default now()
);

create table if not exists public.bv2_verification_cache (
  owner uuid not null,
  project_id uuid not null,
  journey_id text not null,
  owners_hash text not null,
  verdict jsonb not null,
  snapshot_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (owner, project_id, journey_id, owners_hash)
);

create table if not exists public.bv2_builds (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null,
  project_id uuid not null,
  profile text not null,
  request text not null,
  state text not null default 'created',
  budget_credits numeric,
  spent_credits numeric not null default 0,
  contract_id uuid,
  final_snapshot uuid,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists bv2_builds_owner_project
  on public.bv2_builds (owner, project_id, started_at);

create table if not exists public.bv2_assets (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null,
  project_id uuid not null,
  provider text not null,
  provider_asset_id text not null,
  original_url text not null,
  optimised_url text,
  thumbnail_url text,
  storage_path text,
  search_query text,
  intent text,
  category text,
  tags jsonb not null default '[]',
  page text,
  section text,
  slot text,
  alt_text text not null default '',
  width int,
  height int,
  orientation text,
  license jsonb not null default '{}',
  content_hash text,
  variants jsonb not null default '{}',
  usage_count int not null default 0,
  last_used timestamptz,
  created_at timestamptz not null default now(),
  unique (owner, project_id, provider, provider_asset_id, slot)
);
create index if not exists bv2_assets_project_intent on public.bv2_assets (project_id, intent);
create index if not exists bv2_assets_project_hash on public.bv2_assets (project_id, content_hash);

alter table public.ai_requests add column if not exists trace_id uuid;
alter table public.ai_requests add column if not exists parent_id uuid;
alter table public.ai_requests add column if not exists step text;
alter table public.diag_steps add column if not exists trace_id uuid;
alter table public.diag_steps add column if not exists parent_id uuid;

alter table public.bv2_feature_flags       enable row level security;
alter table public.bv2_migration_state     enable row level security;
alter table public.bv2_project_knowledge   enable row level security;
alter table public.bv2_file_revisions      enable row level security;
alter table public.bv2_symbols             enable row level security;
alter table public.bv2_symbol_refs         enable row level security;
alter table public.bv2_dependency_edges    enable row level security;
alter table public.bv2_snapshots           enable row level security;
alter table public.bv2_project_pointers    enable row level security;
alter table public.bv2_snapshot_files      enable row level security;
alter table public.bv2_blobs               enable row level security;
alter table public.bv2_contracts           enable row level security;
alter table public.bv2_retrieval_traces    enable row level security;
alter table public.bv2_patches             enable row level security;
alter table public.bv2_verification_cache  enable row level security;
alter table public.bv2_builds              enable row level security;
alter table public.bv2_assets              enable row level security;