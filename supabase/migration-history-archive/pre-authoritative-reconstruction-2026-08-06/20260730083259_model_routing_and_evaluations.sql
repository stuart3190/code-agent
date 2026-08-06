-- Phase 6 model routing, provider health, and encrypted evaluation records.
-- All tables remain service-role only; prompts and outputs are encrypted by the shell.

alter table public.ca_ai_credentials
  drop constraint if exists ca_ai_credentials_provider_check,
  drop constraint if exists ca_ai_credentials_check;

alter table public.ca_ai_credentials
  add constraint ca_ai_credentials_provider_check
    check (provider in ('codex', 'openai', 'anthropic', 'gemini')),
  add constraint ca_ai_credentials_provider_auth_check
    check (
      (provider = 'codex' and auth_mode = 'chatgpt')
      or (provider in ('openai', 'anthropic', 'gemini') and auth_mode = 'api_key')
    );

alter table public.ca_ai_preferences
  drop constraint if exists ca_ai_preferences_active_provider_check;

alter table public.ca_ai_preferences
  add constraint ca_ai_preferences_active_provider_check
    check (active_provider in ('managed', 'codex', 'openai', 'anthropic', 'gemini')),
  add column routing_mode text not null default 'balanced'
    check (routing_mode in ('balanced', 'quality', 'fast', 'economy', 'manual')),
  add column preferred_model text
    check (preferred_model is null or char_length(preferred_model) between 1 and 200),
  add column allow_fallback boolean not null default true,
  add constraint ca_ai_preferences_manual_model_check
    check (routing_mode <> 'manual' or preferred_model is not null);

create table public.ca_model_attempts (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  run_id uuid references public.ca_runs(id) on delete set null,
  provider text not null check (provider in ('openai', 'anthropic', 'gemini')),
  model text not null check (char_length(model) between 1 and 200),
  route_mode text not null
    check (route_mode in ('balanced', 'quality', 'fast', 'economy', 'manual', 'evaluation')),
  attempt_order smallint not null default 1 check (attempt_order between 1 and 10),
  status text not null check (status in ('success', 'error')),
  latency_ms bigint not null check (latency_ms >= 0),
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  total_tokens bigint not null default 0 check (total_tokens >= 0),
  error_code text,
  retryable boolean not null default false,
  created_at timestamptz not null default now()
);

create index ca_model_attempts_owner_created_idx
  on public.ca_model_attempts(owner, created_at desc);
create index ca_model_attempts_run_id_idx
  on public.ca_model_attempts(run_id)
  where run_id is not null;
create index ca_model_attempts_health_idx
  on public.ca_model_attempts(owner, provider, model, created_at desc);

create table public.ca_model_evaluations (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  label text not null check (char_length(label) between 1 and 120),
  prompt_encrypted text not null,
  prompt_hash text not null check (char_length(prompt_hash) = 64),
  requested_models jsonb not null default '[]'::jsonb,
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed')),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index ca_model_evaluations_owner_created_idx
  on public.ca_model_evaluations(owner, created_at desc);

create table public.ca_model_evaluation_results (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  evaluation_id uuid not null references public.ca_model_evaluations(id) on delete cascade,
  provider text not null check (provider in ('openai', 'anthropic', 'gemini')),
  model text not null check (char_length(model) between 1 and 200),
  status text not null check (status in ('success', 'error')),
  latency_ms bigint not null check (latency_ms >= 0),
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  total_tokens bigint not null default 0 check (total_tokens >= 0),
  output_encrypted text,
  error_code text,
  error text,
  created_at timestamptz not null default now(),
  unique (evaluation_id, provider, model)
);

create index ca_model_evaluation_results_owner_created_idx
  on public.ca_model_evaluation_results(owner, created_at desc);
create index ca_model_evaluation_results_evaluation_idx
  on public.ca_model_evaluation_results(evaluation_id);

alter table public.ca_model_attempts enable row level security;
alter table public.ca_model_evaluations enable row level security;
alter table public.ca_model_evaluation_results enable row level security;

revoke all on table
  public.ca_model_attempts,
  public.ca_model_evaluations,
  public.ca_model_evaluation_results
from public, anon, authenticated;

grant all privileges on table
  public.ca_model_attempts,
  public.ca_model_evaluations,
  public.ca_model_evaluation_results
to service_role;

create policy "ca_model_attempts_browser_deny"
  on public.ca_model_attempts
  as restrictive for all to anon, authenticated
  using (false) with check (false);

create policy "ca_model_evaluations_browser_deny"
  on public.ca_model_evaluations
  as restrictive for all to anon, authenticated
  using (false) with check (false);

create policy "ca_model_evaluation_results_browser_deny"
  on public.ca_model_evaluation_results
  as restrictive for all to anon, authenticated
  using (false) with check (false);
