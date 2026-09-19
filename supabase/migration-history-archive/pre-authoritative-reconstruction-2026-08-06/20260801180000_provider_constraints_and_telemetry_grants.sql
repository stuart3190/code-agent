-- PR 1 of the 2026-08-01 audit remediation: provider-constraint drift + telemetry grants.
--
-- 1. D2 — xAI was added to the application's provider registry and to the credential/preference
--    constraints (PR #114), but two further provider-constrained tables were missed. Every xAI
--    routing attempt therefore violated a CHECK and was swallowed by recordAttempt's
--    `.catch(() => {})`, leaving provider health scoring permanently blind to xAI.
--
-- 2. R1 — diag_runs, diag_steps, ai_requests, build_signals and diag_incidents have RLS enabled
--    with zero policies, but still carry table-level SELECT grants to anon/authenticated. RLS
--    denies every row today (an anonymous client gets 200 []), so nothing leaks — but these
--    tables hold full prompt text and cost telemetry, and every comparable table
--    (projects, ca_conversations, build_checkpoints) fails closed twice over by also revoking
--    the grant. This aligns them.
--
--    Verified before writing: no browser-side read of these tables exists anywhere in
--    shell/web/src. Every legitimate read goes through the service role.

-- ── D2: widen the two AI-provider constraints ───────────────────────────────────────────

alter table public.ca_model_attempts
  drop constraint if exists ca_model_attempts_provider_check;
alter table public.ca_model_attempts
  add constraint ca_model_attempts_provider_check
  check (provider = any (array['openai'::text, 'anthropic'::text, 'gemini'::text, 'xai'::text]));

alter table public.ca_model_evaluation_results
  drop constraint if exists ca_model_evaluation_results_provider_check;
alter table public.ca_model_evaluation_results
  add constraint ca_model_evaluation_results_provider_check
  check (provider = any (array['openai'::text, 'anthropic'::text, 'gemini'::text, 'xai'::text]));

-- ── R1: fail closed twice over on the telemetry + diagnostics tables ────────────────────
-- RLS already denies; this removes the standing grant so a future permissive policy, or an
-- accidental `disable row level security`, cannot expose prompts or cost data to a browser role.

revoke all on table
  public.diag_runs,
  public.diag_steps,
  public.diag_incidents,
  public.diag_prefs,
  public.ai_requests,
  public.build_signals
from public, anon, authenticated;

grant all privileges on table
  public.diag_runs,
  public.diag_steps,
  public.diag_incidents,
  public.diag_prefs,
  public.ai_requests,
  public.build_signals
to service_role;
