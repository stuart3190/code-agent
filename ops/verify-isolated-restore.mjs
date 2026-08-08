#!/usr/bin/env node

import { createHash, createHmac } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { ARTIFACT_BUCKET, CA_TABLES } from "./backup-thrallo.mjs";
import { validateBackupDirectory } from "../scripts/lib/backupValidation.mjs";
import {
  canonicalRowsForRestoreComparison,
  backupTablesToVerify,
  validateGeneratedProjectIds,
  validateRuntimeBackupLinks,
} from "./lib/runtimeBackupSchema.mjs";

const backupDir = path.resolve(process.argv[2] || "");
const url = process.env.RESTORE_TARGET_URL;
const serviceKey = process.env.RESTORE_TARGET_SERVICE_KEY;
const anonKey = process.env.RESTORE_TARGET_ANON_KEY;
const jwtSecret = process.env.RESTORE_TARGET_JWT_SECRET;
const filesystemRoot = process.env.RESTORE_TARGET_FILESYSTEM_ROOT;
if (!process.argv[2] || !url || !serviceKey || !anonKey || !jwtSecret || !filesystemRoot) {
  throw new Error("backup path and isolated restore URL/service/anon/JWT/filesystem environment are required");
}
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw new Error("restore proof refuses a non-loopback target");

const svc = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const validatedBackup = await validateBackupDirectory(backupDir);

async function loadRows(name) {
  return JSON.parse(gunzipSync(await readFile(path.join(backupDir, `${name}.json.gz`))).toString("utf8"));
}

async function loadOptionalRows(name) {
  if (!(await stat(path.join(backupDir, `${name}.json.gz`)).catch(() => null))?.isFile()) return [];
  return loadRows(name);
}

async function fetchAll(table) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await svc.from(table).select("*").range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < 1000) return rows;
  }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  }
  return value;
}

