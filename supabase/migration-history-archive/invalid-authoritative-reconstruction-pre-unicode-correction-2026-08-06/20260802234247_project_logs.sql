-- Project logs: the platform's own record of what happened to a project.
--
-- Deliberately NOT a copy of everything. Client-side runtime errors already live in
-- analytics_events and build detail already lives in diag_steps; duplicating either would create
-- two versions of the truth that drift. This table holds the lifecycle events that had no home ???
-- publish started, deployment succeeded, unpublished, domain verified ??? and the reader merges the
-- three sources into one stream.

create table if not exists public.project_logs (
  id          bigserial primary key,
  owner       uuid not null references auth.users(id) on delete cascade,
  project_id  text not null,
  logged_at   timestamptz not null default now(),
  level       text not null default 'info',        -- info | warning | error | critical
  source      text not null,                       -- publish | deploy | build | domain | system
  message     text not null,
  detail      text,
  -- Links a log line back to the thing it describes, so a deployment can open its own logs.
  ref_type    text,                                -- build | deployment | domain
  ref_id      text,
  duration_ms integer,
  constraint project_logs_level_check check (level in ('info', 'warning', 'error', 'critical'))
);

create index if not exists project_logs_project_time_idx
  on public.project_logs (project_id, logged_at desc);
create index if not exists project_logs_owner_time_idx
  on public.project_logs (owner, logged_at desc);
create index if not exists project_logs_ref_idx
  on public.project_logs (ref_type, ref_id) where ref_id is not null;

alter table public.project_logs enable row level security;
revoke all on table public.project_logs from public, anon, authenticated;
grant all privileges on table public.project_logs to service_role;
grant usage, select on sequence public.project_logs_id_seq to service_role;

-- Client-side failed requests need somewhere to record what failed and how.
alter table public.analytics_events
  add column if not exists request_url text,
  add column if not exists request_method text;

comment on table public.project_logs is
  'Deployment and platform lifecycle events. Runtime errors come from analytics_events and build detail from diag_steps; the log reader merges all three.';