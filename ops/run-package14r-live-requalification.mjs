// Package 14R live requalification. This operator is deliberately resumable and stage-oriented:
// every provider-bearing stage is exactly-once in its evidence directory, AUTO routing is pinned
// per job without changing owner preferences, and aggregate settled usage is capped at 12 credits.

import crypto from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { createDiagSession } from "../shell/server/lib/appBuild/buildDiagnostics.mjs";
import { createJob } from "../shell/server/lib/buildJobs.mjs";
import { awaitBuildWork } from "../shell/server/lib/buildWorkQueue.mjs";
import { loadEnv } from "../shell/server/lib/env.mjs";
import { buildProjectErasureManifest, eraseProjectPermanently } from "../shell/server/lib/erasureService.mjs";
import { createSnapshotStore } from "../shell/server/lib/builderV2/snapshotStore.mjs";
import { supabaseSnapshotStorage } from "../shell/server/lib/builderV2/supabaseTwins.mjs";
import { serviceClient } from "../shell/server/lib/supabase.mjs";

loadEnv();
process.env.THRALLO_BUILD_WORKER_ENABLED = "1"; // this operator process only

const TOTAL_CEILING = 12;
const STAGE = String(process.argv[2] || "preflight").toLowerCase();
const evidenceDir = path.resolve(process.env.PACKAGE14R_EVIDENCE_DIR
  || "/home/ubuntu/thrallo-deploy-evidence/package14r-live-20260808");
const statePath = path.join(evidenceDir, "state.json");
const eventsPath = path.join(evidenceDir, "evidence.jsonl");
const client = serviceClient();
const snapshots = createSnapshotStore(supabaseSnapshotStorage({ client }));

const SIMPLE_REQUEST = `Build a polished one-page website for Northlight Bicycle Repair, an
independent bicycle workshop in Bristol. Include a distinctive hero, repair services, transparent
turnaround guidance, workshop story, opening hours, and a contact form with name, email and message.
Submitting the form must persist a contactEnquiry through makeContactForm({ entity:
"contactEnquiry" }) and show a clear confirmation. Use Builder V2 assets. Do not use localStorage.`;

const EDIT_REQUEST = `Make one bounded edit to this verified application: add a concise service
warranty section with three useful customer assurances, link it from the existing page navigation,
and preserve the existing contact journey and visual language. Do not regenerate unrelated modules.`;

const BOOKING_REQUEST = `Build a polished multi-step booking application for Ember Table, a
chef-led supper club. The model owns the distinctive editorial visual design. The headless behavior
must use both makeBookingSystem and makeWizardMachine. The flow must select date, available slot,
party size and validated contact details, show a review step, confirm with a durable booking
reference, reload and recover the confirmed state, cancel the booking, and restore an explicit
cancelled state. Enforce capacity honestly. Never use localStorage or reimplement these capabilities.`;

