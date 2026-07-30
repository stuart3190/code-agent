import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationPath = new URL("../../supabase/migrations/20260729122234_code_agent_control_plane.sql", import.meta.url);
const githubMigrationPath = new URL("../../supabase/migrations/20260729140251_github_app_installations.sql", import.meta.url);
const hardeningMigrationPath = new URL("../../supabase/migrations/20260729164642_harden_code_agent_schema.sql", import.meta.url);
const anonLockdownMigrationPath = new URL("../../supabase/migrations/20260729165131_lock_down_code_agent_anon_access.sql", import.meta.url);
const webhookMigrationPath = new URL("../../supabase/migrations/20260729231426_github_webhook_ledger.sql", import.meta.url);
const policyRolesMigrationPath = new URL("../../supabase/migrations/20260729232141_restrict_code_agent_policy_roles.sql", import.meta.url);
const aiConnectionsMigrationPath = new URL("../../supabase/migrations/20260729234551_ai_provider_connections.sql", import.meta.url);
const rejectAnonymousMigrationPath = new URL("../../supabase/migrations/20260729234651_reject_anonymous_code_agent_access.sql", import.meta.url);
const repositoryIndexMigrationPath = new URL("../../supabase/migrations/20260730001803_repository_hybrid_index.sql", import.meta.url);
const repositoryIntelligenceMigrationPath = new URL("../../supabase/migrations/20260730063059_repository_code_intelligence.sql", import.meta.url);
const modelRoutingMigrationPath = new URL("../../supabase/migrations/20260730083259_model_routing_and_evaluations.sql", import.meta.url);
const subscriptionsMigrationPath = new URL("../../supabase/migrations/20260730143000_subscriptions_budgets_telemetry.sql", import.meta.url);
const phase8MigrationPath = new URL("../../supabase/migrations/20260730170000_approval_policies_resume_artifacts.sql", import.meta.url);
const phase9MigrationPath = new URL("../../supabase/migrations/20260730200000_egress_command_policies_retention.sql", import.meta.url);
const apiTokensMigrationPath = new URL("../../supabase/migrations/20260730223000_api_tokens.sql", import.meta.url);

test("control-plane migration enables RLS and keeps sensitive tables server-only", async () => {
  const sql = await readFile(migrationPath, "utf8");
  const tables = [
    "ca_repositories", "ca_agents", "ca_runs", "ca_run_events", "ca_tool_calls",
    "ca_checkpoints", "ca_artifacts", "ca_repository_index_files",
    "ca_repository_index_chunks", "ca_usage_records",
  ];
  for (const table of tables) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
  }
  assert.match(sql, /revoke all on public\.ca_tool_calls[\s\S]*from anon, authenticated/i);
  assert.match(sql, /grant all privileges on public\.ca_repositories[\s\S]*to service_role/i);
  assert.match(sql, /grant usage, select on sequence public\.ca_run_events_id_seq to service_role/i);
  assert.match(sql, /using \(\(select auth\.uid\(\)\) = owner\)/i);
  assert.match(sql, /for update skip locked/i);
  assert.match(sql, /grant execute on function public\.claim_code_agent_runs\(integer\) to service_role/i);
});

test("GitHub installation migration exposes metadata but stores no token", async () => {
  const sql = await readFile(githubMigrationPath, "utf8");
  assert.match(sql, /create table if not exists public\.ca_github_installations/i);
  assert.match(sql, /alter table public\.ca_github_installations enable row level security/i);
  assert.match(sql, /using \(\(select auth\.uid\(\)\) = owner\)/i);
  assert.match(sql, /grant all privileges on public\.ca_github_installations to service_role/i);
  assert.doesNotMatch(sql, /\b(access_token|private_key|state_secret)\b/i);
});

test("schema hardening documents server-only RLS and covers foreign keys", async () => {
  const sql = await readFile(hardeningMigrationPath, "utf8");
  for (const table of [
    "ca_tool_calls", "ca_repository_index_files", "ca_repository_index_chunks",
  ]) {
    assert.match(sql, new RegExp(`on public\\.${table}[\\s\\S]*?as restrictive[\\s\\S]*?using \\(false\\)`, "i"));
  }
  for (const index of [
    "ca_agents_repository_id_idx", "ca_artifacts_owner_idx", "ca_checkpoints_owner_idx",
    "ca_repositories_installation_id_idx", "ca_repository_index_chunks_owner_idx",
    "ca_repository_index_files_owner_idx", "ca_run_events_owner_idx", "ca_runs_agent_id_idx",
    "ca_runs_repository_id_idx", "ca_tool_calls_owner_idx", "ca_usage_records_run_id_idx",
  ]) {
    assert.match(sql, new RegExp(`create index if not exists ${index}`, "i"));
  }
});

