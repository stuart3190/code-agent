-- Document the deny-by-default browser boundary for server-only tables. The
-- browser roles also have no table grants; these restrictive policies provide
-- defense in depth and make the intent visible to Supabase's security advisor.
create policy "ca_tool_calls_browser_deny"
  on public.ca_tool_calls
  as restrictive
  for all
  to anon, authenticated
  using (false)
  with check (false);

create policy "ca_repository_index_files_browser_deny"
  on public.ca_repository_index_files
  as restrictive
  for all
  to anon, authenticated
  using (false)
  with check (false);

create policy "ca_repository_index_chunks_browser_deny"
  on public.ca_repository_index_chunks
  as restrictive
  for all
  to anon, authenticated
  using (false)
  with check (false);

-- Cover every foreign key used by the Code Agent control plane. Several of the
-- remaining foreign keys are already covered by unique or workload indexes.
create index if not exists ca_agents_repository_id_idx
  on public.ca_agents(repository_id);
create index if not exists ca_artifacts_owner_idx
  on public.ca_artifacts(owner);
create index if not exists ca_checkpoints_owner_idx
  on public.ca_checkpoints(owner);
create index if not exists ca_repositories_installation_id_idx
  on public.ca_repositories(installation_id);
create index if not exists ca_repository_index_chunks_owner_idx
  on public.ca_repository_index_chunks(owner);
create index if not exists ca_repository_index_files_owner_idx
  on public.ca_repository_index_files(owner);
create index if not exists ca_run_events_owner_idx
  on public.ca_run_events(owner);
create index if not exists ca_runs_agent_id_idx
  on public.ca_runs(agent_id);
create index if not exists ca_runs_repository_id_idx
  on public.ca_runs(repository_id);
create index if not exists ca_tool_calls_owner_idx
  on public.ca_tool_calls(owner);
create index if not exists ca_usage_records_run_id_idx
  on public.ca_usage_records(run_id);
