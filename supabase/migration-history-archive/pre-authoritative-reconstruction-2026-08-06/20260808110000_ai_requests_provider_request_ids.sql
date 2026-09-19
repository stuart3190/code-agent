-- 2026-08-05 billing incident follow-up: the provider's own response ids, per recorded call.
-- The incident could only be reconciled against tariff tables because no provider id was stored;
-- this closes that gap for every call from now on.
alter table public.ai_requests add column if not exists provider_request_ids jsonb;
comment on column public.ai_requests.provider_request_ids is
  'Provider-issued response ids for the turns aggregated into this row. Null for calls recorded before 2026-08-05.';
