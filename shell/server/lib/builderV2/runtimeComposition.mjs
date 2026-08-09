// Builder V2 production composition root.
//
// This is the only place where V2's model, persistence, worker sandbox, preview and diagnostic
// seams are assembled. The orchestrator remains deterministic/injectable; this module supplies
// the production twins. It is deliberately worker-only: loading it is harmless in the shell,
// but execution fails closed unless the durable build worker owns the job.

import crypto from "node:crypto";
import { rm } from "node:fs/promises";

import { clone, fromScaffold } from "../../../../src/engine/fileTree.mjs";
import { REACT_VITE } from "../../../../src/scaffolds/reactVite.mjs";
import { classifyComplexity } from "../appBuild/buildProfile.mjs";
import { createBudgetLedger } from "../appBuild/budgetLedger.mjs";
import { resolveBuildContext } from "../appBuild/buildContext.mjs";
import { managedSettlementPaused, usesManagedCredits } from "../appBuild/providerPolicy.mjs";
import { createDiagSession } from "../appBuild/buildDiagnostics.mjs";
import { proveGeneratedRuntimeBackend, withRuntimeEnv } from "../runtimeEnv.mjs";
import { previewProvider } from "../../preview/index.mjs";
import { serviceClient } from "../supabase.mjs";
import { runSandboxJob } from "../../../../build-worker/sandboxRunner.mjs";
import { createAssetService } from "./assets/assetService.mjs";
import { createOptimiser } from "./assets/optimiser.mjs";
import { pexelsProvider } from "./assets/pexelsProvider.mjs";
import { persistContract, tierContract } from "./contractTiering.mjs";
import { compareGraphIndexes, manifestOf } from "./graphParity.mjs";
import { indexTree, INDEXER_VERSION } from "./indexer.mjs";
import { createModelLanes } from "./modelLanes.mjs";
import { supabaseModelReservations } from "./modelReservations.mjs";
import { createOrchestrator, supabaseBuildStore } from "./orchestrator.mjs";
import { recordFacts } from "./knowledge.mjs";
import { routeV2Step } from "./router.mjs";
import { createSnapshotStore } from "./snapshotStore.mjs";
import {
  loadIndex, persistIndex, supabaseSnapshotStorage,
} from "./supabaseTwins.mjs";
import { supabaseVerificationCache } from "./verification.mjs";
import { assertExecutableCandidate } from "../modelCatalogue.mjs";

const uuid = () => crypto.randomUUID();
const numberEnv = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

function laneProviderId(context) {
  return context.policy?.primaryProvider === "managed" ? "managed" : context.policy?.primaryProvider;
}

export function assertQueuedProviderSelection(expected, context) {
  if (!expected) return;
  const actual = {
    provider: context.policy?.primaryProvider || context.providerLabel || "unknown",
    billingLane: context.policy?.billingLane || (context.byok ? "byok_api" : "managed"),
  };
  if (expected.provider !== actual.provider || expected.billingLane !== actual.billingLane) {
    throw Object.assign(new Error(
      `Builder V2 provider selection changed while queued (${expected.provider}/${expected.billingLane} -> ${actual.provider}/${actual.billingLane}); retry to approve the current lane.`,
    ), { code: "provider_selection_changed" });
  }
}

export function stepOutputPolicy(step) {
  return {
    contract: { estimatedCredits: 0.5, maxOutputTokens: 6_000, callCeilingCredits: 3 },
    core: { estimatedCredits: 2, maxOutputTokens: 16_000, callCeilingCredits: 6 },
    // repairAllowanceCredits is the nominal planning target, not a hard reservation ceiling.
    // modelLanes sizes a targeted output envelope and caps it at the live whole-build headroom.
    repair: { estimatedCredits: 1, maxOutputTokens: 10_000, callCeilingCredits: 6, repairAllowanceCredits: 4 },
    edit: { estimatedCredits: 0.5, maxOutputTokens: 8_000, callCeilingCredits: 4 },
    increment: { estimatedCredits: 0.5, maxOutputTokens: 8_000, callCeilingCredits: 4 },
  }[step] || { estimatedCredits: 0.5, maxOutputTokens: 8_000, callCeilingCredits: 4 };
}

