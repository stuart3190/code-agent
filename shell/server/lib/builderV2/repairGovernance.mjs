// Repair governance: WHO OWNS a verified defect, WHETHER a repair can be dispatched, and WHAT a
// stalled repair means - decided from evidence before any provider credit is spent.
//
// Three retained failure modes motivate this:
//   - repair rounds were dispatched against defects the application could not fix: a producer chain
//     the contract never declared, a verifier that could not run, a sandbox missing a module - each
//     one burned the application's allowance on a patch that could change nothing;
//   - a scoped repair was dispatched with a write boundary that omitted the modules the fix had to
//     touch (the owner's importers, the consumer of a changed export), or named a planned module the
//     tree never contained, so the round failed on scope rather than on the defect;
//   - a repair that moved nothing was simply escalated to regenerate the owner, again and again,
//     although the evidence already said the owner was not where the defect lived.
//
// Every decision here is a pure function of the defects, the tree and the strategy. Nothing reads
// prose, nothing consults a model.

import { parseImports } from "../appBuild/importPreflight.mjs";
import { DEFECT_CLASS, DEFECT_OWNER, REPAIR_TIER, actionableDefects } from "./verificationDefects.mjs";

export const REPAIR_OWNERSHIP = Object.freeze({
  GENERATED_APP: "generated_app",           // the generated application is wrong: an app repair may fix it
  CONTRACT_INVALID: "contract_invalid",     // the contract/execution binding cannot be executed as written
  PREREQUISITE_MISSING: "prerequisite_missing", // the journey's starting state has no reproducible producer
  VERIFIER_INVALID: "verifier_invalid",     // the verification platform itself failed or could not decide
  PLATFORM_PROVIDER: "platform_provider",   // provider/model/credit availability, never the app
  PACKAGING_RUNTIME: "packaging_runtime",   // the sandbox/runtime image is not the host's code
  UNDETERMINED: "undetermined",             // the evidence does not settle who owns it
});

export const REPAIR_STRATEGY_ORDER = Object.freeze([
  "exact_owning_file_repair", "causal_dependency_repair", "owner_module_regeneration",
]);

const unique = (values) => [...new Set((values || []).filter(Boolean))];
const SOURCE = /\.(?:jsx?|tsx?|mjs)$/;
// Platform-owned runtime modules: read context for a repair, never something it may rewrite.
// Repair may never rewrite platform code. WP3+ put the module runtime (lib/modules) and the
// composed public facade (lib/app) inside that boundary: a module fault is platform remediation
// or a versioned module upgrade, never an application patch (audit §14).
const PLATFORM_PATH = /(?:^|\/)lib\/(?:capabilities|scaffolds|backend|modules|app)\//;
const generatedSource = (path) => SOURCE.test(String(path || "")) && !PLATFORM_PATH.test(String(path || ""));

const PACKAGING_SIGNS = /ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)|sandbox_version_mismatch|sandbox (?:image|identity)|not copied|does not support|ENOENT.*node_modules/i;
const PROVIDER_SIGNS = /\b(?:provider|model|credit|budget|rate.?limit|quota|token limit|429|overloaded|billing)\b/i;

/**
 * Who owns one verified defect.
 *
 * @returns {{ ownership: string, reason: string, evidence: object }}
 */
