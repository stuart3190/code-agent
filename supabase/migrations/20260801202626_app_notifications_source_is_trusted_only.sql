-- A client could set `source` itself, letting a compromised app forge a platform security
-- alert ("Your password was changed") to phish its own users into a reset flow. Verified
-- against production before this change: the insert succeeded.
--
-- `source` now marks provenance that only the service role can claim. Clients keep full
-- owner-scoped access to their own notifications; they simply cannot pretend one came from
-- the platform.

drop policy if exists app_notifications_owner_all on public.app_notifications;

create policy app_notifications_owner_read on public.app_notifications
  for select to authenticated using (owner = auth.uid());

create policy app_notifications_owner_update on public.app_notifications
  for update to authenticated
  using (owner = auth.uid())
  with check (owner = auth.uid() and source is null);

create policy app_notifications_owner_delete on public.app_notifications
  for delete to authenticated using (owner = auth.uid());

-- The one that matters: an app may notify its own signed-in user, but may not claim the
-- notification came from Thrallo.
create policy app_notifications_owner_insert on public.app_notifications
  for insert to authenticated
  with check (owner = auth.uid() and source is null);

-- Remove the forged row created while proving the hole existed.
delete from public.app_notifications where title = 'Forged security alert';