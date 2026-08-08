import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { loadEnv } from "../shell/server/lib/env.mjs";
import { listBucketObjects } from "./backup-thrallo.mjs";
import {
  buildAccountErasureManifest, eraseAccountPermanently, eraseProjectPermanently,
} from "../shell/server/lib/erasureService.mjs";

loadEnv();
if (process.env.PACKAGE12_PROOF !== "1") throw new Error("set PACKAGE12_PROOF=1 for disposable/test-owner proof");
const url = process.env.SUPABASE_URL; const key = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;
if (!url || !key || !anonKey) throw new Error("Supabase URL, service and anon keys are required");
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const anon = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
const uuid = () => crypto.randomUUID(); const hash = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const OWNER = uuid(); const OTHER_OWNER = uuid(); const PROJECT = uuid(); const OTHER_PROJECT = uuid(); const CROSS_PROJECT = uuid();
const APP_USER = uuid(); const JOB = uuid(); const PAYLOAD = uuid(); const SNAPSHOT = uuid(); const OTHER_SNAPSHOT = uuid(); const CROSS_SNAPSHOT = uuid();
const CONTENT = "package-12-erasure-proof"; const CONTENT_HASH = hash(CONTENT);
const BUCKET = process.env.CODE_AGENT_ARTIFACT_BUCKET || "thrallo-artifacts";
const targetBlobPath = `package12/${OWNER}/${CONTENT_HASH}`; const otherBlobPath = `package12/${OTHER_OWNER}/${CONTENT_HASH}`;
const sharedAssetPath = `package12/${OWNER}/shared-asset.bin`;
const temp = await mkdtemp(path.join(os.tmpdir(), "thrallo-package12-"));

// Exact parity is required for every production table the bounded erasure RPCs can mutate.
// Repository-index and agent-run tables are intentionally absent: neither erasure RPC can touch
// them, and pulling their source payloads through PostgREST makes this safety proof itself an
// unbounded production query.
const PARITY_TABLES = Object.freeze([
  "ai_requests", "analytics_daily", "analytics_events", "app_auth_events",
  "app_notifications", "app_password_resets", "app_users", "build_checkpoints",
  "build_jobs", "build_signals", "build_work_events", "build_work_jobs",
  "build_work_payloads", "build_work_results", "bv2_assets", "bv2_blobs",
  "bv2_builds", "bv2_contracts", "bv2_dependency_edges", "bv2_file_revisions",
  "bv2_migration_state", "bv2_model_reservations", "bv2_patches",
  "bv2_project_knowledge", "bv2_project_pointers", "bv2_retrieval_traces",
  "bv2_shadow_checks", "bv2_shadow_run_files", "bv2_shadow_runs",
  "bv2_snapshot_files", "bv2_snapshots", "bv2_symbol_refs", "bv2_symbols",
  "bv2_verification_cache", "ca_github_webhook_deliveries", "custom_domains",
  "deployments", "diag_incidents", "diag_prefs", "diag_runs", "diag_steps",
  "entities", "health_checks", "health_status", "project_logs", "projects",
  "publish_activation_intents", "publish_releases", "published_sites",
]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]),
  );
  return value;
}
function canonicalRows(rows) { return rows.map((row) => JSON.stringify(stable(row))).sort().join("\n"); }
async function unwrap(promise, label) { const { data, error } = await promise; if (error) throw new Error(`${label}: ${error.message}`); return data; }
async function snapshot() {
  const output = {};
  for (const table of PARITY_TABLES) {
    const rows = []; for (let from = 0; ; from += 1000) {
      const data = await unwrap(db.from(table).select("*").order("id", { ascending: true, nullsFirst: true }).range(from, from + 999), table)
        .catch(async () => unwrap(db.from(table).select("*").range(from, from + 999), table));
      rows.push(...(data || [])); if (!data?.length || data.length < 1000) break;
    }
    output[table] = hash(canonicalRows(rows));
  }
  output.storage = hash((await listBucketObjects(db, BUCKET)).sort().join("\n"));
  return output;
}
async function createUser(id, email) { await unwrap(db.auth.admin.createUser({ id, email, password: `${uuid()}Aa!9`, email_confirm: true }), `auth ${id}`); }
async function storagePut(object, bytes) { await unwrap(db.storage.from(BUCKET).upload(object, Buffer.from(bytes), { upsert: false }), `storage ${object}`); }

