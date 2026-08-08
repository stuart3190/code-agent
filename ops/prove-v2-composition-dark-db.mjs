#!/usr/bin/env node

// Package 10E canary recovery: production DB/runtime proof with no ingress/filesystem control.
// Every checkpoint is emitted as JSONL before the next mutation. The fixed test identities make
// preflight and cleanup independently auditable. This script never invokes a model or provider.

import assert from "node:assert/strict";
import crypto from "node:crypto";

import { buildProjectZip } from "../shell/server/lib/exportProject.mjs";
import {
  awaitBuildWork, enqueueBuildWork, getBuildWork, listBuildWorkEvents, requestBuildWorkCancel,
} from "../shell/server/lib/buildWorkQueue.mjs";
import { serviceClient } from "../shell/server/lib/supabase.mjs";
import { bindCapabilities, imageIntents, persistContract, tierContract } from "../shell/server/lib/builderV2/contractTiering.mjs";
import { compareGraphIndexes, manifestOf } from "../shell/server/lib/builderV2/graphParity.mjs";
import { memoryGraph } from "../shell/server/lib/builderV2/graphStore.mjs";
import { indexTree } from "../shell/server/lib/builderV2/indexer.mjs";
import { getKnowledge, knowledgeBrief, recordFacts } from "../shell/server/lib/builderV2/knowledge.mjs";
import { resolveVerifiedProjectTree } from "../shell/server/lib/builderV2/projectSource.mjs";
import { retrieve } from "../shell/server/lib/builderV2/retrieval.mjs";
import { prepareBuilderV2PipelineAttempt } from "../shell/server/lib/builderV2/runtimeComposition.mjs";
import { createSnapshotStore } from "../shell/server/lib/builderV2/snapshotStore.mjs";
import {
  loadIndex, persistIndex, purgeOwnerForTests, supabaseSnapshotStorage,
} from "../shell/server/lib/builderV2/supabaseTwins.mjs";

const EXPECTED_PROJECT_REF = "zczgvcsokfafuyognvwx";
if (process.env.THRALLO_PACKAGE10E_CANARY !== "1") throw new Error("THRALLO_PACKAGE10E_CANARY=1 is required");
if (process.env.THRALLO_PROCESS_ROLE !== "package10e-canary") throw new Error("isolated package10e-canary process role is required");
if (process.env.THRALLO_MANAGED_SETTLEMENT_PAUSED !== "1") throw new Error("managed settlement must remain paused");
if (process.env.THRALLO_BUILD_WORKER_ENABLED === "1") throw new Error("customer worker dispatch must remain disabled in the canary process");
if (process.env.THRALLO_ATOMIC_PUBLISH_ENABLED === "1") throw new Error("customer atomic publishing must remain disabled in the canary process");
if (!String(process.env.SUPABASE_URL || "").includes(EXPECTED_PROJECT_REF)) throw new Error("canary target is not the approved production project");

const ids = Object.freeze({
  owner: "10e00000-0000-4000-8000-000000000001",
  otherOwner: "10e00000-0000-4000-8000-000000000002",
  project: "10e10000-0000-4000-8000-000000000001",
  otherProject: "10e10000-0000-4000-8000-000000000002",
  publicBuild: "10e20000-0000-4000-8000-000000000001",
  cancelBuild: "10e20000-0000-4000-8000-000000000002",
  retryBuild: "10e20000-0000-4000-8000-000000000003",
  v2Build: "10e30000-0000-4000-8000-000000000001",
  unsafeV2Build: "10e30000-0000-4000-8000-000000000002",
  diag: "10e40000-0000-4000-8000-000000000001",
  deploymentA: "10e50000-0000-4000-8000-000000000001",
  deploymentB: "10e50000-0000-4000-8000-000000000002",
  deploymentRollback: "10e50000-0000-4000-8000-000000000003",
  releaseA: "10e60000-0000-4000-8000-000000000001",
  releaseB: "10e60000-0000-4000-8000-000000000002",
});

