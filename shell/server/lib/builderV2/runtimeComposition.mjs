// Builder V2 production composition root.
//
// This is the only place where V2's model, persistence, worker sandbox, preview and diagnostic
// seams are assembled. The orchestrator remains deterministic/injectable; this module supplies
// the production twins. It is deliberately worker-only: loading it is harmless in the shell,
// but execution fails closed unless the durable build worker owns the job.

import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rm } from "node:fs/promises";

import { clone, fromScaffold } from "../../../../src/engine/fileTree.mjs";
import { REACT_VITE } from "../../../../src/scaffolds/reactVite.mjs";
import { patchOutcomes } from "./patchEngine.mjs";
import { classifyComplexity } from "../appBuild/buildProfile.mjs";
import { createBudgetLedger } from "../appBuild/budgetLedger.mjs";
import { resolveBuildContext, resolveConnectedRecoveryContext } from "../appBuild/buildContext.mjs";
import { managedSettlementPaused, usesManagedCredits } from "../appBuild/providerPolicy.mjs";
import { createDiagSession } from "../appBuild/buildDiagnostics.mjs";
import { createVerificationIdentity } from "../appBuild/verificationIdentity.mjs";
import { MINIMAL_CONTRACT_VERIFIER_POLICY } from "../appBuild/verifierPolicy.mjs";
import { proveGeneratedRuntimeBackend, proveGeneratedRuntimeConfig, withRuntimeEnv } from "../runtimeEnv.mjs";
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
import { generationPolicyFor } from "./generationPolicy.mjs";
import { MAX_REPAIR_DISPATCHES, supabaseModelReservations } from "./modelReservations.mjs";
import { createOrchestrator, supabaseBuildStore } from "./orchestrator.mjs";
import { recordFacts } from "./knowledge.mjs";
import { routeV2Step } from "./router.mjs";
import { createSnapshotStore } from "./snapshotStore.mjs";
import {
  loadIndex, persistIndex, supabaseSnapshotStorage,
} from "./supabaseTwins.mjs";
import { supabaseVerificationCache, VERIFICATION_CACHE_VERSION } from "./verification.mjs";
import { scopeInteractionContract } from "./interactionContract.mjs";
import {
  compareSandboxIdentity, computeSandboxIdentity, sandboxSkewSummary,
  readDeploymentCommit,
} from "./sandboxProvenance.mjs";
import { assertExecutableCandidate } from "../modelCatalogue.mjs";
import {
  contractRuntimeRequirements, deriveBuildEnvelope, envelopePoolCeiling, FUNDING_POOL,
  supabaseBuildEnvelopes, createEnvelopeProgressGuard,
} from "./buildEnvelope.mjs";
import { supabaseBuildSettlements } from "./buildSettlement.mjs";
import { structuredBuildFailure, customerBuildStatus, customerFailureMessage } from "./buildFailure.mjs";
import { supabaseVerificationEvidenceStore } from "./verificationEvidenceStore.mjs";
import {
  browserVerificationBudget, browserVerificationUsesBackend,
} from "./browserVerificationBudget.mjs";

const uuid = () => crypto.randomUUID();
// shell/server/lib/builderV2 → the checkout root, which is also the image's /app.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const numberEnv = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export function defaultUsageResponsibilityFor(payload = {}) {
  // A trigger describes why a job was queued, not who funds its provider calls. Release and
  // qualification builds still exercise a customer's approved generation lane. Platform-funded
  // work must opt in explicitly so it enters the independent recovery pool accepted by the
  // reservation authority.
  return ["platform_failure", "qualification"].includes(payload.usageResponsibility)
    ? payload.usageResponsibility : "customer_request";
}

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
  return stored?.contract || null;
}

function changedModuleCount(context = {}) {
  const paths = new Set(String((context.problems || []).join("\n"))
    .match(/src\/[\w/.-]+\.(?:jsx?|tsx?|css|mjs)/g) || []);
  return Math.max(1, paths.size || (context.step === "core" ? 6 : 1));
}

function runtimeLimits(workJob, kind, overrides = {}) {
  const inherited = workJob.resource_limits || {};
  return {
    wallSeconds: Number(overrides.wallSeconds || inherited.wallSeconds || 300),
    cpu: Number(inherited.cpu || 2), memoryMb: Number(inherited.memoryMb || 2048),
    pids: Number(inherited.pids || 256), outputBytes: Number(inherited.outputBytes || 4 * 1024 * 1024),
  };
}

export function journeyRequiresPersistentMutation(journey, contract = null) {
  const graphOperations = contract?.capabilityGraph?.operationResponsibilities;
  if (Array.isArray(graphOperations)) {
    return graphOperations.filter((operation) => operation?.journeyId === journey?.id)
      .flatMap((operation) => operation?.responsibilities || [])
      .some((responsibility) => responsibility?.type === "persistence"
        && !["get", "list", "count", "subscribe"].includes(responsibility?.capabilityMethod));
  }
  const structuredFlows = contract?.interactionContract?.flows;
  if (Array.isArray(structuredFlows)) {
    return structuredFlows.some((flow) => flow?.journeyId === journey?.id
      && (flow?.semanticResponsibilityTypes || []).includes("persistence")
      && (flow?.expectedStateTransition?.persists || []).length > 0);
  }
  const text = [journey?.title, journey?.description, ...(journey?.steps || []).flatMap((step) => [
    step?.action, step?.target, step?.expect,
  ])].filter(Boolean).join(" ");
  // A confirmation screen is often a read-only assertion. Only actions that necessarily create,
  // mutate, or remove persisted application state require the independent database proof.
  return /\b(create|submit|send|book|reserve|save|register|sign[ -]?up|cancel|delete|update)\b/i.test(text);
}

