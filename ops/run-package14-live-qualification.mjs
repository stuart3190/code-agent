// Package 14 live quality runner. It is intentionally stage-oriented: an operator runs one
// approved stage, inspects the durable evidence, and only then advances. Customer feature flags
// are never changed. The runner enables V2 dispatch only in its own process and the durable worker
// remains the sole execution authority.

import crypto from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { createDiagSession } from "../shell/server/lib/appBuild/buildDiagnostics.mjs";
import { createJob } from "../shell/server/lib/buildJobs.mjs";
import { awaitBuildWork } from "../shell/server/lib/buildWorkQueue.mjs";
import { loadEnv } from "../shell/server/lib/env.mjs";
import { serviceClient } from "../shell/server/lib/supabase.mjs";

loadEnv();
process.env.THRALLO_BUILD_WORKER_ENABLED = "1"; // this operator process only

const TOTAL_CEILING = 15;
const MANUAL_MODEL = "connected_allowance:codex:gpt-5.5#medium";
const STAGE = String(process.argv[2] || "preflight").toLowerCase();
const evidenceDir = path.resolve(process.env.PACKAGE14_EVIDENCE_DIR
  || "/home/ubuntu/thrallo-deploy-evidence/package14-live-20260808");
const statePath = path.join(evidenceDir, "state.json");
const eventsPath = path.join(evidenceDir, "evidence.jsonl");
const client = serviceClient();

const SIMPLE_REQUEST = `Build a polished one-page website for Northlight Bicycle Repair, an
independent bicycle workshop in Bristol. Include a distinctive hero, repair services, transparent
turnaround guidance, workshop story, opening hours, and a contact form with name, email and message.
Submitting the form must persist the enquiry through the platform contact capability and show a
clear confirmation. Use the Builder V2 Asset Service for any imagery. Do not use localStorage.`;

const sha = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const round = (value) => Math.round(Number(value || 0) * 10_000) / 10_000;
const safeOwner = (owner) => sha(owner).slice(0, 16);
const event = async (stage, details = {}) => {
  const row = { at: new Date().toISOString(), stage, ...details };
  await appendFile(eventsPath, `${JSON.stringify(row)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(JSON.stringify(row));
};
const save = async (state) => {
  const tmp = `${statePath}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, statePath);
};
const load = async () => {
  try { return JSON.parse(await readFile(statePath, "utf8")); } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { schemaVersion: 1, runId: "package14-live-20260808", projects: {}, stages: {} };
  }
};
const unwrap = (result, action) => {
  if (result.error) throw new Error(`${action}: ${result.error.message}`);
  return result.data;
};

async function resolveCodexOwner() {
  const preferences = unwrap(await client.from("ca_ai_preferences")
    .select("owner,active_provider,routing_mode,preferred_model")
    .eq("active_provider", "codex").order("updated_at", { ascending: false }), "Codex preference");
  for (const preference of preferences || []) {
    const credential = unwrap(await client.from("ca_ai_credentials")
      .select("owner,status,provider,auth_mode")
      .eq("owner", preference.owner).eq("provider", "codex").eq("status", "connected")
      .maybeSingle(), "Codex credential");
    if (credential) return { owner: preference.owner, preference, credential };
  }
  throw new Error("Package 14 requires an active connected Codex owner");
}

async function spendForProjects(projectIds) {
  if (!projectIds.length) return { credits: 0, calls: 0, rows: [] };
  const rows = unwrap(await client.from("bv2_model_reservations")
    .select("id,project_id,build_id,call_key,step,provider,model,billing_lane,state,reserved_credits,actual_credits,usage,provider_request_ids,metadata,created_at,settled_at,released_at")
    .in("project_id", projectIds).order("created_at"), "Package 14 reservations") || [];
  return {
    credits: round(rows.filter((row) => row.state === "settled")
      .reduce((sum, row) => sum + Number(row.actual_credits || 0), 0)),
    calls: rows.length, rows,
  };
}

async function stageEvidence({ owner, projectId, publicBuildId, diagId, startedAt }) {
  const [publicBuild, v2Builds, reservations, ai, steps, patches, retrieval] = await Promise.all([
    client.from("build_jobs").select("id,status,phase,pipeline_version,bv2_build_id,result,error,stop_reason,created_at,updated_at")
      .eq("id", publicBuildId).eq("owner", owner).single(),
    client.from("bv2_builds").select("id,state,profile,parent_snapshot_id,green_snapshot_id,error,created_at,finished_at")
      .eq("owner", owner).eq("project_id", projectId).gte("created_at", startedAt).order("created_at"),
    client.from("bv2_model_reservations").select("id,build_id,call_key,step,provider,model,billing_lane,state,reserved_credits,actual_credits,usage,provider_request_ids,metadata,created_at,settled_at,released_at")
      .eq("owner", owner).eq("project_id", projectId).gte("created_at", startedAt).order("created_at"),
    client.from("ai_requests").select("id,provider,model,agent,input_tokens,cached_tokens,output_tokens,reasoning_tokens,cost,duration_ms,provider_request_id,created_at")
      .eq("owner", owner).eq("build_id", diagId).order("created_at"),
    client.from("diag_steps").select("id,kind,label,status,model,usage,duration_ms,context_meta,started_at")
      .eq("run_id", diagId).order("started_at"),
    client.from("bv2_patches").select("id,build_id,step,outcome,reject_reason,files_changed,created_at")
      .eq("owner", owner).gte("created_at", startedAt).order("created_at"),
    client.from("bv2_retrieval_traces").select("id,build_id,step,omitted_count,tokens,included,created_at")
      .eq("owner", owner).gte("created_at", startedAt).order("created_at"),
  ]);
  for (const [name, result] of Object.entries({ publicBuild, v2Builds, reservations, ai, steps, patches, retrieval })) {
    if (result.error) throw new Error(`${name} evidence: ${result.error.message}`);
  }
  return {
    publicBuild: publicBuild.data,
    v2Builds: v2Builds.data || [], reservations: reservations.data || [], aiRequests: ai.data || [],
    diagnosticSteps: steps.data || [], patches: patches.data || [], retrieval: retrieval.data || [],
  };
}

