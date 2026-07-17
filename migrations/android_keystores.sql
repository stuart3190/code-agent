-- Android export (2026-07-17) — per-project TWA signing keystore, encrypted at rest.
-- Applied live via the Supabase MCP the day it was written; kept here as the record.
-- Mirrors byok_keys: deny-all RLS (zero policies) so only the service role touches it. The
-- keystore is a binary .jks; stored base64 then AES-256-GCM (BYOK_ENC_KEY) in keystore_encrypted.
-- One row per project — its signing identity must stay stable so Play accepts updates and the
-- served assetlinks fingerprint keeps matching the app.

create table if not exists public.android_keystores (
  project_id  uuid primary key,
  owner       uuid not null,
  keystore_encrypted text not null,   -- AES-256-GCM(iv:tag:ct) of base64(keystore bytes)
  password_encrypted text not null,   -- AES-256-GCM of the keystore/key password
  fingerprint text not null,          -- SHA-256 colon-hex — goes into assetlinks.json
  package_id  text not null,          -- com.buildr101.app_<slug>
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.android_keystores enable row level security;
-- deny-all: no policies. Only service_role (bypasses RLS) reads/writes.