const round = (value) => Math.round(Number(value || 0) * 10_000) / 10_000;
const hash = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const unwrap = (result, label) => {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
};
const emit = async (stage, details = {}) => {
  const event = { at: new Date().toISOString(), stage, ...details };
  await appendFile(eventsPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(JSON.stringify(event));
};
const save = async (state) => {
  const temporary = `${statePath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, statePath);
};
const load = async () => {
  try { return JSON.parse(await readFile(statePath, "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { schemaVersion: 1, runId: "package14r-live-20260808", projects: {}, stages: {} };
  }
};

async function codexOwner() {
  const preferences = unwrap(await client.from("ca_ai_preferences")
    .select("owner,active_provider,routing_mode,preferred_model").eq("active_provider", "codex")
    .order("updated_at", { ascending: false }), "Codex preferences") || [];
  for (const preference of preferences) {
    const credential = unwrap(await client.from("ca_ai_credentials")
      .select("owner,status,provider,auth_mode").eq("owner", preference.owner)
      .eq("provider", "codex").eq("status", "connected").maybeSingle(), "Codex credential");
    if (credential) return { owner: preference.owner, preference };
  }
  throw new Error("Package 14R requires an active connected Codex owner");
}

async function reservations(projectIds) {
  if (!projectIds.length) return [];
  return unwrap(await client.from("bv2_model_reservations")
    .select("id,project_id,build_id,call_key,step,provider,model,billing_lane,state,reserved_credits,actual_credits,usage,provider_request_ids,metadata,created_at,settled_at,released_at")
    .in("project_id", projectIds).order("created_at"), "Package 14R reservations") || [];
}

async function packageSpend(state) {
  const rows = await reservations(Object.values(state.projects).map((project) => project.id));
  return { rows, calls: rows.length, credits: round(rows.filter((row) => row.state === "settled")
    .reduce((sum, row) => sum + Number(row.actual_credits || 0), 0)) };
}

async function stageEvidence({ owner, projectId, publicBuildId, diagId, startedAt }) {
  const results = await Promise.all([
    client.from("build_jobs").select("id,status,phase,pipeline_version,bv2_build_id,result,error,stop_reason,created_at,updated_at")
      .eq("id", publicBuildId).eq("owner", owner).single(),
    client.from("bv2_builds").select("id,state,profile,request,contract_id,final_snapshot,error,started_at,finished_at")
      .eq("owner", owner).eq("project_id", projectId).gte("started_at", startedAt).order("started_at"),
    client.from("bv2_model_reservations").select("id,build_id,call_key,step,provider,model,billing_lane,state,reserved_credits,actual_credits,usage,provider_request_ids,metadata,created_at,settled_at,released_at")
      .eq("owner", owner).eq("project_id", projectId).gte("created_at", startedAt).order("created_at"),
    client.from("ai_requests").select("id,provider,model,agent,input_tokens,cached_tokens,output_tokens,reasoning_tokens,cost,duration_ms,provider_request_ids,created_at")
      .eq("owner", owner).eq("build_id", diagId).order("created_at"),
    client.from("diag_steps").select("id,kind,label,status,agent,usage,cost,duration_ms,started_at,output")
      .eq("run_id", diagId).order("started_at"),
    client.from("bv2_patches").select("id,build_id,step,outcome,reject_reason,files_changed,created_at")
      .eq("owner", owner).gte("created_at", startedAt).order("created_at"),
    client.from("bv2_retrieval_traces").select("id,build_id,step,query,omitted_count,tokens,included,created_at")
      .eq("owner", owner).gte("created_at", startedAt).order("created_at"),
  ]);
  const names = ["publicBuild", "v2Builds", "reservations", "aiRequests", "diagnosticSteps", "patches", "retrieval"];
  const evidence = {};
  for (let index = 0; index < results.length; index += 1) {
    if (results[index].error) throw new Error(`${names[index]} evidence: ${results[index].error.message}`);
    evidence[names[index]] = results[index].data || (index === 0 ? null : []);
  }
  const buildIds = new Set((evidence.v2Builds || []).map((row) => row.id));
  evidence.patches = (evidence.patches || []).filter((row) => buildIds.has(row.build_id));
  evidence.retrieval = (evidence.retrieval || []).filter((row) => buildIds.has(row.build_id));
  return evidence;
}

async function createProject(owner, name) {
  return unwrap(await client.from("projects").insert({ owner, name, builder_version: "v2" })
    .select("id,name").single(), "qualification project creation");
}

async function runPipeline(state, { stage, project, mode, prompt, ceiling, v2Input = null }) {
  if (state.stages[stage]) throw new Error(`${stage} already exists; Package 14R forbids a second full attempt`);
  const before = await packageSpend(state);
  const remaining = round(TOTAL_CEILING - before.credits);
  if (!(remaining > 0)) throw new Error("HARD STOP: Package 14R credit ceiling exhausted");
  const approved = Math.min(Number(ceiling), remaining);
  const startedAt = new Date().toISOString();
  const diag = await createDiagSession({ owner: state.owner, projectId: project.id,
    kind: `package14r_${stage}`, prompt, client, strictWrites: true });
  await diag.flush();
  const { job, existing } = await createJob({
    owner: { id: state.owner }, projectId: project.id, mode, prompt,
    diag: diag.recorderForJob({ round: 1 }), trigger: "package14r_qualification", taskHint: stage,
    budgetAllowance: approved, byokCostLimit: approved, pipelineVersion: "v2",
    manualModel: null, routingMode: "auto",
    providerSelection: { provider: "codex", billingLane: "connected_allowance", manualModel: null },
    v2Input,
  });
  if (existing) throw new Error(`unexpected active build ${job.id}`);
  state.stages[stage] = { startedAt, projectId: project.id, publicBuildId: job.id,
    workJobId: job.workJobId, diagId: diag.id, ceiling: approved, terminal: false };
  await save(state);
  await emit(`${stage}_queued`, { projectId: project.id, publicBuildId: job.id,
    workJobId: job.workJobId, ceiling: approved, spentBefore: before.credits, routingMode: "auto" });
  let workState = null;
  try {
    workState = (await awaitBuildWork(state.owner, job.workJobId,
      { client, timeoutMs: 60 * 60_000, pollMs: 1_000 }))?.state || null;
  } catch (error) { workState = error.job?.state || "failed"; }
  const evidence = await stageEvidence({ owner: state.owner, projectId: project.id,
    publicBuildId: job.id, diagId: diag.id, startedAt });
  const after = await packageSpend(state);
  if (after.credits > TOTAL_CEILING + 1e-9) throw new Error(`HARD STOP: spent ${after.credits} credits`);
  const stageCredits = round((evidence.reservations || []).filter((row) => row.state === "settled")
    .reduce((sum, row) => sum + Number(row.actual_credits || 0), 0));
  Object.assign(state.stages[stage], { terminal: true, finishedAt: new Date().toISOString(),
    result: evidence.publicBuild?.status === "complete" ? "pass" : "fail",
    stageCredits, workState, evidence });
  await save(state);
  await emit(`${stage}_terminal`, { result: state.stages[stage].result, credits: stageCredits,
    packageCredits: after.credits, calls: evidence.reservations?.length || 0,
    v2States: (evidence.v2Builds || []).map((row) => row.state) });
  return state.stages[stage];
}

async function seedControlledRepair(state) {
  if (state.controlledRepair) return state.controlledRepair;
  const project = state.projects.simple;
  const current = unwrap(await client.from("projects").select("bv2_green_snapshot_id")
    .eq("owner", state.owner).eq("id", project.id).single(), "green snapshot lookup");
  if (!current.bv2_green_snapshot_id) throw new Error("controlled repair requires the simple green snapshot");
  const tree = await snapshots.materialize(state.owner, current.bv2_green_snapshot_id);
  const pathName = Object.keys(tree).find((name) => /\.submitContact\s*\(/.test(String(tree[name])));
  if (!pathName) throw new Error("controlled repair could not locate the verified contact capability call");
  const brokenTree = { ...tree, [pathName]: String(tree[pathName]).replace(/\.submitContact\s*\(/,
    ".__package14rMissingSubmit(") };
  const source = unwrap(await client.from("bv2_builds").insert({ owner: state.owner,
    project_id: project.id, profile: "repair", request: "Package 14R controlled contact mutation defect",
    state: "blocked", error: `${pathName}: required makeContactForm.submitContact call was replaced by a missing method`,
    started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
  }).select("id").single(), "controlled repair source build");
  const checkpoint = await snapshots.createSnapshot(state.owner, project.id, brokenTree, {
    buildId: source.id, parent: current.bv2_green_snapshot_id, reason: "working:package14r-controlled-repair",
  });
  state.controlledRepair = { sourceBuildId: source.id, checkpointId: checkpoint.id,
    parentSnapshotId: current.bv2_green_snapshot_id, path: pathName,
    problems: [`${pathName}: restore the required makeContactForm.submitContact call; do not regenerate unrelated files`] };
  await save(state);
  await emit("controlled_repair_seeded", { sourceBuildId: source.id, checkpointId: checkpoint.id,
    parentSnapshotId: current.bv2_green_snapshot_id, path: pathName });
  return state.controlledRepair;
}

async function archiveZeroSpendPreDispatch(state, stage) {
  const row = state.stages[stage];
  const evidence = row?.evidence || {};
  const v2Builds = evidence.v2Builds || [];
  const previewStop = ["preview_isolation_required", "provider_selection_changed"]
    .includes(evidence.publicBuild?.stop_reason) && v2Builds.length === 0;
  const budgetStop = /cannot fit a useful response inside approved headroom/i.test(
    evidence.publicBuild?.error || "",
  ) && v2Builds.length > 0 && v2Builds.every((build) => build.state === "failed");
  if (!row?.terminal || row.result !== "fail" || Number(row.stageCredits || 0) !== 0
      || (evidence.reservations || []).length
      || (evidence.aiRequests || []).length
      || !(previewStop || budgetStop)) {
    throw new Error(`${stage} is not an approved zero-spend pre-dispatch failure`);
  }
  const sequence = Object.keys(state.stages).filter((key) => key.startsWith(`${stage}_predispatch_`)).length + 1;
  if (sequence > 2) throw new Error(`${stage} exceeded the bounded pre-dispatch correction limit`);
  const key = `${stage}_predispatch_${sequence}`;
  state.stages[key] = row;
  delete state.stages[stage];
  await save(state);
  await emit(`${stage}_predispatch_archived`, { stopReason: evidence.publicBuild.stop_reason,
    credits: 0, calls: 0, v2Builds: v2Builds.length });
}

async function archiveRepairedTreeIdentityFailure(state) {
  const row = state.stages.repair;
  const evidence = row?.evidence || {};
  const reservation = evidence.reservations?.[0];
  const patch = evidence.patches?.[0];
  if (!row?.terminal || row.result !== "fail"
      || !/bv2_snapshots_project_tree/.test(evidence.publicBuild?.error || "")
      || evidence.reservations?.length !== 1 || reservation.state !== "settled"
      || !(Number(reservation.actual_credits || 0) > 0)
      || evidence.patches?.length !== 1 || patch.outcome !== "applied"
      || patch.files_changed?.length !== 1 || patch.files_changed[0] !== state.controlledRepair?.path) {
    throw new Error("repair is not the approved post-patch content-addressed snapshot failure");
  }
  if (state.stages.repair_platform_failure_1) throw new Error("repair platform failure already archived");
  state.stages.repair_platform_failure_1 = row;
  delete state.stages.repair;
  await save(state);
  await emit("repair_platform_failure_archived", { credits: row.stageCredits,
    path: patch.files_changed[0], reason: "content_addressed_snapshot_reuse" });
}

async function cleanup(state) {
  const reports = [];
  for (const project of Object.values(state.projects)) {
    const manifest = await buildProjectErasureManifest(state.owner, project.id, { client });
    reports.push(await eraseProjectPermanently(state.owner, project.id, {
      client, approvedManifestSha256: manifest.manifestSha256,
    }));
  }
  const surviving = unwrap(await client.from("projects").select("id").eq("owner", state.owner)
    .in("id", Object.values(state.projects).map((project) => project.id)), "cleanup verification") || [];
  if (surviving.length) throw new Error("Package 14R project cleanup left survivors");
  state.cleanup = { at: new Date().toISOString(), reports, projectSurvivors: 0 };
  await save(state);
  await emit("cleanup_complete", { projects: reports.length, projectSurvivors: 0 });
}

await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
const state = await load();
const owner = await codexOwner();
if (state.owner && state.owner !== owner.owner) throw new Error("Package 14R owner changed");
state.owner = owner.owner;
state.ownerHash = hash(owner.owner).slice(0, 16);
state.totalCeiling = TOTAL_CEILING;
state.routingMode = "auto";
await save(state);

if (STAGE === "preflight") {
  const spend = await packageSpend(state);
  await emit("preflight", { ownerHash: state.ownerHash, totalCeiling: TOTAL_CEILING,
    existingCredits: spend.credits, existingCalls: spend.calls,
    ownerPreference: owner.preference.routing_mode, qualificationRouting: "auto",
    managedSettlementPaused: process.env.THRALLO_MANAGED_SETTLEMENT_PAUSED === "1" });
} else if (STAGE === "simple") {
  const project = state.projects.simple || await createProject(state.owner, "Package 14R - Northlight Bicycle Repair");
  state.projects.simple = project; await save(state);
  await runPipeline(state, { stage: "simple", project, mode: "build", prompt: SIMPLE_REQUEST, ceiling: 4.5 });
} else if (STAGE === "archive-simple-predispatch") {
  await archiveZeroSpendPreDispatch(state, "simple");
} else if (STAGE === "edit") {
  if (state.stages.simple?.result !== "pass") throw new Error("edit requires a green simple build");
  await runPipeline(state, { stage: "edit", project: state.projects.simple, mode: "iterate",
    prompt: EDIT_REQUEST, ceiling: 4 });
} else if (STAGE === "archive-edit-predispatch") {
  await archiveZeroSpendPreDispatch(state, "edit");
} else if (STAGE === "seed-repair") {
  if (state.stages.simple?.result !== "pass") throw new Error("repair requires a green simple build");
  await seedControlledRepair(state);
} else if (STAGE === "repair") {
  const seed = await seedControlledRepair(state);
  await runPipeline(state, { stage: "repair", project: state.projects.simple, mode: "resume_repair",
    prompt: "Repair the controlled contact-capability regression from the retained working checkpoint.",
    ceiling: 4, v2Input: { sourceBuildId: seed.sourceBuildId, problems: seed.problems } });
} else if (STAGE === "archive-repair-predispatch") {
  await archiveZeroSpendPreDispatch(state, "repair");
} else if (STAGE === "archive-repair-platform-failure") {
  await archiveRepairedTreeIdentityFailure(state);
} else if (STAGE === "booking") {
  if (state.stages.booking) throw new Error("booking already exists; exactly one attempt is authorized");
  const project = state.projects.booking || await createProject(state.owner, "Package 14R - Ember Table booking");
  state.projects.booking = project; await save(state);
  const spend = await packageSpend(state);
  await runPipeline(state, { stage: "booking", project, mode: "build", prompt: BOOKING_REQUEST,
    ceiling: Math.min(8, round(TOTAL_CEILING - spend.credits)) });
} else if (STAGE === "report") {
  const spend = await packageSpend(state);
  await emit("report", { credits: spend.credits, calls: spend.calls,
    stages: Object.fromEntries(Object.entries(state.stages).map(([key, value]) => [key,
      { result: value.result || "pending", credits: value.stageCredits || 0 }])) });
} else if (STAGE === "cleanup") {
  await cleanup(state);
} else {
  throw new Error(`unsupported Package 14R stage: ${STAGE}`);
}