async function createProject(owner, name) {
  return unwrap(await client.from("projects").insert({ owner, name, builder_version: "v2" })
    .select("id,name").single(), "Package 14 project creation");
}

async function runPipeline({ state, stage, project, mode, prompt, ceiling, kind }) {
  const already = state.stages[stage];
  if (already?.terminal) throw new Error(`${stage} already has terminal evidence; refusing a repeat`);
  const spendBefore = await spendForProjects(Object.values(state.projects).map((row) => row.id));
  const remaining = round(TOTAL_CEILING - spendBefore.credits);
  if (!(remaining > 0)) throw new Error("Package 14 credit ceiling exhausted");
  const stageCeiling = Math.min(Number(ceiling), remaining);
  const startedAt = new Date().toISOString();
  const diag = await createDiagSession({ owner: state.owner, projectId: project.id, kind, prompt, client, strictWrites: true });
  await diag.flush();
  const { job, existing } = await createJob({
    owner: { id: state.owner }, projectId: project.id, mode, prompt,
    diag: diag.recorderForJob({ round: 1 }), trigger: "package14_qualification",
    taskHint: stage, budgetAllowance: stageCeiling, byokCostLimit: stageCeiling,
    pipelineVersion: "v2", manualModel: MANUAL_MODEL,
    providerSelection: { provider: "codex", billingLane: "connected_allowance", manualModel: MANUAL_MODEL },
  });
  if (existing) throw new Error(`unexpected existing ${stage} job ${job.id}`);
  state.stages[stage] = { startedAt, projectId: project.id, publicBuildId: job.id, workJobId: job.workJobId,
    diagId: diag.id, ceiling: stageCeiling, terminal: false };
  await save(state);
  await event(`${stage}_queued`, { projectId: project.id, publicBuildId: job.id, workJobId: job.workJobId,
    diagId: diag.id, ceiling: stageCeiling, spentBefore: spendBefore.credits });
  let work = null;
  try {
    work = await awaitBuildWork(state.owner, job.workJobId, { client, timeoutMs: 60 * 60_000, pollMs: 1_000 });
  } catch (error) {
    work = error.job || null;
  }
  const evidence = await stageEvidence({ owner: state.owner, projectId: project.id, publicBuildId: job.id,
    diagId: diag.id, startedAt });
  const stageCredits = round(evidence.reservations.filter((row) => row.state === "settled")
    .reduce((sum, row) => sum + Number(row.actual_credits || 0), 0));
  const spendAfter = await spendForProjects(Object.values(state.projects).map((row) => row.id));
  if (spendAfter.credits > TOTAL_CEILING) throw new Error(`HARD STOP: Package 14 spent ${spendAfter.credits} credits`);
  Object.assign(state.stages[stage], {
    terminal: true, finishedAt: new Date().toISOString(), stageCredits,
    result: evidence.publicBuild?.status === "complete" ? "pass" : "fail",
    evidence,
    workState: work?.state || null,
  });
  await save(state);
  await event(`${stage}_terminal`, {
    result: state.stages[stage].result, credits: stageCredits, packageCredits: spendAfter.credits,
    calls: evidence.reservations.length, publicStatus: evidence.publicBuild?.status,
    v2States: evidence.v2Builds.map((row) => row.state),
  });
  return state.stages[stage];
}

await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
const state = await load();
const codex = await resolveCodexOwner();
if (state.owner && state.owner !== codex.owner) throw new Error("Package 14 owner changed; refusing mixed evidence");
state.owner = codex.owner;
state.ownerHash = safeOwner(codex.owner);
state.manualModel = MANUAL_MODEL;
state.totalCeiling = TOTAL_CEILING;
await save(state);

if (STAGE === "preflight") {
  const spend = await spendForProjects(Object.values(state.projects).map((row) => row.id));
  await event("preflight", { ownerHash: state.ownerHash, activeProvider: "codex",
    routingMode: codex.preference.routing_mode, existingPackageCredits: spend.credits,
    totalCeiling: TOTAL_CEILING, managedSettlementPaused: process.env.THRALLO_MANAGED_SETTLEMENT_PAUSED === "1" });
} else if (STAGE === "simple") {
  const project = state.projects.simple || await createProject(state.owner, "Package 14 - Northlight Bicycle Repair");
  state.projects.simple = project;
  await save(state);
  await runPipeline({ state, stage: "simple", project, mode: "build", prompt: SIMPLE_REQUEST,
    ceiling: 3, kind: "app_build_v2_package14" });
} else if (STAGE === "report") {
  const spend = await spendForProjects(Object.values(state.projects).map((row) => row.id));
  await event("report", { ownerHash: state.ownerHash, credits: spend.credits, calls: spend.calls,
    stages: Object.fromEntries(Object.entries(state.stages).map(([key, value]) => [key, {
      result: value.result || "pending", credits: value.stageCredits || 0,
    }])) });
} else {
  throw new Error(`Unsupported Package 14 stage: ${STAGE}`);
}
