-- Thrallo Analytics: privacy-first, cookieless, native.
--
-- No cookie, no persistent identifier, nothing that follows a person between days or between
-- sites. A "visitor" is sha256(daily salt + ip + user agent + app), where the salt is random per
-- day and DELETED after two days ??? after which yesterday's hashes cannot be recomputed even by us,
-- even holding the raw IP. That is what makes this lawful without a consent banner, and it is why
-- the salt table has its own sweeper.
--
-- Raw IPs are never written. They exist only inside the hash function, for the length of one
-- request.

create table if not exists public.analytics_salts (
  day        date primary key,
  salt       text not null,
  created_at timestamptz not null default now()
);

-- Raw events, kept briefly and rolled up. This is the only table holding per-visit rows.
create table if not exists public.analytics_events (
  id           bigserial primary key,
  owner        uuid not null references auth.users(id) on delete cascade,
  project_id   text not null,
  app_id       text not null,
  kind         text not null,                      -- pageview | vitals | error
  occurred_at  timestamptz not null default now(),
  visitor_hash text not null,                      -- cookieless, unrecoverable after 2 days
  session_hash text not null,                      -- visitor + 30-minute window
  path         text,
  referrer_host text,
  browser      text,
  os           text,
  device       text,                               -- desktop | mobile | tablet
  -- Core Web Vitals, milliseconds except CLS which is unitless.
  lcp_ms       integer, fcp_ms integer, inp_ms integer, ttfb_ms integer,
  cls          numeric(6,4),
  load_ms      integer,
  -- Errors
  error_message text, error_source text, error_stack text,
  status_code  integer,
  constraint analytics_events_kind_check check (kind in ('pageview', 'vitals', 'error'))
);

create index if not exists analytics_events_project_time_idx
  on public.analytics_events (project_id, occurred_at desc);
create index if not exists analytics_events_owner_time_idx
  on public.analytics_events (owner, occurred_at desc);
-- Live visitors reads only the last few minutes.
create index if not exists analytics_events_recent_idx
  on public.analytics_events (occurred_at desc) where kind = 'pageview';

-- Daily rollups. Retention is enforced here (7 / 90 / unlimited by plan), so history survives long
-- after the raw rows are gone and queries stay cheap regardless of traffic.
create table if not exists public.analytics_daily (
  project_id   text not null,
  owner        uuid not null references auth.users(id) on delete cascade,
  day          date not null,
  dimension    text not null,                      -- totals | path | referrer | browser | os | device
  key          text not null default '',
  pageviews    integer not null default 0,
  visitors     integer not null default 0,
  sessions     integer not null default 0,
  errors       integer not null default 0,
  -- Averages are stored as sums plus a count so days can be merged without losing accuracy.
  lcp_sum bigint not null default 0, fcp_sum bigint not null default 0,
  inp_sum bigint not null default 0, ttfb_sum bigint not null default 0,
  load_sum bigint not null default 0, cls_sum numeric(12,4) not null default 0,
  vitals_count integer not null default 0,
  updated_at   timestamptz not null default now(),
  primary key (project_id, day, dimension, key)
);

create index if not exists analytics_daily_owner_idx on public.analytics_daily (owner, day desc);

-- Service-role only, browser denied, exactly like every other control-plane table. Every read goes
-- through an owner-checked endpoint; the browser never queries these directly.
alter table public.analytics_salts  enable row level security;
alter table public.analytics_events enable row level security;
alter table public.analytics_daily  enable row level security;

revoke all on table public.analytics_salts, public.analytics_events, public.analytics_daily
  from public, anon, authenticated;
grant all privileges on table public.analytics_salts, public.analytics_events, public.analytics_daily
  to service_role;
grant usage, select on sequence public.analytics_events_id_seq to service_role;

comment on table public.analytics_salts is
  'Daily random salts for visitor hashing. Deleted after 2 days so historical hashes become uncorrelatable ??? this is what removes the need for a cookie banner.';
comment on column public.analytics_events.visitor_hash is
  'sha256(daily salt + ip + user agent + app). No raw IP is ever stored.';