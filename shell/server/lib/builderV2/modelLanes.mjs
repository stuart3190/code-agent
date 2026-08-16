// The real model lanes behind the orchestrator's two seams (finish plan WP-9; master plan
// Parts 4 and 10). One shared usage bucket + one managedUsageGuard cover EVERY call in a
// build — contract and patches alike — so the job ceiling is a property of the build, not
// of any single call. All spend lands in the canonical diagnostics tables via diag.step
// (creditsForUsage is the ONE pricing function; nothing here invents a second).

import { generateContract } from "../appBuild/contractAgent.mjs";
import { contractBrief } from "../../../shared/implementationContract.mjs";
import { managedUsageGuard } from "../buildJobs.mjs";
import { expectationKeywords } from "../appBuild/journeyVerifier.mjs";
import { EMIT_PATCHES_SCHEMA } from "./patchEngine.mjs";
import { CAPABILITIES, capabilityBrief, preferredAssemblyBrief } from "./capabilityRegistry.mjs";
import { indexTree } from "./indexer.mjs";
import { memoryGraph } from "./graphStore.mjs";
import { retrieve, renderRetrieval } from "./retrieval.mjs";
import {
  bindCapabilities, capabilityRequirementsBrief, persistenceOwnershipPlan,
} from "./contractTiering.mjs";
import { getKnowledge, knowledgeBrief } from "./knowledge.mjs";
import { creditsForUsage } from "../../../../src/billing/costModel.mjs";
import { modelCallKey } from "./modelReservations.mjs";
import { classifyProviderFailure, replayUnsafe } from "../providerOutcome.mjs";
import { assemblyNeeds, interactionContractBrief, scopeInteractionContract } from "./interactionContract.mjs";
import {
  moduleGenerationContractsBrief, moduleGenerationContractsRepairBrief,
} from "./moduleContracts.mjs";
import { dependencyPlanBrief, scopeDependencyPlan } from "./dependencyPlan.mjs";

/** Same shape as buildJobs' private bucket: one accumulator for the whole job. */
export function jobUsageBucket() {
  const total = { turns: 0, input: 0, output: 0, reasoning: 0, cached: 0, cacheWrite: 0, total: 0 };
  const providerRequestIds = new Set();
  return {
    add(telemetry) {
      if (!telemetry) return;
      for (const key of Object.keys(total)) total[key] += Number(telemetry[key] || 0);
      for (const id of [
        ...(Array.isArray(telemetry.providerRequestIds) ? telemetry.providerRequestIds : []),
        telemetry.providerRequestId,
      ].filter(Boolean)) providerRequestIds.add(String(id));
    },
    summary() { return { ...total, providerRequestIds: [...providerRequestIds].sort() }; },
  };
}

// ── prompt rendering (byte-stable given identical inputs — Part 10 prefix discipline) ─────────

const PATCH_SYSTEM_PROMPT = `You are the implementation engine of an app builder. You receive an
implementation contract, the current file tree of a React+Vite app, and pre-resolved image
assets. You make changes ONLY by calling emit_patches — symbol-level operations validated
against a code index. Rules:
- newFile creates files; never rewrite an existing file via newFile. Ops modify existing files:
  add_import adds an import line (imports are NOT symbols); replace_symbol swaps a component
  wholesale (never append a second default component); replace_exact safely replaces one unique
  old source excerpt inside a large symbol; replaceFile is for index-opaque files.
- Pages live in src/routes/<Name>.jsx and MUST be registered in src/App.jsx's ROUTES map
  (replace_symbol on the existing map or the App component).
- src/lib/backend/, src/lib/visitorSession.js and src/lib/capabilities/ are protected platform
  infrastructure: IMPORT them, never modify or reimplement them. Persistence goes through the
  capabilities (src/lib/capabilities) — never localStorage. Every entity operation establishes
  and recovers this app's visitor session automatically, so use the normal capability/entity
  APIs and do NOT call ensureVisitorSession() yourself. A capability-OWNED entity (contact
  messages, newsletter signups, bookings, …) must still go through its owning capability
  (submitContact / subscribe / createBooking): a raw db.entity(...) write to one bypasses that
  capability's validation and is rejected.
- Imagery: import { ASSETS } from "./lib/assetData.js" (adjust the relative path) and render
  with the helpers in src/lib/assets.js (imageProps / pictureSources / isPlaceholder /
  placeholderStyle). Never hardcode an image URL and never invent one. When ASSET_CREDITS
  contains Pexels assets, render a visible footer link to Pexels and link each available
  photographer name to that asset's photoUrl.
- Every user-visible outcome named in the journeys must appear as real, reachable UI text.
- Keep components small; one route file per page plus small shared components.
- BUILD THE WHOLE ASSIGNED DISPATCH SCOPE IN THIS ONE BATCH. A normal core step is several patches and several
  kilobytes of new JSX: new files for every section/page, real copy, real form state, and
  the App.jsx registration. A batch that re-emits existing content, leaves scaffold stubs
  in place, or only tweaks one line is rejected as a no-op and costs you a round.`;

// When the ordinary bounded file prompt still cannot fit, the orchestrator supplies exact source
// excerpts and an exact-replacement primitive. This deliberately excludes broad architecture and
// capability prose: the retained tree supplies exact current bytes, the write boundary is
// machine-enforced, and deterministic compile/browser verification remains mandatory.
export const HEADROOM_FRAGMENT_SYSTEM_PROMPT = `You repair one bounded defect in an existing
React+Vite app. Respond only by calling emit_patches. Modify only the allowed file. Prefer
replace_exact: put the exact old excerpt in symbol and its complete replacement in content. The
old excerpt must occur exactly once and the resulting full file must parse. Preserve all unrelated
behaviour. Never modify protected platform files, fake persistence, or weaken verification.`;

function renderTreeContext(tree, { extraFullPaths = [] } = {}) {
  const paths = Object.keys(tree).sort();
  const listed = paths.map((p) => `  ${p}`).join("\n");
  const shown = new Set();
  const show = (path) => {
    if (!tree[path] || shown.has(path)) return "";
    shown.add(path);
    return `\n--- ${path} (current content) ---\n${tree[path]}`;
  };
  return [
    "FILE TREE:", listed,
    show("src/App.jsx"),
    show("src/routes/HomePage.jsx"),
    show("src/lib/assetData.js"),
    ...extraFullPaths.map(show),
  ].join("\n");
}

/**
 * WP-12 cost work: edit and repair steps carry RETRIEVAL-SLICED context — the evidence's
 * files in full, neighbours as interfaces, the rest as one-line summaries under a hard
 * 9k-token budget — instead of whole files (the WP-10 edit paid ~8k tokens per round to
 * re-send a monolith page it barely touched).
 */
export function renderScopedContext(tree, {
  step, editRequest = null, problems = [], journeys = [], capabilityPaths = [], onRetrieval = null,
} = {}) {
  const graph = memoryGraph("ctx", "ctx", indexTree(tree));
  const evidenceText = step === "edit" ? String(editRequest || "") : problems.join(" ");
  const failureRefs = [...new Set(problems.join("\n").match(/src\/[\w/.-]+\.(?:jsx?|tsx?|css|mjs)/g) || [])];
  const targets = editTargets(tree, evidenceText, { limit: 4 });
  const result = retrieve({ graph, tree, targets, failureRefs, journeys, capabilityPaths, budgetTokens: 9_000 });
  if (result.requiredUnavailable.length) {
    throw new Error(`retrieval cannot provide complete required context: ${result.requiredUnavailable.map((row) => row.path).join(", ")}`);
  }
  onRetrieval?.({
    query: { step, editRequest, problems, targets, failureRefs, journeys: journeys.map((journey) => journey?.id).filter(Boolean), capabilityPaths },
    included: result.trace.included,
    omittedCount: result.trace.omittedCount,
    tokens: result.tokens,
  });
  const paths = Object.keys(tree).sort().map((p) => `  ${p}`).join("\n");
  return [
    "FILE TREE (paths only — retrieval below carries the relevant content):", paths, "",
    renderRetrieval(result, tree),
    tree["src/lib/assetData.js"] ? `\n--- src/lib/assetData.js (current content) ---\n${tree["src/lib/assetData.js"]}` : "",
  ].join("\n");
}

