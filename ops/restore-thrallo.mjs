// Thrallo control-plane restore. Re-inserts a backup run produced by ops/backup-thrallo.mjs
// into a target Supabase project. Dry-run by default; writing requires BOTH explicit target
// env vars AND --confirm so a production key lying around in shell/.env can never be clobbered
// by accident.
//
//   node ops/restore-thrallo.mjs <backup-dir>                       # dry run: counts only
//   RESTORE_TARGET_URL=... RESTORE_TARGET_SERVICE_KEY=... \
//   node ops/restore-thrallo.mjs <backup-dir> --confirm             # write to target
//
// The target must already have every migration applied (supabase/migrations in order), which
// also creates the artifact bucket. Auth users are recreated with their original UUIDs via the
// admin API; passwords cannot be restored — users reset them. Restored encrypted columns are
// only readable when the server runs with the ORIGINAL PLATFORM_ENC_KEY.

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { ARTIFACT_BUCKET } from "./backup-thrallo.mjs";
import { validateBackupDirectory } from "../scripts/lib/backupValidation.mjs";

// Foreign-key-safe insert order. ca_automations and ca_runs reference each other, so
// automations insert first with last_run_id withheld and patched after runs exist.
export const RESTORE_ORDER = [
  "ca_github_installations",
  "ca_repositories",
  "ca_github_webhook_deliveries",
  "ca_agents",
  "ca_automations",
  "ca_runs",
  "ca_run_events",
  "ca_tool_calls",
  "ca_checkpoints",
  "ca_artifacts",
  "ca_usage_records",
  "ca_ai_credentials",
  "ca_ai_preferences",
  "ca_repository_indexes",
  "ca_repository_index_files",
  "ca_repository_index_chunks",
  "ca_repository_symbols",
  "ca_repository_relations",
  "ca_model_attempts",
  "ca_model_evaluations",
  "ca_model_evaluation_results",
  "ca_subscriptions",
  "ca_api_tokens",
  // The account's notification history. It is the only record that something was ever said —
  // losing it would mean a restored account could not see what it had been told.
  "ca_notifications",
  "ca_products",
  "ca_conversations",
  "ca_conversation_turns",
  "ca_conversation_events",
  "ca_owner_profile",
  "ca_memories",
  "projects",     // references ca_products -> restore after it
  "build_jobs",
  "build_work_payloads",
  "build_work_jobs",
  "build_work_results",
  "build_work_events",
  "build_worker_nodes",
  "published_sites",
  // After published_sites: a deployment references the project and product those rows describe.
  "deployments",
  "custom_domains",
  "ca_push_subscriptions",
  "entities",       // owner references auth.users -> after users are ensured
  "app_users",
  "app_auth_events",
  "app_password_resets",
  // Diagnostics + telemetry, restored last: diag_steps references diag_runs, and both
  // build_checkpoints and ai_requests carry project/build ids, so they follow projects
  // and build_jobs above.
  "diag_runs",
  "diag_steps",
  "diag_incidents",
  "diag_prefs",
  "ai_requests",
  "build_signals",
  "build_checkpoints",
  "qa_runs",   // references projects -> restore after it
  "app_notifications",   // owner references auth.users -> after app_users
  // Analytics, logs and health. All reference auth.users only, so ordering among them is free;
  // salts before events so a restored day's hashes stay explicable.
  "analytics_salts",
  "analytics_events",
  "analytics_daily",
  "project_logs",
  "health_checks",
  "health_status",
  // Builder v2 (FK-safe: snapshots before their files and pointers).
  "bv2_feature_flags",
  "bv2_migration_state",
  "bv2_project_knowledge",
  "bv2_file_revisions",
  "bv2_symbols",
  "bv2_symbol_refs",
  "bv2_dependency_edges",
  "bv2_shadow_runs",
  "bv2_shadow_run_files",
  "bv2_shadow_checks",
  "bv2_blobs",
  "bv2_snapshots",
  "bv2_snapshot_files",
  "bv2_project_pointers",
  "bv2_contracts",
  "bv2_builds",
  "bv2_assets",
  "bv2_retrieval_traces",
  "bv2_patches",
  "bv2_verification_cache",
];

const BATCH = 500;

async function loadRows(dir, name) {
  const bytes = await readFile(path.join(dir, `${name}.json.gz`));
  return JSON.parse(gunzipSync(bytes).toString("utf8"));
}

