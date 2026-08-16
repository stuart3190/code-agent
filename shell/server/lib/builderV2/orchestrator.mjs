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

import { indexTree } from "./indexer.mjs";
import { memoryGraph } from "./graphStore.mjs";
import { applyPatches, patchOutcomes } from "./patchEngine.mjs";
import { completionEligibility, previewEligibility } from "./contractTiering.mjs";
import { deriveBuildSpec, scopeBuildSpec } from "./buildSpec.mjs";
import { deriveVerificationManifest } from "./verificationManifest.mjs";
import { advisoryMessages, partitionFindings } from "./validationSeverity.mjs";
import {
  lintDurablePersistence, persistenceFindingMessages, persistenceRepairScope,
} from "./persistenceLint.mjs";
import { interactionFailureDiagnostics, scopeInteractionContract } from "./interactionContract.mjs";
import {
  moduleCorrectionScope, validateModuleConformance, validateModulePatchScope,
} from "./moduleContracts.mjs";
import {
  verifyStage, attributeFailures, planJourneyVerification, recordJourneyVerdicts, memoryVerificationCache,
} from "./verification.mjs";
import { createSnapshotStore } from "./snapshotStore.mjs";
import { serviceClient } from "../supabase.mjs";
import { generationPolicyFor } from "./generationPolicy.mjs";

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

