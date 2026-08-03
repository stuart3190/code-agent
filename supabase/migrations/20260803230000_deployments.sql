-- Deployments: a real publish history.
--
-- Until now "Deployments" was a reformatted view of diag_runs — diagnostic BUILD runs, which are
-- not publishes at all. A build that was never published appeared as a deployment; a publish of an
-- unchanged tree appeared as nothing; and published_sites holds ONE row per project, overwritten on
-- every publish, so the previous deployment was destroyed each time.
--
-- This table is append-only in spirit: a row is written when a publish starts and only ever moves
-- forward through its own lifecycle. Publishing again writes a NEW row and marks the old one
-- superseded. Nothing is overwritten, so "what was live last Tuesday" has an answer.

create table if not exists public.deployments (
  id                  uuid primary key default gen_random_uuid(),
  owner               uuid not null,
  project_id          text not null,
  product_id          uuid,

  -- Per-product, not per-row-in-a-table: #7 means "the seventh time this app went out", which is
  -- what someone reading the list is asking. A rebuild creates a new project row under the same
  -- product, and restarting at #1 there would make the history unreadable.
  number              integer not null,

  -- The real account that asked for it, or null for a system action. No invented Git author.
  triggered_by        uuid,
  triggered_by_kind   text not null default 'user'
                        check (triggered_by_kind in ('user', 'system', 'rollback')),

  environment         text not null default 'production'
                        check (environment in ('production', 'preview')),

  status              text not null default 'building'
                        check (status in ('building', 'deploying', 'live', 'failed', 'rolled_back', 'superseded')),

  -- The diagnostic run whose steps ARE this deployment's build log. Null when a publish had no
  -- build run to attach to; the UI then hides View Logs rather than showing the whole stream.
  build_run_id        uuid,

  -- Which project's tree was published. For a rollback this is the ORIGINAL project, which is not
  -- necessarily the project the rollback was requested from.
  source_project_id   text,
  -- The exact tree that was published. This is what rollback restores and what Download returns,
  -- and it is why an older deployment can never hand back today's source.
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

  -- Set on a rollback record: the deployment whose source this one restored.
  rolled_back_from    uuid references public.deployments(id) on delete set null,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- The app a deployment belongs to. Products own the numbering and the "one live" rule; a project
-- with no product stands alone and is keyed by its own id.
create or replace function public.deployment_scope(p_product uuid, p_project text)
  returns text language sql immutable as $$
    select coalesce(p_product::text, p_project);
  $$;

-- Numbers are unique within an app, so two concurrent publishes cannot both claim #7 — the loser
-- retries rather than silently duplicating.
create unique index if not exists deployments_number_unique
  on public.deployments (owner, public.deployment_scope(product_id, project_id), number);

-- Exactly one live deployment per app. The same shape as published_sites' rule, for the same
-- reason: two rows claiming to be what is serving means some surface has to guess.
create unique index if not exists deployments_one_live_per_app
  on public.deployments (owner, public.deployment_scope(product_id, project_id))
  where status = 'live';

create index if not exists deployments_project_idx on public.deployments (owner, project_id, created_at desc);
create index if not exists deployments_product_idx on public.deployments (owner, product_id, number desc);
create index if not exists deployments_build_run_idx on public.deployments (build_run_id);

alter table public.deployments enable row level security;

-- Read-only to the owner; every write goes through the service role, so a client cannot invent a
-- deployment or promote one to live.
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
