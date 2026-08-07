import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, writeFile, mkdir, symlink } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CA_TABLES, canonicalSqlHash, loadMigrationLedgerEvidence } from "../../ops/backup-thrallo.mjs";
import { RESTORE_ORDER, prepareRowsForRestore } from "../../ops/restore-thrallo.mjs";
import { validateBackupDirectory } from "../../scripts/lib/backupValidation.mjs";
import { inventoryFilesystemRoot, readInventoriedFile, restoreFilesystemLayout } from "../../ops/lib/filesystemBackup.mjs";

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
].map((table) => [table, UNAPPLIED_LEGACY]).concat([
]));

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
  assert.ok(RESTORE_ORDER.indexOf("ca_github_installations") < RESTORE_ORDER.indexOf("ca_repositories"));
  assert.ok(RESTORE_ORDER.indexOf("ca_repositories") < RESTORE_ORDER.indexOf("ca_agents"));
  assert.ok(RESTORE_ORDER.indexOf("ca_agents") < RESTORE_ORDER.indexOf("ca_runs"));
  assert.ok(RESTORE_ORDER.indexOf("ca_automations") < RESTORE_ORDER.indexOf("ca_runs"));
  assert.ok(RESTORE_ORDER.indexOf("ca_runs") < RESTORE_ORDER.indexOf("ca_run_events"));
  assert.ok(RESTORE_ORDER.indexOf("ca_runs") < RESTORE_ORDER.indexOf("ca_artifacts"));
  assert.ok(RESTORE_ORDER.indexOf("bv2_file_revisions") < RESTORE_ORDER.indexOf("bv2_symbols"));
  assert.ok(RESTORE_ORDER.indexOf("bv2_symbols") < RESTORE_ORDER.indexOf("bv2_symbol_refs"));
  assert.ok(RESTORE_ORDER.indexOf("bv2_file_revisions") < RESTORE_ORDER.indexOf("bv2_shadow_run_files"));
  assert.ok(RESTORE_ORDER.indexOf("bv2_shadow_runs") < RESTORE_ORDER.indexOf("bv2_shadow_run_files"));
  assert.ok(RESTORE_ORDER.indexOf("bv2_shadow_runs") < RESTORE_ORDER.indexOf("bv2_shadow_checks"));
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
  await assert.rejects(validateBackupDirectory(dir), /manifest says|checksum mismatch/);
});

test("backup validation verifies storage, filesystem, and migration-ledger payload bytes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "thrallo-backup-objects-"));
  await mkdir(path.join(dir, "storage"), { recursive: true });
  await mkdir(path.join(dir, "filesystem", "publish"), { recursive: true });
  const raw = Buffer.from("immutable payload");
  const objectGz = gzipSync(raw);
  const storageFile = "storage/object.bin.gz";
  const filesystemFile = "filesystem/publish/object.bin.gz";
  await writeFile(path.join(dir, storageFile), objectGz);
  await writeFile(path.join(dir, filesystemFile), objectGz);
  const object = { file: storageFile, bytes: raw.length, sha256: createHash("sha256").update(raw).digest("hex") };
  const storageIndex = gzipSync(JSON.stringify([object]));
  const filesystemIndex = gzipSync(JSON.stringify([{ ...object, file: filesystemFile, root: "publish", relativePath: "index.html" }]));
  const ledger = gzipSync(JSON.stringify({ migrations: [{ version: "1" }] }));
  await writeFile(path.join(dir, "storage_objects.json.gz"), storageIndex);
  await writeFile(path.join(dir, "filesystem_objects.json.gz"), filesystemIndex);
  await writeFile(path.join(dir, "migration_ledger.json.gz"), ledger);
  const files = Object.fromEntries([
    [storageFile, objectGz],
    [filesystemFile, objectGz],
    ["storage_objects.json.gz", storageIndex],
    ["filesystem_objects.json.gz", filesystemIndex],
    ["migration_ledger.json.gz", ledger],
  ].map(([file, bytes]) => [file, { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }]));
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify({
    product: "thrallo",
    tables: { storage_objects: 1, filesystem_objects: 1 },
    files,
    migrationLedger: { migrations: 1 },
  }));

  assert.equal((await validateBackupDirectory(dir)).ok, true);
  await writeFile(path.join(dir, filesystemFile), gzipSync(Buffer.from("tampered")));
  await assert.rejects(validateBackupDirectory(dir), /byte|checksum/i);
});

test("service-account home entries cannot contaminate the canonical worker artifact root", async () => {
  const namespace = await mkdtemp(path.join(os.tmpdir(), "thrallo-worker-boundary-"));
  const home = path.join(namespace, "worker-home");
  const artifacts = path.join(namespace, "artifacts");
  await mkdir(home);
  await mkdir(artifacts);
  await writeFile(path.join(home, ".face"), "os skeleton");
  await symlink(".face", path.join(home, ".face.icon"), "file");

  const inventory = await inventoryFilesystemRoot(artifacts);
  assert.deepEqual(inventory.files, []);
  assert.deepEqual(inventory.directories.map((entry) => entry.relative), ["."]);
});

