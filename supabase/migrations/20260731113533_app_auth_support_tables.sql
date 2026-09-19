-- Support tables the app-auth Edge Function reads/writes (service-role only, deny-all RLS):
-- abuse-guard event log and password-reset codes.
create table if not exists public.app_auth_events (
  id uuid primary key default gen_random_uuid(),
  app_id text,
  kind text not null,
  ip_hash text,
  target_hash text,
  created_at timestamptz not null default now()
);
create index if not exists app_auth_events_kind_time_idx on public.app_auth_events (kind, created_at desc);

create table if not exists public.app_password_resets (
  id uuid primary key default gen_random_uuid(),
  app_id text not null,
  email text not null,
  code_hash text not null,
  attempts int not null default 0,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists app_password_resets_lookup_idx on public.app_password_resets (app_id, lower(email), created_at desc);

alter table public.app_auth_events enable row level security;
alter table public.app_password_resets enable row level security;
revoke all on table public.app_auth_events, public.app_password_resets from public, anon, authenticated;
grant all privileges on table public.app_auth_events, public.app_password_resets to service_role;