test("anonymous role has no Code Agent table privileges", async () => {
  const sql = await readFile(anonLockdownMigrationPath, "utf8");
  for (const table of [
    "ca_repositories", "ca_agents", "ca_runs", "ca_run_events", "ca_tool_calls",
    "ca_checkpoints", "ca_artifacts", "ca_repository_index_files",
    "ca_repository_index_chunks", "ca_usage_records", "ca_github_installations",
  ]) {
    assert.match(sql, new RegExp(`public\\.${table}`, "i"));
  }
  assert.match(sql, /revoke all privileges on table[\s\S]*from anon/i);
});

test("GitHub webhook ledger is private, idempotent, and safely claimable", async () => {
  const sql = await readFile(webhookMigrationPath, "utf8");
  assert.match(sql, /create table public\.ca_github_webhook_deliveries/i);
  assert.match(sql, /delivery_id text primary key/i);
  assert.match(sql, /payload_sha256[\s\S]*\^\[0-9a-f\]\{64\}\$/i);
  assert.match(sql, /status in \('received', 'processing', 'processed', 'ignored', 'failed'\)/i);
  assert.match(sql, /alter table public\.ca_github_webhook_deliveries enable row level security/i);
  assert.match(sql, /revoke all on table public\.ca_github_webhook_deliveries from public, anon, authenticated/i);
  assert.match(sql, /grant all privileges on table public\.ca_github_webhook_deliveries to service_role/i);
  assert.match(sql, /as restrictive[\s\S]*to anon, authenticated[\s\S]*using \(false\)/i);
  assert.match(sql, /ca_github_webhook_deliveries_pending_idx/i);
  assert.match(sql, /ca_github_webhook_deliveries_installation_idx/i);
  assert.match(sql, /ca_github_webhook_deliveries_owner_idx/i);
  assert.match(sql, /create or replace function public\.claim_github_webhook_deliveries/i);
  assert.match(sql, /security invoker/i);
  assert.match(sql, /for update skip locked/i);
  assert.match(sql, /status = 'processing'[\s\S]*interval '10 minutes'/i);
  assert.match(sql, /revoke all on function public\.claim_github_webhook_deliveries\(integer\)[\s\S]*from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.claim_github_webhook_deliveries\(integer\)[\s\S]*to service_role/i);
});

test("owner-readable control-plane policies explicitly require authentication", async () => {
  const sql = await readFile(policyRolesMigrationPath, "utf8");
  for (const policy of [
    "ca_repositories_owner_read", "ca_agents_owner_read", "ca_runs_owner_read",
    "ca_run_events_owner_read", "ca_checkpoints_owner_read", "ca_artifacts_owner_read",
    "ca_usage_owner_read", "ca_github_installations_owner_read",
  ]) {
    assert.match(sql, new RegExp(`alter policy "${policy}"[\\s\\S]*?to authenticated`, "i"));
  }
});

test("AI credentials are encrypted before storage and inaccessible to browser roles", async () => {
  const sql = await readFile(aiConnectionsMigrationPath, "utf8");
  assert.match(sql, /create table public\.ca_ai_credentials/i);
  assert.match(sql, /secret_encrypted text not null/i);
  assert.doesNotMatch(sql, /\b(access_token|refresh_token|api_key)\s+text\b/i);
  assert.match(sql, /alter table public\.ca_ai_credentials enable row level security/i);
  assert.match(sql, /alter table public\.ca_ai_preferences enable row level security/i);
  assert.match(sql, /revoke all on table public\.ca_ai_credentials, public\.ca_ai_preferences[\s\S]*from public, anon, authenticated/i);
  assert.match(sql, /grant all privileges on table public\.ca_ai_credentials, public\.ca_ai_preferences[\s\S]*to service_role/i);
  assert.match(sql, /as restrictive[\s\S]*to anon, authenticated[\s\S]*using \(false\)/i);
  assert.match(sql, /references auth\.users\(id\) on delete cascade/i);
});

