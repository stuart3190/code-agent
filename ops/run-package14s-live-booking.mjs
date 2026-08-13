// Package 14S: exactly one AUTO-routed live booking build and, only if a durable working
// checkpoint exists, at most one targeted resume-repair. Aggregate connected-allowance spend
// is hard-capped at the explicitly approved 15 internal credits. Evidence is private and incremental.

import crypto from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { classifyComplexity } from "../shell/server/lib/appBuild/buildProfile.mjs";
import { createDiagSession } from "../shell/server/lib/appBuild/buildDiagnostics.mjs";
import { createJob } from "../shell/server/lib/buildJobs.mjs";
import { awaitBuildWork } from "../shell/server/lib/buildWorkQueue.mjs";
import { deriveModulePlan } from "../shell/server/lib/builderV2/contractTiering.mjs";
import { loadEnv } from "../shell/server/lib/env.mjs";
import { buildProjectErasureManifest, eraseProjectPermanently } from "../shell/server/lib/erasureService.mjs";
import { serviceClient } from "../shell/server/lib/supabase.mjs";
import { previewProvider } from "../shell/server/preview/index.mjs";
import { requireFreshWorkerPreviewProof } from "../build-worker/previewIsolationPreflight.mjs";

loadEnv();
process.env.THRALLO_BUILD_WORKER_ENABLED = "1"; // operator only; customer shell routing stays dark

const TOTAL_CEILING = 15;
const STAGE = String(process.argv[2] || "preflight").toLowerCase();
const evidenceDir = path.resolve(process.env.PACKAGE14S_EVIDENCE_DIR
  || "/home/ubuntu/thrallo-deploy-evidence/package14s-live-20260809");
const statePath = path.join(evidenceDir, "state.json");
const eventsPath = path.join(evidenceDir, "evidence.jsonl");
const client = serviceClient();

const BOOKING_REQUEST = `Build a polished multi-step booking application for Ember Table, a
chef-led supper club. The model owns the distinctive editorial visual design. Use the enforced
booking module plan and the headless makeBookingSystem and makeWizardMachine capabilities. Guests
must select a date, an available slot, party size and validated contact details, review the exact
selection, confirm with a durable booking reference, reload and recover the confirmed state, cancel
the booking, and reload into an explicit cancelled state. Enforce slot capacity honestly. Persist
through platform capabilities; never use localStorage and never reimplement either capability.`;

const round = (value) => Math.round(Number(value || 0) * 10_000) / 10_000;
const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
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
    return { schemaVersion: 1, runId: "package14s-live-20260809", stages: {} };
  }
};

async function connectedCodexOwner() {
  const preferences = unwrap(await client.from("ca_ai_preferences")
    .select("owner,active_provider,routing_mode,preferred_model").eq("active_provider", "codex")
    .order("updated_at", { ascending: false }), "Codex preferences") || [];
  for (const preference of preferences) {
    const credential = unwrap(await client.from("ca_ai_credentials")
      .select("owner,status,provider,auth_mode").eq("owner", preference.owner)
      .eq("provider", "codex").eq("status", "connected").maybeSingle(), "Codex credential");
    if (credential) return { owner: preference.owner, preference };
  }
  throw new Error("Package 14S requires an active connected Codex owner");
}

async function workerPreviewPreflight() {
  const result = await client.from("build_worker_nodes")
    .select("worker_id,state,job_types,heartbeat_at,metadata")
    .order("heartbeat_at", { ascending: false }).limit(20);
  if (result.error) throw Object.assign(new Error(`worker preview preflight: ${result.error.message}`), {
    code: "preview_isolation_required",
  });
  return requireFreshWorkerPreviewProof(result.data || []);
}

const BASELINE_TABLES = [
  "projects", "build_jobs", "published_sites", "deployments", "custom_domains",
  "ai_requests", "ca_usage_records", "bv2_builds", "bv2_model_reservations",
  "build_work_jobs", "publish_releases", "publish_activation_intents",
];

async function baseline() {
  const out = {};
  for (const table of BASELINE_TABLES) {
    const rows = unwrap(await client.from(table).select("*"), `${table} baseline`) || [];
    const canonicalRows = rows.map((row) => JSON.stringify(row)).sort();
    out[table] = { count: rows.length, sha256: sha256(JSON.stringify(canonicalRows)) };
  }
  return out;
}

