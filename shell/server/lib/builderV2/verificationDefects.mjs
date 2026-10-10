// TYPED VERIFICATION DEFECTS — what the browser proved, in the shape a repair can act on.
//
// WHY THIS EXISTS
//
// Ten paid qualifications ended red and not one of them was turned green by a repair round. The
// evidence was never the problem: the probe already knew a control carried no machine identity,
// the failing step already kept the page's own text and console, and attribution already knew
// which modules own the failed journey. All three were written to objects nothing downstream
// read, and the repair was briefed with a sentence instead.
//
// So the verifier's observations are normalised ONCE, here, into typed defects that carry four
// things a fixer needs and prose cannot supply:
//
//   CLASS    interaction / behaviour / durability / platform / contract / unknown
//   OWNER    app / platform / unknown — who has to change for this to go green
//   ADDRESS  the control id and logical field, the journey, the step, the owning modules
//   TIER     correction (addressed structural fix) / repair (model round) / none
//
// TWO RULES THIS FILE MAY NOT BREAK.
//
// 1. UNKNOWN STAYS UNKNOWN. A defect whose ownership the evidence does not settle is owned by
//    `unknown` and says so. Silently calling it an app defect is how a platform bug becomes a
//    customer's red build, and it is the mistake runs #3-#6 were made of.
// 2. UNKNOWN IS NOT BROKEN. An observation that does not prove a defect — a control reached by
//    its contracted name rather than its identity, a control not mounted on entry — is attached
//    as EVIDENCE to a defect the browser actually proved. It never becomes a defect on its own.
//
// Pure and deterministic: no network, no model, no clock. The browser decides what happened;
// this decides only how to describe it.

import crypto from "node:crypto";
import { sourceContractDigest } from "./executionProvenance.mjs";

import { interactionFailureDiagnostics } from "./interactionContract.mjs";
import { PROTECTED_PATHS } from "./patchEngine.mjs";
import { CAPABILITY_CONFIGURATION_PATH, COMPOSED_ROOT } from "./capabilityComposer.mjs";
import { journeySurfaceContext } from "./surfaceIntegration.mjs";
import { routeScaffoldDefect, SCAFFOLD_REPAIR_CLASS } from "./scaffoldRepairRouting.mjs";
import {
  BYPASSED_VERIFIER_POLICY,
  LEGACY_RICH_VERIFIER_POLICY,
  MINIMAL_CONTRACT_VERIFIER_POLICY,
  SMOKE_VERIFIER_POLICY,
  VERIFICATION_RESULT_CLASS,
  isAppRepairableVerificationClass,
} from "../appBuild/verifierPolicy.mjs";
import { SEVERITY, verifierCheckSeverity } from "./validationSeverity.mjs";

export const DEFECT_CLASS = Object.freeze({
  INTERACTION: "interaction",   // the browser could not operate a contracted control
  BEHAVIOUR: "behaviour",       // the control was operated and the contracted outcome did not appear
  DURABILITY: "durability",     // a durable record was not created, recovered or retired
  PLATFORM: "platform",         // the verification platform itself failed
  CONTRACT: "contract",         // the derived contract/plan could not be executed
  UNKNOWN: "unknown",           // the evidence does not settle what went wrong
});

export const DEFECT_OWNER = Object.freeze({
  APP: "app",
  PLATFORM: "platform",
  UNKNOWN: "unknown",
});

export const REPAIR_TIER = Object.freeze({
  CORRECTION: "correction",     // an addressed structural fix; draws on the correction allowance
  REPAIR: "repair",             // a browser-informed model round
  NONE: "none",                 // nothing an application patch can fix
});
export const VERIFICATION_DEFECT_VERSION = 1;
const fingerprint = (value) => crypto.createHash("sha256")
  .update(JSON.stringify(value ?? null)).digest("hex");

// Flow kinds whose subject is a durable record rather than a screen transition.
const DURABLE_KINDS = new Set(["mutation", "cancellation", "recovery", "lookup"]);
// Flow kinds that only move a record's lifecycle on when the control was actually operated.
const MUTATION_KINDS = new Set(["mutation", "cancellation"]);

const unique = (values) => [...new Set((values || []).filter(Boolean))];
// Generated application source only. The platform runtime a capability lives in is never a repair
// target — the patch engine refuses to write it, so naming it in a boundary would only ever waste
// an attempt on a file the model is not allowed to touch.
const generatedSource = (path) => typeof path === "string"
  && /^src\/.+\.(?:jsx?|tsx?|css)$/.test(path)
  && !PROTECTED_PATHS.some((pattern) => pattern.test(path));

// ── runtime crash evidence ──────────────────────────────────────────────────────────────────────
//
// The smoke gate proves exactly one thing: the application threw (or went blank) in a real
// browser. That is the application's defect and a repair can act on it, but only if the brief says
// WHERE. The page error carries a message and sometimes a stack; the generated file that holds the
// failing identifier is found here by a plain word-boundary search of the tree, no AST and no model.