/** Strict context for a deterministic pre-compile defect: no unrelated source bodies. */
export function renderPrecompileRepairContext(tree, { repairScope, onRetrieval = null } = {}) {
  const files = [...new Set(repairScope?.files || [])].sort();
  const interfaces = [...new Set([
    ...(repairScope?.adapterInterfaces || []), ...(repairScope?.capabilityPaths || []),
  ])].filter((path) => !files.includes(path)).sort();
  const mayCreateMissing = ["module_contract", "runtime_dependency", "imports", "structural_modularity", "headroom_continuation"]
    .includes(repairScope?.kind);
  for (const path of files) {
    if (typeof tree?.[path] !== "string" && !mayCreateMissing) {
      throw new Error(`pre-compile repair source is missing: ${path}`);
    }
  }
  if (mayCreateMissing && files.some((path) => typeof tree?.[path] !== "string")) {
    tree = { ...tree };
    for (const path of files) {
      if (typeof tree[path] !== "string") tree[path] = "// REQUIRED PLANNED MODULE IS MISSING; create it with newFile";
    }
  }
  const graph = memoryGraph("ctx", "ctx", indexTree(tree));
  const interfaceText = (path) => {
    const file = graph.file(path);
    if (!file) return `${path} (platform interface is supplied by the capability contract)`;
    const exported = (file.symbols || []).filter((symbol) => symbol.exported)
      .map((symbol) => `${symbol.kind} ${symbol.name}`).join(", ");
    return `${path}${exported ? ` — exports ${exported}` : ""}`;
  };
  const included = [
    ...files.map((path) => ({ path, form: typeof tree?.[path] === "string" ? "full" : "missing_planned_module",
      reason: "deterministic validator pointed here", tokens: Math.ceil(String(tree?.[path] || "").length / 4) })),
    ...interfaces.map((path) => ({ path, form: "interface", reason: "required persistence interface",
      tokens: Math.ceil(interfaceText(path).length / 4) })),
  ];
  const tokens = included.reduce((sum, row) => sum + row.tokens, 0);
  onRetrieval?.({
    query: { step: "repair", kind: repairScope?.kind, files, capabilityPaths: repairScope?.capabilityPaths || [] },
    included, omittedCount: Math.max(0, Object.keys(tree || {}).length - included.length), tokens,
  });
  return [
    "FILE TREE (paths only; only the validator-named repair scope is included below):",
    Object.keys(tree || {}).sort().map((path) => `  ${path}`).join("\n"),
    "",
    "FILES IN FULL:",
    ...files.map((path) => `\n// ${path} — deterministic validator pointed here\n${tree[path]}`),
    "",
    "RELEVANT INTERFACES:",
    ...interfaces.map(interfaceText),
  ].join("\n");
}

