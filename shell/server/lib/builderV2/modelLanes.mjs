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
import { CAPABILITIES, capabilityBrief } from "./capabilityRegistry.mjs";
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
import { interactionContractBrief, scopeInteractionContract } from "./interactionContract.mjs";
import { moduleGenerationContractsBrief } from "./moduleContracts.mjs";

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
  wholesale (never append a second default component); replaceFile is for index-opaque files.
- Pages live in src/routes/<Name>.jsx and MUST be registered in src/App.jsx's ROUTES map
  (replace_symbol on the existing map or the App component).
- src/lib/backend/, src/lib/visitorSession.js and src/lib/capabilities/ are protected platform
  infrastructure: IMPORT them, never modify or reimplement them. Persistence goes through the
  capabilities (src/lib/capabilities) — never localStorage. Contact messages, newsletter
  signups and bookings MUST use their capability (submitContact / subscribe / createBooking):
  a raw db.entity(...) write has no session and fails with 401 for anonymous visitors. Any
  other entity mutation must call await ensureVisitorSession() first.
- Imagery: import { ASSETS } from "./lib/assetData.js" (adjust the relative path) and render
  with the helpers in src/lib/assets.js (imageProps / pictureSources / isPlaceholder /
  placeholderStyle). Never hardcode an image URL and never invent one. When ASSET_CREDITS
  contains Pexels assets, render a visible footer link to Pexels and link each available
  photographer name to that asset's photoUrl.
