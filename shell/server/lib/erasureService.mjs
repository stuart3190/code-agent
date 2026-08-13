import crypto from "node:crypto";
import path from "node:path";
import { lstat, rm } from "node:fs/promises";

import { serviceClient } from "./supabase.mjs";
import { PROJECT_SCOPED_TABLES, pagedRows, purgeProjectResources } from "./projectTeardown.mjs";

const BUCKET = () => process.env.CODE_AGENT_ARTIFACT_BUCKET || "thrallo-artifacts";
const ACCOUNT_DIRECT_TABLES = Object.freeze([
  ["ai_requests", "owner"], ["build_signals", "owner"], ["diag_incidents", "owner"],
  ["diag_runs", "owner"], ["diag_prefs", "owner"], ["ca_github_webhook_deliveries", "owner"],
]);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const sha256 = (value) => crypto.createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");

// PostgREST does not promise row order without an explicit order clause. Erasure manifests are
// approvals over a set of rows, so their identity must not change merely because the database
// returned that same set in a different order between approval and execution.
export function canonicalErasureRows(values) {
  return [...(values || [])].sort((left, right) => canonical(left).localeCompare(canonical(right)));
}

function auditKey() {
  const key = process.env.THRALLO_ERASURE_AUDIT_KEY || process.env.PLATFORM_ENC_KEY;
  if (!key) throw new Error("THRALLO_ERASURE_AUDIT_KEY or PLATFORM_ENC_KEY is required for pseudonymous erasure evidence");
  return key;
}
export function erasureSubjectRef(ownerId) {
  return crypto.createHmac("sha256", auditKey()).update(String(ownerId)).digest("hex");
}

async function rows(client, table, columns, filters) {
  const result = [];
  for await (const page of pagedRows(client, table, columns, filters)) result.push(...page);
  return result;
}

function variantPaths(asset) {
  const variants = asset?.variants || {};
  return [...(variants.avif || []), ...(variants.webp || [])].map((entry) => entry?.path).filter(Boolean);
}

async function projectStorageManifest(client, ownerId, projectId) {
  const allAssets = await rows(client, "bv2_assets", "id,project_id,storage_path,variants", { owner: ownerId });
  const targetAssets = allAssets.filter((row) => String(row.project_id) === String(projectId));
  const sharedAssetPaths = new Set(allAssets.filter((row) => String(row.project_id) !== String(projectId))
    .flatMap((row) => [row.storage_path, ...variantPaths(row)]).filter(Boolean));
  const assetPaths = targetAssets.flatMap((row) => [row.storage_path, ...variantPaths(row)])
    .filter((assetPath) => assetPath && !sharedAssetPaths.has(assetPath));

  const ownerSnapshots = await rows(client, "bv2_snapshots", "id,project_id", { owner: ownerId });
  const ownerSnapshotIds = new Set(ownerSnapshots.map((row) => row.id));
  const targetSnapshotIds = new Set(ownerSnapshots.filter((row) => String(row.project_id) === String(projectId)).map((row) => row.id));
  let targetFiles = [];
  if (targetSnapshotIds.size) {
    const allFiles = await rows(client, "bv2_snapshot_files", "snapshot_id,content_hash", {});
    const targetHashes = new Set(allFiles.filter((row) => targetSnapshotIds.has(row.snapshot_id)).map((row) => row.content_hash));
    const sharedHashes = new Set(allFiles.filter((row) => ownerSnapshotIds.has(row.snapshot_id)
      && !targetSnapshotIds.has(row.snapshot_id)
      && targetHashes.has(row.content_hash)).map((row) => row.content_hash));
    targetFiles = [...targetHashes].filter((hash) => !sharedHashes.has(hash));
  }
  const blobRows = targetFiles.length
    ? await client.from("bv2_blobs").select("content_hash,storage_path,size_bytes").eq("owner", ownerId).in("content_hash", targetFiles)
      .then(({ data, error }) => { if (error) throw new Error(`blob manifest: ${error.message}`); return data || []; })
    : [];
  return {
    objectPaths: [...new Set([...assetPaths, ...blobRows.map((row) => row.storage_path).filter(Boolean)])].sort(),
    exclusiveBlobHashes: blobRows.map((row) => row.content_hash).sort(),
    bytes: blobRows.reduce((sum, row) => sum + Number(row.size_bytes || 0), 0),
  };
}

