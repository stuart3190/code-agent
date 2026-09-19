-- Phase 6: Thrallo account notification history, and cancellation state.
--
-- 1. `ca_notifications` — the history behind the notification centre.
--
--    Until now every platform notification was fire-and-forget: `notifyOwner` pushed to web-push
--    and Resend and kept nothing. A customer who was asleep when their custom domain stopped
--    working had no way to learn that it ever happened. The notification existed for as long as
--    the browser toast did.
--
--    This is deliberately NOT `app_notifications`. That table belongs to the apps CUSTOMERS build:
--    it is keyed by app_id, its rows are written by generated apps through the SDK, and its RLS
--    maps each (app_id, email) pair to a distinct synthetic auth user. Thrallo's own notifications
--    are about the Thrallo account — domains, health, publishes, billing — and share none of that.
--    Conflating them would put a customer's end users and the account owner in one stream.
--
--    `tag` carries the same value `notifyOwner` already sends to web-push, where it collapses
--    repeat alerts into one notification. It does the same here: the unique index means a domain
--    that fails four sweeps in a row is one unread row that keeps its first-seen time, not four.
--
-- 2. `cancel_at_period_end` — whether a paid subscription is set to stop.
--
--    Stripe holds this on the subscription; nothing in Thrallo read it, so the billing panel could
--    tell someone their plan "renews on the 12th" when it was in fact ending on the 12th. The
--    webhook now syncs it, and Cancel/Reactivate set it.

create table if not exists public.ca_notifications (
  id         uuid primary key default gen_random_uuid(),
  owner      uuid not null references auth.users(id) on delete cascade,
  -- What produced this. Rendered as a label, so the customer can tell a deploy from a domain
  -- problem without reading the whole sentence.
  source     text not null default 'thrallo'
             check (source in ('publish', 'domain', 'health', 'billing', 'thrallo')),
  title      text not null check (char_length(title) between 1 and 200),
  body       text not null default '' check (char_length(body) <= 2000),
  -- Where the notification points. Held as given; the client decides whether it is an external
  -- site or an in-app address.
  url        text,
  tag        text not null default 'thrallo',
  read_at    timestamptz,
  created_at timestamptz not null default now()
);

-- The notification centre reads newest-first, and the unread count reads the same index.
create index if not exists ca_notifications_owner_idx
  on public.ca_notifications (owner, created_at desc);
create index if not exists ca_notifications_unread_idx
  on public.ca_notifications (owner, created_at desc) where read_at is null;

-- One live row per (owner, tag): a repeat alert refreshes the existing one rather than stacking.
-- Partial on unread, so an acknowledged alert that recurs is genuinely new again.
create unique index if not exists ca_notifications_owner_tag_unread_idx
  on public.ca_notifications (owner, tag) where read_at is null;

alter table public.ca_notifications enable row level security;

-- Service-role only, like every other ca_* table: the shell reads and writes on the owner's
-- behalf after authenticating them. The browser never touches this directly.
revoke all on table public.ca_notifications from public, anon, authenticated;
grant all privileges on table public.ca_notifications to service_role;

drop policy if exists "ca_notifications_browser_deny" on public.ca_notifications;
create policy "ca_notifications_browser_deny"
  on public.ca_notifications
  as restrictive for all to anon, authenticated
  using (false) with check (false);

alter table public.ca_subscriptions
  add column if not exists cancel_at_period_end boolean not null default false;