test("owner metadata policies reject anonymous Supabase identities", async () => {
  const sql = await readFile(rejectAnonymousMigrationPath, "utf8");
  for (const policy of [
    "ca_repositories_owner_read", "ca_agents_owner_read", "ca_runs_owner_read",
    "ca_run_events_owner_read", "ca_checkpoints_owner_read", "ca_artifacts_owner_read",
    "ca_usage_owner_read", "ca_github_installations_owner_read",
  ]) {
    assert.match(sql, new RegExp(`alter policy "${policy}"`, "i"));
  }
  assert.equal((sql.match(/auth\.jwt\(\)->>'is_anonymous'/g) || []).length, 8);
  assert.equal((sql.match(/= 'false'/g) || []).length, 8);
});

test("repository hybrid index encrypts source and exposes search to service role only", async () => {
  const sql = await readFile(repositoryIndexMigrationPath, "utf8");
  assert.match(sql, /create table public\.ca_repository_indexes/i);
  assert.match(sql, /content_ciphertext text/i);
  assert.match(sql, /path_hash text/i);
  assert.match(sql, /token_hashes text\[\]/i);
  assert.doesNotMatch(sql, /\bcontent\s+text\b/i);
  assert.match(sql, /using gin\(token_hashes\)/i);
  assert.match(sql, /using hnsw \(embedding extensions\.vector_cosine_ops\)/i);
  assert.match(sql, /alter table public\.ca_repository_indexes enable row level security/i);
  assert.match(sql, /revoke all on table public\.ca_repository_indexes from public, anon, authenticated/i);
  assert.match(sql, /as restrictive[\s\S]*to anon, authenticated[\s\S]*using \(false\)/i);
  assert.match(sql, /create or replace function public\.search_repository_index/i);
  assert.match(sql, /security invoker/i);
  assert.match(sql, /revoke all on function public\.search_repository_index[\s\S]*from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.search_repository_index[\s\S]*to service_role/i);
});

test("repository intelligence graph is private, indexed, and durably claimable", async () => {
  const sql = await readFile(repositoryIntelligenceMigrationPath, "utf8");
  assert.match(sql, /create table public\.ca_repository_symbols/i);
  assert.match(sql, /create table public\.ca_repository_relations/i);
  assert.match(sql, /name_ciphertext text not null/i);
  assert.match(sql, /name_hash text not null/i);
  assert.doesNotMatch(sql, /\bname text\b/i);
  assert.match(sql, /ca_repository_symbols_repo_name_idx/i);
  assert.match(sql, /ca_repository_relations_source_file_kind_idx/i);
  assert.match(sql, /ca_repository_relations_target_file_kind_idx/i);
  assert.match(sql, /alter table public\.ca_repository_symbols enable row level security/i);
  assert.match(sql, /alter table public\.ca_repository_relations enable row level security/i);
  assert.match(sql, /revoke all on table public\.ca_repository_symbols, public\.ca_repository_relations[\s\S]*from public, anon, authenticated/i);
  assert.match(sql, /create or replace function public\.claim_repository_index_refreshes/i);
  assert.match(sql, /security invoker/i);
  assert.match(sql, /for update skip locked/i);
  assert.match(sql, /grant execute on function public\.claim_repository_index_refreshes\(integer\)[\s\S]*to service_role/i);
});

test("model routing telemetry and encrypted evaluations are server-only", async () => {
  const sql = await readFile(modelRoutingMigrationPath, "utf8");
  for (const table of [
    "ca_model_attempts", "ca_model_evaluations", "ca_model_evaluation_results",
  ]) {
    assert.match(sql, new RegExp(`create table public\\.${table}`, "i"));
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
  }
  assert.match(sql, /prompt_encrypted text not null/i);
  assert.match(sql, /output_encrypted text/i);
  assert.doesNotMatch(sql, /\bprompt text\b/i);
  assert.doesNotMatch(sql, /\boutput text\b/i);
  assert.match(sql, /revoke all on table[\s\S]*from public, anon, authenticated/i);
  assert.match(sql, /grant all privileges on table[\s\S]*to service_role/i);
  assert.equal((sql.match(/as restrictive for all to anon, authenticated/g) || []).length, 3);
  assert.match(sql, /ca_model_attempts_run_id_idx[\s\S]*where run_id is not null/i);
});