export async function buildProjectErasureManifest(ownerId, projectId, { client = serviceClient() } = {}) {
  const database = {};
  for (const { table, column, ownerScoped } of PROJECT_SCOPED_TABLES) {
    const filters = { [column]: String(projectId), ...(ownerScoped ? { owner: ownerId } : {}) };
    const found = await rows(client, table, "*", filters);
    database[table] = { count: found.length, rowsSha256: sha256(canonicalErasureRows(found)) };
  }
  const appUsers = await rows(client, "app_users", "auth_user_id", { app_id: String(projectId) });
  const workJobs = await rows(client, "build_work_jobs", "id", { owner: ownerId, project_id: String(projectId) });
  const qaRuns = await rows(client, "qa_runs", "id", { owner: ownerId, project_id: String(projectId) });
  const storage = await projectStorageManifest(client, ownerId, projectId);
  const manifest = {
    version: 1, scope: "project", subjectRef: erasureSubjectRef(ownerId), projectId: String(projectId),
    database, appAuthUserIds: appUsers.map((row) => row.auth_user_id).sort(),
    workerJobIds: workJobs.map((row) => row.id).sort(), qaRunIds: qaRuns.map((row) => row.id).sort(), storage,
  };
  return { ...manifest, manifestSha256: sha256(manifest) };
}

export async function buildAccountErasureManifest(ownerId, { client = serviceClient() } = {}) {
  const projects = await rows(client, "projects", "id", { owner: ownerId });
  const direct = {};
  for (const [table, column] of ACCOUNT_DIRECT_TABLES) {
    const found = await rows(client, table, "*", { [column]: ownerId });
    direct[table] = { count: found.length, rowsSha256: sha256(canonicalErasureRows(found)) };
  }
  const artifacts = await rows(client, "ca_artifacts", "storage_key", { owner: ownerId });
  const candidateKeys = [...new Set(artifacts.map((row) => row.storage_key).filter(Boolean))];
  const sharedKeys = new Set();
  if (candidateKeys.length) {
    const { data, error } = await client.from("ca_artifacts").select("owner,storage_key").in("storage_key", candidateKeys);
    if (error) throw new Error(`account artifact sharing check: ${error.message}`);
    for (const row of data || []) if (row.owner !== ownerId) sharedKeys.add(row.storage_key);
  }
  const manifest = {
    version: 1,
    scope: "account",
    subjectRef: erasureSubjectRef(ownerId),
    projectIds: projects.map((row) => row.id).sort(),
    direct,
    storageObjectPaths: candidateKeys.filter((key) => !sharedKeys.has(key)).sort(),
  };
  return { ...manifest, manifestSha256: sha256(manifest) };
}

function inside(root, segment) {
  const base = path.resolve(root); const target = path.resolve(base, String(segment));
  if (target === base || !target.startsWith(`${base}${path.sep}`)) throw new Error("erasure artifact path escapes its canonical root");
  return target;
}

export async function removeCanonicalDirectories(root, ids) {
  let removed = 0;
  for (const id of ids) {
    const target = inside(root, id); const info = await lstat(target).catch(() => null);
    if (!info) continue;
    if (info.isSymbolicLink()) throw new Error(`erasure refuses unexpected artifact symlink: ${id}`);
    await rm(target, { recursive: true, force: false });
    if (await lstat(target).catch(() => null)) throw new Error(`artifact directory survived erasure: ${id}`);
    removed += 1;
  }
  return removed;
}

async function removeStorageObjects(client, objectPaths) {
  if (!objectPaths.length) return 0;
  for (let from = 0; from < objectPaths.length; from += 100) {
    const batch = objectPaths.slice(from, from + 100);
    const { error } = await client.storage.from(BUCKET()).remove(batch);
    if (error) throw new Error(`erasure storage removal: ${error.message}`);
    for (const object of batch) {
      const { error: probeError } = await client.storage.from(BUCKET()).download(object);
      if (!probeError) throw new Error(`storage object survived erasure: ${sha256(object)}`);
      const missing = Number(probeError.statusCode || probeError.status) === 404
        || /(?:object\s+)?not found|does not exist/i.test(String(probeError.message || ""));
      if (!missing) throw new Error(`storage deletion verification failed: ${probeError.message || "unknown storage error"}`);
    }
  }
  return objectPaths.length;
}

