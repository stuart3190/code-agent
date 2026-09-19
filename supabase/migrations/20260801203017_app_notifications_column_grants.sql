-- The previous fix over-corrected. Pinning `source is null` in WITH CHECK evaluates the
-- RESULTING row, so a user could no longer mark a platform notification (source='app_welcome')
-- as read — verified against production: PATCH returned 42501.
--
-- Column-level privileges are the right mechanism. A client may insert the app-authored fields
-- and may only ever update `read_at`; `source` is simply not a column it can write, so RLS goes
-- back to plain owner scoping and the read/unread flow works for every notification.

drop policy if exists app_notifications_owner_read on public.app_notifications;
drop policy if exists app_notifications_owner_update on public.app_notifications;
drop policy if exists app_notifications_owner_delete on public.app_notifications;
drop policy if exists app_notifications_owner_insert on public.app_notifications;

create policy app_notifications_owner_all on public.app_notifications
  for all to authenticated
  using (owner = auth.uid())
  with check (owner = auth.uid());

revoke all on table public.app_notifications from public, anon, authenticated;

-- Exactly the fields an app may author. `source` is absent: only the service role can claim
-- that a notification came from Thrallo.
grant select on table public.app_notifications to authenticated;
grant insert (owner, app_id, title, body, data) on table public.app_notifications to authenticated;
grant update (read_at) on table public.app_notifications to authenticated;
grant delete on table public.app_notifications to authenticated;

grant all privileges on table public.app_notifications to service_role;