- Every user-visible outcome named in the journeys must appear as real, reachable UI text.
- Keep components small; one route file per page plus small shared components.
- BUILD THE WHOLE STEP IN THIS ONE BATCH. A real step is several patches and several
  kilobytes of new JSX: new files for every section/page, real copy, real form state, and
  the App.jsx registration. A batch that re-emits existing content, leaves scaffold stubs
  in place, or only tweaks one line is rejected as a no-op and costs you a round.`;

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
  for (const path of files) {
    if (typeof tree?.[path] !== "string" && repairScope?.kind !== "module_contract") {
      throw new Error(`pre-compile repair source is missing: ${path}`);
    }
  }
  if (repairScope?.kind === "module_contract" && files.some((path) => typeof tree?.[path] !== "string")) {
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

export function renderPatchPrompt({
  step, contract, tiers, tree, journey, rejections = [], problems = [], editRequest = null,
  projectKnowledge = null, onRetrieval = null, modulePlan = [], moduleContracts = null,
  repairScope = null, moduleCorrectionScope = null, advisory = [],
}) {
  const isEdit = step === "edit";
  const isRepair = step === "repair" || step === "correction";
  const scopedJourneys = step === "core" || isRepair
    ? (contract.journeys || []).filter((j) => tiers.essential.journeys.includes(j.id))
    : isEdit ? (contract.journeys || []) : [journey];
  const persistencePlan = persistenceOwnershipPlan(contract, scopedJourneys, modulePlan);
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
    moduleCorrectionScope
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
    contractBrief(contract),
    "",
    capabilityRequirementsBrief(contract),
    modulePlan.length ? [
      "SUGGESTED MODULE PLAN (responsibilities matter; exact paths are guidance, not a gate — a working"
      + " application is never rejected for naming a file differently):",
      ...modulePlan.map((module) => {
        const ownership = module.stateOwnership || {};
        return `- ${module.path}: ${module.role}${module.factory ? `; bind ${module.factory}(...) here` : ""}; `
          + `owns=${ownership.owns || "presentation only"}; survivesReload=${ownership.survivesReload === true}; `
          + `approvedPersistence=${ownership.approvedPersistence || "none"}; durableStateOwner=${ownership.durableStateOwner || "self/none"}`;
      }),
      "Keep styling, layout, typography and component composition original to this app.",
    ].join("\n") : "REQUIRED MODULE PLAN: none for this scope.",
    "",
    moduleGenerationContractsBrief(moduleCorrectionScope?.moduleContracts || moduleContracts),
    "",
    persistencePlan
      ? `PERSISTENCE OWNERSHIP CONTRACT (machine-enforced JSON; hard constraints, not advice):\n${JSON.stringify(persistencePlan, null, 2)}`
      : "PERSISTENCE OWNERSHIP CONTRACT: no durable journey in this scope.",
    "",
    interactionContractBrief(scopeInteractionContract(contract.interactionContract, scopedJourneys)),
    "",
    repairScope ? [
      "TARGETED PRE-COMPILE REPAIR (write boundary is machine-enforced):",
      repairScope.instruction,
      `Allowed files: [${repairScope.allowedFiles.join(", ")}]`,
      `Validator findings: ${JSON.stringify(repairScope.findings)}`,
    ].join("\n") : "",
    moduleCorrectionScope ? [
      "MODULE-SCOPED CORE CORRECTION (write boundary is machine-enforced):",
      moduleCorrectionScope.instruction,
      `Allowed files: [${moduleCorrectionScope.allowedFiles.join(", ")}]`,
      `Module conformance findings: ${JSON.stringify(moduleCorrectionScope.findings)}`,
    ].join("\n") : "",
    repairScope || moduleCorrectionScope ? "" : null,
    repairScope || moduleCorrectionScope
      ? "PROJECT KNOWLEDGE: omitted for this deterministic pre-compile repair."
      : projectKnowledge || "PROJECT KNOWLEDGE: not loaded for this request.",
    "",
    renderJourneyBrief(scopedJourneys),
    advisoryNotes,
    repairScope || moduleCorrectionScope
      ? renderPrecompileRepairContext(tree, { repairScope: repairScope || moduleCorrectionScope, onRetrieval })
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
  if (problems.length) {
    parts.push("", "VERIFICATION FAILED on your last tree — fix these and re-emit patches:",
      ...problems.map((p) => `- ${p}`));
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

export function routeForStep(step) {
  const kind = String(step || "").startsWith("increment:") ? "increment" : String(step || "");
  return STEP_ROUTING[kind] || STEP_ROUTING.core;
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
  let low = 0;
  let high = requested;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const estimate = conservativeCallReservation(options, model, {
      maxOutputTokens: middle, minimumCredits,
    });
    if (estimate <= creditLimit + 1e-9) low = middle;
    else high = middle - 1;
  }
  const reservedCredits = conservativeCallReservation(options, model, {
    maxOutputTokens: low, minimumCredits,
  });
  if (reservedCredits > creditLimit + 1e-9 || low < minimumUsefulOutputTokens) {
    throw Object.assign(new Error("Builder V2 call cannot fit a useful response inside approved headroom"), {
      code: limitingCode, retryable: false, dispatchState: "before_dispatch",
      remaining, callCeiling: perCall, repairAllowance: Number.isFinite(allowance) ? allowance : null,
      minimumCredits: Number(minimumCredits || 0), minimumUsefulOutputTokens,
      maximumFittingOutputTokens: low,
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
          const plan = planCallReservation(options, selected.provider.model, {
            requestedMaxOutputTokens: selectedMaxOutputTokens,
            // A route estimate is not a mandatory hold. Repair usefulness is enforced by its
            // minimum output envelope; the durable whole-build ceiling remains authoritative.
            minimumCredits: SCOPED_STEPS.has(step) ? 0 : selected.decision?.estimatedCredits || 0,
            callCeilingCredits: callCeiling,
            repairAllowanceCredits: selected.decision?.repairAllowanceCredits,
            repairSizing: SCOPED_STEPS.has(step) ? {
              retrievedFileCount: Number(context.affectedModules || 1),
              retrievalTokens: Number(context.retrievalTokens || 0),
              problemCount: Array.isArray(context.problems) ? context.problems.length : 1,
            } : null,
            fundingPolicy: selected.decision?.fundingPolicy || "request_owner",
            budget,
          });
          const callKey = modelCallKey({ buildId: context.buildId, step, sequence });
          const accountAvailableCredits = (selected.decision?.billingLane || billingLane) === "managed"
            ? Number(await accountCreditResolver?.(context.owner)) : null;
          const hold = await reservations.reserve({
            owner: context.owner, projectId: context.projectId, buildId: context.buildId,
            callKey, step,
            provider: selected.provider.provider || selected.provider.providerId || selected.decision?.provider || selected.provider.model,
            model: selected.provider.model, billingLane: selected.decision?.billingLane || billingLane,
            reservedCredits: plan.reservedCredits, ceilingCredits: Number(ceilingCredits),
            accountAvailableCredits,
            maxRepairs, maxCorrections,
            metadata: {
              routing: selected.decision || null, taskClass: selected.decision?.taskClass || "generated_app", sequence,
              budgetPlan: plan, fundingPolicy: plan.fundingPolicy,
            },
          });
          assertModelDispatchAcquired(hold);
          let turn;
          try {
            turn = await selected.provider.runTurn.call(selected.provider, {
              ...options, signal: context.signal || options.signal, maxOutputTokens: plan.maxOutputTokens,
              // V2 owns retries outside transports so every network dispatch receives its own
              // reservation and telemetry identity. Provider-internal retries would be invisible.
              maxProviderRetries: 0,
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
              }
            } catch (settlementError) {
              throw Object.assign(new AggregateError(
                [error, settlementError],
                `Provider call failed and its usage could not be settled: ${settlementError.message}`,
              ), { code: "billing_settlement_failed", providerError: error });
            }
            if (failure.state === "before_dispatch" || failure.state === "provider_rejected") throw error;
            throw replayUnsafe(error, { reservationId: hold.id, providerRequestId: error?.providerRequestId || null });
          }
          // Settlement is part of successful dispatch. If its acknowledgement fails, stop here;
          // do not reinterpret that database failure as a provider failure or invoke settlement a
          // second time with empty telemetry. The reservation remains the reconciliation authority.
          const actualCredits = creditsForUsage({ usage: turn.usage || {}, model: selected.provider.model });
          await reservations.settle(context.owner, hold.id, {
            actualCredits, usage: turn.usage || {}, providerRequestIds: requestIds(turn.usage),
          });
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

    patchesFn: async ({ owner, projectId, buildId, step, contract, tiers, tree, journey, rejections, problems, editRequest,
      modulePlan = [], moduleContracts = null, repairScope = null, moduleCorrectionScope = null,
      advisory = [], signal = null }) => {
      const projectKnowledge = repairScope || moduleCorrectionScope ? null : await loadKnowledge(owner, projectId);
      let retrievalTrace = null;
      const prompt = renderPatchPrompt({
        step, contract, tiers, tree, journey, rejections, problems, editRequest, projectKnowledge, modulePlan,
        moduleContracts, repairScope, moduleCorrectionScope, advisory,
        onRetrieval: (trace) => { retrievalTrace = trace; },
      });
      if (retrievalTrace && recordRetrieval) {
        await recordRetrieval({ owner, projectId, buildId, step, ...retrievalTrace });
      }
      const systemPrompt = `${PATCH_SYSTEM_PROMPT}\n\nAVAILABLE CAPABILITIES (import, never rewrite):\n${capabilityBrief()}`;
      const startedAt = Date.now();
      const selected = await reservedProvider(step, {
        owner, projectId, buildId, contract, tree, problems, editRequest, signal,
        taskClass: `${String(step).startsWith("increment:") ? "increment" : step}`,
        retrievalTokens: Number(retrievalTrace?.tokens || 0),
        affectedModules: Math.max(1, new Set([
          ...(retrievalTrace?.included || []).map((entry) => entry.path).filter(Boolean),
          ...Object.keys(tree || {}).filter((path) => (problems || []).some((problem) => String(problem).includes(path))),
        ]).size),
      });
      // ONE retry on transport-shaped failures: a dropped SSE stream ("terminated") killed
      // a live booking attempt 24 minutes in. Model/tool errors never retry — only the wire.
      const callOnce = () => selected.provider.runTurn({
        systemPrompt,
        messages: [{ role: "user", content: prompt }],
        tools: [EMIT_PATCHES_SCHEMA],
        toolChoice: { type: "function", name: EMIT_PATCHES_SCHEMA.name },
        // The first live run produced an 82-token no-op with zero reasoning; a forced tool
        // call still needs thinking room — how much is the per-step routing table's call.
        reasoningEffort: routeForStep(step).reasoningEffort,
      });
      let turn;
      try {
        turn = await callOnce();
      } catch (error) {
        if (error?.retrySafe !== true) throw error;
        log(`${step}: provider rejected before billable dispatch (${String(error.message).slice(0, 60)}) — one retry`);
        await new Promise((r) => setTimeout(r, 2_000));
        turn = await callOnce();
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
