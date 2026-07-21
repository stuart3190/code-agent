create table if not exists public.app_analytics_events (
  id bigint generated always as identity primary key,
  app_id text not null,
  owner uuid not null references auth.users(id) on delete cascade,
  app_user_id uuid references auth.users(id) on delete set null,
  session_id text not null check (char_length(session_id) between 8 and 100),
  name text not null check (name ~ '^[a-z][a-z0-9_.-]{1,79}$'),
  path text not null default '/' check (char_length(path) <= 500),
  properties jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists app_analytics_owner_app_created_idx on public.app_analytics_events(owner, app_id, created_at desc);
create index if not exists app_analytics_app_session_idx on public.app_analytics_events(app_id, session_id, created_at desc);
create index if not exists app_analytics_user_idx on public.app_analytics_events(app_user_id, created_at desc);

alter table public.app_analytics_events enable row level security;
drop policy if exists app_analytics_owner_read on public.app_analytics_events;
create policy app_analytics_owner_read on public.app_analytics_events for select to authenticated
  using ((select auth.uid()) = owner);
revoke all on table public.app_analytics_events from anon, authenticated;
grant select on table public.app_analytics_events to authenticated;
