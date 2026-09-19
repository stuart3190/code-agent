-- Owner-readable control-plane metadata is for signed-in users only. Anonymous
-- grants were already revoked; making the policy role explicit adds a second
-- layer of protection and keeps Supabase Security Advisor accurate.
alter policy "ca_repositories_owner_read"
  on public.ca_repositories to authenticated;
alter policy "ca_agents_owner_read"
  on public.ca_agents to authenticated;
alter policy "ca_runs_owner_read"
  on public.ca_runs to authenticated;
alter policy "ca_run_events_owner_read"
  on public.ca_run_events to authenticated;
alter policy "ca_checkpoints_owner_read"
  on public.ca_checkpoints to authenticated;
alter policy "ca_artifacts_owner_read"
  on public.ca_artifacts to authenticated;
alter policy "ca_usage_owner_read"
  on public.ca_usage_records to authenticated;
alter policy "ca_github_installations_owner_read"
  on public.ca_github_installations to authenticated;
