-- Context & cost diagnostics per AI request: trigger source, run linkage, and the full
-- context breakdown (task type, budget, seeded files with reasons, warnings, token split).
alter table public.ai_requests add column if not exists trigger text;
alter table public.ai_requests add column if not exists run_id uuid;
alter table public.ai_requests add column if not exists context jsonb;
