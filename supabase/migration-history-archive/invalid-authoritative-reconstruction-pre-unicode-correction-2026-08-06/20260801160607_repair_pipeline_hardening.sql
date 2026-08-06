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