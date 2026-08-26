// Build Orchestrator (finish plan WP-8; master plan Parts 2 §1, 4 and 5).
//
// One build = one FIRST-GREEN increment loop: contract → tiers/bindings/intents → assets
// (zero model) → CORE (the essential set only) → gates → essential journeys → secondary
// increments one at a time → COMPLETE only when every contracted journey is green. Failed
// pre-green work remains an immutable repair checkpoint; it is never preview authority.
//
// The two MODEL SEAMS (contractFn, patchesFn) are injected. WP-8 proves the whole loop
// with deterministic fakes at zero credits; WP-9 wires the real lanes behind its spend
// gate. Everything else is the real machinery: the real patch engine, the real stage
// gates via the verification facade, the real asset service, the real snapshot protocol.

import crypto from "node:crypto";

import { indexTree } from "./indexer.mjs";
import { memoryGraph } from "./graphStore.mjs";
import { applyPatches, escalationPlan, patchOutcomes } from "./patchEngine.mjs";
import { completionEligibility } from "./contractTiering.mjs";
import { deriveBuildSpec, journeysInMountedScreenUnit, scopeBuildSpec } from "./buildSpec.mjs";
import { deriveVerificationManifest } from "./verificationManifest.mjs";
import { advisoryMessages, partitionFindings } from "./validationSeverity.mjs";
import {
  lintDurablePersistence, persistenceFindingMessages, persistenceRepairScope,
} from "./persistenceLint.mjs";
import {
  interactionDependencyProgress, interactionFailureDiagnostics, scopeInteractionContract,
} from "./interactionContract.mjs";
import {
  moduleCorrectionScope, validateModuleConformance, validateModulePatchScope,
} from "./moduleContracts.mjs";
import {
  verifyStage, attributeFailures, planJourneyVerification, recordJourneyVerdicts, memoryVerificationCache,
} from "./verification.mjs";
import {
  verificationDefects, actionableDefects, platformDefectsOf,
  defectEvidence, defectWriteBoundary, defectProgress, defectSignature,
  verificationDefectRecords,
} from "./verificationDefects.mjs";
import { createSnapshotStore } from "./snapshotStore.mjs";
import { serviceClient } from "../supabase.mjs";
import { generationPolicyFor } from "./generationPolicy.mjs";
import { composeCapabilityFoundation } from "./capabilityComposer.mjs";
import { composeScaffoldFoundation, validateScaffoldComposition } from "./scaffoldComposer.mjs";
import { transformWizardEntryState, wizardEntryTransformSummary } from "../appBuild/wizardEntryTransform.mjs";
import { MINIMAL_CONTRACT_VERIFIER_POLICY } from "../appBuild/verifierPolicy.mjs";

/**
 * Keep the complete contract needed to reconstruct an isolated journey separate from the
 * differential subset that must actually be driven. A cache hit may remove the primary journey
 * from `drivenJourneys`; its account/durable setup is still the only valid starting state for a
 * secondary journey and must never be scoped away with the cached verdicts.
 */
export function verificationExecutionContract(contract, scopedJourneys, drivenJourneys) {
  return {
    ...contract,
    journeys: scopedJourneys,
    allJourneys: contract?.journeys || scopedJourneys,
    prerequisiteInteractionContract: contract?.interactionContract || null,
    interactionContract: scopeInteractionContract(
      contract?.interactionContract,
      (drivenJourneys || []).map((row) => row.journey || row),
    ),
  };
}

/**
 * Type the browser's causal step evidence for a red tree.
 *
 * ONE derivation, shared by the in-build repair tier and the resumed repair of a retained
 * checkpoint, so a resumed repair cannot be briefed more weakly than the round that preceded it.
 */
export function browserRepairDefects({
  contract, interactionContract = contract?.interactionContract, journeyResults, tree,
  backendRowFailures = [], manifest = null,
} = {}) {
  return verificationDefects({
    contract, interactionContract, tree, backendRowFailures,
    journeyResults: journeyResults || { journeys: [], blockingErrors: [] },
    manifest: manifest || deriveVerificationManifest({ ...(contract || {}), interactionContract }),
  });
}

/** Preserve the browser's causal step evidence when handing a red retained tree to repair. */
export function browserRepairEvidence({
  contract, interactionContract = contract?.interactionContract, journeyResults, tree,
  backendRowFailures = [], advisory = [], manifest = null, defects = null,
} = {}) {
  const verdicts = journeyResults || { journeys: [], blockingErrors: [] };
  const typed = defects || browserRepairDefects({
    contract, interactionContract, journeyResults: verdicts, tree, backendRowFailures, manifest,
  });
  return [
    // Typed defects carry the sentence the repair scoping parses AND the enriched structured row:
    // class, owner, control identity, owning modules, the page's own text when it failed, the
    // console errors raised during that step and the probe's addressing evidence.
    ...defectEvidence(typed),
    ...(verdicts.blockingErrors || []),
    ...(advisory || []),
  ];
}

// ── build persistence (bv2_builds twin pattern) ───────────────────────────────────────────────

export function memoryBuildStore() {
  const rows = new Map();
  let counter = 0;
  return {
    async create(row) { const id = `build-${++counter}`; rows.set(id, { id, ...row, states: [row.state] }); return id; },
    async update(id, patch) {
      const row = rows.get(id);
      Object.assign(row, patch);
      if (patch.state) row.states.push(patch.state);
    },
    async get(id) { return rows.get(id) || null; },
  };
}

export function supabaseBuildStore(client = serviceClient()) {
  return {
    async create(row) {
      const { data, error } = await client.from("bv2_builds").insert(row).select("id").single();
      if (error) throw new Error(`build create: ${error.message}`);
      return data.id;
    },
    async update(id, patch) {
      const { error } = await client.from("bv2_builds").update(patch).eq("id", id);
      if (error) throw new Error(`build update: ${error.message}`);
    },
    async get(id) {
      const { data } = await client.from("bv2_builds").select("*").eq("id", id).maybeSingle();
      return data || null;
    },
  };
}

// ── asset injection ───────────────────────────────────────────────────────────────────────────

/**
 * The resolved AssetRefs become CONSTANTS the model consumes (master plan Part 18) — it
 * never sees a provider, never chooses a URL. Keyed by slot; deterministic render order.
 */
export function renderAssetData(resolved) {
  const bySlot = {};
  for (const { slot, via, asset } of [...resolved].sort((a, b) => a.slot.localeCompare(b.slot))) {
    bySlot[slot] = via === "placeholder"
      ? { placeholder: true, css: asset.css, alt: asset.alt }
      : {
        alt_text: asset.alt_text, original_url: asset.original_url,
        optimised_url: asset.optimised_url || null,
        width: asset.width || null, height: asset.height || null,
        variants: asset.variants || {},
        attribution: asset.license?.attribution || null,
      };
  }
  return [
    "// GENERATED by the Asset Service — licensed, cached project imagery keyed by slot.",
    "// Render via src/lib/assets.js (imageProps/pictureSources); do not hardcode image URLs.",
    `export const ASSETS = ${JSON.stringify(bySlot, null, 2)};`,
    "export const ASSET_CREDITS = Object.values(ASSETS).map((asset) => asset.attribution).filter(Boolean);",
    "",
  ].join("\n");
}

