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