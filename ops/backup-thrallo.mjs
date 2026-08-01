// Nightly Thrallo control-plane backup (the Supabase free tier keeps no backups of its own).
// Exports every ca_* table, auth users, and the private artifact bucket as a validated,
// checksummed run directory, then prunes old runs. Runs on the VPS from
// /home/ubuntu/code-agent under the thrallo-backup.timer systemd unit; credentials come from
// shell/.env exactly like the server.
//
//   node ops/backup-thrallo.mjs                          -> ~/thrallo-backups/thrallo-<stamp>/
//   THRALLO_BACKUP_DIR=/path THRALLO_BACKUP_KEEP_DAYS=14    env overrides
//
// Restore with ops/restore-thrallo.mjs (see docs/DISASTER-RECOVERY.md). This protects against
// data loss, not point-in-time recovery. The backup is USELESS without PLATFORM_ENC_KEY from
// shell/.env — every credential, source excerpt, and evaluation is encrypted with it — so an
// offline copy of shell/.env is part of the disaster-recovery kit.

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { loadEnv } from "../shell/server/lib/env.mjs";
import { validateBackupDirectory } from "../scripts/lib/backupValidation.mjs";

// Every control-plane table in supabase/migrations (ca_* plus the Phase-19 app-build tables) —
// test/code-agent/backup-coverage.test.mjs fails the build if a new migration adds a table
// that is missing here.
export const CA_TABLES = [
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
  "projects",
  "build_jobs",
  "published_sites",
  "custom_domains",
  "ca_push_subscriptions",
  "entities",
  "app_users",
  "app_auth_events",
  "app_password_resets",
  // Diagnostics, checkpoints and cost telemetry. Added 2026-08-01: these were missing because
  // the coverage guard only ever checked `ca_`-prefixed tables, so seven non-`ca_` tables —
  // including the permanent build audit trail and the usage data behind billing summaries and
  // BYOK daily spend — were silently absent from every snapshot.
  "diag_runs",
  "diag_steps",
  "diag_incidents",
  "diag_prefs",
  "ai_requests",
  "build_signals",
  "build_checkpoints",
  "qa_runs",
  "app_notifications",
];

export const ARTIFACT_BUCKET = process.env.CODE_AGENT_ARTIFACT_BUCKET || "thrallo-artifacts";
const PAGE = 1000;

async function dumpTable(svc, table) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await svc.from(table).select("*").range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

async function dumpAuthUsers(svc) {
  const users = [];
  for (let page = 1; ; page += 1) {
    const { data, error } = await svc.auth.admin.listUsers({ page, perPage: PAGE });
    if (error) throw new Error(`auth users: ${error.message}`);
    users.push(...(data?.users || []).map((user) => ({
      id: user.id,
      email: user.email,
      created_at: user.created_at,
      email_confirmed_at: user.email_confirmed_at,
      last_sign_in_at: user.last_sign_in_at,
      user_metadata: user.user_metadata,
      app_metadata: user.app_metadata,
    })));
    if (!data?.users || data.users.length < PAGE) break;
  }
  return users;
}

export async function listBucketObjects(svc, bucket, prefix = "") {
  const keys = [];
  for (let offset = 0; ; offset += 100) {
    const { data, error } = await svc.storage.from(bucket)
      .list(prefix, { limit: 100, offset, sortBy: { column: "name", order: "asc" } });
    if (error) throw new Error(`storage list ${prefix || "/"}: ${error.message}`);
    for (const entry of data || []) {
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id === null && !entry.metadata) {
        keys.push(...await listBucketObjects(svc, bucket, key));
      } else {
        keys.push(key);
      }
    }
    if (!data || data.length < 100) break;
  }
  return keys;
}

async function main() {
  loadEnv();
  const URL_ = process.env.SUPABASE_URL;
  const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
  if (!URL_ || !SVC) {
    console.error("backup: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing (shell/.env)");
    process.exit(1);
  }
  const svc = createClient(URL_, SVC, { auth: { persistSession: false, autoRefreshToken: false } });
  const backupRoot = process.env.THRALLO_BACKUP_DIR || path.join(os.homedir(), "thrallo-backups");
  const keepDays = Number(process.env.THRALLO_BACKUP_KEEP_DAYS || 14);

  const stamp = new Date().toISOString().replace(/:/g, "").slice(0, 17);
  const dir = path.join(backupRoot, `thrallo-${stamp}`);
  await mkdir(path.join(dir, "storage"), { recursive: true });

  const manifest = {
    product: "thrallo",
    url: new globalThis.URL(URL_).host,
    startedAt: new Date().toISOString(),
    tables: {},
    files: {},
    storage: { bucket: ARTIFACT_BUCKET, objects: 0 },
    bytes: 0,
  };

  for (const table of CA_TABLES) {
    const rows = await dumpTable(svc, table);
    const gz = gzipSync(JSON.stringify(rows));
    await writeFile(path.join(dir, `${table}.json.gz`), gz);
    manifest.tables[table] = rows.length;
    manifest.files[`${table}.json.gz`] = { bytes: gz.length, sha256: sha256(gz) };
    manifest.bytes += gz.length;
    console.log(`  ${table}: ${rows.length} rows (${gz.length} bytes gz)`);
  }

  const users = await dumpAuthUsers(svc);
  const usersGz = gzipSync(JSON.stringify(users));
  await writeFile(path.join(dir, "auth_users.json.gz"), usersGz);
  manifest.tables.auth_users = users.length;
  manifest.files["auth_users.json.gz"] = { bytes: usersGz.length, sha256: sha256(usersGz) };
  manifest.bytes += usersGz.length;
  console.log(`  auth_users: ${users.length} rows`);

  const keys = await listBucketObjects(svc, ARTIFACT_BUCKET);
  const objectIndex = [];
  for (const key of keys) {
    const { data, error } = await svc.storage.from(ARTIFACT_BUCKET).download(key);
    if (error) throw new Error(`storage download ${key}: ${error.message}`);
    const bytes = Buffer.from(await data.arrayBuffer());
    const gz = gzipSync(bytes);
    const file = `storage/${sha256(Buffer.from(key))}.bin.gz`;
    await writeFile(path.join(dir, file), gz);
    objectIndex.push({ key, file, bytes: bytes.length, sha256: sha256(bytes) });
    manifest.bytes += gz.length;
  }
  const indexGz = gzipSync(JSON.stringify(objectIndex));
  await writeFile(path.join(dir, "storage_objects.json.gz"), indexGz);
  manifest.tables.storage_objects = objectIndex.length;
  manifest.files["storage_objects.json.gz"] = { bytes: indexGz.length, sha256: sha256(indexGz) };
  manifest.storage.objects = objectIndex.length;
  console.log(`  storage: ${objectIndex.length} objects from ${ARTIFACT_BUCKET}`);

  manifest.finishedAt = new Date().toISOString();
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));

  const validation = await validateBackupDirectory(dir);
  console.log(`  validation: ${validation.files} files decoded, counted and checksummed`);

  let removed = 0;
  const cutoff = Date.now() - keepDays * 86_400_000;
  for (const name of await readdir(backupRoot).catch(() => [])) {
    const match = /^thrallo-(\d{4}-\d{2}-\d{2})T/.exec(name);
    if (match && new Date(match[1]).getTime() < cutoff) {
      await rm(path.join(backupRoot, name), { recursive: true, force: true });
      removed += 1;
    }
  }
  console.log(`backup OK -> ${dir} (${manifest.bytes} bytes gz total, pruned ${removed} old runs)`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((error) => { console.error("backup FAILED:", error.message); process.exit(1); });
}
