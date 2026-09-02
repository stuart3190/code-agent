// The real model lanes behind the orchestrator's two seams (finish plan WP-9; master plan
// Parts 4 and 10). One shared usage bucket + one managedUsageGuard cover EVERY call in a
// build — contract and patches alike — so the job ceiling is a property of the build, not
// of any single call. All spend lands in the canonical diagnostics tables via diag.step
// (creditsForUsage is the ONE pricing function; nothing here invents a second).

import { generateContract } from "../appBuild/contractAgent.mjs";
import { contractBrief } from "../../../shared/implementationContract.mjs";
import { managedUsageGuard } from "../buildJobs.mjs";
import { expectationKeywords } from "../appBuild/journeyVerifier.mjs";
import {
  FILE_MAX_TOKENS, MAX_JOURNEYS_PER_FILE, MULTI_JOURNEY_MIN_TOKENS,
} from "../appBuild/modularity.mjs";
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
import { fundingPoolFor, modelCallKey } from "./modelReservations.mjs";
import { FUNDING_POOL } from "./buildEnvelope.mjs";
import { classifyProviderFailure, replayUnsafe } from "../providerOutcome.mjs";
import { assemblyNeeds, interactionContractBrief, scopeInteractionContract } from "./interactionContract.mjs";
import {
  expectedMissingModuleTokens, moduleGenerationContractsBrief, moduleGenerationContractsRepairBrief,
} from "./moduleContracts.mjs";
import { capabilityCompositionBrief } from "./capabilityComposer.mjs";
import { scopeCapabilityGraph } from "./capabilityGraph.mjs";
import { dependencyPlanBrief, scopeDependencyPlan } from "./dependencyPlan.mjs";
import { journeySurfaceBrief, journeySurfaceContext } from "./surfaceIntegration.mjs";
import { scopeScaffoldGraph } from "./scaffoldGraph.mjs";
import { scaffoldCompositionBrief } from "./scaffoldComposer.mjs";

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
  old source excerpt inside a large symbol. For replace_exact, the symbol field is the COMPLETE literal
  old code block, never a function/component name. replaceFile is for index-opaque files.