async function event(client, jobId, eventType, values = {}) {
  const { error } = await client.from("data_erasure_events").insert({ job_id: jobId, event_type: eventType, ...values });
  if (error) throw new Error(`erasure audit event: ${error.message}`);
}

async function createJob(client, ownerId, projectId, manifest) {
  const { data: prior, error: priorError } = await client.from("data_erasure_jobs")
    .select("id,status,manifest_sha256,attempt_count,deleted_counts,storage_counts")
    .eq("scope", "project").eq("subject_ref", manifest.subjectRef).eq("project_id", projectId)
    .neq("status", "succeeded")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (priorError) throw new Error(`erasure job lookup: ${priorError.message}`);
  // A successful job is handled before a new live manifest is built. If the UUID was ever
  // deliberately reused for a new project, this query excludes the old completed job.
  if (prior && prior.manifest_sha256 !== manifest.manifestSha256) {
    throw Object.assign(new Error("blocked erasure manifest changed; refusing retry"), { code: "erasure_manifest_changed" });
  }
  if (prior?.status === "executing") {
    throw Object.assign(new Error("erasure is already executing"), { code: "erasure_in_progress" });
  }
  if (prior) return { ...prior, replay: false };
  const counts = Object.fromEntries(Object.entries(manifest.database).map(([table, value]) => [table, value.count]));
  const { data, error } = await client.from("data_erasure_jobs").insert({
    scope: "project", subject_ref: manifest.subjectRef, owner_id: ownerId, project_id: projectId,
    manifest_sha256: manifest.manifestSha256, manifest_counts: counts,
  }).select("id").single();
  if (error) throw new Error(`erasure job creation: ${error.message}`);
  await event(client, data.id, "planned", { item_count: Object.values(counts).reduce((sum, value) => sum + value, 0), reference_hash: manifest.manifestSha256 });
  return { id: data.id, status: "planned", attempt_count: 0, replay: false };
}

async function completedProjectJob(client, ownerId, projectId) {
  const { data: project, error: projectError } = await client.from("projects")
    .select("id").eq("id", projectId).eq("owner", ownerId).maybeSingle();
  if (projectError) throw new Error(`erasure project replay check: ${projectError.message}`);
  if (project) return null;
  const { data, error } = await client.from("data_erasure_jobs")
    .select("id,status,manifest_sha256,deleted_counts,storage_counts")
    .eq("scope", "project").eq("subject_ref", erasureSubjectRef(ownerId)).eq("project_id", projectId)
    .eq("status", "succeeded").order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(`erasure replay lookup: ${error.message}`);
  return data || null;
}

async function updateJob(client, id, values) {
  const { error } = await client.from("data_erasure_jobs").update(values).eq("id", id);
  if (error) throw new Error(`erasure job update: ${error.message}`);
}

