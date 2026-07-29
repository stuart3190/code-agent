-- Durable, idempotent GitHub App webhook intake. Raw payloads remain
-- server-only so repository and account metadata never enters the browser.
create table public.ca_github_webhook_deliveries (
  delivery_id text primary key
    check (length(delivery_id) between 1 and 100),
  event text not null
    check (length(event) between 1 and 100),
  action text
    check (action is null or length(action) between 1 and 100),
  owner uuid references auth.users(id) on delete set null,
  installation_id bigint,
  payload_sha256 text not null
    check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  payload jsonb not null,
  status text not null default 'received'
    check (status in ('received', 'processing', 'processed', 'ignored', 'failed')),
  attempts integer not null default 0
    check (attempts >= 0),
  next_attempt_at timestamptz,
  error text,
  result jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  updated_at timestamptz not null default now()
);

create index ca_github_webhook_deliveries_pending_idx
  on public.ca_github_webhook_deliveries(status, next_attempt_at, updated_at, received_at)
  where status in ('received', 'processing', 'failed');

create index ca_github_webhook_deliveries_installation_idx
  on public.ca_github_webhook_deliveries(installation_id, received_at desc)
  where installation_id is not null;

create index ca_github_webhook_deliveries_owner_idx
  on public.ca_github_webhook_deliveries(owner)
  where owner is not null;

alter table public.ca_github_webhook_deliveries enable row level security;

revoke all on table public.ca_github_webhook_deliveries from public, anon, authenticated;
grant all privileges on table public.ca_github_webhook_deliveries to service_role;

create policy "ca_github_webhook_deliveries_browser_deny"
  on public.ca_github_webhook_deliveries
  as restrictive
  for all
  to anon, authenticated
  using (false)
  with check (false);

-- Installation rows remain as audit records after suspension or deletion.
-- Connected repositories are disabled separately instead of silently falling
-- back to a broader credential.
alter table public.ca_github_installations
  add column if not exists status text not null default 'active',
  add column if not exists deleted_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'ca_github_installations_status_check'
      and conrelid = 'public.ca_github_installations'::regclass
  ) then
    alter table public.ca_github_installations
      add constraint ca_github_installations_status_check
      check (status in ('active', 'suspended', 'deleted'));
  end if;
end
$$;

create index if not exists ca_github_installations_active_owner_updated_idx
  on public.ca_github_installations(owner, updated_at desc)
  where status = 'active';

-- Keep claims atomic and short. External GitHub calls happen only after the
-- transaction returns, so workers never hold database locks across the network.
create or replace function public.claim_github_webhook_deliveries(p_limit integer default 10)
returns setof public.ca_github_webhook_deliveries
language sql
security invoker
set search_path = ''
as $$
  with candidates as (
    select delivery_id
    from public.ca_github_webhook_deliveries
    where status = 'received'
       or (
         status = 'failed'
         and attempts < 10
         and (next_attempt_at is null or next_attempt_at <= now())
       )
       or (
         status = 'processing'
         and attempts < 10
         and updated_at <= now() - interval '10 minutes'
       )
    order by received_at
    for update skip locked
    limit least(greatest(coalesce(p_limit, 10), 1), 100)
  )
  update public.ca_github_webhook_deliveries as delivery
  set status = 'processing',
      attempts = delivery.attempts + 1,
      next_attempt_at = null,
      error = null,
      processed_at = null,
      updated_at = now()
  from candidates
  where delivery.delivery_id = candidates.delivery_id
  returning delivery.*;
$$;

revoke all on function public.claim_github_webhook_deliveries(integer)
  from public, anon, authenticated;
grant execute on function public.claim_github_webhook_deliveries(integer)
  to service_role;
