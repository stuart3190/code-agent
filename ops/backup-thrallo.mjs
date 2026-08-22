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

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { loadEnv } from "../shell/server/lib/env.mjs";
import { validateBackupDirectory } from "../scripts/lib/backupValidation.mjs";
import { inventoryFilesystemRoot, readInventoriedFile } from "./lib/filesystemBackup.mjs";
import {
  EPHEMERAL_RUNTIME_TABLES,
  findCatalogCoverageGaps,
  prepareRowsForBackup,
  runtimeCatalogEvidence,
  sha256Lines,
} from "./lib/runtimeBackupSchema.mjs";

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
  // The account's notification history. It is the only record that something was ever said —
  // losing it would mean a restored account could not see what it had been told.
  "ca_notifications",
  "ca_products",
  "ca_conversations",
  "ca_conversation_turns",
  "ca_conversation_events",
  "ca_lead_model_reservations",
  "ca_direct_model_reservations",
  "ca_owner_profile",
  "ca_memories",
  "projects",
  "credit_ledger",
  "build_jobs",
  "build_work_payloads",
  "build_work_jobs",
  "build_work_results",
  "build_work_events",
  "build_worker_nodes",
  "published_sites",
  // Deployment history. Permanent while a project lives, and the only copy of the source that was
  // actually published — losing it would make every rollback and every deployment download
  // unrecoverable.
  "deployments",
  "publish_releases",
  "publish_activation_intents",
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

  // Analytics, project logs and health monitoring. Added 2026-08-03: these six shipped straight to
  // production without a migration, so the guard — which reads migrations — could not see them and
  // they were absent from every snapshot. analytics_salts is included deliberately: without the
  // salt for a day, that day's visitor counts can never be recomputed or reconciled.
  "analytics_salts",
  "analytics_events",
  "analytics_daily",
  "project_logs",
  "health_checks",
  "health_status",
  // Builder v2 foundation. Back up every table, including graph rows and verification cache.
  // Deterministic regeneration has not yet passed an isolated restore proof, and a restored cache
  // may be invalidated rather than trusted, but neither is silently omitted from recovery evidence.
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
  "bv2_build_envelopes",
  "bv2_build_progress",
  "bv2_recovery_approvals",
  "bv2_duration_extensions",
  "bv2_verification_defects",
  "bv2_repair_strategies",
  "bv2_build_settlements",
  // Durable pre-dispatch reservations are canonical billing evidence. Losing them could either
  // reopen spent budget after restore or make an already-settled provider call untraceable.
  "bv2_model_reservations",
  "bv2_build_budget_approvals",
  "ca_model_call_identities",
  "bv2_assets",
  "bv2_retrieval_traces",
  "bv2_patches",
  "bv2_verification_cache",
  // Permanent erasure evidence contains references, hashes and counts only. It is required to
  // prove deletion without restoring the deleted content itself.
  "data_erasure_jobs",
  "data_erasure_events",
];

export const ARTIFACT_BUCKET = process.env.CODE_AGENT_ARTIFACT_BUCKET || "thrallo-artifacts";
const PAGE = 1000;
// The floor for the adaptive page size. Below this a genuinely unservable row is the problem, not
// the batch, and shrinking further would only turn one failure into a thousand.
const MIN_PAGE = 10;

/**
 * Every row of a table, in pages that shrink until the database can serve them.
 *
 * A fixed page size cannot work here, because row WEIGHT varies by three orders of magnitude
 * between tables: a subscription row is a few hundred bytes, an index chunk carries an embedding
 * and is ~40 KB. At PAGE=1000 that table asked for roughly 40 MB in one statement and Postgres
 * cancelled it — so the whole backup aborted, leaving 16 of 34 tables on disk and no manifest.
 *
 * It failed loudly in the service log and silently everywhere else, which is how Thrallo went from
 * a complete nightly backup on 3 August to a partial one on 4 August with nothing saying so.
 *
 * Halving on timeout self-tunes as tables grow, instead of needing a constant revisited whenever
 * one does.
 */