- Every contracted route is ALREADY mounted to a model-owned screen listed in the scaffold graph.
  Implement those existing screen slots (normally src/screens/scaffold/*.jsx). Never edit src/App.jsx,
  create a competing router, or leave contracted work in an unmounted component.
- src/App.jsx, src/lib/backend/, src/lib/visitorSession.js, src/lib/capabilities/ and
  src/lib/scaffolds/composed/ are protected platform
  infrastructure: IMPORT them, never modify or reimplement them. Persistence goes through the
  capabilities (src/lib/capabilities) — never localStorage. Every entity operation establishes
  and recovers this app's visitor session automatically, so use the normal capability/entity
  APIs and do NOT call ensureVisitorSession() yourself. A capability-OWNED entity (contact
  messages, newsletter signups, bookings, …) must still go through its owning capability
  (submitContact / subscribe / createBooking): a raw db.entity(...) write to one bypasses that
  capability's validation and is rejected.
- Every protected session export is asynchronous, including currentUser(). Await session calls in
  an effect or event handler; never store or branch on an unresolved Promise as authentication state.
- Imagery: import { ASSETS } from "./lib/assetData.js" (adjust the relative path) and render
  with the helpers in src/lib/assets.js (imageProps / pictureSources / isPlaceholder /
  placeholderStyle). Never hardcode an image URL and never invent one. When ASSET_CREDITS
  contains Pexels assets, render a visible footer link to Pexels and link each available
  photographer name to that asset's photoUrl.
- Every user-visible outcome named in the journeys must appear as real, reachable UI text.
- A declared operation has one stable machine action identity across every assigned journey. When
  multiple journeys exercise the same operation, reuse one existing action control and preserve
  its machine identity; never replace it with a journey-specific action identity or duplicate it.
  With useSemanticAction, set name to the operationId and label to the journey-facing accessible
  copy. A literal data-thrallo-action must equal the supplied control.machineId.
- A contracted control's verificationValue is the authoritative non-secret synthetic browser
  fixture for its domain rule. Configure sample data and validation so that exact value has the
  valid/invalid meaning stated by the journey. A selectable card/button/radio option must expose
  that exact domain value through its native value attribute (for example value={item.id}); visible
  title copy alone is not a machine-readable option value. Do not replace the fixture with a
  different hidden answer, and do not merely echo it as static copy.
- Custom-extension calls must select the operation with a literal second-argument context such as
  { operation: "<operationId>" } and pass that operation's declared input keys explicitly. The
  explicit legacy key operationId is also supported. Do not rely on spreading a domain object whose
  generic fields (for example id) may not match the extension contract. Declared runtime inputs are
  authoritative: collection add/remove/toggle operations must transform the passed collection using
  the passed identifier. Never reject that identifier against private module-local records unless
  those records are themselves a declared input, and never recreate a controller-owned domain
  collection independently inside an extension.
- Keep components small; compose unique screens and bounded helpers behind the mounted slots.
- When a mounted screen's module plan names a shared journey controller, render that controller
  exactly once. It owns the screen's contracted controls and interaction state. Do not mount a
  parallel per-journey copy of those controls in the screen or in another child component.
- BUILD THE WHOLE ASSIGNED DISPATCH SCOPE IN THIS ONE BATCH. A normal core step is several patches and several
  kilobytes of new JSX: new files for every section/page, real copy, real form state, and
  every assigned mounted screen/custom extension. A batch that re-emits existing content, leaves scaffold stubs
  in place, or only tweaks one line is rejected as a no-op and costs you a round.`;

export const COMPILE_CORRECTION_SYSTEM_PROMPT = `You repair a retained generated application that failed to compile.
Call emit_patches exactly once and change only the machine-enforced allowed files. Resolve the named
compiler error with the smallest source change while preserving all existing behavior, exports, routes,
labels, state, and interactions. Reconcile imports and exports across the supplied files when necessary.
Use newFile only for a named missing file. For an existing file use validated ops, replace_exact, or
replaceFile with its complete corrected content. Never edit protected infrastructure or unrelated files,
and do not emit prose outside emit_patches.`;

// When the ordinary bounded file prompt still cannot fit, the orchestrator supplies exact source
// excerpts and an exact-replacement primitive. This deliberately excludes broad architecture and
// capability prose: the retained tree supplies exact current bytes, the write boundary is
// machine-enforced, and deterministic compile/browser verification remains mandatory.
export const HEADROOM_FRAGMENT_SYSTEM_PROMPT = `You repair one bounded defect in an existing
React+Vite app. Respond only by calling emit_patches. Modify only the allowed file. Prefer
replace_exact: put the exact old excerpt in symbol and its complete replacement in content. The
old excerpt must occur exactly once and the resulting full file must parse. Preserve all unrelated
behaviour. Fix the real state transition: changing labels, messages, or static copy merely to echo
verifier keywords is not a repair. When a rendered branch hides the expected controls after the
action, change the handler/state/conditional data flow that keeps that branch active. Never modify
protected platform files, fake persistence, or weaken verification.`;

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
  // A SCOPE MAY NAME A MODULE THAT WAS PLANNED AND NEVER WRITTEN, and that is not a reason to kill
  // a build. This threw on `src/components/create-auto-layout/ControlColumn.jsx` after 30 of 60
  // credits: the module was in the plan, the model had never created it, and creating it was quite
  // possibly the repair being asked for. A missing file here costs one wasted instruction; throwing
  // costs the whole run and everything already verified in it.
  //
  // So the file is offered as a stub the model is told to create, for every scope kind. The list
  // below now only decides whether that substitution is EXPECTED or worth reporting as a surprise.
  const mayCreateMissing = ["module_contract", "runtime_dependency", "imports", "structural_modularity", "headroom_continuation"]
    .includes(repairScope?.kind);
  const missing = files.filter((path) => typeof tree?.[path] !== "string");
  if (missing.length) {
    if (!mayCreateMissing) {
      console.warn(`[builder-v2] ${repairScope?.kind || "repair"} scope names ${missing.length} module(s) `
        + `that do not exist yet; offering them as create-me stubs: ${missing.join(", ")}`);
    }
    tree = { ...tree };
    for (const path of missing) {
      tree[path] = "// REQUIRED PLANNED MODULE IS MISSING; create it with newFile";
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

function renderStructuralModularityPrompt({ tree, repairScope, onRetrieval = null }) {
  const files = [...new Set(repairScope?.files || repairScope?.allowedFiles || [])].sort();
  const prefixes = [...new Set(repairScope?.allowedPrefixes || [])].sort();
  const included = files.map((path) => ({
    path,
    form: "full",
    reason: "structural modularity requires the complete module",
    tokens: Math.ceil(String(tree?.[path] || "").length / 4),
  }));
  onRetrieval?.({
    query: { step: "repair", kind: "structural_modularity", files },
    included,
    omittedCount: Math.max(0, Object.keys(tree || {}).length - included.length),
    tokens: included.reduce((sum, row) => sum + row.tokens, 0),
  });
  return [
    "STEP: correction",
    "STRUCTURAL MODULARITY CORRECTION: the retained application is behaviorally intact, but the",
    "validator proved that the named module is structurally too broad. This correction is ONLY a",
    "source decomposition. Preserve every route, export, visible behavior, label, machine ID, state",
    "transition, capability/custom-extension call, and existing interaction.",
    "",
    repairScope?.instruction || "Split the named module into focused sibling modules.",
    `Validator findings: ${JSON.stringify(repairScope?.findings || [])}`,
    `Existing files that may be replaced: [${files.join(", ")}]`,
    `New supporting modules may be created only under: [${prefixes.join(", ")}]`,
    "",
    "REQUIRED PROGRESS:",
    `- The corrected tree must remove every named modularity finding. A file must stay at or below ${FILE_MAX_TOKENS} tokens.`,
    `- A file above ${MULTI_JOURNEY_MIN_TOKENS} tokens may not implement more than ${MAX_JOURNEYS_PER_FILE} journeys.`,
    "- Move existing data/constants, presentation sections, and focused child components into sibling",
    "  modules, then import and compose them from a smaller coordinator.",
    "- A handler-only, conditional-only, copy-only, or custom-extension call change is NOT structural",
    "  progress and will leave the validator finding unchanged.",
    "- Use replaceFile for each named existing module and newFile for its new siblings. Do not edit",
    "  unrelated files. Call emit_patches now.",
    "",
    "FILE TREE (paths only):",
    ...Object.keys(tree || {}).sort().map((path) => `  ${path}`),
    "",
    "STRUCTURALLY INVALID MODULES IN FULL:",
    ...files.flatMap((path) => ["", `--- ${path} ---`, String(tree?.[path] || "")]),
  ].join("\n");
}

const customExtensionFindings = (scope) => (scope?.findings || [])
  .filter((finding) => finding?.code === "custom_extension_invalid");

function renderCustomExtensionCorrectionPrompt({ tree, repairScope, onRetrieval = null }) {
  const files = [...new Set(repairScope?.files || repairScope?.allowedFiles || [])].sort();
  const findings = customExtensionFindings(repairScope);
  const included = files.map((path) => ({
    path,
    form: "full",
    reason: "all custom-extension call sites must be corrected together",
    tokens: Math.ceil(String(tree?.[path] || "").length / 4),
  }));
  onRetrieval?.({
    query: { step: "repair", kind: "custom_extension_invalid", files },
    included,
    omittedCount: Math.max(0, Object.keys(tree || {}).length - included.length),
    tokens: included.reduce((sum, row) => sum + row.tokens, 0),
  });
  return [
    "STEP: correction",
    "CUSTOM-EXTENSION CALL-SITE CORRECTION: the retained application is intact. Fix every validator",
    "finding below in this one bounded pass and preserve all unrelated behavior, copy, machine IDs,",
    "routes, exports, state transitions, and layout.",
    "",
    repairScope?.instruction || "Correct every named custom-extension call site.",
    `Validator findings: ${JSON.stringify(findings)}`,
    `Allowed existing files: [${files.join(", ")}]`,
    "",
    "REQUIRED PROGRESS:",
    "- Invoke each named custom-extension export directly at its operation call site. Do not hide the",
    "  export behind a runner variable, selected function, wrapper, spread, or generic input alias.",
    "- Pass an explicit object literal whose property names are the final semantic key of every",
    "  required/missing input named in that finding (for example, a path ending in searchQuery must",
    "  appear as searchQuery: <current value>).",
    "- Pass a literal context.operation or context.operationId from the finding's allowedOperations",
    "  at every direct call site. A variable shorthand such as { operation }, a function parameter,",
    "  or a computed selector is still invalid. Split a shared handler into literal operation branches",
    "  when necessary. Preserve an existing selector only when the finding proves it is already literal.",
    "- Repair ALL listed operations and exports, not only the first matching handler.",
    "- Emit one replaceFile with the complete corrected content for each named existing module.",
    "  Do not edit unrelated files. Call emit_patches now.",
    "",
    "FILE TREE (paths only):",
    ...Object.keys(tree || {}).sort().map((path) => `  ${path}`),
    "",
    "VALIDATOR-NAMED MODULES IN FULL:",
    ...files.flatMap((path) => ["", `--- ${path} ---`, String(tree?.[path] || "")]),
  ].join("\n");
}

export function renderCompileCorrectionPrompt({ tree, repairScope, problems = [], onRetrieval = null }) {
  const files = [...new Set(repairScope?.files || repairScope?.allowedFiles || [])].sort();
  const findings = [...new Set([
    ...(problems || []).map(String),
    ...(repairScope?.findings || []).map((finding) => String(finding?.message || finding)),
  ].filter(Boolean))].slice(0, 8);
  const context = renderPrecompileRepairContext(tree, {
    repairScope: { ...repairScope, files }, onRetrieval,
  });
  return [
    "STEP: correction",
    "COMPILE CORRECTION: the retained candidate is complete enough to compile. Fix only the exact",
    "compiler failure below, preserve every unrelated behavior, and leave all later gates intact.",
    "",
    repairScope?.instruction || "Correct the compiler failure in the named files.",
    `Allowed files: [${files.join(", ")}]`,
    "",
    "COMPILER FINDINGS:",
    ...findings.map((finding) => `- ${finding}`),
    "",
    "REQUIRED PROGRESS:",
    "- Resolve the named syntax, import, export, dependency, or type mismatch at its source.",
    "- When one supplied file imports a missing symbol from another supplied file, reconcile the",
    "  importer and exporter together; do not invent an unrelated replacement architecture.",
    "- Preserve all existing routes, visible behavior, state transitions, labels, and machine IDs.",
    "- Emit only the minimal allowed patch batch and call emit_patches now.",
    "",
    context,
  ].join("\n");
}

const wholeFileRepairRequired = (scope) => scope?.kind === "structural_modularity"
  || customExtensionFindings(scope).length > 0;

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

// A bounded continuation consumes the same authoritative graph as full generation, projected to
// the fields needed to implement its selected modules. Registry test contracts and the graph's
// repeated node/journey copies remain enforced after the patch; serializing those copies again
// can make the input alone exceed the unchanged per-call ceiling on a complex application.
function headroomCapabilityGraphBrief(graph) {
  if (!graph) return null;
  // The interaction and per-module contracts immediately below already carry every selected
  // operation's reads, writes, responsibility, state owner and persistence handoff. Repeating
  // those same build-wide semantic rows here made a three-journey shared controller consume the
  // entire per-call allowance before one useful output token could fit. A continuation needs the
  // protected runtime interface it may call; canonical full-graph validation still runs after
  // the patch and remains the authority for all omitted verifier-only relationships.
  return {
    version: graph.version,
    buildProfile: graph.buildProfile,
    nodes: (graph.nodes || []).map((node) => ({
      id: node.id,
      type: node.type,
      capabilityId: node.capabilityId,
      version: node.version,
      proven: node.proven,
      protected: node.protected,
      requiredOperations: node.requiredOperations || [],
      requiredInputs: node.type === "custom_behavior" ? node.requiredInputs || [] : undefined,
      outputs: node.type === "custom_behavior" ? node.outputs || [] : undefined,
      compositionModule: node.compositionModule || null,
      extension: node.extension || null,
    })),
    customBehavior: graph.customBehavior || [],
  };
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

function renderHeadroomFragmentPrompt({
  headroomScope, problems = [], rejections = [], regenerateFiles = [], onRetrieval = null,
}) {
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
        structured.selectionAttempt?.value !== undefined && structured.selectionAttempt?.value !== null
          ? `attemptedSelection=${JSON.stringify(structured.selectionAttempt)}` : null,
        structured.target ? `target=${structured.target}` : null,
      ].filter(Boolean).join("; ");
    }))].slice(0, 4);
  const rejected = [...new Set((rejections || []).map((rejection) => String(rejection?.reason || rejection))
    .filter(Boolean))].slice(0, 4);
  const escalated = [...new Set((regenerateFiles || []).filter((path) => (
    headroomScope?.allowedFiles?.includes(path)
  )))];
  return [
    "RETAINED CANDIDATE MICRO-REPAIR",
    "The full candidate is retained. Fix only the named transition below. Deterministic structure,",
    "compile, and all contracted browser journeys still gate promotion after this patch.",
    "Repair actual handler/state/conditional flow. Do not change copy merely to repeat expected words.",
    `Allowed file: ${headroomScope.allowedFiles[0]}`,
    "Failure evidence:",
    ...failures.map((failure) => `- ${failure}`),
    ...(rejected.length ? [
      "",
      "PREVIOUS EXACT-SOURCE PATCH REJECTIONS (authoritative):",
      ...rejected.map((rejection) => `- ${rejection}`),
      "Emit a substantively corrected replacement. Do not repeat the rejected operation or",
      "introduce an identifier that is not already bound in the supplied source excerpt unless",
      "its binding is also declared inside the complete replacement.",
    ] : []),
    ...(escalated.length ? [
      "",
      "REPEATED-REJECTION ESCALATION:",
      ...escalated.map((path) => `- ${path}`),
      "The complete file cannot fit this bounded correction envelope, so whole-file replacement",
      "has been narrowed to its exact causal fragment. Address every rejection above in one",
      "different replace_exact operation; the full retained file will be parsed and gated after it lands.",
    ] : []),
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

function renderHeadroomScreenMountPrompt({
  headroomScope, screenModules, tree, rejections = [], regenerateFiles = [], onRetrieval = null,
}) {
  const files = screenModules.map((module) => module.path);
  const controllers = [...new Set(screenModules.map((module) => module.journeyController).filter(Boolean))];
  const sourceContext = renderPrecompileRepairContext(tree, {
    repairScope: { ...headroomScope, files, adapterInterfaces: controllers },
    onRetrieval,
  });
  const parts = [
    "STEP: core",
    "HEADROOM-SCOPED SCAFFOLD MOUNT: the protected router already mounts each named model-owned",
    "screen, and each screen's journey controller is already implemented in the retained candidate.",
    "Complete only the thin mounted wrapper; do not reimplement or duplicate the controller's",
    "journey controls, state, data, capabilities, or custom behavior in the screen.",
    "",
    "MOUNT CONTRACT (machine-enforced JSON):",
    JSON.stringify({ modules: screenModules.map((module) => ({
      path: module.path,
      routePath: module.routePath || null,
      journeyController: module.journeyController,
      requiredImports: [...new Set(module.requiredImports || [])],
      requiredExports: module.requiredExports || ["default"],
    })) }, null, 2),
    "For each module: import its existing journeyController through the relative path shown by",
    "requiredImports, render that controller exactly once, and retain the screen's default export.",
    "Do not add another router, another application shell, or a second implementation of any flow.",
    "",
    "INTERNAL HEADROOM-SCOPED WRITE BOUNDARY (machine-enforced):",
    `Allowed files: [${files.join(", ")}]`,
    "",
    sourceContext,
  ];
  if (rejections.length) {
    parts.push("", "PREVIOUS PATCH REJECTIONS (emit only corrected unfinished work):",
      ...rejections.map((rejection) => `- ${rejection.reason}`));
  }
  if (regenerateFiles.length) {
    parts.push("", "WHOLE-FILE ESCALATION:", ...regenerateFiles.map((file) => `- ${file}`),
      "Emit one complete replaceFile for each listed existing screen; preserve its mount contract.");
  }
  parts.push("", "Call emit_patches now with the complete bounded screen-wrapper batch.");
  return parts.join("\n");
}

export function renderPatchPrompt({
  step, originalStep = step, contract, tiers, tree, journey, rejections = [], problems = [], editRequest = null,
  projectKnowledge = null, onRetrieval = null, modulePlan = [], moduleContracts = null,
  repairScope = null, moduleCorrectionScope = null, headroomScope = null, repairBoundary = null,
  regenerateFiles = [], advisory = [],
  capabilityGraph = contract?.capabilityGraph || null, compositionPlan = null,
  scaffoldGraph = contract?.scaffoldGraph || null, scaffoldPlan = null,
}) {
  if (repairScope?.kind === "structural_modularity") {
    return renderStructuralModularityPrompt({ tree, repairScope, onRetrieval });
  }
  if (customExtensionFindings(repairScope).length) {
    return renderCustomExtensionCorrectionPrompt({ tree, repairScope, onRetrieval });
  }
  if (headroomScope?.fragmented) {
    return renderHeadroomFragmentPrompt({
      headroomScope, problems, rejections, regenerateFiles, onRetrieval,
    });
  }
  const compileScope = [headroomScope, repairScope, moduleCorrectionScope]
    .find((scope) => scope?.kind === "compile" || scope?.sourceKind === "compile");
  if (compileScope) {
    return renderCompileCorrectionPrompt({ tree, repairScope: compileScope, problems, onRetrieval });
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
  const headroomScreenMounts = headroomScope && activeScopePaths.length
    ? promptModulePlan.filter((module) => module.providedBy === "scaffold_screen_slot"
      && module.journeyController
      && typeof tree?.[module.journeyController] === "string"
      && /data-scaffold-slot=/.test(String(tree?.[module.path] || ""))
      && String(tree?.[module.path] || "").includes("Application screen ready for composition."))
    : [];
  if (headroomScope && activeScopePaths.length > 0
    && headroomScreenMounts.length === activeScopePaths.length) {
    return renderHeadroomScreenMountPrompt({
      headroomScope, screenModules: headroomScreenMounts, tree, rejections, regenerateFiles, onRetrieval,
    });
  }
  const contractJourneyIds = new Set((contract?.journeys || []).map((row) => row?.id).filter(Boolean));
  const headroomJourneyIds = headroomScope && activeScopePaths.length ? (() => {
    const selectedContracts = (headroomScope.moduleContracts?.specifications?.length
      ? headroomScope.moduleContracts.specifications
      : (moduleContracts?.specifications || []).filter((specification) => (
        activeScopePaths.includes(specification.path)
      )));
    const selectedIds = new Set([
      ...promptModulePlan.flatMap((module) => module.journeyIds || module.ownedJourneys || []),
      ...selectedContracts.flatMap((specification) => specification.ownedJourneys || []),
      ...selectedContracts.flatMap((specification) => (specification.semanticInteractions || [])
        .map((interaction) => interaction.journeyId)),
      ...selectedContracts.flatMap((specification) => (specification.requiredCapabilities || [])
        .flatMap((capability) => (capability.methods || [])
          .flatMap((method) => method.reachableFromJourneys || []))),
    ].filter((id) => contractJourneyIds.has(id)));
    const statePaths = selectedContracts.flatMap((specification) => [
      ...(specification.state?.mayConsume || []),
      ...(specification.state?.mustProduce || []),
      ...(specification.downstream?.consumes || []),
      ...(specification.downstream?.produces || []),
    ]);
    for (const journeyId of contractJourneyIds) {
      if (statePaths.some((path) => String(path).startsWith(`${journeyId}.`))) selectedIds.add(journeyId);
    }
    const downstreamInteractionIds = new Set(selectedContracts
      .flatMap((specification) => specification.downstream?.consumers || []));
    for (const flow of contract?.interactionContract?.flows || []) {
      if (downstreamInteractionIds.has(flow.id) && contractJourneyIds.has(flow.journeyId)) {
        selectedIds.add(flow.journeyId);
      }
    }
    return selectedIds;
  })() : null;
  const browserRepair = step === "repair" && !repairScope && !moduleCorrectionScope;
  const repairFailures = browserRepair ? repairFailureReferences(problems) : [];
  const failedJourneyIds = new Set(repairFailures.map((failure) => failure.journeyId));
  const correctingIncrement = isRepair && String(originalStep || "").startsWith("increment:");
  const candidateJourneys = step === "core" || (isRepair && !correctingIncrement)
    ? (contract.journeys || []).filter((j) => browserRepair && failedJourneyIds.size
      ? failedJourneyIds.has(j.id) : tiers.essential.journeys.includes(j.id))
    : isEdit ? (contract.journeys || []) : [journey];
  const headroomJourneys = headroomJourneyIds?.size
    ? candidateJourneys.filter((candidate) => headroomJourneyIds.has(candidate?.id))
    : [];
  const scopedJourneys = headroomJourneys.length ? headroomJourneys : candidateJourneys;
  const scopedJourneyIds = new Set(scopedJourneys.map((row) => row?.id).filter(Boolean));
  const scopedOperations = (contract.operations || []).filter((operation) => (
    !operation?.journey || scopedJourneyIds.has(operation.journey)
  ));
  const scopedEntityNames = new Set([
    ...scopedOperations.map((operation) => operation.entity).filter(Boolean),
    ...(step === "core" && !headroomScope ? tiers.essential.entities : []),
  ]);
  const scopedCapabilityGraph = capabilityGraph
    ? scopeCapabilityGraph(capabilityGraph, scopedJourneys) : null;
  const scopedScaffoldGraph = scaffoldGraph
    ? scopeScaffoldGraph(scaffoldGraph, scopedJourneys) : null;
  const scopedContract = {
    ...contract,
    journeys: scopedJourneys,
    operations: scopedOperations,
    entities: (contract.entities || []).filter((entity) => scopedEntityNames.has(entity.name)),
    dependencyPlan: scopeDependencyPlan(contract.dependencyPlan, scopedJourneys),
    capabilityGraph: scopedCapabilityGraph, scaffoldGraph: scopedScaffoldGraph,
  };
  const mountedSurface = journeySurfaceContext(tree, contract, scopedJourneys, { modulePlan });
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
  const headroomInteractionIds = new Set((headroomScope?.moduleContracts?.specifications || [])
    .flatMap((specification) => [
      ...(specification.semanticInteractions || []).map((interaction) => interaction.interactionId),
      ...(specification.downstream?.consumers || []),
    ]).filter(Boolean));
  const headroomOwnedInteractionFlows = headroomScope && activeScopePaths.length
    ? repairFlows.filter((flow) => [
      flow.stateOwner,
      flow.control?.stateOwner,
      flow.customBehaviorModule,
      ...(flow.responsibleModules || []),
    ].some((path) => activeScopePaths.includes(path)))
    : [];
  const promptInteractionFlows = headroomScope
    ? headroomInteractionIds.size || headroomOwnedInteractionFlows.length
      ? repairFlows.filter((flow) => headroomInteractionIds.has(flow.id)
        || headroomOwnedInteractionFlows.includes(flow))
      : repairFlows
    : repairFlows;
  const repairInteractionPlan = browserRepair || headroomScope ? {
    version: scopedInteractions.version,
    flows: promptInteractionFlows.map((flow) => {
      const compact = {
        id: flow.id, journeyId: flow.journeyId, stepIndex: flow.stepIndex, kind: flow.kind,
        action: flow.action, target: flow.target || null,
        reads: flow.reads || [], writes: flow.writes || [],
        control: flow.control ? {
        machineId: flow.control.machineId || null,
        roles: flow.control.roles || [], logicalField: flow.control.logicalField || null,
        inputTypes: flow.control.inputTypes || [], accessibleNames: flow.control.accessibleNames || [],
        verificationValue: flow.control.verificationValue ?? null,
        editable: flow.control.editable === true, selectedState: flow.control.selectedState === true,
        stateOwner: flow.control.stateOwner || null, statePath: flow.control.statePath || null,
        downstream: flow.control.downstream || [],
        } : null,
        capability: flow.capability || null, observable: flow.observable || null,
        stateOwner: flow.stateOwner || null, responsibleModules: flow.responsibleModules || [],
        operationId: flow.operationId || null,
        responsibilityIds: flow.responsibilityIds || [],
        semanticResponsibilityTypes: flow.semanticResponsibilityTypes || [],
        actionIdentity: flow.actionIdentity || null,
        expectedStateTransition: flow.expectedStateTransition || null,
        downstreamConsumers: flow.downstreamConsumers || [],
        capabilityId: flow.capabilityId || null,
        capabilityMethod: flow.capabilityMethod || null,
        customBehavior: flow.customBehavior || null,
        customBehaviorModule: flow.customBehaviorModule || null,
        customBehaviorExports: flow.customBehaviorExports || [],
        persistenceHandoff: flow.persistenceHandoff || null,
        verificationObservation: flow.verificationObservation || null,
      };
      return Object.fromEntries(Object.entries(compact).filter(([, value]) => (
        value !== null && value !== undefined && (!Array.isArray(value) || value.length)
      )));
    }),
  } : scopedInteractions;
  const repairFocusPaths = browserRepair ? [...new Set(repairFlows.flatMap((flow) => [
    ...(flow.responsibleModules || []), flow.stateOwner, flow.control?.stateOwner,
  ]).filter((value) => typeof value === "string" && value.startsWith("src/")))] : [];
  const repairControlFocus = headroomScope ? [...new Set(repairFlows.flatMap((flow) => [
    flow.id,
    flow.control?.logicalField,
    ...(flow.control?.accessibleNames || []),
  ]).filter(Boolean))] : moduleCorrectionScope ? [...new Set((moduleCorrectionScope.findings || []).flatMap((finding) => [
    finding.interactionId,
    finding.control,
    finding.requiredBinding?.name,
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
    headroomScope ? "" : journeySurfaceBrief(mountedSurface),
    "",
    headroomScope
      ? "CAPABILITY REQUIREMENTS: the focused per-module summary below is the dispatch brief; full bindings remain machine-enforced after the patch."
      : capabilityRequirementsBrief(scopedContract),
    scopedCapabilityGraph ? [
      "CAPABILITY GRAPH (authoritative behavior/state/data-flow ownership for this scope):",
      JSON.stringify(headroomScope
        ? headroomCapabilityGraphBrief(scopedCapabilityGraph)
        : scopedCapabilityGraph, null, 2),
    ].join("\n") : "CAPABILITY GRAPH: none.",
    scopedCapabilityGraph ? capabilityCompositionBrief(scopedCapabilityGraph) : "",
    scopedScaffoldGraph ? scaffoldCompositionBrief(scopedScaffoldGraph) : "",
    dependencyPlanBrief(scopedContract.dependencyPlan),
    promptModulePlan.length ? [
      "SUGGESTED MODULE PLAN (responsibilities matter; exact paths are guidance, not a gate — a working"
      + " application is never rejected for naming a file differently):",
      ...promptModulePlan.map((module) => {
        const ownership = module.stateOwnership || {};
        if (module.providedBy === "capability_composer") {
          return `- ${module.path}: PROVIDED AND PROTECTED ${module.role}; import its exported interface; never patch, wrap, or reimplement it.`;
        }
        if (module.providedBy === "scaffold_screen_slot") {
          const journeyIds = module.journeyIds || [];
          const controller = module.journeyController
            ? ` Render ${module.journeyController} exactly once as this screen's shared journey controller.` : "";
          const decomposition = journeyIds.length > MAX_JOURNEYS_PER_FILE
            ? ` This slot coordinates ${journeyIds.length} journeys. Keep it as a small mounted coordinator and `
              + `render its planned shared journey controller exactly once from the first batch. That controller `
              + `owns the contracted controls and interaction state; split only presentation-only helpers around it. The `
              + `gate rejects a file above ${MULTI_JOURNEY_MIN_TOKENS} tokens that implements more than `
              + `${MAX_JOURNEYS_PER_FILE} journeys, and every file remains capped at ${FILE_MAX_TOKENS} tokens.`
            : "";
          return `- ${module.path}: PROVIDED, MOUNTED, MODEL-OWNED screen slot for route ${module.routePath}; `
            + "implement this exact module and keep its default export. Do not register another route or move the journey to a dead component."
            + controller + decomposition;
        }
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
    repairBoundary && !headroomScope && !repairScope && !moduleCorrectionScope ? [
      "BROWSER-VERIFIED REPAIR WRITE BOUNDARY (machine-enforced):",
      repairBoundary.instruction,
      `Allowed files: [${repairBoundary.allowedFiles.join(", ")}]`,
      ...(repairBoundary.allowedPrefixes?.length
        ? [`New supporting modules may be created only under: [${repairBoundary.allowedPrefixes.join(", ")}]`] : []),
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
      : renderTreeContext(tree, { extraFullPaths: [
        ...regenerateFiles,
        // Core has no mounted feature yet. An increment does, and omitting that exact route/flow
        // is what produced a complete but unreachable journey in production.
        ...(!isEdit && !isRepair && step !== "core" ? mountedSurface.mountedPaths : []),
      ] }),
  ];
  if (rejections.length) {
    parts.push("", "PART OF YOUR PREVIOUS PATCH BATCH WAS REJECTED — every reason below is exact.",
      "The retained tree already contains every sibling that applied cleanly. Emit ONLY rejected or unfinished work; do not recreate existing files or re-emit changes already visible in CURRENT SOURCE:",
      ...rejections.map((r) => `- ${r.reason}`));
  }
  if (regenerateFiles.length) {
    parts.push("", "MANDATORY WHOLE-FILE ESCALATION — repeated symbol operations could not land:",
      ...regenerateFiles.map((file) => `- ${file}`),
      "For each listed file, emit exactly one replaceFile operation containing the COMPLETE current file plus the required fix. Do not use newFile or symbol operations for these files. Preserve all clean retained sibling work.");
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

const HEADROOM_CODES = new Set([
  "step_budget_ceiling", "customer_envelope_exhausted", "recovery_envelope_exhausted",
]);
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
      structured.selectionAttempt?.value, structured.selectionAttempt?.text,
      ...(structured.selectionAttempt?.optionStates || []).flatMap((option) => [
        option?.value, option?.label, option?.text,
      ]),
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
  const unfinished = planned.filter((path) => {
    if (typeof tree?.[path] !== "string") return true;
    const module = (modulePlan || []).find((candidate) => candidate.path === path);
    return module?.providedBy === "scaffold_screen_slot"
      && /data-scaffold-slot=/.test(String(tree[path]))
      && String(tree[path]).includes("Application screen ready for composition.");
  });
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
  const unscopedGeneration = !active && !["repair", "correction"].includes(logicalStep);
  const candidates = targeted.length
    ? [...new Set([...targeted, ...(unscopedGeneration ? unfinished : [])])]
    : [...new Set([
      ...missing,
      ...planned,
      // The composed scaffold is the canonical mounted application. Its protected manifest proves
      // that App/HomePage are legacy scaffold residue, not unfinished generation targets.
      ...((typeof tree?.["src/lib/scaffolds/composed/manifest.js"] === "string") ? []
        : ["src/App.jsx", "src/routes/HomePage.jsx"]
          .filter((path) => typeof tree?.[path] === "string")),
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
    if (previousScope.wholeFileRequired) return null;
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
  const missingFiles = files.filter((path) => typeof tree?.[path] !== "string");
  const missingFileTokens = expectedMissingModuleTokens(missingFiles, moduleContracts);
  const creationInstruction = missingFiles.length
    ? ` Files [${missingFiles.join(", ")}] do not exist: create each with newFile; file/ops and replaceFile are invalid until it exists.`
    : "";
  return {
    kind: "headroom_continuation",
    sourceKind: previousScope?.sourceKind || active?.kind || null,
    logicalStep: previousScope?.logicalStep || logicalStep,
    batchIndex: Number(previousScope?.batchIndex || 0),
    files,
    allowedFiles: files,
    remainingFiles,
    batchWidth: width,
    allowedPrefixes: active?.allowedPrefixes || [],
    wholeFileRequired: previousScope?.wholeFileRequired === true
      || wholeFileRepairRequired(active),
    findings: [],
    moduleContracts: { version: moduleContracts?.version || 1, specifications: selectedContracts },
    expectedPatchTokens: Math.min(6_000, Math.max(1_000, missingFileTokens, Math.ceil(sourceTokens * 1.1))),
    instruction: "This is one bounded continuation of the same approved build. Implement the complete responsibilities "
      + `owned by [${files.join(", ")}], preserve the retained candidate, and do not touch unrelated modules. `
      + "Do not ask the customer to send another message; the orchestrator will continue with the remaining modules."
      + creationInstruction,
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

const providerRequestIds = (usage, extras = []) => [...new Set([
  ...(Array.isArray(usage?.providerRequestIds) ? usage.providerRequestIds : []),
  usage?.providerRequestId, ...extras,
].filter(Boolean).map(String))].sort();

/**
 * The sole network-dispatch authority for Builder V2. Contract planning, contract repair,
 * generation, corrections, browser-informed repair and continuations all enter here with an
 * explicit provider, payer, responsibility, funding pool and durable logical identity.
 */
export async function runReservedDispatch({
  reservations, owner, projectId, buildId, step, logicalStep = step, sequence,
  logicalDispatchId: suppliedLogicalDispatchId = null,
  continuationIndex = 0, provider, decision = null, options,
  ceilingCredits, fundingPool = null, usageResponsibility = "customer_request",
  accountBalanceResolver = null, maxRepairs = 2, maxCorrections = 2,
  scopedDispatch = false, affectedModules = 1, retrievalTokens = 0, problems = [],
  expectedPatchTokens = null, maxOutputTokens = 16_000, beforeDispatch = null,
  signal = null, causalFiles = [], checkpointId = null, completionReserveCredits = 0,
} = {}) {
  if (!reservations?.reserve || !reservations?.settle || !provider?.runTurn || !provider?.model) {
    throw new Error("runReservedDispatch needs reservation and executable provider authorities");
  }
  const resolvedPool = fundingPool || fundingPoolFor({ usageResponsibility });
  await beforeDispatch?.({ owner, projectId, buildId, step: logicalStep, fundingPool: resolvedPool });
  const budget = reservations.budget
    ? await reservations.budget(owner, buildId, Number(ceilingCredits), resolvedPool)
    : {
      approvedCeilingCredits: Number(ceilingCredits), consumedCredits: 0,
      reservedCredits: 0, remainingCredits: Number(ceilingCredits),
    };
  const protectedCredits = Math.max(0, Number(completionReserveCredits || 0));
  const planningBudget = { ...budget,
    remainingCredits: Math.max(0, Number(budget.remainingCredits || 0) - protectedCredits) };
  const selectedMaxOutputTokens = Number(decision?.maxOutputTokens || maxOutputTokens);
  const callCeiling = Number(decision?.callCeilingCredits || ceilingCredits);
  let plan;
  try {
    plan = planCallReservation(options, provider.model, {
      requestedMaxOutputTokens: selectedMaxOutputTokens,
      minimumCredits: scopedDispatch ? 0 : decision?.estimatedCredits || 0,
      callCeilingCredits: callCeiling,
      repairAllowanceCredits: decision?.repairAllowanceCredits,
      repairSizing: scopedDispatch ? {
        retrievedFileCount: Number(affectedModules || 1),
        retrievalTokens: Number(retrievalTokens || 0),
        problemCount: Array.isArray(problems) ? problems.length : 1,
        expectedPatchTokens: Number(expectedPatchTokens || 0) || null,
      } : null,
      fundingPolicy: decision?.fundingPolicy || (resolvedPool === FUNDING_POOL.RECOVERY
        ? "thrallo_recovery" : "request_owner"),
      budget: planningBudget,
    });
  } catch (error) {
    error.fundingPool = resolvedPool;
    if (error.code === "budget_ceiling") {
      error.code = protectedCredits > 0 ? "customer_completion_reserve"
        : resolvedPool === FUNDING_POOL.RECOVERY
          ? "recovery_envelope_exhausted" : "customer_envelope_exhausted";
      error.completionReserveCredits = protectedCredits;
    }
    throw error;
  }
  const reservationStep = Number(continuationIndex || 0) > 0 ? `${step}:headroom` : step;
  const logicalDispatchId = suppliedLogicalDispatchId
    || `${buildId}:${logicalStep}:${Number(sequence)}:logical`;
  const callKey = modelCallKey({
    buildId, step: reservationStep, sequence,
    purpose: `dispatch:${logicalDispatchId}:${Number(continuationIndex || 0)}`,
  });
  let accountBalance = (decision?.billingLane || "managed") === "managed"
    && usageResponsibility === "customer_request"
    ? await accountBalanceResolver?.(owner) : null;
  const reservationInput = () => ({
    owner, projectId, buildId, callKey, step: reservationStep,
    provider: provider.provider || provider.providerId || decision?.provider || provider.model,
    model: provider.model, billingLane: decision?.billingLane || "managed",
    reservedCredits: plan.reservedCredits, ceilingCredits: Number(ceilingCredits),
    accountBalance, usageResponsibility, fundingPool: resolvedPool,
    maxRepairs, maxCorrections,
    logicalDispatchId, continuationIndex: Number(continuationIndex || 0),
    metadata: {
      routing: decision || null, taskClass: decision?.taskClass || "generated_app", sequence,
      logicalStep, logicalDispatchId, continuationIndex: Number(continuationIndex || 0),
      budgetPlan: plan, fundingPolicy: plan.fundingPolicy,
      causalFiles: [...new Set(causalFiles || [])], checkpointId,
      completionReserveCredits: protectedCredits,
    },
  });
  let hold;
  try {
    hold = await reservations.reserve(reservationInput());
  } catch (error) {
    const customerManaged = (decision?.billingLane || "managed") === "managed"
      && usageResponsibility === "customer_request";
    if (error.code !== "allowance_snapshot_stale" || !customerManaged) {
      if (error.code === "budget_ceiling") {
        error.code = resolvedPool === FUNDING_POOL.RECOVERY
          ? "recovery_envelope_exhausted" : "customer_envelope_exhausted";
        error.fundingPool = resolvedPool;
      }
      throw error;
    }
    accountBalance = await accountBalanceResolver?.(owner);
    hold = await reservations.reserve(reservationInput());
  }
  assertModelDispatchAcquired(hold);
  let turn;
  try {
    turn = await provider.runTurn.call(provider, {
      ...options, signal: signal || options.signal, maxOutputTokens: plan.maxOutputTokens,
      maxProviderRetries: 0, allowParameterRetry: false,
    });
  } catch (error) {
    const usage = error?.usage || {};
    const failure = classifyProviderFailure(error);
    // A provider failure on Builder-owned correction/recovery is a platform/provider failure,
    // never evidence that generated source is defective. Preserve the raw provider error while
    // giving terminal translation the correct responsibility before source may even exist.
    if (!error.classification) {
      const customerOwnedTransport = resolvedPool === FUNDING_POOL.CUSTOMER
        && ["connected_allowance", "byok_api"].includes(decision?.billingLane);
      error.classification = customerOwnedTransport ? "provider_customer" : "platform";
      error.customerActionRequired = false;
      if (customerOwnedTransport) error.customerActionRequired = true;
    }
    const actualCredits = creditsForUsage({ usage, model: provider.model });
    try {
      if (failure.hasUsage) {
        await reservations.settle(owner, hold.id, {
          actualCredits, usage, providerRequestIds: providerRequestIds(usage, [error?.providerRequestId]),
        });
      } else if (failure.state === "before_dispatch" || failure.state === "provider_rejected") {
        await reservations.release(owner, hold.id);
      } else {
        await reservations.markAmbiguous(owner, hold.id, {
          reason: error?.message || "provider dispatch ambiguous",
          providerRequestIds: providerRequestIds(usage, [error?.providerRequestId]),
        });
      }
    } catch (settlementError) {
      const ids = providerRequestIds(usage, [error?.providerRequestId]);
      const accountingError = Object.assign(new AggregateError(
        [error, settlementError],
        `Provider call failed and its usage could not be settled: ${settlementError.message}`,
      ), { code: "billing_settlement_failed", providerError: error });
      try {
        await reservations.markAmbiguous(owner, hold.id, {
          reason: accountingError.message, providerRequestIds: ids,
        });
      } catch (reconciliationError) { accountingError.reconciliationError = reconciliationError; }
      throw replayUnsafe(accountingError, { reservationId: hold.id, providerRequestId: ids[0] || null });
    }
    if (failure.state === "before_dispatch" || failure.state === "provider_rejected") throw error;
    throw replayUnsafe(error, { reservationId: hold.id, providerRequestId: error?.providerRequestId || null });
  }
  const actualCredits = creditsForUsage({ usage: turn.usage || {}, model: provider.model });
  const ids = providerRequestIds(turn.usage);
  try {
    await reservations.settle(owner, hold.id, {
      actualCredits, usage: turn.usage || {}, providerRequestIds: ids,
    });
  } catch (error) {
    try {
      await reservations.markAmbiguous(owner, hold.id, {
        reason: `provider completed but settlement failed: ${error?.message || "unknown error"}`,
        providerRequestIds: ids,
      });
    } catch (reconciliationError) { error.reconciliationError = reconciliationError; }
    throw replayUnsafe(error, { reservationId: hold.id, providerRequestId: ids[0] || null });
  }
  if (!turn || typeof turn !== "object") turn = { text: String(turn || "") };
  if (!Object.isExtensible(turn)) turn = { ...turn };
  Object.defineProperty(turn, "reservation", {
    value: { id: hold.id, logicalDispatchId, continuationIndex, fundingPool: resolvedPool, plan },
    enumerable: false,
  });
  return turn;
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
  poolCeilingResolver = null,
  beforeDispatch = null,
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
          const scopedDispatch = SCOPED_STEPS.has(step) || context.scopedDispatch === true;
          const usageResponsibility = context.recoveryDispatch === true
            || ["repair", "correction"].includes(step)
            ? "thrallo_repair" : defaultUsageResponsibility;
          const fundingPool = fundingPoolFor({ usageResponsibility });
          const poolAuthority = await poolCeilingResolver?.({
            owner: context.owner, projectId: context.projectId, buildId: context.buildId,
            step, fundingPool, context,
          });
          const poolCeiling = Number(poolAuthority?.ceilingCredits ?? poolAuthority ?? ceilingCredits);
          const completionReserveCredits = Number(poolAuthority?.completionReserveCredits || 0);
          return runReservedDispatch({
            reservations, owner: context.owner, projectId: context.projectId,
            buildId: context.buildId, step, logicalStep: context.logicalStep || step, sequence,
            logicalDispatchId: context.logicalDispatchId || `${context.buildId}:${context.logicalStep || step}:`
              + `${context.attempt || context.correction || context.round || sequence}`,
            continuationIndex: Number(context.headroomBatchIndex || 0), provider: selected.provider,
            decision: { ...(selected.decision || {}),
              billingLane: selected.decision?.billingLane || billingLane },
            options, ceilingCredits: poolCeiling, fundingPool, usageResponsibility,
            accountBalanceResolver: accountCreditResolver, maxRepairs, maxCorrections,
            scopedDispatch, affectedModules: context.affectedModules,
            retrievalTokens: context.retrievalTokens, problems: context.problems,
            expectedPatchTokens: context.expectedPatchTokens, maxOutputTokens,
            beforeDispatch, signal: context.signal || options.signal,
            causalFiles: context.causalFiles || [], checkpointId: context.checkpointId || null,
            completionReserveCredits,
          });
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

    contractFn: async ({ owner, projectId, buildId, request, buildProfile = null, signal = null,
      priorContract = null, problems = [], issues = [] }) => {
      const startedAt = Date.now();
      const before = bucket.summary();
      const repair = Boolean(priorContract && problems.length);
      const projectKnowledge = await loadKnowledge(owner, projectId);
      // Project memory is supporting context; the customer's request is irreducible. Keep a
      // bounded, line-complete knowledge prefix so reservation sizing sheds memory before it ever
      // asks the customer to narrow unchanged scope.
      const boundedKnowledge = projectKnowledge.length > 8_000
        ? `${projectKnowledge.slice(0, 8_000).replace(/[^\n]*$/, "")}\n[older project knowledge omitted for sizing]`
        : projectKnowledge;
      const contractRequest = `${boundedKnowledge}\n\nUSER REQUEST:\n${request}`;
      const selectionContext = {
        owner, projectId, buildId, request, signal,
        taskClass: "contract", problems,
        retrievalTokens: Math.ceil(Buffer.byteLength(boundedKnowledge, "utf8") / 4),
        affectedModules: 1,
        recoveryDispatch: repair,
      };
      let selected = await reservedProvider("contract", selectionContext);
      let contractAttempt = 0;
      const dispatchProvider = {
        ...selected.provider,
        runTurn: async (options) => {
          contractAttempt += 1;
          // Retry/correction work is Thrallo-funded even when the first planned contract call was
          // customer-funded. A gate-repair invocation is recovery-funded from its first call.
          if (!repair && contractAttempt > 1) {
            selected = await reservedProvider("contract", {
              ...selectionContext, recoveryDispatch: true,
              logicalDispatchId: `${buildId}:contract_protocol_correction:${contractAttempt - 1}`,
            });
          }
          return selected.provider.runTurn(options);
        },
      };
      let outcome;
      // A thrown attempt must surface as ITS OWN message. Reading `outcome.contract` off an
      // undefined outcome turned every contract-lane exception into "Cannot read properties of
      // undefined", and a gate repair that died mid-attempt was reported as "unavailable" with no
      // cause (bv2 medium qualification, build c56cb4c2).
      let failure = null;
      try {
        outcome = await generateContract({
          provider: dispatchProvider, prompt: contractRequest, buildProfile, log, onUsage: accountUsage,
          priorContract: repair ? priorContract : null, priorProblems: repair ? problems : [],
          priorIssues: repair ? issues : [],
        });
      } catch (error) {
        failure = error;
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
          label: `implementation contract${repair ? " (gate repair)" : ""}`
            + `${outcome?.degraded ? " (degraded)" : ""}`,
          prompt: contractRequest, output: outcome ? JSON.stringify(outcome.contract) : null,
          usage: delta, durationMs: Date.now() - startedAt, providerUsed: selected.provider,
          decision: selected.decision,
        });
      }
      if (failure) throw failure;
      if (!outcome?.contract) throw new Error(`contract generation failed: ${(outcome?.problems || []).join("; ")}`);
      return outcome.contract;
    },

    patchesFn: async ({ owner, projectId, buildId, step, originalStep, attempt = 1, contract, tiers, tree, journey, rejections, problems, editRequest,
      modulePlan = [], moduleContracts = null, repairScope = null, moduleCorrectionScope = null,
      headroomScope: requestedHeadroomScope = null, repairBoundary = null,
      regenerateFiles = [], advisory = [], spec = null, signal = null }) => {
      const projectKnowledge = repairScope || moduleCorrectionScope || requestedHeadroomScope
        ? null : await loadKnowledge(owner, projectId);
      const fullSystemPrompt = `${PATCH_SYSTEM_PROMPT}\n\nAVAILABLE CAPABILITIES (import, never rewrite):\n${capabilityBrief()}`;
      let systemPrompt = fullSystemPrompt;
      const startedAt = Date.now();
      let headroomScope = requestedHeadroomScope;
      let headroomResizes = 0;
      const logicalDispatchId = requestedHeadroomScope?.logicalDispatchId
        || `${buildId}:${originalStep || step}:${attempt}`;
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
          const compileScoped = [headroomScope, repairScope, moduleCorrectionScope]
            .some((scope) => scope?.kind === "compile" || scope?.sourceKind === "compile");
          systemPrompt = headroomScope?.fragmented
            ? HEADROOM_FRAGMENT_SYSTEM_PROMPT
            : compileScoped ? COMPILE_CORRECTION_SYSTEM_PROMPT : fullSystemPrompt;
          prompt = renderPatchPrompt({
            step, originalStep, contract, tiers, tree, journey, rejections, problems: dispatchProblems, editRequest,
            projectKnowledge: headroomScope ? null : projectKnowledge, modulePlan, moduleContracts,
            repairScope, moduleCorrectionScope, headroomScope, repairBoundary, regenerateFiles, advisory,
            capabilityGraph: spec?.capabilityGraph || contract?.capabilityGraph || null,
            compositionPlan: spec?.compositionPlan || null,
            scaffoldGraph: spec?.scaffoldGraph || contract?.scaffoldGraph || null,
            scaffoldPlan: spec?.scaffoldCompositionPlan || null,
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
            recoveryDispatch: ["repair", "correction"].includes(step)
              || (attempt > 1 && !requestedHeadroomScope),
            headroomBatchIndex: Number(headroomScope?.batchIndex || 0) + headroomResizes,
            logicalDispatchId,
            causalFiles: [...new Set([
              ...(repairBoundary?.allowedFiles || []), ...(semanticRepairFiles || []),
              ...(headroomScope?.allowedFiles || []),
            ])],
          });
          try {
            return await callOnce();
          } catch (error) {
            if (!isHeadroomFitError(error)) throw error;
            const nextScope = headroomDispatchScope({
              tree, modulePlan, moduleContracts, repairScope, moduleCorrectionScope,
              problems: dispatchProblems, rejections, previousScope: headroomScope, logicalStep: step,
              semanticFiles: repairBoundary?.allowedFiles?.length ? repairBoundary.allowedFiles : semanticRepairFiles,
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
            headroomScope.logicalDispatchId = logicalDispatchId;
            headroomResizes += 1;
            const poolLimited = ["customer_envelope_exhausted", "recovery_envelope_exhausted"]
              .includes(error.code);
            log(`${step}: ${poolLimited
              ? `the remaining ${error.fundingPool || "build"} pool cannot fit this full semantic request`
              : "the approved whole-build ceiling is intact, but this prompt exceeds its per-call envelope"} `
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