export function classifyRepairOwnership(defect, { tree = null } = {}) {
  const code = String(defect?.code || "");
  const observed = String(defect?.evidence?.observed || defect?.evidence?.detail || "");
  const modules = unique(defect?.modules || []);
  const decide = (ownership, reason, evidence = {}) => ({ ownership, reason, evidence: { code, modules, ...evidence } });

  // The contract or its execution projection cannot be executed as written.
  if (defect?.defectClass === DEFECT_CLASS.CONTRACT
    || /^(?:verification_evidence_contract_mismatch|prerequisite_contract_invalid|execution_contract_provenance_mismatch)$/.test(code)) {
    return decide(REPAIR_OWNERSHIP.CONTRACT_INVALID, "the derived contract or its execution projection is not executable as written");
  }
  // A starting state no reproducible chain establishes. A named producer that DID run and failed is
  // the producer's own generated defect; a chain with nothing to replay is not the app's.
  if (/^(?:journey_prerequisites_unmet|journey_prerequisite_control_missing|prerequisite_durable_outcome_missing)$/.test(code)) {
    // A prerequisite that NAMES a control the browser could not find is the same claim as any other
    // undriveable contracted control: the application lacks it (six journeys, one missing control,
    // zero attempts - that must never repeat). Only a chain with nothing to aim at is not the app's.
    const producerRan = Boolean(defect?.evidence?.expected) || Boolean(defect?.control?.id) || Boolean(defect?.control?.logicalField)
      || modules.some((path) => tree && typeof tree[path] === "string");
    return producerRan
      ? decide(REPAIR_OWNERSHIP.GENERATED_APP, "the chain names a control or producer in the application that did not establish the record")
      : decide(REPAIR_OWNERSHIP.PREREQUISITE_MISSING, "the journey's starting state has no reproducible producer in the application");
  }
  // The platform could not run or could not decide.
  if (defect?.owner === DEFECT_OWNER.PLATFORM || defect?.defectClass === DEFECT_CLASS.PLATFORM) {
    if (PACKAGING_SIGNS.test(observed)) return decide(REPAIR_OWNERSHIP.PACKAGING_RUNTIME, "the sandbox runtime is not the host's code or lacks a module it imports", { observed });
    if (PROVIDER_SIGNS.test(observed) && !/console|request|element|control/i.test(observed)) {
      return decide(REPAIR_OWNERSHIP.PLATFORM_PROVIDER, "a provider, model or credit condition stopped verification", { observed });
    }
    return decide(REPAIR_OWNERSHIP.VERIFIER_INVALID, "the verification platform failed or was inconclusive", { observed });
  }
  // Ambiguity the browser could not settle: the same identity on several visible elements may be
  // the app naming two controls alike (generated) or the platform addressing loosely. Only the tree
  // can say: two distinct bindings of the same identity is the app's defect.
  if (defect?.evidence?.addressing?.reason === "ambiguous_identity") {
    const bindings = tree && defect?.control?.id ? bindingSitesOf(tree, defect.control) : null;
    if (bindings && bindings.length > 1) return decide(REPAIR_OWNERSHIP.GENERATED_APP, "the tree binds one control identity in more than one place", { bindings });
    if (bindings && bindings.length === 1) {
      return decide(REPAIR_OWNERSHIP.UNDETERMINED, "the browser found the identity ambiguous and the tree binds it exactly once: the platform's addressing, not the application, needs review", { bindings });
    }
    // No tree or no identity to check against: ambiguity cannot be disproved, and an unknown owner
    // is not a reason to leave a defect unrepaired (six journeys, one missing control, zero attempts).
    return decide(REPAIR_OWNERSHIP.GENERATED_APP, "the ambiguity could not be disproved from the tree; the application keeps the repair");
  }
  if (defect?.tier === REPAIR_TIER.NONE) {
    return decide(REPAIR_OWNERSHIP.UNDETERMINED, "the defect is not one an application patch can answer");
  }
  return decide(REPAIR_OWNERSHIP.GENERATED_APP, "the browser attributed the failure to generated application modules");
}

