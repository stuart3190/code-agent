-- Cover the project-id side of runtime foreign keys for fast cascades and lookups.
create index if not exists action_schedules_project_idx on public.action_schedules(project_id);
create index if not exists knowledge_chunks_project_idx on public.knowledge_chunks(project_id);
create index if not exists knowledge_documents_project_id_idx on public.knowledge_documents(project_id);
create index if not exists runtime_usage_project_idx on public.runtime_usage(project_id);
