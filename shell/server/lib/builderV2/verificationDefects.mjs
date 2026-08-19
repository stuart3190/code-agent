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

import { interactionFailureDiagnostics } from "./interactionContract.mjs";
import { PROTECTED_PATHS } from "./patchEngine.mjs";

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

/** The contracted flows a step drives, if the interaction contract knows about them. */
function flowsForStep(interactionContract, journeyId, stepIndex) {
  return (interactionContract?.flows || [])
    .filter((flow) => flow.journeyId === journeyId && flow.stepIndex === stepIndex);
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
  return unique([
    ...(diagnostic?.stateOwners || []),
    ...(diagnostic?.responsibleModules || []),
    ...(journey?.owners || []),
  ].filter(generatedSource));
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
  const journeysById = new Map((verdicts.journeys || []).map((journey) => [journey.id, journey]));
  const mechanics = verdicts.mechanics || null;
  const defects = [];

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
      evidence: { observed: journey.attributionDefect.message || "failed journey attributed to no owning module" },
    });
  }

  // ── contract ────────────────────────────────────────────────────────────────────────────────
  // A journey whose required starting state could not be established never tested the app. It is
  // context for the run, never an actionable app defect, and it must not be briefed as one.
  for (const journey of verdicts.journeys || []) {
    if (journey.setup?.ok !== false) continue;
    defects.push({
      code: journey.setup.code || "journey_prerequisites_unmet",
      defectClass: DEFECT_CLASS.CONTRACT, owner: DEFECT_OWNER.UNKNOWN, tier: REPAIR_TIER.NONE,
      uncertain: true, downstream: true,
      journeyId: journey.id, stepIndex: null, action: null,
      control: journey.setup.failure?.control ? { id: null, logicalField: journey.setup.failure.control } : null,
      modules: unique((journey.owners || []).filter(generatedSource)),
      evidence: { observed: journey.setup.failure?.reason || "the journey's starting state could not be established" },
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
    const defectClass = classifyStep({ status, drove: step?.drove, kinds });
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
    defects.push({
      code: proven ? "control_cannot_hold_value"
        : status === "undriveable" ? "contracted_control_undriveable"
        : defectClass === DEFECT_CLASS.DURABILITY ? "durable_outcome_missing"
        : "contracted_outcome_missing",
      defectClass: proven ? DEFECT_CLASS.INTERACTION : defectClass,
      owner: ambiguous ? DEFECT_OWNER.UNKNOWN : DEFECT_OWNER.APP,
      uncertain: ambiguous || undefined,
      tier: proven ? REPAIR_TIER.CORRECTION : REPAIR_TIER.REPAIR,
      journeyId: diagnostic.journeyId, stepIndex: diagnostic.stepIndex,
      action: diagnostic.userAction, control,
      modules: modulesFor(diagnostic, journey),
      evidence: {
        expected: diagnostic.expectedStateAfter || null,
        observed: diagnostic.actualObservedState || null,
        drove: step?.drove ?? null,
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
      },
      diagnostic,
    });
  }

  // ── a red journey that produced no per-step evidence ────────────────────────────────────────
  // The browser ran and the contracted journey did not pass, but nothing said which step or why.
  // That is still a defect and still has to be briefed — what it is NOT is a defect anyone can
  // name, so its class and its owner both stay unknown rather than being invented.
  const journeysWithSteps = new Set(diagnostics.map((row) => row.journeyId));
  for (const journey of verdicts.journeys || []) {
    if (["pass", "reused"].includes(journey.status) || journeysWithSteps.has(journey.id)) continue;
    if (journey.setup?.ok === false) continue; // already reported as a prerequisite defect
    defects.push({
      code: "journey_failed_without_step_evidence",
      defectClass: DEFECT_CLASS.UNKNOWN, owner: DEFECT_OWNER.UNKNOWN, uncertain: true,
      tier: REPAIR_TIER.REPAIR,
      journeyId: journey.id, stepIndex: null, action: null, control: null,
      modules: unique([...(journey.owners || []), ...(journey.fallbackRefs || [])].filter(generatedSource)),
      evidence: {
        observed: `the contracted journey did not pass (status ${journey.status || "unknown"}) `
          + "and no per-step evidence was recorded",
      },
    });
  }

  // ── mechanics failures no failing step accounted for ────────────────────────────────────────
  // A dead control the journeys never reached is still a proven, addressed defect.
  for (const failure of mechanics?.failures || []) {
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
      evidence: { observed: failure.detail || "the contracted durable row was not written" },
    });
  }

  return defects;
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
  for (const defect of actionableDefects(defects)) {
    if (defect.journeyId && defect.action) {
      lines.push(`journey ${defect.journeyId} · step "${defect.action}" FAILED in a real browser: `
        + `${defect.evidence?.observed || "expected outcome never appeared"}`);
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
      stateOwners: defect.diagnostic?.stateOwners || defect.modules,
      responsibleModules: defect.modules,
      expectedControls: defect.diagnostic?.expectedControls || [],
      renderedControlFacts: defect.diagnostic?.renderedControlFacts || [],
      attemptedLocators: defect.evidence?.attemptedLocators || [],
      controlAddressing: defect.evidence?.addressing || null,
      mechanics: defect.evidence?.mechanics || null,
      drove: defect.evidence?.drove ?? null,
      pageTextWhenItFailed: defect.evidence?.pageText || null,
      consoleErrorsDuringStep: defect.evidence?.consoleErrors || [],
      failedRequestsDuringStep: defect.evidence?.failedRequests || [],
    }));
  }
  // Platform and prerequisite defects ride along as CONTEXT with their ownership stated. They
  // explain the run; they never ask the model to change the application.
  for (const defect of defects.filter((row) => row.tier === REPAIR_TIER.NONE)) {
    // An attribution miss still owes the repair somewhere to look: the bounded fallback set is
    // the one thing a defect with no owning module can honestly offer.
    const fallback = defect.modules?.length
      ? ` bounded fallback files: ${defect.modules.join(", ")}` : "";
    lines.push(`context (${defect.owner}-owned, not an application defect) ${defect.code}: `
      + `${defect.evidence?.observed || "no detail"}.${fallback}`);
  }
  return lines;
}

