import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { validateBackupDirectory } from "../scripts/lib/backupValidation.mjs";

const dir = await mkdtemp(path.join(os.tmpdir(), "buildr-backup-test-"));
try {
  const rows = [{ id: 1 }, { id: 2 }];
  const gz = gzipSync(JSON.stringify(rows));
  const fileManifest = { bytes: gz.length, sha256: createHash("sha256").update(gz).digest("hex") };
  await writeFile(path.join(dir, "projects.json.gz"), gz);
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify({
    tables: { projects: 2 },
    files: { "projects.json.gz": fileManifest },
  }));
  assert.equal((await validateBackupDirectory(dir)).ok, true);

  await writeFile(path.join(dir, "manifest.json"), JSON.stringify({ tables: { projects: 3 }, files: { "projects.json.gz": fileManifest } }));
  await assert.rejects(validateBackupDirectory(dir), /manifest says 3 rows/);
  console.log("backup validation: pass");
} finally {
  await rm(dir, { recursive: true, force: true });
}