async function reservations(projectId) {
  return unwrap(await client.from("bv2_model_reservations")
    .select("id,project_id,build_id,call_key,step,provider,model,billing_lane,state,reserved_credits,actual_credits,usage,provider_request_ids,metadata,created_at,settled_at,released_at")
    .eq("project_id", projectId).order("created_at"), "Package 14S reservations") || [];
}

async function spend(projectId) {
  const rows = await reservations(projectId);
  return { rows, calls: rows.length, credits: round(rows.filter((row) => row.state === "settled")
    .reduce((sum, row) => sum + Number(row.actual_credits || 0), 0)) };
}

async function collectEvidence({ owner, projectId, publicBuildId, diagId, startedAt }) {
  const queries = {
    publicBuild: client.from("build_jobs").select("id,status,phase,pipeline_version,bv2_build_id,result,error,stop_reason,created_at,updated_at")
      .eq("id", publicBuildId).eq("owner", owner).single(),
    v2Builds: client.from("bv2_builds").select("id,state,profile,request,contract_id,final_snapshot,error,started_at,finished_at")
      .eq("owner", owner).eq("project_id", projectId).gte("started_at", startedAt).order("started_at"),
    contracts: client.from("bv2_contracts").select("id,build_id,version,contract,capabilities,created_at")
      .eq("owner", owner).eq("project_id", projectId).gte("created_at", startedAt).order("created_at"),
    reservations: client.from("bv2_model_reservations").select("id,build_id,call_key,step,provider,model,billing_lane,state,reserved_credits,actual_credits,usage,provider_request_ids,metadata,created_at,settled_at,released_at")
      .eq("owner", owner).eq("project_id", projectId).gte("created_at", startedAt).order("created_at"),
    aiRequests: client.from("ai_requests").select("id,provider,model,agent,input_tokens,cached_tokens,output_tokens,reasoning_tokens,cost,duration_ms,provider_request_ids,created_at")
      .eq("owner", owner).eq("build_id", diagId).order("created_at"),
    diagnosticSteps: client.from("diag_steps").select("id,kind,label,status,agent,usage,cost,duration_ms,started_at,output")
      .eq("run_id", diagId).order("started_at"),
    patches: client.from("bv2_patches").select("id,build_id,step,outcome,reject_reason,files_changed,created_at")
      .eq("owner", owner).gte("created_at", startedAt).order("created_at"),
    retrieval: client.from("bv2_retrieval_traces").select("id,build_id,step,query,omitted_count,tokens,included,created_at")
      .eq("owner", owner).gte("created_at", startedAt).order("created_at"),
    verdicts: client.from("bv2_verification_cache").select("journey_id,owners_hash,verdict,snapshot_id,created_at")
      .eq("owner", owner).eq("project_id", projectId).gte("created_at", startedAt).order("created_at"),
    workJobs: client.from("build_work_jobs").select("id,build_id,job_type,state,attempts,error_classification,error,result_ref,created_at,started_at,finished_at")
      .eq("owner", owner).eq("project_id", projectId).gte("created_at", startedAt).order("created_at"),
    workResults: client.from("build_work_results").select("id,job_id,result,result_sha256,exit_code,created_at")
      .eq("owner", owner).eq("project_id", projectId).gte("created_at", startedAt).order("created_at"),
    workEvents: client.from("build_work_events").select("seq,job_id,event_type,details,created_at")
      .eq("owner", owner).eq("project_id", projectId).gte("created_at", startedAt).order("seq"),
  };
  const evidence = {};
  for (const [name, query] of Object.entries(queries)) {
    const result = await query;
    if (result.error) throw new Error(`${name} evidence: ${result.error.message}`);
    evidence[name] = result.data || (name === "publicBuild" ? null : []);
  }
  const buildIds = new Set(evidence.v2Builds.map((row) => row.id));
  evidence.patches = evidence.patches.filter((row) => buildIds.has(row.build_id));
  evidence.retrieval = evidence.retrieval.filter((row) => buildIds.has(row.build_id));
  const contract = evidence.contracts.at(-1)?.contract || null;
  evidence.derived = {
    complexity: classifyComplexity({ prompt: BOOKING_REQUEST, contract }),
    modulePlan: contract ? deriveModulePlan(contract, contract.journeys || []) : [],
    capabilityBindings: evidence.contracts.at(-1)?.capabilities || [],
  };
  const compileJobs = evidence.workJobs.filter((job) => job.job_type === "compile");
  const browserJobs = evidence.workJobs.filter((job) => job.job_type === "browser_verify");
  const resultByJob = new Map(evidence.workResults.map((row) => [row.job_id, row]));
  evidence.derived.firstCompile = compileJobs.length
    ? { ...compileJobs[0], result: resultByJob.get(compileJobs[0].id)?.result || null } : null;
  evidence.derived.browserJourneys = browserJobs.map((job) => ({
    ...job, result: resultByJob.get(job.id)?.result || null,
  }));
  const required = new Set((contract?.journeys || []).map((journey) => journey.id));
  const latest = new Map();
  for (const row of evidence.verdicts) latest.set(row.journey_id, row.verdict);
  const journeyResults = [...required].map((journeyId) => ({ journeyId, verdict: latest.get(journeyId) || null }));
  evidence.derived.strictQuality = {
    green: evidence.v2Builds.some((build) => build.state === "green"),
    journeys: journeyResults,
    pass: evidence.v2Builds.some((build) => build.state === "green")
      && journeyResults.every((row) => row.verdict?.status === "pass"),
  };
  return evidence;
}

