create table if not exists public.brand_kits (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.project_brand_settings (
  project_id uuid primary key references public.projects(id) on delete cascade,
  owner uuid not null references auth.users(id) on delete cascade,
  brand_kit_id uuid references public.brand_kits(id) on delete set null,
  config jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists brand_kits_owner_idx on public.brand_kits(owner, updated_at desc);
create index if not exists project_brand_settings_owner_idx on public.project_brand_settings(owner, updated_at desc);
create index if not exists project_brand_settings_kit_idx on public.project_brand_settings(brand_kit_id);

alter table public.brand_kits enable row level security;
alter table public.project_brand_settings enable row level security;
drop policy if exists brand_kits_owner_read on public.brand_kits;
create policy brand_kits_owner_read on public.brand_kits for select to authenticated using ((select auth.uid()) = owner);
drop policy if exists project_brand_settings_owner_read on public.project_brand_settings;
create policy project_brand_settings_owner_read on public.project_brand_settings for select to authenticated using ((select auth.uid()) = owner);

revoke all on table public.brand_kits from anon, authenticated;
revoke all on table public.project_brand_settings from anon, authenticated;
grant select on table public.brand_kits to authenticated;
grant select on table public.project_brand_settings to authenticated;
