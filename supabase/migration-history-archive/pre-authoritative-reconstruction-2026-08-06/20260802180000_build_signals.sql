-- Anonymous behavioural signals per build. NO prompt text, NO user-identifiable data —
-- owner is kept only to scope writes and is never exposed in analytics output.
create table public.build_signals (
  id uuid primary key,
  build_id uuid not null,
  owner uuid,
  signal text not null,
  created_at timestamptz not null default now()
);
create index build_signals_build_idx on public.build_signals (build_id, signal);
create unique index build_signals_unique_idx on public.build_signals (build_id, signal);
alter table public.build_signals enable row level security;