const TREE = Object.freeze({
  "package.json": JSON.stringify({ name: "package10e-proof", private: true, type: "module", scripts: { build: "vite build" }, dependencies: { "@vitejs/plugin-react": "latest", vite: "latest", react: "latest", "react-dom": "latest" }, devDependencies: {} }, null, 2),
  "index.html": '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>',
  "src/main.jsx": 'import React from "react"; import { createRoot } from "react-dom/client"; import App from "./App.jsx"; createRoot(document.getElementById("root")).render(<App />);',
  "src/App.jsx": 'import { listBookings } from "./data/bookings.js"; export default function App(){ return <main data-proof="verified-snapshot">Package 10E {listBookings().length}</main>; }',
  "src/data/bookings.js": 'export function listBookings(){ return []; } export function createBooking(input){ return { id: "proof", ...input }; }',
});

const CONTRACT = Object.freeze({
  summary: "A deterministic internal booking proof",
  auth: { required: false },
  routes: [{ path: "/", name: "Booking" }],
  entities: [{ name: "booking", fields: [{ name: "slot", type: "string" }] }],
  operations: [{ id: "create-booking", description: "Create a booking" }],
  journeys: [{
    id: "create-booking", title: "Create a booking", priority: "primary", entities: ["booking"],
    steps: [{ action: "Select a slot", expect: "The selected slot is visible" }],
  }],
});

const CUSTOMER_DATASETS = Object.freeze([
  "projects", "build_jobs", "published_sites", "deployments", "custom_domains",
  "ai_requests", "ca_usage_records", "ca_subscriptions",
]);
const OWNER_TABLES = Object.freeze([
  "projects", "build_jobs", "diag_runs", "bv2_builds", "bv2_model_reservations",
  "bv2_contracts", "bv2_project_knowledge", "bv2_retrieval_traces", "bv2_patches",
  "bv2_snapshots", "bv2_blobs", "bv2_file_revisions", "build_work_jobs",
  "build_work_results", "build_work_events", "publish_releases",
  "publish_activation_intents", "published_sites", "deployments",
]);

const client = serviceClient();
const one = (value) => Array.isArray(value) ? value[0] : value;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const emit = (stage, evidence = {}) => console.log(JSON.stringify({
  at: new Date().toISOString(), stage, ...evidence,
}));

function unwrap(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

async function datasetHash(table) {
  const rows = unwrap(await client.from(table).select("*"), `${table} baseline`);
  const canonicalRows = rows.map(canonical).sort();
  return {
    count: canonicalRows.length,
    sha256: crypto.createHash("sha256").update(`[${canonicalRows.join(",")}]`).digest("hex"),
  };
}

async function customerBaseline() {
  // Keep production proof reads deliberately sequential. This avoids exhausting the
  // managed PostgREST connection pool while preserving a deterministic table order.
  const baseline = {};
  for (const table of CUSTOMER_DATASETS) baseline[table] = await datasetHash(table);
  return baseline;
}

async function count(table, filter = null) {
  let query = client.from(table).select("*", { count: "exact", head: true });
  if (filter) query = filter(query);
  const result = await query;
  if (result.error) throw new Error(`${table} count: ${result.error.message}`);
  return Number(result.count || 0);
}

async function createPrincipal(id, suffix) {
  const created = await client.auth.admin.createUser({
    id, email: `package10e-recovery-${suffix}@example.invalid`,
    password: `Package10E-${crypto.randomBytes(18).toString("hex")}!`, email_confirm: true,
  });
  if (created.error) throw created.error;
}

async function createPublicBuild(id, { bv2BuildId = null } = {}) {
  unwrap(await client.from("build_jobs").insert({
    id, owner: ids.owner, project_id: ids.project, mode: "build", status: "running",
    phase: "running", server_id: "package10e-canary-recovery", pipeline_version: "v2",
    bv2_build_id: bv2BuildId,
  }), `public build ${id}`);
}

async function waitForJob(jobId, states, timeoutMs = 90_000) {
  const accepted = new Set(states);
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await getBuildWork(ids.owner, jobId, { client, includeResult: true });
    if (last && accepted.has(last.state)) return last;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${jobId}: ${JSON.stringify(last)}`);
}

async function registerRelease(releaseId, deploymentId, hash) {
  const data = unwrap(await client.rpc("register_verified_publish_release", {
    p_release_id: releaseId, p_owner: ids.owner, p_project_id: ids.project,
    p_product_id: null, p_slug: `package10e-${ids.project.slice(0, 8)}`,
    p_url: `https://package10e-${ids.project.slice(0, 8)}.app.thrallo.com/`,
    p_build_id: null, p_snapshot_id: null, p_deployment_id: deploymentId,
    p_artifact_hash: hash, p_manifest_hash: hash,
    p_artifact_path: `.thrallo/releases/${ids.owner}/${ids.project}/${releaseId}`,
    p_artifact_bytes: 42, p_file_count: 1,
    p_manifest: { version: "thrallo-release-v1", artifactHash: hash, fileCount: 1, bytes: 42,
      files: [{ path: "index.html", bytes: 42, sha256: hash }] },
    p_domains: [], p_metadata: { package10eRecovery: true, databaseOnly: true },
  }), `register release ${releaseId}`);
  return one(data);
}

