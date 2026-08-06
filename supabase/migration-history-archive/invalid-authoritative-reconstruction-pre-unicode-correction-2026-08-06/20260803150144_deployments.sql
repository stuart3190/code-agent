create table if not exists public.deployments (
  id                  uuid primary key default gen_random_uuid(),
  owner               uuid not null,
  project_id          text not null,
  product_id          uuid,
  number              integer not null,
  triggered_by        uuid,
  triggered_by_kind   text not null default 'user'
                        check (triggered_by_kind in ('user', 'system', 'rollback')),
  environment         text not null default 'production'
                        check (environment in ('production', 'preview')),
  status              text not null default 'building'
                        check (status in ('building', 'deploying', 'live', 'failed', 'rolled_back', 'superseded')),
  build_run_id        uuid,
  source_project_id   text,
  source_tree         jsonb,
  build_started_at    timestamptz,
  build_completed_at  timestamptz,
  deploy_started_at   timestamptz,
  deployed_at         timestamptz,
  build_duration_ms   integer,
  deploy_duration_ms  integer,
  url                 text,
  slug                text,
  failure_reason      text,
  rolled_back_from    uuid references public.deployments(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create or replace function public.deployment_scope(p_product uuid, p_project text)
  returns text language sql immutable as $$
    select coalesce(p_product::text, p_project);
  $$;

create unique index if not exists deployments_number_unique
  on public.deployments (owner, public.deployment_scope(product_id, project_id), number);

create unique index if not exists deployments_one_live_per_app
  on public.deployments (owner, public.deployment_scope(product_id, project_id))
  where status = 'live';

create index if not exists deployments_project_idx on public.deployments (owner, project_id, created_at desc);
create index if not exists deployments_product_idx on public.deployments (owner, product_id, number desc);
create index if not exists deployments_build_run_idx on public.deployments (build_run_id);

alter table public.deployments enable row level security;

drop policy if exists deployments_owner_read on public.deployments;
create policy deployments_owner_read on public.deployments
  for select using (auth.uid() = owner);

grant select on public.deployments to authenticated;

comment on table public.deployments is
  'One immutable row per publish, publish update or rollback. History is permanent: rows are never deleted except with their project, and a new publish supersedes rather than overwrites.';
comment on column public.deployments.source_tree is
  'The exact source published. Retained for the life of the deployment so rollback restores what actually shipped and Download never returns newer source.';
comment on column public.deployments.rolled_back_from is
  'For a rollback record: the deployment whose source was restored. The original history is left untouched.';