test("subscription and budget tables stay server-only with metered billing source", async () => {
  const sql = await readFile(subscriptionsMigrationPath, "utf8");
  assert.match(sql, /create table public\.ca_subscriptions/i);
  assert.match(sql, /plan text not null default 'free' check \(plan in \('free', 'starter', 'pro'\)\)/i);
  assert.match(sql, /alter table public\.ca_subscriptions enable row level security/i);
  assert.match(sql, /revoke all on table public\.ca_subscriptions from public, anon, authenticated/i);
  assert.match(sql, /grant all privileges on table public\.ca_subscriptions to service_role/i);
  assert.match(sql, /as restrictive for all to anon, authenticated/i);
  assert.match(sql, /ca_subscriptions_stripe_customer_idx[\s\S]*where stripe_customer_id is not null/i);
  assert.match(sql, /alter table public\.ca_usage_records[\s\S]*add column billing_source/i);
  assert.match(sql, /billing_source in \('managed', 'byok', 'codex', 'unknown'\)/i);
  assert.match(sql, /ca_runs_state_created_idx/i);
});

test("phase 8 migration adds policies, resume lineage, and a private artifact bucket", async () => {
  const sql = await readFile(phase8MigrationPath, "utf8");
  assert.match(sql, /publish_mode text not null default 'require_approval'/i);
  assert.match(sql, /publish_mode in \('require_approval', 'auto_publish'\)/i);
  assert.match(sql, /protected_paths jsonb not null default '\[\]'::jsonb/i);
  assert.match(sql, /resumed_from_run_id uuid references public\.ca_runs\(id\) on delete set null/i);
  assert.match(sql, /sandbox_state in \('preserved', 'discarded'\)/i);
  assert.match(sql, /ca_runs_resumed_from_idx[\s\S]*where resumed_from_run_id is not null/i);
  assert.match(sql, /insert into storage\.buckets \(id, name, public\)[\s\S]*'thrallo-artifacts', false/i);
  assert.match(sql, /on conflict \(id\) do nothing/i);
});

test("phase 9 migration adds egress/command policies and retention tracking", async () => {
  const sql = await readFile(phase9MigrationPath, "utf8");
  assert.match(sql, /network_policy text not null default 'full'/i);
  assert.match(sql, /network_policy in \('full', 'offline'\)/i);
  assert.match(sql, /command_policy text not null default 'standard'/i);
  assert.match(sql, /command_policy in \('standard', 'restricted'\)/i);
  assert.match(sql, /add column pruned_at timestamptz/i);
  assert.match(sql, /ca_runs_retention_idx[\s\S]*where pruned_at is null and finished_at is not null/i);
});

test("review-run migration adds a validated pull-request column", async () => {
  const sql = await readFile(
    new URL("../../supabase/migrations/20260731003000_review_runs.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /alter table public\.ca_runs[\s\S]*add column pull_request bigint/i);
  assert.match(sql, /pull_request is null or pull_request > 0/i);
});

test("automations migration is server-only with provenance and due-scan indexes", async () => {
  const sql = await readFile(
    new URL("../../supabase/migrations/20260731020000_automations.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /create table public\.ca_automations/i);
  assert.match(sql, /kind in \('pr_review', 'scheduled_task'\)/i);
  assert.match(sql, /interval_hours between 1 and 168/i);
  assert.match(sql, /kind <> 'scheduled_task' or interval_hours is not null/i);
  assert.match(sql, /ca_automations_due_idx[\s\S]*where enabled and kind = 'scheduled_task'/i);
  assert.match(sql, /alter table public\.ca_runs[\s\S]*add column automation_id uuid references public\.ca_automations/i);
  assert.match(sql, /alter table public\.ca_automations enable row level security/i);
  assert.match(sql, /revoke all on table public\.ca_automations from public, anon, authenticated/i);
  assert.match(sql, /as restrictive for all to anon, authenticated/i);
});

test("api-token migration stores only hashes and stays server-only", async () => {
  const sql = await readFile(apiTokensMigrationPath, "utf8");
  assert.match(sql, /create table public\.ca_api_tokens/i);
  assert.match(sql, /token_hash text not null unique check \(char_length\(token_hash\) = 64\)/i);
  assert.doesNotMatch(sql, /\btoken text\b/i);
  assert.match(sql, /alter table public\.ca_api_tokens enable row level security/i);
  assert.match(sql, /revoke all on table public\.ca_api_tokens from public, anon, authenticated/i);
  assert.match(sql, /grant all privileges on table public\.ca_api_tokens to service_role/i);
  assert.match(sql, /as restrictive for all to anon, authenticated/i);
});