export async function eraseProjectPermanently(ownerId, projectId, {
  client = serviceClient(), provisiond = null, approvedManifestSha256 = null,
  workerRoot = process.env.THRALLO_BUILD_ARTIFACT_ROOT || "/var/lib/thrallo-build-worker",
  qaRoot = process.env.QA_ARTIFACT_DIR || "/var/lib/thrallo-qa",
} = {}) {
  const completed = await completedProjectJob(client, ownerId, projectId);
  if (completed) {
    if (approvedManifestSha256 && approvedManifestSha256 !== completed.manifest_sha256) {
      throw Object.assign(new Error("completed erasure manifest does not match approval"), { code: "erasure_manifest_changed" });
    }
    return { jobId: completed.id, manifestSha256: completed.manifest_sha256,
      deletedCounts: completed.deleted_counts, storage: completed.storage_counts, replay: true };
  }
  const manifest = await buildProjectErasureManifest(ownerId, projectId, { client });
  if (approvedManifestSha256 && manifest.manifestSha256 !== approvedManifestSha256) {
    throw Object.assign(new Error("erasure manifest changed; refusing destructive work"), { code: "erasure_manifest_changed" });
  }
  const job = await createJob(client, ownerId, projectId, manifest);
  if (job.replay) {
    return { jobId: job.id, manifestSha256: job.manifest_sha256, deletedCounts: job.deleted_counts,
      storage: job.storage_counts, replay: true };
  }
  const jobId = job.id;
  const startedAt = new Date().toISOString();
  await updateJob(client, jobId, { status: "executing", started_at: startedAt, updated_at: startedAt,
    attempt_count: Number(job.attempt_count || 0) + 1, last_error_code: null });
  await event(client, jobId, "attempt_started", { reference_hash: manifest.manifestSha256 });
  try {
    const storageObjects = await removeStorageObjects(client, manifest.storage.objectPaths);
    const workerDirs = await removeCanonicalDirectories(workerRoot, manifest.workerJobIds);
    const qaDirs = await removeCanonicalDirectories(qaRoot, manifest.qaRunIds);
    await event(client, jobId, "store_verified", { store: "external", item_count: storageObjects + workerDirs + qaDirs,
      byte_count: manifest.storage.bytes, details: { storageObjects, workerDirs, qaDirs } });

    const report = await purgeProjectResources(ownerId, projectId, {
      client, provisiond, strictExternal: true, atomicDatabase: true,
    });
    const after = await buildProjectErasureManifest(ownerId, projectId, { client });
    const survivors = Object.entries(after.database).filter(([, value]) => value.count > 0);
    if (survivors.length || after.storage.objectPaths.length) throw new Error(`erasure verification found ${survivors.length} database survivor sets`);
    const deletedCounts = Object.fromEntries(Object.entries(manifest.database).map(([table, value]) => [table, value.count]));
    await event(client, jobId, "rows_deleted", { item_count: Object.values(deletedCounts).reduce((sum, value) => sum + value, 0), details: deletedCounts });
    const finishedAt = new Date().toISOString();
    await updateJob(client, jobId, { status: "succeeded", owner_id: null, finished_at: finishedAt,
      updated_at: finishedAt, deleted_counts: deletedCounts,
      storage_counts: { storageObjects, workerDirs, qaDirs } });
    await event(client, jobId, "completed", { reference_hash: manifest.manifestSha256,
      item_count: Object.values(deletedCounts).reduce((sum, value) => sum + value, 0) });
    return { jobId, manifestSha256: manifest.manifestSha256, deletedCounts, storage: { storageObjects, workerDirs, qaDirs }, report };
  } catch (error) {
    const code = String(error.code || "erasure_failed").slice(0, 80); const at = new Date().toISOString();
    try { await updateJob(client, jobId, { status: "blocked", last_error_code: code, updated_at: at }); } catch { /* preserve original */ }
    try { await event(client, jobId, "blocked", { details: { code } }); } catch { /* preserve original */ }
    throw error;
  }
}

async function accountJob(client, ownerId, manifest) {
  const { data: active, error } = await client.from("data_erasure_jobs")
    .select("id,status,manifest_sha256,attempt_count,deleted_counts,storage_counts")
    .eq("scope", "account").eq("subject_ref", manifest.subjectRef).neq("status", "succeeded")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(`account erasure job lookup: ${error.message}`);
  if (active) return active;
  const counts = { projects: manifest.projectIds.length,
    ...Object.fromEntries(Object.entries(manifest.direct).map(([table, value]) => [table, value.count])) };
  const { data, error: insertError } = await client.from("data_erasure_jobs").insert({
    scope: "account", subject_ref: manifest.subjectRef, owner_id: ownerId,
    manifest_sha256: manifest.manifestSha256, manifest_counts: counts,
  }).select("id,status,manifest_sha256,attempt_count,deleted_counts,storage_counts").single();
  if (insertError) throw new Error(`account erasure job creation: ${insertError.message}`);
  await event(client, data.id, "planned", { reference_hash: manifest.manifestSha256,
    item_count: Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0) });
  return data;
}