/** Preserve the browser's causal step evidence when handing a red retained tree to repair. */
export function browserRepairEvidence({
  contract, interactionContract = contract?.interactionContract, journeyResults, tree,
  backendRowFailures = [], advisory = [],
} = {}) {
  const verdicts = journeyResults || { journeys: [], blockingErrors: [] };
  return [
    ...(verdicts.journeys || []).filter((journey) => journey.status !== "pass").flatMap((journey) => {
      const failedSteps = (journey.steps || []).filter((step) => step.status !== "pass");
      const journeyEvidence = failedSteps.length
        ? failedSteps.map((step) => `journey ${journey.id} · step "${step.action}" FAILED in a real browser: `
          + `${step.detail || "expected outcome never appeared"}`)
        : [`journey ${journey.id} FAILED in a real browser (no per-step evidence recorded)`];
      const attributionEvidence = journey.attributionDefect
        ? [`platform defect ${journey.attributionDefect.code}: journey ${journey.id} has no owning module; `
          + `bounded fallback files: ${(journey.fallbackRefs || []).join(", ") || "none available"}`]
        : [];
      return [...journeyEvidence, ...attributionEvidence];
    }),
    ...interactionFailureDiagnostics({ contract, interactionContract, journeyResults: verdicts, tree })
      .map((row) => JSON.stringify(row)),
    ...(backendRowFailures || []).map((failure) => `backend row check failed (${failure.journeyId}): ${failure.detail}`),
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

function targetedGateCorrection(gate, tree) {
  const failure = gate?.layers?.d0d2?.failure;
  if (!failure?.kind || failure.kind === "expectations") return null;
  const findings = failure.findings || [];
  let files = [...new Set(findings.map((finding) => finding?.file).filter((file) => /^src\//.test(file)))];
  files = [...new Set([...files, ...sourcePaths([
    ...(gate.layers?.d0d2?.problems || []), failure.stderr || "",
  ])])].sort();
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
  return {
    ...scope,
    batchIndex: Number(scope.batchIndex || 0) + 1,
    files,
    allowedFiles: files,
    remainingFiles: remaining.slice(width),
    moduleContracts: { version: moduleContracts?.version || 1, specifications: selected },
    expectedPatchTokens: Math.min(6_000, Math.max(1_000, Math.ceil(sourceTokens * 1.1))),
    instruction: "Continue the same approved build with only this next bounded module batch. "
      + `Complete [${files.join(", ")}], preserve every retained module, and do not touch unrelated files.`,
  };
}

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
  log = () => {},
} = {}) {
  if (!contractFn || !patchesFn || !assetService || !baseTree) {
    throw new Error("orchestrator needs contractFn, patchesFn, assetService and baseTree");
  }

  const gateOptions = (contract, stepId, journeys, execution) => ({
    contract, stage: { id: stepId, journeys }, compile: (tree) => compile(tree, execution),
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

  async function verifyJourneySet({ owner, projectId, buildId, contract, journeys, tree, snapshotId, signal }) {
    abortIfRequested(signal);
    const graph = memoryGraph(owner, projectId, indexTree(tree));
    const scoped = { ...contract, journeys };
    const plan = await planJourneyVerification({
      owner, projectId, contract: scoped, identityContract: contract, graph, cache: verificationCache,
      verificationContext,
    });
    let driven = { journeys: [] };
    if (plan.drive.length && journeysFn) {
      const executionContract = verificationExecutionContract(contract, journeys, plan.drive);
      driven = await journeysFn({ owner, projectId, buildId, tree,
        contract: executionContract,
        journeys: plan.drive.map((d) => d.journey), graph, signal });
      abortIfRequested(signal);
      driven = { ...driven, journeys: attributeFailures(driven, graph, scoped) };
      await recordJourneyVerdicts({ owner, projectId, cache: verificationCache, plan, results: driven, snapshotId });
    }
    const platformDefects = driven.journeys.flatMap((j) => j.attributionDefect ? [j.attributionDefect] : []);
    const blockingErrors = [
      ...(driven.consoleErrors || []).map((detail) => `browser console: ${detail}`),
      ...(driven.failedRequests || []).map((detail) => `network request: ${detail}`),
    ];
    for (const defect of platformDefects) log(JSON.stringify({ event: "bv2.platform_defect", ...defect }));
    const merged = [
      ...driven.journeys,
      ...plan.reused.map((r) => {
        const journey = journeys.find((j) => j.id === r.journeyId);
        return { id: r.journeyId, title: journey?.title, priority: journey?.priority, ...r.verdict, reused: true };
      }),
    ];
    return { journeys: merged, plan, platformDefects, blockingErrors,
      unavailable: driven.unavailable === true,
      verifierError: driven.error || null,
      verifierDefects: driven.verifierDefects || [],
      // The pre-journey mechanics probe's verdict travels with the journey verdicts, so a repair
      // brief can lead with the control that provably cannot hold a value.
      mechanics: driven.mechanics || null,
      consoleErrors: driven.consoleErrors || [], failedRequests: driven.failedRequests || [] };
  }

  /**
   * Generate-and-gate one increment: up to maxCoreAttempts patch rounds, machine-taught
   * rejections fed straight back, the Part 4 stop rule on repeated identical failure.
   * Returns { ok, tree } or { ok:false, problems }.
   */
  async function buildIncrement({ step, owner, projectId, buildId, contract, tiers, bindings, tree, assets, journeys,
    editRequest = null, initialProblems = [], checkpointReason = `working:${step}`,
    parentSnapshotId = null, signal = null, spec = null, attemptPolicy = null, initialRepairScope = null,
    // Which ALLOWANCE this increment draws on, when the caller already knows. The reservation
    // layer counts `repair` and `correction` separately on purpose: a repair is a round briefed by
    // observed journey failure, a correction is a named structural fix. A mechanics failure is the
    // second kind — the browser proved one control cannot hold a value, which is a defect with an
    // address — so it must not spend the one browser-informed repair slot.
    dispatchAs = null }) {
    // A CORRECTION continues from the retained candidate; an ATTEMPT redoes the work from the
    // increment's starting tree. Keeping the distinction explicit stops a fresh generation from
    // colliding with files the discarded candidate already created.
    const originalTree = tree;
    let working = tree;
    let rejections = [];
    let problems = initialProblems;
    let lastSignature = null;
    let repairScope = initialRepairScope;
    let contractCorrectionScope = null;
    let headroomScope = null;
    let moduleCorrectionUsed = false;
    let latestCandidate = null;
    let advisory = [];
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
      || noOps > maxNoOpRetries;
    const failure = (reason, extra = {}) => ({
      ok: false, reason, problems, advisory, advisoryFindings: advisory,
      candidateSnapshotId: latestCandidate?.id || null, repairUsed: !!repairScope,
      moduleCorrectionUsed, attempts, corrections, noOps, attemptLedger, ...extra,
    });

    while (!exhausted()) {
      abortIfRequested(signal);
      const attempt = spend() + 1;
      // Pre-compile corrections dispatch under their own step identity so they draw on the
      // correction allowance, never on the single browser-informed repair slot.
      const dispatchStep = dispatchAs
        || headroomScope?.logicalStep
        || (repairScope ? "correction" : contractCorrectionScope ? "correction" : step);
      const patches = await patchesFn({ step: dispatchStep, originalStep: step, owner, projectId, buildId, attempt,
        contract, tiers, tree: working, assets, rejections, problems, journey: journeys?.[0] || null,
        editRequest: repairScope?.instruction || contractCorrectionScope?.instruction || editRequest,
        modulePlan, moduleContracts, repairScope, moduleCorrectionScope: contractCorrectionScope, headroomScope,
        advisory, spec: scoped, signal });
      // The model lane may have split an oversized, not-yet-dispatched prompt into one bounded
      // continuation. Enforce that internal write boundary exactly like a validator-owned scope;
      // the following full-tree gates still decide whether more work is required.
      const activeScope = patches.dispatchScope || headroomScope || repairScope || contractCorrectionScope;
      const internalHeadroomSplit = activeScope?.kind === "headroom_continuation";
      const patchScope = validateModulePatchScope(patches, activeScope);
      if (!patchScope.ok) {
        // Validator-owned correction scopes fall back to a full attempt. Internal headroom
        // continuations keep the same bounded scope so an oversized full prompt cannot reappear.
        rejections = patchScope.findings.map((finding) => ({ signature: finding.code, reason: JSON.stringify(finding) }));
        if (internalHeadroomSplit) {
          headroomScope = activeScope;
        } else {
          repairScope = null;
          contractCorrectionScope = null;
          working = originalTree;
        }
        attempts += 1;
        log(`${step}: scoped correction attempted ${patchScope.findings.length} out-of-scope write(s); `
          + `${internalHeadroomSplit ? "retrying the same bounded continuation" : "retrying unscoped"} `
          + `(attempt ${attempts}/${maxGenerationAttempts})`);
        continue;
      }
      const applied = applyPatches(working, patches, { contract });
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
          working = applied.tree;
          latestCandidate = await snapshotStore.createSnapshot(owner, projectId, working, {
            buildId, parent: latestCandidate?.id || parentSnapshotId,
            reason: `candidate:${step}:${attempt}:partial`,
            assetManifest: await assetService.assetManifestFor?.(owner, projectId) || [],
          });
          await events.checkpoint?.({ owner, projectId, buildId, snapshot: latestCandidate,
            tree: working, reason: `candidate:${step}:${attempt}:partial`, promotable: false });
          log(`${step}: ${applied.rejected.length} patch(es) rejected (${classes.join(", ")}); `
            + `retaining ${filesChanged.length} file(s) that applied cleanly`);
        } else {
          working = originalTree;
          log(`${step}: ${applied.rejected.length} patch op(s) rejected (${classes.join(", ")}), feeding reasons back`);
        }
        attempts += 1;
        attemptLedger.push({ attempt, dispatch: dispatchStep, class: classes[0] || "patch_not_applicable",
          substantive: true, rejected: applied.rejected.length, retainedFiles: retained ? filesChanged : [] });
        continue;
      }
      if (activeScope) {
        const outsideScope = filesChanged.filter((path) => !(activeScope.allowedFiles || []).includes(path)
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
            working = originalTree;
          }
          attempts += 1;
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
        rejections = [{
          code: patches.length ? "patch_noop" : "empty_patch_envelope",
          signature: "no-op",
          file: null,
          operation: null,
          reason: patches.length
            ? "your batch left every file byte-identical — re-emitting current content is not implementation. "
              + "CREATE the required sections/pages as newFile entries (src/routes/…), register them in src/App.jsx, "
              + "and make every journey outcome visible as real UI text"
            : "you returned no patches at all — emit the files this step requires",
        }];
        working = internalHeadroomSplit ? working : originalTree;
        noOps += 1;
        attemptLedger.push({ attempt, dispatch: dispatchStep,
          class: patches.length ? "patch_noop" : "empty_patch_envelope", substantive: false });
        log(`${step}: no-op batch rejected deterministically `
          + `(protocol round ${noOps}/${maxNoOpRetries}, generation attempts still ${attempts}/${maxGenerationAttempts})`);
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
        rejections = [];

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
          rejections = blockingProblems.map((reason) => ({ signature: "blocking-defect", reason }));
          working = originalTree;
          attempts += 1;
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
        corrections += 1;
        log(`${step}: ${assetCompliance.problems.length} asset-attribution defect(s) rejected deterministically`);
        continue;
      }
      abortIfRequested(signal);
      const gate = await verifyStage(applied.tree, gateOptions(contract, step, journeys, {
        owner, projectId, buildId, step, attempt, signal,
      }));
      advisory = [...advisory, ...(gate.advisory || [])];
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
      rejections = [];
      const gateScope = targetedGateCorrection(gate, gate.tree || applied.tree);
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
          + `[${gateScope.files.join(", ")}] (${corrections}/${maxCandidateCorrections} corrections)`);
        continue;
      }
      // No honest bounded repair scope exists. This is a real full-generation failure.
      working = originalTree;
      attempts += 1;
      attemptLedger.push({ attempt, dispatch: dispatchStep,
        class: gate.layers.d0d2.failure?.kind || "gate_failed", substantive: true,
        problems: gateProblems.length });
      log(`${step}: gate failed (${gateProblems.length} problem(s)), attempt ${attempts}/${maxGenerationAttempts}`);
    }
    // Say WHICH ceiling ended the step. "No runnable tree in 3 attempts" read identically whether
    // the model wrote three broken applications or none at all.
    if (noOps > maxNoOpRetries) {
      return failure(`no substantive generation: ${noOps} consecutive protocol round(s) changed nothing `
        + `(generation attempts used: ${attempts}/${maxGenerationAttempts})`, { code: "no_substantive_generation" });
    }
    return failure(attempts >= maxGenerationAttempts
      ? `no runnable tree within ${maxGenerationAttempts} generation attempts`
      : `no runnable tree within ${maxDispatches} dispatches (${attempts} attempt(s), ${corrections} correction(s))`);
  }

  return {
    async runBuild({ owner, projectId, request, profile = "simple", budgetCredits = null,
      maxRepairs = maxJourneyRepairs, userCritical = [], signal = null }) {
      const buildId = await buildStore.create({
        owner, project_id: projectId, profile, request, state: "created",
        budget_credits: budgetCredits, max_repair_dispatches: maxRepairs,
        started_at: new Date().toISOString(),
      });
      await events.buildCreated?.({ owner, projectId, buildId, mode: "build" });
      // Only REAL bv2_builds columns reach the store; everything else is return-value only
      // (the first live run died writing `problems` into the table). A store failure at
      // finish must never mask the build's actual outcome.
      const PERSISTED_FIELDS = ["error", "final_snapshot", "contract_id", "spent_credits"];
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
      };

      let workingSnapshot = null;
      try {
        abortIfRequested(signal);
        // 1. contract → tiers, capability bindings, image intents (deterministic after the call).
        await setState("contracting");
        const rawContract = await contractFn({ owner, projectId, buildId, request, profile, signal });
        // ONE derivation for the whole build: tiers, bindings, module plan, interaction
        // contract, per-module contracts, persistence ownership and image intents all come
        // from here and are passed down, so no subsystem re-reads the contract prose alone.
        const spec = deriveBuildSpec(rawContract, { userCritical });
        if (!spec.verdict.ok) return finish("blocked", {
          error: "interaction contract is structurally incomplete before generation",
          problems: spec.verdict.problems,
          failureClassification: "interaction_contract_invalid",
        });
        const { contract, tiers, bindings, interactionContract } = spec;
        const intents = spec.imageIntents;
        const refinedProfile = await classifyContract?.({ request, contract, profile }) || profile;
        const buildAttemptPolicy = generationPolicyFor(refinedProfile, {
          simpleAttempts: maxCoreAttempts, simpleCorrections: maxPrecompileCorrections,
        });
        log(`generation policy: ${buildAttemptPolicy.profile} â€” ${buildAttemptPolicy.maxGenerationAttempts} `
          + `full attempts, ${buildAttemptPolicy.maxCandidateCorrections} retained-candidate corrections; `
          + "the approved build credit ceiling remains authoritative");
        if (refinedProfile !== profile) {
          try { await buildStore.update(buildId, { profile: refinedProfile }); }
          catch (error) { log(`profile refinement failed: ${error.message}`); }
        }
        const persistedContract = await events.contract?.({ owner, projectId, buildId, contract, tiers,
          bindings, intents });
        if (persistedContract?.id) {
          try { await buildStore.update(buildId, { contract_id: persistedContract.id }); }
          catch (error) { log(`contract id update failed: ${error.message}`); }
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

        // 3. CORE: the essential set only.
        await setState("core");
        let tree = baseTree();
        tree["src/lib/assetData.js"] = renderAssetData(resolved);
        const core = await buildIncrement({
          step: "core", owner, projectId, buildId, contract, tiers, bindings, tree, assets: resolved,
          journeys: essentialJourneys, checkpointReason: "working:core", signal, spec,
          attemptPolicy: buildAttemptPolicy,
        });
        if (!core.ok) return finish("blocked", { error: core.reason, problems: core.problems,
          advisoryFindings: core.advisory || [],
          coreAttempts: core.attempts, coreCorrections: core.corrections,
          workingSnapshotId: core.candidateSnapshotId || null });
        tree = core.tree;
        const coreAdvisory = core.advisory || [];
        workingSnapshot = core.snapshot;
        let workingReason = "working:core";

        // A verifier that cannot supply a valid fixture or cannot run is a PLATFORM failure, not
        // evidence that generated source is wrong. Preserve the candidate and stop before a model
        // repair turn. The live Roblox-concept run spent both repair rounds trying to fix JSX for
        // a 14-character fixture the verifier itself had put into a 20-character prompt.
        const blockOnVerifierPlatformFailure = async (verdicts) => {
          const defects = [...(verdicts.verifierDefects || [])];
          if (verdicts.unavailable) defects.push({ code: "journey_verifier_unavailable",
            detail: verdicts.verifierError || "the browser verifier was unavailable" });
          if (!defects.length) return null;
          const reason = defects.map((defect) => `${defect.code}: ${defect.detail || "verification platform failure"}`).join("; ");
          return finish("blocked", {
            error: `Builder V2 verification platform failure: ${reason}`,
            failureClassification: "verification_platform_defect",
            platformDefects: defects,
            workingSnapshotId: workingSnapshot?.id || null,
          });
        };

        // 4. verify essential journeys (differential), then the C4 eligibility decision —
        //    with the V2-20 repair tier between them: a verified BROWSER failure earns up
        //    to maxRepairs targeted rounds, each briefed with the exact step
        //    evidence, each re-verified differentially (passing journeys reuse verdicts).
        await setState("verify_core");
        let coreVerdicts = await verifyJourneySet({ owner, projectId, buildId, contract,
          journeys: essentialJourneys, tree, snapshotId: null, signal });
        let verifierBlock = await blockOnVerifierPlatformFailure(coreVerdicts);
        if (verifierBlock) return verifierBlock;
        let backendRowFailures = backendProbeFn ? await backendProbeFn({
          owner, projectId, contract, tiers, journeyResults: coreVerdicts.journeys,
        }) : [];
        let eligibility = previewEligibility({ tiers, gates: { ok: true }, journeyResults: { journeys: coreVerdicts.journeys },
          backendRowFailures, blockingErrors: coreVerdicts.blockingErrors });
        let repairsAttempted = 0;
        let repairExhausted = false;
        let repairLimit = null;

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
              step: "repair", owner, projectId, buildId, contract, tiers, bindings, tree, assets: resolved,
              journeys: essentialJourneys, initialProblems: evidence,
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
            journeys: essentialJourneys, tree, snapshotId: null, signal });
          verifierBlock = await blockOnVerifierPlatformFailure(coreVerdicts);
          if (verifierBlock) return verifierBlock;
          backendRowFailures = backendProbeFn ? await backendProbeFn({
            owner, projectId, contract, tiers, journeyResults: coreVerdicts.journeys,
          }) : [];
          eligibility = previewEligibility({ tiers, gates: { ok: true },
            journeyResults: { journeys: coreVerdicts.journeys }, backendRowFailures,
            blockingErrors: coreVerdicts.blockingErrors });
        }
        for (let round = 1; !eligibility.eligible && round <= maxRepairs; round += 1) {
          const structuredInteractionEvidence = interactionFailureDiagnostics({
            contract, interactionContract, journeyResults: coreVerdicts, tree,
          }).map((row) => JSON.stringify(row));
          const evidence = [
            ...coreVerdicts.journeys.filter((j) => j.status !== "pass").flatMap((j) => {
              const failedSteps = (j.steps || []).filter((s) => s.status !== "pass");
              const journeyEvidence = failedSteps.length
                ? failedSteps.map((s) => `journey ${j.id} · step "${s.action}" FAILED in a real browser: ${s.detail || "expected outcome never appeared"}`)
                : [`journey ${j.id} FAILED in a real browser (no per-step evidence recorded)`];
              const attributionEvidence = j.attributionDefect
                ? [`platform defect ${j.attributionDefect.code}: journey ${j.id} has no owning module; bounded fallback files: ${(j.fallbackRefs || []).join(", ") || "none available"}`]
                : [];
              return [...journeyEvidence, ...attributionEvidence];
            }),
            ...structuredInteractionEvidence,
            // MECHANICS EVIDENCE FIRST. A journey failure says "step 5 was undriveable"; the probe
            // says which control, by its own id, what mechanic was expected and what the browser
            // actually observed. Run #7 spent both its rounds on the second kind of message and
            // fixed nothing. Named as a MECHANIC, never as a field: the model is being told a
            // control cannot hold a value, not what the value would have meant.
            ...(coreVerdicts.mechanics?.failures || []).map((row) => `control ${row.id} (${row.primitive}) `
              + `failed its mechanics probe: expected ${JSON.stringify(row.expected)}, observed `
              + `${JSON.stringify(row.observed)} — ${row.detail}. The control is present and located by `
              + "its declared identity, so bind it so a typed value lands in state and renders back, "
              + "for example: value={state.field} with onChange writing state through the setter, or "
              + "the capability field binding, or an uncontrolled input with defaultValue."),
            ...backendRowFailures.map((f) => `backend row check failed (${f.journeyId}): ${f.detail}`),
            ...coreVerdicts.blockingErrors,
            // Shape findings that did not stop the build ride along as CONTEXT for a repair
            // that is now driven by observed browser failure. They explain, they do not accuse.
            ...advisoryMessages(coreAdvisory.filter((finding) => finding.code !== "interaction_control_undriveable")),
          ];
          if (!evidence.length) break; // nothing actionable to brief — blocked below
          await setState(`repair:${round}`);
          log(`repair ${round}/${maxRepairs}: ${evidence.length} verified failure(s)`);
          repairsAttempted += 1;
          let repair;
          try {
            repair = await buildIncrement({
              step: "repair", owner, projectId, buildId, contract, tiers, bindings, tree, assets: resolved,
              journeys: essentialJourneys, initialProblems: evidence,
              checkpointReason: `working:repair:${round}`, parentSnapshotId: workingSnapshot?.id || null,
              signal, spec,
              attemptPolicy: buildAttemptPolicy,
            });
          } catch (error) {
            if (error?.code !== "repair_limit_reached") throw error;
            repairExhausted = true;
            repairLimit = { code: error.code, repairsDispatched: error.repairsDispatched,
              maxRepairs: error.maxRepairs };
            break;
          }
          if (!repair.ok) break;
          tree = repair.tree;
          workingSnapshot = repair.snapshot;
          workingReason = `working:repair:${round}`;
          coreVerdicts = await verifyJourneySet({ owner, projectId, buildId, contract,
            journeys: essentialJourneys, tree, snapshotId: null, signal });
          verifierBlock = await blockOnVerifierPlatformFailure(coreVerdicts);
          if (verifierBlock) return verifierBlock;
          backendRowFailures = backendProbeFn ? await backendProbeFn({
            owner, projectId, contract, tiers, journeyResults: coreVerdicts.journeys,
          }) : [];
          eligibility = previewEligibility({ tiers, gates: { ok: true }, journeyResults: { journeys: coreVerdicts.journeys },
            backendRowFailures, blockingErrors: coreVerdicts.blockingErrors });
        }
        if (!eligibility.eligible) return finish("blocked", {
          error: `required contracted journeys remain red: ${eligibility.failures.join("; ")}`,
          failureClassification: "contracted_journeys_red",
          repair_exhausted: repairExhausted || repairsAttempted >= maxRepairs,
          repairLimit,
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
        const completedJourneys = new Set(essentialJourneys.map((journey) => journey.id));
        const pendingIncrements = [...eligibility.pendingIncrements];
        for (const journey of secondaryJourneys) {
          const step = `increment:${journey.id}`;
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
              journeys: [journey], tree: increment.tree, snapshotId: candidate.id, signal });
          }
          const incrementEligibility = increment.ok ? completionEligibility({
            contract: { ...contract, journeys: [journey] }, gates: { ok: true },
            journeyResults: { journeys: verdicts.journeys }, blockingErrors: verdicts.blockingErrors,
          }) : { eligible: false };
          const passed = increment.ok && incrementEligibility.eligible;
          if (!passed) {
            pendingIncrements.push({ journeyId: journey.id, title: journey.title, reason: increment.ok ? "journey verification failed" : increment.reason });
            if (increment.ok) {
              workingSnapshot = increment.snapshot;
              candidate = workingSnapshot;
              await events.checkpoint?.({ owner, projectId, buildId, snapshot: workingSnapshot,
                tree: increment.tree, reason: workingSnapshot.reason, promotable: false });
            }
            log(`${step}: required journey remains red; retained only as a candidate checkpoint`);
            continue;
          }
          const snapshot = await snapshotStore.markCandidateValidated(owner, projectId, increment.snapshot.id,
            { reason: `working:${step}` });
          await events.checkpoint?.({ owner, projectId, buildId, snapshot, tree: increment.tree,
            reason: `working:${step}`, promotable: false });
          candidate = snapshot;
          workingSnapshot = snapshot;
          shipped.push(journey.id);
          completedJourneys.add(journey.id);
          log(`${step}: verified (working snapshot ${snapshot.id})`);
        }

        for (const journey of contract.journeys || []) {
          if (!completedJourneys.has(journey.id) && !pendingIncrements.some((row) => row.journeyId === journey.id)) {
            pendingIncrements.push({ journeyId: journey.id, title: journey.title, reason: "required journey was not completed" });
          }
        }

        if (pendingIncrements.length) return finish("blocked", {
          error: `required contracted journeys remain red: ${pendingIncrements.map((row) => row.journeyId).join(", ")}`,
          coreSnapshotId: coreSnapshot.id, shipped, pendingIncrements,
          workingSnapshotId: workingSnapshot?.id || candidate.id, providerCalls,
        });

        const finalTree = await snapshotStore.materialize(owner, candidate.id);
        await events.snapshot?.({ owner, projectId, buildId, snapshot: candidate, tree: finalTree, reason: "complete" });
        await snapshotStore.promote(owner, projectId, "green", candidate.id);

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
      initialProblems = [], maxRepairs = 1, userCritical = [], signal = null }) {
      const sourceBuild = await buildStore.get(sourceBuildId);
      const buildId = await buildStore.create({
        owner, project_id: projectId, profile: sourceBuild?.profile || "simple", request, state: "created",
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
        source.tree = refreshPlatformRuntime(source.tree);
        const spec = deriveBuildSpec(contract, { userCritical });
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
        const initialRepairScope = initialGate.ok ? null : targetedGateCorrection(initialGate, source.tree);
        let retainedJourneyProblems = [];
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
            await snapshotStore.promote(owner, projectId, "green", retainedCheckpoint.id);
            return finish("green", { final_snapshot: retainedCheckpoint.id,
              snapshotId: retainedCheckpoint.id, parentSnapshotId: source.snapshotId, providerCalls: 0 });
          }
          const retainedEvidence = browserRepairEvidence({
            contract, interactionContract: spec.interactionContract,
            journeyResults: retainedVerdicts, tree: initialGate.tree,
          });
          retainedJourneyProblems = retainedEvidence.length
            ? retainedEvidence : retainedEligibility.failures || [];
        }
        const repairProblems = initialGate.ok
          ? [...retainedJourneyProblems, ...initialProblems]
          : [...(initialGate.layers?.d0d2?.problems || []), ...initialProblems];
        const repair = await buildIncrement({
          step: "repair", owner, projectId, buildId, contract, tiers, bindings, tree: source.tree,
          assets: [], journeys: allJourneys, initialProblems: repairProblems, editRequest: request,
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
        if (!eligibility.eligible) return finish("blocked", { error: eligibility.failures.join("; "),
          workingSnapshotId: checkpoint.id });
        checkpoint = await snapshotStore.markCandidateValidated(owner, projectId, checkpoint.id,
          { reason: "working:resumed-repair" });
        await events.checkpoint?.({ owner, projectId, buildId, snapshot: checkpoint,
          tree: repair.tree, reason: "working:resumed-repair", promotable: false });
        await events.snapshot?.({ owner, projectId, buildId, snapshot: checkpoint,
          tree: repair.tree, reason: "resumed-repair" });
        await snapshotStore.promote(owner, projectId, "green", checkpoint.id);
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
        const tree = refreshPlatformRuntime(source.tree);
        const spec = deriveBuildSpec(contract, { userCritical });
        contract = spec.contract;
        const journeys = contract.journeys || [];
        const conformance = validateModuleConformance(tree, {
          contract, modulePlan: spec.modulePlan, moduleContracts: spec.moduleContracts,
          interactionContract: spec.interactionContract, bindings: spec.bindings,
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
        await snapshotStore.promote(owner, projectId, "green", checkpoint.id);
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
        ctx.tree = refreshPlatformRuntime(ctx.tree);
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
        await snapshotStore.promote(owner, projectId, "green", snapshot.id);
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
