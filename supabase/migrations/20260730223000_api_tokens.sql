-- Phase 10 personal access tokens for editor and CLI clients.
-- Only the SHA-256 hash is stored; the plaintext token is shown once at creation.
-- Service-role only: the shell authenticates tokens and owners manage them through routes.

create table public.ca_api_tokens (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  token_hash text not null unique check (char_length(token_hash) = 64),
  token_prefix text not null check (char_length(token_prefix) between 8 and 24),
  scopes jsonb not null default '["runs"]'::jsonb,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index ca_api_tokens_owner_idx on public.ca_api_tokens(owner, created_at desc);

alter table public.ca_api_tokens enable row level security;

revoke all on table public.ca_api_tokens from public, anon, authenticated;

grant all privileges on table public.ca_api_tokens to service_role;

create policy "ca_api_tokens_browser_deny"
  on public.ca_api_tokens
  as restrictive for all to anon, authenticated
  using (false) with check (false);