/** Where in the tree a contracted control identity is bound (literal id, or the helper by name/scope). */
export function bindingSitesOf(tree, control) {
  if (!tree || !control) return [];
  const id = String(control.id || control.machineId || "");
  const logical = String(control.logicalField || "");
  const scope = control.scope ? String(control.scope) : null;
  const sites = [];
  for (const [file, source] of Object.entries(tree)) {
    if (!generatedSource(file) || typeof source !== "string") continue;
    if (id && source.includes(id)) { sites.push({ file, via: "literal" }); continue; }
    if (!logical) continue;
    const calls = source.match(/use(?:SemanticField|SemanticSelection)\s*\(\s*\{[^}]*\}/g) || [];
    for (const call of calls) {
      const name = (call.match(/\bname\s*:\s*["'`]([^"'`]+)["'`]/) || [])[1] || null;
      const boundScope = (call.match(/\bscope\s*:\s*["'`]([^"'`]+)["'`]/) || [])[1] || null;
      if (name === logical && (boundScope || null) === scope) sites.push({ file, via: "helper" });
    }
  }
  return sites;
}

// ── dependency closure ─────────────────────────────────────────────────────────────────────────

function resolveRelative(tree, fromFile, specifier) {
  const base = String(fromFile).split("/").slice(0, -1);
  for (const part of String(specifier).split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") base.pop(); else base.push(part);
  }
  const joined = base.join("/");
  for (const suffix of ["", ".js", ".jsx", ".ts", ".tsx", ".mjs", "/index.js", "/index.jsx"]) {
    if (typeof tree[joined + suffix] === "string") return joined + suffix;
  }
  return null;
}

/**
 * The read-dependency closure of a set of modules inside the tree: the modules, every local module
 * they import (transitively, generated source only), and every module that imports them (one level -
 * the consumers a changed export must keep satisfied). Platform runtime modules are reported as
 * `platformContext` (read-only), never as writable members.
 */
export function dependencyClosure(tree, modules = []) {
  const files = Object.keys(tree || {}).filter((path) => typeof tree[path] === "string" && SOURCE.test(path));
  const importsOf = new Map(files.map((file) => [file, unique(parseImports(tree[file])
    .filter((statement) => statement.specifier.startsWith("."))
    .map((statement) => resolveRelative(tree, file, statement.specifier)))]));
  const roots = unique(modules).filter((path) => typeof tree?.[path] === "string");
  const missing = unique(modules).filter((path) => typeof tree?.[path] !== "string");
  const closure = new Set();
  const platformContext = new Set();
  const queue = [...roots];
  while (queue.length) {
    const file = queue.shift();
    if (closure.has(file)) continue;
    closure.add(file);
    for (const dependency of importsOf.get(file) || []) {
      if (PLATFORM_PATH.test(dependency)) platformContext.add(dependency);
      else if (!closure.has(dependency)) queue.push(dependency);
    }
  }
  const importers = files.filter((file) => !closure.has(file) && (importsOf.get(file) || []).some((dependency) => roots.includes(dependency)));
  return {
    roots, missing,
    files: [...closure].sort(),
    importers: importers.sort(),
    platformContext: [...platformContext].sort(),
  };
}

// ── feasibility ────────────────────────────────────────────────────────────────────────────────

/**
 * Can this repair strategy be dispatched against this boundary at all?
 *
 * A boundary that cannot reach the contracted control the defect names (its binding lives in a
 * child component the exact boundary excluded) makes the exact repair fail on scope; a boundary
 * that names a module the tree does not contain cannot be repaired in place. Both are decided here,
 * before dispatch, with the widened strategy the ladder must jump to. The read closure (imports,
 * importers, platform helpers) always travels with the repair as context.
 */
export function repairFeasibility({ tree, defects = [], boundary = null, strategy = REPAIR_STRATEGY_ORDER[0] } = {}) {
  const actionable = actionableDefects(defects);
  const owners = unique(actionable.flatMap((defect) => defect.modules || []));
  const closure = dependencyClosure(tree, owners);
  // Where the defects' contracted controls are actually bound: the files a fix must be able to reach.
  const bindingFiles = unique(actionable.flatMap((defect) => (defect.control?.id ? bindingSitesOf(tree, defect.control) : [])
    .map((site) => site.file)));
  const allowed = new Set(boundary?.allowedFiles || []);
  const outsideBoundary = boundary ? bindingFiles.filter((path) => !allowed.has(path)) : [];
  const contextFiles = unique([...closure.files, ...closure.importers, ...closure.platformContext]);
  const reasons = [];
  let escalateTo = null;
  if (closure.missing.length) {
    reasons.push(`the defect names module(s) the tree does not contain: ${closure.missing.join(", ")}`);
    escalateTo = "owner_module_regeneration";
  }
  if (strategy === "exact_owning_file_repair" && outsideBoundary.length) {
    reasons.push(`the exact boundary cannot reach the module(s) that bind the contracted control(s): ${outsideBoundary.join(", ")}`);
    escalateTo = escalateTo || "causal_dependency_repair";
  }
  return {
    feasible: reasons.length === 0,
    reasons,
    escalateTo: escalateTo && REPAIR_STRATEGY_ORDER.indexOf(escalateTo) > REPAIR_STRATEGY_ORDER.indexOf(strategy) ? escalateTo : null,
    closure,
    contextFiles,
    outsideBoundary,
    missingModules: closure.missing,
  };
}

// ── the gate ───────────────────────────────────────────────────────────────────────────────────

/**
 * Decide one repair round: which defects an application repair may address, which are withheld and
 * why, and whether the strategy must widen before dispatch.
 */
export function governRepairRound({ tree, defects = [], boundary = null, strategy = REPAIR_STRATEGY_ORDER[0] } = {}) {
  const decisions = (defects || []).map((defect) => ({ defect, ...classifyRepairOwnership(defect, { tree }) }));
  const dispatchable = decisions.filter((row) => row.ownership === REPAIR_OWNERSHIP.GENERATED_APP && row.defect.tier !== REPAIR_TIER.NONE);
  const withheld = decisions.filter((row) => !dispatchable.includes(row) && row.defect.owner !== DEFECT_OWNER.PLATFORM);
  const feasibility = dispatchable.length
    ? repairFeasibility({ tree, defects: dispatchable.map((row) => row.defect), boundary, strategy })
    : null;
  const ownershipCounts = Object.fromEntries(Object.values(REPAIR_OWNERSHIP)
    .map((ownership) => [ownership, decisions.filter((row) => row.ownership === ownership).length])
    .filter(([, count]) => count > 0));
  const dominantWithheld = Object.entries(ownershipCounts)
    .filter(([ownership]) => ownership !== REPAIR_OWNERSHIP.GENERATED_APP)
    .sort((left, right) => right[1] - left[1])[0]?.[0] || null;
  return {
    dispatchable: dispatchable.map((row) => row.defect),
    withheld: withheld.map((row) => ({ code: row.defect.code, journeyId: row.defect.journeyId || null,
      stepIndex: row.defect.stepIndex ?? null, ownership: row.ownership, reason: row.reason })),
    ownershipCounts,
    // The stop reason when nothing may be dispatched: named after who owns the dominant defect.
    stopReason: dispatchable.length ? null : `repair_withheld_${dominantWithheld || REPAIR_OWNERSHIP.UNDETERMINED}`,
    feasibility,
    escalateTo: feasibility?.escalateTo || null,
    contextFiles: feasibility?.contextFiles || [],
  };
}

// ── stalls ─────────────────────────────────────────────────────────────────────────────────────

/**
 * A defect that survived the exact AND the causal strategy unchanged is not answered by regenerating
 * its owner unless the evidence still says the owner is where the defect lives. When the contracted
 * control is bound in the tree and was operated (the failure is the outcome, not the control), two
 * scoped repairs that changed nothing say the defect is not in that module: it is reclassified as
 * undetermined - a contract expectation or a verifier reading to review - and stops spending.
 * When the control is bound nowhere, the owner is provably incomplete and regeneration is justified.
 */
export function reclassifyStalledDefects(defects = [], { tree = null, strategiesTried = [] } = {}) {
  const exhaustedScoped = ["exact_owning_file_repair", "causal_dependency_repair"]
    .every((strategy) => strategiesTried.includes(strategy));
  const reclassified = [];
  const next = (defects || []).map((defect) => {
    if (!exhaustedScoped || defect.owner === DEFECT_OWNER.PLATFORM || defect.tier === REPAIR_TIER.NONE) return defect;
    const control = defect.control?.id ? defect.control : null;
    if (!control) return defect; // no identity evidence: the ladder keeps its existing escalation
    const sites = bindingSitesOf(tree, control);
    const operated = defect.evidence?.drove === true || defect.defectClass === DEFECT_CLASS.BEHAVIOUR
      || defect.defectClass === DEFECT_CLASS.DURABILITY;
    if (!sites.length) {
      return { ...defect, repairOwnership: REPAIR_OWNERSHIP.GENERATED_APP,
        repairOwnershipReason: "the contracted control is bound nowhere in the tree: the owner is incomplete" };
    }
    if (!operated) return defect;
    const row = {
      ...defect, owner: DEFECT_OWNER.UNKNOWN, tier: REPAIR_TIER.NONE,
      repairOwnership: REPAIR_OWNERSHIP.UNDETERMINED,
      repairOwnershipReason: `the control is bound (${sites.map((site) => site.file).join(", ")}) and was operated; `
        + "an exact and a causal repair left the outcome unchanged, so the defect is not in those modules: "
        + "review the contracted expectation and the verifier's reading before spending further repairs",
    };
    reclassified.push({ code: defect.code, journeyId: defect.journeyId || null, stepIndex: defect.stepIndex ?? null,
      control: control.id, ownership: row.repairOwnership, reason: row.repairOwnershipReason });
    return row;
  });
  return { defects: next, reclassified };
}
