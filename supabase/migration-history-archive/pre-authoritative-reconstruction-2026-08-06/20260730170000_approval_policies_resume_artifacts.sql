-- Phase 8 approval policies, sandbox preserve/resume, and object-storage artifacts.
-- ca_agents and ca_runs stay owner-readable; the new columns carry no secrets.

alter table public.ca_agents
  add column publish_mode text not null default 'require_approval'
    check (publish_mode in ('require_approval', 'auto_publish')),
  add column protected_paths jsonb not null default '[]'::jsonb;

alter table public.ca_runs
  add column resumed_from_run_id uuid references public.ca_runs(id) on delete set null,
  add column sandbox_state text
    check (sandbox_state is null or sandbox_state in ('preserved', 'discarded'));

create index ca_runs_resumed_from_idx
  on public.ca_runs(resumed_from_run_id)
  where resumed_from_run_id is not null;

-- Private artifact bucket. storage.objects has RLS enabled with no policies for this bucket,
-- so only the service role can read or write; the shell streams content to authenticated owners.
insert into storage.buckets (id, name, public)
values ('thrallo-artifacts', 'thrallo-artifacts', false)
on conflict (id) do nothing;
