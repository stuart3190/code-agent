create table if not exists public.build_checkpoints (
  id                  uuid primary key default gen_random_uuid(),
  owner               uuid not null references auth.users(id) on delete cascade,
  build_id            uuid not null,
  project_id          text not null,
  job_id              text,
  attempt             integer not null default 1,
  seq                 integer not null default 1,
  mark                text not null default 'generated',
  compile_ok          boolean,
  preview_ok          boolean,
  verification_passed boolean,
  status              text,
  label               text,
  file_count          integer not null default 0,
  tree                jsonb not null,
  usage_totals        jsonb,
  created_at          timestamptz not null default now(),
  expires_at          timestamptz
);

create index if not exists build_checkpoints_lifecycle_idx
  on public.build_checkpoints (owner, build_id, seq desc);
create index if not exists build_checkpoints_project_idx
  on public.build_checkpoints (owner, project_id, created_at desc);
create index if not exists build_checkpoints_expiry_idx
  on public.build_checkpoints (expires_at)
  where expires_at is not null;

comment on table public.build_checkpoints is
  'Restorable app-build repair checkpoints. Service-role only; never reachable from a browser session. Not related to ca_checkpoints (repo-agent runs).';

alter table public.build_checkpoints enable row level security;

revoke all on table public.build_checkpoints from public, anon, authenticated;
grant all privileges on table public.build_checkpoints to service_role;

alter table public.ai_requests
  add column if not exists byok boolean not null default false;

comment on column public.ai_requests.byok is
  'True when this request was billed to the user''s own provider account rather than Thrallo managed usage. Drives the rolling daily BYOK spend window.';

create index if not exists ai_requests_byok_daily_idx
  on public.ai_requests (owner, provider, created_at desc)
  where byok = true;