#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..");
const ACTIVE = path.join(ROOT, "supabase", "migrations");
const EVIDENCE = path.join(ROOT, "docs", "evidence", "migration-reconstruction", "2026-08-06");
const ARCHIVE = path.join(ROOT, "supabase", "migration-history-archive", "pre-authoritative-reconstruction-2026-08-06");

const MULTI_MIGRATION_OVERRIDES = new Map([
  ["app_notifications", [
    "app_notifications",
    "app_notifications_source_is_trusted_only",
    "app_notifications_column_grants",
  ]],
  ["allow_xai_provider", ["ai_credentials_allow_xai", "ai_preferences_allow_xai"]],
  ["analytics_logs_health_tables", [
    "thrallo_analytics_foundation",
    "health_monitoring",
    "project_logs",
    "analytics_logs_health_tables_reconcile",
  ]],
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalSql(text) {
  return String(text).replace(/\r\n/g, "\n").trim();
}

function git(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trimEnd();
}

function parseArgs(argv) {
  const mode = argv[2];
  if (!new Set(["archive", "reconstruct"]).has(mode)) {
    throw new Error("usage: node ops/reconstruct-supabase-history.mjs <archive|reconstruct>");
  }
  return { mode };
}

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) throw new Error("authoritative ledger JSON is required on stdin");
  const value = JSON.parse(raw);
  const rows = Array.isArray(value) ? value : value.rows;
  if (!Array.isArray(rows) || rows.length !== 60) {
    throw new Error(`expected exactly 60 authoritative migrations, received ${rows?.length ?? "invalid JSON"}`);
  }
  return rows;
}

function validateLedger(rows) {
  const versions = new Set();
  const filenames = new Set();
  for (const row of rows) {
    if (!/^\d{14}$/.test(row.version)) throw new Error(`unsafe migration version: ${row.version}`);
    if (!/^[a-z0-9_]+$/.test(row.name)) throw new Error(`unsafe migration name: ${row.name}`);
    const validStatements = Array.isArray(row.statements) && row.statements.every((item) => typeof item === "string");
    const validHash = /^[0-9a-f]{64}$/.test(row.sqlSha256 || "");
    if (!validStatements && !validHash) {
      throw new Error(`statements or sqlSha256 required for ${row.version}_${row.name}`);
    }
    if (versions.has(row.version)) throw new Error(`duplicate authoritative version: ${row.version}`);
    const filename = `${row.version}_${row.name}.sql`;
    if (filenames.has(filename)) throw new Error(`duplicate authoritative filename: ${filename}`);
    versions.add(row.version);
    filenames.add(filename);
  }
}

async function sqlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name).sort();
}

function migrationIdentity(filename) {
  const match = /^(\d{14})_(.+)\.sql$/.exec(filename);
  if (!match) return { version: null, name: filename.replace(/\.sql$/, "") };
  return { version: match[1], name: match[2] };
}

function authoritativeTargets(localName, byName) {
  const override = MULTI_MIGRATION_OVERRIDES.get(localName);
  if (override) return override.map((name) => byName.get(name)).filter(Boolean);
  const direct = byName.get(localName);
  return direct ? [direct] : [];
}

