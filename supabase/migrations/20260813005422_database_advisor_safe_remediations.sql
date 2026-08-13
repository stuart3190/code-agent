-- Safe database-advisor remediations: keep policy semantics unchanged while ensuring auth
-- helpers are evaluated once per statement, pin the immutable helper's search path, and remove
-- the later duplicate of the original Stripe-customer uniqueness index.

alter function public.deployment_scope(uuid, text) set search_path = pg_catalog;

alter policy "ca_repositories_owner_read" on public.ca_repositories
  using ((select auth.uid()) = owner and ((select auth.jwt()) ->> 'is_anonymous') = 'false');
alter policy "ca_agents_owner_read" on public.ca_agents
  using ((select auth.uid()) = owner and ((select auth.jwt()) ->> 'is_anonymous') = 'false');
alter policy "ca_runs_owner_read" on public.ca_runs
  using ((select auth.uid()) = owner and ((select auth.jwt()) ->> 'is_anonymous') = 'false');
alter policy "ca_run_events_owner_read" on public.ca_run_events
  using ((select auth.uid()) = owner and ((select auth.jwt()) ->> 'is_anonymous') = 'false');
alter policy "ca_checkpoints_owner_read" on public.ca_checkpoints
  using ((select auth.uid()) = owner and ((select auth.jwt()) ->> 'is_anonymous') = 'false');
alter policy "ca_artifacts_owner_read" on public.ca_artifacts
  using ((select auth.uid()) = owner and ((select auth.jwt()) ->> 'is_anonymous') = 'false');
alter policy "ca_usage_owner_read" on public.ca_usage_records
  using ((select auth.uid()) = owner and ((select auth.jwt()) ->> 'is_anonymous') = 'false');
alter policy "ca_github_installations_owner_read" on public.ca_github_installations
  using ((select auth.uid()) = owner and ((select auth.jwt()) ->> 'is_anonymous') = 'false');

alter policy "entities_owner_all" on public.entities
  using (owner = (select auth.uid()))
  with check (owner = (select auth.uid()));
alter policy "app_notifications_owner_all" on public.app_notifications
  using (owner = (select auth.uid()))
  with check (owner = (select auth.uid()));
alter policy "deployments_owner_read" on public.deployments
  using ((select auth.uid()) = owner);

drop index if exists public.ca_subscriptions_stripe_customer_uniq;