async function dumpTable(svc, table) {
  const rows = [];
  let size = PAGE;
  let from = 0;
  for (;;) {
    const { data, error } = await svc.from(table).select("*").range(from, from + size - 1);
    if (error) {
      // Only a timeout is worth retrying smaller; anything else is a real failure and must stop the
      // backup rather than be quietly skipped, which would produce a plausible-looking short file.
      const timedOut = /timeout|canceling statement/i.test(error.message || "");
      if (timedOut && size > MIN_PAGE) {
        size = Math.max(MIN_PAGE, Math.floor(size / 4));
        console.log(`  ${table}: page too heavy, retrying at ${size} rows`);
        continue;
      }
      throw new Error(`${table}: ${error.message}`);
    }
    rows.push(...(data || []));
    if (!data || data.length < size) break;
    from += data.length;
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
  const finalDir = path.join(backupRoot, `thrallo-${stamp}`);
  const dir = path.join(backupRoot, `.incomplete-thrallo-${stamp}`);
  await mkdir(path.join(dir, "storage"), { recursive: true });

  const manifest = {
    product: "thrallo",
    formatVersion: 2,
    url: new globalThis.URL(URL_).host,
    sourceCommit: process.env.THRALLO_BACKUP_SOURCE_COMMIT || await currentGitCommit(),
    backupToolSha256: sha256(await readFile(new URL(import.meta.url))),
    startedAt: new Date().toISOString(),
    tables: {},
    files: {},
    storage: { bucket: ARTIFACT_BUCKET, objects: 0 },
    filesystem: { roots: {}, objects: 0 },
    bytes: 0,
  };

  const ledger = await loadMigrationLedgerEvidence();
  const evidence = runtimeCatalogEvidence(ledger.migrations?.length);
  const catalog = await loadLiveCatalog(svc);
  const backupTables = CA_TABLES.filter((table) => catalog.includes(table));
  const coverage = findCatalogCoverageGaps(catalog, backupTables, EPHEMERAL_RUNTIME_TABLES);
  if (coverage.missingFromBackup.length || coverage.missingFromCatalog.length) {
    throw new Error(`live catalog / backup manifest mismatch: ${JSON.stringify(coverage)}`);
  }
  const catalogHash = sha256Lines(catalog);
  if (catalog.length !== evidence.tables.length || catalogHash !== evidence.tablesSha256) {
    throw new Error(`live catalog differs from the approved ${evidence.migrationCount}-migration catalog: count=${catalog.length} sha256=${catalogHash}`);
  }
  manifest.catalogCoverage = {
    source: "thrallo_public_tables RPC",
    tables: catalog.length,
    names: catalog,
    excluded: EPHEMERAL_RUNTIME_TABLES.filter((table) => catalog.includes(table)),
    sha256: catalogHash,
    missingFromBackup: [],
    missingFromCatalog: [],
  };
  console.log(`  live catalog: ${catalog.length} canonical tables, complete backup coverage (${catalogHash})`);

  for (const table of backupTables) {
    const rows = prepareRowsForBackup(table, await dumpTable(svc, table));
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
    manifest.files[file] = { bytes: gz.length, sha256: sha256(gz) };
    objectIndex.push({ key, file, bytes: bytes.length, sha256: sha256(bytes), contentType: data.type || "application/octet-stream" });
    manifest.bytes += gz.length;
  }
  const indexGz = gzipSync(JSON.stringify(objectIndex));
  await writeFile(path.join(dir, "storage_objects.json.gz"), indexGz);
  manifest.tables.storage_objects = objectIndex.length;
  manifest.files["storage_objects.json.gz"] = { bytes: indexGz.length, sha256: sha256(indexGz) };
  manifest.storage.objects = objectIndex.length;
  console.log(`  storage: ${objectIndex.length} objects from ${ARTIFACT_BUCKET}`);

  const filesystemIndex = [];
  const filesystemDirectories = [];
  const roots = [
    { name: "publish", source: process.env.PUBLISH_DIR || path.join(os.homedir(), "publish") },
    { name: "qa", source: process.env.QA_ARTIFACT_DIR || path.join(os.homedir(), "thrallo-qa") },
    { name: "build-worker", source: process.env.THRALLO_BUILD_ARTIFACT_ROOT || "/var/lib/thrallo-build-worker" },
  ];
  for (const root of roots) {
    const rootStat = await stat(root.source).catch(() => null);
    if (!rootStat?.isDirectory()) throw new Error(`filesystem root missing or not a directory: ${root.source}`);
    const inventory = await inventoryFilesystemRoot(root.source);
    const files = inventory.files;
    filesystemDirectories.push(...inventory.directories.map((directory) => ({
      root: root.name,
      relativePath: directory.relative,
      mode: directory.mode,
    })));
    let rootBytes = 0;
    for (const item of files) {
      const bytes = await readInventoriedFile(item);
      const gz = gzipSync(bytes);
      const file = `filesystem/${root.name}/${sha256(Buffer.from(item.relative))}.bin.gz`;
      await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await writeFile(path.join(dir, file), gz);
      manifest.files[file] = { bytes: gz.length, sha256: sha256(gz) };
      filesystemIndex.push({ root: root.name, relativePath: item.relative, file, bytes: bytes.length, sha256: sha256(bytes), mode: item.mode });
      manifest.bytes += gz.length;
      rootBytes += bytes.length;
    }
    manifest.filesystem.roots[root.name] = {
      source: root.source,
      objects: files.length,
      directories: inventory.directories.length,
      bytes: rootBytes,
    };
    manifest.filesystem.objects += files.length;
    console.log(`  filesystem ${root.name}: ${files.length} files (${rootBytes} bytes)`);
  }
  const filesystemIndexGz = gzipSync(JSON.stringify(filesystemIndex));
  await writeFile(path.join(dir, "filesystem_objects.json.gz"), filesystemIndexGz);
  manifest.tables.filesystem_objects = filesystemIndex.length;
  manifest.files["filesystem_objects.json.gz"] = { bytes: filesystemIndexGz.length, sha256: sha256(filesystemIndexGz) };
  manifest.bytes += filesystemIndexGz.length;
  const filesystemDirectoriesGz = gzipSync(JSON.stringify(filesystemDirectories));
  await writeFile(path.join(dir, "filesystem_directories.json.gz"), filesystemDirectoriesGz);
  manifest.tables.filesystem_directories = filesystemDirectories.length;
  manifest.files["filesystem_directories.json.gz"] = {
    bytes: filesystemDirectoriesGz.length,
    sha256: sha256(filesystemDirectoriesGz),
  };
  manifest.bytes += filesystemDirectoriesGz.length;

  const ledgerGz = gzipSync(JSON.stringify(ledger));
  await writeFile(path.join(dir, "migration_ledger.json.gz"), ledgerGz);
  manifest.files["migration_ledger.json.gz"] = { bytes: ledgerGz.length, sha256: sha256(ledgerGz) };
  manifest.migrationLedger = { source: ledger.source, capturedAt: ledger.capturedAt, migrations: ledger.migrations.length };
  manifest.bytes += ledgerGz.length;
  const migrationState = await buildMigrationState(ledger);
  const migrationStateGz = gzipSync(JSON.stringify(migrationState));
  await writeFile(path.join(dir, "migration_state.json.gz"), migrationStateGz);
  manifest.tables.migration_state = migrationState.length;
  manifest.files["migration_state.json.gz"] = { bytes: migrationStateGz.length, sha256: sha256(migrationStateGz) };
  manifest.migrationLedger.pendingLocal = migrationState.filter((migration) => !migration.applied).map((migration) => migration.version);
  if (manifest.migrationLedger.pendingLocal.length) {
    throw new Error(`backup source has migrations absent from production evidence: ${manifest.migrationLedger.pendingLocal.join(", ")}`);
  }
  manifest.bytes += migrationStateGz.length;
  console.log(`  migration ledger: ${ledger.migrations.length} authoritative rows captured ${ledger.capturedAt}`);

  manifest.finishedAt = new Date().toISOString();
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));

  const validation = await validateBackupDirectory(dir);
  console.log(`  validation: ${validation.files} files decoded, counted and checksummed`);
  await rename(dir, finalDir);

  let removed = 0;
  const cutoff = Date.now() - keepDays * 86_400_000;
  for (const name of await readdir(backupRoot).catch(() => [])) {
    const match = /^thrallo-(\d{4}-\d{2}-\d{2})T/.exec(name);
    if (match && new Date(match[1]).getTime() < cutoff) {
      await rm(path.join(backupRoot, name), { recursive: true, force: true });
      removed += 1;
    }
  }
  console.log(`backup OK -> ${finalDir} (${manifest.bytes} bytes gz total, pruned ${removed} old runs)`);
}

