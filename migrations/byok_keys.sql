-- BYOK — per-user provider API keys. Run ONCE in the Supabase SQL editor on the same project as
-- Phase 3.1 / 4 / 5. Stores a user's bring-your-own-key so generation can run on THEIR inference
-- account instead of the platform lane.
--
-- SECURITY MODEL (deliberately stricter than projects/entities):
--   * The row holds a SECRET. Unlike a project tree, it must NEVER be client-readable.
--   * The key is stored ENCRYPTED (AES-256-GCM, server-side, key = BYOK_ENC_KEY in shell/.env);
--     `key_encrypted` is ciphertext, `key_hint` is a masked display string only.
--   * RLS is ENABLED with NO end-user policies -> deny-all to any authenticated client. Only the
--     server's SERVICE_ROLE key (which bypasses RLS) ever reads/writes this table. Same custody as
--     the Stripe secret: the raw key never leaves the server, is never returned to the frontend.

create table if not exists public.byok_keys (
  owner         uuid primary key default auth.uid(),   -- one key per user (RLS subject)
  provider      text not null default 'anthropic',     -- which inference provider the key is for
  key_encrypted text not null,                          -- AES-256-GCM ciphertext (iv:tag:data, base64) — NEVER returned to client
  key_hint      text not null,                          -- masked display only, e.g. 'sk-ant-…w9Qd'
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.byok_keys enable row level security;
-- NO policies on purpose: authenticated clients get deny-all; the server (service_role) bypasses RLS
-- and is the only reader/writer. Do NOT add a select policy — it would expose the ciphertext column.

-- Verify (optional):
--   select relrowsecurity from pg_class where relname = 'byok_keys';        -- t (RLS on)
--   select count(*) from pg_policies where tablename = 'byok_keys';         -- 0 (deny-all to clients)
