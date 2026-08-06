#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const migrationsDir = path.join(root, "supabase", "migrations");
const evidenceRoot = path.join(root, "docs", "evidence", "migration-reconstruction");
const evidenceDates = (await readdir(evidenceRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
let manifestText = null;
for (const date of evidenceDates) {
  manifestText = await readFile(path.join(evidenceRoot, date, "authoritative-history-manifest.json"), "utf8").catch(() => null);
  if (manifestText) break;
}
if (!manifestText) throw new Error("authoritative migration manifest is missing");
const manifest = JSON.parse(manifestText);

const filenames = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();
const active = filenames.map((filename) => {
  const match = /^(\d{14})_([a-z0-9_]+)\.sql$/.exec(filename);
  if (!match) throw new Error(`invalid active migration filename: ${filename}`);
  return { version: match[1], name: match[2], filename };
});
const versions = new Set(active.map((migration) => migration.version));
if (versions.size !== active.length) throw new Error("active migration history has duplicate versions");

const authoritative = new Map(manifest.migrations.map((migration) => [String(migration.version), migration]));
if (authoritative.size !== manifest.migrations.length) throw new Error("authoritative manifest has duplicate versions");
for (const migration of manifest.migrations) {
  const local = active.find((candidate) => candidate.version === String(migration.version));
  if (!local || local.name !== migration.name || local.filename !== migration.filename) {
    throw new Error(`authoritative migration identity diverged: ${migration.version}`);
  }
  const bytes = await readFile(path.join(migrationsDir, local.filename));
  const raw = sha256(bytes);
  const canonical = sha256(Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n")));
  if (raw !== migration.sqlSha256 || canonical !== (migration.canonicalSqlSha256 || migration.sqlSha256)) {
    throw new Error(`authoritative migration SQL diverged: ${local.filename}`);
  }
}

const lastApplied = String(manifest.migrations.at(-1).version);
const pending = active.filter((migration) => !authoritative.has(migration.version));
if (pending.some((migration) => migration.version <= lastApplied)) {
  throw new Error("a local-only migration was inserted into authoritative production history");
}

console.log(JSON.stringify({
  authoritative: manifest.migrations.length,
  active: active.length,
  pending: pending.map(({ version, name }) => ({ version, name })),
  duplicates: 0,
}));

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
