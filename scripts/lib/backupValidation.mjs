import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import path from "node:path";

export async function validateBackupDirectory(dir) {
  const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
  const tables = manifest?.tables || {};
  const checked = {};

  for (const [filename, expected] of Object.entries(manifest.files || {})) {
    const full = safeBackupPath(dir, filename);
    const bytes = await readFile(full);
    if (bytes.length !== Number(expected.bytes)) {
      throw new Error(`${filename}: manifest says ${expected.bytes} bytes, read ${bytes.length}`);
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (expected.sha256 !== digest) throw new Error(`${filename}: checksum mismatch`);
  }

  for (const [table, expected] of Object.entries(tables)) {
    const filename = `${table}.json.gz`;
    if (!manifest.files?.[filename]) throw new Error(`${filename}: missing checksum manifest entry`);
    const bytes = await readFile(safeBackupPath(dir, filename));
    const rows = JSON.parse(gunzipSync(bytes).toString("utf8"));
    if (!Array.isArray(rows)) throw new Error(`${filename}: decoded value is not an array`);
    if (rows.length !== Number(expected)) {
      throw new Error(`${filename}: manifest says ${expected} rows, decoded ${rows.length}`);
    }
    checked[table] = rows.length;
  }

  await validateObjectPayloads(dir, manifest, checked.storage_objects ? "storage_objects" : null);
  await validateObjectPayloads(dir, manifest, checked.filesystem_objects ? "filesystem_objects" : null);

  if (manifest.migrationLedger) {
    const filename = "migration_ledger.json.gz";
    if (!manifest.files?.[filename]) throw new Error(`${filename}: missing checksum manifest entry`);
    const ledger = JSON.parse(gunzipSync(await readFile(safeBackupPath(dir, filename))).toString("utf8"));
    if (!Array.isArray(ledger.migrations) || ledger.migrations.length !== Number(manifest.migrationLedger.migrations)) {
      throw new Error(`${filename}: migration count mismatch`);
    }
  }

  return { ok: true, tables: checked, files: Object.keys(manifest.files || {}).length };
}

async function validateObjectPayloads(dir, manifest, indexName) {
  if (!indexName) return;
  const index = JSON.parse(gunzipSync(await readFile(safeBackupPath(dir, `${indexName}.json.gz`))).toString("utf8"));
  for (const object of index) {
    if (!manifest.files?.[object.file]) throw new Error(`${object.file}: missing checksum manifest entry`);
    const raw = gunzipSync(await readFile(safeBackupPath(dir, object.file)));
    if (raw.length !== Number(object.bytes)) throw new Error(`${object.file}: object byte count mismatch`);
    const digest = createHash("sha256").update(raw).digest("hex");
    if (digest !== object.sha256) throw new Error(`${object.file}: object checksum mismatch`);
  }
}

function safeBackupPath(dir, relative) {
  const root = path.resolve(dir);
  const full = path.resolve(root, relative);
  if (full !== root && !full.startsWith(`${root}${path.sep}`)) throw new Error(`backup path escapes root: ${relative}`);
  return full;
}
