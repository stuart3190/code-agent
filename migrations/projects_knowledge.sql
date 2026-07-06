-- Per-project knowledge: custom standing instructions (brand, tone, constraints) applied to
-- every generate/iterate/plan turn by riding the user prompt. RLS unchanged — the column is
-- covered by the existing owner-scoped projects policies.
--
-- Applied live via the Supabase MCP on 2026-07-06 (project qgemqjcyhuejrsvjxkbh).

alter table public.projects add column if not exists knowledge text;
