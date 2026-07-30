-- Phase 7 subscription controls, managed usage budgets, and operational telemetry.
-- The subscription table stores Stripe identifiers and budget overrides, so it stays
-- service-role only; owners read a decrypted-safe projection through the shell.

create table public.ca_subscriptions (
  owner uuid primary key references auth.users(id) on delete cascade,
  plan text not null default 'free' check (plan in ('free', 'starter', 'pro')),
  status text not null default 'active' check (status in ('active', 'past_due', 'cancelled')),
  stripe_customer_id text check (stripe_customer_id is null or char_length(stripe_customer_id) between 1 and 120),
  stripe_subscription_id text check (stripe_subscription_id is null or char_length(stripe_subscription_id) between 1 and 120),
  current_period_start timestamptz,
  current_period_end timestamptz,
  run_limit_override bigint check (run_limit_override is null or run_limit_override > 0),
  managed_token_limit_override bigint check (managed_token_limit_override is null or managed_token_limit_override > 0),
  compute_seconds_limit_override bigint check (compute_seconds_limit_override is null or compute_seconds_limit_override > 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index ca_subscriptions_stripe_customer_idx
  on public.ca_subscriptions(stripe_customer_id)
  where stripe_customer_id is not null;

-- Budget metering distinguishes who paid for the model tokens in each usage record.
alter table public.ca_usage_records
  add column billing_source text not null default 'unknown'
    check (billing_source in ('managed', 'byok', 'codex', 'unknown'));

create index ca_usage_billing_source_idx
  on public.ca_usage_records(owner, billing_source, created_at desc);

-- Operational telemetry aggregates recent runs by state without an owner filter.
create index ca_runs_state_created_idx on public.ca_runs(state, created_at desc);

alter table public.ca_subscriptions enable row level security;

revoke all on table public.ca_subscriptions from public, anon, authenticated;

grant all privileges on table public.ca_subscriptions to service_role;

create policy "ca_subscriptions_browser_deny"
  on public.ca_subscriptions
  as restrictive for all to anon, authenticated
  using (false) with check (false);