async function runLifecycle(state, { stage, mode, prompt, ceiling, v2Input = null }) {
  if (state.stages[stage]) throw new Error(`${stage} already exists; Package 14S forbids replay`);
  const before = await spend(state.project.id);
  const remaining = round(TOTAL_CEILING - before.credits);
  if (!(remaining > 0)) throw new Error("HARD STOP: Package 14S credit ceiling exhausted");
  const approved = Math.min(Number(ceiling), remaining);
  const startedAt = new Date().toISOString();
  const diag = await createDiagSession({ owner: state.owner, projectId: state.project.id,
    kind: `package14s_${stage}`, prompt, client, strictWrites: true });
  await diag.flush();
  const { job, existing } = await createJob({
    owner: { id: state.owner }, projectId: state.project.id, mode, prompt,
    diag: diag.recorderForJob({ round: 1 }), trigger: "package14s_qualification", taskHint: stage,
    budgetAllowance: approved, byokCostLimit: approved, pipelineVersion: "v2",
    manualModel: null, routingMode: "auto",
    providerSelection: { provider: "codex", billingLane: "connected_allowance", manualModel: null },
    v2Input: { maxRepairs: 1, ...(v2Input || {}) },
  });
  if (existing) throw new Error(`unexpected active build ${job.id}`);
  state.stages[stage] = { startedAt, publicBuildId: job.id, workJobId: job.workJobId,
    diagId: diag.id, ceiling: approved, terminal: false };
  await save(state);
  await emit(`${stage}_queued`, { projectId: state.project.id, publicBuildId: job.id,
    workJobId: job.workJobId, ceiling: approved, spentBefore: before.credits, routingMode: "auto" });
  let workState = null;
  try {
    workState = (await awaitBuildWork(state.owner, job.workJobId,
      { client, timeoutMs: 60 * 60_000, pollMs: 1_000 }))?.state || null;
  } catch (error) { workState = error.job?.state || "failed"; }
  const evidence = await collectEvidence({ owner: state.owner, projectId: state.project.id,
    publicBuildId: job.id, diagId: diag.id, startedAt });
  const after = await spend(state.project.id);
  if (after.credits > TOTAL_CEILING + 1e-9) throw new Error(`HARD STOP: spent ${after.credits} credits`);
  const stageCredits = round(evidence.reservations.filter((row) => row.state === "settled")
    .reduce((sum, row) => sum + Number(row.actual_credits || 0), 0));
  Object.assign(state.stages[stage], { terminal: true, finishedAt: new Date().toISOString(),
    result: evidence.derived.strictQuality.pass ? "pass" : "fail", stageCredits, workState, evidence });
  await save(state);
  await emit(`${stage}_terminal`, { result: state.stages[stage].result, credits: stageCredits,
    packageCredits: after.credits, calls: evidence.reservations.length,
    complexity: evidence.derived.complexity.level,
    v2States: evidence.v2Builds.map((row) => row.state),
    strictQuality: evidence.derived.strictQuality.pass });
  return state.stages[stage];
}

/**
 * RETAIN THE GENERATED SOURCE OF A FAILED RUN, BEFORE THE PROJECT IS ERASED.
 *
 * Runs #7 and #8 each cost about 6.8 credits, each failed on the generated application, and in
 * both cases the only artefact that could explain — or validate a rule written in response — was
 * destroyed by this very stage before it could be read. `bv2_snapshots` and `bv2_blobs` were zero
 * by the time anyone looked.
 *
 * Teardown itself is UNCHANGED: nothing is exempted, the project is still erased completely, and
 * the baseline parity proof still has to pass. This copies the tree OUT first. An exemption would
 * have weakened a load-bearing guarantee to buy the same evidence.
 *
 * Scope: failed runs only, the retained working/candidate tree, written beside the run's own
 * evidence at mode 0700. These are synthetic operator-owned applications containing no customer
 * data; they expire when the evidence directory is pruned. Nothing here runs for a customer
 * project — this file is the qualification runner.
 */
