create table if not exists public.ca_notifications (
  id         uuid primary key default gen_random_uuid(),
  owner      uuid not null references auth.users(id) on delete cascade,
  source     text not null default 'thrallo'
             check (source in ('publish', 'domain', 'health', 'billing', 'thrallo')),
  title      text not null check (char_length(title) between 1 and 200),
  body       text not null default '' check (char_length(body) <= 2000),
  url        text,
  tag        text not null default 'thrallo',
  read_at    timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists ca_notifications_owner_idx
  on public.ca_notifications (owner, created_at desc);
create index if not exists ca_notifications_unread_idx
  on public.ca_notifications (owner, created_at desc) where read_at is null;
create unique index if not exists ca_notifications_owner_tag_unread_idx
  on public.ca_notifications (owner, tag) where read_at is null;

alter table public.ca_notifications enable row level security;

revoke all on table public.ca_notifications from public, anon, authenticated;
grant all privileges on table public.ca_notifications to service_role;

drop policy if exists "ca_notifications_browser_deny" on public.ca_notifications;
create policy "ca_notifications_browser_deny"
  on public.ca_notifications
  as restrictive for all to anon, authenticated
  using (false) with check (false);

alter table public.ca_subscriptions
  add column if not exists cancel_at_period_end boolean not null default false;