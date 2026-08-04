// The implementation contract: what "built" actually means for one request.
//
// PR4 of docs/PIPELINE-REDESIGN.md. `diag_runs.plan` was null on both failed production runs, and
// the plan the planner did produce was prose — "add booking functionality", "key features" as a
// bullet list. Prose cannot be verified. Nothing downstream could ask "did the booking persist?"
// because nothing had ever written down that it must.
//
// A contract is the same intent expressed as OBSERVABLE OUTCOMES. Every field here exists to be
// checked by something later: journeys drive Playwright (PR6), entities and operations drive the
// honesty scan (PR7), stages drive checkpointing (PR5), and `deferred` is what stops the scan from
// reporting an omission the customer was told about.
//
// Shared between server and web deliberately — the same vocabulary in the generator, the verifier
// and the Diagnostics view, so the three cannot drift into describing different things.

export const CONTRACT_VERSION = 1;

// The five stages PR5 generates in. Named here because the contract is what assigns work to them.
export const STAGES = ["foundation", "data", "primary_journey", "supporting", "polish"];

// ── the shape ─────────────────────────────────────────────────────────────────────────────────
//
// {
//   version, summary, projectType,
//   journeys:   [{ id, title, priority, stage, steps: [{ action, target, expect }], acceptance: [] }],
//   routes:     [{ path, name, purpose, auth }],
//   entities:   [{ name, fields: [{ name, type, required }], owned, relationships: [] }],
//   auth:       { required, model, rules: [] },
//   operations: [{ id, entity, kind, description, journey }],
//   integrations: [{ name, purpose, required }],
//   states:     [{ surface, loading, empty, validation, error, success }],
//   acceptance: [{ id, statement, journey, kind }],
//   deferred:   [{ item, reason }]
// }

// Vague verbs that describe an intention rather than an outcome. A journey step or acceptance
// statement built only from these is exactly the "add booking functionality" the brief forbids.
const VAGUE = [
  /^add\s+\w+\s+functionality$/i,
  /^implement\s+\w+$/i,
  /^support\s+\w+$/i,
  /^handle\s+\w+$/i,
  /^make\s+it\s+work$/i,
  /^build\s+(the\s+)?\w+$/i,
  /^booking\s+system$/i,
  /^user\s+management$/i,
  /^crud$/i,
];

// An observable statement names something a machine could look for: an interaction, a rendered
// value, a stored record, a visible message, a state change.
//
// Stems with their inflections, because half of these naturally appear as past participles — "the
// confirmation is DISPLAYED", "the slot is HIGHLIGHTED", "continue becomes ENABLED". A first
// version listed only base forms and rejected three perfectly good steps of the booking contract.
const OBSERVABLE = new RegExp(`\\b(${[
  // interactions
  "click(s|ed|ing)?", "select(s|ed|ing|able)?", "enter(s|ed|ing)?", "typ(e|es|ed|ing)",
  "submit(s|ted|ting)?", "choos(e|es|ing)", "chose(n)?", "open(s|ed|ing)?", "navigat(e|es|ed)",
  "sign(s|ed)?", "log(s|ged)? ?in", "upload(s|ed)?", "cancel(s|led)?", "delet(e|es|ed)",
  // rendering
  "see|sees|seen", "show(s|n|ing)?", "display(s|ed|ing)?", "appear(s|ed|ing)?", "render(s|ed)?",
  "visible", "hidden", "highlight(s|ed|ing)?", "list(s|ed)?", "contain(s|ed)?", "read(s|able)?",
  "message", "error", "confirmation", "empty",
  // state
  "enabled?", "disabled?", "remain(s|ed|ing)?", "stay(s|ed)?", "become(s)?", "became",
  // persistence and refusal
  "persist(s|ed|ing)?", "sav(e|es|ed)", "stor(e|es|ed)", "reload(s|ed)?", "refresh(es|ed)?",
  "survive(s|d)?", "refus(e|es|ed)", "reject(s|ed)?", "prevent(s|ed)?", "block(s|ed)?",
  "cannot|can't|does not|doesn't|no longer|not created|no second",
  "redirect(s|ed)?", "return(s|ed)?",
].join("|")})\\b`, "i");