async function retainGeneratedSource(state) {
  const booking = state.stages?.booking;
  if (!booking || booking.result === "pass") return null;
  const bv2 = booking.evidence?.publicBuild?.result?._worker?.bv2 || {};
  const ids = [...new Set([bv2.workingSnapshotId, bv2.candidateSnapshotId].filter(Boolean))];
  if (!ids.length) return { retained: 0, reason: "the failed build left no snapshot" };

  try {
    const [{ createSnapshotStore }, { supabaseSnapshotStorage }] = await Promise.all([
      import("../shell/server/lib/builderV2/snapshotStore.mjs"),
      import("../shell/server/lib/builderV2/supabaseTwins.mjs"),
    ]);
    const store = createSnapshotStore(supabaseSnapshotStorage({ client }));
    let files = 0;
    for (const id of ids) {
      const tree = await store.materialize(state.owner, id);
      for (const [relative, content] of Object.entries(tree || {})) {
        const target = path.join(evidenceDir, "generated-source", id, relative);
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, String(content), { mode: 0o600 });
        files += 1;
      }
    }
    return { retained: ids.length, files, snapshots: ids };
  } catch (error) {
    // Retention is forensics, never a gate: a failure here must not stop the erasure it precedes.
    return { retained: 0, error: String(error?.message || error).slice(0, 160) };
  }
}

async function archiveZeroSpendPreDispatchRepair(state) {
  const row = state.stages?.repair;
  const evidence = row?.evidence || {};
  const v2Builds = evidence.v2Builds || [];
  const eligible = row?.terminal && row.result === "fail" && Number(row.stageCredits || 0) === 0
    && !(evidence.reservations || []).length && !(evidence.aiRequests || []).length
    && /cannot fit a useful response inside approved headroom/i.test(evidence.publicBuild?.error || "")
    && v2Builds.length > 0 && v2Builds.every((build) => build.state === "failed");
  if (!eligible) throw new Error("the single targeted repair was already used");
  if (state.stages.repair_predispatch_1) {
    throw new Error("the bounded zero-spend repair pre-dispatch retry was already used");
  }
  state.stages.repair_predispatch_1 = row;
  delete state.stages.repair;
  await save(state);
  await emit("repair_predispatch_archived", {
    code: "budget_ceiling", credits: 0, calls: 0, v2Builds: v2Builds.length,
  });
}

async function archiveZeroSpendPreExecutionReverify(state) {
  const attempt = state.stages.reverify;
  if (!attempt || state.stages.reverify_preexecution_1) return false;
  const evidence = attempt.evidence || {};
  if (Number(attempt.stageCredits || 0) !== 0
    || (evidence.reservations || []).length
    || (evidence.aiRequests || []).length
    || (evidence.v2Builds || []).length
    || attempt.workState !== "failed") return false;
  state.stages.reverify_preexecution_1 = attempt;
  delete state.stages.reverify;
  await save(state);
  await emit("reverify_zero_spend_preexecution_archived", {
    publicBuildId: attempt.publicBuildId,
    workJobId: attempt.workJobId,
    reason: "worker stopped before checkpoint verification began",
  });
  return true;
}

async function archiveZeroSpendPreDispatchRepair2(state) {
  const row = state.stages?.repair2;
  const evidence = row?.evidence || {};
  const v2Builds = evidence.v2Builds || [];
  const eligible = row?.terminal && row.result === "fail" && Number(row.stageCredits || 0) === 0
    && !(evidence.reservations || []).length && !(evidence.aiRequests || []).length
    && /cannot fit a useful response inside approved headroom/i.test(evidence.publicBuild?.error || "")
    && v2Builds.length > 0 && v2Builds.every((build) => build.state === "failed");
  if (!eligible) throw new Error("the final bounded browser-informed repair was already used");
  if (state.stages.repair2_predispatch_1) {
    throw new Error("the bounded zero-spend final repair retry was already used");
  }
  state.stages.repair2_predispatch_1 = row;
  delete state.stages.repair2;
  await save(state);
  await emit("repair2_predispatch_archived", {
    code: "budget_ceiling", credits: 0, calls: 0, v2Builds: v2Builds.length,
  });
}

