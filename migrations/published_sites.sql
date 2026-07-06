-- Publish site-name claims: one slug = one project, first publish claims it, republish reuses it.
-- Enforced by the shell server (service role); deny-all RLS to clients — ownership checks must not
-- be bypassable from the browser. Custom domains hang their table off the same ownership.
--
-- Applied live via the Supabase MCP on 2026-07-06 (project qgemqjcyhuejrsvjxkbh).

create table if not exists public.published_sites (
  slug text primary key,
  owner uuid not null,
  project_id text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists published_sites_project_idx on public.published_sites (project_id);

alter table public.published_sites enable row level security;
-- no policies: deny-all to anon/authenticated; service_role bypasses.
