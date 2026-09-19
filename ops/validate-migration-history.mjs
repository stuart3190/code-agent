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
const overlayTexts = [];
for (const date of evidenceDates) {
  manifestText = await readFile(path.join(evidenceRoot, date, "authoritative-history-manifest.json"), "utf8").catch(() => null);
  if (manifestText) break;
}
if (!manifestText) throw new Error("authoritative migration manifest is missing");
const manifest = JSON.parse(manifestText);
for (const date of [...evidenceDates].reverse()) {
  const overlayText = await readFile(path.join(evidenceRoot, date, "applied-history-overlay.json"), "utf8").catch(() => null);
  if (overlayText) overlayTexts.push(overlayText);
}
const overlays = overlayTexts.map((text) => JSON.parse(text));

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
const applied = new Map(authoritative);
// A migration pushed to production is recorded under the version the push assigned, which is not
// always the version in the authored filename. The identity checks below stay anchored to the local
// file; appliedVersion carries the ledger value so the difference is reported rather than lost.
const versionDrift = [];
let expectedOrder = manifest.migrations.length + 1;
for (const migration of overlays.flatMap((overlay) => overlay.migrations || [])) {
  const version = String(migration.version);
  const local = active.find((candidate) => candidate.version === version);
  if (!local || local.name !== migration.name || local.filename !== migration.filename) {
    throw new Error(`applied overlay migration identity diverged: ${version}`);
  }
  if (migration.appliedOrder !== expectedOrder) {
    throw new Error(`applied overlay order diverged: ${version}`);
  }
  const bytes = await readFile(path.join(migrationsDir, local.filename));
  const canonical = sha256(Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n")));
  if (canonical !== migration.localCanonicalSqlSha256) {
    throw new Error(`applied overlay local SQL diverged: ${local.filename}`);
  }
  applied.set(version, migration);
  if (migration.appliedVersion && migration.appliedVersion !== version) {
    versionDrift.push({ version, appliedVersion: String(migration.appliedVersion), name: migration.name });
  }
  expectedOrder += 1;
}
const pending = active.filter((migration) => !applied.has(migration.version));
if (pending.some((migration) => migration.version <= lastApplied)) {
  throw new Error("a local-only migration was inserted into authoritative production history");
}

console.log(JSON.stringify({
  authoritativeBase: manifest.migrations.length,
  appliedOverlay: overlays.reduce((count, overlay) => count + (overlay.migrations || []).length, 0),
  effectiveApplied: applied.size,
  active: active.length,
  pending: pending.map(({ version, name }) => ({ version, name })),
  versionDrift,
  duplicates: 0,
}));

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