/** Deterministic edit-scope targeting: generated files ranked by request-keyword hits. */
export function editTargets(tree, request, { limit = 3 } = {}) {
  const words = [...new Set(String(request).toLowerCase().match(/[a-z]{4,}/g) || [])];
  return Object.entries(tree)
    .filter(([path]) => /^src\/(routes|components|data)\/.*\.(jsx?|tsx?)$/.test(path))
    .map(([path, source]) => {
      const body = String(source).toLowerCase();
      return { path, hits: words.filter((w) => body.includes(w)).length };
    })
    .filter((f) => f.hits > 0)
    .sort((a, b) => b.hits - a.hits || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map((f) => f.path);
}

// The live-proven v1 transition brief (stagePlan.mjs): the verifier snapshots the page
// BEFORE each action and only counts what changed AFTER it; a step passes when ≥ half its
// expectation keywords are visible — NEWLY visible, unless the step is navigational. The
// second live run failed exactly because the builder was never told this contract.
function renderJourneyBrief(journeys) {
  const lines = [
    "JOURNEYS THIS STEP MUST MAKE PASS — a real browser drives every step. The verifier",
    "snapshots the page BEFORE each action and passes the step only when the expected",
    "outcome APPEARS OR CHANGES as a result of the action. Words already present as",
    "static copy count for NOTHING on action steps — a page that always says \"received\"",
    "fails the submit step. Every outcome must be a real state transition:",
    "  - choosing an option: unchosen first; the click adds a visible active/selected state;",
    "  - submitting: the confirmation wording must NOT exist anywhere before submit and must",
    "    render after it — use DISTINCTIVE confirmation copy, not words the page already shows;",
    "  - cancelling or updating: the visible status text changes to the new state;",
    "  - navigation/page-load steps: at least half the listed keywords must be visible on the page.",
    "",
  ];
  for (const journey of journeys) {
    if (!journey) continue;
    lines.push(`JOURNEY — ${journey.title}${journey.priority === "primary" ? " (PRIMARY — the preview is gated on this)" : ""}:`);
    for (const [i, step] of (journey.steps || []).entries()) {
      lines.push(`  ${i + 1}. ACTION: ${step.action}${step.target ? ` (${step.target})` : ""}`);
      lines.push(`     RESULT (must be caused by the action): ${step.expect}`);
      const wanted = expectationKeywords(step.expect);
      if (wanted.length) {
        lines.push(`     the verifier looks for these EXACT words as visible text: [${wanted.join(", ")}] — at least half must be present (newly, unless this step is navigation/page-load)`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

function structuredFailure(problem) {
  if (typeof problem !== "string" || !problem.trim().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(problem);
    return parsed?.code === "interaction_verification_failure" ? parsed : null;
  } catch {
    return null;
  }
}

function isDownstreamFailureEvidence(problem) {
  const structured = structuredFailure(problem);
  if (structured) return ["not_reached", "skipped"].includes(String(structured.status || "").toLowerCase());
  const value = String(problem);
  if (/\b(?:not[_ ]reached|skipped)\b/i.test(value)) return true;
  return /(?:required starting state|journey prerequisites).*could not be established/i.test(value);
}

export function repairFailureReferences(problems = []) {
  return (problems || [])
    .filter((problem) => !isDownstreamFailureEvidence(problem))
    .map((problem) => {
      const structured = structuredFailure(problem);
      if (structured?.journeyId && structured?.userAction) {
        return { journeyId: structured.journeyId, action: structured.userAction };
      }
      // Accept both the canonical middle dot and its historical UTF-8 mojibake as stored by older
      // workers. The orchestrator emits this exact sentence; repair scoping must parse what it owns.
      const current = String(problem).match(/^journey\s+(.+?)\s+(?:\u00c2?\u00b7)\s+step\s+"([^"]+)"\s+FAILED/i);
      if (current) return { journeyId: current[1], action: current[2] };
      const legacy = String(problem).match(/^journey ([^:]+): (.*?): /);
      return legacy ? { journeyId: legacy[1], action: legacy[2] } : null;
    }).filter(Boolean);
}

/** Prefer the earliest primary-journey defect over simultaneous secondary cascades. */
export function causalRepairProblems(contract = {}, problems = []) {
  const actionable = (problems || []).filter((problem) => !isDownstreamFailureEvidence(problem));
  const primary = new Set((contract.journeys || [])
    .filter((journey) => journey.priority === "primary")
    .map((journey) => journey.id));
  const primaryStructured = actionable.filter((problem) => {
    const structured = structuredFailure(problem);
    return structured?.journeyId && primary.has(structured.journeyId);
  });
  return primaryStructured.length ? primaryStructured : actionable;
}

export function repairFailureOwnedPaths(contract = {}, problems = []) {
  const actionable = causalRepairProblems(contract, problems);
  const directOwners = actionable.flatMap((problem) => {
    const structured = structuredFailure(problem);
    if (!structured) return [];
    const stateOwners = structured.stateOwners || [];
    return stateOwners.length ? stateOwners : structured.responsibleModules || [];
  });
  const failures = new Set(repairFailureReferences(actionable)
    .map((failure) => `${failure.journeyId}\n${failure.action}`));
  const mappedOwners = failures.size ? (contract.interactionContract?.flows || [])
    .filter((flow) => failures.has(`${flow.journeyId}\n${flow.action}`))
    .flatMap((flow) => {
      const stateOwners = [flow.stateOwner, flow.control?.stateOwner].filter(Boolean);
      return stateOwners.length ? stateOwners : flow.responsibleModules || [];
    }) : [];
  return [...new Set([...directOwners, ...mappedOwners]
    .filter((path) => typeof path === "string" && GENERATED_SOURCE.test(path)))];
}

function renderHeadroomFragmentPrompt({ headroomScope, problems = [], onRetrieval = null }) {
  const fragments = headroomScope?.fragments || [];
  const included = fragments.map((fragment) => ({
    path: fragment.path, form: "exact_fragment", reason: "live verifier named this control/state",
    startLine: fragment.startLine, endLine: fragment.endLine,
    tokens: Math.ceil(Buffer.byteLength(fragment.content || "", "utf8") / 4),
  }));
  onRetrieval?.({
    query: { step: "repair", kind: headroomScope.kind, files: headroomScope.allowedFiles },
    included, omittedCount: 0, tokens: included.reduce((sum, row) => sum + row.tokens, 0),
  });
  const failures = [...new Set((problems || []).filter((problem) => !isDownstreamFailureEvidence(problem))
    .map((problem) => {
      const structured = structuredFailure(problem);
      if (!structured) return String(problem);
      return [
        `action=${structured.userAction || "unknown"}`,
        `expected=${structured.expectedStateAfter || structured.expectedOutcome || structured.expected || "contracted visible transition"}`,
        `observed=${structured.actualObservedState || structured.detail || "the transition did not occur"}`,
        structured.target ? `target=${structured.target}` : null,
      ].filter(Boolean).join("; ");
    }))].slice(0, 4);
  return [
    "RETAINED CANDIDATE MICRO-REPAIR",
    "The full candidate is retained. Fix only the named transition below. Deterministic structure,",
    "compile, and all contracted browser journeys still gate promotion after this patch.",
    `Allowed file: ${headroomScope.allowedFiles[0]}`,
    "Failure evidence:",
    ...failures.map((failure) => `- ${failure}`),
    "",
    "EXACT CURRENT SOURCE EXCERPTS (line numbers are informational):",
    ...fragments.map((fragment) => [
      `--- ${fragment.path}:${fragment.startLine}-${fragment.endLine} ---`, fragment.content,
    ].join("\n")),
    "",
    "Use replace_exact for a nested handler/conditional: symbol must be a non-empty exact old",
    "excerpt copied above, content its complete balanced replacement. It is rejected unless the",
    "old excerpt occurs exactly once and the entire retained file still parses. Preserve everything",
    "outside the defect. Do not replace the whole file. Call emit_patches now.",
  ].join("\n");
}

export function renderPatchPrompt({
  step, originalStep = step, contract, tiers, tree, journey, rejections = [], problems = [], editRequest = null,
  projectKnowledge = null, onRetrieval = null, modulePlan = [], moduleContracts = null,
  repairScope = null, moduleCorrectionScope = null, headroomScope = null, advisory = [],
}) {
  if (headroomScope?.fragmented) {
    return renderHeadroomFragmentPrompt({ headroomScope, problems, onRetrieval });
  }
  const isEdit = step === "edit";
  const isRepair = step === "repair" || step === "correction";
  const activeScope = headroomScope || repairScope || moduleCorrectionScope;
  const activeScopePaths = [...new Set([
    ...(activeScope?.allowedFiles || []), ...(activeScope?.files || []),
  ].filter(Boolean))];
  const promptModulePlan = activeScopePaths.length
    ? modulePlan.filter((module) => activeScopePaths.includes(module.path))
    : modulePlan;
  const browserRepair = step === "repair" && !repairScope && !moduleCorrectionScope;
  const repairFailures = browserRepair ? repairFailureReferences(problems) : [];
  const failedJourneyIds = new Set(repairFailures.map((failure) => failure.journeyId));
  const correctingIncrement = isRepair && String(originalStep || "").startsWith("increment:");
  const scopedJourneys = step === "core" || (isRepair && !correctingIncrement)
    ? (contract.journeys || []).filter((j) => browserRepair && failedJourneyIds.size
      ? failedJourneyIds.has(j.id) : tiers.essential.journeys.includes(j.id))
    : isEdit ? (contract.journeys || []) : [journey];
  const scopedJourneyIds = new Set(scopedJourneys.map((row) => row?.id).filter(Boolean));
  const scopedOperations = (contract.operations || []).filter((operation) => (
    !operation?.journey || scopedJourneyIds.has(operation.journey)
  ));
  const scopedEntityNames = new Set([
    ...scopedOperations.map((operation) => operation.entity).filter(Boolean),
    ...(step === "core" ? tiers.essential.entities : []),
  ]);
  const scopedContract = {
    ...contract,
    journeys: scopedJourneys,
    operations: scopedOperations,
    entities: (contract.entities || []).filter((entity) => scopedEntityNames.has(entity.name)),
    dependencyPlan: scopeDependencyPlan(contract.dependencyPlan, scopedJourneys),
  };
  const persistencePlan = persistenceOwnershipPlan(contract, scopedJourneys, modulePlan);
  const scopedInteractions = scopeInteractionContract(contract.interactionContract, scopedJourneys);
  const failedActions = new Set(repairFailures.map((failure) => `${failure.journeyId}\n${failure.action}`));
  const matchedRepairFlows = browserRepair && failedActions.size
    ? (scopedInteractions.flows || []).filter((flow) => failedActions.has(`${flow.journeyId}\n${flow.action}`))
    : [];
  // Exact verifier actions normally select the small failing slice. If an older/custom verifier
  // emits a different label, retain the full failed-journey contract instead of silently sending
  // no interaction requirements.
  const repairFlows = browserRepair && matchedRepairFlows.length
    ? matchedRepairFlows : scopedInteractions.flows || [];
  const repairInteractionPlan = browserRepair ? {
    version: scopedInteractions.version,
    flows: repairFlows.map((flow) => ({
      id: flow.id, journeyId: flow.journeyId, stepIndex: flow.stepIndex, kind: flow.kind,
      action: flow.action, reads: flow.reads || [], writes: flow.writes || [],
      control: flow.control ? {
        roles: flow.control.roles || [], logicalField: flow.control.logicalField || null,
        inputTypes: flow.control.inputTypes || [], accessibleNames: flow.control.accessibleNames || [],
        editable: flow.control.editable === true, stateOwner: flow.control.stateOwner || null,
      } : null,
      capability: flow.capability || null, observable: flow.observable || null,
      stateOwner: flow.stateOwner || null, responsibleModules: flow.responsibleModules || [],
    })),
  } : scopedInteractions;
  const repairFocusPaths = browserRepair ? [...new Set(repairFlows.flatMap((flow) => [
    ...(flow.responsibleModules || []), flow.stateOwner, flow.control?.stateOwner,
  ]).filter((value) => typeof value === "string" && value.startsWith("src/")))] : [];
  const repairControlFocus = headroomScope ? [...new Set(repairFlows.flatMap((flow) => [
    flow.id,
    flow.control?.logicalField,
    ...(flow.control?.accessibleNames || []),
  ]).filter(Boolean))] : [];
  const compactPersistencePlan = browserRepair || activeScopePaths.length ? {
    durableJourneys: persistencePlan?.durableJourneys || [],
    forbiddenBusinessPersistence: persistencePlan?.forbiddenBusinessPersistence || [],
    owners: persistencePlan?.owners || [],
    modules: (persistencePlan?.modules || []).filter((module) => (
      (activeScopePaths.length ? activeScopePaths : repairFocusPaths).includes(module.path)
    ))
      .map(({ forbiddenPersistence: _forbiddenPersistence, ...module }) => module),
  } : persistencePlan;
  const compactHeadroomProblems = headroomScope ? (() => {
    const actionable = (problems || []).filter((problem) => !isDownstreamFailureEvidence(problem));
    return [...new Set((actionable.length ? actionable : problems || []).map(String))].slice(0, 12);
  })() : problems;
  const compactHeadroomContract = headroomScope ? JSON.stringify({
    summary: scopedContract.summary || "",
    journeys: scopedJourneys.map((scopedJourney) => ({
      id: scopedJourney.id,
      title: scopedJourney.title,
      priority: scopedJourney.priority,
      steps: repairFailures.length
        ? (scopedJourney.steps || []).filter((contractStep) => repairFailures.some((failure) => (
          failure.journeyId === scopedJourney.id && failure.action === contractStep.action
        )))
        : scopedJourney.steps || [],
    })),
    entities: scopedContract.entities || [],
    operations: scopedOperations,
    routes: scopedContract.routes || [],
    dependencyPlan: scopedContract.dependencyPlan || null,
  }, null, 2) : null;
  const capabilityPaths = bindCapabilities(contract)
    .map((binding) => CAPABILITIES[binding.name]?.package).filter(Boolean);
  const advisoryNotes = (advisory || []).length ? [
    "",
    "ADVISORY NOTES from the previous candidate (NOT rejections — the tree was kept and is running;"
    + " address them only where they make the journeys below more likely to pass):",
    ...advisory.slice(0, 12).map((finding) => `- ${finding.code}: ${finding.message || ""}`),
  ].join("\n") : "";
  const parts = [
    `STEP: ${step}`,
    headroomScope
      ? "HEADROOM-SCOPED CONTINUATION: the current candidate is retained. Complete ONLY the named modules in this bounded internal dispatch; Thrallo will integrate and verify the remaining work automatically."
      : moduleCorrectionScope
      ? "CORE CORRECTION: preserve the current candidate and patch ONLY the validator-named modules. Do not replay or redesign conforming modules."
      : step === "core"
      ? `Build the ESSENTIAL scope only: journeys [${tiers.essential.journeys.join(", ")}], entities [${tiers.essential.entities.join(", ")}]. Secondary work is delivered later as increments — do NOT build it now.`
      : step === "correction"
        ? "PRE-COMPILE CORRECTION: your current tree is retained and usable. A deterministic safety check named the exact problem below. Fix ONLY that; change nothing else."
      : isRepair
        ? "REPAIR: a real browser drove the journeys below against your current tree and the listed steps FAILED with the exact evidence shown. Fix ONLY what the evidence names — the smallest correct patch wins, and everything currently passing must keep passing."
        : isEdit
          ? `Apply EXACTLY this change to the existing app, and nothing else:\n  ${editRequest}\nThe smallest correct patch wins: prefer symbol ops on existing files over rewrites. Every existing journey must KEEP working — do not remove or reword the outcomes they verify.`
          : `Build EXACTLY this one increment: journey "${journey?.id}" (${journey?.title}). Touch nothing else.`,
    "",
    "IMPLEMENTATION CONTRACT:",
    compactHeadroomContract || contractBrief(scopedContract),
    "",
    headroomScope
      ? "CAPABILITY REQUIREMENTS: the focused per-module summary below is the dispatch brief; full bindings remain machine-enforced after the patch."
      : capabilityRequirementsBrief(scopedContract),
    dependencyPlanBrief(scopedContract.dependencyPlan),
    promptModulePlan.length ? [
      "SUGGESTED MODULE PLAN (responsibilities matter; exact paths are guidance, not a gate — a working"
      + " application is never rejected for naming a file differently):",
      ...promptModulePlan.map((module) => {
        const ownership = module.stateOwnership || {};
        return `- ${module.path}: ${module.role}${module.factory ? `; bind ${module.factory}(...) here` : ""}; `
          + `owns=${ownership.owns || "presentation only"}; survivesReload=${ownership.survivesReload === true}; `
          + `approvedPersistence=${ownership.approvedPersistence || "none"}; durableStateOwner=${ownership.durableStateOwner || "self/none"}`;
      }),
      "Keep styling, layout, typography and component composition original to this app.",
    ].join("\n") : "REQUIRED MODULE PLAN: none for this scope.",
    "",
    activeScope || isRepair
      ? moduleGenerationContractsRepairBrief(activeScope?.moduleContracts || moduleContracts,
        {
          focusPaths: activeScopePaths.length ? activeScopePaths : repairFocusPaths,
          focusControls: repairControlFocus,
        })
      : moduleGenerationContractsBrief(moduleCorrectionScope?.moduleContracts || moduleContracts),
    "",
    compactPersistencePlan
      ? `PERSISTENCE OWNERSHIP CONTRACT (machine-enforced JSON; hard constraints, not advice):\n${JSON.stringify(compactPersistencePlan, null, 2)}`
      : "PERSISTENCE OWNERSHIP CONTRACT: no durable journey in this scope.",
    "",
    interactionContractBrief(repairInteractionPlan),
    headroomScope ? "" : preferredAssemblyBrief(assemblyNeeds(repairInteractionPlan, bindCapabilities(contract))),
    "",
    repairScope && !headroomScope ? [
      "TARGETED PRE-COMPILE REPAIR (write boundary is machine-enforced):",
      repairScope.instruction,
      `Allowed files: [${repairScope.allowedFiles.join(", ")}]`,
      ...(repairScope.allowedPrefixes?.length
        ? [`New supporting modules may be created only under: [${repairScope.allowedPrefixes.join(", ")}]`] : []),
      `Validator findings: ${JSON.stringify(repairScope.findings)}`,
    ].join("\n") : "",
    moduleCorrectionScope && !headroomScope ? [
      "MODULE-SCOPED CORE CORRECTION (write boundary is machine-enforced):",
      moduleCorrectionScope.instruction,
      `Allowed files: [${moduleCorrectionScope.allowedFiles.join(", ")}]`,
      ...(moduleCorrectionScope.allowedPrefixes?.length
        ? [`New supporting modules may be created only under: [${moduleCorrectionScope.allowedPrefixes.join(", ")}]`] : []),
      `Module conformance findings: ${JSON.stringify(moduleCorrectionScope.findings)}`,
    ].join("\n") : "",
    headroomScope ? [
      "INTERNAL HEADROOM-SCOPED WRITE BOUNDARY (machine-enforced):",
      headroomScope.instruction,
      `Allowed files: [${headroomScope.allowedFiles.join(", ")}]`,
      ...(headroomScope.allowedPrefixes?.length
        ? [`New supporting modules may be created only under: [${headroomScope.allowedPrefixes.join(", ")}]`] : []),
    ].join("\n") : "",
    activeScope ? "" : null,
    activeScope
      ? headroomScope
        ? "PROJECT KNOWLEDGE: omitted for this deterministic headroom continuation."
        : "PROJECT KNOWLEDGE: omitted for this deterministic pre-compile repair."
      : projectKnowledge || "PROJECT KNOWLEDGE: not loaded for this request.",
    "",
    headroomScope ? "" : renderJourneyBrief(scopedJourneys),
    headroomScope ? "" : advisoryNotes,
    activeScope
      ? renderPrecompileRepairContext(tree, { repairScope: activeScope, onRetrieval })
      : isEdit || isRepair
      ? renderScopedContext(tree, {
        step, editRequest, problems, journeys: scopedJourneys,
        capabilityPaths,
        onRetrieval,
      })
      : renderTreeContext(tree),
  ];
  if (rejections.length) {
    parts.push("", "YOUR PREVIOUS PATCH BATCH WAS REJECTED — every reason below is exact; fix and re-emit ALL patches:",
      ...rejections.map((r) => `- ${r.reason}`));
  }
  if (compactHeadroomProblems.length) {
    parts.push("", "VERIFICATION FAILED on your last tree — fix these and re-emit patches:",
      ...compactHeadroomProblems.map((p) => `- ${p}`));
  }
  parts.push("", "Call emit_patches now with the complete batch for this step.");
  return parts.filter((part) => part !== null).join("\n");
}

// ── the lanes ─────────────────────────────────────────────────────────────────────────────────

/**
 * Wire a provider (Codex in WP-9) into the orchestrator's contractFn/patchesFn seams with
 * ONE job-wide credit ceiling. Throws ManagedCreditBudgetError (reason job_credit_limit)
 * the moment accumulated spend can no longer fit under the ceiling.
 */
// Per-step routing (master plan Part 10, WP-12): one transport model on the Codex lane,
// so the routable lever is REASONING EFFORT — full thinking where design happens, less
// where the step is mechanical. Tuned from live traces as they accumulate.
export const STEP_ROUTING = Object.freeze({
  contract: { reasoningEffort: "medium" },
  core: { reasoningEffort: "medium" },
  repair: { reasoningEffort: "medium" },
  // A deterministic pre-compile correction is narrow and fully specified by validator findings:
  // it is mechanical work, and routes accordingly. It is also budgeted separately from `repair`
  // so a correction can never consume the one browser-informed repair slot.
  correction: { reasoningEffort: "low" },
  edit: { reasoningEffort: "low" },
  increment: { reasoningEffort: "low" },
});

/** Steps whose write scope is bounded by the validator, so output is sized from that scope. */
export const SCOPED_STEPS = Object.freeze(new Set(["repair", "correction"]));

const HEADROOM_CODES = new Set(["budget_ceiling", "step_budget_ceiling"]);
const GENERATED_SOURCE = /^src\/(?!lib\/(?:backend\/|capabilities\/|visitorSession\.js$|assets\.js$|assetData\.js$)).*\.(?:jsx?|tsx?|css)$/;
const evidencePaths = (values) => [...new Set((values || []).flatMap((value) => (
  String(value?.reason || value?.message || value || "").match(/src\/[a-zA-Z0-9_./-]+\.(?:jsx?|tsx?|css)/g) || []
)).filter((path) => GENERATED_SOURCE.test(path)))];

export function isHeadroomFitError(error) {
  return error?.dispatchState === "before_dispatch" && HEADROOM_CODES.has(error?.code)
    && /approved (?:build )?headroom|useful response|insufficient approved/i.test(String(error?.message || ""));
}

const FRAGMENT_STOP_WORDS = new Set([
  "after", "before", "because", "could", "expected", "failed", "failure", "found", "from",
  "into", "journey", "not", "required", "should", "status", "step", "that", "their", "then",
  "this", "visible", "when", "with",
]);

function sourceWords(value) {
  return String(value || "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()
    .match(/[a-z][a-z0-9_-]{3,}/g) || [];
}

/** Exact, bounded excerpts around the controls/state named by live verifier evidence. */
export function headroomSourceFragments(source, problems = [], { maxFragments = 2, radius = 7 } = {}) {
  const firstCausal = (problems || []).filter((problem) => !isDownstreamFailureEvidence(problem)).slice(0, 1);
  const evidence = firstCausal.flatMap((problem) => {
    const structured = structuredFailure(problem);
    if (!structured) return [String(problem || "")];
    return [structured.userAction, structured.expectedStateAfter, structured.expectedOutcome,
      structured.actualObservedState, structured.detail, structured.target,
      structured.control?.logicalField, ...(structured.control?.accessibleNames || []),
      ...(structured.expectedControls || []).flatMap((control) => [
        control.field, ...(control.accessibleNames || []),
      ])];
  }).filter(Boolean);
  const terms = [...new Set(evidence.flatMap(sourceWords)
    .filter((word) => !FRAGMENT_STOP_WORDS.has(word)))];
  const phrases = [...new Set(evidence.flatMap((value) => {
    const words = sourceWords(value).filter((word) => !FRAGMENT_STOP_WORDS.has(word));
    return [...words.slice(0, -1).map((word, index) => `${word} ${words[index + 1]}`),
      ...words.slice(0, -2).map((word, index) => `${word} ${words[index + 1]} ${words[index + 2]}`)];
  }))];
  if (!terms.length) return [];
  const lines = String(source || "").split("\n");
  const scored = lines.map((line, index) => {
    const normalized = line.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
    const hits = terms.reduce((sum, term) => sum + (normalized.includes(term) ? 1 : 0), 0);
    const phraseHits = phrases.reduce((sum, phrase) => sum + (normalized.includes(phrase) ? 1 : 0), 0);
    return { index, hits, score: (hits + (phraseHits * 4)) / (1 + (line.length / 500)) };
  }).filter((row) => row.hits > 0)
    .sort((a, b) => b.score - a.score || b.hits - a.hits || a.index - b.index);
  const centres = [];
  for (const row of scored) {
    if (centres.some((index) => Math.abs(index - row.index) <= radius)) continue;
    centres.push(row.index);
    if (centres.length >= maxFragments) break;
  }
  const ranges = centres.map((centre) => {
    let start = Math.max(0, centre - radius);
    // Include the nearest enclosing handler/conditional/state declaration so an excerpt shows
    // why clicking the named control did not change the rendered branch.
    for (let index = centre; index >= Math.max(0, centre - (radius * 2)); index -= 1) {
      if (/^\s*(?:if\s*\(|(?:async\s+)?function\s|const\s+\[)/.test(lines[index])) {
        start = index;
        break;
      }
    }
    return { start, end: Math.min(lines.length - 1, centre + radius) };
  }).sort((a, b) => a.start - b.start);
  const merged = [];
  for (const range of ranges) {
    const prior = merged.at(-1);
    if (prior && range.start <= prior.end + 1) prior.end = Math.max(prior.end, range.end);
    else merged.push({ ...range });
  }
  return merged.map(({ start, end }) => ({
    startLine: start + 1, endLine: end + 1, content: lines.slice(start, end + 1).join("\n"),
  }));
}

/**
 * Turn one oversized, not-yet-dispatched request into a machine-bounded semantic continuation.
 * This never retries a provider-completed call. The first split prefers validator/evidence files,
 * then missing planned modules; a repeated pre-dispatch refusal halves that set until one module
 * remains. The approved whole-build and per-call ceilings remain unchanged.
 */
export function headroomDispatchScope({
  tree = {}, modulePlan = [], moduleContracts = null, repairScope = null,
  moduleCorrectionScope = null, problems = [], rejections = [], previousScope = null,
  logicalStep = null, semanticFiles = [],
} = {}) {
  const active = previousScope || repairScope || moduleCorrectionScope;
  const activeFiles = [...new Set([...(active?.allowedFiles || []), ...(active?.files || [])])]
    .filter((path) => GENERATED_SOURCE.test(path));
  const evidence = evidencePaths([...(problems || []), ...(rejections || [])]);
  const planned = (modulePlan || []).map((module) => module.path).filter((path) => GENERATED_SOURCE.test(path));
  const missing = planned.filter((path) => typeof tree?.[path] !== "string");
  const semantic = semanticFiles.filter((path) => GENERATED_SOURCE.test(path)
    && (planned.includes(path) || typeof tree?.[path] === "string"));
  const targeted = [...new Set([
    ...activeFiles,
    ...semantic,
    // Structured state ownership is the strongest available write address. Broad diagnostic
    // `responsibleModules` remain a fallback only when no exact semantic owner was derived.
    ...(semantic.length ? [] : evidence.filter((path) => planned.includes(path) || typeof tree?.[path] === "string")),
  ])];
  // A browser/pre-compile repair already names its owning modules. Queuing every other missing
  // planned module turned a one-file repair into unrelated continuations and exhausted the
  // retained build's headroom. Planned modules remain the fallback for unscoped generation.
  const candidates = targeted.length ? targeted : [...new Set([
    ...missing,
    ...planned,
    ...["src/App.jsx", "src/routes/HomePage.jsx"].filter((path) => typeof tree?.[path] === "string"),
  ])];
  if (!candidates.length) return null;
  const priorFiles = previousScope?.allowedFiles || activeFiles;
  const width = priorFiles.length
    ? Math.max(1, Math.floor(priorFiles.length / 2))
    : Math.min(3, Math.max(1, Math.ceil(candidates.length / 2)));
  const source = priorFiles.length ? priorFiles : candidates;
  const files = source.slice(0, width);
  const remainingFiles = [...source.slice(width), ...(previousScope?.remainingFiles || [])];
  // A large top-level component may contain one tiny nested handler/branch. If the full one-file
  // prompt still cannot fit, expose only exact verifier-relevant excerpts and require a unique
  // exact-source replacement. This is a real semantic resize, not a retry of identical bytes.
  if (previousScope && previousScope.allowedFiles?.length === 1 && files.length === 1) {
    if (previousScope.fragmented) return null;
    const fragments = headroomSourceFragments(tree?.[files[0]], problems);
    if (!fragments.length) return null;
    const fragmentTokens = fragments.reduce((sum, fragment) => (
      sum + Math.ceil(Buffer.byteLength(fragment.content, "utf8") / 4)
    ), 0);
    return {
      ...previousScope,
      kind: "headroom_fragment_continuation",
      fragmented: true,
      fragments: fragments.map((fragment) => ({ path: files[0], ...fragment })),
      remainingFiles: previousScope.remainingFiles || [],
      expectedPatchTokens: Math.min(1_200, Math.max(500, Math.ceil(fragmentTokens * 0.6))),
      instruction: "The complete file is retained but too large to resend. Repair the exact nested "
        + "handler/conditional shown in the excerpts with replace_exact. Put an exact, unique old "
        + "excerpt in symbol and its balanced replacement in content; do not rewrite the whole file.",
    };
  }
  const selectedContracts = (moduleContracts?.specifications || [])
    .filter((specification) => files.includes(specification.path));
  const sourceTokens = files.reduce((sum, path) => sum + Math.ceil(String(tree?.[path] || "").length / 4), 0);
  return {
    kind: "headroom_continuation",
    logicalStep: previousScope?.logicalStep || logicalStep,
    batchIndex: Number(previousScope?.batchIndex || 0),
    files,
    allowedFiles: files,
    remainingFiles,
    batchWidth: width,
    allowedPrefixes: active?.allowedPrefixes || [],
    findings: [],
    moduleContracts: { version: moduleContracts?.version || 1, specifications: selectedContracts },
    expectedPatchTokens: Math.min(6_000, Math.max(1_000, Math.ceil(sourceTokens * 1.1))),
    instruction: "This is one bounded continuation of the same approved build. Implement the complete responsibilities "
      + `owned by [${files.join(", ")}], preserve the retained candidate, and do not touch unrelated modules. `
      + "Do not ask the customer to send another message; the orchestrator will continue with the remaining modules.",
  };
}

export function routeForStep(step, { repairScope = null, moduleCorrectionScope = null } = {}) {
  const kind = String(step || "").startsWith("increment:") ? "increment" : String(step || "");
  const routed = STEP_ROUTING[kind] || STEP_ROUTING.core;
  const correctionKind = repairScope?.kind || moduleCorrectionScope?.kind || null;
  if (kind === "correction" && ["structural_modularity", "runtime_dependency", "compile"].includes(correctionKind)) {
    return { ...routed, reasoningEffort: "medium" };
  }
  return routed;
}

/**
 * Conservative prompt-token estimate without the previous one-byte-equals-one-token bug.
 * The actual unescaped values are budgeted at one token per three UTF-8 bytes, followed by a 20%
 * safety margin and fixed wire overhead. This is intentionally more conservative than the usual
 * four-characters-per-token approximation without counting JSON escape bytes as model tokens.
 * This remains deliberately above observed Responses usage while avoiding a 3-4x false hold for
 * large retrieval prompts.
 */
export function estimatePromptTokens(options) {
  // Count the values sent over the wire, not JSON escape bytes. JSON.stringify turns every source
  // newline into two characters and was the remaining source of the live repair's false hold.
  const wire = [
    String(options?.systemPrompt || ""),
    ...(options?.messages || []).flatMap((message) => [
      String(message?.role || ""),
      typeof message?.content === "string" ? message.content : JSON.stringify(message?.content || ""),
    ]),
    JSON.stringify(options?.tools || []),
  ].join("\n");
  return Math.ceil((Buffer.byteLength(wire, "utf8") / 3) * 1.2) + 512;
}

export function conservativeCallReservation(options, model, {
  maxOutputTokens = 16_000, minimumCredits = 0, inputTokens = null,
} = {}) {
  const hasExplicitInput = inputTokens !== null && inputTokens !== undefined && inputTokens !== "";
  const inputUpper = hasExplicitInput && Number.isFinite(Number(inputTokens)) && Number(inputTokens) >= 0
    ? Math.ceil(Number(inputTokens)) : estimatePromptTokens(options);
  const calculated = creditsForUsage({
    usage: { input: inputUpper, cached: 0, output: maxOutputTokens, total: inputUpper + maxOutputTokens },
    model,
  });
  return Math.ceil(Math.max(calculated, Number(minimumCredits || 0)) * 10_000) / 10_000;
}

/**
 * Size a targeted repair response from its known retrieval/patch scope. This is deliberately a
 * simple envelope, not a second router: enough room for a useful structured patch batch, without
 * reserving the step's 10k emergency maximum for every one-file correction.
 */
export function repairOutputEnvelope({
  requestedMaxOutputTokens = 10_000,
  retrievedFileCount = 1,
  retrievalTokens = 0,
  problemCount = 1,
  expectedPatchTokens = null,
} = {}) {
  const requested = Math.max(1, Math.floor(Number(requestedMaxOutputTokens || 0)));
  const files = Math.max(1, Math.min(8, Math.floor(Number(retrievedFileCount || 1))));
  const context = Math.max(0, Number(retrievalTokens || 0));
  const problems = Math.max(1, Math.min(12, Math.floor(Number(problemCount || 1))));
  const expected = Number.isFinite(Number(expectedPatchTokens)) && Number(expectedPatchTokens) > 0
    ? Number(expectedPatchTokens)
    : 900 + (files * 700) + (problems * 160);
  const minimumUsefulOutputTokens = Math.min(requested, Math.max(1_200, 700 + (files * 250)));
  const contextAllowance = Math.min(1_500, Math.ceil(context * 0.12));
  const plannedOutputTokens = Math.min(requested, Math.max(
    minimumUsefulOutputTokens,
    Math.ceil((expected + contextAllowance) / 100) * 100,
  ));
  return {
    requestedMaxOutputTokens: requested,
    plannedOutputTokens,
    minimumUsefulOutputTokens,
    retrievedFileCount: files,
    retrievalTokens: context,
    problemCount: problems,
    expectedPatchTokens: Math.ceil(expected),
  };
}

/**
 * Fit a provider call into both its per-call limit and the live build headroom. A repair's nominal
 * allowance informs policy/evidence but is not another hard ceiling; its retrieved scope sizes the
 * output envelope. Reducing maxOutputTokens makes the reservation a real upper bound rather than
 * an optimistic estimate. The durable reserve RPC is still the final concurrency guard.
 */
export function planCallReservation(options, model, {
  requestedMaxOutputTokens = 16_000,
  minimumCredits = 0,
  callCeilingCredits,
  repairAllowanceCredits = null,
  repairSizing = null,
  fundingPolicy = "request_owner",
  budget,
} = {}) {
  const remaining = Number(budget?.remainingCredits || 0);
  const perCall = Number(callCeilingCredits || 0);
  const allowance = repairAllowanceCredits == null ? Infinity : Number(repairAllowanceCredits);
  // The configured per-call ceiling and live whole-build headroom are hard limits. The historical
  // repair allowance is a sizing target only: treating it as another ceiling stranded approved
  // build headroom and blocked a bounded repair before dispatch.
  const creditLimit = Math.min(remaining, perCall);
  const limitingCode = perCall <= remaining ? "step_budget_ceiling" : "budget_ceiling";
  if (!(creditLimit > 0) || creditLimit + 1e-9 < Number(minimumCredits || 0)) {
    throw Object.assign(new Error("Builder V2 model call has insufficient approved build headroom"), {
      code: limitingCode, retryable: false, dispatchState: "before_dispatch",
      remaining, callCeiling: perCall, repairAllowance: Number.isFinite(allowance) ? allowance : null,
      minimumCredits: Number(minimumCredits || 0),
    });
  }
  const sizing = repairSizing ? repairOutputEnvelope({
    requestedMaxOutputTokens,
    ...repairSizing,
  }) : null;
  const requested = sizing?.plannedOutputTokens
    ?? Math.max(0, Math.floor(Number(requestedMaxOutputTokens || 0)));
  const minimumUsefulOutputTokens = sizing?.minimumUsefulOutputTokens || 1;
  const estimatedInputTokens = estimatePromptTokens(options);
  let low = 0;
  let high = requested;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const estimate = conservativeCallReservation(options, model, {
      maxOutputTokens: middle, minimumCredits, inputTokens: estimatedInputTokens,
    });
    if (estimate <= creditLimit + 1e-9) low = middle;
    else high = middle - 1;
  }
  const reservedCredits = conservativeCallReservation(options, model, {
    maxOutputTokens: low, minimumCredits, inputTokens: estimatedInputTokens,
  });
  if (reservedCredits > creditLimit + 1e-9 || low < minimumUsefulOutputTokens) {
    throw Object.assign(new Error("Builder V2 call cannot fit a useful response inside approved headroom"), {
      code: limitingCode, retryable: false, dispatchState: "before_dispatch",
      remaining, callCeiling: perCall, repairAllowance: Number.isFinite(allowance) ? allowance : null,
      minimumCredits: Number(minimumCredits || 0), minimumUsefulOutputTokens,
      maximumFittingOutputTokens: low, estimatedInputTokens,
    });
  }
  return {
    reservedCredits,
    maxOutputTokens: low,
    approvedCeilingCredits: Number(budget.approvedCeilingCredits),
    consumedCredits: Number(budget.consumedCredits || 0),
    alreadyReservedCredits: Number(budget.reservedCredits || 0),
    remainingCredits: remaining,
    repairAllowanceCredits: Number.isFinite(allowance) ? allowance : null,
    callCeilingCredits: perCall,
    effectiveCallCeilingCredits: creditLimit,
    estimatedInputTokens,
    outputEnvelope: sizing,
    pricingAssumption: "uncached_input_upper_bound",
    fundingPolicy,
  };
}

export function createModelLanes({
  provider, providerForStep = null, ceilingCredits, diag = null, log = () => {},
  bucket = jobUsageBucket(), knowledgeStore = null, reservations = null,
  billingLane = "connected_allowance", recordRetrieval = null, accountCreditResolver = null,
  strictKnowledge = false,
  maxOutputTokens = 16_000,
  maxRepairs = 2,
  maxCorrections = 2,
  defaultUsageResponsibility = "customer_request",
}) {
  if ((!provider && !providerForStep) || !ceilingCredits) throw new Error("model lanes need a provider and a ceiling");
  const legacyGuard = reservations ? null : managedUsageGuard(Number(ceilingCredits), provider.model, bucket);
  let callSequence = 0;
  const choose = async (step, context) => {
    const selected = providerForStep ? await providerForStep({ step, ...context }) : { provider, decision: null };
    const selectedProvider = selected?.provider?.runTurn ? selected.provider : selected;
    if (!selectedProvider?.runTurn || !selectedProvider.model) throw new Error(`no executable provider for Builder V2 step ${step}`);
    return { provider: selectedProvider, decision: selected?.decision || null };
  };
  const requestIds = (usage, extras = []) => [...new Set([
    ...(Array.isArray(usage?.providerRequestIds) ? usage.providerRequestIds : []),
    usage?.providerRequestId, ...extras,
  ].filter(Boolean).map(String))].sort();
  const reservedProvider = async (step, context) => {
    const selected = await choose(step, context);
    if (!reservations) return selected;
    return {
      ...selected,
      provider: {
        ...selected.provider,
        runTurn: async (options) => {
          // Each network dispatch gets its own durable identity. A transport retry is a real
          // second provider attempt and must never reuse/overwrite the first attempt's usage.
          const sequence = ++callSequence;
          const selectedMaxOutputTokens = Number(selected.decision?.maxOutputTokens || maxOutputTokens);
          const callCeiling = Number(selected.decision?.callCeilingCredits || ceilingCredits);
          const budget = reservations.budget
            ? await reservations.budget(context.owner, context.buildId, Number(ceilingCredits))
            : {
              approvedCeilingCredits: Number(ceilingCredits), consumedCredits: 0,
              reservedCredits: 0, remainingCredits: Number(ceilingCredits),
            };
          const scopedDispatch = SCOPED_STEPS.has(step) || context.scopedDispatch === true;
          const plan = planCallReservation(options, selected.provider.model, {
            requestedMaxOutputTokens: selectedMaxOutputTokens,
            // A route estimate is not a mandatory hold. Repair usefulness is enforced by its
            // minimum output envelope; the durable whole-build ceiling remains authoritative.
            minimumCredits: scopedDispatch ? 0 : selected.decision?.estimatedCredits || 0,
            callCeilingCredits: callCeiling,
            repairAllowanceCredits: selected.decision?.repairAllowanceCredits,
            repairSizing: scopedDispatch ? {
              retrievedFileCount: Number(context.affectedModules || 1),
              retrievalTokens: Number(context.retrievalTokens || 0),
              problemCount: Array.isArray(context.problems) ? context.problems.length : 1,
              expectedPatchTokens: Number(context.expectedPatchTokens || 0) || null,
            } : null,
            fundingPolicy: selected.decision?.fundingPolicy || "request_owner",
            budget,
          });
          // One logical repair/correction may be split into several bounded model calls. The
          // first useful call consumes its ordinary dispatch slot; later batches retain the same
          // funding/routing identity but are explicit continuations. Every batch still settles
          // against the same whole-build ceiling.
          const reservationStep = Number(context.headroomBatchIndex || 0) > 0
            ? `${step}:headroom` : step;
          const callKey = modelCallKey({ buildId: context.buildId, step: reservationStep, sequence });
          const usageResponsibility = ["qualification", "platform_failure"].includes(defaultUsageResponsibility)
            ? defaultUsageResponsibility
            : ["repair", "correction"].includes(step) ? "thrallo_repair" : defaultUsageResponsibility;
          let accountBalance = (selected.decision?.billingLane || billingLane) === "managed"
            && usageResponsibility === "customer_request"
            ? await accountCreditResolver?.(context.owner) : null;
          const reservationInput = () => ({
            owner: context.owner, projectId: context.projectId, buildId: context.buildId,
            callKey, step: reservationStep,
            provider: selected.provider.provider || selected.provider.providerId || selected.decision?.provider || selected.provider.model,
            model: selected.provider.model, billingLane: selected.decision?.billingLane || billingLane,
            reservedCredits: plan.reservedCredits, ceilingCredits: Number(ceilingCredits),
            accountBalance,
            usageResponsibility,
            maxRepairs, maxCorrections,
            metadata: {
              routing: selected.decision || null, taskClass: selected.decision?.taskClass || "generated_app", sequence,
              logicalStep: step, headroomBatchIndex: Number(context.headroomBatchIndex || 0),
              budgetPlan: plan, fundingPolicy: plan.fundingPolicy,
            },
          });
          let hold;
          try {
            hold = await reservations.reserve(reservationInput());
          } catch (error) {
            const customerManaged = (selected.decision?.billingLane || billingLane) === "managed"
              && usageResponsibility === "customer_request";
            if (error.code !== "allowance_snapshot_stale" || !customerManaged) throw error;
            accountBalance = await accountCreditResolver?.(context.owner);
            hold = await reservations.reserve(reservationInput());
          }
          assertModelDispatchAcquired(hold);
          let turn;
          try {
            turn = await selected.provider.runTurn.call(selected.provider, {
              ...options, signal: context.signal || options.signal, maxOutputTokens: plan.maxOutputTokens,
              // V2 owns retries outside transports so every network dispatch receives its own
              // reservation and telemetry identity. Provider-internal retries would be invisible.
              maxProviderRetries: 0,
              allowParameterRetry: false,
            });
          } catch (error) {
            const usage = error?.usage || {};
            const failure = classifyProviderFailure(error);
            const actualCredits = creditsForUsage({ usage, model: selected.provider.model });
            try {
              if (failure.hasUsage) {
                await reservations.settle(context.owner, hold.id, {
                  actualCredits, usage, providerRequestIds: requestIds(usage, [error?.providerRequestId]),
                });
              } else if (failure.state === "before_dispatch" || failure.state === "provider_rejected") {
                await reservations.release(context.owner, hold.id);
              } else {
                await reservations.markAmbiguous(context.owner, hold.id, {
                  reason: error?.message || "provider dispatch ambiguous",
                  providerRequestIds: requestIds(usage, [error?.providerRequestId]),
                });
              }
            } catch (settlementError) {
              const providerRequestIds = requestIds(usage, [error?.providerRequestId]);
              const accountingError = Object.assign(new AggregateError(
                [error, settlementError],
                `Provider call failed and its usage could not be settled: ${settlementError.message}`,
              ), { code: "billing_settlement_failed", providerError: error });
              try {
                await reservations.markAmbiguous(context.owner, hold.id, {
                  reason: accountingError.message,
                  providerRequestIds,
                });
              } catch (reconciliationError) {
                accountingError.reconciliationError = reconciliationError;
              }
              throw replayUnsafe(accountingError, {
                reservationId: hold.id,
                providerRequestId: providerRequestIds[0] || null,
              });
            }
            if (failure.state === "before_dispatch" || failure.state === "provider_rejected") throw error;
            throw replayUnsafe(error, { reservationId: hold.id, providerRequestId: error?.providerRequestId || null });
          }
          // Settlement is part of successful dispatch. If its acknowledgement fails, stop here;
          // do not reinterpret that database failure as a provider failure or invoke settlement a
          // second time with empty telemetry. The reservation remains the reconciliation authority.
          const actualCredits = creditsForUsage({ usage: turn.usage || {}, model: selected.provider.model });
          const providerRequestIds = requestIds(turn.usage);
          try {
            await reservations.settle(context.owner, hold.id, {
              actualCredits, usage: turn.usage || {}, providerRequestIds,
            });
          } catch (error) {
            try {
              await reservations.markAmbiguous(context.owner, hold.id, {
                reason: `provider completed but settlement failed: ${error?.message || "unknown error"}`,
                providerRequestIds,
              });
            } catch (reconciliationError) {
              error.reconciliationError = reconciliationError;
            }
            throw replayUnsafe(error, {
              reservationId: hold.id,
              providerRequestId: providerRequestIds[0] || null,
            });
          }
          return turn;
        },
      },
    };
  };
  const accountUsage = async (usage) => {
    if (legacyGuard) return legacyGuard(usage);
    bucket.add({ ...usage, turns: 1 });
  };
  // WP-12 trace hierarchy: root = the diag run (the build); every model call is a child
  // span named by its pipeline step. Verification spans join from the runners.
  const record = async (step, { label, prompt, output, usage, durationMs, providerUsed, decision = null }) => {
    diag?.step({
      agent: "BuilderV2", kind: "agent", label: `${step}: ${label}`, status: "info",
      prompt, output, usage, model: providerUsed?.model || provider?.model, durationMs,
      contextMeta: decision ? { routing: decision } : null,
      trace: { traceId: diag?.id || null, parentId: diag?.id || null, step },
    });
    await diag?.flush?.();
  };
  const loadKnowledge = async (owner, projectId) => {
    if (!owner || !projectId) return "PROJECT KNOWLEDGE: not loaded for this request.";
    const facts = await getKnowledge(owner, projectId, {
      ...(knowledgeStore ? { store: knowledgeStore } : {}), failClosed: strictKnowledge,
    });
    return knowledgeBrief(facts);
  };

  return {
    bucket,

    contractFn: async ({ owner, projectId, buildId, request, signal = null }) => {
      const startedAt = Date.now();
      const before = bucket.summary();
      const projectKnowledge = await loadKnowledge(owner, projectId);
      const contractRequest = `${projectKnowledge}\n\nUSER REQUEST:\n${request}`;
      const selected = await reservedProvider("contract", {
        owner, projectId, buildId, request, signal,
        taskClass: "contract",
        retrievalTokens: Math.ceil(Buffer.byteLength(projectKnowledge, "utf8") / 4),
        affectedModules: 1,
      });
      let outcome;
      try {
        outcome = await generateContract({ provider: selected.provider, prompt: contractRequest, log, onUsage: accountUsage });
      } finally {
        // Exact spend for THIS call = the shared bucket's delta (generateContract's own
        // `usage` reports only its last attempt). Recorded even when the guard throws —
        // paid work always reaches the diagnostics.
        const after = bucket.summary();
        const delta = Object.fromEntries(Object.keys(totalUsageShape(after))
          .map((k) => [k, Number(after[k] || 0) - Number(before[k] || 0)]));
        delta.providerRequestIds = (after.providerRequestIds || [])
          .filter((id) => !(before.providerRequestIds || []).includes(id));
        await record("contract", {
          label: outcome?.degraded ? "implementation contract (degraded)" : "implementation contract",
          prompt: contractRequest, output: outcome ? JSON.stringify(outcome.contract) : null,
          usage: delta, durationMs: Date.now() - startedAt, providerUsed: selected.provider,
          decision: selected.decision,
        });
      }
      if (!outcome.contract) throw new Error(`contract generation failed: ${(outcome.problems || []).join("; ")}`);
      return outcome.contract;
    },

    patchesFn: async ({ owner, projectId, buildId, step, originalStep, contract, tiers, tree, journey, rejections, problems, editRequest,
      modulePlan = [], moduleContracts = null, repairScope = null, moduleCorrectionScope = null,
      headroomScope: requestedHeadroomScope = null, advisory = [], signal = null }) => {
      const projectKnowledge = repairScope || moduleCorrectionScope || requestedHeadroomScope
        ? null : await loadKnowledge(owner, projectId);
      const fullSystemPrompt = `${PATCH_SYSTEM_PROMPT}\n\nAVAILABLE CAPABILITIES (import, never rewrite):\n${capabilityBrief()}`;
      let systemPrompt = fullSystemPrompt;
      const startedAt = Date.now();
      let headroomScope = requestedHeadroomScope;
      let headroomResizes = 0;
      const dispatchProblems = step === "repair" ? causalRepairProblems(contract, problems) : problems;
      const semanticRepairFiles = step === "repair" && !repairScope && !moduleCorrectionScope
        ? repairFailureOwnedPaths(contract, dispatchProblems) : [];
      let prompt = null;
      let selected = null;
      let turn = null;
      // ONE retry on transport-shaped failures: a dropped SSE stream ("terminated") killed
      // a live booking attempt 24 minutes in. Model/tool errors never retry — only the wire.
      const callOnce = () => selected.provider.runTurn({
        systemPrompt,
        messages: [{ role: "user", content: prompt }],
        tools: [EMIT_PATCHES_SCHEMA],
        toolChoice: { type: "function", name: EMIT_PATCHES_SCHEMA.name },
        // The first live run produced an 82-token no-op with zero reasoning; a forced tool
        // call still needs thinking room — how much is the per-step routing table's call.
        reasoningEffort: routeForStep(step, {
          repairScope, moduleCorrectionScope: headroomScope || moduleCorrectionScope,
        }).reasoningEffort,
      });
      const dispatchWithHeadroom = async () => {
        for (;;) {
          let retrievalTrace = null;
          systemPrompt = headroomScope?.fragmented ? HEADROOM_FRAGMENT_SYSTEM_PROMPT : fullSystemPrompt;
          prompt = renderPatchPrompt({
            step, originalStep, contract, tiers, tree, journey, rejections, problems: dispatchProblems, editRequest,
            projectKnowledge: headroomScope ? null : projectKnowledge, modulePlan, moduleContracts,
            repairScope, moduleCorrectionScope, headroomScope, advisory,
            onRetrieval: (trace) => { retrievalTrace = trace; },
          });
          if (retrievalTrace && recordRetrieval) {
            await recordRetrieval({ owner, projectId, buildId,
              step: headroomScope ? `${step}:headroom:${headroomResizes}` : step, ...retrievalTrace });
          }
          const scopedFiles = headroomScope?.allowedFiles || [];
          selected = await reservedProvider(step, {
            owner, projectId, buildId, contract, tree, problems: dispatchProblems, editRequest, signal,
            taskClass: `${String(step).startsWith("increment:") ? "increment" : step}`,
            retrievalTokens: Number(retrievalTrace?.tokens || 0),
            affectedModules: Math.max(1, scopedFiles.length || new Set([
              ...(retrievalTrace?.included || []).map((entry) => entry.path).filter(Boolean),
              ...Object.keys(tree || {}).filter((path) => (problems || []).some((problem) => String(problem).includes(path))),
            ]).size),
            expectedPatchTokens: headroomScope?.expectedPatchTokens
              || repairScope?.expectedPatchTokens || moduleCorrectionScope?.expectedPatchTokens || null,
            scopedDispatch: !!(headroomScope || repairScope || moduleCorrectionScope),
            headroomBatchIndex: Number(headroomScope?.batchIndex || 0),
          });
          try {
            return await callOnce();
          } catch (error) {
            if (!isHeadroomFitError(error)) throw error;
            const nextScope = headroomDispatchScope({
              tree, modulePlan, moduleContracts, repairScope, moduleCorrectionScope,
              problems: dispatchProblems, rejections, previousScope: headroomScope, logicalStep: step,
              semanticFiles: semanticRepairFiles,
            });
            if (!nextScope) {
              // A raw call with no model/module boundary is not safely splittable. Preserve its
              // canonical planner error; only a scope that was actually narrowed may be reported
              // as an irreducible smallest continuation.
              if (!headroomScope && headroomResizes === 0) throw error;
              throw Object.assign(error, {
                code: "smallest_scoped_call_exceeds_headroom",
                publicMessage: "The remaining approved budget cannot fit the smallest safe Builder V2 continuation.",
                headroomResizes,
              });
            }
            headroomScope = nextScope;
            headroomResizes += 1;
            log(`${step}: approved ceiling is intact, but this single prompt exceeds its per-call envelope `
              + `(estimated input ${Number(error.estimatedInputTokens || 0)} tokens, maximum fitting output `
              + `${Number(error.maximumFittingOutputTokens || 0)} tokens); `
              + `continuing internally with ${nextScope.allowedFiles.length} module(s) `
              + `[${nextScope.allowedFiles.join(", ")}] (resize ${headroomResizes})`);
          }
        }
      };
      try {
        turn = await dispatchWithHeadroom();
      } catch (error) {
        if (error?.retrySafe !== true) throw error;
        log(`${step}: provider rejected before billable dispatch (${String(error.message).slice(0, 60)}) — one retry`);
        await new Promise((r) => setTimeout(r, 2_000));
        turn = await dispatchWithHeadroom();
      }
      const call = (turn.toolCalls || []).find((c) => c.name === EMIT_PATCHES_SCHEMA.name);
      // Record BEFORE the guard can throw — the ceiling stopping a build never hides spend.
      await record(step, {
        label: `patches (${call?.arguments?.patches?.length ?? 0})`,
        prompt, output: call ? JSON.stringify(call.arguments) : turn.text,
        usage: { ...turn.usage, turns: 1 }, durationMs: Date.now() - startedAt,
        providerUsed: selected.provider, decision: selected.decision,
      });
      await accountUsage(turn.usage || {});
      if (!call || !Array.isArray(call.arguments?.patches)) {
        throw new Error(`the model did not call emit_patches at step ${step}: ${String(turn.text).slice(0, 300)}`);
      }
      if (headroomScope) {
        Object.defineProperty(call.arguments.patches, "dispatchScope", {
          value: headroomScope, enumerable: false, configurable: false,
        });
      }
      return call.arguments.patches;
    },
  };
}

/** Final provider boundary: only the process that atomically acquired this durable hold may call. */
export function assertModelDispatchAcquired(hold) {
  if (hold?.acquired === false) {
    throw Object.assign(new Error("Builder V2 refused a replayed provider dispatch"), {
      code: "provider_replay_unsafe", reservationId: hold.id,
    });
  }
  return hold;
}

function totalUsageShape(usage) {
  return Object.fromEntries(Object.entries(usage || {}).filter(([, value]) => typeof value === "number"));
}
