-- Custom domains for published apps: a user points their own domain's A record at the VPS and we
-- serve their site there with automatic HTTPS (Caddy on-demand TLS, gated by the shell's
-- /api/domain-check ask endpoint reading this table). Service-role only; deny-all RLS.
--
-- Applied live via the Supabase MCP on 2026-07-06 (project qgemqjcyhuejrsvjxkbh).

create table if not exists public.custom_domains (
  domain text primary key,
  owner uuid not null,
  project_id text not null,
  slug text not null,
  created_at timestamptz not null default now(),
  verified_at timestamptz
);

create index if not exists custom_domains_project_idx on public.custom_domains (project_id);

alter table public.custom_domains enable row level security;
-- no policies: deny-all to anon/authenticated; service_role bypasses.
