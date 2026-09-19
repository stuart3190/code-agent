create table if not exists public.project_templates (
  id uuid primary key default gen_random_uuid(),
  owner uuid references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  description text not null default '' check (char_length(description) <= 500),
  category text not null default 'other' check (char_length(category) between 1 and 40),
  source_tree jsonb not null,
  public boolean not null default false,
  times_remixed integer not null default 0 check (times_remixed >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists project_templates_owner_idx on public.project_templates(owner, updated_at desc);
create index if not exists project_templates_public_idx on public.project_templates(public, times_remixed desc, created_at desc) where public = true;
alter table public.project_templates enable row level security;
drop policy if exists project_templates_visible on public.project_templates;
create policy project_templates_visible on public.project_templates for select to authenticated
  using (public or (select auth.uid()) = owner);
revoke all on table public.project_templates from anon, authenticated;
grant select on table public.project_templates to authenticated;