const CRASH_PATTERNS = Object.freeze([
  /([\w$]+(?:\.[\w$]+)*)\s+is not (?:defined|a function|a constructor|iterable|an object)/g,
  /Cannot (?:read|set) propert(?:y|ies) of (?:undefined|null) \((?:reading|setting) '([^']+)'\)/g,
  /Cannot access '([^']+)' before initialization/g,
  /does not provide an export named '([^']+)'/g,
  /(?:for|of|named|entity|store|property|key|field)\s+["'`]?([A-Za-z_$][\w$]{2,})["'`]?\s*$/g,
  /['"`]([A-Za-z_$][\w$]{2,})['"`]/g,
  // camelCase / PascalCase / snake_case identifiers are specific enough to search for unprompted.
  /\b([a-z][a-z0-9]*(?:[A-Z][A-Za-z0-9]*)+|[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+|[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+)\b/g,
]);
const GENERIC_TOKEN = /^(?:\w*Error|Uncaught|undefined|null|NaN|Object|Array|Promise|Symbol|Function|String|Number|Boolean|true|false|length|constructor|prototype|toString|default|module|exports|React|ReactDOM)$/;
// A token found in more files than this names a habit of the codebase, not a cause.
const CRASH_TOKEN_FILE_CAP = 4;
const CRASH_FILE_CAP = 6;

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Identifiers worth searching the tree for, taken from a runtime error message. */
export function crashIdentifiers(message) {
  const text = String(message || "").slice(0, 600);
  const tokens = [];
  for (const pattern of CRASH_PATTERNS) {
    for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
      for (const part of String(match[1] || "").split(".")) {
        if (part.length >= 3 && !GENERIC_TOKEN.test(part) && !tokens.includes(part)) tokens.push(part);
      }
    }
  }
  return tokens.slice(0, 8);
}

/**
 * The generated files a runtime crash points at: the source files named by the stack frames, then
 * the files that contain a token from the error message (with the first line each appears on).
 */
export function crashSourceEvidence(tree, crash = null) {
  const message = String(crash?.message || "");
  const stackFiles = unique((crash?.sourceFiles || []).filter((path) => generatedSource(path)
    && typeof tree?.[path] === "string"));
  const tokens = crashIdentifiers(message);
  const hits = [];
  if (tree && tokens.length) {
    const sources = Object.entries(tree).filter(([path, source]) => generatedSource(path) && typeof source === "string");
    for (const token of tokens) {
      const pattern = new RegExp(`(?<![\\w$])${escapeRegExp(token)}(?![\\w$])`);
      const matching = sources.filter(([, source]) => pattern.test(source));
      if (!matching.length || matching.length > CRASH_TOKEN_FILE_CAP) continue;
      for (const [path, source] of matching) {
        const rows = source.split("\n");
        const line = rows.findIndex((row) => pattern.test(row)) + 1;
        // A token passed as a string argument (entityStore("x"), repository("x")) is the call
        // site the message is about, far more than a variable or comment that merely shares it.
        const quoted = rows.some((row) => new RegExp(`["'\`]${escapeRegExp(token)}["'\`]`).test(row));
        hits.push({ path, line, token, quoted });
      }
    }
  }
  // Files matching the most distinct tokens (a quoted call-site argument counts triple) come first.
  // A distinctive identifier (camelCase, PascalCase, snake_case) outranks a plain word such as
  // "open" or "rooms": the plain word is only searched for when no distinctive one matched anywhere.
  const distinctive = (token) => /[a-z][A-Z]|_|^[A-Z][a-z0-9]+[A-Z]/.test(token);
  const usable = hits.some((hit) => distinctive(hit.token)) ? hits.filter((hit) => distinctive(hit.token)) : hits;
  const score = new Map();
  for (const hit of usable) score.set(hit.path, (score.get(hit.path) || 0) + (hit.quoted ? 3 : 1));
  const tokenFiles = [...score.keys()].sort((a, b) => score.get(b) - score.get(a) || a.localeCompare(b));
  return {
    tokens,
    hits: usable.slice(0, 12),
    stackFiles,
    files: unique([...stackFiles, ...tokenFiles]).slice(0, CRASH_FILE_CAP),
  };
}

/** The contracted flows a step drives, if the interaction contract knows about them. */
function flowsForStep(interactionContract, journeyId, stepIndex) {
  return (interactionContract?.flows || [])
    .filter((flow) => flow.journeyId === journeyId && flow.stepIndex === stepIndex);
}

const semanticControlKey = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Resolve a failed secondary-journey setup control back to its primary producer. */
function prerequisiteProducerFlow(contract, interactionContract, namedControl) {
  const wanted = semanticControlKey(namedControl);
  if (!wanted) return null;
  const flows = [
    ...(contract?.prerequisiteInteractionContract?.flows || []),
    ...(interactionContract?.flows || []),
  ];
  return flows.find((flow) => flow?.control && [
    flow.control.logicalField,
    flow.control.accessibleName,
    flow.control.purpose,
    ...(flow.control.accessibleNames || []),
  ].some((identity) => semanticControlKey(identity) === wanted)) || null;
}

/**
 * The probe's addressing evidence for one control id.
 *
 * `identity_absent` is the exact shape that ended run #8: a hand-wired control the probe could
 * only reach through a contract-supplied name, therefore invisible to every identity-addressed
 * path. It proves nothing on its own — a name-addressed control that works is a working control —
 * so it is only ever attached to a defect the browser separately proved.
 */
function addressingFor(mechanics, controlId) {
  if (!controlId) return null;
  const outcome = (mechanics?.outcomes || []).find((row) => row.id === controlId);
  const skip = (mechanics?.skipped || []).find((row) => row.id === controlId);
  const reason = outcome?.outcome || skip?.reason || null;
  if (!reason) return null;
  return {
    reason,
    detail: outcome?.detail || skip?.detail
      || (skip?.candidates ? `${skip.candidates} visible candidates` : null),
    addressedBy: skip?.addressedBy || outcome?.addressedBy || null,
  };
}

/** A control's identity and business name, from the manifest the browser was never given. */
function controlIdentity(manifest, flows, mechanicsId = null) {
  const mapping = manifest?.mapping || {};
  const id = mechanicsId
    || flows.map((flow) => flow.control?.machineId).find(Boolean)
    || null;
  const logicalField = (id && mapping[id]?.logicalField)
    || flows.map((flow) => flow.control?.logicalField).find(Boolean)
    || null;
  return id || logicalField ? { id, logicalField } : null;
}

/**
 * Where a repair for this defect has to be written. Structured attribution first — the journey's
 * owning modules and the flow's declared state owners — never a path scraped out of prose.
 */
function modulesFor(diagnostic, journey) {
  const renderedOwners = (diagnostic?.renderedControlFacts || [])
    .map((control) => control?.file)
    .filter(generatedSource);
  const attributed = [
    ...(diagnostic?.stateOwners || []),
    ...(diagnostic?.responsibleModules || []),
    ...renderedOwners,
  ];
  // A composed capability owns the state, but its implementation is deliberately not a repair
  // address. Route integration/configuration corrections to the one bounded model-owned seam and
  // retain the journey UI owner alongside it. This keeps the verifier's attribution useful
  // without ever inviting a model to patch proven capability internals.
  const capabilityConfiguration = attributed.some((path) => (
    typeof path === "string" && path.startsWith(`${COMPOSED_ROOT}/`)
  )) ? [CAPABILITY_CONFIGURATION_PATH] : [];
  return unique([
    ...attributed,
    ...capabilityConfiguration,
    ...(journey?.owners || []),
  ].filter(generatedSource));
}

const failingCheckKind = (check) => (typeof check === "string" ? check : String(check?.kind || ""));

function failingVerifierChecks(step) {
  return (Array.isArray(step?.checks) ? step.checks : [])
    .filter((check) => check && check.ok === false && check.kind)
    .map((check) => (check.inconclusive === true
      ? { kind: String(check.kind), inconclusive: true }
      : String(check.kind)));
}

function advisoryVerifierChecksOnly(checks) {
  return checks.length > 0 && checks.every((check) => (
    check?.inconclusive !== true
    && verifierCheckSeverity(failingCheckKind(check)) === SEVERITY.ADVISORY
  ));
}

/**
 * Whether this step's result may spend an application repair.
 *
 * Named per policy. Smoke and a bypassed preview never repair: they carry no contracted
 * outcome a patch can answer. The minimal contract policy repairs only a class the verifier
 * called an application failure, plus an unexposed contracted selection value. Every other
 * policy is not repairable merely because it is not minimal — a named non-application class
 * stays withheld. Only a historical verdict that recorded no class at all (legacy rich, or
 * evidence from before classes existed) remains repairable by default.
 */
function repairableVerificationResult({ policy, resultClass, selectionValueMissing = false } = {}) {
  if (policy === SMOKE_VERIFIER_POLICY || policy === BYPASSED_VERIFIER_POLICY) return false;
  const classRepairable = isAppRepairableVerificationClass(resultClass) || selectionValueMissing === true;
  if (policy === MINIMAL_CONTRACT_VERIFIER_POLICY) return classRepairable;
  if (!resultClass && (policy == null || policy === LEGACY_RICH_VERIFIER_POLICY)) return true;
  return classRepairable;
}

/**
 * Classify one failing step.
 *
 * `drove` is the discriminator that matters and the browser already records it: a step that never
 * operated its control is an INTERACTION defect (run #7's dead inputs, run #8's dead chooser),
 * while a step that operated the control and did not get the contracted outcome is BEHAVIOUR —
 * or, when the contract says the step's subject is a durable record, DURABILITY (run #9's refused
 * commit, run #10's booking that did not survive a reload).
 */
function classifyStep({ status, drove, kinds }) {
  if (status === "undriveable") return DEFECT_CLASS.INTERACTION;
  const durable = kinds.some((kind) => DURABLE_KINDS.has(kind));
  if (!durable) return DEFECT_CLASS.BEHAVIOUR;
  // A mutation the browser never managed to trigger is not evidence about durability.
  if (kinds.every((kind) => MUTATION_KINDS.has(kind)) && drove === false) return DEFECT_CLASS.INTERACTION;
  return DEFECT_CLASS.DURABILITY;
}

/**
 * The browser found the contracted selection group, enumerated its live options and proved that
 * none exposes the contract's exact fixture as text, label or value. That is not an uncertain
 * driver failure: the generated option surface omitted the machine-readable domain value. The
 * mounted application can repair it (for example, a card button exposes value={item.id}).
 */
function selectionFixtureIsUnexposed(step, status) {
  const evidence = step?.controlEvidence;
  if (status !== "undriveable" || evidence?.fixtureAuthority !== "contract"
    || evidence?.verificationValue === undefined || evidence?.verificationValue === null
    || !Array.isArray(evidence?.selectedOptions) || !evidence.selectedOptions.length) return false;
  const expected = String(evidence.verificationValue).trim().toLowerCase();
  const exposed = evidence.selectedOptions.some((option) => [option?.value, option?.label, option?.text]
    .filter((value) => value !== undefined && value !== null)
    .some((value) => String(value).trim().toLowerCase() === expected));
  return !exposed && /not an available option/i.test(String(step?.detail || ""));
}

/**
 * Every defect this verification run proved, typed and addressed.
 *
 * @returns {Array<object>} deterministic order: platform first (they invalidate everything after
 *   them), then journey defects in journey/step order, then unattached mechanics defects.
 */
export function verificationDefects({
  contract, interactionContract = contract?.interactionContract, journeyResults,
  tree = null, backendRowFailures = [], manifest = null,
} = {}) {
  const verdicts = journeyResults || { journeys: [] };
  if (verdicts.executionProvenance?.sourceContractDigest
      && verdicts.executionProvenance.sourceContractDigest !== sourceContractDigest(contract)) return [{
    code: "verification_evidence_contract_mismatch", defectClass: DEFECT_CLASS.CONTRACT,
    owner: DEFECT_OWNER.PLATFORM, tier: REPAIR_TIER.NONE,
    journeyId: null, stepIndex: null, action: null, control: null, modules: [],
    evidence: { observed: "retained browser evidence belongs to a different execution contract; fresh verification is required" },
  }];
  const policy = verdicts.verifierPolicy || null;
  const minimal = policy === MINIMAL_CONTRACT_VERIFIER_POLICY;
  const journeysById = new Map((verdicts.journeys || []).map((journey) => [journey.id, journey]));
  const mechanics = verdicts.mechanics || null;
  const defects = [];
  const mountedSurfaceFor = (journeyId) => {
    if (!tree || !journeyId) return null;
    const context = journeySurfaceContext(tree, contract, [journeyId]);
    if (!context.unreachableJourneyModules.length) return null;
    return {
      routePaths: context.routePaths,
      routeFiles: context.routeFiles,
      mountedPaths: context.mountedPaths,
      unreachableJourneyModules: context.unreachableJourneyModules,
    };
  };

  // ── platform ────────────────────────────────────────────────────────────────────────────────
  // A verifier that could not run, a driver that threw, a failed journey with no owning module.
  // None of these are claims about the application and none may spend an application's repair
  // allowance; they are reported so the run ends inconclusive rather than red.
  for (const defect of verdicts.verifierDefects || []) {
    defects.push({
      code: defect.code || "journey_verifier_defect",
      defectClass: DEFECT_CLASS.PLATFORM, owner: DEFECT_OWNER.PLATFORM, tier: REPAIR_TIER.NONE,
      journeyId: defect.journeyId || null, stepIndex: defect.stepIndex ?? null,
      action: defect.action || null, control: null, modules: [],
      evidence: { observed: defect.detail || "the verification platform failed" },
    });
  }
  if (verdicts.unavailable) {
    defects.push({
      code: "journey_verifier_unavailable",
      defectClass: DEFECT_CLASS.PLATFORM, owner: DEFECT_OWNER.PLATFORM, tier: REPAIR_TIER.NONE,
      journeyId: null, stepIndex: null, action: null, control: null, modules: [],
      evidence: { observed: verdicts.verifierError || verdicts.error || "the browser verifier was unavailable" },
    });
  }
  for (const journey of verdicts.journeys || []) {
    if (!journey.attributionDefect) continue;
    defects.push({
      code: journey.attributionDefect.code || "journey_ownership_missing",
      defectClass: DEFECT_CLASS.PLATFORM, owner: DEFECT_OWNER.PLATFORM, tier: REPAIR_TIER.NONE,
      journeyId: journey.id, stepIndex: null, action: null, control: null,
      // The bounded fallback is the one thing a repair CAN use when attribution missed.
      modules: unique((journey.fallbackRefs || []).filter(generatedSource)),
      failureRefs: unique(journey.fallbackRefs || []),
      evidence: { observed: journey.attributionDefect.message || "failed journey attributed to no owning module" },
    });
  }

  // ── unmet prerequisites ─────────────────────────────────────────────────────────────────────
  //
  // A journey whose required starting state could not be established never tested the app — and
  // for a while this file called that "context, never an actionable app defect". That was wrong,
  // and it cost a whole production build: six contracted journeys came back `not_reached`, every
  // one of them for the same reason —
  //
  //     the journey's required starting state could not be established
  //     (new project control: no contracted control matched)
  //
  // — and because the defect was filed as tier NONE, `actionableDefects` was empty and the repair
  // tier broke out before its first round. Six journeys, one missing control, zero attempts to
  // build it.
  //
  // A prerequisite that names a CONTROL the browser could not find is the same claim as any other
  // undriveable contracted control: something the contract requires is not there, or is there and
  // unaddressable. Which of those it is remains UNKNOWN — that part was right — but unknown
  // ownership is not a reason to leave it unrepaired.
  for (const journey of verdicts.journeys || []) {
    if (journey.setup?.ok !== false) continue;
    if (journey.setup.planningIssues?.length) {
      defects.push({ code: "prerequisite_contract_invalid", defectClass: DEFECT_CLASS.CONTRACT,
        owner: DEFECT_OWNER.PLATFORM, tier: REPAIR_TIER.NONE,
        journeyId: journey.id, stepIndex: null, action: null, control: null, modules: [],
        evidence: { observed: journey.setup.failure?.reason, planningIssues: journey.setup.planningIssues } });
      continue;
    }
    const named = journey.setup.failure?.control || null;
    const setupReason = String(journey.setup.failure?.reason || "");
    const producer = journey.setup.failure?.producerInteractionId
      ? (contract?.prerequisiteInteractionContract || interactionContract)?.flows?.find((flow) =>
        flow.id === journey.setup.failure.producerInteractionId)
      : prerequisiteProducerFlow(contract, interactionContract, named);
    // This reason is emitted only after setup found and activated the exact durable mutation.
    // It is concrete application evidence and belongs to the producing control's modules, not
    // to the secondary journey that was waiting for that record.
    const activatedDurableMutation = minimal && (producer?.kind === "mutation"
      || ["create", "update", "remove"].includes(producer?.durableOperation))
      && /durable mutation did not reach its contracted observable state|no entered value or new durable reference was committed/i
        .test(setupReason);
    const producerModules = producer ? unique([
      producer.stateOwner,
      producer.control?.stateOwner,
      ...(producer.responsibleModules || []),
    ]).filter(generatedSource) : [];
    defects.push({
      code: activatedDurableMutation ? "prerequisite_durable_outcome_missing"
        : named ? "journey_prerequisite_control_missing" : (journey.setup.code || "journey_prerequisites_unmet"),
      // Named control → an interaction defect a patch can answer. Unnamed → genuinely nothing to
      // aim at, so it stays context.
      defectClass: activatedDurableMutation ? DEFECT_CLASS.BEHAVIOUR
        : minimal ? DEFECT_CLASS.PLATFORM : (named ? DEFECT_CLASS.INTERACTION : DEFECT_CLASS.CONTRACT),
      owner: activatedDurableMutation ? DEFECT_OWNER.APP
        : minimal ? DEFECT_OWNER.PLATFORM : DEFECT_OWNER.UNKNOWN,
      tier: activatedDurableMutation ? REPAIR_TIER.REPAIR
        : minimal ? REPAIR_TIER.NONE : (named ? REPAIR_TIER.REPAIR : REPAIR_TIER.NONE),
      uncertain: activatedDurableMutation ? undefined : true, downstream: !named,
      prerequisite: true,
      blockedJourneyId: producer ? journey.id : undefined,
      journeyId: producer ? producer.journeyId : journey.id,
      stepIndex: producer ? producer.stepIndex : null,
      action: producer ? producer.action : null,
      control: producer
        ? { id: producer.control?.machineId || null,
          logicalField: producer.control?.logicalField || producer.control?.accessibleName || named }
        : named ? { id: null, logicalField: named } : null,
      modules: producer
        ? producerModules : unique((journey.owners || []).filter(generatedSource)),
      failureRefs: producer ? producerModules
        : unique([...(journey.owners || []), ...(journey.fallbackRefs || [])]),
      evidence: {
        expected: activatedDurableMutation ? producer.observable || null : null,
        observed: setupReason || "the journey's starting state could not be established",
      },
    });
  }

  // ── journey steps ───────────────────────────────────────────────────────────────────────────
  // Built ON the existing structured diagnostics so state ownership, rendered-control facts and
  // attempted locators arrive already derived; this layer adds the type, the address and the
  // evidence the diagnostics never carried.
  const diagnostics = interactionFailureDiagnostics({ contract, interactionContract, journeyResults: verdicts, tree });
  const coveredControls = new Set();
  for (const diagnostic of diagnostics) {
    const journey = journeysById.get(diagnostic.journeyId) || null;
    const step = (journey?.steps || [])[diagnostic.stepIndex] || null;
    const flows = flowsForStep(interactionContract, diagnostic.journeyId, diagnostic.stepIndex);
    const kinds = unique(flows.map((flow) => flow.kind));
    const status = String(diagnostic.status || step?.status || "").toLowerCase();
    const resultClass = step?.classification || null;
    const platformInconclusive = minimal
      && resultClass === VERIFICATION_RESULT_CLASS.PLATFORM_INCONCLUSIVE;
    // A step whose contract states no structured outcome is a contract gap: not repairable, not
    // the platform's fault, and never a behaviour defect of the application.
    const contractIncomplete = minimal
      && resultClass === VERIFICATION_RESULT_CLASS.CONTRACT_INCOMPLETE;
    const appSelectionValueMissing = platformInconclusive && selectionFixtureIsUnexposed(step, status);
    const repairableResult = repairableVerificationResult({
      policy, resultClass, selectionValueMissing: appSelectionValueMissing,
    });
    const defectClass = resultClass === VERIFICATION_RESULT_CLASS.PERSISTENCE_FAILURE
      ? DEFECT_CLASS.DURABILITY
      : contractIncomplete ? DEFECT_CLASS.CONTRACT
      : platformInconclusive && !appSelectionValueMissing ? DEFECT_CLASS.PLATFORM
        : classifyStep({ status, drove: step?.drove, kinds });
    const control = controlIdentity(manifest, flows);
    const addressing = addressingFor(mechanics, control?.id);
    // A control the probe PROVED cannot hold a value is an addressed structural defect: the
    // correction allowance answers it, and it must not spend the browser-informed repair slot.
    const proven = (mechanics?.failures || []).find((row) => row.id && row.id === control?.id) || null;
    if (proven) coveredControls.add(proven.id);
    // Ambiguity is the one addressing outcome that does not say whose fault it is: the same id
    // matching several visible elements can be the app naming two controls alike or the platform
    // addressing them too loosely. It stays unknown rather than being charged to the app.
    const ambiguous = addressing?.reason === "ambiguous_identity";
    // Exact runtime contract failure remains repairable even when the page exposes duplicates.
    // The ambiguity is useful evidence and keeps ownership unknown, but it cannot demote a
    // browser-classified application interaction defect into an unrepairable platform stop.
    const inconclusiveAddressing = minimal && ambiguous
      && !isAppRepairableVerificationClass(resultClass)
      && !appSelectionValueMissing;
    const surfaceIntegration = mountedSurfaceFor(diagnostic.journeyId);
    const causalSurfaceModules = surfaceIntegration ? unique([
      ...surfaceIntegration.routeFiles,
      ...surfaceIntegration.mountedPaths,
      ...surfaceIntegration.unreachableJourneyModules,
    ]).filter(generatedSource) : [];
    const failingChecks = failingVerifierChecks(step);
    // A miss that is only declared visible text is not something a repair round can honestly fix.
    // Blocking checks still present keep the normal tier.
    const advisoryOnly = advisoryVerifierChecksOnly(failingChecks);
    defects.push({
      code: proven ? "control_cannot_hold_value"
        : status === "undriveable" ? "contracted_control_undriveable"
        : defectClass === DEFECT_CLASS.DURABILITY ? "durable_outcome_missing"
        : "contracted_outcome_missing",
      defectClass: proven ? DEFECT_CLASS.INTERACTION : defectClass,
      owner: (platformInconclusive && !appSelectionValueMissing) || contractIncomplete || inconclusiveAddressing ? DEFECT_OWNER.PLATFORM
        : (ambiguous ? DEFECT_OWNER.UNKNOWN : DEFECT_OWNER.APP),
      uncertain: ambiguous || undefined,
      tier: (advisoryOnly && !proven) || (platformInconclusive && !appSelectionValueMissing) || inconclusiveAddressing || !repairableResult ? REPAIR_TIER.NONE
        : (proven ? REPAIR_TIER.CORRECTION : REPAIR_TIER.REPAIR),
      journeyId: diagnostic.journeyId, stepIndex: diagnostic.stepIndex,
      action: diagnostic.userAction, control,
      modules: unique([...causalSurfaceModules, ...modulesFor(diagnostic, journey)]),
      failureRefs: unique([
        ...causalSurfaceModules,
        ...(diagnostic.failureRefs || []),
        ...(diagnostic.renderedControlFacts || []).map((control) => control?.file).filter(generatedSource),
        ...(journey?.owners || []), ...(journey?.fallbackRefs || []),
      ]),
      evidence: {
        expected: diagnostic.expectedStateAfter || null,
        observed: diagnostic.actualObservedState || null,
        drove: step?.drove ?? null,
        failingChecks,
        // Collection verification already distinguishes "the action did not run" from "the
        // durable row exists but the mounted collection still renders no matching member". Keep
        // that distinction through repair dispatch; dropping it made repeated rounds rewrite a
        // working mutation while leaving the actual state/filter/render seam untouched.
        collectionMembership: step?.controlEvidence?.collectionMembership || null,
        // A dependent step can race an unfinished async action when the prior step's expected text
        // was already on screen. The browser records that as an advisory. Carry the bounded causal
        // history so repair can remove the pre-existing outcome or publish/await the real state
        // transition instead of treating the downstream symptom as an isolated render failure.
        journeyAdvisories: (journey?.steps || []).slice(0, diagnostic.stepIndex + 1)
          .flatMap((candidate, index) => (candidate?.advisories || []).map((advisory) => ({
            stepIndex: index,
            code: advisory?.code || null,
            detail: advisory?.detail || null,
          }))),
        // Preserve the exact option the browser operated. A selected-state failure without this
        // value only tells repair to add styling; it hides cross-module domain mismatches where a
        // handler receives a real option id but an adapter returns an empty/foreign state value.
        selectionAttempt: step?.selectedValue !== undefined && step?.selectedValue !== null
          ? {
            field: step?.controlEvidence?.contractedField || control?.logicalField || null,
            value: step.selectedValue,
            text: step?.selectedText || null,
            fixtureAuthority: step?.controlEvidence?.fixtureAuthority || null,
            optionStates: (step?.controlEvidence?.selectedOptions || []).slice(0, 12).map((option) => ({
              value: option?.value ?? null,
              label: option?.label ?? null,
              text: option?.text ?? null,
              selected: option?.selected === true,
            })),
          }
          : null,
        // WHAT THE PAGE ITSELF SAID. Captured for every failing step since run #9 and, until now,
        // read only by a human after the money was spent.
        pageText: step?.observation?.text || null,
        consoleErrors: step?.observation?.consoleSince || [],
        failedRequests: step?.observation?.requestsSince || [],
        attemptedLocators: diagnostic.attemptedLocators || [],
        addressing: addressing || null,
        mechanics: proven
          ? { expected: proven.expected, observed: proven.observed, detail: proven.detail }
          : null,
        entityBefore: journey?.backendEvidence?.before || null,
        entityAfter: journey?.backendEvidence?.after || null,
        entityDiff: journey?.backendEvidence?.entityDiff || journey?.backendEvidence?.diff || null,
        surfaceIntegration,
      },
      diagnostic,
    });
  }

  // ── a red journey that produced no per-step evidence ────────────────────────────────────────
  // The browser ran and the contracted journey did not pass, but nothing said which step or why.
  // That is still a defect and still has to be briefed — what it is NOT is a defect anyone can
  // name, so its class and its owner both stay unknown rather than being invented.
  const journeysWithSteps = new Set(diagnostics.map((row) => row.journeyId));
  const smoke = policy === SMOKE_VERIFIER_POLICY;
  // A journey with no step evidence is repairable only for the historical policies that
  // recorded failures that way. Minimal, smoke, bypass, and any unnamed future policy are not.
  const unnamedJourneyRepairable = !minimal && !smoke && policy !== BYPASSED_VERIFIER_POLICY
    && (policy == null || policy === LEGACY_RICH_VERIFIER_POLICY);
  for (const journey of verdicts.journeys || []) {
    if (["pass", "reused"].includes(journey.status) || journeysWithSteps.has(journey.id)) continue;
    if (journey.setup?.ok === false) continue; // already reported as a prerequisite defect
    if (smoke) {
      // The smoke gate drives no contracted steps, so a red smoke verdict is exactly one thing: the
      // application crashed (or rendered nothing) in a real browser. That is the application's
      // defect and a repair CAN act on it: the thrown error is the expectation. It used to be filed
      // as tier NONE ("nothing to repair against"), which ended the build with no repair spent and,
      // on resume, briefed the crash as context rather than a defect. Only a verdict the smoke
      // itself marked as the platform's (an unreachable preview) stays non-repairable.
      const observed = journey.detail
        || "the application crashed or rendered nothing in the browser smoke test";
      const crash = journey.crash
        || (verdicts.smoke?.crashes || []).find((row) => row?.message) || null;
      const crashFacts = { ...(crash || {}), message: crash?.message
        || String(observed).replace(/^.*?(?:fatal runtime error (?:during load|after activation):\s*)/i, "") };
      const found = crashSourceEvidence(tree, crashFacts);
      const platformVerdict = journey.classification === VERIFICATION_RESULT_CLASS.PLATFORM_INCONCLUSIVE
        || journey.status === "undriveable";
      const owners = unique([...(journey.owners || []), ...(journey.fallbackRefs || [])]);
      defects.push({
        code: "fatal_runtime_crash",
        defectClass: DEFECT_CLASS.BEHAVIOUR, owner: DEFECT_OWNER.APP,
        tier: platformVerdict ? REPAIR_TIER.NONE : REPAIR_TIER.REPAIR,
        journeyId: journey.id, stepIndex: null, action: null, control: null,
        // The files the error actually names come first; the journey owners stay as the fallback.
        modules: unique([...found.files, ...owners.filter(generatedSource)]),
        failureRefs: unique([...found.files, ...owners]),
        evidence: {
          observed,
          crash: crash || found.tokens.length || found.files.length ? {
            phase: crash?.phase || null, control: crash?.control || null,
            message: crashFacts.message || null, stack: crash?.stack || [],
            sourceFiles: crash?.sourceFiles || [], tokens: found.tokens, hits: found.hits,
            files: found.files,
          } : null,
        },
      });
      continue;
    }
    defects.push({
      code: "journey_failed_without_step_evidence",
      defectClass: minimal ? DEFECT_CLASS.PLATFORM : DEFECT_CLASS.UNKNOWN,
      owner: minimal ? DEFECT_OWNER.PLATFORM : DEFECT_OWNER.UNKNOWN, uncertain: true,
      tier: unnamedJourneyRepairable ? REPAIR_TIER.REPAIR : REPAIR_TIER.NONE,
      journeyId: journey.id, stepIndex: null, action: null, control: null,
      modules: unique([...(journey.owners || []), ...(journey.fallbackRefs || [])].filter(generatedSource)),
      failureRefs: unique([...(journey.owners || []), ...(journey.fallbackRefs || [])]),
      evidence: {
        observed: `the contracted journey did not pass (status ${journey.status || "unknown"}) `
          + "and no per-step evidence was recorded",
      },
    });
  }

  // ── mechanics failures no failing step accounted for ────────────────────────────────────────
  // A dead control the journeys never reached is still a proven, addressed defect.
  for (const failure of mechanics?.failures || []) {
    if (minimal) continue;
    if (!failure.id || coveredControls.has(failure.id)) continue;
    const mapped = manifest?.mapping?.[failure.id] || null;
    const flows = (interactionContract?.flows || []).filter((flow) => flow.control?.machineId === failure.id);
    defects.push({
      code: "control_cannot_hold_value",
      defectClass: DEFECT_CLASS.INTERACTION, owner: DEFECT_OWNER.APP, tier: REPAIR_TIER.CORRECTION,
      journeyId: mapped?.journeyId || flows[0]?.journeyId || null, stepIndex: flows[0]?.stepIndex ?? null,
      action: null,
      control: { id: failure.id, logicalField: mapped?.logicalField || flows[0]?.control?.logicalField || null },
      modules: unique(flows.flatMap((flow) => [flow.stateOwner, ...(flow.responsibleModules || [])])
        .filter(generatedSource)),
      failureRefs: unique(flows.flatMap((flow) => [flow.stateOwner, ...(flow.responsibleModules || [])])),
      evidence: {
        expected: failure.expected, observed: failure.observed,
        mechanics: { expected: failure.expected, observed: failure.observed, detail: failure.detail },
        addressing: addressingFor(mechanics, failure.id),
      },
    });
  }

  // ── durable row checks ──────────────────────────────────────────────────────────────────────
  for (const failure of backendRowFailures || []) {
    const journey = journeysById.get(failure.journeyId) || null;
    defects.push({
      code: "durable_row_missing",
      defectClass: DEFECT_CLASS.DURABILITY, owner: DEFECT_OWNER.APP, tier: REPAIR_TIER.REPAIR,
      journeyId: failure.journeyId || null, stepIndex: null, action: null, control: null,
      modules: unique((journey?.owners || []).filter(generatedSource)),
      failureRefs: unique(journey?.owners || []),
      evidence: { observed: failure.detail || "the contracted durable row was not written" },
    });
  }

  return defects.map((defect) => {
    if (!contract?.scaffoldGraph || typeof tree?.["src/lib/scaffolds/composed/manifest.js"] !== "string") return defect;
    const scaffoldRouting = routeScaffoldDefect(defect, contract.scaffoldGraph);
    if (scaffoldRouting.classification === SCAFFOLD_REPAIR_CLASS.INTERNAL) {
      return { ...defect, owner: DEFECT_OWNER.PLATFORM, tier: REPAIR_TIER.NONE,
        modules: [], scaffoldRouting };
    }
    if (scaffoldRouting.repairableByModel && scaffoldRouting.targetFiles.length) {
      return { ...defect, modules: scaffoldRouting.targetFiles, scaffoldRouting };
    }
    return { ...defect, scaffoldRouting };
  });
}

/** Defects an application patch can actually answer. Platform and downstream context are not. */
export const actionableDefects = (defects = []) => defects
  .filter((defect) => defect.tier !== REPAIR_TIER.NONE && defect.owner !== DEFECT_OWNER.PLATFORM);

/** Defects that stop the run because the platform, not the app, failed. */
export const platformDefectsOf = (defects = []) => defects
  .filter((defect) => defect.owner === DEFECT_OWNER.PLATFORM);

/**
 * The repair brief.
 *
 * Two lines per defect, deliberately: the sentence the existing repair scoping parses for journey
 * and action, and one enriched `interaction_verification_failure` row carrying the type, the
 * address, the page's own account of the failure and the probe's addressing evidence. The row
 * keeps the code the downstream parsers already accept, so nothing has to re-learn the format.
 */
export function defectEvidence(defects = []) {
  const lines = [];
  const crashNarrated = new Set();
  for (const defect of actionableDefects(defects)) {
    if (defect.journeyId && defect.action) {
      lines.push(`journey ${defect.journeyId} · step "${defect.action}" FAILED in a real browser: `
        + `${defect.evidence?.observed || "expected outcome never appeared"}`);
    } else if (defect.prerequisite) {
      // Deliberately NOT phrased as "the required starting state could not be established": that
      // sentence is matched by the downstream-evidence filter and would be dropped from the brief
      // before the model ever saw it. This is a missing control, and it is named as one.
      lines.push(`journey ${defect.journeyId} could not START in a real browser: the contracted `
        + `"${defect.control?.logicalField}" control was not found on the app's entry surface `
        + `(${defect.evidence?.observed}). Every step of this journey is therefore unreachable. `
        + "Build that control where a first-time visitor can reach it, bind it so the verifier can "
        + "address it by its declared identity, and make the state it creates visible.");
    } else if (defect.control) {
      lines.push(`control ${defect.control.logicalField || defect.control.id} `
        + `(${defect.control.id || "no machine identity"}) failed its mechanics probe: `
        + `expected ${JSON.stringify(defect.evidence?.expected)}, observed ${JSON.stringify(defect.evidence?.observed)}`);
    }
    // The one defect class with a known remedy gets told the remedy. Named as a MECHANIC — the
    // model is being told a control cannot hold a value, never what the value would have meant.
    if (defect.code === "control_cannot_hold_value") {
      lines.push(`${defect.evidence?.mechanics?.detail || "the contracted control did not accept its interaction"} `
        + "— the control is present and located by its declared identity, so bind it so a typed value "
        + "lands in state and renders back: value + onChange writing through the setter, the capability "
        + "field binding, or an uncontrolled input with defaultValue.");
    }
    if (defect.evidence?.addressing?.reason === "ambiguous_identity") {
      lines.push(`${defect.evidence.addressing.matches || "Multiple"} visible controls share the declared `
        + `machine identity ${defect.control?.id || "for this field"}. Render exactly one active `
        + "journey-facing control with that identity. If the form is inside a repeated collection, "
        + "move the contracted form outside the repeated rows or render it only for the active row; "
        + "do not copy the same data-thrallo-control onto every row.");
    }
    if (/every contracted selection value was already selected/i.test(String(defect.evidence?.observed || ""))) {
      lines.push("the compound selection controls start in every contracted final value. Initialise at "
        + "least one control to a real non-target option so the browser can perform and observe the "
        + "contracted transition. Do not pre-render the expected post-selection message as initial state.");
    }
    if (defect.code === "prerequisite_durable_outcome_missing") {
      lines.push("the exact durable mutation control was found and activated during prerequisite setup, "
        + "but its contracted result did not become a post-action observable. Do not seed or statically "
        + "render that final result before activation; wire the mutation to publish the newly committed "
        + "record on the mounted surface.");
    }
    if (defect.evidence?.collectionMembership?.checked) {
      const membership = defect.evidence.collectionMembership;
      const created = defect.evidence?.entityDiff?.created || [];
      lines.push(`the browser checked the rendered collection after activation: regionFound=${membership.regionFound === true}, `
        + `structuralMemberCount=${Number(membership.structuralMemberCount || 0)}, `
        + `missing=${JSON.stringify(membership.missing || [])}, unexpected=${JSON.stringify(membership.unexpected || [])}. `
        + (created.length
          ? `Backend evidence recorded ${created.length} created row(s), so repair the mounted state/filter/render handoff rather than duplicating the mutation.`
          : "Repair the action-to-mounted-collection state transition."));
    }
    // Freshness is verifier context. Brief it only while the advisory still says the result was
    // already visible — that wording is the race a repair can answer. Any other wording is noise
    // and must not become an instruction.
    if ((defect.evidence?.journeyAdvisories || []).some((advisory) => (
      advisory?.code === "text_freshness_not_observed"
      && /already visible/i.test(String(advisory.detail || ""))
    ))) {
      lines.push("context (verifier advisory, not the repair): an earlier contracted result was already visible before its action completed. Prevent the dependent step from racing an unfinished async transition: do not pre-render the post-action outcome, or publish/await the completed state before dependent controls can run.");
    }
    if (defect.code === "fatal_runtime_crash") {
      // ONE narrative per distinct crash: the smoke stamps the same verdict on every contracted
      // journey, and repeating the paragraph per journey only spends the model's context.
      const key = JSON.stringify([defect.evidence?.observed, defect.evidence?.crash?.message]);
      if (!crashNarrated.has(key)) {
        crashNarrated.add(key);
        lines.push(runtimeCrashBrief(defect, defects));
      }
    }
    if (defect.evidence?.surfaceIntegration) {
      const surface = defect.evidence.surfaceIntegration;
      lines.push(`journey ${defect.journeyId} has generated source that is not reachable from its `
        + `browser entry route [${(surface.routePaths || []).join(", ")}]: `
        + `[${(surface.unreachableJourneyModules || []).join(", ")}]. The mounted runtime source is `
        + `[${(surface.mountedPaths || []).join(", ")}]. Integrate the contracted behaviour into `
        + "that mounted surface or mount the existing journey module; editing dead source alone cannot change the browser result.");
    }
    lines.push(JSON.stringify({
      // The code downstream already parses. The fields below it are additive.
      code: "interaction_verification_failure",
      defectCode: defect.code,
      defectClass: defect.defectClass,
      owner: defect.owner,
      uncertain: defect.uncertain || false,
      repairTier: defect.tier,
      journeyId: defect.journeyId,
      stepIndex: defect.stepIndex,
      status: defect.diagnostic?.status || null,
      userAction: defect.action,
      control: defect.control,
      expectedStateAfter: defect.evidence?.expected || null,
      actualObservedState: defect.evidence?.observed || null,
      // Structured attribution. `repairFailureOwnedPaths` reads these two names.
      // Repair-addressable state owners. The raw diagnostic may name a protected composed
      // capability; modulesFor has already translated that platform owner to its bounded
      // configuration seam while retaining the journey UI owner.
      stateOwners: defect.modules,
      capabilityStateOwners: defect.diagnostic?.stateOwners || [],
      responsibleModules: defect.modules,
      expectedControls: defect.diagnostic?.expectedControls || [],
      renderedControlFacts: defect.diagnostic?.renderedControlFacts || [],
      attemptedLocators: defect.evidence?.attemptedLocators || [],
      controlAddressing: defect.evidence?.addressing || null,
      mechanics: defect.evidence?.mechanics || null,
      selectionAttempt: defect.evidence?.selectionAttempt || null,
      collectionMembership: defect.evidence?.collectionMembership || null,
      journeyAdvisories: defect.evidence?.journeyAdvisories || [],
      backendEntityDiff: defect.evidence?.entityDiff || null,
      drove: defect.evidence?.drove ?? null,
      failingChecks: defect.evidence?.failingChecks || [],
      pageTextWhenItFailed: defect.evidence?.pageText || null,
      consoleErrorsDuringStep: defect.evidence?.consoleErrors || [],
      failedRequestsDuringStep: defect.evidence?.failedRequests || [],
      failureRefs: defect.failureRefs || defect.modules || [],
      surfaceIntegration: defect.evidence?.surfaceIntegration || null,
      runtimeCrash: defect.evidence?.crash || null,
    }));
  }
  // Platform and prerequisite defects ride along as CONTEXT with their ownership stated. They
  // explain the run; they never ask the model to change the application.
  for (const defect of defects.filter((row) => row.tier === REPAIR_TIER.NONE)) {
    // An attribution miss still owes the repair somewhere to look: the bounded fallback set is
    // the one thing a defect with no owning module can honestly offer.
    const fallback = defect.modules?.length
      ? ` bounded fallback files: ${defect.modules.join(", ")}` : "";
    // An application-owned defect that no repair tier could be dispatched for is still the
    // application's: say so. "not an application defect" is reserved for platform/unknown owners.
    const framing = defect.owner === DEFECT_OWNER.APP
      ? "application-owned defect, fix the cause"
      : `${defect.owner}-owned, not an application defect`;
    lines.push(`context (${framing}) ${defect.code}: `
      + `${defect.evidence?.observed || "no detail"}.${fallback}`);
  }
  return lines;
}

/** The one paragraph that tells repair what crashed, where, and what to do about it. */
function runtimeCrashBrief(defect, defects = []) {
  const crash = defect.evidence?.crash || {};
  const message = crash.message || defect.evidence?.observed || "the application crashed";
  const when = crash.phase === "activate"
    ? `after activating ${crash.control ? JSON.stringify(crash.control) : "a control"}` : "while loading";
  const journeys = unique((defects || []).filter((row) => row.code === "fatal_runtime_crash"
    && row.evidence?.observed === defect.evidence?.observed).map((row) => row.journeyId));
  const where = (crash.hits || []).length
    ? ` Generated files that contain ${unique(crash.hits.map((hit) => JSON.stringify(hit.token))).join(", ")}: `
      + `${unique(crash.hits.map((hit) => `${hit.path}${hit.line ? `:${hit.line}` : ""}`)).join(", ")}.`
    : (crash.files || []).length ? ` Files named by the stack: ${crash.files.join(", ")}.` : "";
  const stack = (crash.stack || []).length ? ` Stack: ${crash.stack.slice(0, 3).join(" | ")}.` : "";
  const transient = /entity ?store/i.test(String(message))
    ? " Platform stores exist only for durable entities. A calculation result or other transient value "
      + "has no store: delete the entityStore(...) call and keep that value in local component state (useState)."
    : "";
  return `application crash (this is an application defect: the generated code throws, repair the cause): `
    + `the app crashed ${when} with ${JSON.stringify(message)}${journeys.length > 1 ? ` (the same crash fails journeys ${journeys.join(", ")})` : ""}.`
    + `${stack}${where} Remove or replace the failing call or reference in those files; do not keep it, and `
    + `do not rewrite unrelated modules.${transient}`;
}

/**
 * The write boundary for a browser-informed repair.
 *
 * Structured attribution is the address; if attribution produced nothing there is no boundary and
 * the repair stays unscoped rather than being confined to a guess.
 */
export function defectWriteBoundary(defects = [], { maxFiles = 12 } = {}) {
  const actionable = actionableDefects(defects);
  // When the browser failed on a journey whose generated implementation is unreachable, the
  // mounted route and current mounted flow are the causal callers. Put them before the ordinary
  // owner list so a large attribution set cannot sort the actual integration seam out of the
  // bounded first strategy.
  const surfaceFiles = unique(actionable.flatMap((defect) => [
    ...(defect.evidence?.surfaceIntegration?.routeFiles || []),
    ...(defect.evidence?.surfaceIntegration?.mountedPaths || []),
    ...(defect.evidence?.surfaceIntegration?.unreachableJourneyModules || []),
  ])).filter(generatedSource).sort();
  // A runtime crash names the file that throws. Keep those first so a long owner list cannot sort
  // the one file that actually has to change out of the bounded first strategy.
  const crashFiles = unique(actionable.flatMap((defect) => defect.evidence?.crash?.files || []))
    .filter(generatedSource).sort();
  const ownerFiles = unique(actionable.flatMap((defect) => defect.modules)).filter(generatedSource).sort();
  const files = unique([...surfaceFiles, ...crashFiles, ...ownerFiles]).slice(0, maxFiles);
  if (!files.length) return null;
  const controls = unique(actionable.map((defect) => defect.control?.logicalField || defect.control?.id));
  return {
    kind: "browser_repair_boundary",
    allowedFiles: files,
    // DELIBERATELY NO DIRECTORY PREFIXES. A prefix of `src/routes/` would readmit every sibling
    // route and the boundary would mean nothing for exactly the files a repair is most likely to
    // wander into. A repair that genuinely needs a new module breaks scope once and falls back to
    // an unscoped attempt, which is the same one-strike escape a validator-owned scope gets.
    allowedPrefixes: [],
    controls,
    instruction: "BROWSER-VERIFIED REPAIR WRITE BOUNDARY (machine-enforced): the verifier attributed "
      + `every failure below to these modules${controls.length ? ` and these controls: [${controls.join(", ")}]` : ""}. `
      + "Fix the named transitions there. Do not restate expected words as copy; change the handler, "
      + "state or conditional that failed.",
  };
}

/**
 * "The previous attempt did not fix it."
 *
 * A round that leaves the same defect in place is discarded (the retained tree is restored), so the
 * next round starts from the same code and, without being told, tends to make the same change. Each
 * ledger entry records what a discarded round touched and which defects survived it; this turns the
 * entries whose defect is still present into one explicit block for the next brief: what was
 * changed, that it did not work, and (for a runtime crash) where the cause still is.
 *
 * @param {{attempts?: Array<{round:number, strategy:string, changedFiles:string[], persisted:string[]}>,
 *   defects?: object[], tree?: object|null}} input
 * @returns {string[]} brief lines; empty when no earlier round left a current defect in place
 */
export function previousAttemptNotes({ attempts = [], defects = [], tree = null } = {}) {
  const current = new Map(actionableDefects(defects).map((defect) => [defectSignature(defect), defect]));
  const lines = [];
  for (const attempt of (attempts || []).slice(-2)) {
    const survivors = (attempt.persisted || []).map((signature) => current.get(signature)).filter(Boolean);
    if (!survivors.length) continue;
    const first = survivors[0];
    const crash = first.code === "fatal_runtime_crash"
      ? crashSourceEvidence(tree, { message: first.evidence?.crash?.message || first.evidence?.observed,
        sourceFiles: first.evidence?.crash?.sourceFiles || [] }) : null;
    const changed = unique(attempt.changedFiles || []);
    const stillThere = crash?.hits?.length
      ? unique(crash.hits.map((hit) => `${hit.path}${hit.line ? `:${hit.line}` : ""}`)) : [];
    const causeFiles = unique((crash?.files || []));
    const untouched = causeFiles.filter((path) => !changed.includes(path));
    lines.push(`PREVIOUS ATTEMPT DID NOT FIX THIS: round ${attempt.round} [${attempt.strategy}] changed `
      + `[${changed.join(", ") || "no files"}] and the same defect (${first.code}`
      + `${first.evidence?.observed ? `: ${JSON.stringify(String(first.evidence.observed).slice(0, 200))}` : ""}) `
      + "persisted, so that change was discarded. Do not repeat it."
      + (stillThere.length ? ` The cause is still present at ${stillThere.join(", ")}.` : "")
      + (untouched.length ? ` The earlier round never modified [${untouched.join(", ")}]: change the offending code in ${untouched.length > 1 ? "them" : "it"} itself.` : "")
      + (crash ? " Remove or replace the failing call rather than adjusting code around it." : ""));
  }
  return lines;
}

/** A stable identity for one defect, for comparing one repair round against the next. */
export const defectSignature = (defect) => [
  defect.defectClass, defect.code, defect.journeyId || "-",
  defect.stepIndex ?? "-", defect.control?.id || defect.control?.logicalField || "-",
].join("|");

/**
 * Keep a retained browser-proven tree while carrying forward strictly additive attribution learned
 * from a rejected/no-progress candidate. The defect identity and observation remain those of the
 * retained tree; only generated-source addresses for the same defect signature are widened.
 */
export function mergeDefectAttribution(retained = [], observed = []) {
  const observedBySignature = new Map();
  for (const defect of observed || []) {
    const signature = defectSignature(defect);
    if (!observedBySignature.has(signature)) observedBySignature.set(signature, []);
    observedBySignature.get(signature).push(defect);
  }
  return (retained || []).map((defect) => {
    const matches = observedBySignature.get(defectSignature(defect)) || [];
    if (!matches.length) return defect;
    const modules = unique([defect.modules, ...matches.map((row) => row.modules)].flat())
      .filter(generatedSource);
    const failureRefs = unique([defect.failureRefs, ...matches.map((row) => row.failureRefs)].flat());
    const routingTargets = unique([
      defect.scaffoldRouting?.targetFiles,
      ...matches.map((row) => row.scaffoldRouting?.targetFiles),
    ].flat()).filter(generatedSource);
    return {
      ...defect,
      modules,
      failureRefs,
      ...(defect.scaffoldRouting || routingTargets.length ? {
        scaffoldRouting: { ...(defect.scaffoldRouting || matches.find((row) => row.scaffoldRouting)?.scaffoldRouting || {}),
          targetFiles: routingTargets },
      } : {}),
    };
  });
}

/** Versioned durable defect evidence with sensitive entity values represented only by hashes. */
export function verificationDefectRecord(defect, {
  sourceTreeHash, candidateSnapshotId = null, dependencyOwners = [],
} = {}) {
  if (!sourceTreeHash) throw new Error("verification defect persistence requires a source tree hash");
  const signature = defectSignature(defect);
  const identityStatus = defect.code === "journey_verifier_unavailable"
    ? "verifier_unavailable"
    : defect.evidence?.addressing?.reason === "ambiguous_identity" ? "ambiguous_identity"
      : defect.evidence?.addressing?.reason === "identity_absent" || !defect.control?.id
        ? "identity_absent" : "identified";
  return {
    defectId: fingerprint({ version: VERIFICATION_DEFECT_VERSION, signature }).slice(0, 32),
    version: VERIFICATION_DEFECT_VERSION,
    classification: defect.defectClass,
    journeyId: defect.journeyId || null,
    stepId: defect.stepIndex == null ? null : String(defect.stepIndex),
    capabilityOperationId: defect.diagnostic?.capabilityOperationId || null,
    controlIdentity: defect.control || null,
    actionIdentity: defect.action ? {
      journeyId: defect.journeyId || null, stepId: defect.stepIndex ?? null, action: defect.action,
    } : null,
    expectedState: defect.evidence?.expected ?? null,
    observedState: defect.evidence?.observed ?? null,
    drove: defect.evidence?.drove ?? null,
    identityStatus,
    pageState: defect.evidence?.pageText ? String(defect.evidence.pageText).slice(0, 2_000) : null,
    consoleFingerprint: fingerprint(defect.evidence?.consoleErrors || []),
    requestFingerprint: fingerprint(defect.evidence?.failedRequests || []),
    entityBefore: defect.evidence?.entityBefore || null,
    entityAfter: defect.evidence?.entityAfter || null,
    entityDiff: defect.evidence?.entityDiff || null,
    collectionMembership: defect.evidence?.collectionMembership || null,
    journeyAdvisories: defect.evidence?.journeyAdvisories || [],
    failureRefs: unique(defect.failureRefs || defect.modules || []),
    owningModules: unique(defect.modules || []),
    dependencyOwners: unique(dependencyOwners),
    sourceTreeHash,
    candidateSnapshotId,
    repairTier: defect.tier,
    owner: defect.owner,
    defectCode: defect.code,
    signature,
    surfaceIntegration: defect.evidence?.surfaceIntegration || null,
  };
}

export function verificationDefectRecords(defects, options = {}) {
  return (defects || []).map((defect) => verificationDefectRecord(defect, options));
}

/**
 * Did the repair move anything?
 *
 * Fingerprinting already stops an identical brief. This catches the expensive middle case that
 * cost run #7 both of its rounds: a repair that edits files, changes the wording of the failure,
 * and leaves the defect exactly where it was. A round earns its successor only by RESOLVING a
 * defect — new defects appearing while none were resolved is a regression, not progress.
 */
export function defectProgress(before = [], after = []) {
  const prior = actionableDefects(before);
  const next = actionableDefects(after);
  const priorSet = new Set(prior.map(defectSignature));
  const nextSet = new Set(next.map(defectSignature));
  const resolved = [...priorSet].filter((signature) => !nextSet.has(signature));
  const persisted = [...priorSet].filter((signature) => nextSet.has(signature));
  const introduced = [...nextSet].filter((signature) => !priorSet.has(signature));
  if (!priorSet.size) return { moved: true, resolved, persisted, introduced, reason: "first_round" };

  // A changed signature is not necessarily progress. A candidate that crashes at an earlier
  // step makes the old defect disappear too, as does one that breaks a journey which was green.
  // Compare the earliest actionable frontier per journey so the repair may advance downstream,
  // but may never trade one contracted journey (or an earlier step) for another.
  const position = (defect) => ({
    step: Number.isInteger(defect.stepIndex) ? defect.stepIndex : -1,
    // Making a control driveable and then observing a missing outcome is real progress within
    // the same contracted step. Behaviour/durability are downstream of interaction mechanics.
    phase: defect.defectClass === DEFECT_CLASS.INTERACTION ? 0 : 1,
  });
  const comparePosition = (left, right) => left.step - right.step || left.phase - right.phase;
  const frontier = (defects) => {
    const byJourney = new Map();
    for (const defect of defects) {
      const key = defect.journeyId || "__global__";
      const nextPosition = position(defect);
      const current = byJourney.get(key);
      if (!current || comparePosition(nextPosition, current) < 0) byJourney.set(key, nextPosition);
    }
    return byJourney;
  };
  const priorFrontier = frontier(prior);
  const nextFrontier = frontier(next);
  const regressed = next.some((defect) => {
    if (!introduced.includes(defectSignature(defect))) return false;
    const journeyId = defect.journeyId || "__global__";
    return !priorFrontier.has(journeyId)
      || comparePosition(position(defect), priorFrontier.get(journeyId)) <= 0;
  });
  const advanced = [...priorFrontier].some(([journeyId, priorPosition]) => (
    !nextFrontier.has(journeyId)
      || comparePosition(nextFrontier.get(journeyId), priorPosition) > 0
  ));

  if (!regressed && advanced) {
    return { moved: true, resolved, persisted, introduced,
      reason: introduced.length ? "partial_progress" : "progress" };
  }
  return {
    moved: false, resolved, persisted, introduced,
    reason: regressed ? "regressed" : "unchanged",
  };
}