function rowsHash(rows) {
  const canonical = rows.map((row) => JSON.stringify(stable(row))).sort().join("\n");
  return sha256(Buffer.from(canonical));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

let tableRows = 0;
const restoredTables = {};
for (const table of backupTablesToVerify(CA_TABLES, validatedBackup.tables)) {
  const source = await loadRows(table);
  const restored = await fetchAll(table);
  const generatedProblems = validateGeneratedProjectIds(table, restored);
  if (generatedProblems.length) throw new Error(generatedProblems.join("; "));
  const canonicalSource = canonicalRowsForRestoreComparison(table, source);
  const canonicalRestored = canonicalRowsForRestoreComparison(table, restored);
  if (source.length !== restored.length || rowsHash(canonicalSource) !== rowsHash(canonicalRestored)) {
    throw new Error(`${table}: restored rows differ from backup`);
  }
  restoredTables[table] = restored;
  tableRows += source.length;
}
const runtimeLinkProblems = validateRuntimeBackupLinks(restoredTables);
if (runtimeLinkProblems.length) throw new Error(`runtime restore links are invalid: ${runtimeLinkProblems.join("; ")}`);

const sourceUsers = (await loadRows("auth_users")).map(projectAuthUser);
const targetUsers = [];
for (let page = 1; ; page += 1) {
  const { data, error } = await svc.auth.admin.listUsers({ page, perPage: 1000 });
  if (error) throw new Error(`auth users: ${error.message}`);
  targetUsers.push(...(data?.users || []).map(projectAuthUser));
  if (!data?.users || data.users.length < 1000) break;
}
if (rowsHash(sourceUsers) !== rowsHash(targetUsers)) throw new Error("restored auth ownership identities differ from backup");

const storageObjects = await loadRows("storage_objects");
for (const object of storageObjects) {
  const { data, error } = await svc.storage.from(ARTIFACT_BUCKET).download(object.key);
  if (error) throw new Error(`storage ${object.key}: ${error.message}`);
  const bytes = Buffer.from(await data.arrayBuffer());
  if (bytes.length !== object.bytes || sha256(bytes) !== object.sha256) throw new Error(`storage object differs: ${object.key}`);
}

const filesystemObjects = await loadRows("filesystem_objects");
for (const object of filesystemObjects) {
  const targetRoot = path.resolve(filesystemRoot, object.root);
  const target = path.resolve(targetRoot, object.relativePath);
  if (target !== targetRoot && !target.startsWith(`${targetRoot}${path.sep}`)) throw new Error(`filesystem path escapes root: ${object.relativePath}`);
  const bytes = await readFile(target);
  const metadata = await stat(target);
  if (bytes.length !== object.bytes || sha256(bytes) !== object.sha256 || (metadata.mode & 0o777) !== object.mode) {
    throw new Error(`filesystem object differs: ${object.root}/${object.relativePath}`);
  }
}
const filesystemDirectories = await loadOptionalRows("filesystem_directories");
for (const directory of filesystemDirectories) {
  const targetRoot = path.resolve(filesystemRoot, directory.root);
  const target = directory.relativePath === "." ? targetRoot : path.resolve(targetRoot, directory.relativePath);
  if (target !== targetRoot && !target.startsWith(`${targetRoot}${path.sep}`)) throw new Error(`filesystem directory path escapes root: ${directory.relativePath}`);
  const metadata = await stat(target);
  if (!metadata.isDirectory() || (metadata.mode & 0o777) !== directory.mode) {
    throw new Error(`filesystem directory differs: ${directory.root}/${directory.relativePath}`);
  }
}

const blobs = await loadRows("bv2_blobs");
const blobContent = new Map();
for (const blob of blobs) {
  let content;
  if (blob.content !== null) content = String(blob.content);
  else {
    const { data, error } = await svc.storage.from(ARTIFACT_BUCKET).download(blob.storage_path);
    if (error) throw new Error(`blob storage ${blob.storage_path}: ${error.message}`);
    content = await data.text();
  }
  if (Buffer.byteLength(content, "utf8") !== blob.size_bytes || sha256(Buffer.from(content)) !== blob.content_hash) {
    throw new Error("restored blob bytes do not match declared hash");
  }
  blobContent.set(`${blob.owner}:${blob.content_hash}`, content);
}

const snapshots = await loadRows("bv2_snapshots");
const snapshotFiles = await loadRows("bv2_snapshot_files");
const snapshotById = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
for (const snapshot of snapshots) {
  const files = snapshotFiles.filter((file) => file.snapshot_id === snapshot.id);
  if (files.length !== snapshot.file_count) throw new Error("snapshot file count differs from manifest");
  const pairs = [];
  for (const file of files) {
    const content = blobContent.get(`${snapshot.owner}:${file.content_hash}`);
    if (content === undefined || sha256(Buffer.from(content)) !== file.content_hash) throw new Error("snapshot cannot materialise from verified blobs");
    pairs.push(`${file.path} ${file.content_hash}`);
  }
  if (sha256(Buffer.from(pairs.sort().join("\n"))) !== snapshot.tree_hash) throw new Error("materialised snapshot tree hash differs");
  if (snapshot.parent_snapshot && !snapshotById.has(snapshot.parent_snapshot)) throw new Error("snapshot parent does not resolve");
}
for (const pointer of await loadRows("bv2_project_pointers")) {
  const snapshot = snapshotById.get(pointer.snapshot_id);
  if (!snapshot || snapshot.owner !== pointer.owner || snapshot.project_id !== pointer.project_id) throw new Error("snapshot pointer ownership does not resolve");
}

const caches = await loadRows("bv2_verification_cache");
for (const entry of caches) {
  if (entry.snapshot_id && !snapshotById.has(entry.snapshot_id)) throw new Error("restored verification cache points to a missing snapshot");
}

const revisions = await loadRows("bv2_file_revisions");
const symbols = await loadRows("bv2_symbols");
const symbolRefs = await loadRows("bv2_symbol_refs");
const dependencyEdges = await loadRows("bv2_dependency_edges");
const revisionById = new Map(revisions.map((revision) => [revision.id, revision]));
for (const revision of revisions) {
  const actual = {
    symbols: symbols.filter((row) => row.revision_id === revision.id).length,
    refs: symbolRefs.filter((row) => row.revision_id === revision.id).length,
    edges: dependencyEdges.filter((row) => row.revision_id === revision.id).length,
  };
  const declared = { symbols: revision.symbol_count, refs: revision.ref_count, edges: revision.edge_count };
  if (revision.state === "ready" && JSON.stringify(actual) !== JSON.stringify(declared)) {
    throw new Error("restored ready graph revision has incomplete children");
  }
}
const shadowRuns = await loadRows("bv2_shadow_runs");
const shadowRunById = new Map(shadowRuns.map((run) => [run.id, run]));
const restoredMigrationStates = await loadRows("bv2_migration_state");
for (const file of await loadRows("bv2_shadow_run_files")) {
  const run = shadowRunById.get(file.shadow_run_id);
  const revision = revisionById.get(file.revision_id);
  if (!run || !revision
    || run.owner !== file.owner || run.project_id !== file.project_id
    || revision.owner !== file.owner || revision.project_id !== file.project_id
    || revision.path !== file.path || revision.content_hash !== file.content_hash) {
    throw new Error("restored shadow manifest ownership/revision link does not resolve");
  }
}
for (const check of await loadRows("bv2_shadow_checks")) {
  const run = check.shadow_run_id ? shadowRunById.get(check.shadow_run_id) : null;
  const migrationState = check.shadow_run_id ? null : restoredMigrationStates
    .find((row) => row.owner === check.owner && row.project_id === check.project_id && row.state === "shadow");
  if ((check.shadow_run_id && (!run || run.owner !== check.owner || run.project_id !== check.project_id))
    || (!check.shadow_run_id && !migrationState)) {
    throw new Error("restored shadow check ownership does not resolve");
  }
}

const projects = await loadRows("projects");
const owners = [...new Set(projects.map((project) => project.owner))];
if (owners.length < 2) throw new Error("cross-owner proof requires at least two project owners");
for (const owner of owners.slice(0, 2)) {
  const token = signUserJwt(owner, jwtSecret);
  const userClient = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data, error } = await userClient.from("projects").select("id,owner");
  if (error && /permission denied/i.test(error.message || "")) continue;
  if (error) throw new Error(`owner-isolation query failed unexpectedly: ${error.message}`);
  const expected = projects.filter((project) => project.owner === owner).length;
  if ((data || []).length !== expected || (data || []).some((project) => project.owner !== owner)) {
    throw new Error("cross-owner project access is possible");
  }
}

console.log(JSON.stringify({
  ok: true,
  tables: CA_TABLES.length,
  tableRows,
  authUsers: sourceUsers.length,
  storageObjects: storageObjects.length,
  filesystemObjects: filesystemObjects.length,
  filesystemDirectories: filesystemDirectories.length,
  blobs: blobs.length,
  snapshots: snapshots.length,
  verificationCacheRows: caches.length,
  graphRevisions: revisions.length,
  shadowRuns: shadowRuns.length,
  modelReservations: restoredTables.bv2_model_reservations.length,
  generatedProjectIds: {
    bv2Builds: restoredTables.bv2_builds.length,
    diagnosticRuns: restoredTables.diag_runs.length,
  },
  runtimeLinks: "valid",
  crossOwnerPrincipals: 2,
}));

function projectAuthUser(user) {
  return { id: user.id, email: user.email, user_metadata: user.user_metadata || {}, app_metadata: user.app_metadata || {} };
}

function signUserJwt(owner, secret) {
  const base64url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const header = base64url({ alg: "HS256", typ: "JWT" });
  const body = base64url({ aud: "authenticated", role: "authenticated", sub: owner, iat: now - 10, exp: now + 300 });
  const signature = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}
