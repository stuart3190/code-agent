-- Custom domains gain a verification lifecycle.
--
-- Until now a row existing was enough for Caddy to be told "yes, issue a certificate for this
-- hostname". That meant anyone able to create a row could make Thrallo request a certificate for a
-- domain they do not own. Certificates are now gated on `status = 'active'`, which is only reached
-- after a DNS TXT token proves ownership AND the domain actually points here.
alter table public.custom_domains
  add column if not exists status text not null default 'pending_dns',
  add column if not exists verification_token text,
  add column if not exists last_checked_at timestamptz,
  add column if not exists failure_reason text,
  add column if not exists ssl_status text not null default 'pending',
  add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'custom_domains_status_check') then
    alter table public.custom_domains add constraint custom_domains_status_check
      check (status in ('pending_dns', 'verifying', 'active', 'failed'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'custom_domains_ssl_status_check') then
    alter table public.custom_domains add constraint custom_domains_ssl_status_check
      check (ssl_status in ('pending', 'active'));
  end if;
end $$;

-- Existing rows were approved under the old rule. Anything already verified stays trusted;
-- anything else drops back to pending so it must now prove itself before a certificate is issued.
update public.custom_domains
   set status = case when verified_at is not null then 'active' else 'pending_dns' end
 where status = 'pending_dns' and verified_at is not null;

create index if not exists custom_domains_owner_idx on public.custom_domains (owner);
create index if not exists custom_domains_project_idx on public.custom_domains (project_id);
-- The verification sweeper polls unfinished domains; keep that lookup cheap.
create index if not exists custom_domains_unsettled_idx
  on public.custom_domains (last_checked_at) where status <> 'failed';

comment on column public.custom_domains.status is
  'pending_dns → verifying → active | failed. Certificates are issued ONLY for active.';

-- When the current verification attempt began. Distinct from created_at so that Retry restarts the
-- give-up clock without rewriting when the domain was first connected.
alter table public.custom_domains
  add column if not exists verification_started_at timestamptz;

update public.custom_domains set verification_started_at = created_at
 where verification_started_at is null;
