-- WP12 — application subscriptions and the provider event trail.
--
-- ADDITIVE and idempotent. Nothing is dropped, altered or deleted. Both tables are service-role
-- only (deny-all RLS): the app-accounts Edge Function is the only writer, so a generated client
-- cannot write its own entitlement. That is the whole point — a `plan` field an application can
-- set is a plan anybody can set.
--
-- This is storage for GENERATED applications' own subscriptions. Thrallo's own billing is
-- separate and untouched by this migration.

create table if not exists public.app_subscriptions (
  app_id text not null,
  subject uuid not null,
  plan_id text,
  status text not null default 'none',
  provider_subscription_id text,
  current_period_end timestamptz,
  cancel_at timestamptz,
  -- The provider's own timestamp for the event that last moved this row. Order safety depends on
  -- it: an event older than this is ignored rather than applied.
  occurred_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (app_id, subject),
  constraint app_subscriptions_status_check
    check (status in ('none', 'trialing', 'active', 'past_due', 'cancelled', 'expired'))
);
alter table public.app_subscriptions enable row level security;
revoke all on table public.app_subscriptions from public, anon, authenticated;
grant all privileges on table public.app_subscriptions to service_role;

-- The event trail. The primary key IS the idempotence guarantee: a provider that retries the same
-- event cannot apply it twice, because the second insert conflicts.
create table if not exists public.app_billing_events (
  app_id text not null,
  event_id text not null,
  subject uuid,
  type text not null,
  status text,
  outcome text not null,
  occurred_at timestamptz,
  received_at timestamptz not null default now(),
  primary key (app_id, event_id)
);
create index if not exists app_billing_events_subject_idx
  on public.app_billing_events (app_id, subject, occurred_at desc);
alter table public.app_billing_events enable row level security;
revoke all on table public.app_billing_events from public, anon, authenticated;
grant all privileges on table public.app_billing_events to service_role;

-- The trail is append-only for everyone, including the service role: what a provider said, and
-- when, is a fact. Rewriting it would make a billing dispute unanswerable.
create or replace function public.app_billing_events_append_only()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'app_billing_events is append-only';
end;
$$;

drop trigger if exists app_billing_events_no_update on public.app_billing_events;
create trigger app_billing_events_no_update
  before update on public.app_billing_events
  for each row execute function public.app_billing_events_append_only();
