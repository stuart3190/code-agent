-- Phase 9 sandbox egress and command policies, plus retention tracking.
-- The new agent columns are owner-editable policy flags; pruned_at marks runs whose
-- events and artifact content the retention sweeper has already removed.

alter table public.ca_agents
  add column network_policy text not null default 'full'
    check (network_policy in ('full', 'offline')),
  add column command_policy text not null default 'standard'
    check (command_policy in ('standard', 'restricted'));

alter table public.ca_runs
  add column pruned_at timestamptz;

create index ca_runs_retention_idx
  on public.ca_runs(finished_at)
  where pruned_at is null and finished_at is not null;
