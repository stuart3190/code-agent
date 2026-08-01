-- Repair-pipeline hardening (2026-08-01).
--
-- 1. build_jobs.stop_reason: why a job stopped, recorded where the truth was known. The
--    relay previously inferred retry eligibility from `status` alone, which cannot tell a
--    user cancellation from a crash — so cancellations, budget stops and cost-guard
--    refusals were all being retried as paid work.
-- 2. ca_ai_preferences.byok_safety: the OPTIONAL BYOK safety controls. Null means every
--    control is off, which is the default: a BYOK user's tokens are billed by their own
--    provider account, so Thrallo imposes no spend cap unless they ask for one.

alter table public.build_jobs
  add column if not exists stop_reason text;

comment on column public.build_jobs.stop_reason is
  'Why the job stopped: cancelled | managed_budget | cost_guard | provider_quota | provider_rate_limit | provider_unavailable | transient. Null means no explicit reason was recorded.';

create index if not exists build_jobs_stop_reason_idx
  on public.build_jobs (stop_reason)
  where stop_reason is not null;

alter table public.ca_ai_preferences
  add column if not exists byok_safety jsonb;

comment on column public.ca_ai_preferences.byok_safety is
  'Optional, user-enabled BYOK safety controls: maxCostPerBuild, maxDailySpend, warnThreshold, approvalThreshold, maxRepairJobs. Null (the default) means every control is disabled.';