test("an unexpected symlink inside a canonical job directory aborts backup inventory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "thrallo-worker-symlink-"));
  await mkdir(path.join(root, "job-1"));
  await writeFile(path.join(root, "job-1", "artifact.zip"), "artifact");
  await symlink("artifact.zip", path.join(root, "job-1", "latest.zip"), "file");
  await assert.rejects(inventoryFilesystemRoot(root), /refuses symlink/);
});

test("a symlink pointing outside the canonical artifact root is rejected", async () => {
  const namespace = await mkdtemp(path.join(os.tmpdir(), "thrallo-worker-outside-"));
  const root = path.join(namespace, "artifacts");
  const outside = path.join(namespace, "outside.txt");
  await mkdir(root);
  await writeFile(outside, "must not follow");
  await symlink(outside, path.join(root, "escape"), "file");
  await assert.rejects(inventoryFilesystemRoot(root), /refuses symlink/);
});

test("canonical worker files and directory modes are inventoried without silent skips", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "thrallo-worker-canonical-"));
  const job = path.join(root, "job-1");
  const artifact = path.join(job, "artifact");
  await mkdir(artifact, { recursive: true });
  await chmod(job, 0o750);
  await chmod(artifact, 0o750);
  await writeFile(path.join(job, "result.json"), "{\"ok\":true}");
  await writeFile(path.join(artifact, "index.html"), "ready");

  const inventory = await inventoryFilesystemRoot(root);
  assert.deepEqual(inventory.files.map((entry) => entry.relative), [
    "job-1/artifact/index.html",
    "job-1/result.json",
  ]);
  assert.deepEqual(inventory.directories.map((entry) => entry.relative), [".", "job-1", "job-1/artifact"]);
  const jobMode = (await import("node:fs/promises")).stat(job).then((entry) => entry.mode & 0o777);
  assert.equal(inventory.directories.find((entry) => entry.relative === "job-1").mode, await jobMode);
  assert.equal((await readInventoriedFile(inventory.files[0])).toString(), "ready");
  assert.equal((await readInventoriedFile(inventory.files[1])).toString(), "{\"ok\":true}");

  const target = await mkdtemp(path.join(os.tmpdir(), "thrallo-worker-restored-"));
  const files = await Promise.all(inventory.files.map(async (entry) => {
    const bytes = await readInventoriedFile(entry);
    return {
      root: "build-worker",
      relativePath: entry.relative,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      mode: entry.mode,
      content: bytes,
    };
  }));
  const directories = inventory.directories.map((entry) => ({
    root: "build-worker",
    relativePath: entry.relative,
    mode: entry.mode,
  }));
  await restoreFilesystemLayout({
    filesystemRoot: target,
    directories,
    files,
    readObject: async (object) => object.content,
  });
  assert.equal(await readFile(path.join(target, "build-worker", "job-1", "artifact", "index.html"), "utf8"), "ready");
  const restoredJobMode = (await (await import("node:fs/promises")).stat(path.join(target, "build-worker", "job-1"))).mode & 0o777;
  assert.equal(restoredJobMode, await jobMode);
});

test("non-durable temp and workspace siblings are excluded from worker artifact inventory", async () => {
  const namespace = await mkdtemp(path.join(os.tmpdir(), "thrallo-worker-nondurable-"));
  const root = path.join(namespace, "artifacts");
  await mkdir(root);
  await mkdir(path.join(namespace, "workspace"));
  await mkdir(path.join(namespace, "tmp"));
  await writeFile(path.join(root, "result.json"), "canonical");
  await writeFile(path.join(namespace, "workspace", "source.ts"), "temporary");
  await writeFile(path.join(namespace, "tmp", "cache"), "temporary");

  const inventory = await inventoryFilesystemRoot(root);
  assert.deepEqual(inventory.files.map((entry) => entry.relative), ["result.json"]);
});

test("an empty canonical worker artifact root inventories cleanly", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "thrallo-worker-empty-"));
  const inventory = await inventoryFilesystemRoot(root);
  assert.equal(inventory.files.length, 0);
  assert.deepEqual(inventory.directories.map((entry) => entry.relative), ["."]);
});

test("authoritative migration identity is line-ending independent without changing file hashes", async () => {
  const lf = Buffer.from("select 1;\nselect 2;\n");
  const crlf = Buffer.from("select 1;\r\nselect 2;\r\n");
  assert.notEqual(createHash("sha256").update(lf).digest("hex"), createHash("sha256").update(crlf).digest("hex"));
  assert.equal(canonicalSqlHash(lf), canonicalSqlHash(crlf));
});

test("backup migration evidence overlays the authoritative base through production ledger row 65", async () => {
  const ledger = await loadMigrationLedgerEvidence();
  assert.equal(ledger.migrations.length, 65);
  assert.deepEqual(ledger.migrations.slice(-5).map((migration) => migration.version), [
    "20260806210321",
    "20260806221153",
    "20260806230625",
    "20260807072455",
    "20260807174720",
  ]);
  assert.equal(ledger.migrations.at(-1).appliedOrder, 65);
  assert.ok(ledger.migrations.slice(-5).every((migration) => migration.localCanonicalSqlSha256));
});

