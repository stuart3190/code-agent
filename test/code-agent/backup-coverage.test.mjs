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

async function tablesFromMigrations() {
  const tables = new Set();
  for (const name of await readdir(migrationsDir)) {
    if (!name.endsWith(".sql")) continue;
    const sql = await readFile(new URL(name, migrationsDir), "utf8");
    for (const match of sql.matchAll(/create table (?:if not exists )?public\.(ca_\w+|projects|build_jobs)/gi)) {
      tables.add(match[1]);
    }
  }
  return tables;
}

test("the backup covers every ca_ table any migration creates", async () => {
  const migrated = await tablesFromMigrations();
  const backedUp = new Set(CA_TABLES);
  const missing = [...migrated].filter((table) => !backedUp.has(table));
  const extra = [...backedUp].filter((table) => !migrated.has(table));
  assert.deepEqual(missing, [], `add these tables to CA_TABLES in ops/backup-thrallo.mjs: ${missing.join(", ")}`);
  assert.deepEqual(extra, [], `CA_TABLES lists tables no migration creates: ${extra.join(", ")}`);
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
