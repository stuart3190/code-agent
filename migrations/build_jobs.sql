-- Background builds (2026-07-20) — server-side build jobs + coarse status stream.
-- Applied live via the Supabase MCP the day it was written; kept here as the record.
--
-- A generate request creates a job row and returns immediately; the engine loop runs detached
-- in the shell server (in-memory registry is the live source, this table is write-through) so a
-- build survives the browser navigating away. The client observes ONLY coarse phases
-- (queued/preparing/planning/building/finalizing -> complete/failed/interrupted) — engine
-- internals never enter the client stream.
--
-- RLS: owner SELECT only. All writes are service-role (the shell server); there are no
-- insert/update/delete policies on purpose. `result` holds the whitelisted terminal payload
-- (tree/finalText/previewUrl/...) so a client that reattaches after completion can still save
-- the build via its own RLS-scoped projects write — the server stays out of the projects row.
-- `build_stderr` stays server-side only (full of file paths; feeds the Fix-it prompt) — it is
-- deliberately NOT part of `result`.
-- `server_id` scopes the restart sweep: local dev and prod share this Supabase project, so a
-- dev restart must never mark prod's running jobs interrupted.

create table if not exists public.build_jobs (
  id           uuid primary key default gen_random_uuid(),
  owner        uuid not null,
  project_id   text not null,          -- text, not uuid: generate tolerates ad-hoc ids
  mode         text not null,          -- build | iterate | plan
  status       text not null default 'queued',  -- queued | running | complete | failed | interrupted
  phase        text not null default 'queued',  -- queued | preparing | planning | building | finalizing | complete | failed | interrupted
  error        text,                   -- human-readable, client-visible on failed/interrupted
  result       jsonb,                  -- whitelisted terminal payload (see buildJobs.mjs)
  build_stderr text,                   -- server-side only; Fix-it composes from this
  server_id    text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists build_jobs_project_idx on public.build_jobs (project_id, created_at desc);
create index if not exists build_jobs_owner_status_idx on public.build_jobs (owner, status);

alter table public.build_jobs enable row level security;

-- Owner can read their own jobs (reattach after completion reads `result`); nobody but the
-- service role writes.
drop policy if exists "build_jobs_owner_read" on public.build_jobs;
create policy "build_jobs_owner_read" on public.build_jobs
  for select using (auth.uid() = owner);
