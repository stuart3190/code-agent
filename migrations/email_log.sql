-- Transactional email log (2026-07-17) — idempotency + audit for lifecycle emails (welcome,
-- credits-remaining nudge). Applied live via the Supabase MCP the day written. One row per
-- (owner, kind) — the PK makes each lifecycle email send at most once per user. Deny-all RLS:
-- only the shell's service role reads/writes it.
create table if not exists public.email_log (
  owner    uuid not null,
  kind     text not null,          -- 'welcome' | 'nudge'
  sent_at  timestamptz not null default now(),
  primary key (owner, kind)
);
alter table public.email_log enable row level security;
-- deny-all: no policies (service_role only).