async function insertRows(svc, table, rows) {
  for (let from = 0; from < rows.length; from += BATCH) {
    const { error } = await svc.from(table).upsert(rows.slice(from, from + BATCH));
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

export function prepareRowsForRestore(table, rows) {
  if (table !== "ca_run_events" || rows.length === 0) return rows;
  const sorted = [...rows].sort((a, b) => Number(a.id) - Number(b.id));
  for (let index = 0; index < sorted.length; index += 1) {
    if (Number(sorted[index].id) !== index + 1) {
      throw new Error("ca_run_events identity has gaps; exact restore requires a database-native OVERRIDING SYSTEM VALUE path");
    }
  }
  return sorted.map(({ id: _generatedIdentity, ...row }) => row);
}

async function main() {
  const dir = path.resolve(process.argv[2] || "");
  if (!process.argv[2]) {
    console.error("Usage: node ops/restore-thrallo.mjs <backup-dir> [--confirm]");
    process.exit(1);
  }
  const confirm = process.argv.includes("--confirm");

  const validation = await validateBackupDirectory(dir);
  console.log(`backup validated: ${validation.files} files`);
  for (const [table, count] of Object.entries(validation.tables)) {
    console.log(`  ${table}: ${count} rows`);
  }
  const missing = RESTORE_ORDER.filter((table) => !(table in validation.tables));
  if (missing.length) throw new Error(`backup is missing tables: ${missing.join(", ")}`);

  if (!confirm) {
    console.log("\nDry run only. To write, set RESTORE_TARGET_URL and RESTORE_TARGET_SERVICE_KEY and pass --confirm.");
    return;
  }
  const url = process.env.RESTORE_TARGET_URL;
  const key = process.env.RESTORE_TARGET_SERVICE_KEY;
  if (!url || !key) {
    throw new Error("--confirm requires RESTORE_TARGET_URL and RESTORE_TARGET_SERVICE_KEY (never taken from shell/.env)");
  }
  const svc = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const users = await loadRows(dir, "auth_users");
  for (const user of users) {
    const { error } = await svc.auth.admin.createUser({
      id: user.id,
      email: user.email,
      email_confirm: !!user.email_confirmed_at,
      user_metadata: user.user_metadata || {},
      app_metadata: user.app_metadata || {},
    });
    if (error && !/already/i.test(error.message)) throw new Error(`auth user ${user.email}: ${error.message}`);
  }
  console.log(`auth users: ${users.length} ensured (passwords must be reset)`);

  const automationPatches = [];
  const snapshotPatches = [];
  for (const table of RESTORE_ORDER) {
    let rows = await loadRows(dir, table);
    if (table === "ca_automations") {
      for (const row of rows) {
        if (row.last_run_id) automationPatches.push({ id: row.id, last_run_id: row.last_run_id });
      }
      rows = rows.map((row) => ({ ...row, last_run_id: null }));
    }
    if (table === "bv2_snapshots") {
      for (const row of rows) {
        if (row.parent_snapshot) snapshotPatches.push({ id: row.id, parent_snapshot: row.parent_snapshot });
      }
      rows = rows.map((row) => ({ ...row, parent_snapshot: null }));
    }
    rows = prepareRowsForRestore(table, rows);
    await insertRows(svc, table, rows);
    console.log(`  ${table}: ${rows.length} restored`);
  }
  for (const patch of automationPatches) {
    const { error } = await svc.from("ca_automations")
      .update({ last_run_id: patch.last_run_id }).eq("id", patch.id);
    if (error) throw new Error(`ca_automations patch ${patch.id}: ${error.message}`);
  }
  if (automationPatches.length) console.log(`  ca_automations: ${automationPatches.length} last_run_id links patched`);
  for (const patch of snapshotPatches) {
    const { error } = await svc.from("bv2_snapshots")
      .update({ parent_snapshot: patch.parent_snapshot }).eq("id", patch.id);
    if (error) throw new Error(`bv2_snapshots patch ${patch.id}: ${error.message}`);
  }
  if (snapshotPatches.length) console.log(`  bv2_snapshots: ${snapshotPatches.length} parent links patched`);

  const objects = await loadRows(dir, "storage_objects");
  for (const object of objects) {
    const gz = await readFile(path.join(dir, object.file));
    const bytes = gunzipSync(gz);
    const { error } = await svc.storage.from(ARTIFACT_BUCKET)
      .upload(object.key, bytes, { upsert: true, contentType: object.contentType || "application/octet-stream" });
    if (error) throw new Error(`storage ${object.key}: ${error.message}`);
  }
  console.log(`storage: ${objects.length} objects restored to ${ARTIFACT_BUCKET}`);
  const filesystemObjects = await loadRows(dir, "filesystem_objects");
  const filesystemRoot = process.env.RESTORE_TARGET_FILESYSTEM_ROOT;
  if (filesystemObjects.length && !filesystemRoot) {
    throw new Error("filesystem restore requires RESTORE_TARGET_FILESYSTEM_ROOT (an isolated empty namespace)");
  }
  for (const object of filesystemObjects) {
    const targetRoot = path.resolve(filesystemRoot, object.root);
    const target = path.resolve(targetRoot, object.relativePath);
    if (target !== targetRoot && !target.startsWith(`${targetRoot}${path.sep}`)) {
      throw new Error(`filesystem restore path escapes target root: ${object.relativePath}`);
    }
    const bytes = gunzipSync(await readFile(path.join(dir, object.file)));
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== object.bytes || digest !== object.sha256) throw new Error(`filesystem object corrupt: ${object.root}/${object.relativePath}`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: "wx" });
    if (Number.isInteger(object.mode)) await chmod(target, object.mode);
  }
  console.log(`filesystem: ${filesystemObjects.length} files restored under ${filesystemRoot}`);
  console.log("restore complete — run the verification steps in docs/DISASTER-RECOVERY.md");
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((error) => { console.error("restore FAILED:", error.message); process.exit(1); });
}
