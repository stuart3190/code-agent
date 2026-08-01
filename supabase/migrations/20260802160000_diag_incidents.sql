-- Private technical incidents: everything a user must never see (raw messages, stack
-- traces, provider/DB codes, service, request ids). Owner-scoped reads only, service-role
-- only writes (RLS on, no policies — browser can never reach it).
create table public.diag_incidents (
  id uuid primary key,
  reference text not null,
  owner uuid,
  conversation_id uuid,
  build_id uuid,
  run_id uuid,
  service text,
  agent text,
  model text,
  code text,
  message text,
  stack text,
  logs text,
  retry_count int default 0,
  resolved boolean default false,
  resolution text,
  created_at timestamptz not null default now()
);
create index diag_incidents_owner_idx on public.diag_incidents (owner, created_at desc);
create unique index diag_incidents_reference_idx on public.diag_incidents (reference);
alter table public.diag_incidents enable row level security;
