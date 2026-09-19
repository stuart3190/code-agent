-- Phase 12 automations: webhook-triggered pull-request reviews and scheduled runs.
-- Service-role only; owners manage automations through authenticated shell routes.

create table public.ca_automations (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  repository_id uuid not null references public.ca_repositories(id) on delete cascade,
  kind text not null check (kind in ('pr_review', 'scheduled_task')),
  enabled boolean not null default true,
  config jsonb not null default '{}'::jsonb,
  interval_hours integer check (interval_hours is null or interval_hours between 1 and 168),
  next_run_at timestamptz,
  last_run_id uuid references public.ca_runs(id) on delete set null,
  last_triggered_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ca_automations_schedule_check
    check (kind <> 'scheduled_task' or interval_hours is not null)
);

create index ca_automations_owner_idx on public.ca_automations(owner, created_at desc);
create index ca_automations_repo_kind_idx on public.ca_automations(repository_id, kind)
  where enabled;
create index ca_automations_due_idx on public.ca_automations(next_run_at)
  where enabled and kind = 'scheduled_task';

-- Run provenance: which automation created this run (null for manual runs).
alter table public.ca_runs
  add column automation_id uuid references public.ca_automations(id) on delete set null;

alter table public.ca_automations enable row level security;

revoke all on table public.ca_automations from public, anon, authenticated;

grant all privileges on table public.ca_automations to service_role;

create policy "ca_automations_browser_deny"
  on public.ca_automations
  as restrictive for all to anon, authenticated
  using (false) with check (false);
