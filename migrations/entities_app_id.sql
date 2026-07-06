-- Per-app namespace on the generic entities table (DECISION-hosting.md, Decision 3 lean shape).
-- app_id partitions ONE user's data between their apps; security stays the Phase 3.1
-- owner-scoped RLS (owner = auth.uid()) — no policy changes here.
--
-- Paste into the Supabase SQL editor (project qgemqjcyhuejrsvjxkbh), same as prior migrations.

alter table public.entities add column if not exists app_id text;

create index if not exists entities_owner_app_idx
  on public.entities (owner, app_id, type);