function candidateSet(context) {
  const quality = context.buildProvider("generate");
  const balanced = context.buildProvider("edit");
  const fast = context.buildProvider("fast");
  const laneProvider = laneProviderId(context);
  const transport = (provider) => provider.provider || provider.providerId
    || provider.decision?.provider || context.providerLabel || laneProvider;
  const rows = [
    { provider: transport(quality), laneProvider, model: quality.model, tier: "quality", billingLane: context.policy.billingLane,
      estimatedCredits: numberEnv("THRALLO_BV2_QUALITY_EXPECTED_CREDITS", 2), executable: quality },
    { provider: transport(balanced), laneProvider, model: balanced.model, tier: "balanced", billingLane: context.policy.billingLane,
      estimatedCredits: numberEnv("THRALLO_BV2_BALANCED_EXPECTED_CREDITS", 0.75), executable: balanced },
    { provider: transport(fast), laneProvider, model: fast.model, tier: "fast", billingLane: context.policy.billingLane,
      estimatedCredits: numberEnv("THRALLO_BV2_FAST_EXPECTED_CREDITS", 0.35), executable: fast },
  ];
  // A transport may expose one model for every intent (Codex currently does). Keep the strongest
  // tier and one executable rather than pretending duplicate candidates create a choice.
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.provider}:${row.model}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((row) => assertExecutableCandidate({
    ...row,
    reasoningProfile: row.executable?.reasoningEffort || (row.provider === "codex" ? "medium" : "default"),
  }));
}

async function routingHistory(client, owner) {
  const { data, error } = await client.from("bv2_model_reservations")
    .select("provider,model,actual_credits,metadata,build_id")
    .eq("owner", owner).eq("state", "settled")
    .order("created_at", { ascending: false }).limit(200);
  if (error) throw new Error(`Builder V2 routing history: ${error.message}`);
  const buildIds = [...new Set((data || []).map((row) => row.build_id))];
  let states = new Map();
  if (buildIds.length) {
    const { data: builds, error: buildError } = await client.from("bv2_builds")
      .select("id,state").eq("owner", owner).in("id", buildIds);
    if (buildError) throw new Error(`Builder V2 routing outcomes: ${buildError.message}`);
    states = new Map((builds || []).map((row) => [row.id, row.state]));
  }
  return (data || []).map((row) => ({
    provider: row.provider,
    model: row.model,
    taskClass: row.metadata?.taskClass || "generated_app",
    cost: Number(row.actual_credits || 0),
    verified: states.get(row.build_id) === "green",
  }));
}

