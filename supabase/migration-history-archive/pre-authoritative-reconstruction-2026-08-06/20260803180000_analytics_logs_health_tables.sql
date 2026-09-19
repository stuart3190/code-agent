-- Reconciliation: analytics, project logs and health monitoring.
--
-- These six tables were applied directly to production and never written here, so the database
-- could not be rebuilt from the repo and none of them were picked up by the backup coverage guard
-- (which enumerates `create table` across migrations). That is the same class as audit finding D3.
--
-- Written from the live `information_schema` so a fresh apply reproduces production exactly, and
-- fully idempotent so applying it to the existing database is a no-op.
--
-- Ownership note: `owner` is the PRINCIPAL, not necessarily a person. Nothing here assumes a single
-- human — when organisations arrive, `owner` becomes the org and these tables need no rewrite.

-- ── Analytics ────────────────────────────────────────────────────────────────────────────
-- Daily salts for cookieless visitor hashing. Deleted after two days by the rollup sweeper, which
-- is what makes historical hashes uncorrelatable and removes the need for a consent banner.
create table if not exists public.analytics_salts (
  day        date primary key,
  salt       text not null,
  created_at timestamptz not null default now()
);

-- Raw events. Held ~3 days, rolled up, then deleted.
create table if not exists public.analytics_events (
  id            bigserial primary key,
  owner         uuid not null references auth.users(id) on delete cascade,
  project_id    text not null,
  app_id        text not null,
  kind          text not null,
  occurred_at   timestamptz not null default now(),
  visitor_hash  text not null,
  session_hash  text not null,
  path          text,
  referrer_host text,
  browser       text,
  os            text,
  device        text,
  lcp_ms        integer,
  fcp_ms        integer,
  inp_ms        integer,
  ttfb_ms       integer,
  cls           numeric(6,4),
  load_ms       integer,
  error_message text,
  error_source  text,
  error_stack   text,
  status_code   integer,
  request_url    text,
  request_method text,
  constraint analytics_events_kind_check check (kind in ('pageview', 'vitals', 'error'))
);

create index if not exists analytics_events_project_time_idx
  on public.analytics_events (project_id, occurred_at desc);
create index if not exists analytics_events_owner_time_idx
  on public.analytics_events (owner, occurred_at desc);
create index if not exists analytics_events_recent_idx
  on public.analytics_events (occurred_at desc) where kind = 'pageview';

-- Daily rollups. The primary key is what `rollup.mjs` upserts against
-- (onConflict: "project_id,day,dimension,key") — without it every rollup throws.
create table if not exists public.analytics_daily (
  project_id   text not null,
  owner        uuid not null references auth.users(id) on delete cascade,
  day          date not null,
  dimension    text not null,
  key          text not null default '',
  pageviews    integer not null default 0,
  visitors     integer not null default 0,
  sessions     integer not null default 0,
  errors       integer not null default 0,
  lcp_sum      bigint not null default 0,
  fcp_sum      bigint not null default 0,
  inp_sum      bigint not null default 0,
  ttfb_sum     bigint not null default 0,
  load_sum     bigint not null default 0,
  cls_sum      numeric(12,4) not null default 0,
  vitals_count integer not null default 0,
  updated_at   timestamptz not null default now(),
  primary key (project_id, day, dimension, key)
);

create index if not exists analytics_daily_owner_idx on public.analytics_daily (owner, day desc);

-- ── Project logs ─────────────────────────────────────────────────────────────────────────
-- Lifecycle events only. Runtime errors live in analytics_events and build detail in diag_steps;
-- the log reader merges all three so there is one version of each fact.
create table if not exists public.project_logs (
  id          bigserial primary key,
  owner       uuid not null references auth.users(id) on delete cascade,
  project_id  text not null,
  logged_at   timestamptz not null default now(),
  level       text not null default 'info',
  source      text not null,
  message     text not null,
  detail      text,
  ref_type    text,
  ref_id      text,
  duration_ms integer,
  constraint project_logs_level_check check (level in ('info', 'warning', 'error', 'critical'))
);

create index if not exists project_logs_project_time_idx on public.project_logs (project_id, logged_at desc);
create index if not exists project_logs_owner_time_idx on public.project_logs (owner, logged_at desc);
create index if not exists project_logs_ref_idx on public.project_logs (ref_type, ref_id) where ref_id is not null;

