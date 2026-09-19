-- When the current verification attempt began. Distinct from created_at so that Retry restarts the
-- give-up clock without rewriting when the domain was first connected.
alter table public.custom_domains
  add column if not exists verification_started_at timestamptz;

update public.custom_domains set verification_started_at = created_at
 where verification_started_at is null;