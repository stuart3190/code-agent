alter table public.app_users add column if not exists status text not null default 'active';
alter table public.app_auth_events add column if not exists key text;
create index if not exists app_auth_events_kind_key_time_idx on public.app_auth_events (kind, key, created_at desc);