-- Phase 22: publishing + notifications on Thrallo infrastructure. published_sites and
-- custom_domains are recreated fresh in Thrallo's Supabase (the frozen Buildr101 tables are
-- never touched); ca_push_subscriptions backs the web-push notification channel. All three
-- are service-role only with browser deny — every access is server-mediated.

create table public.published_sites (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null references auth.users(id) on delete cascade,
  project_id  text not null unique,
  slug        text not null unique,
  url         text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.custom_domains (
  domain      text primary key,
  owner       uuid not null references auth.users(id) on delete cascade,
  project_id  text not null,
  slug        text not null,
  verified_at timestamptz,
  created_at  timestamptz not null default now()
);

create table public.ca_push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null references auth.users(id) on delete cascade,
  endpoint    text not null unique,
  keys        jsonb not null,
  created_at  timestamptz not null default now(),
  last_ok_at  timestamptz,
  disabled_at timestamptz
);

create index push_subscriptions_owner_idx on public.ca_push_subscriptions (owner);

alter table public.published_sites enable row level security;
alter table public.custom_domains enable row level security;
alter table public.ca_push_subscriptions enable row level security;

revoke all on table public.published_sites, public.custom_domains, public.ca_push_subscriptions
  from public, anon, authenticated;

grant all privileges on table public.published_sites, public.custom_domains, public.ca_push_subscriptions
  to service_role;

create policy "published_sites_browser_deny" on public.published_sites
  as restrictive for all to anon, authenticated using (false) with check (false);
create policy "custom_domains_browser_deny" on public.custom_domains
  as restrictive for all to anon, authenticated using (false) with check (false);
create policy "push_subscriptions_browser_deny" on public.ca_push_subscriptions
  as restrictive for all to anon, authenticated using (false) with check (false);