async function cleanup(state) {
  if (state.cleanup) throw new Error("cleanup already completed");
  const retention = await retainGeneratedSource(state);
  const preview = await previewProvider().stop(state.project.id);
  const manifest = await buildProjectErasureManifest(state.owner, state.project.id, { client });
  const report = await eraseProjectPermanently(state.owner, state.project.id, {
    client, approvedManifestSha256: manifest.manifestSha256,
  });
  const survivor = unwrap(await client.from("projects").select("id").eq("owner", state.owner)
    .eq("id", state.project.id).maybeSingle(), "cleanup verification");
  if (survivor) throw new Error("Package 14S cleanup left the project");
  const after = await baseline();
  const parity = Object.fromEntries(BASELINE_TABLES.map((table) => [table, {
    before: state.baseline[table], after: after[table],
    match: state.baseline[table].count === after[table].count
      && state.baseline[table].sha256 === after[table].sha256,
  }]));
  // Retention is announced in both places. It ran silently after run #9 — the files were on disk
  // and nothing said so — and a forensic step nobody can see is one that stops working unnoticed,
  // discovered only the next time it is needed, which is always after a failure.
  state.cleanup = { at: new Date().toISOString(), preview, report, parity, retention,
    pass: Object.values(parity).every((row) => row.match) };
  await save(state);
  await emit("cleanup_complete", { projectSurvivors: 0, preview, parity: state.cleanup.pass, retention });
}

await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
const state = await load();
const owner = await connectedCodexOwner();
if (state.owner && state.owner !== owner.owner) throw new Error("Package 14S owner changed");
state.owner = owner.owner;
state.ownerHash = sha256(owner.owner).slice(0, 16);
state.totalCeiling = TOTAL_CEILING;
await save(state);

