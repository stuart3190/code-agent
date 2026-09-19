import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { validateBackupDirectory } from "../scripts/lib/backupValidation.mjs";

const upload = process.argv.includes("--upload");
const root = path.resolve(process.env.THRALLO_BACKUP_DIR || path.join(os.homedir(), "thrallo-backups"));
const remote = process.env.THRALLO_OFFSITE_RCLONE_REMOTE;
const recipient = process.env.THRALLO_OFFSITE_AGE_RECIPIENT;
const backups = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory() && entry.name.startsWith("thrallo-"))
  .map((entry) => path.join(root, entry.name)).sort();
const latest = backups.at(-1);
if (!latest) throw new Error("no complete production backup is available");
await validateBackupDirectory(latest);
const manifest = JSON.parse(await readFile(path.join(latest, "manifest.json"), "utf8"));
if (!manifest.completedAt) throw new Error("latest backup is incomplete");
if (!remote || !recipient) {
  console.log(JSON.stringify({ ok: false, configured: false, latest, reason: "THRALLO_OFFSITE_RCLONE_REMOTE and THRALLO_OFFSITE_AGE_RECIPIENT are required" }));
  process.exitCode = upload ? 1 : 0;
} else if (!upload) {
  execFileSync("age", ["--version"], { stdio: "ignore" });
  execFileSync("rclone", ["version"], { stdio: "ignore" });
  execFileSync("rclone", ["lsd", remote], { stdio: "ignore" });
  console.log(JSON.stringify({ ok: true, configured: true, latest, completedAt: manifest.completedAt }));
} else {
  const temp = await mkdtemp(path.join(os.tmpdir(), "thrallo-offsite-"));
  const archive = path.join(temp, `${path.basename(latest)}.tar.gz`);
  const encrypted = `${archive}.age`;
  try {
    execFileSync("tar", ["-czf", archive, "-C", path.dirname(latest), path.basename(latest)], { stdio: "inherit" });
    execFileSync("age", ["-r", recipient, "-o", encrypted, archive], { stdio: "inherit" });
    execFileSync("rclone", ["copyto", "--immutable", encrypted, `${remote.replace(/\/$/, "")}/${path.basename(encrypted)}`], { stdio: "inherit" });
    console.log(JSON.stringify({ ok: true, backup: latest, remoteObject: path.basename(encrypted), encryptedBytes: (await stat(encrypted)).size }));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
