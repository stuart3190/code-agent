import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateBackupDirectory } from "./lib/backupValidation.mjs";

const root = process.env.BACKUP_DIR || path.join(os.homedir(), "backups");
let dir = process.argv[2];
if (!dir) {
  const runs = (await readdir(root).catch(() => []))
    .filter((name) => name.startsWith("supabase-"))
    .sort();
  if (!runs.length) throw new Error(`No backups found in ${root}`);
  dir = path.join(root, runs.at(-1));
}

const result = await validateBackupDirectory(path.resolve(dir));
console.log(`backup validation OK: ${result.files} files decoded and matched their manifest`);
