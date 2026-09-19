-- Shared platform foundations for staged feature delivery.
-- Browser clients may read only their own non-secret records. All mutations are server-side.

create table if not exists public.feature_flags (
  key text primary key,
  enabled boolean not null default false,
  rollout_percent integer not null default 0 check (rollout_percent between 0 and 100),
  config jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.project_secrets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  owner uuid not null references auth.users(id) on delete cascade,
  environment text not null default 'test' check (environment in ('test', 'live')),
  name text not null,
  value_encrypted text not null,
  value_hint text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, environment, name)
);

create table if not exists public.project_integrations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  owner uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  environment text not null default 'test' check (environment in ('test', 'live')),
  status text not null default 'disconnected' check (status in ('disconnected', 'pending', 'connected', 'error')),
  config jsonb not null default '{}'::jsonb,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, environment, provider)
);

create table if not exists public.project_environments (
  project_id uuid not null references public.projects(id) on delete cascade,
  owner uuid not null references auth.users(id) on delete cascade,
  environment text not null check (environment in ('test', 'live')),
  config jsonb not null default '{}'::jsonb,
  schema_version integer not null default 1 check (schema_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id, environment)
);

create table if not exists public.project_releases (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  owner uuid not null references auth.users(id) on delete cascade,
  environment text not null default 'live' check (environment in ('test', 'live')),
  source_tree jsonb not null,
  release_config jsonb not null default '{}'::jsonb,
  schema_version integer not null default 1 check (schema_version > 0),
  status text not null default 'ready' check (status in ('building', 'ready', 'failed', 'rolled_back')),
  created_at timestamptz not null default now()
);

create table if not exists public.background_tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  owner uuid not null references auth.users(id) on delete cascade,
  type text not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  input jsonb not null default '{}'::jsonb,
  output jsonb,
  error text,
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.audit_events (
  id bigint generated always as identity primary key,
  owner uuid not null references auth.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null,
  target text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists project_secrets_owner_project_idx on public.project_secrets(owner, project_id);
create index if not exists project_integrations_owner_project_idx on public.project_integrations(owner, project_id);
create index if not exists project_releases_owner_project_created_idx on public.project_releases(owner, project_id, created_at desc);
create index if not exists background_tasks_ready_idx on public.background_tasks(status, available_at) where status = 'queued';
create index if not exists background_tasks_owner_project_idx on public.background_tasks(owner, project_id, created_at desc);
create index if not exists audit_events_owner_project_idx on public.audit_events(owner, project_id, created_at desc);

alter table public.feature_flags enable row level security;
alter table public.project_secrets enable row level security;
alter table public.project_integrations enable row level security;
alter table public.project_environments enable row level security;
alter table public.project_releases enable row level security;
alter table public.background_tasks enable row level security;
alter table public.audit_events enable row level security;

drop policy if exists project_integrations_owner_read on public.project_integrations;
create policy project_integrations_owner_read on public.project_integrations for select to authenticated
  using ((select auth.uid()) = owner);

drop policy if exists project_environments_owner_read on public.project_environments;
create policy project_environments_owner_read on public.project_environments for select to authenticated
  using ((select auth.uid()) = owner);

drop policy if exists project_releases_owner_read on public.project_releases;
create policy project_releases_owner_read on public.project_releases for select to authenticated
  using ((select auth.uid()) = owner);

drop policy if exists background_tasks_owner_read on public.background_tasks;
create policy background_tasks_owner_read on public.background_tasks for select to authenticated
  using ((select auth.uid()) = owner);

drop policy if exists audit_events_owner_read on public.audit_events;
create policy audit_events_owner_read on public.audit_events for select to authenticated
  using ((select auth.uid()) = owner);

revoke all on table public.feature_flags from anon, authenticated;
revoke all on table public.project_secrets from anon, authenticated;
revoke all on table public.project_integrations from anon, authenticated;
revoke all on table public.project_environments from anon, authenticated;
revoke all on table public.project_releases from anon, authenticated;
revoke all on table public.background_tasks from anon, authenticated;
revoke all on table public.audit_events from anon, authenticated;

grant select on table public.project_integrations to authenticated;
grant select on table public.project_environments to authenticated;
grant select on table public.project_releases to authenticated;
grant select on table public.background_tasks to authenticated;
grant select on table public.audit_events to authenticated;

insert into public.feature_flags(key, enabled, rollout_percent) values
  ('test_fix', false, 0),
  ('saas_runtime', false, 0),
  ('visual_editor', false, 0),
  ('owner_console', false, 0),
  ('github_export', false, 0),
  ('github_sync', false, 0),
  ('integrations', false, 0),
  ('analytics', false, 0),
  ('environments', false, 0),
  ('templates', false, 0)
on conflict (key) do nothing;
