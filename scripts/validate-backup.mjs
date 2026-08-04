import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateBackupDirectory } from "./lib/backupValidation.mjs";

/**
 * Validate THRALLO's latest backup.
 *
 * This defaulted to ~/backups and looked for directories named `supabase-*` — the Buildr101-era
 * layout. Thrallo's backup writes to ~/thrallo-backups as `thrallo-<stamp>`, so this script has
 * never once validated a Thrallo backup: it read an old, unrelated set and reported OK.
 *
 * That is how a broken backup stayed invisible. On 4 August the nightly run aborted on a statement
 * timeout, leaving 16 of 34 tables and no manifest — and this still said "OK, 33 files", because it
 * was looking somewhere else entirely. A validator pointed at the wrong directory is worse than no
 * validator, because it manufactures confidence.
 *
 * Both roots are searched now, newest run wins, and the run's own name is printed so the output
 * says WHAT was validated rather than only that something was.
 */
const ROOTS = process.env.BACKUP_DIR
  ? [process.env.BACKUP_DIR]
  : [path.join(os.homedir(), "thrallo-backups"), path.join(os.homedir(), "backups")];

let dir = process.argv[2];
if (!dir) {
  const candidates = [];
  for (const root of ROOTS) {
    for (const name of await readdir(root).catch(() => [])) {
      if (/^(thrallo|supabase)-/.test(name)) candidates.push({ root, name });
    }
  }
  if (!candidates.length) throw new Error(`No backups found in ${ROOTS.join(" or ")}`);
  // The stamp is in the name and sorts lexicographically, so the last one is the newest.
  candidates.sort((a, b) => a.name.localeCompare(b.name));
  const latest = candidates.at(-1);
  dir = path.join(latest.root, latest.name);
}

const result = await validateBackupDirectory(path.resolve(dir));
console.log(`backup validation OK: ${path.basename(dir)} — ${result.files} files decoded and matched their manifest`);
