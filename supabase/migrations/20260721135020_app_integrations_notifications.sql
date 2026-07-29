create table if not exists public.app_notifications (
  id uuid primary key default gen_random_uuid(),
  app_id text not null,
  app_user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 160),
  body text not null default '' check (char_length(body) <= 2000),
  data jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists app_notifications_user_created_idx on public.app_notifications(app_user_id, created_at desc);
create index if not exists app_notifications_app_idx on public.app_notifications(app_id, created_at desc);

alter table public.app_notifications enable row level security;
drop policy if exists app_notifications_read_own on public.app_notifications;
create policy app_notifications_read_own on public.app_notifications for select to authenticated
  using ((select auth.uid()) = app_user_id);
drop policy if exists app_notifications_update_own on public.app_notifications;
create policy app_notifications_update_own on public.app_notifications for update to authenticated
  using ((select auth.uid()) = app_user_id) with check ((select auth.uid()) = app_user_id);

revoke all on table public.app_notifications from anon, authenticated;
grant select, update on table public.app_notifications to authenticated;
