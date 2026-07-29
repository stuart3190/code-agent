-- Anonymous Supabase users must not read Code Agent owner metadata.
-- Service-role server access is unaffected by these SELECT policies.
alter policy "ca_repositories_owner_read"
  on public.ca_repositories
  using ((select auth.uid()) = owner and (select auth.jwt()->>'is_anonymous') = 'false');
alter policy "ca_agents_owner_read"
  on public.ca_agents
  using ((select auth.uid()) = owner and (select auth.jwt()->>'is_anonymous') = 'false');
alter policy "ca_runs_owner_read"
  on public.ca_runs
  using ((select auth.uid()) = owner and (select auth.jwt()->>'is_anonymous') = 'false');
alter policy "ca_run_events_owner_read"
  on public.ca_run_events
  using ((select auth.uid()) = owner and (select auth.jwt()->>'is_anonymous') = 'false');
alter policy "ca_checkpoints_owner_read"
  on public.ca_checkpoints
  using ((select auth.uid()) = owner and (select auth.jwt()->>'is_anonymous') = 'false');
alter policy "ca_artifacts_owner_read"
  on public.ca_artifacts
  using ((select auth.uid()) = owner and (select auth.jwt()->>'is_anonymous') = 'false');
alter policy "ca_usage_owner_read"
  on public.ca_usage_records
  using ((select auth.uid()) = owner and (select auth.jwt()->>'is_anonymous') = 'false');
alter policy "ca_github_installations_owner_read"
  on public.ca_github_installations
  using ((select auth.uid()) = owner and (select auth.jwt()->>'is_anonymous') = 'false');
