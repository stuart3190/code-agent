-- Preserve the existing owner-only RLS model while evaluating auth.uid() once per statement.
alter policy entities_select_own on public.entities
  to authenticated using (owner = (select auth.uid()));
alter policy entities_insert_own on public.entities
  to authenticated with check (owner = (select auth.uid()));
alter policy entities_update_own on public.entities
  to authenticated using (owner = (select auth.uid())) with check (owner = (select auth.uid()));
alter policy entities_delete_own on public.entities
  to authenticated using (owner = (select auth.uid()));

alter policy projects_select_own on public.projects
  to authenticated using (owner = (select auth.uid()));
alter policy projects_insert_own on public.projects
  to authenticated with check (owner = (select auth.uid()));
alter policy projects_update_own on public.projects
  to authenticated using (owner = (select auth.uid())) with check (owner = (select auth.uid()));
alter policy projects_delete_own on public.projects
  to authenticated using (owner = (select auth.uid()));

alter policy ledger_select_own on public.credit_ledger
  to authenticated using (owner = (select auth.uid()));
alter policy customers_select_own on public.customers
  to authenticated using (owner = (select auth.uid()));
alter policy build_jobs_owner_read on public.build_jobs
  to authenticated using ((select auth.uid()) = owner);
