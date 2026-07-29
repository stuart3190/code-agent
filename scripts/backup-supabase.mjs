// Nightly Supabase backup (launch audit: the free tier keeps NO backups of its own).
// Exports every platform table + auth users as gzipped JSON via the service-role key and prunes
// old runs. Runs on the VPS from ~/app-builder under a systemd timer (buildr-backup.timer);
// creds come from shell/.env exactly like the server.
//
//   node scripts/backup-supabase.mjs            -> ~/backups/supabase-<UTC timestamp>/
//   BACKUP_DIR=/path BACKUP_KEEP_DAYS=14        env overrides
//
// RESTORE is manual and surgical by design: each file is an array of rows — re-insert with the
// service role (upsert on id) into a fresh or existing project; auth users are recreated via
// auth.admin.createUser (passwords can't be exported — users reset them). This protects against
// data loss, not point-in-time recovery; for that, move Supabase to Pro.

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { loadEnv } from "../shell/server/lib/env.mjs";
import { validateBackupDirectory } from "./lib/backupValidation.mjs";

loadEnv();
const URL = process.env.SUPABASE_URL;
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
if (!URL || !SVC) { console.error("backup: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing (shell/.env)"); process.exit(1); }

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(os.homedir(), "backups");
const KEEP_DAYS = Number(process.env.BACKUP_KEEP_DAYS || 14);
const TABLES = [
  "projects", "entities", "credit_ledger", "customers", "byok_keys", "app_users",
  "published_sites", "custom_domains", "app_password_resets", "app_auth_events",
  "android_keystores", "email_log", "build_jobs",
  "feature_flags", "project_secrets", "project_integrations", "project_environments",
  "project_releases", "background_tasks", "audit_events",
  "connector_oauth_states", "connector_workflows",
  "app_user_integrations", "app_connector_oauth_states",
  "qa_runs",
  "payment_products", "payment_orders",
  "brand_kits", "project_brand_settings",
  "app_notifications",
  "app_analytics_events",
  "project_templates",
];
const PAGE = 1000;

const svc = createClient(URL, SVC, { auth: { persistSession: false, autoRefreshToken: false } });

async function dumpTable(table) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await svc.from(table).select("*").range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

async function dumpAuthUsers() {
  const users = [];
  for (let page = 1; ; page++) {
    const { data, error } = await svc.auth.admin.listUsers({ page, perPage: PAGE });
    if (error) throw new Error(`auth users: ${error.message}`);
    users.push(...(data?.users || []).map((u) => ({
      id: u.id, email: u.email, created_at: u.created_at, email_confirmed_at: u.email_confirmed_at,
      last_sign_in_at: u.last_sign_in_at, user_metadata: u.user_metadata, app_metadata: u.app_metadata,
    })));
    if (!data?.users || data.users.length < PAGE) break;
  }
  return users;
}

async function prune() {
  const cutoff = Date.now() - KEEP_DAYS * 86400_000;
  let removed = 0;
  for (const name of await readdir(BACKUP_DIR).catch(() => [])) {
    const m = /^supabase-(\d{4}-\d{2}-\d{2})T/.exec(name);
    if (!m) continue;
    if (new Date(m[1]).getTime() < cutoff) {
      await rm(path.join(BACKUP_DIR, name), { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}

async function main() {
  const stamp = new Date().toISOString().replace(/:/g, "").slice(0, 17); // supabase-YYYY-MM-DDTHHMMSS
  const dir = path.join(BACKUP_DIR, `supabase-${stamp}`);
  await mkdir(dir, { recursive: true });

  const manifest = { url: new globalThis.URL(URL).host, startedAt: new Date().toISOString(), tables: {}, files: {}, bytes: 0 };
  for (const t of TABLES) {
    const rows = await dumpTable(t);
    const gz = gzipSync(JSON.stringify(rows));
    await writeFile(path.join(dir, `${t}.json.gz`), gz);
    manifest.tables[t] = rows.length;
    manifest.files[`${t}.json.gz`] = { bytes: gz.length, sha256: createHash("sha256").update(gz).digest("hex") };
    manifest.bytes += gz.length;
    console.log(`  ${t}: ${rows.length} rows (${gz.length} bytes gz)`);
  }
  const users = await dumpAuthUsers();
  const ugz = gzipSync(JSON.stringify(users));
  await writeFile(path.join(dir, "auth_users.json.gz"), ugz);
  manifest.tables.auth_users = users.length;
  manifest.files["auth_users.json.gz"] = { bytes: ugz.length, sha256: createHash("sha256").update(ugz).digest("hex") };
  manifest.bytes += ugz.length;
  console.log(`  auth_users: ${users.length} rows (${ugz.length} bytes gz)`);

  manifest.finishedAt = new Date().toISOString();
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));

  const validation = await validateBackupDirectory(dir);
  console.log(`  validation: ${validation.files} files decoded, counted and checksummed`);

  const removed = await prune();
  console.log(`backup OK -> ${dir} (${manifest.bytes} bytes gz total, pruned ${removed} old run${removed === 1 ? "" : "s"})`);
}

main().catch((e) => { console.error(`backup FAILED: ${e.message}`); process.exit(1); });
