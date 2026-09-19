-- WP4 — real application accounts: memberships, profiles, membership events, account policies.
--
-- ADDITIVE and idempotent. Nothing is dropped, altered or deleted. Every table is service-role
-- only (deny-all RLS): the app-accounts Edge Function and the shell are the only writers, so a
-- generated client can never grant itself a role by writing a row. Existing app_users are
-- backfilled as ordinary members with their current status; no business "role" field anywhere
-- is consulted (audit §8: generated role fields never become authority).

create table if not exists public.app_memberships (
  id uuid primary key default gen_random_uuid(),
  app_id text not null,
  email text not null,
  auth_user_id uuid,
  role text not null default 'member',
  status text not null default 'active',
  granted_by uuid,
  provisioned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint app_memberships_status_check check (status in ('active', 'invited', 'suspended'))
);
create unique index if not exists app_memberships_app_email_idx on public.app_memberships (app_id, email);
create index if not exists app_memberships_app_user_idx on public.app_memberships (app_id, auth_user_id);
alter table public.app_memberships enable row level security;
revoke all on table public.app_memberships from public, anon, authenticated;
grant all privileges on table public.app_memberships to service_role;

create table if not exists public.app_profiles (
  app_id text not null,
  auth_user_id uuid not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (app_id, auth_user_id)
);
alter table public.app_profiles enable row level security;
revoke all on table public.app_profiles from public, anon, authenticated;
grant all privileges on table public.app_profiles to service_role;

create table if not exists public.app_membership_events (
  id uuid primary key default gen_random_uuid(),
  app_id text not null,
  action text not null,
  actor_user_id uuid,
  actor_email text,
  target_user_id uuid,
  target_email text,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);
create index if not exists app_membership_events_app_time_idx on public.app_membership_events (app_id, created_at desc);
alter table public.app_membership_events enable row level security;
revoke all on table public.app_membership_events from public, anon, authenticated;
grant all privileges on table public.app_membership_events to service_role;

create table if not exists public.app_account_policies (
  app_id text primary key,
  policy jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.app_account_policies enable row level security;
revoke all on table public.app_account_policies from public, anon, authenticated;
grant all privileges on table public.app_account_policies to service_role;

-- Explicit account-mapping migration: every existing app user is an ordinary member. Status
-- follows app_users.status; roles are never inferred from application data.
insert into public.app_memberships (app_id, email, auth_user_id, role, status)
select u.app_id, lower(u.email), u.auth_user_id, 'member',
       case when u.status = 'active' then 'active' else 'suspended' end
from public.app_users u
on conflict (app_id, email) do nothing;