/**
 * Is this a slogan rather than an outcome?
 *
 * ASYMMETRIC, and it took a production run to get the asymmetry the right way round. The first
 * version required a match against a list of observable verbs, and rejected these, all of which
 * are perfectly checkable:
 *
 *   "an iCalendar file for the confirmed date and time is offered"
 *   "Header navigation reaches Home, Book Now, Plan Your Visit, Our Farm"
 *   "The guest step visibly states the adult and child entry amount"
 *
 * — because "offered", "reaches" and "states" were not on the list. The whole contract was
 * discarded and the build silently fell back to one-shot generation with no contract at all. A
 * checker that is confidently wrong is worse than no checker; that is as true here as it was for
 * the import preflight.
 *
 * So the rule is now: reject what is RECOGNISABLY a slogan — a known empty phrase, or something too
 * short and verbless to be a statement about anything — and accept everything else. An observable
 * verb is strong positive evidence, not a requirement.
 */
export function isVague(text) {
  const value = String(text || "").trim();
  if (value.length < 12) return true;
  if (VAGUE.some((pattern) => pattern.test(value))) return true;

  // A real outcome is a sentence about something. Short verbless fragments — "booking works",
  // "user management", "payment flow" — are labels for work, not descriptions of it.
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length < 5 && !OBSERVABLE.test(value)) return true;

  return false;
}

/**
 * Check a contract for the things that make it useless downstream.
 *
 * Returns `{ ok, problems, warnings }`. The distinction matters: a problem means the contract
 * cannot drive verification and must be regenerated; a warning means it is thin but usable. A
 * contract that fails this is worse than none, because later stages would trust it.
 */
export function validateContract(contract) {
  const problems = [];
  const warnings = [];
  const c = contract || {};

  if (!c.summary || String(c.summary).trim().length < 10) problems.push("the contract has no summary");
  if (!Array.isArray(c.journeys) || !c.journeys.length) problems.push("the contract defines no user journeys");

  const journeyIds = new Set();
  for (const [index, journey] of (c.journeys || []).entries()) {
    const where = journey?.id || `journey ${index + 1}`;
    if (!journey?.title) problems.push(`${where} has no title`);
    if (journey?.id && journeyIds.has(journey.id)) problems.push(`duplicate journey id "${journey.id}"`);
    if (journey?.id) journeyIds.add(journey.id);
    if (!Array.isArray(journey?.steps) || journey.steps.length < 2) {
      problems.push(`${where} has fewer than two steps — a journey is a sequence, not a label`);
      continue;
    }
    for (const [stepIndex, step] of journey.steps.entries()) {
      // `expect` is the whole point: a step with no expectation cannot fail, so it cannot verify.
      if (!step?.expect || isVague(step.expect)) {
        problems.push(`${where} step ${stepIndex + 1} has no observable expectation ("${String(step?.expect || step?.action || "").slice(0, 60)}")`);
      }
    }
    if (journey.stage && !STAGES.includes(journey.stage)) problems.push(`${where} names unknown stage "${journey.stage}"`);
  }

  // Exactly one primary journey: the thing that must work before a preview may be called complete.
  const primary = (c.journeys || []).filter((j) => j.priority === "primary");
  if (!primary.length) problems.push("no journey is marked primary — nothing defines what must work");
  if (primary.length > 1) warnings.push(`${primary.length} journeys are marked primary; only the first gates the preview`);

  for (const [index, entity] of (c.entities || []).entries()) {
    const where = entity?.name || `entity ${index + 1}`;
    if (!entity?.name) problems.push(`entity ${index + 1} has no name`);
    if (!Array.isArray(entity?.fields) || !entity.fields.length) problems.push(`entity ${where} declares no fields`);
  }

  // An app that stores anything must say who owns it, or ownership cannot be checked.
  if ((c.entities || []).some((e) => e.owned) && !c.auth?.required) {
    problems.push("entities are marked owned but the contract does not require authentication");
  }

  for (const [index, test] of (c.acceptance || []).entries()) {
    if (!test?.statement || isVague(test.statement)) {
      problems.push(`acceptance ${test?.id || index + 1} is not an observable outcome ("${String(test?.statement || "").slice(0, 60)}")`);
    }
  }
  if (!Array.isArray(c.acceptance) || c.acceptance.length < 3) {
    problems.push("fewer than three acceptance tests — that cannot describe a working application");
  }

  if (!Array.isArray(c.routes) || !c.routes.length) warnings.push("no routes declared");
  if (!Array.isArray(c.states) || !c.states.length) warnings.push("no loading/empty/error states declared");

  return { ok: problems.length === 0, problems, warnings };
}