async function loadProjectContract(client, owner, projectId) {
  const { data: stored, error } = await client.from("bv2_contracts").select("contract")
    .eq("owner", owner).eq("project_id", projectId)
    .order("version", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(`Builder V2 contract load: ${error.message}`);
  if (stored?.contract) return stored.contract;
  const { data: legacy, error: legacyError } = await client.from("diag_runs").select("contract")
    .eq("owner", owner).eq("project_id", projectId).not("contract", "is", null)
    .order("started_at", { ascending: false }).limit(1).maybeSingle();
  if (legacyError) throw new Error(`legacy contract adoption: ${legacyError.message}`);
  return legacy?.contract || null;
}

function changedModuleCount(context = {}) {
  const paths = new Set(String((context.problems || []).join("\n"))
    .match(/src\/[\w/.-]+\.(?:jsx?|tsx?|css|mjs)/g) || []);
  return Math.max(1, paths.size || (context.step === "core" ? 6 : 1));
}

function runtimeLimits(workJob, kind) {
  const inherited = workJob.resource_limits || {};
  return {
    wallSeconds: kind === "browser_verify" ? 240 : Number(inherited.wallSeconds || 300),
    cpu: Number(inherited.cpu || 2), memoryMb: Number(inherited.memoryMb || 2048),
    pids: Number(inherited.pids || 256), outputBytes: Number(inherited.outputBytes || 4 * 1024 * 1024),
  };
}

export function journeyRequiresPersistentMutation(journey) {
  const text = [journey?.title, journey?.description, ...(journey?.steps || []).flatMap((step) => [
    step?.action, step?.target, step?.expect,
  ])].filter(Boolean).join(" ");
  // A confirmation screen is often a read-only assertion. Only actions that necessarily create,
  // mutate, or remove persisted application state require the independent database proof.
  return /\b(create|submit|send|book|reserve|save|register|sign[ -]?up|cancel|delete|update)\b/i.test(text);
}

async function backendFingerprint(client, projectId) {
  const appUsers = await client.from("app_users").select("id,auth_user_id,created_at")
    .eq("app_id", String(projectId)).order("id");
  if (appUsers.error) throw new Error(`backend app-user proof: ${appUsers.error.message}`);
  const userIds = (appUsers.data || []).map((row) => row.auth_user_id);
  let entityRows = [];
  if (userIds.length) {
    const entities = await client.from("entities").select("id,type,data,created_at")
      .eq("app_id", String(projectId)).in("owner", userIds).order("id");
    if (entities.error) throw new Error(`backend entity proof: ${entities.error.message}`);
    entityRows = entities.data || [];
  }
  const rows = { entities: entityRows, appUsers: appUsers.data || [] };
  return {
    hash: crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
    entityCount: rows.entities.length, appUserCount: rows.appUsers.length,
  };
}

async function resumeDiagnostics(client, workJob, request) {
  if (!workJob.payload?.diagSessionId) {
    throw Object.assign(new Error("Builder V2 execution requires a durable diagnostic trace root."), {
      code: "diagnostics_required",
    });
  }
  return createDiagSession({
    owner: workJob.owner, projectId: workJob.project_id, kind: "app_build_v2", prompt: request,
    client, existingRunId: workJob.payload.diagSessionId, strictWrites: true,
  });
}

export async function prepareBuilderV2PipelineAttempt(workJob, { client = serviceClient() } = {}) {
  if (Number(workJob.attempts || 1) <= 1) return { action: "start" };
  const { data, error } = await client.rpc("prepare_bv2_pipeline_retry", {
    p_owner: workJob.owner,
    p_public_build_id: workJob.build_id,
    p_work_job_id: workJob.id,
  });
  if (error) throw new Error(`Builder V2 crash-recovery guard: ${error.message}`);
  const decision = Array.isArray(data) ? data[0] : data;
  if (!decision?.action) throw new Error("Builder V2 crash-recovery guard returned no action");
  if (decision.action === "recovered") {
    return {
      action: "recovered",
      outcome: {
        status: "complete",
        stopReason: decision.stopReason || null,
        result: decision.result || null,
        bv2: decision.result?._worker?.bv2 || null,
      },
    };
  }
  if (decision.action === "restart_before_provider") return decision;
  throw Object.assign(new Error(
    decision.action === "provider_replay_unsafe"
      ? "The worker stopped after provider dispatch may have begun. The build was not replayed; reconcile provider telemetry before retrying."
      : "The interrupted Builder V2 build is not safely replayable.",
  ), {
    code: decision.action === "provider_replay_unsafe" ? "provider_replay_unsafe" : "pipeline_replay_blocked",
    retryable: false,
    recovery: decision,
  });
}

/**
 * Create an injectable composition for deterministic tests or the production worker.
 */
export function createBuilderV2Runtime({
  client = serviceClient(),
  contextResolver = resolveBuildContext,
  sandbox = runSandboxJob,
  preview = previewProvider(),
  assets = null,
  snapshots = null,
  reservations = null,
  historyResolver = routingHistory,
  accountCreditResolver = async (owner) => (await createBudgetLedger().getBalance(owner)).total,
  runtimePreflight = null,
  requireWorker = true,
  log = console.log,
} = {}) {
  const snapshotStore = snapshots || createSnapshotStore(supabaseSnapshotStorage({ client }));
  const assetService = assets || createAssetService({
    providers: [pexelsProvider()], client, optimiser: createOptimiser({ client }),
  });
  const reservationStore = reservations || supabaseModelReservations(client);
  let runtimePreflightPromise = null;
  const ensureRuntimeReady = runtimePreflight || (({ projectId }) => {
    // EnvironmentFiles are immutable for a running worker. Concurrent work inside this runtime
    // shares the same promise; a failed proof stays failed until configuration is corrected and
    // the worker is restarted. The normal worker entry creates a runtime for each pipeline job,
    // so every backend-dependent qualification gets a fresh pre-dispatch proof.
    runtimePreflightPromise ||= proveGeneratedRuntimeBackend({ projectId, adminClient: client });
    return runtimePreflightPromise;
  });

  async function isolated(job, options) {
    let outcome = null;
    try {
      outcome = await sandbox(job, options);
      return outcome;
    } finally {
      if (outcome?.workspaceRef) {
        await rm(outcome.workspaceRef, { recursive: true, force: true }).catch((error) => {
          log(`[bv2] sandbox cleanup failed for ${job.id}: ${error.message}`);
        });
      }
    }
  }

  async function persistAndProveGraph({ owner, projectId, buildId, tree }) {
    const expected = indexTree(tree);
    const manifest = manifestOf(expected);
    await persistIndex(owner, projectId, expected, { client });
    const actual = await loadIndex(owner, projectId, manifest, { client });
    const parity = compareGraphIndexes(expected, actual, { owner, projectId, buildId });
    if (!parity.clean) {
      throw Object.assign(new Error(`Builder V2 graph parity failed: ${JSON.stringify(parity.mismatches)}`), {
        code: "graph_parity", parity,
      });
    }
    return parity;
  }

  async function adoptLegacyTree(owner, projectId, workJob, events) {
    if (await snapshotStore.pointer(owner, projectId, "green")) return;
    const { data: project, error } = await client.from("projects").select("tree,builder_version")
      .eq("id", projectId).eq("owner", owner).maybeSingle();
    if (error) throw new Error(`legacy project adoption: ${error.message}`);
    if (!project?.tree || !Object.keys(project.tree).length) throw new Error("project has no verified source tree to adopt");
    const snapshot = await snapshotStore.createSnapshot(owner, projectId, project.tree, {
      reason: "legacy_v1_adoption", assetManifest: await assetService.assetManifestFor(owner, projectId),
    });
    await events.snapshot({ owner, projectId, buildId: null, snapshot, tree: project.tree, reason: "legacy_v1_adoption" });
    await snapshotStore.promote(owner, projectId, "green", snapshot.id);
    log(`[bv2] adopted legacy project ${projectId} at snapshot ${snapshot.id}`);
  }

  return {
    async execute(workJob, { signal = null, onEvent = null } = {}) {
      if (requireWorker && process.env.THRALLO_PROCESS_ROLE !== "build-worker") {
        throw Object.assign(new Error("Builder V2 execution requires the durable build worker"), { code: "worker_required" });
      }
      if (requireWorker && preview.mode !== "vps") {
        throw Object.assign(new Error(
          `Builder V2 production preview requires the isolated provisioner; PREVIEW_MODE resolved to ${preview.mode || "unknown"}.`,
        ), { code: "preview_isolation_required" });
      }
      if (workJob.payload?.pipelineVersion !== "v2") throw new Error("not a Builder V2 pipeline job");
      // This is deliberately ahead of recovery, provider-context resolution and contract creation:
      // backend-dependent generated apps cannot spend a model token unless the worker can inject
      // and exercise the exact public browser runtime. Service-role values never enter this path.
      await ensureRuntimeReady({ projectId: workJob.project_id, workJob });
      const recovery = await prepareBuilderV2PipelineAttempt(workJob, { client });
      if (recovery.action === "recovered") return recovery.outcome;
      const owner = workJob.owner;
      const projectId = workJob.project_id;
      const input = workJob.payload.input || {};
      const mode = workJob.payload.mode || "build";
      const request = String(input.prompt || workJob.payload.request || "");
      const emit = (kind, value) => onEvent?.(kind, typeof value === "string" ? value : JSON.stringify(value));
      const diag = await resumeDiagnostics(client, workJob, request);
      let previewResult = null;

      try {
      const context = await contextResolver(owner, { preferProvider: workJob.payload.providerOverride || null });
      assertQueuedProviderSelection(workJob.payload.providerSelection || null, context);
      diag.setByok?.(context.byok);
      if (usesManagedCredits(context.policy) && managedSettlementPaused()) {
        throw Object.assign(new Error("Managed Builder V2 dispatch is paused; no provider call was made."), { code: "settlement_paused" });
      }
      const ceilingCredits = Number(workJob.payload.budgetAllowance
        ?? workJob.payload.byokCostLimit
        ?? numberEnv("THRALLO_BV2_DEFAULT_BUILD_CEILING", 60));
      if (!(ceilingCredits > 0)) throw Object.assign(new Error("Builder V2 has no positive build budget"), { code: "budget_ceiling" });
      const candidates = candidateSet(context);
      const history = await historyResolver(client, owner, projectId);
      const complexity = classifyComplexity({ prompt: request }).level;
      const providerForStep = async ({ step, ...stepContext }) => {
        const routedStep = String(step).startsWith("increment:") ? "increment" : step;
        const stepComplexity = classifyComplexity({ prompt: request, contract: stepContext.contract || null }).level;
        const decision = routeV2Step({
          step: routedStep,
          taskClass: stepContext.taskClass || `${routedStep}:${stepComplexity}`,
          complexity: stepComplexity,
          affectedModules: Number(stepContext.affectedModules || changedModuleCount({ step, ...stepContext })),
          retrievalTokens: Number(stepContext.retrievalTokens || 0),
          repairRound: Number(stepContext.attempt || 0), candidates, history,
          policy: context.policy,
          // A job may pin automatic routing without mutating the owner's durable preference.
          // This is useful for bounded qualification and for future per-build AUTO selection.
          // Explicit manualModel still wins; all identities remain catalogue-validated below.
          manualModel: workJob.payload.manualModel || (workJob.payload.routingMode === "auto"
            ? null
            : context.routing?.routingMode === "manual" ? context.routing.preferredModel : null),
        });
        const outputPolicy = stepOutputPolicy(routedStep);
        Object.assign(decision, outputPolicy);
        const chosen = candidates.find((candidate) => candidate.provider === decision.provider
          && candidate.model === decision.model && candidate.billingLane === decision.billingLane);
        if (!chosen) throw new Error(`routing selected unavailable model ${decision.model}`);
        emit("progress", { kind: "routing", decision });
        return { provider: chosen.executable, decision };
      };

      const events = {
        buildCreated: async ({ owner: eventOwner, buildId }) => {
          const { error } = await client.from("build_jobs").update({ bv2_build_id: buildId })
            .eq("id", workJob.build_id).eq("owner", eventOwner).eq("pipeline_version", "v2");
          if (error) throw new Error(`Builder V2 job link: ${error.message}`);
        },
        contract: async ({ owner: eventOwner, projectId: eventProject, buildId, contract, tiers, bindings, intents }) => {
          diag.setContract?.(contract);
          await diag.flush?.();
          const stored = await persistContract(eventOwner, eventProject, {
            buildId, contract, tiers, bindings, intents,
          }, { client });
          await recordFacts(eventOwner, eventProject, [
            {
              kind: "contract_ref", key: "current", sourceBuild: buildId,
              value: { contractId: stored.id, version: stored.version, summary: contract.summary },
            },
            ...bindings.map((binding) => ({
              kind: "capability", key: binding.name, sourceBuild: buildId,
              value: { version: binding.version, pinnedMajor: Number(String(binding.version).split(".")[0]) },
            })),
          ]);
          return stored;
        },
        patches: async ({ owner: eventOwner, buildId, step, patches, outcome, rejected, filesChanged }) => {
          if (!patches.length) return;
          const rows = patches.map((patch, index) => ({
            id: uuid(), owner: eventOwner, build_id: buildId, step: `${step}:${index + 1}`,
            patch, outcome, reject_reason: rejected?.[index]?.reason || null, files_changed: filesChanged,
          }));
          const { error } = await client.from("bv2_patches").insert(rows);
          if (error) throw new Error(`Builder V2 patch trace: ${error.message}`);
        },
        checkpoint: async ({ snapshot, reason }) => {
          emit("progress", { kind: "working_checkpoint", snapshotId: snapshot.id,
            treeHash: snapshot.tree_hash, reason, promotable: false });
        },
        snapshot: persistAndProveGraph,
        knowledge: async ({ owner: eventOwner, projectId: eventProject, buildId, kind, key, value }) => {
          await recordFacts(eventOwner, eventProject, [{ kind, key, value, sourceBuild: buildId }]);
        },
      };
      const recordRetrieval = async ({ owner: eventOwner, buildId, step, query, included, omittedCount, tokens }) => {
        const { error } = await client.from("bv2_retrieval_traces").insert({
          owner: eventOwner, build_id: buildId, step, query, included,
          omitted_count: omittedCount, tokens,
        });
        if (error) throw new Error(`Builder V2 retrieval trace: ${error.message}`);
      };
      const lanes = createModelLanes({
        providerForStep, ceilingCredits, diag, log: (line) => emit("stdout", line),
        reservations: reservationStore, billingLane: context.policy.billingLane, strictKnowledge: true,
        recordRetrieval, accountCreditResolver,
      });
      const compile = async (tree, execution = {}) => isolated({
        id: `${workJob.id}-compile-${execution.step || "step"}-${execution.attempt || 0}`,
        durable_job_id: workJob.id, job_type: "compile", attempts: workJob.attempts || 1,
        payload: { tree: withRuntimeEnv(tree, projectId) }, resource_limits: runtimeLimits(workJob, "compile"),
      }, {
        signal: execution.signal || signal,
        onStdout: (chunk) => emit("stdout", chunk), onStderr: (chunk) => emit("stderr", chunk),
      });
      const journeysFn = async ({ tree, journeys, signal: journeySignal }) => {
        previewResult = await preview.start(projectId, withRuntimeEnv(tree, projectId));
        if (!previewResult?.url) throw new Error("verification preview returned no URL");
        const results = [];
        const consoleErrors = [];
        const failedRequests = [];
        for (const journey of journeys) {
          const before = journeyRequiresPersistentMutation(journey)
            ? await backendFingerprint(client, projectId) : null;
          const outcome = await isolated({
            id: `${workJob.id}-journey-${uuid()}`, durable_job_id: workJob.id,
            job_type: "browser_verify", attempts: workJob.attempts || 1,
            payload: { previewUrl: previewResult.url, contract: { journeys: [journey] }, timeoutMs: 180_000 },
            resource_limits: runtimeLimits(workJob, "browser_verify"),
          }, {
            signal: journeySignal || signal,
            onStdout: (chunk) => emit("stdout", chunk), onStderr: (chunk) => emit("stderr", chunk),
          });
          if (!outcome.journeys) throw new Error(`browser verification produced no journey evidence (${outcome.classification || outcome.stderr || "unknown"})`);
          consoleErrors.push(...(outcome.journeys.consoleErrors || []));
          failedRequests.push(...(outcome.journeys.failedRequests || []));
          const after = before ? await backendFingerprint(client, projectId) : null;
          for (const verdict of outcome.journeys.journeys || []) {
            results.push({
              ...verdict,
              backendEvidence: before ? {
                required: true, changed: before.hash !== after.hash,
                before: { entityCount: before.entityCount, appUserCount: before.appUserCount },
                after: { entityCount: after.entityCount, appUserCount: after.appUserCount },
              } : { required: false },
            });
          }
        }
        const journeyResult = {
          pass: results.every((row) => row.status === "pass") && !consoleErrors.length && !failedRequests.length,
          journeys: results,
          consoleErrors: [...new Set(consoleErrors)], failedRequests: [...new Set(failedRequests)],
        };
        diag.step?.({ agent: "Verifier", kind: "browser", label: "Builder V2 journeys",
          status: journeyResult.pass ? "ok" : "failed", output: JSON.stringify(journeyResult, null, 2) });
        await diag.flush?.();
        return journeyResult;
      };
      const backendProbeFn = async ({ journeyResults }) => (journeyResults || [])
        .filter((journey) => journey.backendEvidence?.required && journey.backendEvidence.changed !== true)
        .map((journey) => ({
          journeyId: journey.id,
          detail: "the browser journey passed without a corresponding app-scoped database mutation",
        }));
      const orchestrator = createOrchestrator({
        ...lanes, assetService, snapshotStore, buildStore: supabaseBuildStore(client),
        verificationCache: supabaseVerificationCache(client),
        verificationContext: {
          verifierVersion: "journey-v2", backendRuntimeVersion: process.env.THRALLO_RUNTIME_VERSION || "unknown",
          environmentVersion: process.env.THRALLO_ENV_VERSION || "unknown", capabilityVersions: "registry-current",
          indexerVersion: INDEXER_VERSION,
        },
        journeysFn, backendProbeFn, compile, baseTree: () => clone(fromScaffold(REACT_VITE)), events,
        classifyContract: ({ contract: generatedContract, profile }) => (
          classifyComplexity({ prompt: request, contract: generatedContract }).level || profile
        ),
        log: (line) => emit("stdout", line),
      });

      const contract = mode === "build" ? null : await loadProjectContract(client, owner, projectId);
      if (mode !== "build" && !contract) {
        throw Object.assign(new Error("This legacy project has no implementation contract to verify; V2 adoption needs an explicit qualification build."), {
          code: "legacy_contract_missing",
        });
      }
      if (contract) tierContract(contract); // reject malformed legacy diagnostics before spend
      // Validate the adoption contract before creating/promoting any snapshot. An unsupported
      // legacy project must remain byte-for-byte V1 until its explicit qualification build.
      if (mode !== "build" && mode !== "resume_repair") await adoptLegacyTree(owner, projectId, workJob, events);
      const result = mode === "build"
        ? await orchestrator.runBuild({ owner, projectId, request, profile: input.profile || complexity,
          budgetCredits: ceilingCredits, signal })
        : mode === "resume_repair"
          ? await orchestrator.runRepairFromCheckpoint({
            owner, projectId, sourceBuildId: String(input.sourceBuildId || ""), request, contract,
            initialProblems: Array.isArray(input.problems) ? input.problems : [], signal,
          })
          : await orchestrator.runEdit({ owner, projectId, request, contract, signal });

      if (result.state !== "green") {
        await diag.finish?.(result.state === "cancelled" ? "cancelled" : "failed");
        return { status: result.state === "cancelled" ? "failed" : "failed", stopReason: result.state,
          result: { buildOk: false, finalText: result.error || "Builder V2 could not produce a verified result." },
          contract, bv2: result };
      }
      const tree = await snapshotStore.materialize(owner, result.snapshotId);
      previewResult = await preview.update(projectId, withRuntimeEnv(tree, projectId));
      if (!previewResult?.url) throw new Error("verified Builder V2 snapshot has no healthy preview");
      await snapshotStore.promote(owner, projectId, "preview", result.snapshotId);
      const { error: projectError } = await client.from("projects").update({
        tree, builder_version: "v2", bv2_green_snapshot_id: result.snapshotId,
        preview_ref: previewResult.url, updated_at: new Date().toISOString(),
      }).eq("id", projectId).eq("owner", owner);
      if (projectError) throw new Error(`verified project projection: ${projectError.message}`);
      await diag.finish?.("complete");
      return {
        status: "complete", stopReason: null,
        result: {
          finalText: mode === "build"
            ? "Builder V2 created and verified the application."
            : mode === "resume_repair"
              ? "Builder V2 resumed the failed build and verified the targeted repair."
              : "Builder V2 applied and verified the change.",
          tree, buildOk: true, previewUrl: previewResult.url, snapshotId: result.snapshotId,
          pipelineVersion: "v2", qualityWarnings: result.pendingIncrements || [],
        },
        contract: contract || diag.contract || null,
        bv2: result,
      };
      } catch (error) {
        try {
          await diag.finish?.(error?.code === "cancelled" || error?.name === "AbortError" ? "cancelled" : "failed");
        } catch { /* diagnostics never hide the canonical build failure */ }
        throw error;
      }
    },
  };
}

export async function executeBuilderV2PipelineWork(workJob, options = {}) {
  return createBuilderV2Runtime().execute(workJob, options);
}
