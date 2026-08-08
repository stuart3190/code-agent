#!/usr/bin/env node

// Read-only Package 10E credential containment audit. Never prints credential bytes.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const shellEnvPath = "/home/ubuntu/code-agent/shell/.env";
const workerEnvPath = "/etc/thrallo/build-worker.env";

function envValue(file, name) {
  const text = fs.readFileSync(file, "utf8");
  const match = text.match(new RegExp(`^${name}=(.*)$`, "m"));
  if (!match) throw new Error(`${name} absent from ${file}`);
  return match[1].trim().replace(/^(["'])(.*)\1$/, "$2");
}

const shellKey = envValue(shellEnvPath, "SUPABASE_SERVICE_ROLE_KEY");
const workerKey = envValue(workerEnvPath, "SUPABASE_SERVICE_ROLE_KEY");
if (!shellKey.startsWith("sb_secret_")) throw new Error("shell credential is not an sb_secret key");
if (shellKey !== workerKey) throw new Error("shell and worker credentials differ");

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const secret = Buffer.from(shellKey);
const approved = new Set([shellEnvPath, workerEnvPath]);
const roots = [
  "/home/ubuntu/code-agent",
  "/etc/thrallo",
  "/home/ubuntu/thrallo-deploy-evidence",
  "/home/ubuntu/thrallo-restore-evidence",
  "/home/ubuntu/thrallo-backups",
  "/home/ubuntu/.bash_history",
  "/tmp",
  "/var/tmp",
  "/var/log",
];
const skipNames = new Set(["node_modules", ".git"]);
const matches = [];
const errors = [];
let filesScanned = 0;
let bytesScanned = 0;

function scanFile(file) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { errors.push({ file, code: error.code }); return; }
  if (!stat.isFile() || stat.isSymbolicLink()) return;
  if (stat.size > 128 * 1024 * 1024) {
    errors.push({ file, code: "SIZE_LIMIT", bytes: stat.size });
    return;
  }
  try {
    const content = fs.readFileSync(file);
    filesScanned += 1;
    bytesScanned += content.length;
    if (content.includes(secret)) matches.push({ file, approved: approved.has(file), bytes: stat.size });
  } catch (error) {
    errors.push({ file, code: error.code });
  }
}

function walk(target) {
  let stat;
  try { stat = fs.lstatSync(target); } catch (error) { errors.push({ file: target, code: error.code }); return; }
  if (stat.isSymbolicLink()) return;
  if (stat.isFile()) return scanFile(target);
  if (!stat.isDirectory()) return;
  let entries;
  try { entries = fs.readdirSync(target, { withFileTypes: true }); } catch (error) {
    errors.push({ file: target, code: error.code }); return;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && skipNames.has(entry.name)) continue;
    walk(path.join(target, entry.name));
  }
}

for (const root of roots) if (fs.existsSync(root)) walk(root);

const processMatches = [];
for (const entry of fs.readdirSync("/proc", { withFileTypes: true })) {
  if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
  const environ = `/proc/${entry.name}/environ`;
  try {
    if (fs.readFileSync(environ).includes(secret)) {
      const comm = fs.readFileSync(`/proc/${entry.name}/comm`, "utf8").trim();
      processMatches.push({ pid: Number(entry.name), comm });
    }
  } catch {}
}

const journal = spawnSync("journalctl", ["--all", "--since", "2026-08-08 00:00:00 UTC", "--output", "cat"], {
  encoding: null,
  maxBuffer: 256 * 1024 * 1024,
});
const journalMatches = journal.stdout?.includes(secret) ? 1 : 0;

console.log(JSON.stringify({
  credential: {
    type: "secret",
    format: "sb_secret",
    sha256: sha256(shellKey),
    bytes: secret.length,
    storesEqual: true,
  },
  approvedStores: [...approved],
  scan: { roots, filesScanned, bytesScanned, matches, errors },
  processes: processMatches,
  journal: { since: "2026-08-08T00:00:00Z", matches: journalMatches, status: journal.status },
}));