/** The journey a preview is not allowed to ship without. */
export function primaryJourney(contract) {
  const journeys = contract?.journeys || [];
  return journeys.find((j) => j.priority === "primary") || journeys[0] || null;
}

/** Journeys assigned to one generation stage (PR5). */
export function journeysForStage(contract, stage) {
  return (contract?.journeys || []).filter((j) => (j.stage || "primary_journey") === stage);
}

/**
 * The contract as instructions for a build or repair agent.
 *
 * Deliberately terse and imperative. The Builder used to receive a prose plan it could satisfy
 * impressionistically; this is a list of things that will be CHECKED, stated as the checks.
 */
export function contractBrief(contract) {
  if (!contract) return "";
  const lines = ["IMPLEMENTATION CONTRACT — this build is judged against these, not against appearance.", ""];

  const primary = primaryJourney(contract);
  if (primary) {
    lines.push(`PRIMARY JOURNEY (the preview cannot ship until this passes) — ${primary.title}:`);
    for (const [i, step] of (primary.steps || []).entries()) {
      lines.push(`  ${i + 1}. ${step.action}${step.target ? ` (${step.target})` : ""} → ${step.expect}`);
    }
    lines.push("");
  }

  const others = (contract.journeys || []).filter((j) => j !== primary);
  if (others.length) {
    lines.push("OTHER REQUIRED JOURNEYS:");
    for (const journey of others) {
      lines.push(`  - ${journey.title}: ${(journey.steps || []).map((s) => s.expect).filter(Boolean).join("; ")}`);
    }
    lines.push("");
  }

  if (contract.entities?.length) {
    lines.push("PERSISTED DATA — these must go through db.entity(), never component state:");
    for (const entity of contract.entities) {
      const fields = (entity.fields || []).map((f) => `${f.name}:${f.type}${f.required ? "*" : ""}`).join(", ");
      lines.push(`  - ${entity.name}${entity.owned ? " (owned by the signed-in user)" : ""} { ${fields} }`);
      for (const rel of entity.relationships || []) lines.push(`      ${rel}`);
    }
    lines.push("");
  }

  if (contract.auth?.required) {
    lines.push(`AUTHENTICATION: ${contract.auth.model || "email + password via the backend SDK"}.`);
    for (const rule of contract.auth.rules || []) lines.push(`  - ${rule}`);
    lines.push("");
  }

  if (contract.operations?.length) {
    lines.push("BACKEND OPERATIONS THAT MUST REALLY RUN:");
    for (const op of contract.operations) lines.push(`  - ${op.id}: ${op.description}`);
    lines.push("");
  }

  if (contract.states?.length) {
    lines.push("REQUIRED UI STATES (each surface needs all of these, not just the happy path):");
    for (const state of contract.states) {
      const has = ["loading", "empty", "validation", "error", "success"].filter((k) => state[k]);
      lines.push(`  - ${state.surface}: ${has.join(", ")}`);
    }
    lines.push("");
  }

  if (contract.deferred?.length) {
    lines.push("EXPLICITLY DEFERRED — do not build these, and do not fake them either. If a control");
    lines.push("for one would appear, omit it or disable it with a visible reason:");
    for (const item of contract.deferred) lines.push(`  - ${item.item}${item.reason ? ` (${item.reason})` : ""}`);
    lines.push("");
  }

  lines.push("EVERY VISIBLE CONTROL must work, be disabled with a stated reason, or be absent.");
  lines.push("A button that only shows a toast, or data held in component state that a refresh loses,");
  lines.push("is a FAILURE of this contract even if the page looks finished.");
  return lines.join("\n");
}

/** One-line summary for logs and the Diagnostics header. */
export function contractSummary(contract) {
  if (!contract) return "no contract";
  return [
    `${(contract.journeys || []).length} journeys`,
    `${(contract.entities || []).length} entities`,
    `${(contract.operations || []).length} operations`,
    `${(contract.acceptance || []).length} acceptance tests`,
    contract.deferred?.length ? `${contract.deferred.length} deferred` : null,
  ].filter(Boolean).join(" · ");
}