export async function eraseAccountPermanently(ownerId, {
  client = serviceClient(), provisiond = null, approvedManifestSha256,
  workerRoot = process.env.THRALLO_BUILD_ARTIFACT_ROOT || "/var/lib/thrallo-build-worker",
  qaRoot = process.env.QA_ARTIFACT_DIR || "/var/lib/thrallo-qa",
} = {}) {
  if (!approvedManifestSha256) throw Object.assign(new Error("an approved account erasure manifest is required"), { code: "erasure_manifest_required" });
  const subjectRef = erasureSubjectRef(ownerId);
  const { data: completed, error: completedError } = await client.from("data_erasure_jobs")
    .select("id,status,manifest_sha256,deleted_counts,storage_counts")
    .eq("scope", "account").eq("subject_ref", subjectRef).eq("status", "succeeded")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (completedError) throw new Error(`account erasure replay lookup: ${completedError.message}`);
  if (completed) {
    if (completed.manifest_sha256 !== approvedManifestSha256) {
      throw Object.assign(new Error("completed account erasure manifest does not match approval"), { code: "erasure_manifest_changed" });
    }
    return { jobId: completed.id, manifestSha256: completed.manifest_sha256,
      deletedCounts: completed.deleted_counts, storage: completed.storage_counts, replay: true };
  }
  const manifest = await buildAccountErasureManifest(ownerId, { client });
  const job = await accountJob(client, ownerId, manifest);
  const databaseAlreadyErased = Object.keys(job.deleted_counts || {}).length > 0;
  if (job.manifest_sha256 !== approvedManifestSha256) {
    throw Object.assign(new Error("account erasure manifest changed; refusing destructive work"), { code: "erasure_manifest_changed" });
  }
  if (!databaseAlreadyErased && job.manifest_sha256 !== manifest.manifestSha256) {
    throw Object.assign(new Error("blocked account erasure manifest changed; refusing retry"), { code: "erasure_manifest_changed" });
  }
  const now = new Date().toISOString();
  await updateJob(client, job.id, { status: "executing", started_at: now, updated_at: now,
    attempt_count: Number(job.attempt_count || 0) + 1, last_error_code: null });
  await event(client, job.id, "attempt_started", { reference_hash: job.manifest_sha256 });
  try {
    let deletedCounts = job.deleted_counts || {};
    let storageCounts = job.storage_counts || {};
    if (!databaseAlreadyErased) {
      for (const projectId of manifest.projectIds) {
        const projectManifest = await buildProjectErasureManifest(ownerId, projectId, { client });
        await eraseProjectPermanently(ownerId, projectId, { client, provisiond,
          approvedManifestSha256: projectManifest.manifestSha256, workerRoot, qaRoot });
      }
      const storageObjects = await removeStorageObjects(client, manifest.storageObjectPaths);
      const { data, error } = await client.rpc("erase_account_runtime_rows", { p_owner: ownerId });
      if (error) throw new Error(`account database erasure: ${error.message}`);
      deletedCounts = { projects: manifest.projectIds.length,
        ...Object.fromEntries(Object.entries(manifest.direct).map(([table, value]) => [table, value.count])) };
      storageCounts = { storageObjects };
      await updateJob(client, job.id, { deleted_counts: deletedCounts, storage_counts: storageCounts, updated_at: new Date().toISOString() });
      await event(client, job.id, "rows_deleted", { item_count: Object.values(deletedCounts).reduce((sum, value) => sum + Number(value || 0), 0),
        details: { ...deletedCounts, rpc: data } });
    }
    const { error: authError } = await client.auth.admin.deleteUser(ownerId);
    if (authError && !/not found/i.test(authError.message || "")) throw new Error(`account Auth erasure: ${authError.message}`);
    const finishedAt = new Date().toISOString();
    await updateJob(client, job.id, { status: "succeeded", owner_id: null, finished_at: finishedAt,
      updated_at: finishedAt, deleted_counts: deletedCounts, storage_counts: storageCounts });
    await event(client, job.id, "completed", { reference_hash: job.manifest_sha256,
      item_count: Object.values(deletedCounts).reduce((sum, value) => sum + Number(value || 0), 0) });
    return { jobId: job.id, manifestSha256: job.manifest_sha256, deletedCounts, storage: storageCounts };
  } catch (error) {
    const code = String(error.code || "erasure_failed").slice(0, 80); const at = new Date().toISOString();
    try { await updateJob(client, job.id, { status: "blocked", last_error_code: code, updated_at: at }); } catch { /* preserve original */ }
    try { await event(client, job.id, "blocked", { details: { code } }); } catch { /* preserve original */ }
    throw error;
  }
}