async function loadLiveCatalog(svc) {
  const { data, error } = await svc.rpc("thrallo_public_tables");
  if (error || !Array.isArray(data)) {
    throw new Error(`cannot enumerate the live public catalog: ${error?.message || "invalid RPC result"}`);
  }
  const names = data.map((row) => row.table_name || row).filter(Boolean).sort();
  if (new Set(names).size !== names.length) throw new Error("live catalog contains duplicate table names");
  return names;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function resolveMigrationLedgerFile() {
  if (process.env.THRALLO_MIGRATION_LEDGER_FILE) return path.resolve(process.env.THRALLO_MIGRATION_LEDGER_FILE);
  const root = path.resolve("docs", "evidence", "migration-reconstruction");
  const dates = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
  for (const date of dates) {
    const candidate = path.join(root, date, "authoritative-history-manifest.json");
    if ((await stat(candidate).catch(() => null))?.isFile()) return candidate;
  }
  throw new Error("authoritative migration ledger evidence is missing; set THRALLO_MIGRATION_LEDGER_FILE");
}

export async function loadMigrationLedgerEvidence() {
  const ledgerPath = await resolveMigrationLedgerFile();
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  if (process.env.THRALLO_MIGRATION_LEDGER_FILE) return ledger;

  const evidenceRoot = path.dirname(path.dirname(ledgerPath));
  const overlays = [];
  for (const date of (await readdir(evidenceRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
    const overlayPath = path.join(evidenceRoot, date, "applied-history-overlay.json");
    const overlay = JSON.parse(await readFile(overlayPath, "utf8").catch(() => "null"));
    if (overlay) overlays.push({ ...overlay, path: overlayPath });
  }
  const migrations = [...(ledger.migrations || [])];
  const versions = new Set(migrations.map((migration) => String(migration.version)));
  for (const overlay of overlays) {
    for (const migration of overlay.migrations || []) {
      if (versions.has(String(migration.version))) throw new Error(`migration ledger overlay duplicates version: ${migration.version}`);
      versions.add(String(migration.version));
      migrations.push(migration);
    }
  }
  migrations.sort((a, b) => Number(a.appliedOrder) - Number(b.appliedOrder));
  for (let index = 0; index < migrations.length; index += 1) {
    if (Number(migrations[index].appliedOrder) !== index + 1) {
      throw new Error(`migration ledger applied order is not contiguous at ${migrations[index].version}`);
    }
  }
  const latest = overlays.at(-1);
  return {
    ...ledger,
    source: latest ? `${ledger.source}; overlays through ${latest.source}` : ledger.source,
    capturedAt: latest?.capturedAt || ledger.capturedAt,
    migrations,
    overlays: overlays.map((overlay) => path.relative(evidenceRoot, overlay.path).split(path.sep).join("/")),
  };
}

async function buildMigrationState(ledger) {
  const authoritative = new Map(ledger.migrations.map((migration) => [String(migration.version), migration]));
  if (authoritative.size !== ledger.migrations.length) throw new Error("authoritative migration ledger contains duplicate versions");
  const migrationsDir = path.resolve("supabase", "migrations");
  const state = [];
  for (const filename of (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort()) {
    const match = /^(\d{14})_(.+)\.sql$/.exec(filename);
    if (!match) throw new Error(`invalid active migration filename: ${filename}`);
    const sql = await readFile(path.join(migrationsDir, filename));
    const row = authoritative.get(match[1]);
    const fileSha256 = sha256(sql);
    const sqlSha256 = canonicalSqlHash(sql);
    if (row && (row.localCanonicalSqlSha256 || row.canonicalSqlSha256 || row.sqlSha256) !== sqlSha256) {
      throw new Error(`applied migration hash diverged: ${filename}`);
    }
    state.push({ version: match[1], name: match[2], filename, sqlSha256, fileSha256, applied: !!row, appliedOrder: row?.appliedOrder ?? null });
  }
  for (const migration of ledger.migrations) {
    if (!state.some((row) => row.version === String(migration.version))) {
      throw new Error(`authoritative migration is absent from active history: ${migration.version}`);
    }
  }
  return state;
}

async function currentGitCommit() {
  const head = (await readFile(path.resolve(".git", "HEAD"), "utf8").catch(() => "")).trim();
  if (/^[0-9a-f]{40}$/i.test(head)) return head;
  const ref = /^ref: (.+)$/.exec(head)?.[1];
  if (!ref) return null;
  const value = (await readFile(path.resolve(".git", ref), "utf8").catch(() => "")).trim();
  return /^[0-9a-f]{40}$/i.test(value) ? value : null;
}

export function canonicalSqlHash(bytes) {
  return sha256(Buffer.from(Buffer.from(bytes).toString("utf8").replace(/\r\n/g, "\n")));
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((error) => { console.error("backup FAILED:", error.message); process.exit(1); });
}
