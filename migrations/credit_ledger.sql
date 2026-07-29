-- Phase 4 (LIVE) — credit ledger + entitlement mapping. Run ONCE in the Supabase SQL editor on the
-- same project as Phase 3.1. Mirrors the committed design in baseline/PHASE-4-BILLING.md §8 verbatim,
-- plus a `customers` entitlement table the live billing needs (Stripe customer <-> Supabase user,
-- and the user's current tier — which the per-tier hard ceiling reads at debit time).
--
-- DESIGN INVARIANTS (do not relax):
--   * credit_ledger is APPEND-ONLY. No update/delete policy is granted -> rows are immutable by
--     construction. Balance is NEVER stored; it is Σ delta. Corrections are new refund/adjust rows.
--   * RLS is owner-scoped: a user reads only their own rows; all writes are server-side.
--   * Platform writes (Stripe-webhook grants, the trusted engine's debits, the monthly expiry job)
--     run server-side with the SERVICE_ROLE key, which bypasses RLS. There is deliberately no
--     end-user insert policy or INSERT grant on this money-like table.

-- ──────────────────────────────────────────────────────────────────────────────────────────────
-- 1. credit_ledger  (append-only; balance = Σ delta)
-- ──────────────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.credit_ledger (
  id         uuid primary key default gen_random_uuid(),
  owner      uuid not null default auth.uid(),          -- RLS subject (Phase 3.1 pattern)
  ts         timestamptz not null default now(),
  delta      numeric(14,4) not null,                    -- + grant / top-up, − debit / expire
  bucket     text not null check (bucket in ('bundle','topup')),
  kind       text not null check (kind in ('grant','debit','expire','refund','adjust')),
  model      text,                                      -- debit: which model (-> weight applied)
  tokens     integer,                                   -- debit: raw blended tokens served
  weight     numeric(6,4),                              -- debit: model weight applied
  cycle      text,                                      -- bundle grants/expiry: billing period e.g. '2026-07'
  ref        text not null,                             -- stripe id / generation-turn id / idempotency key
  created_at timestamptz not null default now()
);

-- Idempotency: re-running the same grant/debit/top-up (same ref+kind) can't double-write — it no-ops
-- at the DB on the unique violation. A turn that spans BOTH buckets writes two rows (one per bucket),
-- so the index includes `bucket` to let both land under the same turn ref.
create unique index if not exists credit_ledger_ref_kind_uq
  on public.credit_ledger (owner, ref, kind, bucket);
create index if not exists credit_ledger_owner_ts on public.credit_ledger (owner, ts);

alter table public.credit_ledger enable row level security;
drop policy if exists ledger_select_own on public.credit_ledger;
drop policy if exists ledger_insert_own on public.credit_ledger;
create policy ledger_select_own on public.credit_ledger
  for select to authenticated using (owner = auth.uid());
revoke insert, update, delete, truncate, references, trigger on public.credit_ledger from anon, authenticated;
grant select on public.credit_ledger to authenticated;
-- (no update/delete policies — corrections are new 'refund'/'adjust' rows)

-- ──────────────────────────────────────────────────────────────────────────────────────────────
-- 2. customers  (entitlement: Stripe customer <-> Supabase user + current tier)
-- ──────────────────────────────────────────────────────────────────────────────────────────────
-- One row per user. `tier` is the entitlement the per-tier hard ceiling and the rollover job read.
-- Webhooks UPSERT this (set tier on subscription create/renew, clear on cancel). Owner-scoped RLS so
-- a user can read their own entitlement; the server (service_role) is what writes it.
create table if not exists public.customers (
  owner              uuid primary key default auth.uid(),
  stripe_customer_id text unique,
  tier               text,                              -- 'starter' | 'pro' | 'studio' | null (none)
  current_period     text,                              -- active billing period e.g. '2026-07'
  updated_at         timestamptz not null default now()
);

alter table public.customers enable row level security;
drop policy if exists customers_select_own on public.customers;
create policy customers_select_own on public.customers
  for select to authenticated using (owner = auth.uid());
-- writes are server-side (service_role) only; no insert/update policy for end users.

-- ──────────────────────────────────────────────────────────────────────────────────────────────
-- Verify (optional):
--   select policyname from pg_policies where tablename in ('credit_ledger','customers');
--   select count(*) from public.credit_ledger;   -- 0 on a fresh ledger
-- ──────────────────────────────────────────────────────────────────────────────────────────────
