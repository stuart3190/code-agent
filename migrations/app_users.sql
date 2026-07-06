-- Per-app end-user pools (PLAN-per-app-auth default lane). Maps (app_id, real email) to the
-- app-scoped synthetic Supabase auth user. Emails are unique PER APP, not globally — the fix for
-- the shared-pool collision. Clients never touch this table (deny-all RLS; only the app-auth
-- Edge Function's service role reads/writes it, same custody model as byok_keys).
--
-- Applied live via the Supabase MCP on 2026-07-06 (project qgemqjcyhuejrsvjxkbh).

create table if not exists public.app_users (
  id uuid primary key default gen_random_uuid(),
  app_id text not null,
  email text not null,
  auth_user_id uuid not null,
  created_at timestamptz not null default now()
);

create unique index if not exists app_users_app_email_idx
  on public.app_users (app_id, lower(email));

create unique index if not exists app_users_auth_user_idx
  on public.app_users (auth_user_id);

alter table public.app_users enable row level security;
-- No policies = deny-all to anon/authenticated; service_role bypasses RLS.