if (STAGE === "preflight") {
  if (state.project || Object.keys(state.stages).length) throw new Error("Package 14S run already started");
  let workerPreview;
  try {
    workerPreview = await workerPreviewPreflight();
  } catch (error) {
    await emit("preflight_failed", { code: "preview_isolation_required", providerCalls: 0,
      tokens: 0, credits: 0, detail: error.message });
    throw error;
  }
  state.baseline = await baseline();
  state.project = unwrap(await client.from("projects").insert({
    owner: state.owner, name: "Package 14S - Ember Table booking", builder_version: "v2",
  }).select("id,name").single(), "qualification project creation");
  await save(state);
  await emit("preflight", { ownerHash: state.ownerHash, totalCeiling: TOTAL_CEILING,
    projectId: state.project.id, ownerPreference: owner.preference.routing_mode,
    qualificationRouting: "auto", managedSettlementPaused: process.env.THRALLO_MANAGED_SETTLEMENT_PAUSED === "1",
    workerPreview: { workerId: workerPreview.workerId, heartbeatAt: workerPreview.heartbeatAt,
      resolvedMode: workerPreview.resolvedMode, provisiondOrigin: workerPreview.provisiondOrigin,
      health: workerPreview.health, preview: workerPreview.preview, teardown: workerPreview.teardown } });
} else if (STAGE === "booking") {
  if (!state.project) throw new Error("run preflight first");
  await runLifecycle(state, { stage: "booking", mode: "build", prompt: BOOKING_REQUEST, ceiling: TOTAL_CEILING });
} else if (STAGE === "repair") {
  if (state.stages.repair) await archiveZeroSpendPreDispatchRepair(state);
  const first = state.stages.booking;
  if (!first?.terminal || first.result === "pass") throw new Error("repair requires one completed red booking build");
  const v2 = first.evidence?.v2Builds?.at(-1);
  const bv2Result = first.evidence?.publicBuild?.result?._worker?.bv2 || {};
  const workingSnapshotId = bv2Result.workingSnapshotId;
  if (!v2?.id || !workingSnapshotId) {
    throw new Error("first-pass generation has no resumable checkpoint; full regeneration is forbidden");
  }
  const problems = [
    ...(bv2Result.pendingIncrements || []).map((row) => `required journey ${row.journeyId}: ${row.reason || "red"}`),
    ...(first.evidence?.derived?.strictQuality?.journeys || []).flatMap((row) => {
      if (!row.verdict) return [`required journey ${row.journeyId}: not yet verified`];
      return (row.verdict.steps || []).filter((step) => step.status !== "pass").map((step) =>
        `required journey ${row.journeyId}, ${step.status} at ${step.action}: ${step.detail}; expected ${step.expect}`);
    }),
    bv2Result.error || v2.error,
  ].filter(Boolean).slice(0, 20).map((problem) => String(problem).slice(0, 1_000));
  const current = await spend(state.project.id);
  const remaining = round(TOTAL_CEILING - current.credits);
  if (!(remaining > 0)) throw new Error("no approved Package 14S headroom remains for targeted repair");
  await runLifecycle(state, { stage: "repair", mode: "resume_repair",
    prompt: "Repair only the exact failed contracted booking journeys from the retained working checkpoint; do not regenerate the application.",
    ceiling: remaining, v2Input: { sourceBuildId: v2.id, problems } });
} else if (STAGE === "reverify") {
  await archiveZeroSpendPreExecutionReverify(state);
  if (state.stages.reverify) throw new Error("the zero-model platform re-verification was already used");
  const repaired = state.stages.repair;
  if (!repaired?.terminal || repaired.result === "pass" || Number(repaired.stageCredits || 0) <= 0) {
    throw new Error("reverify requires one completed paid checkpoint repair that remained red");
  }
  const reservations = repaired.evidence?.reservations || [];
  if (reservations.length !== 1 || reservations[0].state !== "settled") {
    throw new Error("reverify requires exactly one settled repair provider call");
  }
  const v2 = repaired.evidence?.v2Builds?.at(-1);
  const bv2Result = repaired.evidence?.publicBuild?.result?._worker?.bv2 || {};
  if (!v2?.id || !bv2Result.workingSnapshotId) {
    throw new Error("paid repair left no checkpoint to re-verify");
  }
  const current = await spend(state.project.id);
  const remaining = round(TOTAL_CEILING - current.credits);
  if (!(remaining > 0)) throw new Error("no approved Package 14S headroom remains");
  await runLifecycle(state, { stage: "reverify", mode: "resume_verify",
    prompt: "Re-verify the retained paid repair against the current protected platform runtime; make no model call and no generated-source change.",
    ceiling: remaining, v2Input: { sourceBuildId: v2.id, maxRepairs: 0 } });
} else if (STAGE === "repair2") {
  if (state.stages.repair2) await archiveZeroSpendPreDispatchRepair2(state);
  const verified = state.stages.reverify;
  if (!verified?.terminal || verified.result === "pass" || Number(verified.stageCredits || 0) !== 0) {
    throw new Error("repair2 requires a completed zero-spend platform re-verification that remained red");
  }
  if ((verified.evidence?.reservations || []).length || (verified.evidence?.aiRequests || []).length) {
    throw new Error("repair2 refuses a re-verification that made a provider call");
  }
  const v2 = verified.evidence?.v2Builds?.at(-1);
  const bv2Result = verified.evidence?.publicBuild?.result?._worker?.bv2 || {};
  if (!v2?.id || !bv2Result.workingSnapshotId) throw new Error("re-verification left no checkpoint for final repair");
  const problems = (verified.evidence?.verdicts || []).flatMap((row) => (row.verdict?.steps || [])
    .filter((step) => !["pass", "skipped", "not_reached"].includes(step.status))
    .map((step) => `journey ${row.journey_id}: ${step.action}: ${step.detail}`));
  if (!problems.length) throw new Error("re-verification recorded no actionable browser failures");
  const current = await spend(state.project.id);
  const remaining = round(TOTAL_CEILING - current.credits);
  if (!(remaining > 0)) throw new Error("no approved Package 14S headroom remains for final repair");
  await runLifecycle(state, { stage: "repair2", mode: "resume_repair",
    prompt: "Apply one final bounded repair to only the exact remaining failed contracted journeys; preserve the working application and do not regenerate it.",
    ceiling: remaining, v2Input: { sourceBuildId: v2.id, problems } });
} else if (STAGE === "report") {
  const current = state.project ? await spend(state.project.id) : { credits: 0, calls: 0 };
  await emit("report", { credits: current.credits, calls: current.calls,
    booking: state.stages.booking?.result || "not-run", repair: state.stages.repair?.result || "not-used",
    reverify: state.stages.reverify?.result || "not-used", repair2: state.stages.repair2?.result || "not-used",
    finalPass: state.stages.repair2?.result === "pass" || state.stages.reverify?.result === "pass"
      || state.stages.repair?.result === "pass" || state.stages.booking?.result === "pass" });
} else if (STAGE === "cleanup") {
  await cleanup(state);
} else {
  throw new Error(`unsupported Package 14S stage: ${STAGE}`);
}