async function requestActivation(releaseId, version, operation, deploymentId) {
  return one(unwrap(await client.rpc("request_publish_activation", {
    p_owner: ids.owner, p_release_id: releaseId, p_expected_version: version,
    p_operation: operation, p_activation_deployment_id: deploymentId,
  }), `request ${operation}`));
}

async function requestUnpublish(version) {
  return one(unwrap(await client.rpc("request_publish_unpublish", {
    p_owner: ids.owner, p_project_id: ids.project, p_expected_version: version,
  }), "request unpublish"));
}

async function completeIntent(intent, observedReleaseId) {
  unwrap(await client.rpc("mark_publish_pointer_switched", {
    p_intent_id: intent.id, p_observed_release_id: observedReleaseId,
  }), "mark pointer evidence");
  return one(unwrap(await client.rpc("complete_publish_activation", {
    p_intent_id: intent.id,
  }), "complete activation"));
}

async function stablePublishState(expectedRelease, expectedVersion, expectedLiveDeployment) {
  const site = one(unwrap(await client.from("published_sites")
    .select("active_publish_release_id,activation_version,unpublished_at")
    .eq("owner", ids.owner).eq("project_id", ids.project).single(), "site state"));
  assert.equal(site.active_publish_release_id, expectedRelease);
  assert.equal(site.activation_version, expectedVersion);
  assert.equal(Boolean(site.unpublished_at), expectedRelease === null);
  const deployments = unwrap(await client.from("deployments").select("id,status")
    .eq("owner", ids.owner).eq("project_id", ids.project), "deployment states");
  const live = deployments.filter((row) => row.status === "live");
  assert.equal(live.length, expectedLiveDeployment ? 1 : 0);
  if (expectedLiveDeployment) assert.equal(live[0].id, expectedLiveDeployment);
  return { release: expectedRelease, version: expectedVersion, liveDeployment: expectedLiveDeployment };
}

async function ownerResidue() {
  const rows = {};
  for (const table of OWNER_TABLES) rows[table] = await count(table, (query) => query.eq("owner", ids.owner));
  return rows;
}

async function cleanup() {
  const work = unwrap(await client.from("build_work_jobs").select("id,state")
    .eq("owner", ids.owner), "cleanup work list");
  for (const job of work) {
    if (!["succeeded", "failed", "cancelled"].includes(job.state)) {
      await requestBuildWorkCancel(ids.owner, job.id, { client }).catch(() => {});
      await waitForJob(job.id, ["succeeded", "failed", "cancelled"], 30_000).catch(() => {});
    }
  }
  await purgeOwnerForTests(ids.owner, { client }).catch(() => {});
  await client.from("publish_activation_intents").delete().eq("owner", ids.owner);
  await client.from("publish_releases").delete().eq("owner", ids.owner);
  await client.from("published_sites").delete().eq("owner", ids.owner);
  await client.from("deployments").delete().eq("owner", ids.owner);
  await client.from("build_work_jobs").delete().eq("owner", ids.owner);
  await client.from("build_jobs").delete().eq("owner", ids.owner);
  await client.from("diag_runs").delete().eq("owner", ids.owner);
  await client.from("projects").delete().in("id", [ids.project, ids.otherProject]);
  await client.auth.admin.deleteUser(ids.owner).catch(() => {});
  await client.auth.admin.deleteUser(ids.otherOwner).catch(() => {});
}

