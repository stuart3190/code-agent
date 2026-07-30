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
