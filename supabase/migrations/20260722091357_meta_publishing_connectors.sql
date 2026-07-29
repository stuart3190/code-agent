-- Per-end-user OAuth connections for generated apps. Tokens remain encrypted and server-only;
-- generated clients receive only safe account metadata through the runtime connector route.

create table if not exists public.app_user_integrations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  app_user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider ~ '^[a-z][a-z0-9_]{1,39}$'),
  status text not null default 'connected' check (status in ('connected','error','disconnected')),
  config jsonb not null default '{}'::jsonb,
  access_token_encrypted text not null,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(project_id, app_user_id, provider)
);

create table if not exists public.app_connector_oauth_states (
  id uuid primary key default gen_random_uuid(),
  state_hash text not null unique,
  project_id uuid not null references public.projects(id) on delete cascade,
  app_user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider ~ '^[a-z][a-z0-9_]{1,39}$'),
  return_origin text not null check (char_length(return_origin) between 8 and 500),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists app_user_integrations_user_idx
  on public.app_user_integrations(app_user_id, project_id);
create index if not exists app_user_integrations_project_provider_idx
  on public.app_user_integrations(project_id, provider) where status = 'connected';
create index if not exists app_connector_oauth_states_expiry_idx
  on public.app_connector_oauth_states(expires_at) where used_at is null;
create index if not exists app_connector_oauth_states_user_idx
  on public.app_connector_oauth_states(app_user_id, project_id);
create index if not exists app_connector_oauth_states_project_idx
  on public.app_connector_oauth_states(project_id);

alter table public.app_user_integrations enable row level security;
alter table public.app_connector_oauth_states enable row level security;

revoke all on table public.app_user_integrations from anon, authenticated;
revoke all on table public.app_connector_oauth_states from anon, authenticated;
grant select, insert, update, delete on table public.app_user_integrations to service_role;
grant select, insert, update, delete on table public.app_connector_oauth_states to service_role;
