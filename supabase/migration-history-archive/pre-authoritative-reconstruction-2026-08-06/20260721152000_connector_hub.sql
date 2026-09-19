-- Connector Hub: one-time OAuth state and zero-credit event workflows.
-- Both tables are server-only. Connector metadata itself reuses project_integrations;
-- credentials continue to live encrypted in project_secrets.

create table if not exists public.connector_oauth_states (
  id uuid primary key default gen_random_uuid(),
  state_hash text not null unique,
  owner uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  provider text not null,
  code_verifier_encrypted text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.connector_workflows (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  enabled boolean not null default true,
  trigger_event text not null,
  action_provider text not null check (action_provider in (
    'app_email', 'app_sms', 'signed_webhook', 'slack_webhook', 'discord_webhook'
  )),
  config jsonb not null default '{}'::jsonb,
  last_run_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists connector_oauth_states_expiry_idx
  on public.connector_oauth_states(expires_at) where used_at is null;
create index if not exists connector_oauth_states_owner_project_idx
  on public.connector_oauth_states(owner, project_id);
create index if not exists connector_oauth_states_project_idx
  on public.connector_oauth_states(project_id);
create index if not exists connector_workflows_owner_project_idx
  on public.connector_workflows(owner, project_id, created_at desc);
create index if not exists connector_workflows_event_idx
  on public.connector_workflows(project_id, trigger_event) where enabled = true;

alter table public.connector_oauth_states enable row level security;
alter table public.connector_workflows enable row level security;

revoke all on table public.connector_oauth_states from anon, authenticated;
revoke all on table public.connector_workflows from anon, authenticated;
grant select, insert, update, delete on table public.connector_oauth_states to service_role;
grant select, insert, update, delete on table public.connector_workflows to service_role;
