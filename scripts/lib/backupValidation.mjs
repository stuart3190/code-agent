import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import path from "node:path";

export async function validateBackupDirectory(dir) {
  const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
  const tables = manifest?.tables || {};
  const checked = {};

  for (const [table, expected] of Object.entries(tables)) {
    const filename = `${table}.json.gz`;
    const bytes = await readFile(path.join(dir, filename));
    const rows = JSON.parse(gunzipSync(bytes).toString("utf8"));
    if (!Array.isArray(rows)) throw new Error(`${filename}: decoded value is not an array`);
    if (rows.length !== Number(expected)) {
      throw new Error(`${filename}: manifest says ${expected} rows, decoded ${rows.length}`);
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (manifest.files?.[filename]?.sha256 && manifest.files[filename].sha256 !== digest) {
      throw new Error(`${filename}: checksum mismatch`);
    }
    checked[table] = rows.length;
  }

  return { ok: true, tables: checked, files: Object.keys(checked).length };
}