async function archive(rows) {
  const existingArchive = await stat(ARCHIVE).catch(() => null);
  if (existingArchive) throw new Error(`archive already exists: ${ARCHIVE}`);

  const files = await sqlFiles(ACTIVE);
  if (!files.length) throw new Error("active migration directory is empty");
  const byName = new Map(rows.map((row) => [row.name, row]));
  const baseline = {
    capturedAt: new Date().toISOString(),
    git: {
      commit: git("rev-parse", "HEAD"),
      branch: git("branch", "--show-current"),
      captureWorktreeStatus: git("status", "--porcelain=v1"),
    },
    activeDirectory: "supabase/migrations",
    archiveDirectory: path.relative(ROOT, ARCHIVE).replaceAll("\\", "/"),
    files: [],
  };

  const mappings = [];
  for (const filename of files) {
    const bytes = await readFile(path.join(ACTIVE, filename));
    const identity = migrationIdentity(filename);
    const targets = authoritativeTargets(identity.name, byName);
    const localCanonicalHash = sha256(Buffer.from(canonicalSql(bytes.toString("utf8"))));
    const targetHashes = targets.map((row) => row.sqlSha256 || sha256(Buffer.from(row.statements.join("\n"))));
    const exact = targets.length === 1 && localCanonicalHash === targetHashes[0];
    baseline.files.push({ filename, sha256: sha256(bytes), bytes: bytes.length });
    mappings.push({
      currentLocalFilename: filename,
      authoritative: targets.map((row) => ({ version: row.version, name: row.name })),
      sqlEquivalence: exact ? "canonical SQL exact" : targets.length
        ? "not text-equivalent; catalog/semantic comparison required"
        : "no authoritative ledger migration by mapped name",
      representation: targets.length === 0 ? "no production migration"
        : targets.length === 1 ? "one production migration"
          : `${targets.length} production migrations`,
      finalReconstructedFilenames: targets.map((row) => `${row.version}_${row.name}.sql`),
    });
  }

  await mkdir(ARCHIVE, { recursive: true });
  for (const filename of files) await rename(path.join(ACTIVE, filename), path.join(ARCHIVE, filename));
  await mkdir(EVIDENCE, { recursive: true });
  await writeFile(path.join(EVIDENCE, "local-history-baseline.json"), `${JSON.stringify(baseline, null, 2)}\n`);
  await writeFile(path.join(EVIDENCE, "migration-mapping.json"), `${JSON.stringify(mappings, null, 2)}\n`);

  const header = [
    "# Local-to-production migration mapping",
    "",
    `Captured from commit \`${baseline.git.commit}\`. The archive preserves every original byte;`,
    "the active history is reconstructed separately from the production ledger. A non-exact SQL",
    "classification is not automatically a schema difference: comments, formatting, or consolidated",
    "follow-up migrations can change text while producing the same final catalog.",
    "",
    "| Current local file | Authoritative production migration(s) | SQL equivalence | Representation | Final reconstructed file(s) |",
    "|---|---|---|---|---|",
  ];
  for (const row of mappings) {
    const targets = row.authoritative.length
      ? row.authoritative.map((item) => `\`${item.version}_${item.name}\``).join("<br>")
      : "None by mapped name";
    const finals = row.finalReconstructedFilenames.length
      ? row.finalReconstructedFilenames.map((item) => `\`${item}\``).join("<br>")
      : "None";
    header.push(`| \`${row.currentLocalFilename}\` | ${targets} | ${row.sqlEquivalence} | ${row.representation} | ${finals} |`);
  }
  await writeFile(path.join(EVIDENCE, "MAPPING.md"), `${header.join("\n")}\n`);
  console.log(JSON.stringify({ archived: files.length, archive: baseline.archiveDirectory, evidence: path.relative(ROOT, EVIDENCE) }));
}

async function reconstruct(rows) {
  const activeFiles = await sqlFiles(ACTIVE);
  if (activeFiles.length) throw new Error(`active migration directory is not empty (${activeFiles.length} SQL files)`);
  const archivedFiles = await sqlFiles(ARCHIVE);
  if (!archivedFiles.length) throw new Error("forensic archive is missing or empty");

  await mkdir(ACTIVE, { recursive: true });
  const manifest = [];
  for (const row of rows) {
    if (!Array.isArray(row.statements)) throw new Error(`stored SQL statements missing for ${row.version}_${row.name}`);
    const filename = `${row.version}_${row.name}.sql`;
    const content = row.statements.join("\n");
    const bytes = Buffer.from(content, "utf8");
    const expected = sha256(Buffer.from(row.statements.join("\n")));
    if (sha256(bytes) !== expected) throw new Error(`statement-order hash mismatch before write: ${filename}`);
    await writeFile(path.join(ACTIVE, filename), bytes, { flag: "wx" });
    const stored = await readFile(path.join(ACTIVE, filename));
    if (sha256(stored) !== expected) throw new Error(`post-write hash mismatch: ${filename}`);
    manifest.push({
      appliedOrder: manifest.length + 1,
      version: row.version,
      name: row.name,
      filename,
      statementCount: row.statements.length,
      sqlSha256: expected,
    });
  }
  await writeFile(path.join(EVIDENCE, "authoritative-history-manifest.json"), `${JSON.stringify({
    source: "supabase_migrations.schema_migrations on zczgvcsokfafuyognvwx",
    capturedAt: new Date().toISOString(),
    migrations: manifest,
  }, null, 2)}\n`);
  console.log(JSON.stringify({ reconstructed: manifest.length, first: manifest[0].filename, last: manifest.at(-1).filename }));
}

const { mode } = parseArgs(process.argv);
const rows = await readStdinJson();
validateLedger(rows);
if (mode === "archive") await archive(rows);
else await reconstruct(rows);