/** Provider API terms are deterministic release constraints, not prompt advice. */
export function lintAssetAttribution(tree, assets = []) {
  const requiresPexelsCredit = assets.some(({ via, asset }) => (
    via !== "placeholder"
    && asset?.provider === "pexels"
    && asset?.license?.apiLinkRequired === true
  ));
  if (!requiresPexelsCredit) return { ok: true, problems: [] };

  // Metadata in assetData.js is not proof that the generated application renders it.
  const uiSource = Object.entries(tree || {})
    .filter(([path]) => path !== "src/lib/assetData.js" && /^src\/.+\.(?:js|jsx|ts|tsx)$/.test(path))
    .map(([, source]) => String(source))
    .join("\n");
  const problems = [];
  if (!/\bASSET_CREDITS\b/.test(uiSource)) problems.push("Pexels API compliance: render credits from ASSET_CREDITS in generated UI");
  if (!/https:\/\/(?:www\.)?pexels\.com(?:\/|[\"'])/.test(uiSource)) problems.push("Pexels API compliance: include a visible link to https://www.pexels.com");
  if (!/\bphotoUrl\b/.test(uiSource)) problems.push("Pexels API compliance: link each available photographer credit to photoUrl");
  return { ok: problems.length === 0, problems };
}

const problemSignature = (problems) => (problems || []).map((p) => String(p).slice(0, 120)).sort().join("|");
const treeHash = (tree) => crypto.createHash("sha256").update(JSON.stringify(
  Object.fromEntries(Object.entries(tree || {}).sort(([a], [b]) => a.localeCompare(b))),
)).digest("hex");
const treesEqual = (a, b) => {
  const left = Object.keys(a || {}).sort();
  const right = Object.keys(b || {}).sort();
  return left.length === right.length && left.every((path, index) => path === right[index] && a[path] === b[path]);
};
const TARGETED_CANDIDATE_MAX_FILES = 3;
const sourcePaths = (values) => [...new Set((values || []).flatMap((value) => (
  String(value || "").match(/src\/[a-zA-Z0-9_./-]+\.(?:jsx?|tsx?|json|css)/g) || []
)).map((path) => path.replace(/[):,;]+$/, "")))].sort();
const directoryPrefix = (path) => path.includes("/") ? `${path.slice(0, path.lastIndexOf("/") + 1)}` : "";

export function targetedGateCorrection(gate, tree, contract = null) {
  const failure = gate?.layers?.d0d2?.failure;
  if (!failure?.kind || failure.kind === "expectations") return null;
  const findings = failure.findings || [];
  let files = [...new Set(findings.map((finding) => finding?.file).filter((file) => /^src\//.test(file)))];
  const unreachable = findings.filter((finding) => finding?.code === "journey_surface_unreachable");
  const extensionInterfaces = findings.filter((finding) => finding?.code === "custom_extension_invalid"
    && ((finding?.missingInputs || []).length || finding?.operation));
  const mountedIntegrationFiles = unreachable.flatMap((finding) => {
    if ((finding.mountedModules || []).length) return finding.mountedModules;
    const journeyIds = new Set(finding.journeyIds || []);
    if (!journeyIds.size) {
      for (const extension of contract?.scaffoldGraph?.extensions || []) {
        if (extension?.module === finding.file || (extension?.allowedFiles || []).includes(finding.file)) {
          for (const journeyId of extension.owningJourneys || []) journeyIds.add(journeyId);
        }
      }
    }
    return (contract?.scaffoldGraph?.journeyOwnership || [])
      .filter((owner) => journeyIds.has(owner?.journeyId)).map((owner) => owner.mountedModule);
  }).filter((file) => /^src\//.test(file));
  files = [...new Set([...files, ...mountedIntegrationFiles])];
  files = [...new Set([...files, ...sourcePaths([
    ...(gate.layers?.d0d2?.problems || []), failure.stderr || "",
  ])])].sort();
  // Several journey-owned child modules can all be valid yet unreachable for the same reason:
  // their one mounted screen forgot to import them. Including every child plus that screen made
  // an otherwise one-file integration fix exceed the targeted-correction width, so the
  // orchestrator discarded the candidate and regenerated the whole application. Preserve the
  // detailed findings in the brief, but when their combined scope is too wide, write only to the
  // mounted integration owner(s). Editing an unreachable child cannot make itself reachable.
  if (files.length > TARGETED_CANDIDATE_MAX_FILES && unreachable.length && mountedIntegrationFiles.length) {
    const unreachableFiles = new Set(unreachable.map((finding) => finding?.file).filter(Boolean));
    const integrationOnly = [...new Set([
      ...files.filter((path) => !unreachableFiles.has(path)),
      ...mountedIntegrationFiles,
    ])].sort();
    if (integrationOnly.length && integrationOnly.length <= TARGETED_CANDIDATE_MAX_FILES) files = integrationOnly;
  }
  if (failure.kind === "config" && !files.length) files = ["package.json"];
  if (!files.length || files.length > TARGETED_CANDIDATE_MAX_FILES) return null;
  const missing = files.filter((path) => typeof tree?.[path] !== "string");
  const allowedPrefixes = ["imports", "modularity", "runtime_dependency"].includes(failure.kind)
    ? [...new Set(files.map(directoryPrefix).filter((prefix) => prefix.startsWith("src/")))] : [];
  const sourceTokens = files.reduce((sum, path) => sum + Math.ceil(String(tree?.[path] || "").length / 4), 0);
  return {
    kind: failure.kind,
    files,
    allowedFiles: files,
    allowedPrefixes,
    findings,
    expectedPatchTokens: Math.min(8_000, Math.max(1_200, Math.ceil(sourceTokens * 1.2))),
    instruction: `Retain the candidate and correct the bounded ${failure.kind} failure in `
      + `[${files.join(", ")}]. ${missing.length ? `Create the missing module(s) [${missing.join(", ")}] `
        + "inside the allowed directory boundary. " : ""}`
      + (unreachable.length
        ? "Integrate the named journey module from its owning mounted screen and use its declared export in the live interaction; editing or re-exporting the unreachable module alone cannot make progress. "
        : "")
      + (extensionInterfaces.length
        ? "At the named custom-extension call site, pass every missing contract input as an explicit object property using its declared semantic key; an object spread or generic id alias is not sufficient. "
        : "")
      + "Do not regenerate the application or change unrelated working modules.",
  };
}

function structuralCandidateCorrection(applied) {
  if (!applied?.modularityFailed || !applied.provisionalTree) return null;
  const files = sourcePaths(applied.structuralProblems || []);
  if (!files.length || files.length > TARGETED_CANDIDATE_MAX_FILES) return null;
  const sourceTokens = files.reduce((sum, path) => (
    sum + Math.ceil(String(applied.provisionalTree?.[path] || "").length / 4)
  ), 0);
  return {
    kind: "structural_modularity",
    files,
    allowedFiles: files,
    allowedPrefixes: [...new Set(files.map(directoryPrefix).filter((prefix) => prefix.startsWith("src/")))],
    findings: (applied.structuralProblems || []).map((message) => ({ code: "tree_integrity_failed", message })),
    expectedPatchTokens: Math.min(8_000, Math.max(1_500, Math.ceil(sourceTokens * 1.2))),
    instruction: "The candidate parses and its sibling patches are valid, but the named module is structurally too broad. "
      + "Split its distinct responsibilities into focused sibling modules under the allowed directory, keep the existing "
      + "route/data/shell work, and leave final correctness gates unchanged.",
  };
}

// ── the orchestrator ──────────────────────────────────────────────────────────────────────────

function nextHeadroomContinuation(scope, moduleContracts, tree) {
  const remaining = [...new Set(scope?.remainingFiles || [])];
  if (!remaining.length) return null;
  const width = Math.max(1, Number(scope.batchWidth || scope.allowedFiles?.length || 1));
  const files = remaining.slice(0, width);
  const selected = (moduleContracts?.specifications || [])
    .filter((specification) => files.includes(specification.path));
  const sourceTokens = files.reduce((sum, path) => (
    sum + Math.ceil(String(tree?.[path] || "").length / 4)
  ), 0);
  const missingFileTokens = files.filter((path) => typeof tree?.[path] !== "string").length * 1_600;
  return {
    ...scope,
    batchIndex: Number(scope.batchIndex || 0) + 1,
    files,
    allowedFiles: files,
    remainingFiles: remaining.slice(width),
    moduleContracts: { version: moduleContracts?.version || 1, specifications: selected },
    expectedPatchTokens: Math.min(6_000, Math.max(1_000, missingFileTokens, Math.ceil(sourceTokens * 1.1))),
    instruction: "Continue the same approved build with only this next bounded module batch. "
      + `Complete [${files.join(", ")}], preserve every retained module, and do not touch unrelated files.`,
  };
}

/** The file a patch writes, whichever operation shape it used. */
const patchTargetPath = (patch) => patch?.file || patch?.newFile || patch?.replaceFile || patch?.deleteFile || null;

export function createOrchestrator({
  contractFn,                       // MODEL SEAM: async ({owner, projectId, request, profile}) → contract
  patchesFn,                        // MODEL SEAM: async ({step, contract, tiers, tree, assets, rejections, problems, journey}) → patches[]
  assetService,
  snapshotStore = createSnapshotStore(),
  buildStore = memoryBuildStore(),
  verificationCache = memoryVerificationCache(),
  verificationContext = {},          // safe release/runtime/config versions for cache identity
  journeysFn = null,                // browser layer: async ({tree, journeys, graph}) → {journeys:[{id,title,status,priority}]}
  backendProbeFn = null,            // D4 row check: async ({owner, projectId, contract, tiers}) → [{journeyId, detail}]
  maxJourneyRepairs = 2,            // V2-20 repair tier: targeted rounds against verified browser failures
  maxPrecompileCorrections = 2,     // deterministic pre-compile corrections; SEPARATE from the repair tier
  maxMechanicsCorrections = 1,      // probe-proven dead controls: a correction, never a repair round
  compile = async () => ({ ok: true }),
  baseTree,                         // () → scaffold tree (injected so tests pin the real REACT_VITE)
  baseline = null,                  // protected-path baseline for the stage gate
  extraGateOptions = {},            // e.g. { nodeModules, log } for live runs — merged into every gate call
  maxCoreAttempts = 3,              // REAL generation failures only: unusable output or a tree that will not compile
  // A dispatch that produced NO change to the tree is a protocol round, not a generation attempt.
  // A live build spent two of its three attempts on 4-second replies that re-emitted the scaffold's
  // own placeholder byte for byte, leaving ONE attempt to write an entire application. Bounded, so
  // a model that will only ever answer with no-ops still fails — just for the right reason.
  maxNoOpRetries = 2,
  events = {},                      // durable composition hooks: contract, patches, snapshot
  classifyContract = null,          // deterministic post-contract complexity refinement
  deriveEnvelope = null,             // validated contract -> immutable funding/execution envelope
  contractPreflight = null,          // contract-specific account/entity runtime proof
  deferGreenPromotion = false,       // production atomically promotes pointers + project projection
  log = () => {},
} = {}) {
  if (!contractFn || !patchesFn || !assetService || !baseTree) {
    throw new Error("orchestrator needs contractFn, patchesFn, assetService and baseTree");
  }

  const gateOptions = (contract, stepId, journeys, execution, modulePlan = []) => ({
    contract, stage: { id: stepId, journeys }, compile: (tree) => compile(tree, execution),
    modulePlan,
    ...(baseline ? { baseline } : {}), ...extraGateOptions,
  });

  const abortIfRequested = (signal) => {
    if (signal?.aborted) throw Object.assign(new Error("Builder V2 build cancelled."), {
      name: "AbortError", code: "cancelled",
    });
  };

  // Protected platform runtime upgrades with the worker. A checkpoint intentionally preserves
  // generated application source, but it must not preserve an old capability implementation:
  // doing so made a repaired app continue running the exact controlled-input bug the host had
  // already fixed. This is the same adoption rule used by edits, shared here so the paths cannot
  // drift again.
  const refreshPlatformRuntime = (tree) => {
    const refreshed = { ...tree };
    const currentPlatform = baseTree();
    for (const [path, source] of Object.entries(currentPlatform)) {
      if (/^src\/lib\/(?:capabilities\/|backend\/|visitorSession\.js$|assets\.js$)/.test(path)) {
        refreshed[path] = source;
      }
    }
    return refreshed;
  };

  const refreshDeterministicFoundation = (tree, spec) => composeScaffoldFoundation(
    composeCapabilityFoundation(refreshPlatformRuntime(tree), spec.capabilityGraph).tree,
    spec.scaffoldGraph,
  ).tree;

  async function verifyJourneySet({ owner, projectId, buildId, contract, journeys, tree, snapshotId, signal,
    forceFresh = false }) {
    abortIfRequested(signal);
    const graph = memoryGraph(owner, projectId, indexTree(tree));
    const scoped = { ...contract, journeys };
    const plan = await planJourneyVerification({
      owner, projectId, contract: scoped, identityContract: contract, graph, cache: verificationCache,
      verificationContext,
    });
    const drive = forceFresh
      ? journeys.map((journey) => ({ journey, journeyId: journey.id, cacheKey: null }))
      : plan.drive;
    const reused = forceFresh ? [] : plan.reused;
    let driven = { journeys: [] };
    if (drive.length && journeysFn) {
      const executionContract = verificationExecutionContract(contract, journeys, drive);
      driven = await journeysFn({ owner, projectId, buildId, tree,
        contract: executionContract,
        journeys: drive.map((d) => d.journey), graph, signal });
      abortIfRequested(signal);
      driven = { ...driven, journeys: attributeFailures(driven, graph, scoped) };
      if (!forceFresh) {
        await recordJourneyVerdicts({ owner, projectId, cache: verificationCache, plan, results: driven, snapshotId });
      }
      await events.telemetry?.({ owner, projectId, buildId, kind: "browser_verification_pass", details: {
        fresh: forceFresh, drivenJourneys: drive.length, reusedJourneys: reused.length,
        passedJourneys: (driven.journeys || []).filter((row) => row.status === "pass").length,
        failedJourneys: (driven.journeys || []).filter((row) => row.status !== "pass").length,
      } });
    }
    const platformDefects = driven.journeys.flatMap((j) => j.attributionDefect ? [j.attributionDefect] : []);
    const blockingErrors = [
      ...(driven.fatalErrors || []).map((detail) => `fatal browser runtime: ${detail}`),
    ];
    for (const defect of platformDefects) log(JSON.stringify({ event: "bv2.platform_defect", ...defect }));
    const merged = [
      ...driven.journeys,
      ...reused.map((r) => {
        const journey = journeys.find((j) => j.id === r.journeyId);
        return { id: r.journeyId, title: journey?.title, priority: journey?.priority, ...r.verdict, reused: true };
      }),
    ];
    return { journeys: merged, plan: { ...plan, drive, reused }, platformDefects, blockingErrors,
      unavailable: driven.unavailable === true,
      verifierError: driven.error || null,
      verifierDefects: driven.verifierDefects || [],
      // The pre-journey mechanics probe's verdict travels with the journey verdicts, so a repair
      // brief can lead with the control that provably cannot hold a value.
      mechanics: driven.mechanics || null,
      consoleErrors: driven.consoleErrors || [], failedRequests: driven.failedRequests || [],
      fatalErrors: driven.fatalErrors || [], advisories: driven.advisories || [],
      verifierPolicy: driven.verifierPolicy || verificationContext.verifierPolicy || null,
      failureRefs: driven.failureRefs || [] };
  }

  /**
   * Generate-and-gate one increment: up to maxCoreAttempts patch rounds, machine-taught
   * rejections fed straight back, the Part 4 stop rule on repeated identical failure.
   * Returns { ok, tree } or { ok:false, problems }.
   */
  async function buildIncrement({ step, owner, projectId, buildId, contract, tiers, bindings, tree, assets, journeys,
    editRequest = null, initialProblems = [], checkpointReason = `working:${step}`,
    parentSnapshotId = null, signal = null, spec = null, attemptPolicy = null, initialRepairScope = null,
    protocolRetryLimit = maxNoOpRetries,
    // Which ALLOWANCE this increment draws on, when the caller already knows. The reservation
    // layer counts `repair` and `correction` separately on purpose: a repair is a round briefed by
    // observed journey failure, a correction is a named structural fix. A mechanics failure is the
    // second kind — the browser proved one control cannot hold a value, which is a defect with an
    // address — so it must not spend the one browser-informed repair slot.
    dispatchAs = null,
    // The verifier's own attribution, as a machine-enforced write boundary. Unlike a repairScope
    // this does NOT turn the dispatch into a pre-compile correction: the browser-informed prompt,
    // its journey brief and its retrieval-sliced context are unchanged. It only says where the
    // fix may be written, and it is dropped after one out-of-scope attempt exactly as a
    // validator-owned scope is, so a mis-attributed boundary can never trap a build.
    repairBoundary: initialRepairBoundary = null,
    // Modules the caller wants rewritten outright. The escalation ladder inside this function
    // still adds its own; this is the tier above it asking for a clean re-emit of the files the
    // verifier attributed the failure to, after a narrower attempt failed to move the defect.
    regenerateFiles: forcedRegenerateFiles = [] }) {
    // A CORRECTION continues from the retained candidate; an ATTEMPT redoes the work from the
    // increment's starting tree. Keeping the distinction explicit stops a fresh generation from
    // colliding with files the discarded candidate already created.
    const originalTree = tree;
    let repairBoundary = initialRepairBoundary;
    let working = tree;
    let rejections = [];
    const rejectionHistory = [];
    let problems = initialProblems;
    let lastSignature = null;
    let repairScope = initialRepairScope;
    let contractCorrectionScope = null;
    let headroomScope = null;
    let retryAsCorrection = false;
    let moduleCorrectionUsed = false;
    let latestCandidate = null;
    let advisory = [];
    // Files already asked to split, so the instruction is issued once, not every round.
    // Held apart from `advisory`, which is REASSIGNED by the conformance and gate steps below
    // and would silently drop them — the first version of this did exactly that.
    const splitRequests = new Set();
    const splitFindings = [];
    // ONE derived specification, narrowed to this increment's journeys. Every view below —
    // module plan, interaction contract, per-module contracts, persistence ownership — is a
    // projection of the same object rather than an independent re-reading of the contract.
    const scoped = scopeBuildSpec(spec || deriveBuildSpec(contract, { journeys }), journeys);
    const { modulePlan, moduleContracts, bindings: scopedBindings, interactionContract: scopedInteractionContract } = scoped;

    // Two independent allowances. A core ATTEMPT means "that generation was unusable and the
    // work must be redone"; a CORRECTION means "the tree is usable and one named part needs
    // fixing". Conflating them is why narrow validator findings used to consume the same
    // budget as a failed generation and exhaust a build in three rounds.
    let attempts = 0;
    let corrections = 0;
    // Protocol rounds: dispatches that changed nothing at all. Counted, reported and bounded, but
    // never charged against the substantive generation attempts.
    let noOps = 0;
    const attemptLedger = [];
    const spend = () => attempts + corrections;
    const policy = attemptPolicy || generationPolicyFor("simple", {
      simpleAttempts: maxCoreAttempts, simpleCorrections: maxPrecompileCorrections,
    });
    const maxGenerationAttempts = policy.maxGenerationAttempts;
    const maxCandidateCorrections = policy.maxCandidateCorrections;
    const maxDispatches = maxGenerationAttempts + maxCandidateCorrections;
    const exhausted = () => attempts >= maxGenerationAttempts || spend() >= maxDispatches
      || noOps > protocolRetryLimit;
    const failure = (reason, extra = {}) => ({
      ok: false, reason, problems, advisory, advisoryFindings: advisory,
      candidateSnapshotId: latestCandidate?.id || null, repairUsed: !!repairScope,
      moduleCorrectionUsed, attempts, corrections, noOps, attemptLedger, ...extra,
    });
    // A browser-informed repair is one paid repair dispatch. Everything learned after that
    // dispatch is deterministic feedback about its patch (scope, syntax, integrity or gates), so
    // the follow-up belongs to the separate correction allowance. Re-booking it as `repair`
    // trips maxRepairs before the model can correct even a single malformed replace_exact.
    const scheduleCorrectionRetry = () => {
      if (corrections >= maxCandidateCorrections) return false;
      retryAsCorrection = true;
      corrections += 1;
      return true;
    };

    while (!exhausted()) {
      abortIfRequested(signal);
      const attempt = spend() + 1;
      // Pre-compile corrections dispatch under their own step identity so they draw on the
      // correction allowance, never on the single browser-informed repair slot.
      const scopeRejectionCorrection = retryAsCorrection;
      const dispatchStep = dispatchAs
        || headroomScope?.logicalStep
        || (scopeRejectionCorrection ? "correction" : null)
        || (repairScope ? "correction" : contractCorrectionScope ? "correction" : step);
      const correctionDispatch = dispatchStep === "correction";
      retryAsCorrection = false;
      // A scoped finding consumes the first correction before any patch is attempted. If that
      // patch is then rejected, a simple build has only one correction left. Use that final
      // dispatch for the escalation the patch engine promises instead of spending it on the same
      // fragile symbol surgery and discovering the repeated rejection only after the allowance is
      // gone. The boundary remains the validator-named file and every normal gate still runs.
      const finalCorrectionRegeneration = correctionDispatch
        && corrections >= maxCandidateCorrections
        ? [...new Set(rejectionHistory.map((row) => row.file)
          .filter((file) => file && Object.hasOwn(working, file)))]
        : [];
      const regenerateFiles = [...new Set([
        ...forcedRegenerateFiles,
        ...escalationPlan(rejectionHistory).regenerateFiles,
        ...finalCorrectionRegeneration,
      ])];
      const patches = await patchesFn({ step: dispatchStep, originalStep: step, owner, projectId, buildId, attempt,
        contract, tiers, tree: working, assets, rejections, problems, journey: journeys?.[0] || null,
        editRequest: repairScope?.instruction || contractCorrectionScope?.instruction || editRequest,
        modulePlan, moduleContracts, repairScope, moduleCorrectionScope: contractCorrectionScope, headroomScope,
        repairBoundary, regenerateFiles, advisory: [...splitFindings, ...advisory],
        dispatchReason: dispatchAs === "correction" ? "mechanics_correction"
          : scopeRejectionCorrection ? "scope_rejection_correction" : null,
        spec: scoped, signal });
      // The model lane may have split an oversized, not-yet-dispatched prompt into one bounded
      // continuation. Enforce that internal write boundary exactly like a validator-owned scope;
      // the following full-tree gates still decide whether more work is required.
      const activeScope = patches.dispatchScope || headroomScope || repairScope || contractCorrectionScope
        || repairBoundary;
      const internalHeadroomSplit = activeScope?.kind === "headroom_continuation";
      const patchScope = validateModulePatchScope(patches, activeScope);
      if (!patchScope.ok) {
        // Validator-owned correction scopes fall back to a full attempt. Internal headroom
        // continuations keep the same bounded scope so an oversized full prompt cannot reappear.
        rejections = patchScope.findings.map((finding) => ({ signature: finding.code, reason: JSON.stringify(finding) }));
        if (internalHeadroomSplit) {
          headroomScope = activeScope;
          attempts += 1;
        } else {
          repairScope = null;
          contractCorrectionScope = null;
          repairBoundary = null;
          // A rejected correction changes nothing. Keep the immutable candidate it was correcting;
          // resetting to the increment base discards clean sibling files and makes the next model
          // round repair paths that no longer exist.
          working = correctionDispatch && latestCandidate ? working : originalTree;
          // The browser-informed dispatch has already spent its one repair slot. A deterministic
          // scope rejection is re-briefed through the separate correction lane, so the model gets
          // the exact rejection without consuming another journey's repair share.
          if (!scheduleCorrectionRetry()) {
            return failure("the patch scope rejection remained after the correction allowance", {
              problems: rejections.map((row) => row.reason),
            });
          }
        }
        log(`${step}: scoped correction attempted ${patchScope.findings.length} out-of-scope write(s); `
          + `${internalHeadroomSplit ? "retrying the same bounded continuation" : "retrying unscoped"} `
          + `(attempt ${attempts}/${maxGenerationAttempts})`);
        continue;
      }
      const applied = applyPatches(working, patches, { contract });
      let retainedPartial = false;
      const retainedPatchRejections = [...(applied.rejected || [])];
      // A STRUCTURAL PROBLEM THE BATCH INHERITED IS AN INSTRUCTION, NOT A REJECTION.
      //
      // The patch was allowed to land because it did not make the file worse. But nobody has yet
      // asked for the file to be made SMALLER, and until somebody does, every future repair to it
      // stays as fragile as the ones that produced two browser verdicts from twenty-three
      // dispatches. So the next brief carries the split as work to do, naming the file.
      for (const problem of applied.inheritedStructuralProblems || []) {
        const path = (String(problem).match(/^(src\/[^\s]+)/) || [])[1] || null;
        if (splitRequests.has(path)) continue;
        splitRequests.add(path);
        splitFindings.push({
          code: "oversized_module_must_be_split",
          module: path,
          severity: "advisory",
          rationale: "every repair to this file is exact-text surgery on a module too large to patch reliably",
          message: `${problem}. Split it NOW, before fixing anything else in it: move each step or `
            + "concern into its own module under the same directory, re-export what the flow needs, and "
            + "keep the behaviour identical. A smaller module is the difference between a repair that "
            + "lands and one that does not.",
        });
      }
      let deterministicEntryChanges = [];
      if (!applied.modularityFailed && applied.tree) {
        const alignedEntry = transformWizardEntryState(applied.tree, { contract });
        if (alignedEntry.changes.length) {
          applied.tree = alignedEntry.tree;
          deterministicEntryChanges = alignedEntry.changes;
          log(`${step}: deterministic flow-entry identity — ${wizardEntryTransformSummary(alignedEntry)}`);
        }
      }
      const deterministicEntryFiles = new Set(deterministicEntryChanges.map((change) => change.file));
      const evidenceTree = applied.modularityFailed && applied.provisionalTree
        ? applied.provisionalTree : applied.tree;
      const filesChanged = [...new Set([
        ...Object.keys(evidenceTree).filter((path) => evidenceTree[path] !== working[path]),
        ...Object.keys(working).filter((path) => !(path in evidenceTree)),
      ])].sort();
      await events.patches?.({
        owner, projectId, buildId, step: dispatchStep, attempt, patches,
        outcome: applied.rejected.length ? "rejected" : "applied",
        rejected: applied.rejected, applied: applied.applied,
        outcomes: patchOutcomes(patches, applied), filesChanged,
      });
      if (applied.rejected.length) {
        headroomScope = null;
        rejectionHistory.push(...applied.rejected);
        rejections = applied.rejected;
        const classes = [...new Set(applied.rejected.map((row) => row.code).filter(Boolean))];
        const structuralScope = structuralCandidateCorrection(applied);
        if (structuralScope && corrections < maxCandidateCorrections) {
          const signature = problemSignature(applied.structuralProblems);
          if (signature === lastSignature) {
            return failure("the same structural defect survived a scoped correction (stop rule)", {
              problems: applied.structuralProblems,
            });
          }
          lastSignature = signature;
          problems = [...applied.structuralProblems];
          latestCandidate = await snapshotStore.createSnapshot(owner, projectId, applied.provisionalTree, {
            buildId, parent: latestCandidate?.id || parentSnapshotId,
            reason: `candidate:${step}:${attempt}:structural`,
            assetManifest: await assetService.assetManifestFor?.(owner, projectId) || [],
          });
          await events.checkpoint?.({ owner, projectId, buildId, snapshot: latestCandidate,
            tree: applied.provisionalTree, reason: `candidate:${step}:${attempt}:structural`, promotable: false });
          await events.candidateFindings?.({ owner, projectId, buildId, step, attempt,
            snapshotId: latestCandidate.id, advisory: [], blocking: structuralScope.findings });
          working = await snapshotStore.materialize(owner, latestCandidate.id);
          repairScope = structuralScope;
          contractCorrectionScope = null;
          corrections += 1;
          attemptLedger.push({ attempt, dispatch: dispatchStep, class: "structural_candidate_correction",
            substantive: true, rejected: applied.rejected.length, retainedFiles: filesChanged });
          log(`${step}: retained structurally invalid candidate ${latestCandidate.id}; correcting only `
            + `[${structuralScope.files.join(", ")}] instead of regenerating ${filesChanged.length} valid file(s)`);
          continue;
        }
        // RETAIN WHAT LANDED. applyPatches is per-patch, so the siblings of a bad patch are already
        // in the tree; rolling back to the original threw them away. A live build wrote eight sound
        // modules and one file with unbalanced braces, and lost all nine — then had to regenerate
        // the whole application from nothing with its remaining attempt.
        //
        // Safety is unchanged: the malformed source was NEVER applied, the retained tree is a
        // non-promotable candidate, and compile and browser verification still gate everything
        // downstream. An incomplete tree simply fails to compile, which is the correct answer.
        const retained = filesChanged.length > 0 && !applied.modularityFailed;
        if (retained) {
          retainedPartial = true;
          log(`${step}: ${applied.rejected.length} patch(es) rejected (${classes.join(", ")}); `
            + `retaining and validating ${filesChanged.length} file(s) that applied cleanly`);
          // A rejected sibling does not prove the retained tree is still red. In a live build the
          // required contact factory landed cleanly on attempt two, but an unrelated malformed
          // wizard patch skipped every gate; attempts three and four repeated that mistake and the
          // build finally returned the stale attempt-one "factory missing" problem. Let the normal
          // full-tree conformance/compile path below judge what actually landed. It will either
          // promote a genuinely runnable candidate or derive a fresh, scoped correction from the
          // current tree; rejected source itself remains excluded by applyPatches.
          attemptLedger.push({ attempt, dispatch: dispatchStep,
            class: `${classes[0] || "patch_not_applicable"}_partial_candidate`, substantive: true,
            rejected: applied.rejected.length, retainedFiles: filesChanged });
        } else {
          working = correctionDispatch && latestCandidate ? working : originalTree;
          log(`${step}: ${applied.rejected.length} patch op(s) rejected (${classes.join(", ")}), feeding reasons back`);
          if (step === "repair" || correctionDispatch) {
            if (!scheduleCorrectionRetry()) {
              return failure(`${step === "repair" ? "the repair" : "the candidate correction"} patch remained invalid after the correction allowance`, {
                problems: applied.rejected.map((row) => row.reason),
              });
            }
          } else {
            attempts += 1;
          }
          attemptLedger.push({ attempt, dispatch: dispatchStep, class: classes[0] || "patch_not_applicable",
            substantive: true, rejected: applied.rejected.length, retainedFiles: [] });
          continue;
        }
      }
      if (activeScope) {
        const outsideScope = filesChanged.filter((path) => !deterministicEntryFiles.has(path)
          && !(activeScope.allowedFiles || []).includes(path)
          && !(activeScope.allowedPrefixes || []).some((prefix) => path.startsWith(prefix)));
        if (outsideScope.length) {
          // A validator-owned correction that reached wider than its boundary drops back to a
          // full attempt. A headroom continuation remains bounded so it cannot reintroduce the
          // oversized prompt that caused the split.
          rejections = [{
            signature: "correction-scope",
            reason: `your correction changed ${outsideScope.join(", ")}, outside its boundary `
              + `[${activeScope.allowedFiles.join(", ")}]. Re-emit the fix for the named files only, `
              + "or address the problem across the step if it genuinely cannot be scoped.",
          }];
          if (internalHeadroomSplit) {
            headroomScope = activeScope;
          } else {
            repairScope = null;
            contractCorrectionScope = null;
            repairBoundary = null;
            working = correctionDispatch && latestCandidate ? working : originalTree;
          }
          if (step === "repair" || correctionDispatch) {
            if (!scheduleCorrectionRetry()) {
              return failure(`${step === "repair" ? "the repair" : "the candidate correction"} kept exceeding its write boundary after the correction allowance`, {
                problems: rejections.map((row) => row.reason),
              });
            }
          } else {
            attempts += 1;
          }
          log(`${step}: correction exceeded its boundary; `
            + `${internalHeadroomSplit ? "retrying the same bounded continuation" : "retrying unscoped"} `
            + `(attempt ${attempts}/${maxGenerationAttempts})`);
          continue;
        }
      }
      // No-op batches are rejected DETERMINISTICALLY, before a gate cycle is spent on them:
      // the first live run's model "replaced" a stub with its own identical content, twice.
      const changed = Object.keys(applied.tree).some((p) => applied.tree[p] !== working[p])
        || Object.keys(working).some((p) => !(p in applied.tree));
      if (!changed) {
        // A PROTOCOL round, not a generation attempt. It cost provider tokens and credits — both
        // still counted — but it produced no code, so charging it against the substantive attempts
        // punishes the build for a round in which nothing was written.
        //
        // NAME WHAT CHANGED NOTHING. A generic "your batch was byte-identical" leaves the model
        // free to send the same operation again, and on 2026-08-20 it sent the identical
        // `replace_symbol ROUTES` three times running and burned the build's protocol allowance.
        // The exact operations go back, so the next round can see what not to repeat.
        const noOpTargets = [...new Set(patches.map(patchTargetPath).filter(Boolean))];
        const noOpOperations = patches.flatMap((patch) => {
          const file = patchTargetPath(patch);
          if (Array.isArray(patch.ops) && patch.ops.length) {
            return patch.ops.map((op) => `${file}: ${op.op}${op.symbol ? ` ${op.symbol}` : ""}`);
          }
          return [`${file}: ${patch.newFile ? "newFile" : patch.replaceFile ? "replaceFile" : "write"}`];
        }).slice(0, 8);
        rejections = [{
          code: patches.length ? "patch_noop" : "empty_patch_envelope",
          signature: "no-op",
          file: noOpTargets[0] || null,
          operation: null,
          reason: patches.length
            ? `these operations left the file byte-identical because it ALREADY contains exactly that content: `
              + `${noOpOperations.join("; ")}. Do not send them again. Re-emitting current content is not `
              + "implementation: CREATE the required sections/pages as newFile entries (src/routes/…), register "
              + "them in src/App.jsx, and make every journey outcome visible as real UI text"
            : "you returned no patches at all — emit the files this step requires",
        }];
        // …and feed the ESCALATION LADDER. A file the model keeps rewriting to its own current
        // content does not need another symbol operation on it; the second identical no-op
        // promotes that file to a whole-file re-emit, exactly as a repeated rejection does.
        for (const file of noOpTargets) rejectionHistory.push({ signature: `${file}:noop` });
        working = internalHeadroomSplit || (correctionDispatch && latestCandidate) ? working : originalTree;
        noOps += 1;
        if ((step === "repair" || correctionDispatch) && !scheduleCorrectionRetry()) {
          return failure(`${step === "repair" ? "the repair" : "the candidate correction"} produced no applicable change after the correction allowance`, {
            code: "no_substantive_repair",
          });
        }
        attemptLedger.push({ attempt, dispatch: dispatchStep,
          class: patches.length ? "patch_noop" : "empty_patch_envelope", substantive: false });
        log(`${step}: no-op batch rejected deterministically `
          + `(protocol round ${noOps}/${protocolRetryLimit}, generation attempts still ${attempts}/${maxGenerationAttempts})`);
        continue;
      }

      // ── EARLIEST SAFE CHECKPOINT ────────────────────────────────────────────────────────
      // Patches applied, tree integrity holds, write scope honoured. That is everything
      // required to make this tree resumable, so it is captured HERE — before any shape gate.
      //
      // It used to be captured after module conformance, which meant the failure class that
      // dominated live runs produced no checkpoint at all: four consecutive qualifications
      // ended "targeted repair: not run because no immutable working checkpoint existed",
      // and a usable tree was discarded because a static validator disliked its shape.
      // The candidate stays non-promotable, non-preview, non-publishable until compile and
      // browser verification pass — that guarantee is unchanged.
      latestCandidate = await snapshotStore.createSnapshot(owner, projectId, applied.tree, {
        buildId, parent: latestCandidate?.id || parentSnapshotId, reason: `candidate:${step}:${attempt}`,
        assetManifest: await assetService.assetManifestFor?.(owner, projectId) || [],
      });
      await events.checkpoint?.({ owner, projectId, buildId, snapshot: latestCandidate,
        tree: applied.tree, reason: `candidate:${step}:${attempt}`, promotable: false });

      if (internalHeadroomSplit && activeScope.remainingFiles?.length) {
        working = applied.tree;
        headroomScope = nextHeadroomContinuation(activeScope, moduleContracts, working);
        repairScope = null;
        contractCorrectionScope = null;
        attemptLedger.push({ attempt, dispatch: dispatchStep, class: "headroom_continuation",
          substantive: true, retainedFiles: filesChanged });
        log(`${step}: retained headroom batch ${latestCandidate.id}; continuing automatically with `
          + `[${headroomScope.allowedFiles.join(", ")}] (${headroomScope.remainingFiles.length} queued file(s) after it)`);
        continue;
      }
      headroomScope = null;

      // Shape analysis now RECORDS rather than rejects. Only genuine safety/integrity findings
      // (see validationSeverity) can stop a candidate that is otherwise runnable.
      const conformance = validateModuleConformance(applied.tree, {
        contract, modulePlan, moduleContracts, interactionContract: scopedInteractionContract, bindings: scopedBindings,
        capabilityGraph: scoped.capabilityGraph,
      });
      const persistence = lintDurablePersistence(applied.tree, { contract, journeys, modulePlan });
      const persistenceVerdict = partitionFindings(persistence.findings || []);
      advisory = [...(conformance.advisory || []), ...persistenceVerdict.advisory];
      const blocking = [...(conformance.blocking || []), ...persistenceVerdict.blocking];
      if (advisory.length) {
        log(`${step}: ${advisory.length} advisory finding(s) recorded; the candidate remains runnable`);
      }
      await events.candidateFindings?.({ owner, projectId, buildId, step, attempt,
        snapshotId: latestCandidate.id, advisory, blocking });

      if (blocking.length) {
        const blockingProblems = blocking.map((finding) => JSON.stringify(finding));
        const signature = problemSignature(blockingProblems);
        if (signature === lastSignature) {
          return failure("the same blocking defect survived a scoped correction (stop rule)",
            { problems: blockingProblems });
        }
        if (corrections >= maxCandidateCorrections) {
          return failure("blocking pre-compile findings remain after the correction allowance",
            { problems: blockingProblems });
        }
        lastSignature = signature;
        problems = blockingProblems;
        // A partial candidate has two independent facts: what failed to apply and what the
        // resulting full tree still lacks. Keep both. Dropping the first fact makes the next
        // dispatch repeat malformed surgery; dropping the second returns stale problems.
        rejections = retainedPartial ? [...retainedPatchRejections] : [];

        // A persistence violation names its own write boundary; other blocking findings are
        // scoped by the modules they actually name. Either way the candidate is RETAINED and
        // the correction draws on its own allowance.
        if (persistenceVerdict.blocking.length) {
          repairScope = persistenceRepairScope({ findings: persistenceVerdict.blocking }, modulePlan);
          contractCorrectionScope = null;
          working = await snapshotStore.materialize(owner, latestCandidate.id);
          corrections += 1;
          log(`${step}: ${persistenceVerdict.blocking.length} forbidden-persistence finding(s); `
            + `checkpoint ${latestCandidate.id} retained and one scoped correction selected`);
          continue;
        }
        const scope = moduleCorrectionScope(conformance, moduleContracts);
        if (conformance.correction.wholeCoreRequired || !scope.allowedFiles.length) {
          // Widespread or unattributable: no honest boundary exists, so this is a real
          // generation attempt rather than a correction, and the step starts over.
          repairScope = null;
          contractCorrectionScope = null;
          rejections.push(...blockingProblems.map((reason) => ({ signature: "blocking-defect", reason })));
          // Clean siblings from a partially accepted batch remain valuable even when the current
          // blocker has no honest narrow scope. Retry the unfinished work over that immutable
          // checkpoint; only a wholly applied but unusable generation restarts from the increment
          // base to avoid colliding with an abandoned design.
          working = retainedPartial
            ? await snapshotStore.materialize(owner, latestCandidate.id)
            : originalTree;
          if (step === "repair") {
            if (!scheduleCorrectionRetry()) {
              return failure("the repair's blocking findings remained after the correction allowance", {
                problems: blockingProblems,
              });
            }
          } else {
            attempts += 1;
          }
          log(`${step}: ${blocking.length} widespread or unmapped blocking defect(s) require a whole-core `
            + `retry (attempt ${attempts}/${maxGenerationAttempts})`);
          continue;
        }
        contractCorrectionScope = scope;
        repairScope = null;
        moduleCorrectionUsed = true;
        working = await snapshotStore.materialize(owner, latestCandidate.id);
        corrections += 1;
        log(`${step}: ${blocking.length} blocking defect(s); retaining the tree and correcting only `
          + `[${scope.allowedFiles.join(", ")}]`);
        continue;
      }
      repairScope = null;
      contractCorrectionScope = null;
      const assetCompliance = lintAssetAttribution(applied.tree, assets);
      if (!assetCompliance.ok) {
        rejections = assetCompliance.problems.map((reason) => ({ signature: "asset-attribution", reason }));
        if (!scheduleCorrectionRetry()) {
          return failure("asset-attribution defects remained after the correction allowance", {
            problems: assetCompliance.problems,
          });
        }
        log(`${step}: ${assetCompliance.problems.length} asset-attribution defect(s) rejected deterministically`);
        continue;
      }
      abortIfRequested(signal);
      const gate = await verifyStage(applied.tree, gateOptions(contract, step, journeys, {
        owner, projectId, buildId, step, attempt, signal,
      }, scoped.modulePlan));
      advisory = [...advisory, ...(gate.advisory || [])];
      const staticFindings = gate.layers?.d0d2?.failure?.kind === "static_application"
        ? gate.layers.d0d2.failure.findings || [] : [];
      const protectedScaffoldFiles = new Set(scoped.scaffoldCompositionPlan?.protectedFiles || []);
      await events.telemetry?.({ owner, projectId, buildId, kind: "scaffold_generation_surface", details: {
        step, attempt,
        modelGeneratedFiles: filesChanged.filter((path) => !protectedScaffoldFiles.has(path)
          && !deterministicEntryFiles.has(path)),
        deterministicIntegrationFiles: [...deterministicEntryFiles].sort(),
        customExtensionFiles: filesChanged.filter((path) => (scoped.scaffoldGraph?.extensions || [])
          .some((extension) => extension.module === path)),
        preBrowserStaticFailures: staticFindings.length,
        reachabilityFailures: staticFindings.filter((finding) => finding.code === "journey_surface_unreachable").length,
      } });
      if (gate.ok) {
        let qualifiedCandidate = latestCandidate;
        if (!treesEqual(applied.tree, gate.tree)) {
          qualifiedCandidate = await snapshotStore.createSnapshot(owner, projectId, gate.tree, {
            buildId, parent: latestCandidate.id, reason: `candidate:${step}:${attempt}:corrected`,
            assetManifest: await assetService.assetManifestFor?.(owner, projectId) || [],
          });
          await events.checkpoint?.({ owner, projectId, buildId, snapshot: qualifiedCandidate,
            tree: gate.tree, reason: `candidate:${step}:${attempt}:corrected`, promotable: false });
        }
        if (retainedPartial && step === "repair") {
          // A browser-informed repair is not complete merely because its accepted siblings still
          // compile. The rejected operations were selected to fix observed customer evidence; an
          // early browser rerun spends the one repair slot before those causal edits receive their
          // separate deterministic correction allowance. Core generation may accept a runnable
          // subset, but a partial repair must finish the refused work before paid re-verification.
          if (!scheduleCorrectionRetry()) {
            return failure("the repair remained partially rejected after the correction allowance", {
              problems: retainedPatchRejections.map((row) => row.reason),
            });
          }
          latestCandidate = qualifiedCandidate;
          working = await snapshotStore.materialize(owner, qualifiedCandidate.id);
          rejections = [...retainedPatchRejections];
          attemptLedger.push({ attempt, dispatch: dispatchStep, class: "partial_repair_correction",
            substantive: true, rejected: retainedPatchRejections.length, retainedFiles: filesChanged });
          log(`${step}: retained ${filesChanged.length} clean file(s), but ${retainedPatchRejections.length} `
            + "browser-repair operation(s) were rejected; finishing them through correction allowance before re-verification");
          continue;
        }
        return { ok: true, tree: gate.tree, snapshot: qualifiedCandidate,
          candidateSnapshotId: latestCandidate.id, checkpointReason, repairUsed: !!repairScope,
          moduleCorrectionUsed, advisory, advisoryFindings: advisory, attempts, corrections };
      }
      const gateProblems = gate.layers.d0d2.problems || [];
      const signature = problemSignature(gateProblems);
      if (signature === lastSignature) {
        return failure("the same defect survived a repair round (stop rule)", { problems: gateProblems });
      }
      lastSignature = signature;
      problems = gateProblems;
      rejections = retainedPartial ? [...retainedPatchRejections] : [];
      const gateScope = targetedGateCorrection(gate, gate.tree || applied.tree, contract);
      if (gateScope && corrections < maxCandidateCorrections) {
        if (!treesEqual(applied.tree, gate.tree)) {
          latestCandidate = await snapshotStore.createSnapshot(owner, projectId, gate.tree, {
            buildId, parent: latestCandidate.id, reason: `candidate:${step}:${attempt}:deterministic`,
            assetManifest: await assetService.assetManifestFor?.(owner, projectId) || [],
          });
          await events.checkpoint?.({ owner, projectId, buildId, snapshot: latestCandidate,
            tree: gate.tree, reason: `candidate:${step}:${attempt}:deterministic`, promotable: false });
        }
        working = await snapshotStore.materialize(owner, latestCandidate.id);
        repairScope = gateScope;
        contractCorrectionScope = null;
        corrections += 1;
        attemptLedger.push({ attempt, dispatch: dispatchStep, class: `${gateScope.kind}_candidate_correction`,
          substantive: true, problems: gateProblems.length, retainedFiles: gateScope.files });
        log(`${step}: retained candidate ${latestCandidate.id}; bounded ${gateScope.kind} failure will correct only `
          + `[${gateScope.files.join(", ")}] (${corrections}/${maxCandidateCorrections} corrections): `
          + gateProblems.slice(0, 3).join("; "));
        continue;
      }
      // No honest bounded repair scope exists. This is a real full-generation failure.
      working = retainedPartial
        ? await snapshotStore.materialize(owner, latestCandidate.id)
        : originalTree;
      if (step === "repair") {
        if (!scheduleCorrectionRetry()) {
          return failure("the repair gate remained red after the correction allowance", {
            problems: gateProblems,
          });
        }
      } else {
        attempts += 1;
      }
      attemptLedger.push({ attempt, dispatch: dispatchStep,
        class: gate.layers.d0d2.failure?.kind || "gate_failed", substantive: true,
        problems: gateProblems.length });
      log(`${step}: gate failed (${gateProblems.length} problem(s)), attempt ${attempts}/${maxGenerationAttempts}`);
    }
    // Say WHICH ceiling ended the step. "No runnable tree in 3 attempts" read identically whether
    // the model wrote three broken applications or none at all.
    if (noOps > protocolRetryLimit) {
      return failure(`no substantive generation: ${noOps} consecutive protocol round(s) changed nothing `
        + `(generation attempts used: ${attempts}/${maxGenerationAttempts})`, { code: "no_substantive_generation" });
    }
    return failure(attempts >= maxGenerationAttempts
      ? `no runnable tree within ${maxGenerationAttempts} generation attempts`
      : `no runnable tree within ${maxDispatches} dispatches (${attempts} attempt(s), ${corrections} correction(s))`);
  }

  return {
    async runBuild({ owner, projectId, request, profile = "simple", buildProfile = null, budgetCredits = null,
      maxRepairs = maxJourneyRepairs, userCritical = [], signal = null }) {
      const buildId = await buildStore.create({
        owner, project_id: projectId, profile, request, state: "created",
        verifier_policy: MINIMAL_CONTRACT_VERIFIER_POLICY,
        budget_credits: budgetCredits, max_repair_dispatches: maxRepairs,
        started_at: new Date().toISOString(),
      });
      await events.buildCreated?.({ owner, projectId, buildId, mode: "build" });
      // Only REAL bv2_builds columns reach the store; everything else is return-value only
      // (the first live run died writing `problems` into the table). A store failure at
      // finish must never mask the build's actual outcome.
      const PERSISTED_FIELDS = ["error", "final_snapshot", "contract_id", "spent_credits",
        "failure", "customer_state", "last_durable_progress_at"];
      const finish = async (state, extra = {}) => {
        const patch = { state, finished_at: new Date().toISOString() };
        for (const key of PERSISTED_FIELDS) if (key in extra) patch[key] = extra[key];
        try {
          await buildStore.update(buildId, patch);
        } catch (error) {
          log(`build row update failed (result unaffected): ${error.message}`);
        }
        return { buildId, state, ...extra };
      };

      // State transitions are telemetry — a transient store failure must never kill a
      // build that has already spent money.
      const setState = async (state) => {
        try { await buildStore.update(buildId, { state }); } catch (error) { log(`state update failed: ${error.message}`); }
        try { await events.state?.({ owner, projectId, buildId, state }); }
        catch (error) { log(`customer state projection failed: ${error.message}`); }
      };

      let workingSnapshot = null;
      let repairRoundCeiling = maxRepairs;
      try {
        abortIfRequested(signal);
        // 1. contract → tiers, capability bindings, image intents (deterministic after the call).
        await setState("contracting");
        const rawContract = await contractFn({ owner, projectId, buildId, request, profile, buildProfile, signal });
        // ONE derivation for the whole build: tiers, bindings, module plan, interaction
        // contract, per-module contracts, persistence ownership and image intents all come
        // from here and are passed down, so no subsystem re-reads the contract prose alone.
        let spec = deriveBuildSpec(rawContract, { userCritical });
        const failingGates = (verdict) => ["interaction", "capabilityGraph", "scaffoldGraph", "buildProfile"]
          .filter((gate) => verdict?.[gate] && !verdict[gate].ok);
        let contractRepairUsed = false;
        if (!spec.verdict.ok) {
          // ONE targeted contract repair before the build dies. The contract lane deliberately
          // returns a degraded contract rather than nothing, and this gate then rejected it on
          // checks the lane had already failed — two paid contract calls, zero generation, and a
          // sentence that named nothing. The model is now shown exactly what the derived spec
          // could not satisfy, and gets one attempt to close it.
          log(`contract gate rejected the contract (${failingGates(spec.verdict).join(", ")}): `
            + `${(spec.verdict.problems || []).join(" | ")}`);
          try {
            const dependencyIssuesBefore = spec.verdict.interaction?.issues || [];
            const repairedContract = await contractFn({
              owner, projectId, buildId, request, profile, buildProfile, signal,
              priorContract: rawContract, problems: spec.verdict.problems || [],
              issues: dependencyIssuesBefore,
            });
            // Whatever the repair produced is now the build's contract: when it still fails, its
            // problems — not the superseded first attempt's — are what the build died on.
            spec = deriveBuildSpec(repairedContract, { userCritical });
            contractRepairUsed = true;
            const dependencyProgress = interactionDependencyProgress(
              dependencyIssuesBefore, spec.verdict.interaction?.issues || [],
            );
            if (dependencyProgress.equivalent) {
              log("contract repair made no dependency progress; the same missing producer remains");
            }
            log(`contract repair ${spec.verdict.ok ? "produced a derivable contract" : "did not close the gate"}`);
          } catch (error) {
            abortIfRequested(signal);
            log(`contract repair unavailable (${error.message}); reporting the original gate result`);
          }
        }
        if (!spec.verdict.ok) {
          // Say WHAT is incomplete. The bare sentence was unactionable: it read identically for a
          // missing state owner, an uncovered capability responsibility and an unmet intake
          // obligation, and the problems never reached a log or the build row.
          const problems = spec.verdict.problems || [];
          const failing = failingGates(spec.verdict);
          log(`contract blocked before generation (${failing.join(", ") || "unknown gate"}): `
            + problems.join(" | "));
          return finish("blocked", {
            error: `interaction contract is structurally incomplete before generation`
              + `${problems.length ? `: ${problems.slice(0, 3).join("; ")}` : ""}`
              + `${problems.length > 3 ? ` (+${problems.length - 3} more)` : ""}`,
            problems,
            failingGates: failing,
            contractRepairUsed,
            failureClassification: "interaction_contract_invalid",
          });
        }
        const { contract, tiers, bindings, interactionContract } = spec;
        const intents = spec.imageIntents;
        const refinedProfile = await classifyContract?.({ request, contract, profile }) || profile;
        const buildAttemptPolicy = generationPolicyFor(refinedProfile, {
          simpleAttempts: maxCoreAttempts, simpleCorrections: maxPrecompileCorrections,
        });
        // One browser-informed repair round owns exactly one durable repair dispatch. Deterministic
        // candidate corrections still use their separate correction allowance, but parse, no-op or
        // full-generation retries become the next outer round. This keeps fair-share accounting in
        // the same unit the database enforces and prevents one journey consuming another's slots.
        const repairAttemptPolicy = {
          profile: buildAttemptPolicy.profile,
          maxGenerationAttempts: 1,
          maxCandidateCorrections: buildAttemptPolicy.maxCandidateCorrections,
        };
        log(`generation policy: ${buildAttemptPolicy.profile} â€” ${buildAttemptPolicy.maxGenerationAttempts} `
          + `full attempts, ${buildAttemptPolicy.maxCandidateCorrections} retained-candidate corrections; `
          + "the approved build credit ceiling remains authoritative");
        if (refinedProfile !== profile) {
          try { await buildStore.update(buildId, { profile: refinedProfile }); }
          catch (error) { log(`profile refinement failed: ${error.message}`); }
        }
        const envelope = deriveEnvelope ? await deriveEnvelope({
          owner, projectId, buildId, request, contract, spec, profile: refinedProfile,
        }) : null;
        if (envelope) {
          repairRoundCeiling = Math.max(1, Math.min(maxRepairs,
            Number(envelope.thralloRecovery?.strategyCapacity || maxRepairs)));
          await events.envelope?.({ owner, projectId, buildId, envelope });
          await events.progress?.({ owner, projectId, buildId, kind: "validated_contract", details: {
            contractHash: envelope.contractHash, complexityBand: envelope.complexityBand,
          } });
          if (envelope.approvalRequired) {
            return finish("blocked", {
              error: "The validated contract needs a revised generation approval before core generation.",
              failureClassification: "revised_scope_approval_required",
              actionRequired: true,
              customerState: "action_required",
              envelope,
            });
          }
        }
        const persistedContract = await events.contract?.({ owner, projectId, buildId, contract, tiers,
          bindings, intents });
        if (persistedContract?.id) {
          try { await buildStore.update(buildId, { contract_id: persistedContract.id }); }
          catch (error) { log(`contract id update failed: ${error.message}`); }
        }

        // Capability proof is proportional to the validated contract. Static sites stop after the
        // zero-network runtime/config proof; account and entity probes run only when contracted.
        if (contractPreflight) {
          await setState("capability_preflight");
          await contractPreflight({ owner, projectId, buildId, contract, spec, envelope });
          await events.progress?.({ owner, projectId, buildId, kind: "capability_preflight", details: {
            requirements: envelope?.runtimeRequirements || null,
          } });
        }

        // 2. assets resolve BEFORE any generation, zero model turns, cache-first.
        await setState("assets");
        abortIfRequested(signal);
        const { resolved, providerCalls } = await assetService.resolveIntents(owner, projectId, intents);
        abortIfRequested(signal);
        log(`assets: ${resolved.length} slot(s), ${providerCalls} provider call(s)`);

        const journeysById = new Map((contract.journeys || []).map((j) => [j.id, j]));
        const essentialJourneys = tiers.essential.journeys.map((id) => journeysById.get(id)).filter(Boolean);
        const secondaryJourneys = tiers.secondary.journeys.map((id) => journeysById.get(id)).filter(Boolean);
        const coreJourneys = journeysInMountedScreenUnit(spec, essentialJourneys);
        const coreJourneyIds = new Set(coreJourneys.map((journey) => journey.id));
        const incrementJourneys = secondaryJourneys.filter((journey) => !coreJourneyIds.has(journey.id));
        // This override is local to generation scope. It does not alter the persisted product tier:
        // it tells the model that every journey writing the core's mounted screen is in this batch.
        const coreGenerationTiers = {
          ...tiers,
          essential: { ...tiers.essential, journeys: [...coreJourneyIds] },
        };
        const evaluateCore = (nextVerdicts, rows = []) => completionEligibility({
          contract: { ...contract, journeys: coreJourneys }, gates: { ok: true },
          journeyResults: { journeys: nextVerdicts.journeys }, backendRowFailures: rows,
          blockingErrors: nextVerdicts.blockingErrors,
        });

        // 3. Deterministic application foundation. This zero-model checkpoint is deliberately
        // earlier than product generation: later optional/custom work may fail, but it cannot
        // erase the known-good router, mounted screens, capability adapters or extension seams.
        await setState("compose_scaffold");
        const compositionStartedAt = Date.now();
        const capabilityFoundation = composeCapabilityFoundation(baseTree(), spec.capabilityGraph);
        const scaffoldFoundation = composeScaffoldFoundation(capabilityFoundation.tree, spec.scaffoldGraph);
        let tree = scaffoldFoundation.tree;
        tree["src/lib/assetData.js"] = renderAssetData(resolved);
        const foundationVerdict = validateScaffoldComposition(tree, spec.scaffoldGraph,
          scaffoldFoundation.plan, { requireExtensions: false, rejectScreenSlots: false });
        if (!foundationVerdict.ok) return finish("blocked", {
          error: `Builder V2 scaffold composition failed: ${foundationVerdict.problems.join("; ")}`,
          failureClassification: "scaffold_platform_defect", problems: foundationVerdict.problems,
        });
        const foundationBuild = await compile(tree, {
          owner, projectId, buildId, step: "scaffold_foundation", attempt: 0, signal,
        });
        if (!foundationBuild?.ok) return finish("blocked", {
          error: `Builder V2 scaffold foundation did not compile: ${String(foundationBuild?.stderr || "unknown compiler failure").slice(0, 1200)}`,
          failureClassification: "scaffold_platform_defect",
        });
        workingSnapshot = await snapshotStore.createSnapshot(owner, projectId, tree, {
          buildId, parent: null, reason: "foundation:scaffold",
          assetManifest: await assetService.assetManifestFor?.(owner, projectId) || [],
        });
        await events.checkpoint?.({ owner, projectId, buildId, snapshot: workingSnapshot, tree,
          reason: "foundation:scaffold", promotable: false });
        await events.telemetry?.({ owner, projectId, buildId, kind: "scaffold_composition", details: {
          scaffoldGraphVersion: spec.scaffoldGraph.version,
          registryVersion: spec.scaffoldGraph.registryVersion,
          families: spec.scaffoldGraph.families.map((node) => node.scaffoldId),
          deterministicFiles: scaffoldFoundation.deterministicFilesCreated,
          screenSlots: scaffoldFoundation.screenSlotsCreated,
          customExtensions: spec.scaffoldGraph.extensions.map((extension) => extension.module),
          checkpointId: workingSnapshot.id,
          compositionDurationMs: Math.max(0, Date.now() - compositionStartedAt),
        } });

        // 4. CORE: every journey in the essential product screen's model-owned write unit.
        await setState("core");
        const core = await buildIncrement({
          step: "core", owner, projectId, buildId, contract, tiers: coreGenerationTiers,
          bindings, tree, assets: resolved, journeys: coreJourneys, checkpointReason: "working:core",
          parentSnapshotId: workingSnapshot.id, signal, spec,
          attemptPolicy: buildAttemptPolicy,
        });
        if (!core.ok) return finish("blocked", { error: core.reason, problems: core.problems,
          advisoryFindings: core.advisory || [],
          coreAttempts: core.attempts, coreCorrections: core.corrections,
          workingSnapshotId: core.candidateSnapshotId || workingSnapshot?.id || null });
        tree = core.tree;
        await events.progress?.({ owner, projectId, buildId, kind: "completed_required_generation_module",
          details: { step: "core", snapshotId: core.snapshot?.id || null } });
        const coreAdvisory = core.advisory || [];
        workingSnapshot = core.snapshot;
        let workingReason = "working:core";

        // A verifier that cannot supply a valid fixture or cannot run is a PLATFORM failure, not
        // evidence that generated source is wrong. Preserve the candidate and stop before a model
        // repair turn. The live Roblox-concept run spent both repair rounds trying to fix JSX for
        // a 14-character fixture the verifier itself had put into a 20-character prompt.
        const blockOnVerifierPlatformFailure = async (verdicts, derivedDefects = []) => {
          const derivedPlatformDefects = platformDefectsOf(derivedDefects);
          const platformOnly = derivedPlatformDefects.length > 0
            && actionableDefects(derivedDefects).length === 0;
          const defects = [
            ...(verdicts.verifierDefects || []),
            ...(platformOnly ? derivedPlatformDefects : []),
          ];
          if (verdicts.unavailable) defects.push({ code: "journey_verifier_unavailable",
            detail: verdicts.verifierError || "the browser verifier was unavailable" });
          const uniqueDefects = [...new Map(defects.map((defect) => [
            [defect.code, defect.journeyId, defect.stepIndex].join(":"), defect,
          ])).values()];
          if (!uniqueDefects.length) return null;
          const reason = uniqueDefects.map((defect) => `${defect.code}: ${
            defect.detail || defect.evidence?.observed || "verification platform failure"
          }`).join("; ");
          return finish("blocked", {
            error: `Builder V2 verification platform failure: ${reason}`,
            failureClassification: "verification_platform_defect",
            platformDefects: uniqueDefects,
            workingSnapshotId: workingSnapshot?.id || null,
          });
        };

        // 4. verify essential journeys (differential), then the C4 eligibility decision —
        //    with the V2-20 repair tier between them: a verified BROWSER failure earns up
        //    to maxRepairs targeted rounds, each briefed with the exact step
        //    evidence, each re-verified differentially (passing journeys reuse verdicts).
        await setState("verify_core");
        let coreVerdicts = await verifyJourneySet({ owner, projectId, buildId, contract,
          journeys: coreJourneys, tree, snapshotId: null, signal });
        let verifierBlock = await blockOnVerifierPlatformFailure(coreVerdicts);
        if (verifierBlock) return verifierBlock;
        let backendRowFailures = backendProbeFn ? await backendProbeFn({
          owner, projectId, contract, tiers, journeyResults: coreVerdicts.journeys,
        }) : [];
        let eligibility = evaluateCore(coreVerdicts, backendRowFailures);
        // ONE typed view of what the browser proved, recomputed after every verification. Class,
        // owner, control identity and owning modules come from here; nothing below re-reads prose.
        const verificationManifest = deriveVerificationManifest(spec || deriveBuildSpec(contract));
        const defectsFor = (verdicts, rows, evidenceTree = tree) => browserRepairDefects({
          contract, interactionContract, journeyResults: verdicts, tree: evidenceTree,
          backendRowFailures: rows, manifest: verificationManifest,
        });
        const persistDefects = async (defects, evidenceTree, candidateSnapshotId = null) => {
          if (!defects?.length) return;
          await events.verificationDefects?.({ owner, projectId, buildId,
            records: verificationDefectRecords(defects, {
              sourceTreeHash: treeHash(evidenceTree), candidateSnapshotId,
            }) });
        };
        let coreDefects = defectsFor(coreVerdicts, backendRowFailures);
        await persistDefects(coreDefects, tree, workingSnapshot?.id || null);
        verifierBlock = await blockOnVerifierPlatformFailure(coreVerdicts, coreDefects);
        if (verifierBlock) return verifierBlock;
        let repairsAttempted = 0;
        let repairExhausted = false;
        let repairLimit = null;
        let repairProgressStop = null;
        let repairStopReason = null;
        let repairRoundError = null;
        let budgetExhausted = false;
        let strategySequence = 0;

        // ── THE REPAIR TIER, FOR EVERY CONTRACTED JOURNEY ───────────────────────────────────────
        //
        // This used to exist only for the essential core. A SECONDARY journey got one increment
        // dispatch and, if the browser found it red, the loop recorded it as pending and moved on
        // — no repair round, ever. A production build on 2026-08-19 ended with six red journeys
        // and 39 of its 60 approved credits UNSPENT, because six increments each failed once and
        // nothing was allowed to try again. Same tier, same evidence, same enforcement, for both.
        //
        // A ROUND EARNS ITS SUCCESSOR BY RESOLVING A DEFECT — but a round that resolves nothing no
        // longer ends the tier. It ESCALATES: the attributed write boundary may itself have been
        // wrong, so the next round widens, and the one after regenerates the owning modules
        // outright. The loop only stops when every strategy is spent, the approved credit ceiling
        // is reached, or there is nothing an application patch could answer. Spending the approved
        // budget on genuinely DIFFERENT attempts is the point; spending it on identical ones is
        // what this guards against.
        const REPAIR_STRATEGIES = [
          "exact_owning_file_repair", "causal_dependency_repair", "owner_module_regeneration",
        ];
        // THE ALLOWANCE IS ONE POOL AND THE CORE MUST NOT DRINK IT DRY.
        //
        // The database counts repair DISPATCHES per build, not rounds, and a single round can
        // spend several. On 2026-08-20 the core tier consumed all ten — 17.1 credits — went green,
        // and then all six secondary journeys failed on one dispatch each with nothing left to
        // repair them. The core gates everything so it keeps the larger share, but every
        // contracted journey is guaranteed part of what remains.
        const secondaryCount = incrementJourneys.length;
        const coreRepairRounds = secondaryCount
          ? Math.max(1, Math.ceil(repairRoundCeiling * 0.4)) : repairRoundCeiling;
        const shareForRemaining = (journeysLeft) => Math.max(1,
          Math.floor((repairRoundCeiling - repairsAttempted) / Math.max(1, journeysLeft)));
        async function repairUntilGreen({
          label, journeys: repairJourneys, tree: startTree, snapshot, verdicts, defects,
          eligibility: startEligibility, backendRowFailures: startRows = [], advisory = [], evaluate,
          maxRounds = repairRoundCeiling, generationTiers = tiers,
        }) {
          let currentTree = startTree;
          let currentSnapshot = snapshot;
          let currentVerdicts = verdicts;
          let currentDefects = defects;
          let currentEligibility = startEligibility;
          let rows = startRows;
          let rounds = 0;
          let strategy = 0;
          let exhausted = false;
          let limit = null;
          let progressStop = null;
          let budgetOut = false;
          let roundError = null;
          // WHY THE TIER STOPPED, decided where it actually stopped rather than re-derived from
          // counters afterwards. "used its reserved share" and "ran out of ideas" are different
          // outcomes and only one of them is a platform problem.
          const stopReasonNow = () => {
            if (currentEligibility.eligible) return null;
            if (budgetOut) return "approved_credits_exhausted";
            if (exhausted) return "repair_allowance_exhausted";
            if (roundError) return "repair_round_error";
            if (!actionableDefects(currentDefects).length) return "no_actionable_defect";
            if (strategy >= REPAIR_STRATEGIES.length) return "repair_strategies_exhausted";
            if (rounds >= maxRounds) return "repair_share_exhausted";
            return "repair_stopped_early";
          };
          const done = () => ({
            tree: currentTree, snapshot: currentSnapshot, verdicts: currentVerdicts,
            defects: currentDefects, eligibility: currentEligibility, backendRowFailures: rows,
            rounds, exhausted, repairLimit: limit, progressStop, budgetExhausted: budgetOut, roundError,
            stopReason: stopReasonNow(), verifierBlock: null,
          });

          // A stable fingerprint of the whole defect set, used to tell a tier that is grinding
          // through genuinely different attempts from one that has stopped learning anything.
          const signatureOf = (rows) => actionableDefects(rows).map(defectSignature).sort().join("|");
          let cycleBaseline = signatureOf(currentDefects);
          while (!currentEligibility.eligible && rounds < maxRounds
            && strategy < REPAIR_STRATEGIES.length) {
            const actionable = actionableDefects(currentDefects);
            if (!actionable.length) break; // nothing an application patch can answer
            const evidence = browserRepairEvidence({
              contract, interactionContract, journeyResults: currentVerdicts, tree: currentTree,
              backendRowFailures: rows, defects: currentDefects,
              // Shape findings that did not stop the build ride along as CONTEXT for a repair
              // that is now driven by observed browser failure. They explain, they do not accuse.
              advisory: advisoryMessages((advisory || [])
                .filter((finding) => finding.code !== "interaction_control_undriveable")),
            });
            if (!evidence.length) break;
            const mode = REPAIR_STRATEGIES[strategy];
            const scaffoldRepairClasses = [...new Set(actionable
              .map((defect) => defect.scaffoldRouting?.classification).filter(Boolean))];
            await events.telemetry?.({ owner, projectId, buildId, kind: "scaffold_repair_routing", details: {
              strategy: mode, classes: scaffoldRepairClasses,
              scaffoldRepairs: scaffoldRepairClasses.filter((value) => value.startsWith("scaffold_")).length,
              customExtensionRepairs: scaffoldRepairClasses.includes("custom_extension") ? 1 : 0,
              unreachableRepairs: scaffoldRepairClasses.includes("unreachable_module") ? 1 : 0,
            } });
            // The verifier's own attribution bounds the write — until a round proves the boundary
            // was not where the defect lived, at which point the next attempt is deliberately wider.
            const regenerate = mode === "owner_module_regeneration"
              ? [...new Set(actionable.flatMap((defect) => defect.modules))].slice(0, 6) : [];
            let boundary = mode === "exact_owning_file_repair" ? defectWriteBoundary(currentDefects) : null;
            if (mode === "causal_dependency_repair") {
              const graph = memoryGraph(owner, projectId, indexTree(currentTree));
              const owners = [...new Set(actionable.flatMap((defect) => defect.modules || []))];
              const allowedFiles = [...new Set(owners.flatMap((path) => [path,
                ...graph.neighbors(path, { depth: 1, direction: "both" }),
              ]))].filter((path) => typeof currentTree[path] === "string").sort().slice(0, 18);
              boundary = allowedFiles.length ? {
                kind: "browser_repair_dependency_boundary", allowedFiles, allowedPrefixes: [],
                instruction: "The exact owner repair did not resolve the structural defect. Repair only the "
                  + "evidence-supported direct owner, caller, or dependency files in this boundary.",
              } : null;
            } else if (mode === "owner_module_regeneration" && regenerate.length) {
              boundary = { kind: "browser_owner_regeneration_boundary", allowedFiles: regenerate,
                allowedPrefixes: [], instruction: "Regenerate only the proven owner modules." };
            }
            rounds += 1;
            await setState(`${label}:${rounds}`);
            log(`${label} ${rounds}/${maxRounds} [${mode}]: ${actionable.length} typed defect(s) `
              + `[${[...new Set(actionable.map((defect) => defect.defectClass))].join(", ")}]`
              + (boundary ? ` scoped to [${boundary.allowedFiles.join(", ")}]` : "")
              + (regenerate.length ? ` regenerating [${regenerate.join(", ")}]` : ""));
            const defectsBefore = currentDefects;
            const strategyRow = await events.repairStrategyStarted?.({
              owner, projectId, buildId, strategyId: mode, sequence: ++strategySequence,
              targetedOwners: [...new Set(actionable.flatMap((defect) => defect.modules || []))],
              targetedFiles: boundary?.allowedFiles?.length ? boundary.allowedFiles
                : regenerate.length ? regenerate
                  : [...new Set(actionable.flatMap((defect) => [
                    ...(defect.modules || []), ...(defect.failureRefs || []),
                  ]))],
              preTreeHash: treeHash(currentTree),
              preBindingHash: crypto.createHash("sha256").update(JSON.stringify(bindings || [])).digest("hex"),
              defectSignatureBefore: signatureOf(defectsBefore),
              reason: `evidence prerequisites satisfied for ${mode}`
                + (scaffoldRepairClasses.length ? ` (${scaffoldRepairClasses.join(",")})` : ""),
            });
            let repair;
            try {
              repair = await buildIncrement({
                step: "repair", owner, projectId, buildId, contract,
                tiers: generationTiers, bindings,
                tree: currentTree, assets: resolved, journeys: repairJourneys,
                initialProblems: evidence, checkpointReason: `working:${label}:${rounds}`,
                parentSnapshotId: currentSnapshot?.id || null, signal, spec,
                attemptPolicy: repairAttemptPolicy, protocolRetryLimit: 0, repairBoundary: boundary,
                regenerateFiles: regenerate,
              });
            } catch (error) {
              if (strategyRow?.id) await events.repairStrategyFinished?.({ id: strategyRow.id,
                postTreeHash: treeHash(currentTree), defectSignatureAfter: signatureOf(currentDefects),
                outcome: "error", reason: error?.code || error?.message || "repair dispatch failed" });
              if (error?.code === "repair_limit_reached") {
                exhausted = true;
                limit = { code: error.code, repairsDispatched: error.repairsDispatched, maxRepairs: error.maxRepairs };
                break;
              }
              // THE APPROVED CEILING IS A STOP, NOT A CRASH. A build that has genuinely spent what
              // the customer approved keeps its last verified checkpoint and reports honestly.
              if (["budget_ceiling", "account_budget", "recovery_envelope_exhausted",
                "customer_envelope_exhausted", "customer_completion_reserve"].includes(error?.code)) {
                budgetOut = true;
                log(`${label}: approved credit ceiling reached after ${rounds} round(s); stopping with the retained checkpoint`);
                break;
              }
              if (["cancelled", "AbortError"].includes(error?.code) || error?.name === "AbortError") throw error;
              // A REPAIR ROUND IS NOT ALLOWED TO DESTROY THE BUILD IT WAS TRYING TO HELP.
              //
              // A scope naming a planned-but-unwritten module threw out of here and took a paid
              // build to `failed` with 30 of 60 credits spent and a verified core checkpoint on
              // disk that nobody could use. The tier is best-effort by nature: it ends, the reason
              // is recorded and reported, and everything already proved green survives.
              roundError = { round: rounds, message: String(error?.message || error).slice(0, 300),
                code: error?.code || null };
              log(`${label} round ${rounds} failed: ${roundError.message} — ending the tier and `
                + "keeping the retained checkpoint");
              break;
            }
            // ONE FAILED GENERATION IS NOT THE END OF THE TIER.
            //
            // This was a bare `break`, and it is why a 100-credit build with forty rounds stopped
            // after two of them having spent 14.56 — while the repair was visibly working: it had
            // fixed `unitSystem` and `roomShape`, carried the journey from 1/6 steps to 2/6, and
            // had one control left to go. A round whose generation could not produce a runnable
            // tree tells us that ATTEMPT failed, not that the defect is unfixable.
            //
            // So it escalates like any other unproductive round — the next strategy is a different
            // attempt — and the tier ends only when the strategies are spent, the rounds are gone,
            // or the credits are. The retained checkpoint is untouched either way.
            if (!repair.ok) {
              if (strategyRow?.id) await events.repairStrategyFinished?.({ id: strategyRow.id,
                postTreeHash: treeHash(currentTree), defectSignatureAfter: signatureOf(currentDefects),
                outcome: "rejected", reason: repair.reason || "no runnable repair candidate" });
              strategy += 1;
              log(`${label} round ${rounds} produced no runnable tree (${repair.reason || "generation failed"})`
                + (strategy < REPAIR_STRATEGIES.length
                  ? ` — escalating to [${REPAIR_STRATEGIES[strategy]}]`
                  : " — every repair strategy is spent"));
              continue;
            }
            currentTree = repair.tree;
            currentSnapshot = repair.snapshot;
            currentVerdicts = await verifyJourneySet({ owner, projectId, buildId, contract,
              journeys: repairJourneys, tree: currentTree, snapshotId: null, signal });
            const block = await blockOnVerifierPlatformFailure(currentVerdicts);
            if (block) {
              if (strategyRow?.id) await events.repairStrategyFinished?.({ id: strategyRow.id,
                postTreeHash: treeHash(currentTree), defectSignatureAfter: signatureOf(currentDefects),
                outcome: "failed", reason: block.failureClassification || "verification platform blocked" });
              return { ...done(), verifierBlock: block };
            }
            rows = backendProbeFn ? await backendProbeFn({
              owner, projectId, contract, tiers, journeyResults: currentVerdicts.journeys,
            }) : [];
            currentEligibility = evaluate(currentVerdicts, rows);
            currentDefects = defectsFor(currentVerdicts, rows, currentTree);
            await persistDefects(currentDefects, currentTree, currentSnapshot?.id || null);
            const derivedBlock = await blockOnVerifierPlatformFailure(currentVerdicts, currentDefects);
            if (derivedBlock) {
              if (strategyRow?.id) await events.repairStrategyFinished?.({ id: strategyRow.id,
                postTreeHash: treeHash(currentTree),
                postBindingHash: crypto.createHash("sha256").update(JSON.stringify(bindings || [])).digest("hex"),
                defectSignatureAfter: signatureOf(currentDefects), outcome: "failed",
                reason: derivedBlock.failureClassification || "verification platform blocked" });
              return { ...done(), verifierBlock: derivedBlock };
            }
            const progress = defectProgress(defectsBefore, currentDefects);
            if (strategyRow?.id) await events.repairStrategyFinished?.({ id: strategyRow.id,
              postTreeHash: treeHash(currentTree),
              postBindingHash: crypto.createHash("sha256").update(JSON.stringify(bindings || [])).digest("hex"),
              defectSignatureAfter: signatureOf(currentDefects),
              outcome: currentEligibility.eligible ? "success" : progress.moved ? "progress" : "no_progress",
              reason: currentEligibility.eligible ? "contracted assertions green" : progress.reason });
            if (progress.moved) await events.progress?.({ owner, projectId, buildId,
              kind: currentEligibility.eligible ? "resolved_behavioral_defect" : "accepted_candidate_checkpoint",
              details: { strategyId: mode, resolved: progress.resolved, introduced: progress.introduced } });
            if (currentEligibility.eligible) break;
            if (progress.moved) {
              // It is working. Keep the strategy that is working.
              strategy = 0;
              continue;
            }
            progressStop = { round: rounds, strategy: mode, ...progress };
            strategy += 1;
            log(`${label} ${rounds} ${progress.reason} under [${mode}]: `
              + `${progress.persisted.length} defect(s) survived, ${progress.introduced.length} new`
              + (strategy < REPAIR_STRATEGIES.length
                ? ` — escalating to [${REPAIR_STRATEGIES[strategy]}]`
                : " — every strategy tried this cycle"));
            if (strategy >= REPAIR_STRATEGIES.length) {
              // EVERY STRATEGY TRIED. That ends the tier only if the cycle taught us nothing: a
              // second pass over a DIFFERENT tree is a different attempt, and stopping with
              // rounds and credits in hand is what left a 100-credit build blocked at 14.56 with
              // one control left to fix. If the defect set has moved at all since this cycle
              // began, the ladder resets and keeps going.
              const signature = signatureOf(currentDefects);
              if (signature === cycleBaseline) {
                log(`${label}: a full strategy cycle left the defect set identical — stopping`);
                break;
              }
              cycleBaseline = signature;
              strategy = 0;
              log(`${label}: the defect set moved during the cycle — restarting the ladder `
                + `(${rounds}/${maxRounds} rounds used)`);
            }
          }
          return done();
        }

        // MECHANICS CORRECTIONS, BEFORE THE REPAIR TIER.
        //
        // The pre-journey probe answers one question — can this contracted control hold the value
        // its primitive implies — and a failure is a structural defect with an address: a control
        // id, an expected mechanic, an observed result. That is a CORRECTION, not a browser-informed
        // journey repair, and the reservation layer already counts the two separately.
        //
        // Run #7 spent both repair rounds on "step 5 was undriveable" and fixed nothing, then had
        // no allowance left for anything else. A build should be able to fix three dead textboxes
        // and still have its repair tier intact for whatever the journeys then find.
        let mechanicsCorrections = 0;
        let mechanicsLimit = null;
        while (!eligibility.eligible && coreVerdicts.mechanics?.failures?.length
          && mechanicsCorrections < maxMechanicsCorrections) {
          const failures = coreVerdicts.mechanics.failures;
          // NAME THE CONTROL THE MODEL WROTE.
          //
          // `ctl_c2b1f3ae` is meaningless to the author of the app — especially for a hand-wired
          // control, which never carried that id in the first place. The mapping back to the
          // contracted field lives HERE, in the manifest the orchestrator derives and deliberately
          // withholds from the browser, so the brief can say "eventDate" without the browser ever
          // having known it. The model owns that name: it wrote the contract the name came from.
          const mapping = deriveVerificationManifest(spec || deriveBuildSpec(contract)).mapping || {};
          const named = (id) => (mapping[id]?.logicalField ? `${id} (the contracted "${mapping[id].logicalField}")` : id);
          const evidence = failures.map((row) => `control ${named(row.id)} (${row.primitive}) failed its `
            + `mechanics probe: expected ${JSON.stringify(row.expected)}, observed ${JSON.stringify(row.observed)}`
            + ` — ${row.detail}. The control is present and located by its declared identity, so bind it `
            + "so a typed value lands in state and renders back: value + onChange writing through the "
            + "setter, the capability field binding, or an uncontrolled input with defaultValue.");
          await setState(`mechanics_correction:${mechanicsCorrections + 1}`);
          log(`mechanics correction ${mechanicsCorrections + 1}/${maxMechanicsCorrections}: `
            + `${failures.length} control(s) cannot hold a value [${failures.map((row) => row.id).join(", ")}]`);
          mechanicsCorrections += 1;
          let corrected;
          try {
            corrected = await buildIncrement({
              step: "repair", owner, projectId, buildId, contract, tiers: coreGenerationTiers,
              bindings, tree, assets: resolved, journeys: coreJourneys, initialProblems: evidence,
              checkpointReason: `working:mechanics:${mechanicsCorrections}`,
              parentSnapshotId: workingSnapshot?.id || null, signal, spec,
              // …drawing on the CORRECTION allowance, which is the whole point.
              dispatchAs: "correction",
              attemptPolicy: buildAttemptPolicy,
            });
          } catch (error) {
            if (error?.code !== "correction_limit_reached") throw error;
            mechanicsLimit = { code: error.code, correctionsDispatched: error.correctionsDispatched,
              maxCorrections: error.maxCorrections };
            break;
          }
          if (!corrected.ok) break;
          tree = corrected.tree;
          workingSnapshot = corrected.snapshot;
          workingReason = `working:mechanics:${mechanicsCorrections}`;
          coreVerdicts = await verifyJourneySet({ owner, projectId, buildId, contract,
            journeys: coreJourneys, tree, snapshotId: null, signal });
          verifierBlock = await blockOnVerifierPlatformFailure(coreVerdicts);
          if (verifierBlock) return verifierBlock;
          backendRowFailures = backendProbeFn ? await backendProbeFn({
            owner, projectId, contract, tiers, journeyResults: coreVerdicts.journeys,
          }) : [];
          eligibility = evaluateCore(coreVerdicts, backendRowFailures);
          coreDefects = defectsFor(coreVerdicts, backendRowFailures, tree);
          await persistDefects(coreDefects, tree, workingSnapshot?.id || null);
          verifierBlock = await blockOnVerifierPlatformFailure(coreVerdicts, coreDefects);
          if (verifierBlock) return verifierBlock;
        }
        const coreRepair = await repairUntilGreen({
          label: "repair", journeys: coreJourneys, tree, snapshot: workingSnapshot,
          verdicts: coreVerdicts, defects: coreDefects, eligibility,
          backendRowFailures, advisory: coreAdvisory,
          maxRounds: coreRepairRounds,
          evaluate: evaluateCore, generationTiers: coreGenerationTiers,
        });
        if (coreRepair.verifierBlock) return coreRepair.verifierBlock;
        // THE RESERVATION IS SOFT WHILE A DISTINCT STRATEGY REMAINS.
        //
        // Holding 60% of the allowance back for the secondary journeys only makes sense if those
        // journeys ever run, and they only run once the core is green. On 2026-08-20 the core used
        // its four-round share, stayed red, and the build blocked with 41 of 60 approved credits
        // unspent and the reserved rounds never touched. If the core reaches its share mid-ladder,
        // it takes the rest of the pool: nothing downstream can use it anyway. A complete ladder
        // whose defect set stayed identical is different: it proved there is no new strategy, so
        // the outer core path must preserve that stop instead of starting the same ladder again.
        if (!coreRepair.eligibility.eligible
            && coreRepair.stopReason === "repair_share_exhausted"
            && coreRepair.rounds < repairRoundCeiling) {
          log(`core remains red after its reserved share (${coreRepair.rounds}/${coreRepairRounds}); `
            + `continuing into the remaining allowance — a red core means no increment can use it`);
          const overflow = await repairUntilGreen({
            label: "repair", journeys: coreJourneys, tree: coreRepair.tree,
            snapshot: coreRepair.snapshot, verdicts: coreRepair.verdicts, defects: coreRepair.defects,
            eligibility: coreRepair.eligibility, backendRowFailures: coreRepair.backendRowFailures,
            advisory: coreAdvisory, maxRounds: repairRoundCeiling - coreRepair.rounds,
            evaluate: evaluateCore, generationTiers: coreGenerationTiers,
          });
          if (overflow.verifierBlock) return overflow.verifierBlock;
          Object.assign(coreRepair, overflow, { rounds: coreRepair.rounds + overflow.rounds });
        }
        tree = coreRepair.tree;
        if (coreRepair.snapshot) workingSnapshot = coreRepair.snapshot;
        if (coreRepair.rounds) workingReason = `working:repair:${coreRepair.rounds}`;
        coreVerdicts = coreRepair.verdicts;
        coreDefects = coreRepair.defects;
        eligibility = coreRepair.eligibility;
        backendRowFailures = coreRepair.backendRowFailures;
        repairsAttempted += coreRepair.rounds;
        repairExhausted = repairExhausted || coreRepair.exhausted;
        repairLimit = coreRepair.repairLimit || repairLimit;
        repairProgressStop = coreRepair.progressStop || repairProgressStop;
        repairStopReason = coreRepair.stopReason || repairStopReason;
        repairRoundError = coreRepair.roundError || repairRoundError;
        budgetExhausted = budgetExhausted || coreRepair.budgetExhausted;
        if (!eligibility.eligible) return finish("blocked", {
          error: `required contracted journeys remain red: ${eligibility.failures.join("; ")}`,
          failureClassification: "contracted_journeys_red",
          repair_exhausted: repairExhausted || repairsAttempted >= repairRoundCeiling,
          repairLimit,
          repairProgressStop,
          repairRounds: repairsAttempted,
          repairRoundError,
          // WHY the tier stopped, in the customer's terms: the approved credits ran out, or every
          // repair strategy was spent while credits remained. Those are different problems and a
          // build that stops for the second reason with budget left is a platform defect.
          budgetExhausted,
          stopReason: repairStopReason || (budgetExhausted ? "approved_credits_exhausted" : "no_actionable_defect"),
          // The typed defect set, so a resumed repair and a human post-mortem both start from
          // what the browser proved rather than from one summary sentence.
          defects: coreDefects,
          defectClasses: [...new Set(coreDefects.map((defect) => defect.defectClass))],
          // Reported beside the repair tier and counted apart from it, because they are two
          // allowances answering two different kinds of evidence.
          mechanicsCorrections, mechanicsLimit,
          mechanicsFailures: coreVerdicts.mechanics?.failures || [],
          finalJourneyVerdicts: coreVerdicts.journeys,
          finalVerificationDiagnostics: interactionFailureDiagnostics({
            contract, interactionContract, journeyResults: coreVerdicts, tree,
          }),
          advisoryFindings: coreAdvisory,
          platformDefects: coreVerdicts.platformDefects,
          workingSnapshotId: workingSnapshot?.id || null,
        });

        // 5. Only browser-verified candidates advance to working:* metadata. Until here the
        // immutable candidate remains explicitly non-promotable.
        workingSnapshot = await snapshotStore.markCandidateValidated(owner, projectId, workingSnapshot.id,
          { reason: workingReason });
        await events.checkpoint?.({ owner, projectId, buildId, snapshot: workingSnapshot, tree,
          reason: workingReason, promotable: false });
        const coreSnapshot = workingSnapshot;
        if (!coreSnapshot) throw new Error("verified core has no durable working checkpoint");
        log(`core verified: working snapshot ${coreSnapshot.id}`);

        // 6. Secondary increments are verified one at a time and remain unpromoted until complete.
        let candidate = coreSnapshot;
        const shipped = [];
        const completedJourneys = new Set(coreJourneys.map((journey) => journey.id));
        const pendingIncrements = [];
        for (const journey of incrementJourneys) {
          const step = `increment:${journey.id}`;
          // A secondary is only shippable if it preserves every journey already proved green.
          // Differential verification will reuse unchanged owners and re-drive any earlier journey
          // whose modules this candidate touched, so the check is complete without being wasteful.
          const regressionJourneys = (contract.journeys || [])
            .filter((candidateJourney) => completedJourneys.has(candidateJourney.id)
              || candidateJourney.id === journey.id);
          await setState(step);
          const startTree = await snapshotStore.materialize(owner, candidate.id);
          const increment = await buildIncrement({
            step, owner, projectId, buildId, contract, tiers, bindings, tree: startTree, assets: resolved,
            journeys: [journey], checkpointReason: `working:${step}`, parentSnapshotId: candidate.id,
            signal, spec,
            attemptPolicy: buildAttemptPolicy,
          });
          let verdicts = null;
          if (increment.ok) {
            verdicts = await verifyJourneySet({ owner, projectId, buildId, contract,
              journeys: regressionJourneys, tree: increment.tree, snapshotId: increment.snapshot.id, signal });
          }
          const evaluateIncrement = (nextVerdicts) => completionEligibility({
            contract: { ...contract, journeys: regressionJourneys }, gates: { ok: true },
            journeyResults: { journeys: nextVerdicts.journeys }, blockingErrors: nextVerdicts.blockingErrors,
          });
          let incrementEligibility = increment.ok ? evaluateIncrement(verdicts) : { eligible: false };
          let incrementTree = increment.ok ? increment.tree : null;
          let incrementSnapshot = increment.ok ? increment.snapshot : null;
          // A RED SECONDARY JOURNEY NOW EARNS THE SAME REPAIR TIER THE CORE GETS. Until this, one
          // failed dispatch was the end of it: the journey was filed as pending and the build went
          // on to the next one, which is how a 60-credit build finished with six red journeys and
          // 39 credits unspent.
          if (increment.ok && !incrementEligibility.eligible) {
            const incrementDefects = defectsFor(verdicts, [], increment.tree);
            await persistDefects(incrementDefects, increment.tree, increment.snapshot?.id || null);
            verifierBlock = await blockOnVerifierPlatformFailure(verdicts, incrementDefects);
            if (verifierBlock) return verifierBlock;
            const incrementRepair = await repairUntilGreen({
              label: `${step}:repair`, journeys: regressionJourneys, tree: increment.tree,
              snapshot: increment.snapshot, verdicts,
              defects: incrementDefects, eligibility: incrementEligibility,
              advisory: increment.advisory || [], evaluate: evaluateIncrement,
              // Its share of what the core left, divided across the journeys still to come.
              maxRounds: shareForRemaining(incrementJourneys.length - shipped.length - pendingIncrements.length),
            });
            if (incrementRepair.verifierBlock) return incrementRepair.verifierBlock;
            incrementTree = incrementRepair.tree;
            incrementSnapshot = incrementRepair.snapshot;
            incrementEligibility = incrementRepair.eligibility;
            verdicts = incrementRepair.verdicts;
            repairsAttempted += incrementRepair.rounds;
            repairExhausted = repairExhausted || incrementRepair.exhausted;
            repairLimit = incrementRepair.repairLimit || repairLimit;
            budgetExhausted = budgetExhausted || incrementRepair.budgetExhausted;
            repairStopReason = incrementRepair.stopReason || repairStopReason;
            repairRoundError = incrementRepair.roundError || repairRoundError;
          }
          const passed = increment.ok && incrementEligibility.eligible;
          if (!passed) {
            pendingIncrements.push({ journeyId: journey.id, title: journey.title, reason: increment.ok ? "journey verification failed" : increment.reason });
            if (increment.ok) {
              // The attempt is RETAINED and stays resumable, so its work is available to a later
              // targeted repair. What it does NOT do is become `candidate` — the base for the next
              // journey. Building increment N+1 on a tree the browser has just called red is how
              // one failure turned into six; the last VERIFIED candidate stays the base.
              workingSnapshot = incrementSnapshot;
              await events.checkpoint?.({ owner, projectId, buildId, snapshot: incrementSnapshot,
                tree: incrementTree, reason: incrementSnapshot.reason, promotable: false });
            }
            log(`${step}: required journey remains red after its repair tier; `
              + "retained as a candidate and NOT used as the base for the next increment");
            continue;
          }
          const snapshot = await snapshotStore.markCandidateValidated(owner, projectId, incrementSnapshot.id,
            { reason: `working:${step}` });
          await events.checkpoint?.({ owner, projectId, buildId, snapshot, tree: incrementTree,
            reason: `working:${step}`, promotable: false });
          candidate = snapshot;
          workingSnapshot = snapshot;
          shipped.push(journey.id);
          completedJourneys.add(journey.id);
          await events.progress?.({ owner, projectId, buildId, kind: "completed_required_generation_module",
            details: { step, journeyId: journey.id, snapshotId: snapshot.id } });
          log(`${step}: verified (working snapshot ${snapshot.id})`);
        }

        for (const journey of contract.journeys || []) {
          if (!completedJourneys.has(journey.id) && !pendingIncrements.some((row) => row.journeyId === journey.id)) {
            pendingIncrements.push({ journeyId: journey.id, title: journey.title, reason: "required journey was not completed" });
          }
        }

        if (pendingIncrements.length) return finish("blocked", {
          error: `required contracted journeys remain red: ${pendingIncrements.map((row) => row.journeyId).join(", ")}`,
          failureClassification: "contracted_journeys_red",
          coreSnapshotId: coreSnapshot.id, shipped, pendingIncrements,
          // Each of these journeys has now been through the same repair tier the core gets, so the
          // report has to say what that tier did and why it stopped. A build that ends here with
          // budget remaining and strategies unspent is a platform defect, not a customer outcome.
          repairRounds: repairsAttempted,
          repairRoundError,
          repair_exhausted: repairExhausted || repairsAttempted >= repairRoundCeiling,
          repairLimit, budgetExhausted,
          stopReason: repairStopReason || (budgetExhausted ? "approved_credits_exhausted" : "repair_strategies_exhausted"),
          workingSnapshotId: workingSnapshot?.id || candidate.id, providerCalls,
        });

        // Green promotion is based on one complete, fresh browser pass. Differential evidence is
        // useful while repairing, but cached verdicts can never be the final release authority.
        let finalTree = await snapshotStore.materialize(owner, candidate.id);
        await setState("final_fresh_verification");
        let finalVerdicts = await verifyJourneySet({ owner, projectId, buildId, contract,
          journeys: contract.journeys || [], tree: finalTree, snapshotId: candidate.id, signal,
          forceFresh: true });
        verifierBlock = await blockOnVerifierPlatformFailure(finalVerdicts);
        if (verifierBlock) return verifierBlock;
        let finalRows = backendProbeFn ? await backendProbeFn({
          owner, projectId, contract, tiers, journeyResults: finalVerdicts.journeys,
        }) : [];
        const evaluateFinal = (nextVerdicts, rows) => completionEligibility({
          contract, gates: { ok: true }, journeyResults: { journeys: nextVerdicts.journeys },
          backendRowFailures: rows, blockingErrors: nextVerdicts.blockingErrors,
        });
        let finalEligibility = evaluateFinal(finalVerdicts, finalRows);
        let finalDefects = defectsFor(finalVerdicts, finalRows, finalTree);
        await persistDefects(finalDefects, finalTree, candidate.id);
        verifierBlock = await blockOnVerifierPlatformFailure(finalVerdicts, finalDefects);
        if (verifierBlock) return verifierBlock;
        if (!finalEligibility.eligible && repairsAttempted < repairRoundCeiling) {
          const finalRepair = await repairUntilGreen({
            label: "final_repair", journeys: contract.journeys || [], tree: finalTree,
            snapshot: candidate, verdicts: finalVerdicts, defects: finalDefects,
            eligibility: finalEligibility, backendRowFailures: finalRows,
            maxRounds: repairRoundCeiling - repairsAttempted, evaluate: evaluateFinal,
          });
          if (finalRepair.verifierBlock) return finalRepair.verifierBlock;
          repairsAttempted += finalRepair.rounds;
          finalTree = finalRepair.tree;
          candidate = finalRepair.snapshot || candidate;
          finalVerdicts = await verifyJourneySet({ owner, projectId, buildId, contract,
            journeys: contract.journeys || [], tree: finalTree, snapshotId: candidate.id, signal,
            forceFresh: true });
          verifierBlock = await blockOnVerifierPlatformFailure(finalVerdicts);
          if (verifierBlock) return verifierBlock;
          finalRows = backendProbeFn ? await backendProbeFn({
            owner, projectId, contract, tiers, journeyResults: finalVerdicts.journeys,
          }) : [];
          finalEligibility = evaluateFinal(finalVerdicts, finalRows);
          finalDefects = defectsFor(finalVerdicts, finalRows, finalTree);
          await persistDefects(finalDefects, finalTree, candidate.id);
          verifierBlock = await blockOnVerifierPlatformFailure(finalVerdicts, finalDefects);
          if (verifierBlock) return verifierBlock;
        }
        if (!finalEligibility.eligible) return finish("blocked", {
          error: `final fresh verification remained red: ${finalEligibility.failures?.join("; ")
            || "one or more contracted journeys failed"}`,
          failureClassification: "contracted_journeys_red",
          workingSnapshotId: candidate.id, repairRounds: repairsAttempted,
        });
        candidate = await snapshotStore.markCandidateValidated(owner, projectId, candidate.id,
          { reason: "working:final-fresh" });
        await events.progress?.({ owner, projectId, buildId, kind: "fresh_verification_green",
          details: { snapshotId: candidate.id, journeyCount: (contract.journeys || []).length } });
        await events.snapshot?.({ owner, projectId, buildId, snapshot: candidate, tree: finalTree, reason: "complete" });
        if (!deferGreenPromotion) await snapshotStore.promote(owner, projectId, "green", candidate.id);

        return finish("green", {
          final_snapshot: candidate.id,
          snapshotId: candidate.id,
          coreSnapshotId: coreSnapshot.id,
          shipped,
          pendingIncrements,
          providerCalls,
          // A green build that needed a mechanics correction should say so: it is the difference
          // between "the model got it right" and "the model was told which control was dead".
          mechanicsCorrections,
        });
      } catch (error) {
        const cancelled = error?.code === "cancelled" || error?.name === "AbortError";
        if (error?.code === "internal_extension_required") {
          return finish("blocked", {
            error: error.message,
            failureClassification: "platform_internal_extension_required",
            customerState: "checking", actionRequired: false,
            workingSnapshotId: error.checkpointId || workingSnapshot?.id || null,
          });
        }
        if (cancelled) {
          try { await snapshotStore.discardWorking(owner, projectId, buildId); }
          catch (cleanupError) { log(`cancelled checkpoint cleanup failed: ${cleanupError.message}`); }
        }
        return finish(cancelled ? "cancelled" : "failed", {
          error: error.message, workingSnapshotId: workingSnapshot?.id || null,
        });
      }
    },

    /**
     * Crash recovery: resume from the project's green pointer — the tree, index and cached
     * assets all come back without a single model call or provider search.
     */
    async resumeContext(owner, projectId) {
      const pointer = await snapshotStore.pointer(owner, projectId, "green");
      if (!pointer) return null;
      const tree = await snapshotStore.materialize(owner, pointer);
      return { snapshotId: pointer, tree, index: indexTree(tree) };
    },

    /** Resume a failed/pre-green build from byte-verified immutable source, never projects.tree. */
    async resumeWorkingContext(owner, projectId, buildId) {
      const snapshot = await snapshotStore.latestForBuild(owner, projectId, buildId,
        { reasonPrefixes: ["working:", "candidate:"] });
      if (!snapshot) return null;
      const tree = await snapshotStore.materialize(owner, snapshot.id);
      return { snapshotId: snapshot.id, tree, index: indexTree(tree), reason: snapshot.reason };
    },

    /**
     * Targeted recovery for a failed first-green build. It starts from the exact compiled
     * checkpoint and the already-persisted contract, so contract/core provider calls are never
     * replayed. The checkpoint remains unpromoted unless the repaired journeys become green.
     */
    async runRepairFromCheckpoint({ owner, projectId, sourceBuildId, request, contract,
      initialProblems = [], maxRepairs = 1, userCritical = [], budgetCredits = null, signal = null }) {
      const sourceBuild = await buildStore.get(sourceBuildId);
      const buildId = await buildStore.create({
        owner, project_id: projectId, profile: sourceBuild?.profile || "simple", request, state: "created",
        verifier_policy: MINIMAL_CONTRACT_VERIFIER_POLICY,
        // Persist the dispatch allowance as well as inheriting historical source metadata. Old
        // repair rows pre-date ceiling propagation and can legitimately have a null budget.
        budget_credits: Number(budgetCredits || sourceBuild?.budget_credits || 0) || null,
        max_repair_dispatches: maxRepairs, started_at: new Date().toISOString(),
      });
      await events.buildCreated?.({ owner, projectId, buildId, mode: "resume_repair", sourceBuildId });
      const finish = async (state, extra = {}) => {
        const patch = { state, finished_at: new Date().toISOString() };
        for (const key of ["error", "final_snapshot"]) if (key in extra) patch[key] = extra[key];
        try { await buildStore.update(buildId, patch); } catch (error) { log(`repair row update failed: ${error.message}`); }
        return { buildId, state, sourceBuildId, ...extra };
      };
      try {
        abortIfRequested(signal);
        const source = await this.resumeWorkingContext(owner, projectId, sourceBuildId);
        if (!source) return finish("blocked", { error: "failed build has no resumable working checkpoint" });
        const spec = deriveBuildSpec(contract, { userCritical });
        source.tree = refreshDeterministicFoundation(source.tree, spec);
        contract = spec.contract;
        const { tiers, bindings } = spec;
        const attemptPolicy = generationPolicyFor(sourceBuild?.profile || "simple", {
          simpleAttempts: maxCoreAttempts, simpleCorrections: maxPrecompileCorrections,
        });
        const journeysById = new Map((contract.journeys || []).map((journey) => [journey.id, journey]));
        const allJourneys = [...journeysById.values()];
        // Classify the retained tree before buying another model turn. If a deterministic gate can
        // name one bounded defect (as in the live fake-delay / missing-runtime candidate), the
        // first resumed dispatch is already a scoped correction. Browser-red but otherwise valid
        // candidates still use the ordinary repair path below.
        const initialGate = await verifyStage(source.tree, gateOptions(contract,
          "resume-preflight", allJourneys, { owner, projectId, buildId, step: "resume-preflight", attempt: 0, signal }));
        const initialRepairScope = initialGate.ok ? null : targetedGateCorrection(initialGate, source.tree, contract);
        let retainedJourneyProblems = [];
        let retainedDefects = [];
        if (initialGate.ok) {
          // A retained candidate may have failed only because the platform verifier/runtime was
          // defective. Re-prove the candidate before buying a repair turn. This keeps retries
          // checkpoint-first and allows a platform fix to promote the existing bytes at zero
          // provider cost, while a genuinely red journey still falls through to targeted repair.
          let retainedCheckpoint = await snapshotStore.createSnapshot(owner, projectId, initialGate.tree, {
            buildId, parent: source.snapshotId, reason: "candidate:resume-preflight",
            assetManifest: await assetService.assetManifestFor?.(owner, projectId) || [],
          });
          await events.checkpoint?.({ owner, projectId, buildId, snapshot: retainedCheckpoint,
            tree: initialGate.tree, reason: "candidate:resume-preflight", promotable: false });
          const retainedVerdicts = await verifyJourneySet({ owner, projectId, buildId, contract,
            journeys: allJourneys, tree: initialGate.tree, snapshotId: retainedCheckpoint.id, signal });
          const retainedEligibility = completionEligibility({ contract, gates: { ok: true },
            journeyResults: { journeys: retainedVerdicts.journeys },
            blockingErrors: retainedVerdicts.blockingErrors });
          if (retainedEligibility.eligible) {
            retainedCheckpoint = await snapshotStore.markCandidateValidated(owner, projectId,
              retainedCheckpoint.id, { reason: "working:resumed-preflight" });
            await events.checkpoint?.({ owner, projectId, buildId, snapshot: retainedCheckpoint,
              tree: initialGate.tree, reason: "working:resumed-preflight", promotable: false });
            await events.snapshot?.({ owner, projectId, buildId, snapshot: retainedCheckpoint,
              tree: initialGate.tree, reason: "resumed-preflight" });
            if (!deferGreenPromotion) await snapshotStore.promote(owner, projectId, "green", retainedCheckpoint.id);
            return finish("green", { final_snapshot: retainedCheckpoint.id,
              snapshotId: retainedCheckpoint.id, parentSnapshotId: source.snapshotId, providerCalls: 0 });
          }
          // THE RESUMED REPAIR IS BRIEFED FROM THE SAME TYPED DEFECTS AS THE ROUND THAT PRECEDED
          // IT. A blocked build persists one summary sentence and nothing else, so re-deriving
          // the defect set here — from a verification that just ran against the retained tree —
          // is what stops a resume from being briefed more weakly than the build it resumes.
          retainedDefects = browserRepairDefects({
            contract, interactionContract: spec.interactionContract,
            journeyResults: retainedVerdicts, tree: initialGate.tree,
          });
          const retainedEvidence = browserRepairEvidence({
            contract, interactionContract: spec.interactionContract,
            journeyResults: retainedVerdicts, tree: initialGate.tree, defects: retainedDefects,
          });
          retainedJourneyProblems = retainedEvidence.length
            ? retainedEvidence : retainedEligibility.failures || [];
        }
        // A platform-owned defect is not something an application patch can answer, and it must
        // not spend the retained build's remaining allowance proving that again.
        const retainedPlatformDefects = platformDefectsOf(retainedDefects);
        if (retainedPlatformDefects.length && !actionableDefects(retainedDefects).length) {
          return finish("blocked", {
            error: `Builder V2 verification platform failure: ${retainedPlatformDefects
              .map((defect) => `${defect.code}: ${defect.evidence?.observed || "verification platform failure"}`).join("; ")}`,
            failureClassification: "verification_platform_defect",
            platformDefects: retainedPlatformDefects, defects: retainedDefects,
            workingSnapshotId: source.snapshotId,
          });
        }
        const repairProblems = initialGate.ok
          ? [...retainedJourneyProblems, ...initialProblems]
          : [...(initialGate.layers?.d0d2?.problems || []), ...initialProblems];
        const repair = await buildIncrement({
          step: "repair", owner, projectId, buildId, contract, tiers, bindings, tree: source.tree,
          assets: [], journeys: allJourneys, initialProblems: repairProblems, editRequest: request,
          // The verifier's attribution bounds the resumed write exactly as it bounds an in-build
          // repair round; no attribution means no boundary.
          repairBoundary: defectWriteBoundary(retainedDefects),
          checkpointReason: "working:resumed-repair", parentSnapshotId: source.snapshotId, signal, spec,
          attemptPolicy, initialRepairScope,
        });
        if (!repair.ok) return finish("blocked", { error: repair.reason, problems: repair.problems,
          workingSnapshotId: source.snapshotId });
        let checkpoint = repair.snapshot;
        const verdicts = await verifyJourneySet({ owner, projectId, buildId, contract,
          journeys: allJourneys, tree: repair.tree, snapshotId: checkpoint.id, signal });
        const eligibility = completionEligibility({ contract, gates: { ok: true },
          journeyResults: { journeys: verdicts.journeys }, blockingErrors: verdicts.blockingErrors });
        if (!eligibility.eligible) {
          // What the resumed round actually achieved, measured on defects rather than on wording.
          const afterDefects = browserRepairDefects({
            contract, interactionContract: spec.interactionContract,
            journeyResults: verdicts, tree: repair.tree,
          });
          const progress = defectProgress(retainedDefects, afterDefects);
          log(`resumed repair ${progress.reason}: ${progress.resolved.length} resolved, `
            + `${progress.persisted.length} survived, ${progress.introduced.length} new`);
          return finish("blocked", { error: eligibility.failures.join("; "),
            failureClassification: "contracted_journeys_red",
            defects: afterDefects, repairProgress: progress,
            workingSnapshotId: checkpoint.id });
        }
        checkpoint = await snapshotStore.markCandidateValidated(owner, projectId, checkpoint.id,
          { reason: "working:resumed-repair" });
        await events.checkpoint?.({ owner, projectId, buildId, snapshot: checkpoint,
          tree: repair.tree, reason: "working:resumed-repair", promotable: false });
        await events.snapshot?.({ owner, projectId, buildId, snapshot: checkpoint,
          tree: repair.tree, reason: "resumed-repair" });
        if (!deferGreenPromotion) await snapshotStore.promote(owner, projectId, "green", checkpoint.id);
        return finish("green", { final_snapshot: checkpoint.id, snapshotId: checkpoint.id,
          parentSnapshotId: source.snapshotId });
      } catch (error) {
        const cancelled = error?.code === "cancelled" || error?.name === "AbortError";
        if (cancelled) {
          try { await snapshotStore.discardWorking(owner, projectId, buildId); }
          catch (cleanupError) { log(`cancelled repair checkpoint cleanup failed: ${cleanupError.message}`); }
        }
        return finish(cancelled ? "cancelled" : "failed",
          { error: error.message });
      }
    },

    /**
     * Re-run deterministic gates and browser journeys for a retained checkpoint after a platform
     * runtime upgrade. No model seam is called and no provider reservation is created. This is
     * deliberately separate from repair: it may prove a platform fix, never invent app changes.
     */
    async runVerifyFromCheckpoint({ owner, projectId, sourceBuildId, request, contract,
      userCritical = [], signal = null }) {
      const buildId = await buildStore.create({
        owner, project_id: projectId, profile: "verify", request, state: "created",
        verifier_policy: MINIMAL_CONTRACT_VERIFIER_POLICY,
        max_repair_dispatches: 0, started_at: new Date().toISOString(),
      });
      await events.buildCreated?.({ owner, projectId, buildId, mode: "resume_verify", sourceBuildId });
      const finish = async (state, extra = {}) => {
        const patch = { state, finished_at: new Date().toISOString() };
        for (const key of ["error", "final_snapshot"]) if (key in extra) patch[key] = extra[key];
        try { await buildStore.update(buildId, patch); } catch (error) { log(`verify row update failed: ${error.message}`); }
        return { buildId, state, sourceBuildId, ...extra };
      };
      try {
        abortIfRequested(signal);
        const source = await this.resumeWorkingContext(owner, projectId, sourceBuildId);
        if (!source) return finish("blocked", { error: "failed build has no resumable working checkpoint" });
        const spec = deriveBuildSpec(contract, { userCritical });
        const tree = refreshDeterministicFoundation(source.tree, spec);
        contract = spec.contract;
        const journeys = contract.journeys || [];
        const conformance = validateModuleConformance(tree, {
          contract, modulePlan: spec.modulePlan, moduleContracts: spec.moduleContracts,
          interactionContract: spec.interactionContract, bindings: spec.bindings,
          capabilityGraph: spec.capabilityGraph,
        });
        const persistence = partitionFindings(lintDurablePersistence(tree, {
          contract, journeys, modulePlan: spec.modulePlan,
        }).findings || []);
        const blocking = [...(conformance.blocking || []), ...persistence.blocking];
        if (blocking.length) return finish("blocked", {
          error: `platform re-verification found ${blocking.length} blocking deterministic issue(s): `
            + blocking.map((finding) => finding.message || finding.code).join("; "),
        });
        const gate = await verifyStage(tree, gateOptions(contract, "runtime-refresh", journeys, {
          owner, projectId, buildId, step: "runtime-refresh", attempt: 0, signal,
        }));
        if (!gate.ok) return finish("blocked", {
          error: (gate.layers?.d0d2?.problems || ["runtime refresh did not compile"]).join("; "),
        });
        let checkpoint = await snapshotStore.createSnapshot(owner, projectId, gate.tree, {
          buildId, parent: source.snapshotId, reason: "candidate:runtime-refresh",
          assetManifest: await assetService.assetManifestFor?.(owner, projectId) || [],
        });
        await events.checkpoint?.({ owner, projectId, buildId, snapshot: checkpoint,
          tree: gate.tree, reason: "candidate:runtime-refresh", promotable: false });
        const verdicts = await verifyJourneySet({ owner, projectId, buildId, contract,
          journeys, tree: gate.tree, snapshotId: checkpoint.id, signal });
        const eligibility = completionEligibility({ contract, gates: { ok: true },
          journeyResults: { journeys: verdicts.journeys }, blockingErrors: verdicts.blockingErrors });
        if (!eligibility.eligible) return finish("blocked", {
          error: eligibility.failures.join("; "), workingSnapshotId: checkpoint.id,
        });
        checkpoint = await snapshotStore.markCandidateValidated(owner, projectId, checkpoint.id,
          { reason: "working:runtime-refresh" });
        await events.checkpoint?.({ owner, projectId, buildId, snapshot: checkpoint,
          tree: gate.tree, reason: "working:runtime-refresh", promotable: false });
        await events.snapshot?.({ owner, projectId, buildId, snapshot: checkpoint,
          tree: gate.tree, reason: "runtime-refresh" });
        if (!deferGreenPromotion) await snapshotStore.promote(owner, projectId, "green", checkpoint.id);
        return finish("green", { final_snapshot: checkpoint.id, snapshotId: checkpoint.id,
          parentSnapshotId: source.snapshotId, providerCalls: 0 });
      } catch (error) {
        const cancelled = error?.code === "cancelled" || error?.name === "AbortError";
        return finish(cancelled ? "cancelled" : "failed", { error: error.message });
      }
    },

    /**
     * The EDIT path (finish plan WP-10 / V2-18): adopt the green snapshot → patch → gate →
     * DIFFERENTIAL journey verification (unchanged owners reuse their cached PASS verdicts;
     * only journeys whose owning modules changed are re-driven) → new snapshot promoted
     * atomically. A failed edit promotes nothing — the prior green keeps serving. No
     * contract call, no asset search: everything persistent is simply resumed.
     */
    async runEdit({ owner, projectId, request, contract, maxRepairs = maxJourneyRepairs,
      userCritical = [], signal = null }) {
      const buildId = await buildStore.create({
        owner, project_id: projectId, profile: "edit", request, state: "created",
        verifier_policy: MINIMAL_CONTRACT_VERIFIER_POLICY,
        max_repair_dispatches: maxRepairs, started_at: new Date().toISOString(),
      });
      await events.buildCreated?.({ owner, projectId, buildId, mode: "edit" });
      const finish = async (state, extra = {}) => {
        const patch = { state, finished_at: new Date().toISOString() };
        for (const key of ["error", "final_snapshot"]) if (key in extra) patch[key] = extra[key];
        try { await buildStore.update(buildId, patch); } catch (error) { log(`edit row update failed (result unaffected): ${error.message}`); }
        return { buildId, state, ...extra };
      };
      const setState = async (state) => {
        try { await buildStore.update(buildId, { state }); } catch (error) { log(`state update failed: ${error.message}`); }
      };

      try {
        abortIfRequested(signal);
        const spec = deriveBuildSpec(contract, { userCritical });
        contract = spec.contract;
        const ctx = await this.resumeContext(owner, projectId);
        if (!ctx) return finish("blocked", { error: "no green snapshot to edit — run a build first" });
        // Capability/backend modules are platform-owned and upgrade on iterate. Legacy adoption
        // gains new reliable behaviours without asking a model to recreate protected code.
        ctx.tree = refreshDeterministicFoundation(ctx.tree, spec);
        const { tiers, bindings } = spec;
        const journeys = contract.journeys || [];

        await setState("editing");
        const edit = await buildIncrement({
          step: "edit", owner, projectId, buildId, contract, tiers, bindings, tree: ctx.tree, assets: [],
          journeys, editRequest: request, checkpointReason: "working:edit",
          parentSnapshotId: ctx.snapshotId, signal, spec,
        });
        if (!edit.ok) return finish("blocked", { error: edit.reason, problems: edit.problems,
          advisoryFindings: edit.advisory || [] });

        let workingSnapshot = edit.snapshot;

        // Differential verification over EVERY contract journey: the cache decides what to
        // actually drive. Unchanged owners reuse; changed owners (and prior fails) re-drive.
        await setState("verify_edit");
        const verdicts = await verifyJourneySet({ owner, projectId, buildId, contract,
          journeys, tree: edit.tree, snapshotId: ctx.snapshotId, signal });
        const eligibility = completionEligibility({ contract, gates: { ok: true }, journeyResults: { journeys: verdicts.journeys },
          blockingErrors: verdicts.blockingErrors });
        if (!eligibility.eligible) return finish("blocked", {
          error: eligibility.failures.join("; "),
          platformDefects: verdicts.platformDefects,
          workingSnapshotId: workingSnapshot.id,
        });

        workingSnapshot = await snapshotStore.markCandidateValidated(owner, projectId, workingSnapshot.id,
          { reason: "working:edit" });
        await events.checkpoint?.({ owner, projectId, buildId, snapshot: workingSnapshot,
          tree: edit.tree, reason: "working:edit", promotable: false });
        const snapshot = workingSnapshot;
        await events.snapshot?.({ owner, projectId, buildId, snapshot, tree: edit.tree, reason: "edit" });
        await events.knowledge?.({
          owner, projectId, buildId, kind: "decision", key: `edit:${buildId}`,
          value: { text: request, verifiedSnapshot: snapshot.id },
        });
        if (!deferGreenPromotion) await snapshotStore.promote(owner, projectId, "green", snapshot.id);
        log(`edit green: snapshot ${snapshot.id} (drove ${verdicts.plan.drive.length}, reused ${verdicts.plan.reused.length})`);
        return finish("green", {
          final_snapshot: snapshot.id,
          snapshotId: snapshot.id,
          parentSnapshotId: ctx.snapshotId,
          drove: verdicts.plan.drive.map((d) => d.journey.id),
          reused: verdicts.plan.reused.map((r) => r.journeyId),
          pendingIncrements: [],
        });
      } catch (error) {
        const cancelled = error?.code === "cancelled" || error?.name === "AbortError";
        if (cancelled) {
          try { await snapshotStore.discardWorking(owner, projectId, buildId); }
          catch (cleanupError) { log(`cancelled edit checkpoint cleanup failed: ${cleanupError.message}`); }
        }
        return finish(cancelled ? "cancelled" : "failed", { error: error.message });
      }
    },
  };
}
