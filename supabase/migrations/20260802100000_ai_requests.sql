-- Per-AI-request accounting for builds: provider, model, agent, token classes, duration,
-- exact cost, build + project linkage. Service-role only (RLS enabled, zero policies —
-- the browser can never read this table directly; every API path is owner-scoped).
create table public.ai_requests (
  id uuid primary key,
  owner uuid not null,
  provider text,
  model text,
  agent text,
  input_tokens bigint default 0,
  output_tokens bigint default 0,
  cached_tokens bigint default 0,
  reasoning_tokens bigint default 0,
  duration_ms bigint,
  cost numeric,
  build_id uuid,
  project_id uuid,
  created_at timestamptz not null default now()
);
create index ai_requests_owner_idx on public.ai_requests (owner, created_at desc);
create index ai_requests_build_idx on public.ai_requests (build_id);
alter table public.ai_requests enable row level security;
