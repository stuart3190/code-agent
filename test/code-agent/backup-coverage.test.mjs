import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CA_TABLES } from "../../ops/backup-thrallo.mjs";
import { RESTORE_ORDER } from "../../ops/restore-thrallo.mjs";
import { validateBackupDirectory } from "../../scripts/lib/backupValidation.mjs";

const migrationsDir = new URL("../../supabase/migrations/", import.meta.url);

// Tables a migration creates that are deliberately NOT in disaster recovery. Every entry needs
// a reason: the point of this list is that skipping a table becomes a decision someone wrote
// down, not an accident of a regex that never matched it.
//
// All of these belong to Buildr101-era migration files that were carried over at fork time and
// **never applied to Thrallo's Supabase** — verified 2026-08-01 against information_schema: all
// 28 are absent from production. Backing up a table that does not exist would fail the nightly
// job, so they are excluded until (and unless) their feature is deliberately revived.
//
// IMPORTANT: if one of these is ever applied to production, it must MOVE to CA_TABLES. CI cannot
// see the live database, so the scheduled migration-drift ops check owns that half: it compares
// this list against the tables that actually exist and fails when one appears in production while
// still excluded here.
const UNAPPLIED_LEGACY = "defined by an unapplied Buildr101-era migration; absent from Thrallo production (verified 2026-08-01)";
const INTENTIONALLY_NOT_BACKED_UP = new Map([
  "feature_flags", "project_secrets", "project_integrations", "project_environments",
  "project_releases", "background_tasks", "audit_events", "payment_products",
  "payment_orders", "brand_kits", "project_brand_settings",
  "app_analytics_events", "project_templates", "connector_oauth_states", "connector_workflows",
  "project_actions", "app_jobs", "runtime_usage", "app_usage_ledger", "action_schedules",
  "provider_webhook_events", "knowledge_bases", "knowledge_documents", "knowledge_chunks",
  "app_user_integrations", "app_connector_oauth_states",
].map((table) => [table, UNAPPLIED_LEGACY]));

// EVERY table any migration creates. This deliberately does NOT filter by name: the previous
// version matched a hardcoded allowlist (`ca_\w+|projects|build_jobs|…`), so seven tables added
// later — diag_runs, diag_steps, diag_incidents, diag_prefs, ai_requests, build_signals,
// build_checkpoints — were invisible to the guard and silently absent from every snapshot.
async function tablesFromMigrations() {
  const tables = new Set();
  for (const name of await readdir(migrationsDir)) {
    if (!name.endsWith(".sql")) continue;
    const sql = await readFile(new URL(name, migrationsDir), "utf8");
    const code = sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const match of code.matchAll(/create table (?:if not exists )?public\.(\w+)/gi)) {
      tables.add(match[1]);
    }
  }
  return tables;
}

test("the backup covers every table any migration creates", async () => {
  const migrated = await tablesFromMigrations();
  const backedUp = new Set(CA_TABLES);
  const missing = [...migrated]
    .filter((table) => !backedUp.has(table) && !INTENTIONALLY_NOT_BACKED_UP.has(table));
  const extra = [...backedUp].filter((table) => !migrated.has(table));
  assert.deepEqual(missing, [],
    `add these tables to CA_TABLES in ops/backup-thrallo.mjs, or justify them in INTENTIONALLY_NOT_BACKED_UP: ${missing.join(", ")}`);
  assert.deepEqual(extra, [], `CA_TABLES lists tables no migration creates: ${extra.join(", ")}`);
});

test("every deliberate backup exclusion carries a written reason", () => {
  for (const [table, reason] of INTENTIONALLY_NOT_BACKED_UP) {
    assert.ok(reason && reason.length > 20, `${table}: exclusions need a real justification`);
  }
});

test("the restore order covers exactly the backed-up tables", () => {
  assert.deepEqual([...RESTORE_ORDER].sort(), [...CA_TABLES].sort());
  assert.ok(RESTORE_ORDER.indexOf("ca_repositories") < RESTORE_ORDER.indexOf("ca_agents"));
  assert.ok(RESTORE_ORDER.indexOf("ca_agents") < RESTORE_ORDER.indexOf("ca_runs"));
  assert.ok(RESTORE_ORDER.indexOf("ca_automations") < RESTORE_ORDER.indexOf("ca_runs"));
  assert.ok(RESTORE_ORDER.indexOf("ca_runs") < RESTORE_ORDER.indexOf("ca_run_events"));
  assert.ok(RESTORE_ORDER.indexOf("ca_runs") < RESTORE_ORDER.indexOf("ca_artifacts"));
});

test("a backup directory round-trips through validation and rejects tampering", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "thrallo-backup-test-"));
  await mkdir(path.join(dir, "storage"), { recursive: true });
  const rows = [{ id: "1", value: "a" }, { id: "2", value: "b" }];
  const gz = gzipSync(JSON.stringify(rows));
  await writeFile(path.join(dir, "ca_runs.json.gz"), gz);
  const manifest = {
    product: "thrallo",
    tables: { ca_runs: 2 },
    files: { "ca_runs.json.gz": { bytes: gz.length, sha256: createHash("sha256").update(gz).digest("hex") } },
  };
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest));

  const result = await validateBackupDirectory(dir);
  assert.equal(result.ok, true);
  assert.equal(result.tables.ca_runs, 2);

  await writeFile(path.join(dir, "ca_runs.json.gz"), gzipSync(JSON.stringify([{ id: "1" }])));
  await assert.rejects(validateBackupDirectory(dir), /manifest says 2/);
});

test("systemd units and the runbook ship with the repository", async () => {
  const service = await readFile(new URL("../../ops/thrallo-backup.service", import.meta.url), "utf8");
  assert.match(service, /ExecStart=\/usr\/bin\/node ops\/backup-thrallo\.mjs/);
  assert.match(service, /WorkingDirectory=\/home\/ubuntu\/code-agent/);
  const timer = await readFile(new URL("../../ops/thrallo-backup.timer", import.meta.url), "utf8");
  assert.match(timer, /OnCalendar=/);
  assert.match(timer, /Persistent=true/);
  const runbook = await readFile(new URL("../../docs/DISASTER-RECOVERY.md", import.meta.url), "utf8");
  assert.match(runbook, /PLATFORM_ENC_KEY/);
  assert.match(runbook, /restore-thrallo\.mjs/);
});
