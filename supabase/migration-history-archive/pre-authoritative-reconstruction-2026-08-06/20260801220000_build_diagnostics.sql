-- Permanent build diagnostics: one diag_runs row per build session (the Build ID), an
-- append-only trail of diag_steps (raw compiler/test/lint/runtime/terminal output, agent
-- prompts, diffs, usage, cost), and per-owner retention prefs. Service-role only.
create table public.diag_runs (
  id uuid primary key,
  owner uuid not null,
  project_id uuid,
  conversation_id uuid,
  kind text not null,
  status text not null default 'running',
  prompt text,
  plan text,
  model text,
  agents jsonb default '[]'::jsonb,
  repair_rounds int default 0,
  totals jsonb default '{}'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  duration_ms bigint,
  created_at timestamptz not null default now()
);
create index diag_runs_owner_idx on public.diag_runs (owner, started_at desc);
create index diag_runs_status_idx on public.diag_runs (status) where status = 'running';

create table public.diag_steps (
  id uuid primary key,
  run_id uuid not null references public.diag_runs(id) on delete cascade,
  seq int not null,
  round int default 1,
  agent text,
  kind text,
  label text,
  status text,
  prompt text,
  output text,
  output_gz text,
  usage jsonb,
  cost numeric,
  started_at timestamptz,
  duration_ms bigint,
  created_at timestamptz not null default now()
);
create index diag_steps_run_idx on public.diag_steps (run_id, seq);

create table public.diag_prefs (
  owner uuid primary key,
  retention_days int,
  updated_at timestamptz not null default now()
);

alter table public.diag_runs enable row level security;
alter table public.diag_steps enable row level security;
alter table public.diag_prefs enable row level security;
