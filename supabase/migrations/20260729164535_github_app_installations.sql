-- GitHub App installations are durable authorization metadata. Installation access tokens are
-- short-lived and minted on demand; they are never stored in this table or exposed to the browser.

create table if not exists public.ca_github_installations (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  installation_id bigint not null unique,
  account_id bigint,
  account_login text,
  account_type text,
  repository_selection text,
  permissions jsonb not null default '{}'::jsonb,
  events jsonb not null default '[]'::jsonb,
  suspended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.ca_repositories
  add constraint ca_repositories_installation_fk
  foreign key (installation_id)
  references public.ca_github_installations(installation_id)
  on delete set null;

create index if not exists ca_github_installations_owner_updated_idx
  on public.ca_github_installations(owner, updated_at desc);

alter table public.ca_github_installations enable row level security;

grant select on public.ca_github_installations to authenticated;
grant all privileges on public.ca_github_installations to service_role;

create policy "ca_github_installations_owner_read"
  on public.ca_github_installations
  for select to authenticated
  using ((select auth.uid()) = owner);