-- ── Health monitoring ────────────────────────────────────────────────────────────────────
-- Every check is stored: uptime percentage and response trends cannot be reconstructed from a
-- single latest row.
create table if not exists public.health_checks (
  id            bigserial primary key,
  owner         uuid not null references auth.users(id) on delete cascade,
  project_id    text not null,
  checked_at    timestamptz not null default now(),
  url           text not null,
  status        text not null,
  http_status   integer,
  response_ms   integer,
  ssl_valid_to  timestamptz,
  ssl_days_left integer,
  dns_ok        boolean,
  detail        text,
  constraint health_checks_status_check check (status in ('healthy', 'warning', 'offline'))
);

create index if not exists health_checks_project_time_idx on public.health_checks (project_id, checked_at desc);
create index if not exists health_checks_owner_time_idx on public.health_checks (owner, checked_at desc);

-- Current state per project plus alerting bookkeeping. Alerts fire on TRANSITION, never per check,
-- which is what `alerted` records.
create table if not exists public.health_status (
  project_id           text primary key,
  owner                uuid not null references auth.users(id) on delete cascade,
  status               text not null default 'healthy',
  since                timestamptz not null default now(),
  last_checked_at      timestamptz,
  last_healthy_at      timestamptz,
  url                  text,
  http_status          integer,
  response_ms          integer,
  ssl_valid_to         timestamptz,
  ssl_days_left        integer,
  dns_ok               boolean,
  detail               text,
  consecutive_failures integer not null default 0,
  alerted              jsonb not null default '{}'::jsonb,
  updated_at           timestamptz not null default now(),
  constraint health_status_status_check check (status in ('healthy', 'warning', 'offline'))
);

create index if not exists health_status_owner_idx on public.health_status (owner);

-- ── Security posture ─────────────────────────────────────────────────────────────────────
-- Service-role only with the browser denied, matching every other control-plane table. Every read
-- goes through an owner-checked endpoint; the browser never queries these directly.
alter table public.analytics_salts  enable row level security;
alter table public.analytics_events enable row level security;
alter table public.analytics_daily  enable row level security;
alter table public.project_logs     enable row level security;
alter table public.health_checks    enable row level security;
alter table public.health_status    enable row level security;

revoke all on table
  public.analytics_salts, public.analytics_events, public.analytics_daily,
  public.project_logs, public.health_checks, public.health_status
  from public, anon, authenticated;

grant all privileges on table
  public.analytics_salts, public.analytics_events, public.analytics_daily,
  public.project_logs, public.health_checks, public.health_status
  to service_role;

grant usage, select on sequence public.analytics_events_id_seq to service_role;
grant usage, select on sequence public.project_logs_id_seq to service_role;
grant usage, select on sequence public.health_checks_id_seq to service_role;

-- ── Drift detection support ──────────────────────────────────────────────────────────────
-- CI reads migrations and therefore cannot see a table that was applied straight to production —
-- exactly how the six tables above went unnoticed and unbacked-up. `ops/migration-drift.mjs` needs
-- to enumerate what really exists, and information_schema is not reachable through PostgREST.
--
-- security definer so it can read the catalog, but granted ONLY to service_role and returning
-- nothing but table names: no row data, and no reachability for anon or authenticated.
drop function if exists public.thrallo_public_tables();
create function public.thrallo_public_tables()
returns table (table_name text, project_scoped boolean)
language sql
security definer
set search_path = public, pg_catalog
as $
  select c.relname::text,
         exists (
           select 1 from pg_attribute a
            where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
              and a.attname in ('project_id', 'app_id')
         )
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
   order by c.relname;
$;

revoke all on function public.thrallo_public_tables() from public, anon, authenticated;
grant execute on function public.thrallo_public_tables() to service_role;

comment on function public.thrallo_public_tables is
  'Table names only, service-role only. Backs the migration-drift check, which is the only thing that can catch a table applied to production without a migration.';

comment on table public.analytics_salts is
  'Daily random salts for visitor hashing. Deleted after 2 days so historical hashes become uncorrelatable — this is what removes the need for a cookie banner.';
comment on column public.analytics_events.visitor_hash is
  'sha256(daily salt + ip + user agent + app). No raw IP is ever stored.';
comment on table public.project_logs is
  'Deployment and platform lifecycle events. Runtime errors come from analytics_events and build detail from diag_steps; the log reader merges all three.';
comment on table public.health_status is
  'Current health per project plus alerting state. Alerts fire on transition, never per check.';
