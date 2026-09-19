alter table public.app_users add column if not exists status text not null default 'active'
  check (status in ('active', 'disabled'));
alter table public.app_users add column if not exists updated_at timestamptz not null default now();
create index if not exists app_users_app_created_idx on public.app_users(app_id, created_at desc);
