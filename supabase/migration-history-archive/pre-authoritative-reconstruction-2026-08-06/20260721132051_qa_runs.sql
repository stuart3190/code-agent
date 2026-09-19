create table if not exists public.qa_runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  owner uuid not null references auth.users(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'running', 'passed', 'issues_found', 'failed', 'cancelled')),
  preview_url text,
  report jsonb,
  passed_count integer not null default 0 check (passed_count >= 0),
  issue_count integer not null default 0 check (issue_count >= 0),
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create index if not exists qa_runs_project_idx on public.qa_runs(project_id);
create index if not exists qa_runs_owner_project_created_idx on public.qa_runs(owner, project_id, created_at desc);
create unique index if not exists qa_runs_one_active_per_project_idx on public.qa_runs(project_id)
  where status in ('queued', 'running');

alter table public.qa_runs enable row level security;
drop policy if exists qa_runs_owner_read on public.qa_runs;
create policy qa_runs_owner_read on public.qa_runs for select to authenticated
  using ((select auth.uid()) = owner);

revoke all on table public.qa_runs from anon, authenticated;
grant select on table public.qa_runs to authenticated;
