-- QA / responsive verification runs (audit PR 3, Option A).
--
-- A `qa_runs` table has existed in the repo since the Buildr101 fork
-- (20260721132051_qa_runs.sql) but was NEVER applied to Thrallo's Supabase — verified against
-- information_schema on 2026-08-01, alongside 27 other tables from unapplied legacy migrations.
-- Remounting the QA routes without it would have produced 500s, so this creates it properly.
--
-- Two deliberate departures from the legacy DDL:
--
-- 1. Isolation posture. The legacy version granted SELECT to `authenticated` with an
--    owner-scoped policy, i.e. browser-readable. Thrallo reaches QA runs only through
--    owner-checked server routes, so this matches `build_jobs` instead: RLS on, an explicit
--    browser-deny policy, service-role grants only. Fail closed twice over.
-- 2. No dependency on `feature_flags`. That table was never created here either, and the
--    entitlement path it fed belongs to the retired credit ledger. QA is gated by the
--    capability registry's requirements() like every other Thrallo capability.

create table if not exists public.qa_runs (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects(id) on delete cascade,
  owner         uuid not null references auth.users(id) on delete cascade,
  status        text not null default 'queued'
                check (status in ('queued', 'running', 'passed', 'issues_found', 'failed', 'cancelled')),
  preview_url   text,
  report        jsonb,
  passed_count  integer not null default 0 check (passed_count >= 0),
  issue_count   integer not null default 0 check (issue_count >= 0),
  error         text,
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz
);

create index if not exists qa_runs_project_idx
  on public.qa_runs (project_id);
create index if not exists qa_runs_owner_project_created_idx
  on public.qa_runs (owner, project_id, created_at desc);
-- One active run per project: a second request returns the in-flight run rather than
-- starting a duplicate browser sweep.
create unique index if not exists qa_runs_one_active_per_project_idx
  on public.qa_runs (project_id)
  where status in ('queued', 'running');

comment on table public.qa_runs is
  'Responsive/multi-route QA sweeps over a generated app preview. Service-role only; read through owner-checked server routes.';

alter table public.qa_runs enable row level security;

drop policy if exists qa_runs_owner_read on public.qa_runs;
drop policy if exists qa_runs_browser_deny on public.qa_runs;
create policy qa_runs_browser_deny on public.qa_runs
  for all to anon, authenticated using (false);

revoke all on table public.qa_runs from public, anon, authenticated;
grant all privileges on table public.qa_runs to service_role;
