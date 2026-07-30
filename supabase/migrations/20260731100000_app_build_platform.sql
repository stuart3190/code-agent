-- Phase 19 app-build platform: the Buildr generation pipeline re-pointed at Thrallo.
-- Same table names the engine code already speaks (projects, build_jobs), created fresh in
-- Thrallo's own Supabase project — Buildr101's live project is never touched. Unlike the
-- legacy Buildr schema (client-side tree writes over RLS), Thrallo's conversation flow is
-- fully server-mediated, so both tables are service-role only with browser deny.

create table public.projects (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null references auth.users(id) on delete cascade,
  name        text check (name is null or char_length(name) <= 200),
  product_id  uuid references public.ca_products(id) on delete set null,
  tree        jsonb,
  history     jsonb,
  design_profile jsonb,
  preview_ref text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index projects_owner_updated on public.projects (owner, updated_at desc);

create table public.build_jobs (
  id           uuid primary key default gen_random_uuid(),
  owner        uuid not null references auth.users(id) on delete cascade,
  project_id   text not null,
  mode         text not null,
  status       text not null default 'queued',
  phase        text not null default 'queued',
  error        text,
  result       jsonb,
  build_stderr text,
  server_id    text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index build_jobs_project_idx on public.build_jobs (project_id, created_at desc);
create index build_jobs_owner_status_idx on public.build_jobs (owner, status);

alter table public.projects enable row level security;
alter table public.build_jobs enable row level security;

revoke all on table public.projects, public.build_jobs from public, anon, authenticated;

grant all privileges on table public.projects, public.build_jobs to service_role;

create policy "projects_browser_deny" on public.projects
  as restrictive for all to anon, authenticated using (false) with check (false);
create policy "build_jobs_browser_deny" on public.build_jobs
  as restrictive for all to anon, authenticated using (false) with check (false);