/**
 * One verification round may contain independent journeys and several producer/consumer
 * lifecycles. Anonymous visitor identity follows that scenario graph: independent journeys get
 * isolated visitors, while a lifecycle's consumers recover the exact visitor that produced its
 * durable record. Keying the whole round to one visitor made an independent capacity check inherit
 * a cancelled booking, then made a later recovery check inherit that unrelated capacity context.
 */
export function verificationVisitorScopeForJourney(roundScope, journey, contract = {}) {
  const fullInteraction = contract.prerequisiteInteractionContract || contract.interactionContract || {};
  const scenario = fullInteraction.scenarios?.[journey?.id]
    || contract.interactionContract?.scenarios?.[journey?.id]
    || null;
  if (scenario?.role === "independent") {
    return `${roundScope}:independent:${journey.id}`;
  }
  if (["produces", "consumes"].includes(scenario?.role)) {
    const lifecycle = scenario.lifecycle || scenario.scenario;
    if (lifecycle) return `${roundScope}:lifecycle:${lifecycle}`;
  }
  // Historical contracts may predate explicit scenarios. A declared durable lifecycle is still
  // enough to associate its producer and consumers without sharing unrelated visitor state.
  const lifecycle = (fullInteraction.flows || [])
    .find((flow) => flow.journeyId === journey?.id && flow.durableLifecycle)?.durableLifecycle;
  return lifecycle
    ? `${roundScope}:lifecycle:${lifecycle}`
    : `${roundScope}:independent:${journey?.id || "unknown"}`;
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
  const valueShape = (value) => ({
    type: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
    hash: crypto.createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex").slice(0, 20),
  });
  const redactedEntities = rows.entities.map((row) => ({
    id: row.id, type: row.type, createdAt: row.created_at,
    fields: Object.fromEntries(Object.entries(row.data || {}).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, valueShape(value)])),
  }));
  const redactedUsers = rows.appUsers.map((row) => ({ id: row.id, createdAt: row.created_at,
    authUserHash: valueShape(row.auth_user_id).hash }));
  return {
    hash: crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
    entityCount: rows.entities.length, appUserCount: rows.appUsers.length,
    entities: redactedEntities, appUsers: redactedUsers,
  };
}

