-- Builder V2 public jobs are leased through build_work_jobs/build_worker_nodes. The legacy
-- server_id column named the in-process Builder V1 server and has no V2 writer or reader. Keeping
-- its NOT NULL constraint after V1 retirement makes every real V2 job insert fail before queueing.
-- Refuse to remove it anywhere V1 rows remain, then remove the obsolete contract completely.
do $$
begin
  if exists (
    select 1 from public.build_jobs where pipeline_version is distinct from 'v2'
  ) then
    raise exception 'cannot retire build_jobs.server_id while non-V2 jobs remain';
  end if;
  if exists (
    select 1 from public.build_jobs where budget_approval_id is not null
    group by budget_approval_id having count(*) > 1
  ) then
    raise exception 'cannot enforce one build job per budget approval while duplicates remain';
  end if;
  if exists (
    select 1 from public.projects where budget_approval_id is not null
    group by budget_approval_id having count(*) > 1
  ) then
    raise exception 'cannot enforce one project per budget approval while duplicates remain';
  end if;
end
$$;

alter table public.build_jobs drop column if exists server_id;

drop index if exists public.build_jobs_budget_approval_idx;
create unique index build_jobs_budget_approval_uq on public.build_jobs(budget_approval_id)
  where budget_approval_id is not null;

drop index if exists public.projects_budget_approval_idx;
create unique index projects_budget_approval_uq on public.projects(budget_approval_id)
  where budget_approval_id is not null;
