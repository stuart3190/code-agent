create table if not exists public.app_notifications (
  id         uuid primary key default gen_random_uuid(),
  owner      uuid not null references auth.users(id) on delete cascade,
  app_id     text not null,
  title      text not null check (char_length(title) between 1 and 160),
  body       text not null default '' check (char_length(body) <= 2000),
  data       jsonb not null default '{}'::jsonb,
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

drop policy if exists app_notifications_read_own on public.app_notifications;
drop policy if exists app_notifications_update_own on public.app_notifications;
drop policy if exists app_notifications_owner_all on public.app_notifications;

create policy app_notifications_owner_all on public.app_notifications
  for all to authenticated
  using (owner = auth.uid())
  with check (owner = auth.uid());

revoke all on table public.app_notifications from public, anon;
grant select, insert, update, delete on table public.app_notifications to authenticated;
grant all privileges on table public.app_notifications to service_role;