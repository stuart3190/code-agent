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

import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { ARTIFACT_BUCKET } from "./backup-thrallo.mjs";
import { validateBackupDirectory } from "../scripts/lib/backupValidation.mjs";

// Foreign-key-safe insert order. ca_automations and ca_runs reference each other, so
// automations insert first with last_run_id withheld and patched after runs exist.
export const RESTORE_ORDER = [
  "ca_repositories",
  "ca_github_installations",
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
  "ca_products",
  "ca_conversations",
  "ca_conversation_turns",
  "ca_conversation_events",
  "ca_owner_profile",
  "ca_memories",
  "projects",     // references ca_products -> restore after it
  "build_jobs",
  "published_sites",
  "custom_domains",
  "ca_push_subscriptions",
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
  for (const table of RESTORE_ORDER) {
    let rows = await loadRows(dir, table);
    if (table === "ca_automations") {
      for (const row of rows) {
        if (row.last_run_id) automationPatches.push({ id: row.id, last_run_id: row.last_run_id });
      }
      rows = rows.map((row) => ({ ...row, last_run_id: null }));
    }
    await insertRows(svc, table, rows);
    console.log(`  ${table}: ${rows.length} restored`);
  }
  for (const patch of automationPatches) {
    const { error } = await svc.from("ca_automations")
      .update({ last_run_id: patch.last_run_id }).eq("id", patch.id);
    if (error) throw new Error(`ca_automations patch ${patch.id}: ${error.message}`);
  }
  if (automationPatches.length) console.log(`  ca_automations: ${automationPatches.length} last_run_id links patched`);

  const objects = await loadRows(dir, "storage_objects");
  for (const object of objects) {
    const gz = await readFile(path.join(dir, object.file));
    const bytes = gunzipSync(gz);
    const { error } = await svc.storage.from(ARTIFACT_BUCKET)
      .upload(object.key, bytes, { upsert: true, contentType: "application/octet-stream" });
    if (error) throw new Error(`storage ${object.key}: ${error.message}`);
  }
  console.log(`storage: ${objects.length} objects restored to ${ARTIFACT_BUCKET}`);
  console.log("restore complete — run the verification steps in docs/DISASTER-RECOVERY.md");
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((error) => { console.error("restore FAILED:", error.message); process.exit(1); });
}