const baseline = await customerBaseline();
let primaryError = null;
let workerJob = null;
let cancelJob = null;
let retryJob = null;

try {
  assert.equal(await count("projects", (q) => q.in("id", [ids.project, ids.otherProject])), 0);
  const flags = unwrap(await client.from("bv2_feature_flags").select("key,value")
    .in("key", ["bv2.enabled", "bv2.owners"]), "feature flags");
  assert.equal(flags.some((row) => row.key === "bv2.enabled" && row.value === true), false);
  assert.equal(flags.some((row) => row.key === "bv2.owners" && (row.value === true || row.value?.length)), false);
  emit("baseline", { customer: baseline, ledgerExpected: 67, flags: { enabled: false, owners: 0 }, modelCallsAllowed: false });

  await createPrincipal(ids.owner, "a");
  await createPrincipal(ids.otherOwner, "b");
  unwrap(await client.from("projects").insert([
    { id: ids.project, owner: ids.owner, name: "Package 10E canary recovery", tree: TREE },
    { id: ids.otherProject, owner: ids.otherOwner, name: "Package 10E isolation peer", tree: {} },
  ]), "test projects");
  emit("test_identity_created", { owner: ids.owner, project: ids.project, peerOwner: ids.otherOwner });

  const legacy = await resolveVerifiedProjectTree(ids.owner, {
    id: ids.project, owner: ids.owner, builder_version: "v1", bv2_green_snapshot_id: null, tree: TREE,
  }, { client });
  assert.equal(legacy.source, "legacy_tree");
  unwrap(await client.from("diag_runs").insert({
    id: ids.diag, owner: ids.owner, project_id: ids.project, kind: "package10e_canary_recovery",
    status: "running", prompt: "[zero-model deterministic production composition proof]",
  }), "diagnostic root");
  unwrap(await client.from("bv2_builds").insert({
    id: ids.v2Build, owner: ids.owner, project_id: ids.project, profile: "deterministic-proof",
    request: "Package 10E zero-model canary recovery", state: "created", budget_credits: 0,
  }), "V2 lifecycle");
  await createPublicBuild(ids.publicBuild, { bv2BuildId: ids.v2Build });
  unwrap(await client.from("build_jobs").update({ diag_run_id: ids.diag })
    .eq("id", ids.publicBuild).eq("owner", ids.owner), "diagnostic/public link");
  emit("runtime_lifecycle_created", { legacySource: legacy.source, publicBuild: ids.publicBuild, v2Build: ids.v2Build, diagnostic: ids.diag });

  const tiers = tierContract(CONTRACT);
  const bindings = bindCapabilities(CONTRACT);
  const intents = imageIntents(CONTRACT);
  const contract = await persistContract(ids.owner, ids.project, {
    buildId: ids.v2Build, contract: CONTRACT, tiers, bindings, intents,
  }, { client });
  unwrap(await client.from("bv2_builds").update({ contract_id: contract.id, state: "core" })
    .eq("id", ids.v2Build).eq("owner", ids.owner), "contract link");
  await recordFacts(ids.owner, ids.project, [
    { kind: "contract_ref", key: "current", sourceBuild: ids.v2Build, value: { contractId: contract.id, version: contract.version } },
    { kind: "entity", key: "booking", sourceBuild: ids.v2Build, value: { fields: ["slot"], owned: true } },
    { kind: "route", key: "/", sourceBuild: ids.v2Build, value: { name: "Booking", file: "src/App.jsx" } },
    ...bindings.map((binding) => ({ kind: "capability", key: binding.name, sourceBuild: ids.v2Build,
      value: { version: binding.version, pinnedMajor: Number(binding.version.split(".")[0]) } })),
  ]);
  const knowledge = await getKnowledge(ids.owner, ids.project, { failClosed: true });
  assert.match(knowledgeBrief(knowledge), /booking/);
  emit("contract_knowledge_persisted", { contractId: contract.id, version: contract.version, capabilities: bindings, facts: 3 + bindings.length });

  const expectedIndex = indexTree(TREE);
  const persisted = await persistIndex(ids.owner, ids.project, expectedIndex, { client });
  const duplicate = await persistIndex(ids.owner, ids.project, expectedIndex, { client });
  assert.equal(duplicate.written.length, 0);
  const loadedIndex = await loadIndex(ids.owner, ids.project, manifestOf(expectedIndex), { client });
  const parity = compareGraphIndexes(expectedIndex, loadedIndex, {
    owner: ids.owner, projectId: ids.project, buildId: ids.v2Build,
  });
  assert.equal(parity.clean, true, JSON.stringify(parity.mismatches));
  const graph = memoryGraph(ids.owner, ids.project, loadedIndex);
  const retrieval = retrieve({
    graph, tree: TREE, targets: ["src/App.jsx"], journeys: CONTRACT.journeys, budgetTokens: 2_000,
  });
  assert.ok(retrieval.full.some((row) => row.path === "src/App.jsx"));
  unwrap(await client.from("bv2_retrieval_traces").insert({
    owner: ids.owner, build_id: ids.v2Build, step: "core", query: retrieval.trace.query,
    included: retrieval.trace.included, omitted_count: retrieval.trace.omittedCount, tokens: retrieval.tokens,
  }), "retrieval trace");
  unwrap(await client.from("bv2_patches").insert({
    owner: ids.owner, build_id: ids.v2Build, step: "core:1",
    patch: { op: "replace", path: "src/App.jsx", deterministicFixture: true },
    outcome: "applied", files_changed: ["src/App.jsx"],
  }), "patch trace");
  emit("graph_retrieval_patch_green", {
    revisionsWritten: persisted.written.length, graphPaths: graph.paths().length,
    importers: graph.importersOf("src/data/bookings.js"), retrievalTokens: retrieval.tokens,
    retrievalIncluded: retrieval.trace.included.length,
  });

  const snapshots = createSnapshotStore(supabaseSnapshotStorage({ client }));
  const snapshot = await snapshots.createSnapshot(ids.owner, ids.project, TREE, {
    buildId: ids.v2Build, reason: "package10e_canary_recovery",
  });
  await snapshots.promote(ids.owner, ids.project, "green", snapshot.id);
  unwrap(await client.from("bv2_builds").update({
    state: "green", final_snapshot: snapshot.id, finished_at: new Date().toISOString(),
  }).eq("id", ids.v2Build).eq("owner", ids.owner), "V2 green completion");
  unwrap(await client.from("projects").update({
    builder_version: "v2", bv2_green_snapshot_id: snapshot.id,
    tree: { "src/App.jsx": "export default function Stale(){ return null }" },
  }).eq("id", ids.project).eq("owner", ids.owner), "snapshot-authoritative project");
  const source = await resolveVerifiedProjectTree(ids.owner, { id: ids.project, owner: ids.owner }, {
    client, log: () => {},
  });
  assert.equal(source.source, "bv2_green_snapshot");
  assert.deepEqual(source.tree, TREE);
  const exported = buildProjectZip({ id: ids.project, name: "Package 10E proof", tree: source.tree, history: [] });
  assert.match(exported.files["src/App.jsx"], /verified-snapshot/);
  emit("snapshot_preview_export_qa_source_green", {
    snapshotId: snapshot.id, treeHash: snapshot.tree_hash, files: Object.keys(source.tree).length,
    exportFiles: Object.keys(exported.files).length, source: source.source,
    qaUsesSharedResolver: true,
  });

  workerJob = await enqueueBuildWork({
    owner: ids.owner, projectId: ids.project, buildId: ids.publicBuild, jobType: "proof_slow",
    payload: { durationMs: 750, phase: "package10e-composition-recovery" },
    idempotencyKey: "package10e-recovery-success", priority: 90, maxAttempts: 2,
    resourceLimits: { wallSeconds: 20, cpu: 0.5, memoryMb: 384, pids: 64 }, client,
  });
  unwrap(await client.from("build_jobs").update({ work_job_id: workerJob.id })
    .eq("id", ids.publicBuild).eq("owner", ids.owner), "worker/public link");
  const completedWork = await awaitBuildWork(ids.owner, workerJob.id, { client, timeoutMs: 90_000, pollMs: 250 });
  assert.equal(completedWork.state, "succeeded");
  assert.ok(completedWork.result_ref);
  const events = await listBuildWorkEvents(ids.owner, workerJob.id, { client });
  assert.ok(events.some((event) => event.event_type === "succeeded"));
  unwrap(await client.from("build_jobs").update({
    status: "complete", phase: "complete",
    result: { buildOk: true, snapshotId: snapshot.id, pipelineVersion: "v2", _worker: { proof: true } },
  }).eq("id", ids.publicBuild).eq("owner", ids.owner), "durable public completion");
  const recovered = await prepareBuilderV2PipelineAttempt({
    id: workerJob.id, owner: ids.owner, build_id: ids.publicBuild, attempts: 2,
  }, { client });
  assert.equal(recovered.action, "recovered");
  emit("worker_completion_recovery_green", {
    workerJob: workerJob.id, resultRef: completedWork.result_ref, events: events.length,
    retryAction: recovered.action,
  });

  await createPublicBuild(ids.cancelBuild);
  cancelJob = await enqueueBuildWork({
    owner: ids.owner, projectId: ids.project, buildId: ids.cancelBuild, jobType: "proof_slow",
    payload: { durationMs: 12_000, phase: "package10e-cancel" },
    idempotencyKey: "package10e-recovery-cancel", priority: 90, maxAttempts: 1,
    resourceLimits: { wallSeconds: 20, cpu: 0.5, memoryMb: 384, pids: 64 }, client,
  });
  unwrap(await client.from("build_jobs").update({ work_job_id: cancelJob.id })
    .eq("id", ids.cancelBuild).eq("owner", ids.owner), "cancel/public link");
  await requestBuildWorkCancel(ids.owner, cancelJob.id, { client });
  const cancelled = await waitForJob(cancelJob.id, ["cancelled"], 90_000);
  unwrap(await client.from("build_jobs").update({ status: "failed", phase: "cancelled", error: "proof cancellation" })
    .eq("id", ids.cancelBuild).eq("owner", ids.owner), "cancel public terminal");
  emit("worker_cancellation_green", { workerJob: cancelJob.id, state: cancelled.state });

  await createPublicBuild(ids.retryBuild);
  retryJob = await enqueueBuildWork({
    owner: ids.owner, projectId: ids.project, buildId: ids.retryBuild, jobType: "proof_slow",
    payload: { durationMs: 100, phase: "package10e-retry-identity" },
    idempotencyKey: "package10e-recovery-retry", priority: -100, maxAttempts: 1, client,
  });
  unwrap(await client.from("build_jobs").update({ work_job_id: retryJob.id })
    .eq("id", ids.retryBuild).eq("owner", ids.owner), "retry/public link");
  const safeRetry = await prepareBuilderV2PipelineAttempt({
    id: retryJob.id, owner: ids.owner, build_id: ids.retryBuild, attempts: 2,
  }, { client });
  assert.equal(safeRetry.action, "restart_before_provider");
  unwrap(await client.from("bv2_builds").insert({
    id: ids.unsafeV2Build, owner: ids.owner, project_id: ids.project,
    profile: "deterministic-proof", request: "synthetic dispatch evidence", state: "core",
    budget_credits: 1,
  }), "unsafe V2 lifecycle");
  unwrap(await client.from("build_jobs").update({ bv2_build_id: ids.unsafeV2Build })
    .eq("id", ids.retryBuild).eq("owner", ids.owner), "unsafe lifecycle/public link");
  const reservation = one(unwrap(await client.rpc("reserve_bv2_model_call", {
    p_owner: ids.owner, p_project_id: ids.project, p_build_id: ids.unsafeV2Build,
    p_call_key: "package10e-synthetic-dispatch", p_step: "core", p_provider: "synthetic",
    p_model: "no-provider-called", p_billing_lane: "byok_api", p_reserved_credits: 0.01,
    p_ceiling_credits: 1, p_account_available_credits: null,
    p_metadata: { syntheticDispatchEvidence: true, providerCalled: false },
  }), "synthetic reservation"));
  const unsafe = one(unwrap(await client.rpc("prepare_bv2_pipeline_retry", {
    p_owner: ids.owner, p_public_build_id: ids.retryBuild, p_work_job_id: retryJob.id,
  }), "unsafe retry"));
  assert.equal(unsafe.action, "provider_replay_unsafe");
  unwrap(await client.rpc("release_bv2_model_call", {
    p_owner: ids.owner, p_reservation_id: reservation.id,
  }), "release synthetic reservation");
  unwrap(await client.from("build_jobs").update({ status: "failed", phase: "failed", error: "synthetic replay guard proof" })
    .eq("id", ids.retryBuild).eq("owner", ids.owner), "retry public terminal");
  emit("provider_replay_boundary_green", {
    safeAction: safeRetry.action, unsafeAction: unsafe.action, providerCalled: false,
    reservationReleased: reservation.id,
  });

  unwrap(await client.from("deployments").insert([
    { id: ids.deploymentA, owner: ids.owner, project_id: ids.project, number: 1, status: "deploying" },
    { id: ids.deploymentB, owner: ids.owner, project_id: ids.project, number: 2, status: "deploying" },
    { id: ids.deploymentRollback, owner: ids.owner, project_id: ids.project, number: 3,
      status: "deploying", triggered_by_kind: "rollback", rolled_back_from: ids.deploymentB },
  ]), "proof deployments");
  const hashA = "a".repeat(64);
  const hashB = "b".repeat(64);
  const registrationA = await registerRelease(ids.releaseA, ids.deploymentA, hashA);
  const duplicateA = await registerRelease(ids.releaseA, ids.deploymentA, hashA);
  assert.equal(duplicateA.release_id, registrationA.release_id);
  const activationA = await requestActivation(ids.releaseA, 0, "activate", ids.deploymentA);
  await completeIntent(activationA, ids.releaseA);
  emit("c8_release_a_active", await stablePublishState(ids.releaseA, 1, ids.deploymentA));

  await registerRelease(ids.releaseB, ids.deploymentB, hashB);
  const stale = await client.rpc("request_publish_activation", {
    p_owner: ids.owner, p_release_id: ids.releaseB, p_expected_version: 0,
    p_operation: "activate", p_activation_deployment_id: ids.deploymentB,
  });
  assert.ok(stale.error);
  const activationB = await requestActivation(ids.releaseB, 1, "activate", ids.deploymentB);
  await completeIntent(activationB, ids.releaseB);
  emit("c8_release_b_active", { ...(await stablePublishState(ids.releaseB, 2, ids.deploymentB)), staleCasRejected: true });

  const immutable = await client.from("publish_releases").update({ artifact_hash: hashB })
    .eq("id", ids.releaseA).eq("owner", ids.owner);
  assert.ok(immutable.error);
  const rollback = await requestActivation(ids.releaseA, 2, "rollback", ids.deploymentRollback);
  await completeIntent(rollback, ids.releaseA);
  const releaseAAfter = one(unwrap(await client.from("publish_releases").select("artifact_hash")
    .eq("id", ids.releaseA).single(), "release A immutable hash"));
  assert.equal(releaseAAfter.artifact_hash, hashA);
  emit("c8_rollback_green", { ...(await stablePublishState(ids.releaseA, 3, ids.deploymentRollback)), artifactHashUnchanged: true, rebuild: false });

  const unpublish = await requestUnpublish(3);
  await completeIntent(unpublish, null);
  await stablePublishState(null, 4, null);
  const replayed = one(unwrap(await client.rpc("complete_publish_activation", {
    p_intent_id: unpublish.id,
  }), "replay unpublish completion"));
  assert.equal(replayed.id, unpublish.id);
  const reactivation = await requestActivation(ids.releaseA, 4, "activate", ids.deploymentRollback);
  await completeIntent(reactivation, ids.releaseA);
  await stablePublishState(ids.releaseA, 5, ids.deploymentRollback);
  const finalUnpublish = await requestUnpublish(5);
  await completeIntent(finalUnpublish, null);
  const finalPublishState = await stablePublishState(null, 6, null);
  const crossOwner = await client.rpc("request_publish_activation", {
    p_owner: ids.otherOwner, p_release_id: ids.releaseA, p_expected_version: 6,
    p_operation: "activate", p_activation_deployment_id: null,
  });
  assert.ok(crossOwner.error);
  emit("c8_database_state_machine_green", {
    ...finalPublishState, registrationIdempotent: true, immutableIdentity: true,
    unpublishIdempotent: true, republishRetained: true, crossOwnerRejected: true,
    filesystemProofReused: "docs/evidence/atomic-publishing/2026-08-07/PROOF.md",
    filesystemMutationThisRun: false,
  });

  const persistedEvidence = {
    contracts: await count("bv2_contracts", (q) => q.eq("owner", ids.owner)),
    knowledge: await count("bv2_project_knowledge", (q) => q.eq("owner", ids.owner)),
    retrievalTraces: await count("bv2_retrieval_traces", (q) => q.eq("owner", ids.owner)),
    patches: await count("bv2_patches", (q) => q.eq("owner", ids.owner)),
    snapshots: await count("bv2_snapshots", (q) => q.eq("owner", ids.owner)),
    diagnostics: await count("diag_runs", (q) => q.eq("owner", ids.owner)),
  };
  assert.deepEqual(persistedEvidence, {
    contracts: 1, knowledge: 7, retrievalTraces: 1, patches: 1, snapshots: 1, diagnostics: 1,
  });
  unwrap(await client.from("diag_steps").insert({
    id: crypto.randomUUID(), run_id: ids.diag, seq: 1, round: 1, agent: "Builder V2",
    kind: "production_canary", label: "Package 10E canary recovery", status: "ok",
    output: JSON.stringify({ persisted: persistedEvidence, workerJob: workerJob.id, snapshotId: snapshot.id, c8DatabaseOnly: true }),
  }), "diagnostic step");
  unwrap(await client.from("diag_runs").update({
    status: "complete", finished_at: new Date().toISOString(), totals: { modelCalls: 0, credits: 0 },
  }).eq("id", ids.diag).eq("owner", ids.owner), "diagnostic completion");
  emit("canonical_traces_green", { persisted: persistedEvidence, diagnosticsComplete: true, modelCalls: 0, credits: 0 });
} catch (error) {
  primaryError = error;
  emit("canary_failed", { name: error.name, code: error.code || null, message: error.message });
}

