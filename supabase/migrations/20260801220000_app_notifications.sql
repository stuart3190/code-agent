-- Per-app end-user notifications (audit PR 5).
--
-- The generated-app SDK has exposed `backend.notifications` (list + markRead) since the fork,
-- but `app_notifications` was never created in Thrallo's Supabase — so every call in every
-- generated app has always failed. This creates it, adapted from the unapplied legacy DDL
-- (20260721135020) to Thrallo's `entities` isolation model rather than copied.
--
-- Departures from the legacy version, and why:
--
-- 1. `owner` instead of `app_user_id`, matching `entities`. The SDK never names the column —
--    it filters on app_id and relies on RLS for user scoping — so the two tables can and should
--    speak the same language.
-- 2. INSERT is permitted to the owning user. The legacy table was read/update only, which made
--    the SDK's write path impossible; an app can now record its own user's notifications.
-- 3. A trusted service-role writer supplies notifications the USER cannot forge for themselves
--    (welcome, security alerts). RLS keeps client writes owner-scoped, so a compromised client
--    can only ever notify itself.
--
-- Tenant isolation works exactly as it does for `entities`: app-auth maps each (app_id, email)
-- pair to a DISTINCT synthetic auth user, so `owner = auth.uid()` isolates per app. `app_id`
-- remains a namespace, not a security boundary — the same contract the SDK documents.

create table if not exists public.app_notifications (
  id         uuid primary key default gen_random_uuid(),
  owner      uuid not null references auth.users(id) on delete cascade,
  app_id     text not null,
  title      text not null check (char_length(title) between 1 and 160),
  body       text not null default '' check (char_length(body) <= 2000),
  data       jsonb not null default '{}'::jsonb,
  -- Which trusted event produced this, when it was not the app itself. Null for app-authored
  -- notifications; set for platform events so they can be recognised and audited.
  source     text check (source is null or char_length(source) <= 60),
  read_at    timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists app_notifications_owner_created_idx
  on public.app_notifications (owner, created_at desc);
create index if not exists app_notifications_app_created_idx
  on public.app_notifications (app_id, created_at desc);
create index if not exists app_notifications_unread_idx
  on public.app_notifications (owner, app_id)
  where read_at is null;

comment on table public.app_notifications is
  'Per-app end-user notifications for generated apps. Owner-scoped RLS mirrors public.entities; app_id is a namespace, not a security boundary (app-auth issues a distinct auth user per app).';

alter table public.app_notifications enable row level security;

-- Clean up the legacy policy names in case an older migration is ever replayed.
drop policy if exists app_notifications_read_own on public.app_notifications;
drop policy if exists app_notifications_update_own on public.app_notifications;
drop policy if exists app_notifications_owner_all on public.app_notifications;

-- Owner scoping, exactly as entities does it.
create policy app_notifications_owner_all on public.app_notifications
  for all to authenticated
  using (owner = auth.uid())
  with check (owner = auth.uid());

revoke all on table public.app_notifications from public, anon, authenticated;

-- COLUMN-level privileges carry the trust boundary, not RLS. Both alternatives were tried
-- against production and rejected:
--   * a single `for all` policy let a client set `source` itself, so a compromised app could
--     forge "Your password was changed" and phish its own users into a reset flow;
--   * pinning `source is null` in WITH CHECK evaluates the RESULTING row, which then stopped
--     users marking a platform notification as read (PATCH returned 42501).
-- Granting only the columns an app may author solves both: `source` is not a column the client
-- can write at all, and `read_at` is the only field it may update.
grant select on table public.app_notifications to authenticated;
grant insert (owner, app_id, title, body, data) on table public.app_notifications to authenticated;
grant update (read_at) on table public.app_notifications to authenticated;
grant delete on table public.app_notifications to authenticated;

grant all privileges on table public.app_notifications to service_role;
