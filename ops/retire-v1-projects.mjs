// One-time, fail-closed retirement of the exact Builder V1 production inventory approved for
// the V2-only cutover. This command is read-only by default. Destructive work requires both
// --execute and the exact typed confirmation printed by --help.

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { serviceClient } from "../shell/server/lib/supabase.mjs";
import { buildProjectErasureManifest, eraseProjectPermanently } from "../shell/server/lib/erasureService.mjs";
import { PROJECT_SCOPED_TABLES, detachDomains, takeSiteOffline } from "../shell/server/lib/projectTeardown.mjs";

export const APPROVED_V1_PROJECT_IDS = Object.freeze([
  "5d0b8474-6caa-4622-9a4b-0a82c6ce6460",
  "eebb454f-f75b-4d7f-9876-5b5ff94e7f21",
  "9bf2d8d2-d601-4221-83e7-429d50e694ad",
  "5de72f0d-8c2d-4900-b9d3-5b2785997edf",
  "544ee227-6a01-4a46-9800-791b10d3b05d",
  "ef78b9e5-9130-46f8-a8d8-e8ee158ddab5",
  "521c8922-1fdd-4e3a-b9cb-2994e5affc17",
  "66d26ad6-6851-4619-99a6-1d9889b00ed2",
  "970f8f27-19db-4023-a25a-4efc268e5768",
  "bf5a947e-ec59-41d4-b67a-290c34894474",
  "5c658a89-ab93-4903-b58e-7251960e676b",
]);

export const EXECUTE_CONFIRMATION = "RETIRE EXACTLY 11 APPROVED V1 PROJECTS";
const PAGE_SIZE = 500;
const ACTIVE_WORK_STATES = new Set(["queued", "leased", "running", "cancel_requested", "expired"]);
const TERMINAL_BV2_STATES = new Set(["green", "failed", "cancelled", "blocked"]);
const NON_TERMINAL_ACTIVATION_STATES = new Set(["prepared", "pointer_switched", "retrying"]);

// Rows removed directly by the canonical teardown, plus rows removed by database cascades and
// immutable erasure evidence that refers to the target. Child-only tables are collected below.
const DIRECT_EVIDENCE_TABLES = Object.freeze([
  ...PROJECT_SCOPED_TABLES,
  { table: "qa_runs", column: "project_id" },
  { table: "bv2_symbols", column: "project_id" },
  { table: "bv2_symbol_refs", column: "project_id" },
  { table: "bv2_dependency_edges", column: "project_id" },
  { table: "bv2_shadow_run_files", column: "project_id" },
  { table: "bv2_shadow_checks", column: "project_id" },
  { table: "data_erasure_jobs", column: "project_id" },
]);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function canonicalJson(value) {
  return `${canonical(value)}\n`;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function parseRetirementArgs(argv) {
  const out = { execute: false, confirmation: null, evidenceDir: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--execute") out.execute = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--confirm" || arg === "--evidence-dir") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--confirm") out.confirmation = value;
      else out.evidenceDir = path.resolve(value);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!out.execute && out.confirmation) throw new Error("--confirm is only valid with --execute");
  if (out.execute && out.confirmation !== EXECUTE_CONFIRMATION) {
    throw new Error(`--execute requires --confirm \"${EXECUTE_CONFIRMATION}\"`);
  }
  return out;
}

async function queryRows(client, table, filters = {}) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    let query = client.from(table).select("*");
    for (const [column, value] of Object.entries(filters)) {
      query = Array.isArray(value) ? query.in(column, value) : query.eq(column, value);
    }
    const { data, error } = await query.range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${table} inventory failed: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

function ids(rows, field = "id") {
  return [...new Set(rows.map((row) => row[field]).filter(Boolean).map(String))].sort();
}

function containsExactValue(value, targets) {
  if (typeof value === "string") return targets.has(value);
  if (Array.isArray(value)) return value.some((item) => containsExactValue(item, targets));
  if (value && typeof value === "object") return Object.values(value).some((item) => containsExactValue(item, targets));
  return false;
}

