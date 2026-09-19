-- Reconcile privilege drift created by the historical Supabase default that automatically granted
-- browser roles access to new objects in public. The authoritative 60 migrations never contained
-- these grants; current local Supabase correctly defaults to fail-closed.
--
-- Forward repair: this migration is idempotent and can be reapplied if a deployment is interrupted.
-- Rollback guidance: do NOT restore the unsafe anon/authenticated write grants. If server access is
-- disrupted, re-grant the affected object to service_role as a forward repair. Authenticated read
-- access is intentionally retained only on the eight control-plane metadata tables and deployments.

-- Builder V2 is server-only while rollout remains paused. RLS is defense in depth; object grants
-- must also fail closed so a future policy cannot accidentally expose an internal store.
revoke all privileges on table
  public.bv2_feature_flags,
  public.bv2_migration_state,
  public.bv2_project_knowledge,
  public.bv2_file_revisions,
  public.bv2_symbols,
  public.bv2_symbol_refs,
  public.bv2_dependency_edges,
  public.bv2_snapshots,
  public.bv2_project_pointers,
  public.bv2_snapshot_files,
  public.bv2_blobs,
  public.bv2_contracts,
  public.bv2_retrieval_traces,
  public.bv2_patches,
  public.bv2_verification_cache,
  public.bv2_builds,
  public.bv2_assets
from public, anon, authenticated;

grant all privileges on table
  public.bv2_feature_flags,
  public.bv2_migration_state,
  public.bv2_project_knowledge,
  public.bv2_file_revisions,
  public.bv2_symbols,
  public.bv2_symbol_refs,
  public.bv2_dependency_edges,
  public.bv2_snapshots,
  public.bv2_project_pointers,
  public.bv2_snapshot_files,
  public.bv2_blobs,
  public.bv2_contracts,
  public.bv2_retrieval_traces,
  public.bv2_patches,
  public.bv2_verification_cache,
  public.bv2_builds,
  public.bv2_assets
to service_role;

-- These tables were deliberately browser-readable, not browser-writable. Revoke the implicit
-- write grants while preserving their owner-scoped SELECT policies.
revoke all privileges on table
  public.ca_agents,
  public.ca_artifacts,
  public.ca_checkpoints,
  public.ca_github_installations,
  public.ca_repositories,
  public.ca_run_events,
  public.ca_runs,
  public.ca_usage_records
from public, anon, authenticated;

grant select on table
  public.ca_agents,
  public.ca_artifacts,
  public.ca_checkpoints,
  public.ca_github_installations,
  public.ca_repositories,
  public.ca_run_events,
  public.ca_runs,
  public.ca_usage_records
to authenticated;

-- Deployment history is owner-readable through RLS but only the control plane may mutate it.
revoke all privileges on table public.deployments from public, anon, authenticated;
grant select on table public.deployments to authenticated;
grant all privileges on table public.deployments to service_role;

-- All current serial sequences are used by server-only write paths. Explicitly remove the hosted
-- project's legacy browser grants and retain complete service-role access.
revoke all privileges on all sequences in schema public from public, anon, authenticated;
grant all privileges on all sequences in schema public to service_role;

-- This helper exists only to support deployment indexes; it is not a public RPC.
revoke all on function public.deployment_scope(uuid, text) from public, anon, authenticated;
grant execute on function public.deployment_scope(uuid, text) to service_role;

-- Make future migration behavior explicit and independent of hosted-project creation defaults.
alter default privileges for role postgres in schema public
  revoke all privileges on tables from public, anon, authenticated;
alter default privileges for role postgres in schema public
  grant all privileges on tables to service_role;
alter default privileges for role postgres in schema public
  revoke all privileges on sequences from public, anon, authenticated;
alter default privileges for role postgres in schema public
  grant all privileges on sequences to service_role;
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;
alter default privileges for role postgres in schema public
  grant execute on functions to service_role;