function backendDifference(before, after) {
  const prior = new Map((before?.entities || []).map((row) => [row.id, row]));
  const next = new Map((after?.entities || []).map((row) => [row.id, row]));
  return {
    created: [...next.keys()].filter((id) => !prior.has(id)),
    deleted: [...prior.keys()].filter((id) => !next.has(id)),
    changed: [...next.keys()].filter((id) => prior.has(id)
      && JSON.stringify(prior.get(id)) !== JSON.stringify(next.get(id))).map((id) => ({
      id,
      fields: [...new Set([
        ...Object.keys(prior.get(id)?.fields || {}), ...Object.keys(next.get(id)?.fields || {}),
      ])].filter((field) => JSON.stringify(prior.get(id)?.fields?.[field])
        !== JSON.stringify(next.get(id)?.fields?.[field])),
    })),
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
  if (decision.action === "restart_before_provider") {
    if (!decision.payload || typeof decision.payload !== "object" || Array.isArray(decision.payload)) {
      throw Object.assign(new Error("The interrupted Builder V2 build has no valid durable retry payload."), {
        code: "durable_retry_state_missing", retryable: false, recovery: decision,
      });
    }
    // The lease was materialised before the retry RPC reconciled the prior attempt. Adopt the
    // refreshed durable payload so this process cannot dispatch with stale funding or continuation
    // state while the next reclaimed lease sees different authority.
    workJob.payload = decision.payload;
    return decision;
  }
  if (decision.action === "retry_state_missing" || decision.action === "retry_state_invalid") {
    throw Object.assign(new Error("The interrupted Builder V2 build has no safe durable retry state."), {
      code: decision.code || "durable_retry_state_missing", retryable: false, recovery: decision,
    });
  }
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
  recoveryContextResolver = async () => resolveConnectedRecoveryContext(),
  sandbox = runSandboxJob,
  preview = previewProvider(),
  assets = null,
  snapshots = null,
  reservations = null,
  envelopes = null,
  settlements = null,
  evidence = null,
  historyResolver = routingHistory,
  accountCreditResolver = async (owner) => createBudgetLedger().getBalance(owner),
  runtimePreflight = null,
  requireWorker = true,
  log = console.log,
} = {}) {
  const snapshotStore = snapshots || createSnapshotStore(supabaseSnapshotStorage({ client }));
  const assetService = assets || createAssetService({
    providers: [pexelsProvider()], client, optimiser: createOptimiser({ client }),
  });
  const reservationStore = reservations || supabaseModelReservations(client);
  const envelopeStore = envelopes || supabaseBuildEnvelopes(client);
  const settlementStore = settlements || supabaseBuildSettlements(client);
  const evidenceStore = evidence || supabaseVerificationEvidenceStore(client);
  const progressGuard = createEnvelopeProgressGuard({ envelopeStore });
  const ensureRuntimeReady = runtimePreflight || (({ projectId, requirements }) => (
    proveGeneratedRuntimeBackend({ projectId, adminClient: client, requirements })
  ));
  const retryRuntimePreflight = async (input) => {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try { return await ensureRuntimeReady(input); }
      catch (error) {
        lastError = error;
        if (error?.retryable !== true || attempt === 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** (attempt - 1))));
      }
    }
    throw lastError;
  };

  let sandboxIdentityPromise = null;
  /**
   * Prove the sandbox grades with THIS code, before anything is spent.
   *
   * A pinned image is invisible from in here: the worker looks deployed, the shell looks
   * deployed, and the container quietly runs whatever digest the pin names. On 2026-08-10 that
   * was a three-day-old verifier, and a full paid qualification produced false passes because of
   * it. The check costs one 60-second container that hashes five files, and it runs ahead of
   * contract creation so a stale image ends the job at zero credits with a machine-readable code
   * instead of buying another wrong verdict.
   */
  async function ensureSandboxCompatible(workJob) {
    // In process mode the sandbox is a child of THIS checkout, so there is nothing to skew and
    // nothing to prove. Skew is a property of shipping the code somewhere else.
    if (process.env.THRALLO_BUILD_SANDBOX === "process") return { compatible: true, code: null, inProcess: true };
    sandboxIdentityPromise ||= (async () => {
      const host = await computeSandboxIdentity({
        root: repoRoot, commit: await readDeploymentCommit({ root: repoRoot }),
      });
      const outcome = await isolated({
        id: `${workJob.id}-sandbox-provenance`, durable_job_id: workJob.id,
        job_type: "sandbox_provenance", attempts: workJob.attempts || 1,
        payload: {}, resource_limits: runtimeLimits(workJob, "sandbox_provenance"),
      }, {});
      const report = compareSandboxIdentity(host, {
        ...(outcome?.provenance || {}),
        imageDigest: process.env.THRALLO_BUILD_SANDBOX_IMAGE || null,
      });
      log(JSON.stringify({ event: "bv2.sandbox_provenance", ...report, mismatches: report.mismatches }));
      return report;
    })();
    const report = await sandboxIdentityPromise;
    if (!report.compatible) {
      throw Object.assign(new Error(`${report.detail} — ${sandboxSkewSummary(report)}`), {
        code: report.code, classification: report.code, skew: report,
      });
    }
    return report;
  }

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
      // Release/runtime authority proof: local materialisation and public credential shape only.
      // Contract-specific auth/entity probes run after the contract says they are required.
      proveGeneratedRuntimeConfig({ projectId: workJob.project_id });
      const sandboxCompatibility = await ensureSandboxCompatible(workJob);
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
      let activeBuildId = null;
      let activeEnvelope = null;
      let terminalSettled = false;
      const recoveryStrategyCosts = new Map();

      const settleTerminal = async ({ state, failure = null, greenPreview = false }) => {
        if (!activeBuildId || terminalSettled) return null;
        const customerOwnedProviderFailure = failure?.classification === "provider_customer";
        const cancelled = state === "cancelled" || failure?.code === "cancelled";
        const settlement = await settlementStore.settle({
          owner, buildId: activeBuildId, terminalState: state,
          failureClassification: failure?.classification || null, greenPreview,
          compensationEligible: !cancelled && !customerOwnedProviderFailure,
        });
        terminalSettled = true;
        return settlement;
      };

      try {
      const context = await contextResolver(owner, { preferProvider: workJob.payload.providerOverride || null });
      // Recovery authority is platform-owned and server-configured. Never pass the customer owner
      // or queued payload into its resolver; neither may select the transport that pays for repair.
      const recoveryContext = await recoveryContextResolver({ purpose: "builder_v2_recovery" });
      assertQueuedProviderSelection(workJob.payload.providerSelection || null, context);
      diag.setByok?.(context.byok);
      if (usesManagedCredits(context.policy) && managedSettlementPaused()) {
        throw Object.assign(new Error("Managed Builder V2 dispatch is paused; no provider call was made."), { code: "settlement_paused" });
      }
      const ceilingCredits = Number(workJob.payload.budgetAllowance
        ?? workJob.payload.byokCostLimit
        ?? numberEnv("THRALLO_BV2_DEFAULT_BUILD_CEILING", 60));
      if (!(ceilingCredits > 0)) throw Object.assign(new Error("Builder V2 has no positive build budget"), { code: "budget_ceiling" });
      // THE REPAIR ALLOWANCE IS SIZED BY THE APPROVED BUDGET, NOT BY A CONSTANT.
      //
      // It was 2 for every build regardless of what the customer approved. A 60-credit build
      // therefore stopped after two repair rounds with 39 credits unspent and six journeys red.
      // The credit ceiling is the real limit and it already fails closed; this count is only a
      // backstop against a pathological loop, so it scales with the money actually approved.
      // An explicit caller value still wins.
      // This is an emergency loop guard only. The validated contract's strategyCapacity and the
      // independent recovery credit pool are the actual repair authority.
      const maxRepairs = Number.isInteger(input.maxRepairs)
        ? Math.max(0, Math.min(MAX_REPAIR_DISPATCHES, input.maxRepairs))
        : MAX_REPAIR_DISPATCHES;
      const candidates = candidateSet(context);
      const recoveryCandidates = candidateSet(recoveryContext);
      if (!recoveryCandidates.length || recoveryCandidates.some((candidate) => (
        candidate.billingLane !== "connected_allowance" || candidate.laneProvider !== "codex"
      ))) {
        throw Object.assign(new Error("Builder V2 recovery authority resolved outside platform connected Codex."), {
          code: "recovery_provider_unavailable", classification: "platform", retryable: true,
          dispatchState: "before_dispatch",
        });
      }
      const history = await historyResolver(client, owner, projectId);
      const complexity = classifyComplexity({ prompt: request }).level;
      let generationProfile = complexity;
      if (mode === "resume_repair" && input.sourceBuildId) {
        const { data: sourceBuild, error: sourceBuildError } = await client.from("bv2_builds")
          .select("profile").eq("id", String(input.sourceBuildId)).eq("owner", owner).maybeSingle();
        if (sourceBuildError) throw new Error(`Builder V2 source-build profile read: ${sourceBuildError.message}`);
        generationProfile = sourceBuild?.profile || complexity;
      }
      const generationPolicy = generationPolicyFor(generationProfile);
      const providerForStep = async ({ step, ...stepContext }) => {
        const routedStep = String(step).startsWith("increment:") ? "increment" : step;
        const recoveryDispatch = stepContext.recoveryDispatch === true
          || ["repair", "correction"].includes(routedStep);
        const routingContext = recoveryDispatch ? recoveryContext : context;
        const routingCandidates = recoveryDispatch ? recoveryCandidates : candidates;
        const stepComplexity = classifyComplexity({ prompt: request, contract: stepContext.contract || null }).level;
        const decision = routeV2Step({
          step: routedStep,
          taskClass: stepContext.taskClass || `${routedStep}:${stepComplexity}`,
          complexity: stepComplexity,
          affectedModules: Number(stepContext.affectedModules || changedModuleCount({ step, ...stepContext })),
          retrievalTokens: Number(stepContext.retrievalTokens || 0),
          repairRound: Number(stepContext.attempt || 0), candidates: routingCandidates, history,
          policy: routingContext.policy,
          // A job may pin automatic routing without mutating the owner's durable preference.
          // This is useful for bounded qualification and for future per-build AUTO selection.
          // Explicit manualModel still wins; all identities remain catalogue-validated below.
          manualModel: workJob.payload.manualModel || (workJob.payload.routingMode === "auto"
            ? null
            : recoveryDispatch ? null
              : context.routing?.routingMode === "manual" ? context.routing.preferredModel : null),
        });
        const outputPolicy = stepOutputPolicy(routedStep);
        Object.assign(decision, outputPolicy);
        const chosen = routingCandidates.find((candidate) => candidate.provider === decision.provider
          && candidate.model === decision.model && candidate.billingLane === decision.billingLane);
        if (!chosen) throw new Error(`routing selected unavailable model ${decision.model}`);
        decision.usageResponsibility = recoveryDispatch ? "thrallo_repair" : "customer_request";
        decision.fundingPolicy = recoveryDispatch ? "thrallo_recovery" : "request_owner";
        decision.executionAuthority = recoveryDispatch ? "platform_connected_codex" : "request_owner";
        emit("progress", { kind: "routing", decision });
        return { provider: chosen.executable, decision };
      };

      const events = {
        buildCreated: async ({ owner: eventOwner, buildId }) => {
          activeBuildId = buildId;
          const { error } = await client.from("build_jobs").update({ bv2_build_id: buildId })
            .eq("id", workJob.build_id).eq("owner", eventOwner).eq("pipeline_version", "v2");
          if (error) throw new Error(`Builder V2 job link: ${error.message}`);
        },
        envelope: async ({ owner: eventOwner, projectId: eventProject, buildId, envelope }) => {
          const stored = await envelopeStore.create({
            owner: eventOwner, projectId: eventProject, buildId, envelope,
          });
          activeEnvelope = stored.envelope || envelope;
          const status = customerBuildStatus({ internalState: "building" });
          const { error } = await client.from("bv2_builds").update({
            envelope_version: envelope.version, customer_state: status.state,
            expected_duration_ms: envelope.execution.expectedDurationMs,
            hard_safety_duration_ms: envelope.execution.hardSafetyDurationMs,
            last_durable_progress_at: envelope.execution.lastDurableProgressAt,
          }).eq("id", buildId).eq("owner", eventOwner);
          if (error) throw new Error(`Builder V2 envelope projection: ${error.message}`);
          return stored;
        },
        progress: async ({ owner: eventOwner, buildId, kind, details = {} }) => {
          if (!activeEnvelope) return null;
          const recorded = await progressGuard.mark(eventOwner, buildId, kind, details);
          const { error } = await client.from("bv2_builds").update({
            last_durable_progress_at: recorded.progressed_at || recorded.at,
          }).eq("id", buildId).eq("owner", eventOwner);
          if (error) throw new Error(`Builder V2 progress projection: ${error.message}`);
          return recorded;
        },
        telemetry: async ({ owner: eventOwner, buildId, kind, details = {} }) => {
          if (!activeEnvelope) return null;
          const { data, error } = await client.from("bv2_build_progress").insert({
            owner: eventOwner, build_id: buildId, kind, details,
          }).select("*").single();
          if (error) throw new Error(`Builder V2 timing telemetry: ${error.message}`);
          return data;
        },
        state: async ({ owner: eventOwner, buildId, state }) => {
          const customerStatus = customerBuildStatus({ internalState: state, creditsProtected: true });
          const [internal, publicBuild] = await Promise.all([
            client.from("bv2_builds").update({ customer_state: customerStatus.state })
              .eq("id", buildId).eq("owner", eventOwner),
            client.from("build_jobs").update({ phase: customerStatus.state,
              updated_at: new Date().toISOString() })
              .eq("id", workJob.build_id).eq("owner", eventOwner),
          ]);
          if (internal.error) throw new Error(`Builder V2 customer state projection: ${internal.error.message}`);
          if (publicBuild.error) throw new Error(`Builder V2 public state projection: ${publicBuild.error.message}`);
          emit("progress", { kind: "customer_state", ...customerStatus });
          return customerStatus;
        },
        verificationDefects: ({ owner: eventOwner, projectId: eventProject, buildId, records }) => (
          evidenceStore.recordDefects({ owner: eventOwner, projectId: eventProject, buildId, records })
        ),
        repairStrategyStarted: async (row) => {
          const ceiling = activeEnvelope
            ? envelopePoolCeiling(activeEnvelope, FUNDING_POOL.RECOVERY) : preliminaryRecoveryCredits;
          const budget = await reservationStore.budget?.(row.owner, row.buildId, ceiling, FUNDING_POOL.RECOVERY);
          const stored = await evidenceStore.startStrategy(row);
          recoveryStrategyCosts.set(stored.id, Number(budget?.consumedCredits || 0));
          return stored;
        },
        repairStrategyFinished: async ({ id, owner: strategyOwner = owner,
          buildId: strategyBuildId = activeBuildId, ...row }) => {
          const ceiling = activeEnvelope
            ? envelopePoolCeiling(activeEnvelope, FUNDING_POOL.RECOVERY) : preliminaryRecoveryCredits;
          const budget = await reservationStore.budget?.(
            strategyOwner, strategyBuildId, ceiling, FUNDING_POOL.RECOVERY,
          );
          const before = recoveryStrategyCosts.get(id) || 0;
          recoveryStrategyCosts.delete(id);
          return evidenceStore.finishStrategy(id, {
            ...row, settledRecoveryCost: Math.max(0, Number(budget?.consumedCredits || 0) - before),
          });
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
        patches: async ({ owner: eventOwner, buildId, step, patches, outcome, rejected, outcomes, filesChanged }) => {
          if (!patches.length) return;
          // Per-patch truth, correlated by SIGNATURE. Correlating by array position wrote twelve
          // null reasons and attached the one real parse error to an unrelated patch.
          const resolved = outcomes || patchOutcomes(patches, { rejected: rejected || [] });
          const rows = patches.map((patch, index) => {
            const row = resolved[index] || {};
            const rejectedRow = (row.outcome || outcome) === "rejected";
            return {
              id: uuid(), owner: eventOwner, build_id: buildId, step: `${step}:${index + 1}`,
              patch, outcome: row.outcome || outcome, files_changed: filesChanged,
              // A rejected row without a reason is not an audit trail. The code is stable, the
              // detail is readable, and the fallback still names the batch it died with.
              reject_reason: rejectedRow
                ? JSON.stringify({
                  code: row.code || "rejected_in_batch",
                  file: row.file ?? null,
                  operation: row.operation ?? null,
                  independentlyValid: row.independentlyValid === true,
                  detail: row.reason
                    || "rejected as part of a batch that could not be applied; no per-patch reason was recorded",
                })
                : null,
            };
          });
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
      // Bounded planning/correction capacity exists before a valid contract can price the full
      // recovery strategy graph. Once the envelope is durable, its independent pool is the only
      // recovery authority.
      const preliminaryRecoveryCredits = Math.max(3,
        1.5 + (complexity === "advanced" ? 4 : complexity === "medium" ? 2 : 1));
      const lanes = createModelLanes({
        providerForStep, ceilingCredits, diag, log: (line) => emit("stdout", line),
        reservations: reservationStore, billingLane: context.policy.billingLane, strictKnowledge: true,
        recordRetrieval, accountCreditResolver, maxRepairs,
        maxCorrections: generationPolicy.maxCandidateCorrections,
        defaultUsageResponsibility: defaultUsageResponsibilityFor(workJob.payload),
        poolCeilingResolver: async ({ fundingPool, step }) => {
          if (fundingPool === FUNDING_POOL.RECOVERY) {
            if (!activeEnvelope) return preliminaryRecoveryCredits;
            const current = activeBuildId ? await envelopeStore.get(owner, activeBuildId) : null;
            activeEnvelope = current?.envelope || activeEnvelope;
            return envelopePoolCeiling(activeEnvelope, FUNDING_POOL.RECOVERY);
          }
          if (!activeEnvelope) return ceilingCredits;
          const stages = (activeEnvelope.stages || [])
            .filter((stage) => stage.required !== false && stage.fundingSource === FUNDING_POOL.CUSTOMER);
          const currentId = step === "core" ? "core_generation"
            : String(step).startsWith("increment:") ? `journey_generation:${String(step).slice("increment:".length)}`
              : null;
          const currentIndex = stages.findIndex((stage) => stage.id === currentId);
          const completionReserveCredits = currentIndex >= 0
            ? stages.slice(currentIndex + 1).reduce((sum, stage) => sum + Number(stage.estimatedCredits || 0), 0)
            : 0;
          return { ceilingCredits: envelopePoolCeiling(activeEnvelope, FUNDING_POOL.CUSTOMER),
            completionReserveCredits };
        },
        beforeDispatch: ({ owner: dispatchOwner, buildId }) => (
          progressGuard.beforeDispatch(dispatchOwner, buildId)
        ),
      });
      const compile = async (tree, execution = {}) => isolated({
        id: `${workJob.id}-compile-${execution.step || "step"}-${execution.attempt || 0}`,
        durable_job_id: workJob.id, job_type: "compile", attempts: workJob.attempts || 1,
        payload: { tree: withRuntimeEnv(tree, projectId) }, resource_limits: runtimeLimits(workJob, "compile"),
      }, {
        signal: execution.signal || signal,
        onStdout: (chunk) => emit("stdout", chunk), onStderr: (chunk) => emit("stderr", chunk),
      });
      const journeysFn = async ({ tree, journeys, contract: journeyContract, signal: journeySignal }) => {
        previewResult = await preview.start(projectId, withRuntimeEnv(tree, projectId));
        if (!previewResult?.url) throw new Error("verification preview returned no URL");
        const results = [];
        const consoleErrors = [];
        const failedRequests = [];
        const fatalErrors = [];
        const advisories = [];
        const verifierDefects = [];
        let unavailable = false;
        let verifierError = null;
        let mechanics = null;
        // Identity is stable within each producer/consumer lifecycle and isolated for each
        // independent scenario. A later repair round gets a new root scope and cannot inherit a
        // half-completed wizard or terminal state from the prior candidate.
        const verificationVisitorScope = uuid();
        for (const journey of journeys) {
          const runtimeRequirements = activeEnvelope?.runtimeRequirements
            || contractRuntimeRequirements(journeyContract);
          const usesBackend = browserVerificationUsesBackend(runtimeRequirements);
          const browserBudget = browserVerificationBudget({
            journey, contract: journeyContract, usesBackend,
          });
          // Use a server-only authority to seal stable verifier credentials. Only the derived,
          // purpose-scoped tokens enter the ephemeral sandbox payload; the service credential
          // itself never leaves the durable worker process.
          const verificationIdentity = createVerificationIdentity({
            appId: projectId,
            scope: journey.id,
            visitorScope: verificationVisitorScopeForJourney(
              verificationVisitorScope, journey, journeyContract,
            ),
            secret: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE,
          });
          const before = journeyRequiresPersistentMutation(journey, journeyContract)
            ? await backendFingerprint(client, projectId) : null;
          const outcome = await isolated({
            id: `${workJob.id}-journey-${uuid()}`, durable_job_id: workJob.id,
            job_type: "browser_verify", attempts: workJob.attempts || 1,
            payload: { previewUrl: previewResult.url,
              usesBackend,
              contract: { ...journeyContract, journeys: [journey],
                allJourneys: journeyContract?.allJourneys || journeyContract?.journeys || [],
                prerequisiteInteractionContract: journeyContract?.prerequisiteInteractionContract
                  || journeyContract?.interactionContract || null,
                interactionContract: scopeInteractionContract(journeyContract?.interactionContract, [journey]) },
              // Stable only within this project/journey. The sandbox restores deterministic test
              // credentials, then the app still obtains a real app-auth/RLS session normally.
              verificationIdentity,
              verifierPolicy: MINIMAL_CONTRACT_VERIFIER_POLICY,
              appTimeoutMs: browserBudget.appTimeoutMs,
              journeyTimeoutMs: browserBudget.journeyTimeoutMs },
            resource_limits: runtimeLimits(workJob, "browser_verify", {
              wallSeconds: browserBudget.wallSeconds,
            }),
          }, {
            signal: journeySignal || signal,
            onStdout: (chunk) => emit("stdout", chunk), onStderr: (chunk) => emit("stderr", chunk),
          });
          if (!outcome.journeys) throw new Error(`browser verification produced no journey evidence (${outcome.classification || outcome.stderr || "unknown"})`);
          consoleErrors.push(...(outcome.journeys.consoleErrors || []));
          failedRequests.push(...(outcome.journeys.failedRequests || []));
          fatalErrors.push(...(outcome.journeys.fatalErrors || []));
          advisories.push(...(outcome.journeys.advisories || []));
          const failureRefs = outcome.journeys.failureRefs || [];
          verifierDefects.push(...(outcome.journeys.verifierDefects || []));
          unavailable = unavailable || outcome.journeys.unavailable === true;
          verifierError ||= outcome.journeys.error || null;
          if (outcome.journeys.mechanics) {
            const current = outcome.journeys.mechanics;
            mechanics = {
              probed: (mechanics?.probed || 0) + (current.probed || 0),
              failures: [...(mechanics?.failures || []), ...(current.failures || [])],
              skipped: [...(mechanics?.skipped || []), ...(current.skipped || [])],
              outcomes: [...(mechanics?.outcomes || []), ...(current.outcomes || [])],
            };
          }
          const after = before ? await backendFingerprint(client, projectId) : null;
          const entityDiff = before ? backendDifference(before, after) : null;
          for (const verdict of outcome.journeys.journeys || []) {
            results.push({
              ...verdict,
              failureRefs: [...new Set([...(verdict.failureRefs || []), ...failureRefs])],
              backendEvidence: before ? {
                required: true, changed: before.hash !== after.hash,
                before, after, entityDiff,
              } : { required: false },
            });
          }
          // A platform-owned verifier failure cannot be repaired by changing generated source.
          // Stop opening more browsers and let the orchestrator retain the candidate immediately.
          if (unavailable || verifierDefects.length) break;
        }
        const journeyResult = {
          pass: !unavailable && !verifierDefects.length
            && results.every((row) => row.status === "pass"),
          verifierPolicy: MINIMAL_CONTRACT_VERIFIER_POLICY,
          journeys: results,
          consoleErrors: [...new Set(consoleErrors)], failedRequests: [...new Set(failedRequests)],
          fatalErrors: [...new Set(fatalErrors)],
          advisories,
          verifierDefects: [...new Map(verifierDefects.map((row) => [row.code, row])).values()],
          unavailable,
          error: verifierError,
          mechanics,
          failureRefs: [...new Set(results.flatMap((row) => row.failureRefs || []))],
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
          // Cache PASS evidence against both the exact verifier bytes the sandbox proved it is
          // running and the deployed orchestration revision that assembled its contract. A
          // release can no longer change either half of the grader while retaining a static
          // "journey-v2" identity and silently reuse an older verdict.
          verifierVersion: [
            sandboxCompatibility.sandboxVerifier || "in-process",
            sandboxCompatibility.hostCommit || VERIFICATION_CACHE_VERSION,
          ].join(":"),
          verifierPolicy: MINIMAL_CONTRACT_VERIFIER_POLICY,
          backendRuntimeVersion: process.env.THRALLO_RUNTIME_VERSION || "unknown",
          environmentVersion: process.env.THRALLO_ENV_VERSION || "unknown", capabilityVersions: "registry-current",
          indexerVersion: INDEXER_VERSION,
        },
        journeysFn, backendProbeFn, compile, baseTree: () => clone(fromScaffold(REACT_VITE)), events,
        classifyContract: ({ contract: generatedContract, profile }) => (
          classifyComplexity({ prompt: request, contract: generatedContract }).level || profile
        ),
        deriveEnvelope: async ({ contract: generatedContract, spec, profile: refined, buildId }) => {
          const recoveryBudget = await reservationStore.budget?.(
            owner, buildId, preliminaryRecoveryCredits, FUNDING_POOL.RECOVERY,
          );
          return deriveBuildEnvelope({
            contract: generatedContract, spec, profile: refined,
            approvedCustomerCredits: ceilingCredits,
            generationProviderPolicy: context.policy,
            recoveryProviderPolicy: {
              ...recoveryContext.policy, usageResponsibility: "thrallo_repair",
              fundingSource: "thrallo", managedFallback: false,
            },
            recoveryFloorCredits: Number(recoveryBudget?.consumedCredits || 0)
              + Number(recoveryBudget?.reservedCredits || 0),
          });
        },
        deferGreenPromotion: true,
        contractPreflight: async ({ contract: generatedContract, envelope, buildId }) => {
          try {
            const proof = await retryRuntimePreflight({ projectId, workJob, contract: generatedContract,
              requirements: envelope.runtimeRequirements });
            await events.telemetry({ owner, projectId, buildId, kind: "capability_preflight_result",
              details: { ok: true, requirements: envelope.runtimeRequirements } });
            return proof;
          } catch (error) {
            await events.telemetry({ owner, projectId, buildId, kind: "capability_preflight_result",
              details: { ok: false, code: error?.code || "runtime_preflight_failed",
                requirements: envelope.runtimeRequirements } });
            throw error;
          }
        },
        log: (line) => emit("stdout", line),
      });

      const contract = mode === "build" ? null : await loadProjectContract(client, owner, projectId);
      if (mode !== "build" && !contract) {
        throw Object.assign(new Error("This Builder V2 project has no durable implementation contract."), {
          code: "v2_contract_missing",
        });
      }
      if (contract) tierContract(contract); // reject malformed durable contracts before spend
      const result = mode === "build"
        ? await orchestrator.runBuild({ owner, projectId, request, profile: input.profile || complexity,
          buildProfile: input.buildProfile || null,
          budgetCredits: ceilingCredits, maxRepairs, signal })
        : mode === "resume_repair"
          ? await orchestrator.runRepairFromCheckpoint({
            owner, projectId, sourceBuildId: String(input.sourceBuildId || ""), request, contract,
            initialProblems: Array.isArray(input.problems) ? input.problems : [], maxRepairs,
            budgetCredits: ceilingCredits, signal,
          })
          : mode === "resume_verify"
            ? await orchestrator.runVerifyFromCheckpoint({
              owner, projectId, sourceBuildId: String(input.sourceBuildId || ""), request, contract, signal,
            })
          : await orchestrator.runEdit({ owner, projectId, request, contract, maxRepairs, signal });

      if (result.state !== "green") {
        const failureCode = result.failureClassification || result.stopReason || result.state;
        const explicitClassification = /verifier|platform|runtime|worker|preview/i.test(failureCode)
          ? "platform"
          : /provider|quota|credential|billing/i.test(failureCode) ? "provider_customer"
            : /interaction_contract|scope_approval|contradict/i.test(failureCode) ? "contract"
              : /accounting|settlement|reservation/i.test(failureCode) ? "accounting" : "generated_app";
        const failure = structuredBuildFailure(Object.assign(new Error(result.error || "Builder V2 stopped"), {
          code: failureCode,
        }), {
          classification: explicitClassification,
          customerActionRequired: result.actionRequired === true || explicitClassification === "provider_customer",
          checkpointId: result.workingSnapshotId || result.snapshotId || null,
        });
        const settlement = await settleTerminal({ state: result.state, failure, greenPreview: false });
        const customerStatus = customerBuildStatus({ internalState: result.state, failure,
          creditsProtected: true });
        if (activeBuildId) {
          const { error: failureProjectionError } = await client.from("bv2_builds").update({
            failure, customer_state: customerStatus.state,
          }).eq("id", activeBuildId).eq("owner", owner);
          if (failureProjectionError) throw new Error(`Builder V2 failure projection: ${failureProjectionError.message}`);
        }
        await diag.finish?.(result.state === "cancelled" ? "cancelled" : "failed");
        return { status: result.state === "cancelled" ? "failed" : "failed", stopReason: result.state,
          result: { buildOk: false, finalText: customerFailureMessage(failure),
            customerStatus, creditsProtected: true },
          failure, settlement,
          contract, bv2: result };
      }
      await events.state({ owner, projectId, buildId: activeBuildId, state: "promotion_projection" });
      const tree = await snapshotStore.materialize(owner, result.snapshotId);
      previewResult = await preview.update(projectId, withRuntimeEnv(tree, projectId));
      if (!previewResult?.url) throw new Error("verified Builder V2 snapshot has no healthy preview");
      const { data: projection, error: projectError } = await client.rpc("promote_bv2_green_projection", {
        p_owner: owner, p_project_id: projectId, p_build_id: activeBuildId,
        p_snapshot_id: result.snapshotId, p_preview_url: previewResult.url,
      });
      if (projectError) throw new Error(`verified project projection: ${projectError.message}`);
      terminalSettled = true;
      const settlement = projection?.settlement || null;
      const customerStatus = customerBuildStatus({ internalState: "green",
        previewUrl: previewResult.url, creditsProtected: true });
      if (activeBuildId) {
        const { error: stateError } = await client.from("bv2_builds").update({
          customer_state: customerStatus.state,
        }).eq("id", activeBuildId).eq("owner", owner);
        if (stateError) throw new Error(`Builder V2 ready-state projection: ${stateError.message}`);
      }
      await diag.finish?.("complete");
      return {
        status: "complete", stopReason: null,
        result: {
          finalText: mode === "build"
            ? "Builder V2 created and verified the application."
            : mode === "resume_repair"
              ? "Builder V2 resumed the failed build and verified the targeted repair."
              : mode === "resume_verify"
                ? "Builder V2 re-verified the retained application against the current platform runtime."
              : "Builder V2 applied and verified the change.",
          buildOk: true, previewUrl: previewResult.url, snapshotId: result.snapshotId,
          pipelineVersion: "v2", qualityWarnings: result.pendingIncrements || [],
          customerStatus, creditsProtected: true,
        },
        settlement,
        contract: contract || diag.contract || null,
        bv2: result,
      };
      } catch (error) {
        if (activeBuildId && !terminalSettled) {
          const failure = structuredBuildFailure(error, {
            checkpointId: error?.checkpointId || null,
          });
          try {
            await settleTerminal({ state: error?.code === "cancelled" ? "cancelled" : "failed",
              failure, greenPreview: false });
            await client.from("bv2_builds").update({
              failure, customer_state: customerBuildStatus({ internalState: "failed", failure }).state,
              state: error?.code === "cancelled" ? "cancelled" : "failed",
              error: String(error?.message || error), finished_at: new Date().toISOString(),
            }).eq("id", activeBuildId).eq("owner", owner);
          } catch (settlementError) {
            error = Object.assign(new AggregateError([error, settlementError],
              "Builder V2 failed and terminal accounting could not be completed"), {
              code: "terminal_settlement_failed", classification: "accounting", retryable: true,
            });
          }
        }
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