let cleanupError = null;
try {
  await cleanup();
} catch (error) {
  cleanupError = error;
  emit("cleanup_failed", { name: error.name, code: error.code || null, message: error.message });
}

const residue = await ownerResidue();
const residueCount = Object.values(residue).reduce((sum, value) => sum + value, 0);
const authProbe = await client.auth.admin.getUserById(ids.owner);
const peerAuthProbe = await client.auth.admin.getUserById(ids.otherOwner);
assert.ok(authProbe.error || !authProbe.data?.user, "test owner remains in Auth");
assert.ok(peerAuthProbe.error || !peerAuthProbe.data?.user, "test peer remains in Auth");
assert.equal(residueCount, 0, `test-owner residue: ${JSON.stringify(residue)}`);
const after = await customerBaseline();
assert.deepEqual(after, baseline, "customer canonical datasets changed");
const finalFlags = unwrap(await client.from("bv2_feature_flags").select("key,value")
  .in("key", ["bv2.enabled", "bv2.owners"]), "final feature flags");
assert.equal(finalFlags.some((row) => row.key === "bv2.enabled" && row.value === true), false);
assert.equal(finalFlags.some((row) => row.key === "bv2.owners" && (row.value === true || row.value?.length)), false);
emit("cleanup_customer_parity_green", {
  residue, authUsersRemoved: true, customer: after,
  flags: { enabled: false, owners: 0 }, managedSettlementPaused: true,
  customerWorkerDispatch: false, customerAtomicPublishing: false,
});

if (primaryError || cleanupError) throw primaryError || cleanupError;
emit("package10e_canary_recovery_complete", {
  ok: true, providerCalls: 0, stripeTransactions: 0, customerMutations: 0,
  ingressOrFilesystemControlCalls: 0,
});
