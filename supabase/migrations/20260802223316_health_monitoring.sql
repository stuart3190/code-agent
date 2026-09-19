-- Health monitoring for published sites.
--
-- Every check is stored rather than only the latest, because uptime percentage and response-time
-- trends are the whole point and neither can be reconstructed from a single row. Checks are cheap
-- and small; 30 days of them at one every five minutes is a few thousand rows per site.

create table if not exists public.health_checks (
  id           bigserial primary key,
  owner        uuid not null references auth.users(id) on delete cascade,
  project_id   text not null,
  checked_at   timestamptz not null default now(),
  url          text not null,
  status       text not null,                      -- healthy | warning | offline
  http_status  integer,
  response_ms  integer,
  ssl_valid_to timestamptz,
  ssl_days_left integer,
  dns_ok       boolean,
  detail       text,                               -- why it is not healthy, in the owner's words
  constraint health_checks_status_check check (status in ('healthy', 'warning', 'offline'))
);

create index if not exists health_checks_project_time_idx
  on public.health_checks (project_id, checked_at desc);
create index if not exists health_checks_owner_time_idx
  on public.health_checks (owner, checked_at desc);

-- The current state per project, so the dashboard reads one row per card instead of scanning
-- history. Also holds the alerting state: alerts fire on TRANSITION, never on every check, or a
-- site down overnight would send hundreds of notifications.
create table if not exists public.health_status (
  project_id     text primary key,
  owner          uuid not null references auth.users(id) on delete cascade,
  status         text not null default 'healthy',
  since          timestamptz not null default now(),
  last_checked_at timestamptz,
  last_healthy_at timestamptz,
  url            text,
  http_status    integer,
  response_ms    integer,
  ssl_valid_to   timestamptz,
  ssl_days_left  integer,
  dns_ok         boolean,
  detail         text,
  consecutive_failures integer not null default 0,
  -- One row per alert kind, so a fresh problem still alerts while an ongoing one stays quiet.
  alerted        jsonb not null default '{}'::jsonb,
  updated_at     timestamptz not null default now(),
  constraint health_status_status_check check (status in ('healthy', 'warning', 'offline'))
);

create index if not exists health_status_owner_idx on public.health_status (owner);

alter table public.health_checks enable row level security;
alter table public.health_status enable row level security;
revoke all on table public.health_checks, public.health_status from public, anon, authenticated;
grant all privileges on table public.health_checks, public.health_status to service_role;
grant usage, select on sequence public.health_checks_id_seq to service_role;

comment on table public.health_status is
  'Current health per project plus alerting state. Alerts fire on transition, never per check.';