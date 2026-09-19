-- Plan changes for existing paid subscribers.
--
-- Upgrades apply immediately; downgrades take effect at the end of the paid period, so a
-- subscription can carry a *pending* plan that Stripe holds in a subscription schedule. These
-- columns mirror that pending state so the UI can show it without a Stripe round trip. Stripe
-- stays authoritative: the webhook overwrites them when the scheduled phase actually starts.
alter table public.ca_subscriptions
  add column if not exists pending_plan text,
  add column if not exists pending_plan_at timestamptz,
  add column if not exists stripe_schedule_id text;

-- A pending plan is only meaningful as one of the sold plans.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ca_subscriptions_pending_plan_check'
  ) then
    alter table public.ca_subscriptions
      add constraint ca_subscriptions_pending_plan_check
      check (pending_plan is null or pending_plan in ('free', 'starter', 'pro'));
  end if;
end $$;

-- One Thrallo owner must never map to two Stripe subscriptions. The application prevents this by
-- updating the existing subscription rather than creating a second one; this makes it structurally
-- impossible for two owners to claim the same Stripe subscription as well.
create unique index if not exists ca_subscriptions_stripe_subscription_uniq
  on public.ca_subscriptions (stripe_subscription_id)
  where stripe_subscription_id is not null;

create unique index if not exists ca_subscriptions_stripe_customer_uniq
  on public.ca_subscriptions (stripe_customer_id)
  where stripe_customer_id is not null;