test("generated-always run-event ids restore exactly only when the backup is contiguous", () => {
  assert.deepEqual(prepareRowsForRestore("ca_run_events", [{ id: 2, value: "b" }, { id: 1, value: "a" }]), [
    { value: "a" },
    { value: "b" },
  ]);
  assert.throws(() => prepareRowsForRestore("ca_run_events", [{ id: 1 }, { id: 3 }]), /identity has gaps/);
});

test("systemd units and the runbook ship with the repository", async () => {
  const backup = await readFile(new URL("../../ops/backup-thrallo.mjs", import.meta.url), "utf8");
  assert.match(backup, /\.incomplete-thrallo-/);
  assert.match(backup, /await rename\(dir, finalDir\)/);
  const service = await readFile(new URL("../../ops/thrallo-backup.service", import.meta.url), "utf8");
  assert.match(service, /ExecStart=\/usr\/bin\/node ops\/backup-thrallo\.mjs/);
  // Drift runs AFTER the backup, so a drift failure can never stop a backup being taken.
  assert.match(service, /ExecStartPost=\/usr\/bin\/node ops\/migration-drift\.mjs/);
  assert.match(service, /WorkingDirectory=\/home\/ubuntu\/code-agent/);
  const timer = await readFile(new URL("../../ops/thrallo-backup.timer", import.meta.url), "utf8");
  assert.match(timer, /OnCalendar=/);
  assert.match(timer, /Persistent=true/);
  const runbook = await readFile(new URL("../../docs/DISASTER-RECOVERY.md", import.meta.url), "utf8");
  assert.match(runbook, /PLATFORM_ENC_KEY/);
  assert.match(runbook, /restore-thrallo\.mjs/);
  const workerUnit = await readFile(new URL("../../build-worker/thrallo-build-worker.service", import.meta.url), "utf8");
  assert.match(workerUnit, /Environment=HOME=\/var\/lib\/thrallo-build-worker-home/);
  assert.match(workerUnit, /ReadWritePaths=\/var\/lib\/thrallo-build-worker(?:\r?\n|$)/);
  assert.doesNotMatch(workerUnit, /ReadWritePaths=\/var\/lib\/thrallo-build-worker-home/);
  for (const table of ["build_work_results", "build_work_events"]) assert.ok(CA_TABLES.includes(table));
});

// ── Migration drift: the half CI structurally cannot do ─────────────────────────────────
//
// The guard above reads `supabase/migrations/`, so it is blind by construction to a table applied
// straight to production and never written to a migration. Six tables reached production that way
// — analytics, logs and health — and were absent from every backup. The comment above delegated
// this to "the scheduled migration-drift ops check", which did not exist until now.

test("drift detection catches a live table with no migration and no backup", async () => {
  const { findDrift } = await import("../../ops/migration-drift.mjs");

  // Exactly the situation that shipped: the table exists, works, and is invisible to the repo.
  const problems = findDrift({
    live: new Set(["ca_runs", "analytics_events"]),
    migrated: new Set(["ca_runs"]),
    backedUp: new Set(["ca_runs"]),
  });
  assert.equal(problems.length, 2, "it is two separate failures, not one");
  assert.ok(problems.some((p) => /NO migration/.test(p)), "the database cannot be rebuilt");
  assert.ok(problems.some((p) => /NOT backed up/.test(p)), "and its data is lost on restore");
});

test("a migrated-but-unbacked table is caught on its own", () => {
  // Different consequence from the above: restoring succeeds and silently loses the data.
  return import("../../ops/migration-drift.mjs").then(({ findDrift }) => {
    const problems = findDrift({
      live: new Set(["diag_runs"]),
      migrated: new Set(["diag_runs"]),
      backedUp: new Set(),
    });
    assert.deepEqual(problems.map((p) => p.includes("NOT backed up")), [true]);
  });
});

test("a fully reconciled database reports nothing, and Supabase's own tables are ignored", async () => {
  const { findDrift } = await import("../../ops/migration-drift.mjs");
  assert.deepEqual(findDrift({
    live: new Set(["ca_runs", "schema_migrations"]),
    migrated: new Set(["ca_runs"]),
    backedUp: new Set(["ca_runs"]),
  }), [], "schema_migrations is Supabase's, not ours to migrate or back up");
});

test("every table this session added to production is now migrated AND backed up", async () => {
  const migrated = await tablesFromMigrations();
  for (const table of [
    "analytics_events", "analytics_daily", "analytics_salts",
    "project_logs", "health_checks", "health_status",
  ]) {
    assert.ok(migrated.has(table), `${table} has no migration — the DB cannot be rebuilt from the repo`);
    assert.ok(CA_TABLES.includes(table), `${table} is not backed up`);
    assert.ok(RESTORE_ORDER.includes(table), `${table} cannot be restored`);
  }
});
