-- Thrallo model connections. API keys and Codex auth state are encrypted by
-- the shell before insertion and remain completely server-only.
create table public.ca_ai_credentials (
  owner uuid not null references auth.users(id) on delete cascade,
  provider text not null
    check (provider in ('codex', 'openai', 'anthropic')),
  auth_mode text not null
    check (auth_mode in ('chatgpt', 'api_key')),
  secret_encrypted text not null,
  secret_hint text not null,
  status text not null default 'connected'
    check (status in ('connected', 'error')),
  metadata jsonb not null default '{}'::jsonb,
  last_error text,
  last_verified_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner, provider),
  check (
    (provider = 'codex' and auth_mode = 'chatgpt')
    or (provider in ('openai', 'anthropic') and auth_mode = 'api_key')
  )
);

create table public.ca_ai_preferences (
  owner uuid primary key references auth.users(id) on delete cascade,
  active_provider text not null default 'managed'
    check (active_provider in ('managed', 'codex', 'openai', 'anthropic')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index ca_ai_credentials_provider_status_idx
  on public.ca_ai_credentials(provider, status);

alter table public.ca_ai_credentials enable row level security;
alter table public.ca_ai_preferences enable row level security;

revoke all on table public.ca_ai_credentials, public.ca_ai_preferences
  from public, anon, authenticated;
grant all privileges on table public.ca_ai_credentials, public.ca_ai_preferences
  to service_role;

create policy "ca_ai_credentials_browser_deny"
  on public.ca_ai_credentials
  as restrictive
  for all
  to anon, authenticated
  using (false)
  with check (false);

create policy "ca_ai_preferences_browser_deny"
  on public.ca_ai_preferences
  as restrictive
  for all
  to anon, authenticated
  using (false)
  with check (false);
