import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import path from "node:path";

import { inspectBackupRelations, validateImmutableBackupContent, relationCatalogHash } from "../../ops/lib/backupRelations.mjs";

export async function validateBackupDirectory(dir) {
  const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
  const tables = manifest?.tables || {};
  const checked = {};
  const relationTables = new Map();
  if (manifest.formatVersion >= 3 && !manifest.relations) throw new Error("backup relation evidence missing");

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
    if (manifest.relations && (table === "auth_users" || manifest.catalogCoverage?.names?.includes(table))) relationTables.set(table, rows);
  }

  if(manifest.relations) {
    const filename=manifest.relations.file;
    if(!manifest.files?.[filename])throw new Error("backup relation catalog checksum entry missing");
    const catalog=JSON.parse(gunzipSync(await readFile(safeBackupPath(dir,filename))).toString("utf8"));
    if(relationCatalogHash(catalog)!==manifest.relations.catalogSha256)throw new Error("backup relation catalog hash mismatch");
    const issues=inspectBackupRelations(relationTables,catalog);
    if(issues.missing.length || issues.containers.length)throw new Error(`backup referential closure failed: ${issues.missing.length} missing parents, ${issues.containers.length} incomplete immutable containers`);
    validateImmutableBackupContent(relationTables);
    const storage=JSON.parse(gunzipSync(await readFile(safeBackupPath(dir,"storage_objects.json.gz"))).toString("utf8"));
    const objects=new Map(storage.map(row=>[row.key,row]));
    for(const blob of relationTables.get("bv2_blobs") || []) {
      if(blob.content != null) continue;
      const object=objects.get(blob.storage_path);
      if(!object || object.sha256 !== blob.content_hash || object.bytes !== blob.size_bytes) throw new Error("backup external blob storage integrity mismatch");
    }
    relationTables.clear();
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

  if (manifest.catalogCoverage) {
    const names = manifest.catalogCoverage.names;
    if (!Array.isArray(names) || new Set(names).size !== names.length) {
      throw new Error("catalog coverage names are missing or duplicated");
    }
    if (names.length !== Number(manifest.catalogCoverage.tables)) {
      throw new Error("catalog coverage table count mismatch");
    }
    const digest = createHash("sha256").update([...names].sort().join("\n")).digest("hex");
    if (digest !== manifest.catalogCoverage.sha256) throw new Error("catalog coverage checksum mismatch");
    const excluded = new Set(manifest.catalogCoverage.excluded || []);
    const absent = names.filter((table) => !excluded.has(table) && !(table in tables));
    if (absent.length) throw new Error(`catalog tables missing from backup manifest: ${absent.join(", ")}`);
  }

  return {
    ok: true,
    tables: checked,
    files: Object.keys(manifest.files || {}).length,
    catalogCoverage: manifest.catalogCoverage || null,
    migrationLedger: manifest.migrationLedger || null,
  };
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
