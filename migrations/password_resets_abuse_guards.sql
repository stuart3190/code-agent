-- Launch hardening (2026-07-15) — app-auth password reset + abuse guards.
-- Applied live via the Supabase MCP the day it was written; kept here as the record.
--
-- 1. app_password_resets — one row per emailed 6-digit reset code (app-auth "reset" action).
--    Codes are stored HASHED (sha256 of appId|email|code), expire after 15 minutes, and die
--    after 5 wrong attempts. Deny-all RLS: only the app-auth function's service role touches it.
-- 2. app_auth_events — tiny rolling log the app-auth function counts for per-IP rate limits
--    (signup / reset floods). Deny-all RLS, same reasoning. Rows self-prune at check time.
-- 3. enforce_project_cap — BEFORE INSERT trigger on projects. Project creation is a CLIENT-side
--    insert under owner-RLS (shell/web/src/lib/projects.js), so the only unbypassable cap is in
--    the database itself: free accounts (no tier in customers) get 10 projects, paid tiers 100.

-- ── 1. reset codes ────────────────────────────────────────────────────────────────────────────
create table if not exists public.app_password_resets (
  id         uuid primary key default gen_random_uuid(),
  app_id     text not null,
  email      text not null,             -- the REAL email (matches app_users.email)
  code_hash  text not null,             -- sha256(appId|email|code) hex — never the code itself
  attempts   int  not null default 0,   -- wrong guesses; row dies at 5
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists app_password_resets_lookup
  on public.app_password_resets (app_id, email, created_at desc);

alter table public.app_password_resets enable row level security;
-- deny-all: no policies. Only service_role (which bypasses RLS) may read or write.

-- ── 2. auth event log (rate-limit counters) ──────────────────────────────────────────────────
create table if not exists public.app_auth_events (
  id         bigint generated always as identity primary key,
  kind       text not null,             -- 'signup' | 'reset'
  key        text not null,             -- caller IP (x-forwarded-for)
  app_id     text,
  created_at timestamptz not null default now()
);

create index if not exists app_auth_events_lookup
  on public.app_auth_events (kind, key, created_at desc);

alter table public.app_auth_events enable row level security;
-- deny-all: no policies (service_role only).

-- ── 3. per-account project cap ────────────────────────────────────────────────────────────────
create or replace function public.enforce_project_cap()
returns trigger
language plpgsql
security definer            -- owned by postgres: counts across RLS reliably
set search_path = public
as $$
declare
  n   int;
  cap int;
begin
  select count(*) into n from projects where owner = new.owner;
  select case when exists (select 1 from customers where owner = new.owner and tier is not null)
              then 100 else 10 end
    into cap;
  if n >= cap then
    raise exception 'PROJECT_CAP: this account already has % projects (limit %). Delete an old project%',
      n, cap, case when cap = 10 then ' or upgrade to a paid plan for a higher limit.' else '.' end;
  end if;
  return new;
end
$$;

drop trigger if exists projects_enforce_cap on public.projects;
create trigger projects_enforce_cap
  before insert on public.projects
  for each row execute function public.enforce_project_cap();

-- Verify (optional):
--   select tablename from pg_tables where tablename in ('app_password_resets','app_auth_events');
--   select tgname from pg_trigger where tgname = 'projects_enforce_cap';