function sameIds(left, right) {
  const a = [...left].map(String).sort();
  const b = [...right].map(String).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function assertApprovedInventory(projects, approvedIds = APPROVED_V1_PROJECT_IDS) {
  const target = new Set(approvedIds);
  const targetRows = projects.filter((project) => target.has(String(project.id)));
  const targetV2 = targetRows.filter((project) => project.builder_version === "v2").map((project) => project.id);
  if (targetV2.length) throw new Error(`approved retirement target is Builder V2: ${targetV2.sort().join(", ")}`);
  const currentV1 = projects.filter((project) => project.builder_version === "v1").map((project) => String(project.id));
  if (!sameIds(currentV1, approvedIds)) {
    const approved = new Set(approvedIds);
    const current = new Set(currentV1);
    const missing = approvedIds.filter((id) => !current.has(id));
    const unexpected = currentV1.filter((id) => !approved.has(id));
    throw new Error(`current Builder V1 inventory differs from approval (missing=${missing.join(",") || "none"}; unexpected=${unexpected.join(",") || "none"})`);
  }
  if (targetRows.some((project) => project.builder_version !== "v1")) {
    throw new Error("every approved retirement target must be explicitly marked builder_version=v1");
  }
  return [...targetRows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

export function assertNoActiveJobs(active) {
  const nonempty = Object.entries(active).filter(([, rows]) => rows.length > 0);
  if (nonempty.length) {
    throw new Error(`active work blocks V1 retirement: ${nonempty.map(([table, rows]) => `${table}=${rows.length}`).join(", ")}`);
  }
}

export async function inspectRetirementState(client) {
  const projects = await queryRows(client, "projects");
  const approvedProjects = assertApprovedInventory(projects);
  const targetIds = APPROVED_V1_PROJECT_IDS;
  const [buildJobs, workJobs, qaRuns, bv2Builds, activationIntents] = await Promise.all([
    queryRows(client, "build_jobs", { project_id: targetIds }),
    queryRows(client, "build_work_jobs", { project_id: targetIds }),
    queryRows(client, "qa_runs", { project_id: targetIds }),
    queryRows(client, "bv2_builds", { project_id: targetIds }),
    queryRows(client, "publish_activation_intents", { project_id: targetIds }),
  ]);
  const active = {
    build_jobs: buildJobs.filter((row) => ["queued", "running"].includes(row.status)),
    build_work_jobs: workJobs.filter((row) => ACTIVE_WORK_STATES.has(row.state)),
    qa_runs: qaRuns.filter((row) => ["queued", "running"].includes(row.status)),
    bv2_builds: bv2Builds.filter((row) => !TERMINAL_BV2_STATES.has(row.state)),
    publish_activation_intents: activationIntents.filter((row) => NON_TERMINAL_ACTIVATION_STATES.has(row.state)),
  };
  assertNoActiveJobs(active);
  return { projects: approvedProjects, active };
}

async function collectRelatedRows(client, direct) {
  const related = {};
  const diagRunIds = ids(direct.diag_runs || []);
  related.diag_steps = diagRunIds.length ? await queryRows(client, "diag_steps", { run_id: diagRunIds }) : [];
  related.build_signals = diagRunIds.length ? await queryRows(client, "build_signals", { build_id: diagRunIds }) : [];

  const snapshotIds = ids(direct.bv2_snapshots || []);
  related.bv2_snapshot_files = snapshotIds.length
    ? await queryRows(client, "bv2_snapshot_files", { snapshot_id: snapshotIds }) : [];
  const blobHashes = ids(related.bv2_snapshot_files, "content_hash");
  const owners = ids(direct.projects || [], "owner");
  related.bv2_blobs = [];
  if (blobHashes.length) {
    for (const owner of owners) {
      related.bv2_blobs.push(...await queryRows(client, "bv2_blobs", { owner, content_hash: blobHashes }));
    }
  }

  const buildIds = ids(direct.bv2_builds || []);
  related.bv2_retrieval_traces = buildIds.length
    ? await queryRows(client, "bv2_retrieval_traces", { build_id: buildIds }) : [];
  related.bv2_patches = buildIds.length ? await queryRows(client, "bv2_patches", { build_id: buildIds }) : [];

  const erasureJobIds = ids(direct.data_erasure_jobs || []);
  related.data_erasure_events = erasureJobIds.length
    ? await queryRows(client, "data_erasure_events", { job_id: erasureJobIds }) : [];

  // Immutable accounting rows intentionally survive project deletion. Capture the rows whose
  // logical identity came from a target Builder reservation so retained billing evidence remains
  // attributable after the reservation itself is erased.
  const reservationIds = ids(direct.bv2_model_reservations || []);
  related.ca_model_call_identities = reservationIds.length
    ? await queryRows(client, "ca_model_call_identities", { reservation_id: reservationIds }) : [];
  related.ca_usage_records = reservationIds.length
    ? await queryRows(client, "ca_usage_records", { id: reservationIds }) : [];
  related.bv2_build_budget_approvals = await queryRows(client, "bv2_build_budget_approvals", {
    dispatch_project_id: APPROVED_V1_PROJECT_IDS,
  });

  // Conversations deliberately do not FK to projects; durable events carry the relationship.
  // Preserve the complete thread as evidence without deleting history or an unrelated V2 project
  // that may share the same product/conversation.
  const targetOwners = ids(direct.projects || [], "owner");
  const allOwnerEvents = targetOwners.length
    ? await queryRows(client, "ca_conversation_events", { owner: targetOwners }) : [];
  const targetSet = new Set(APPROVED_V1_PROJECT_IDS);
  const matchingEvents = allOwnerEvents.filter((row) => containsExactValue(row.payload, targetSet));
  const conversationIds = ids(matchingEvents, "conversation_id");
  related.ca_conversations = conversationIds.length
    ? await queryRows(client, "ca_conversations", { id: conversationIds }) : [];
  if (related.ca_conversations.some((row) => row.state === "thinking")) {
    throw new Error("an approved V1 project conversation is actively thinking; refusing retirement");
  }
  related.ca_conversation_turns = conversationIds.length
    ? await queryRows(client, "ca_conversation_turns", { conversation_id: conversationIds }) : [];
  related.ca_conversation_events = conversationIds.length
    ? await queryRows(client, "ca_conversation_events", { conversation_id: conversationIds }) : [];
  return related;
}

export async function collectRetirementEvidence(client) {
  const direct = {};
  for (const { table, column } of DIRECT_EVIDENCE_TABLES) {
    if (table in direct) continue;
    direct[table] = await queryRows(client, table, { [column]: APPROVED_V1_PROJECT_IDS });
  }
  const related = await collectRelatedRows(client, direct);
  return Object.fromEntries(Object.entries({ ...direct, ...related }).sort(([a], [b]) => a.localeCompare(b)));
}

async function writePrivateFile(filename, bytes) {
  await writeFile(filename, bytes, { flag: "wx", mode: 0o600 });
  await chmod(filename, 0o600);
}

export async function writeEvidenceBundle(rowsByTable, {
  evidenceDir,
  capturedAt = new Date().toISOString(),
  approvedIds = APPROVED_V1_PROJECT_IDS,
} = {}) {
  if (!evidenceDir) throw new Error("an evidence directory is required");
  const finalDir = path.resolve(evidenceDir);
  const partialDir = `${finalDir}.partial`;
  if (await stat(finalDir).catch(() => null)) throw new Error(`evidence directory already exists: ${finalDir}`);
  await mkdir(path.dirname(finalDir), { recursive: true, mode: 0o700 });
  await mkdir(partialDir, { recursive: false, mode: 0o700 });
  await chmod(partialDir, 0o700);
  const tablesDir = path.join(partialDir, "tables");
  await mkdir(tablesDir, { mode: 0o700 });
  await chmod(tablesDir, 0o700);

  const files = {};
  for (const [table, sourceRows] of Object.entries(rowsByTable).sort(([a], [b]) => a.localeCompare(b))) {
    const sortedRows = [...sourceRows].sort((a, b) => canonical(a).localeCompare(canonical(b)));
    const relative = `tables/${table}.json`;
    const bytes = canonicalJson({ rows: sortedRows, table });
    await writePrivateFile(path.join(partialDir, relative), bytes);
    files[relative] = { rows: sortedRows.length, bytes: Buffer.byteLength(bytes), sha256: sha256(bytes) };
  }
  const manifest = {
    version: 1,
    purpose: "approved-builder-v1-retirement-evidence",
    capturedAt,
    approvedProjectIds: [...approvedIds].sort(),
    projectCount: approvedIds.length,
    files,
  };
  const manifestBytes = canonicalJson(manifest);
  const manifestSha256 = sha256(manifestBytes);
  await writePrivateFile(path.join(partialDir, "manifest.json"), manifestBytes);
  await writePrivateFile(path.join(partialDir, "manifest.sha256"), `${manifestSha256}  manifest.json\n`);

  for (const [relative, expected] of Object.entries(files)) {
    const actual = await readFile(path.join(partialDir, relative));
    if (actual.length !== expected.bytes || sha256(actual) !== expected.sha256) {
      throw new Error(`evidence verification failed: ${relative}`);
    }
  }
  if (sha256(await readFile(path.join(partialDir, "manifest.json"))) !== manifestSha256) {
    throw new Error("evidence manifest verification failed");
  }
  await rename(partialDir, finalDir);
  await chmod(finalDir, 0o700);
  return { directory: finalDir, manifestSha256, files: Object.keys(files).length };
}

export function createProvisiondClient({ url = process.env.PROVISIOND_URL, token = process.env.PROVISIOND_TOKEN } = {}) {
  if (!url || !token) throw new Error("execution requires PROVISIOND_URL and PROVISIOND_TOKEN");
  return async (route, body = null, method = "POST") => {
    const response = await fetch(`${url}${route}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`provisiond ${route} failed (${response.status})`);
    return payload;
  };
}

async function verifyNoResidue(client, evidenceRows = {}) {
  const projects = await queryRows(client, "projects");
  const survivingTargets = projects.filter((row) => APPROVED_V1_PROJECT_IDS.includes(String(row.id)));
  const v1 = projects.filter((row) => row.builder_version === "v1");
  if (survivingTargets.length || v1.length) {
    throw new Error(`retirement verification failed (target residues=${survivingTargets.length}; V1 projects=${v1.length})`);
  }
  for (const { table, column } of DIRECT_EVIDENCE_TABLES) {
    // Erasure jobs are deliberately retained, content-free proof. They are evidence, not residue.
    if (table === "data_erasure_jobs") continue;
    const residue = await queryRows(client, table, { [column]: APPROVED_V1_PROJECT_IDS });
    if (residue.length) throw new Error(`retirement verification found ${residue.length} target rows in ${table}`);
  }
  const childProbes = [
    ["diag_steps", "run_id", ids(evidenceRows.diag_runs || [])],
    ["build_signals", "build_id", ids(evidenceRows.diag_runs || [])],
    ["bv2_snapshot_files", "snapshot_id", ids(evidenceRows.bv2_snapshots || [])],
    ["bv2_retrieval_traces", "build_id", ids(evidenceRows.bv2_builds || [])],
    ["bv2_patches", "build_id", ids(evidenceRows.bv2_builds || [])],
  ];
  for (const [table, column, values] of childProbes) {
    if (!values.length) continue;
    const residue = await queryRows(client, table, { [column]: values });
    if (residue.length) throw new Error(`retirement verification found ${residue.length} target child rows in ${table}`);
  }
}

export async function retireApprovedV1Projects({
  client,
  execute = false,
  evidenceDir,
  provisiond = null,
  collectEvidence = collectRetirementEvidence,
  writeEvidence = writeEvidenceBundle,
  eraseProject = eraseProjectPermanently,
  inspect = inspectRetirementState,
  takeOffline = takeSiteOffline,
  detach = detachDomains,
  buildManifest = buildProjectErasureManifest,
  verify = verifyNoResidue,
} = {}) {
  if (!client) throw new Error("a service client is required");
  const before = await inspect(client);
  const evidenceRows = await collectEvidence(client);
  const evidence = await writeEvidence(evidenceRows, { evidenceDir });
  if (!execute) return { mode: "dry-run", projects: before.projects.length, evidence };

  if (!process.env.THRALLO_ERASURE_AUDIT_KEY && !process.env.PLATFORM_ENC_KEY) {
    throw new Error("execution requires THRALLO_ERASURE_AUDIT_KEY or PLATFORM_ENC_KEY");
  }
  if (!provisiond) throw new Error("execution requires a provisiond client");
  // Re-read after the export and immediately before the first mutation. A V1 request or job that
  // appeared while evidence was being written invalidates the approved retirement set.
  const current = await inspect(client);
  if (!sameIds(current.projects.map((row) => row.id), before.projects.map((row) => row.id))) {
    throw new Error("V1 inventory changed while evidence was captured; refusing mutation");
  }

  // Build and approve every durable erasure manifest before taking even one site offline. This
  // exercises all database/storage inventory reads up front and avoids a preventable half-start.
  const erasureManifests = new Map();
  for (const project of current.projects) {
    const manifest = await buildManifest(project.owner, project.id, { client });
    erasureManifests.set(project.id, manifest.manifestSha256);
  }
  await inspect(client);

  for (const project of current.projects) {
    // Existing erasure owns database/Auth/Storage/filesystem deletion. Verify published resources
    // first because its database transaction must never erase the slug while it is still serving.
    const site = await takeOffline({ client, provisiond, ownerId: project.owner, projectId: project.id });
    if (site.slug && !site.removed) throw new Error(`published site teardown was not verified for project ${project.id}`);
    if (site.slug) {
      const absence = await provisiond(`/exists?label=${encodeURIComponent(site.slug)}`, null, "GET");
      if (absence?.exists !== false) throw new Error(`published site absence was not proven for project ${project.id}`);
    }
    const domains = await detach({ client, provisiond, ownerId: project.owner, projectId: project.id, strictExternal: true });
    const expectedDomains = (evidenceRows.custom_domains || [])
      .filter((row) => String(row.project_id) === String(project.id) && String(row.owner) === String(project.owner))
      .map((row) => row.domain).filter(Boolean).sort();
    if (!sameIds(domains.detached || [], expectedDomains)) {
      throw new Error(`custom domain teardown did not cover the exported inventory for project ${project.id}`);
    }
    await eraseProject(project.owner, project.id, {
      client,
      provisiond,
      approvedManifestSha256: erasureManifests.get(project.id),
    });
  }
  await verify(client, evidenceRows);
  return { mode: "executed", projects: current.projects.length, evidence };
}

function defaultEvidenceDir() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.resolve("evidence", "v1-retirement", `retirement-${stamp}`);
}

function usage() {
  return [
    "Usage:",
    "  node ops/retire-v1-projects.mjs [--evidence-dir PATH]",
    `  node ops/retire-v1-projects.mjs --execute --confirm \"${EXECUTE_CONFIRMATION}\" [--evidence-dir PATH]`,
    "",
    "Default mode is read-only with respect to production: it inventories and writes local evidence only.",
  ].join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseRetirementArgs(argv);
  if (args.help) { console.log(usage()); return; }
  const evidenceDir = args.evidenceDir || defaultEvidenceDir();
  const client = serviceClient();
  const provisiond = args.execute ? createProvisiondClient() : null;
  const result = await retireApprovedV1Projects({ client, execute: args.execute, evidenceDir, provisiond });
  // Evidence may contain customer data. Output only counts, mode and the integrity hash.
  console.log(JSON.stringify({ ok: true, mode: result.mode, projects: result.projects,
    evidenceDirectory: result.evidence.directory, manifestSha256: result.evidence.manifestSha256 }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => { console.error(`V1 retirement FAILED: ${error.message}`); process.exitCode = 1; });
}
