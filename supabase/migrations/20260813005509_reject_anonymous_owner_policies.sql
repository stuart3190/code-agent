-- Platform accounts do not use Supabase anonymous identities. Keep these owner policies available
-- to registered authenticated users while rejecting anonymous JWTs explicitly.

alter policy "entities_owner_all" on public.entities
  using (owner = (select auth.uid()) and ((select auth.jwt()) ->> 'is_anonymous') = 'false')
  with check (owner = (select auth.uid()) and ((select auth.jwt()) ->> 'is_anonymous') = 'false');

alter policy "app_notifications_owner_all" on public.app_notifications
  using (owner = (select auth.uid()) and ((select auth.jwt()) ->> 'is_anonymous') = 'false')
  with check (owner = (select auth.uid()) and ((select auth.jwt()) ->> 'is_anonymous') = 'false');

alter policy "deployments_owner_read" on public.deployments
  using ((select auth.uid()) = owner and ((select auth.jwt()) ->> 'is_anonymous') = 'false');
