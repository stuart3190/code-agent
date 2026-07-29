-- Code Agent has no unauthenticated database surface. Authentication flows use
-- Supabase Auth directly; all control-plane metadata requires a user session.
revoke all privileges on table
  public.ca_repositories,
  public.ca_agents,
  public.ca_runs,
  public.ca_run_events,
  public.ca_tool_calls,
  public.ca_checkpoints,
  public.ca_artifacts,
  public.ca_repository_index_files,
  public.ca_repository_index_chunks,
  public.ca_usage_records,
  public.ca_github_installations
from anon;
