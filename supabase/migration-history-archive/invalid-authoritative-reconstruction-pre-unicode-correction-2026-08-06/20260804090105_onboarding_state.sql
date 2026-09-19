alter table public.ca_owner_profile
  add column if not exists onboarding jsonb not null default '{}'::jsonb;