const before = await snapshot(); const checks = [];
try {
  await createUser(OWNER, `package12-${OWNER}@example.invalid`);
  await createUser(OTHER_OWNER, `package12-${OTHER_OWNER}@example.invalid`);
  await createUser(APP_USER, `package12-app-${APP_USER}@example.invalid`);
  await unwrap(db.from("projects").insert([
    { id: PROJECT, owner: OWNER, name: "Package 12 erasure target", tree: {} },
    { id: OTHER_PROJECT, owner: OWNER, name: "Package 12 same-owner survivor", tree: {} },
    { id: CROSS_PROJECT, owner: OTHER_OWNER, name: "Package 12 cross-owner survivor", tree: {} },
  ]), "projects");
  await unwrap(db.from("entities").insert({ owner: OWNER, app_id: PROJECT, type: "proof", data: { value: true } }), "entity");
  await unwrap(db.from("app_users").insert({ app_id: PROJECT, email: `package12-app-${APP_USER}@example.invalid`, auth_user_id: APP_USER }), "app user");
  await unwrap(db.from("project_logs").insert({ owner: OWNER, project_id: PROJECT, source: "system", message: "erasure proof" }), "log");
  await unwrap(db.from("build_work_payloads").insert({ id: PAYLOAD, owner: OWNER, project_id: PROJECT, job_type: "proof_slow",
    payload: { proof: true }, payload_sha256: hash(JSON.stringify({ proof: true })), byte_size: Buffer.byteLength(JSON.stringify({ proof: true })) }), "payload");
  await unwrap(db.from("build_work_jobs").insert({ id: JOB, owner: OWNER, project_id: PROJECT, job_type: "proof_slow",
    payload_ref: PAYLOAD, idempotency_key: `package12:${PROJECT}` }), "worker job");
  await unwrap(db.from("build_work_events").insert({ job_id: JOB, owner: OWNER, project_id: PROJECT, event_type: "queued" }), "worker event");
  for (const row of [
    { owner: OWNER, content_hash: CONTENT_HASH, content: null, storage_path: targetBlobPath, size_bytes: CONTENT.length },
    { owner: OTHER_OWNER, content_hash: CONTENT_HASH, content: null, storage_path: otherBlobPath, size_bytes: CONTENT.length },
  ]) await unwrap(db.from("bv2_blobs").insert(row), "blob");
  await unwrap(db.from("bv2_snapshots").insert([
    { id: SNAPSHOT, owner: OWNER, project_id: PROJECT, tree_hash: hash(`tree:${PROJECT}`), reason: "proof", file_count: 1, total_tokens: 1, state: "ready" },
    { id: OTHER_SNAPSHOT, owner: OWNER, project_id: OTHER_PROJECT, tree_hash: hash(`tree:${OTHER_PROJECT}`), reason: "proof", file_count: 0, total_tokens: 0, state: "ready" },
    { id: CROSS_SNAPSHOT, owner: OTHER_OWNER, project_id: CROSS_PROJECT, tree_hash: hash(`tree:${CROSS_PROJECT}`), reason: "proof", file_count: 1, total_tokens: 1, state: "ready" },
  ]), "snapshots");
  await unwrap(db.from("bv2_snapshot_files").insert([
    { snapshot_id: SNAPSHOT, path: "src/App.jsx", content_hash: CONTENT_HASH },
    { snapshot_id: CROSS_SNAPSHOT, path: "src/App.jsx", content_hash: CONTENT_HASH },
  ]), "snapshot files");
  await unwrap(db.from("bv2_assets").insert([
    { owner: OWNER, project_id: PROJECT, provider: "proof", provider_asset_id: "target", original_url: "https://example.invalid/a", storage_path: sharedAssetPath, slot: "hero" },
    { owner: OWNER, project_id: OTHER_PROJECT, provider: "proof", provider_asset_id: "survivor", original_url: "https://example.invalid/a", storage_path: sharedAssetPath, slot: "hero" },
  ]), "assets");
  await storagePut(targetBlobPath, CONTENT); await storagePut(otherBlobPath, CONTENT); await storagePut(sharedAssetPath, "shared");
  await mkdir(path.join(temp, "worker", JOB), { recursive: true }); await writeFile(path.join(temp, "worker", JOB, "result.json"), "{}");

  const limited = await Promise.all(Array.from({ length: 10 }, () => db.rpc("consume_http_rate_limit", {
    p_key_hash: hash("package12-rate"), p_route_class: "package12", p_limit: 3, p_window_seconds: 60,
  })));
  assert.equal(limited.filter((result) => result.data?.[0]?.allowed).length, 3); checks.push("atomic shared rate limit");
  assert.ok((await anon.rpc("consume_http_rate_limit", { p_key_hash: hash("anon"), p_route_class: "package12", p_limit: 1, p_window_seconds: 60 })).error);
  checks.push("browser rate RPC denied");

  const wrongOwner = await db.rpc("erase_project_runtime_rows", { p_owner: OWNER, p_project: CROSS_PROJECT });
  assert.ok(wrongOwner.error); checks.push("cross-owner erasure rejected");
  const result = await eraseProjectPermanently(OWNER, PROJECT, { client: db, workerRoot: path.join(temp, "worker"), qaRoot: path.join(temp, "qa") });
  assert.equal((await db.from("projects").select("id").eq("id", PROJECT)).data.length, 0);
  assert.equal((await db.from("bv2_blobs").select("content_hash").eq("owner", OWNER).eq("content_hash", CONTENT_HASH)).data.length, 0);
  assert.equal((await db.from("bv2_blobs").select("content_hash").eq("owner", OTHER_OWNER).eq("content_hash", CONTENT_HASH)).data.length, 1);
  assert.ok((await db.storage.from(BUCKET).download(targetBlobPath)).error);
  assert.equal((await db.storage.from(BUCKET).download(otherBlobPath)).error, null);
  assert.equal((await db.storage.from(BUCKET).download(sharedAssetPath)).error, null);
  assert.ok((await db.auth.admin.getUserById(APP_USER)).error);
  const replay = await eraseProjectPermanently(OWNER, PROJECT, { client: db, workerRoot: path.join(temp, "worker"), qaRoot: path.join(temp, "qa") });
  assert.equal(replay.replay, true); checks.push("cross-store erasure and idempotent replay");

  await unwrap(db.from("diag_prefs").insert({ owner: OWNER, retention_days: 7 }), "diagnostic preferences");
  await unwrap(db.from("ai_requests").insert({ id: uuid(), owner: OWNER, provider: "proof", project_id: OTHER_PROJECT }), "account AI request");
  const accountManifest = await buildAccountErasureManifest(OWNER, { client: db });
  const accountResult = await eraseAccountPermanently(OWNER, { client: db,
    approvedManifestSha256: accountManifest.manifestSha256,
    workerRoot: path.join(temp, "worker"), qaRoot: path.join(temp, "qa") });
  assert.equal((await db.from("projects").select("id").eq("owner", OWNER)).data.length, 0);
  assert.equal((await db.from("diag_prefs").select("owner").eq("owner", OWNER)).data.length, 0);
  assert.equal((await db.from("ai_requests").select("id").eq("owner", OWNER)).data.length, 0);
  assert.ok((await db.auth.admin.getUserById(OWNER)).error);
  const accountReplay = await eraseAccountPermanently(OWNER, { client: db,
    approvedManifestSha256: accountManifest.manifestSha256,
    workerRoot: path.join(temp, "worker"), qaRoot: path.join(temp, "qa") });
  assert.equal(accountReplay.replay, true); checks.push("account erasure and idempotent replay");

  await eraseProjectPermanently(OTHER_OWNER, CROSS_PROJECT, { client: db, workerRoot: path.join(temp, "worker"), qaRoot: path.join(temp, "qa") });
  await db.auth.admin.deleteUser(OTHER_OWNER);
  const after = await snapshot(); assert.deepEqual(after, before); checks.push("unaffected canonical hashes exact");
  console.log(JSON.stringify({ ok: true, checks, erasureJob: result.jobId, accountErasureJob: accountResult.jobId,
    manifestSha256: result.manifestSha256, accountManifestSha256: accountManifest.manifestSha256 }));
} finally {
  await db.from("http_rate_limit_buckets").delete().in("key_hash", [hash("package12-rate"), hash("anon")]);
  for (const object of [targetBlobPath, otherBlobPath, sharedAssetPath]) await db.storage.from(BUCKET).remove([object]).catch(() => {});
  for (const project of [PROJECT, OTHER_PROJECT, CROSS_PROJECT]) await db.from("projects").delete().eq("id", project);
  for (const user of [APP_USER, OWNER, OTHER_OWNER]) await db.auth.admin.deleteUser(user).catch(() => {});
  await rm(temp, { recursive: true, force: true });
}
