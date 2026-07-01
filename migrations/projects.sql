-- Phase 5 (SHELL) — the dedicated `projects` table. Run ONCE in the Supabase SQL editor on the same
-- project as Phase 3.1 / Phase 4. This is where a builder's projects live: the durable file tree + the
-- engine turn history that make edits hold across reload, owner-scoped so a user sees only their own.
--
-- RLS is modelled EXACTLY on the proven Phase 3.1 `entities` policies (baseline/PHASE-3.1.md lines
-- 38-45): `owner uuid not null default auth.uid()` + four owner-scoped policies
-- (select/insert/update/delete own). No new policy shape is hand-rolled. The shell writes through the
-- user's own session, so RLS confines every read/write to the caller's rows (the honest Phase 3 path).

create table if not exists public.projects (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null default auth.uid(),   -- RLS subject (Phase 3.1 pattern)
  name        text,
  tree        jsonb,          -- durable file tree — the session state that makes edits hold
  history     jsonb,          -- engine turn/message history (the builder's prompts + outcomes)
  preview_ref text,           -- VPS container / subdomain (the preview seam)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists projects_owner_updated on public.projects (owner, updated_at desc);

alter table public.projects enable row level security;
drop policy if exists projects_select_own on public.projects;
drop policy if exists projects_insert_own on public.projects;
drop policy if exists projects_update_own on public.projects;
drop policy if exists projects_delete_own on public.projects;
create policy projects_select_own on public.projects for select to authenticated using (owner = auth.uid());
create policy projects_insert_own on public.projects for insert to authenticated with check (owner = auth.uid());
create policy projects_update_own on public.projects for update to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
create policy projects_delete_own on public.projects for delete to authenticated using (owner = auth.uid());

-- Verify (optional):
--   select policyname from pg_policies where tablename = 'projects';   -- 4 owner-scoped policies
--   select count(*) from public.projects;                             -- 0 on a fresh table
