-- WP8 — application settings and append-only audit history.
--
-- ADDITIVE and idempotent. Nothing is dropped, altered or deleted. Every table is service-role
-- only (deny-all RLS): the app-accounts Edge Function is the only writer, so a generated client
-- can neither set an application-wide value it has no grant for nor write its own history.
--
-- Audit capture is OPT-IN PER APPLICATION. The trigger below appends an entity-mutation event
-- only for applications that have a row in app_audit_config with enabled = true, so an
-- application that never selected the audit module pays nothing and stores nothing. The trigger
-- deliberately records WHO changed WHICH record WHEN and never the values: field-level diffs
-- exist only where the platform mediates the write (the account and settings commands), which is
-- the only place redaction can be applied truthfully.

create table if not exists public.app_settings (
  app_id text not null,
  scope text not null,
  scope_target text not null default '',
  key text not null,
  value jsonb,
  version int not null default 1,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (app_id, scope, scope_target, key),
  constraint app_settings_scope_check check (scope in ('app', 'user', 'workspace'))
);
alter table public.app_settings enable row level security;
revoke all on table public.app_settings from public, anon, authenticated;
grant all privileges on table public.app_settings to service_role;

create table if not exists public.app_audit_events (
  id uuid primary key default gen_random_uuid(),
  app_id text not null,
  actor_user_id uuid,
  actor_email text,
  action text not null,
  resource text,
  resource_id text,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);
create index if not exists app_audit_events_app_time_idx on public.app_audit_events (app_id, created_at desc);
create index if not exists app_audit_events_resource_idx on public.app_audit_events (app_id, resource, resource_id, created_at desc);
alter table public.app_audit_events enable row level security;
revoke all on table public.app_audit_events from public, anon, authenticated;
grant all privileges on table public.app_audit_events to service_role;

-- History is append-only for everyone, including the service role: a row, once written, is a
-- fact. Removing an application's data on teardown happens through the erasure path, which runs
-- as the table owner and is not bound by these policies.
create or replace function public.app_audit_events_append_only()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'app_audit_events is append-only';
end;
$$;

drop trigger if exists app_audit_events_no_update on public.app_audit_events;
create trigger app_audit_events_no_update
  before update on public.app_audit_events
  for each row execute function public.app_audit_events_append_only();

create table if not exists public.app_audit_config (
  app_id text primary key,
  enabled boolean not null default false,
  sensitive_fields jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.app_audit_config enable row level security;
revoke all on table public.app_audit_config from public, anon, authenticated;
grant all privileges on table public.app_audit_config to service_role;

-- Entity mutations become history only for applications that opted in. Identity and action only:
-- the values stay out, so no sensitive field can reach a row through this path.
create or replace function public.app_entities_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  row_app_id text := coalesce(new.app_id, old.app_id);
  row_enabled boolean;
begin
  if row_app_id is null then
    return coalesce(new, old);
  end if;
  select enabled into row_enabled from public.app_audit_config where app_id = row_app_id;
  if row_enabled is not true then
    return coalesce(new, old);
  end if;
  insert into public.app_audit_events (app_id, actor_user_id, action, resource, resource_id)
  values (
    row_app_id,
    auth.uid(),
    lower(tg_op),
    coalesce(new.type, old.type),
    coalesce(new.id, old.id)::text
  );
  return coalesce(new, old);
end;
$$;

drop trigger if exists app_entities_audit_trigger on public.entities;
create trigger app_entities_audit_trigger
  after insert or update or delete on public.entities
  for each row execute function public.app_entities_audit();
