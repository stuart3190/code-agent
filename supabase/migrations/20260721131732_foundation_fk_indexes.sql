create index if not exists audit_events_actor_idx on public.audit_events(actor_id);
create index if not exists audit_events_project_idx on public.audit_events(project_id);
create index if not exists background_tasks_project_idx on public.background_tasks(project_id);
create index if not exists project_environments_owner_idx on public.project_environments(owner);
create index if not exists project_releases_project_idx on public.project_releases(project_id);