/**
 * The write boundary for a browser-informed repair.
 *
 * Structured attribution is the address; if attribution produced nothing there is no boundary and
 * the repair stays unscoped rather than being confined to a guess.
 */
export function defectWriteBoundary(defects = [], { maxFiles = 12 } = {}) {
  const actionable = actionableDefects(defects);
  const files = unique(actionable.flatMap((defect) => defect.modules)).sort().slice(0, maxFiles);
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

/** A stable identity for one defect, for comparing one repair round against the next. */
export const defectSignature = (defect) => [
  defect.defectClass, defect.code, defect.journeyId || "-",
  defect.stepIndex ?? "-", defect.control?.id || defect.control?.logicalField || "-",
].join("|");

/**
 * Did the repair move anything?
 *
 * Fingerprinting already stops an identical brief. This catches the expensive middle case that
 * cost run #7 both of its rounds: a repair that edits files, changes the wording of the failure,
 * and leaves the defect exactly where it was. A round earns its successor only by RESOLVING a
 * defect — new defects appearing while none were resolved is a regression, not progress.
 */
export function defectProgress(before = [], after = []) {
  const priorSet = new Set(actionableDefects(before).map(defectSignature));
  const nextSet = new Set(actionableDefects(after).map(defectSignature));
  const resolved = [...priorSet].filter((signature) => !nextSet.has(signature));
  const persisted = [...priorSet].filter((signature) => nextSet.has(signature));
  const introduced = [...nextSet].filter((signature) => !priorSet.has(signature));
  if (!priorSet.size) return { moved: true, resolved, persisted, introduced, reason: "first_round" };
  if (resolved.length) {
    return { moved: true, resolved, persisted, introduced,
      reason: introduced.length ? "partial_progress" : "progress" };
  }
  return {
    moved: false, resolved, persisted, introduced,
    reason: introduced.length ? "regressed" : "unchanged",
  };
}
