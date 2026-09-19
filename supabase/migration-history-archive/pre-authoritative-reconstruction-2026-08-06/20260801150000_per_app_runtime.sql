-- Per-app backend runtime (the deferred "generated-app runtime story", now delivered):
-- `entities` — the generic jsonb store every generated app's db.entity() uses, owner-scoped
-- RLS (owner = auth.uid(), defaulted on insert), namespaced per app via app_id.
-- `app_users` — per-app end-user pool for the app-auth Edge Function (same email may
-- register in many apps); deny-all RLS, service-role only.

create table if not exists public.entities (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users(id) on delete cascade,
  type text not null,
  app_id text,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists entities_owner_app_idx on public.entities (owner, app_id, type);
create index if not exists entities_owner_type_created_idx on public.entities (owner, type, created_at desc);

alter table public.entities enable row level security;
create policy entities_owner_all on public.entities
  for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
revoke all on table public.entities from anon;
grant select, insert, update, delete on table public.entities to authenticated;
grant all privileges on table public.entities to service_role;

create table if not exists public.app_users (
  id uuid primary key default gen_random_uuid(),
  app_id text not null,
  email text not null,
  auth_user_id uuid not null,
  created_at timestamptz not null default now()
);

create unique index if not exists app_users_app_email_idx on public.app_users (app_id, lower(email));
create unique index if not exists app_users_auth_user_idx on public.app_users (auth_user_id);

alter table public.app_users enable row level security;
revoke all on table public.app_users from public, anon, authenticated;
grant all privileges on table public.app_users to service_role;

-- app-auth support tables + alignment (kind/key event log, reset codes, user status).
create table if not exists public.app_auth_events (
  id uuid primary key default gen_random_uuid(),
  app_id text,
  kind text not null,
  key text,
  created_at timestamptz not null default now()
);
create index if not exists app_auth_events_kind_key_time_idx on public.app_auth_events (kind, key, created_at desc);

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

alter table public.app_users add column if not exists status text not null default 'active';

alter table public.app_auth_events enable row level security;
alter table public.app_password_resets enable row level security;
revoke all on table public.app_auth_events, public.app_password_resets from public, anon, authenticated;
grant all privileges on table public.app_auth_events, public.app_password_resets to service_role;
