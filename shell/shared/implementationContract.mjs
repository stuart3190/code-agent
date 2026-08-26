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

export const CONTRACT_VERSION = 2;

// The five stages PR5 generates in. Named here because the contract is what assigns work to them.
export const STAGES = ["foundation", "data", "primary_journey", "supporting", "polish"];

// A functional operation does not always mutate an entity field. Read-like operations and
// terminal browser actions may instead return a transient result: rendered output, a downloadable
// artifact, or another observable action result. That result is still a real semantic output, but
// inventing a durable entity field for it would falsely turn an effect into persistence.
//
// This vocabulary is deliberately driven by the operation's structured `kind`, never its product
// name or application prose. Mutating create/update/delete operations remain required to declare
// their actual field writes.
const TRANSIENT_RESULT_OPERATION_KINDS = new Map([
  ["read", "read_result"], ["get", "read_result"], ["find", "read_result"],
  ["lookup", "read_result"], ["view", "read_result"], ["fetch", "read_result"],
  ["list", "read_result"], ["search", "read_result"], ["query", "read_result"],
  ["export", "artifact"], ["download", "artifact"], ["print", "rendered_output"],
]);

const operationKind = (operation) => String(
  operation?.kind || operation?.type || operation?.action || operation?.id || operation?.name || "",
).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)[0] || "";

const PERSISTENCE_OPERATION_KINDS = new Set([
  "create", "insert", "add", "read", "get", "find", "lookup", "view", "fetch",
  "list", "search", "query", "update", "edit", "delete", "remove", "destroy",
]);
const MUTATING_PERSISTENCE_OPERATION_KINDS = new Set([
  "create", "insert", "add", "update", "edit", "delete", "remove", "destroy",
]);
const TRANSIENT_STORAGE = /\b(?:client(?:-only| side| session)?|browser(?:-only| session)?|session(?:-only| local)?|in[- ]?memory|local in-app|local state|ephemeral|transient|current (?:browser )?session|not (?:saved|stored|persisted)|no backend)\b/i;

/**
 * Structured entity state is not necessarily a database record. Its storage declaration is the
 * authority that prevents local/session-only workflow state from acquiring invented CRUD.
 */
export function entityPersistencePolicy(contract, entityName) {
  const entity = (contract?.entities || []).find((candidate) => (
    normaliseReference(candidate?.name) === normaliseReference(entityName)
  ));
  if (!entity) return "unspecified";
  // Contract agents commonly serialize enum-like authorities as `client_session`. Storage is a
  // semantic declaration, so separators must not change whether it is recognized as transient.
  const storage = [entity.storage, entity.persistence, entity.durability]
    .filter(Boolean).join(" ").replace(/[_]+/g, " ");
  return TRANSIENT_STORAGE.test(storage) ? "transient" : "unspecified";
}

export function operationUsesDurablePersistence(contract, operation) {
  if ((operation?.responsibilities || []).some((responsibility) => responsibility?.type === "persistence")) {
    return true;
  }
  if (entityPersistencePolicy(contract, operation?.entity) === "transient") return false;
  return PERSISTENCE_OPERATION_KINDS.has(operationKind(operation));
}

export function operationRequiresDurableMutation(contract, operation) {
  if (!operationUsesDurablePersistence(contract, operation)) return false;
  const explicit = (operation?.responsibilities || []).filter((responsibility) => responsibility?.type === "persistence");
  if (explicit.length) {
    return explicit.some((responsibility) => MUTATING_PERSISTENCE_OPERATION_KINDS.has(operationKind({
      kind: responsibility.capabilityMethod || responsibility.method || responsibility.operation || operationKind(operation),
    })));
  }
  return MUTATING_PERSISTENCE_OPERATION_KINDS.has(operationKind(operation));
}

export function contractUsesDurablePersistence(contract) {
  return (contract?.operations || []).some((operation) => operationUsesDurablePersistence(contract, operation));
}

export function functionalOutputEffect(operation, responsibility) {
  if (responsibility?.type !== "functional" || (responsibility?.writes || []).length) return null;
  const kind = operationKind(operation);
  const effect = TRANSIENT_RESULT_OPERATION_KINDS.get(kind);
  if (!effect) return null;
  return {
    type: "transient_result",
    effect,
    operationKind: kind,
    durable: false,
  };
}

// ── the shape ─────────────────────────────────────────────────────────────────────────────────
//
// {
//   version, summary, projectType,
//   journeys:   [{ id, title, priority, stage, steps: [{ action, target, expect }], acceptance: [] }],
//   routes:     [{ path, name, purpose, auth }],
//   entities:   [{ name, fields: [{ name, type, required }], owned, relationships: [] }],
//   auth:       { required, model, rules: [] },
//   operations: [{ id, entity, kind, description, journey,
//                  responsibilities: [{ type, behavior, capability, capabilityMethod, reads, writes }] }],
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
/** Everything a step is allowed to name: the contract's own declared vocabulary, nothing else. */
const normaliseReference = (value) => String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");

const VERIFICATION_VALUE_INTENT = /\b(?:correct|incorrect)(?:ly)?\b/i;
// Keyboard focus is a real control interaction, not an observation. Without structured operands
// the verifier has no authoritative control identity and can only guess from prose. A production
// catalogue contract named several controls this way and passed planning, then stopped as a
// platform-undriveable journey after generation even though the controls existed. Require the
// planner to split mixed control types and identify each focusable field before any build spend.
const KEYBOARD_FOCUS_INTENT = /\b(?:focus(?:es|ed|ing)?|tab(?:s|bed|bing)?(?:\s+through)?)\b/i;
const DOMAIN_SEARCH_OPERATION_KINDS = new Set(["filter", "query", "search"]);
const VERIFICATION_VALUE_STOP_WORDS = new Set([
  "a", "an", "and", "answer", "control", "details", "field", "form", "input", "question", "the", "value",
]);

const referenceWords = (value) => String(value || "")
  .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
  .toLowerCase().match(/[a-z][a-z0-9]*/g) || [];

/**
 * Domain-valid values the verifier cannot safely invent from an HTML input type.
 *
 * Native constraints are enough for ordinary names, email addresses, numbers and dates. They are
 * not enough for prose such as "the correct answer": only the application knows which otherwise
 * valid string its business rule accepts. Pick the field named most specifically around that
 * intent and require the planner to declare a non-secret synthetic fixture for it.
 */
export function verificationFixtureFields(step = {}, contract = {}) {
  const operated = (step.operates || []).map(String).filter((reference) => (
    fieldNames(contract).has(normaliseReference(reference))
  ));
  if (!operated.length) return [];
  const operatedReferences = new Set((step.operates || []).map(normaliseReference));
  const domainSearch = (contract?.operations || []).some((operation) => (
    operatedReferences.has(normaliseReference(operation?.id || operation?.name))
    && DOMAIN_SEARCH_OPERATION_KINDS.has(String(operation?.kind || "").toLowerCase())
    && entityPersistencePolicy(contract, operation?.entity) === "transient"
    && (operation?.responsibilities || []).some((responsibility) => responsibility?.type === "functional")
  ));
  if (domainSearch) return operated;
  if (!VERIFICATION_VALUE_INTENT.test(String(step.action || ""))) return [];
  const actionWords = referenceWords(step.action);
  const intentIndexes = actionWords.map((word, index) => (
    /^(?:correct|incorrect)(?:ly)?$/.test(word) ? index : -1
  )).filter((index) => index >= 0);
  const scored = operated.map((field) => {
    const words = referenceWords(String(field).split(".").pop())
      .filter((word) => !VERIFICATION_VALUE_STOP_WORDS.has(word));
    const positions = words.flatMap((word) => actionWords
      .map((candidate, index) => candidate === word ? index : -1).filter((index) => index >= 0));
    const matchedWords = new Set(words.filter((word) => actionWords.includes(word))).size;
    const distance = positions.length && intentIndexes.length
      ? Math.min(...positions.flatMap((position) => intentIndexes.map((index) => Math.abs(position - index))))
      : Number.POSITIVE_INFINITY;
    return { field, matchedWords, distance, score: matchedWords * 100 - distance };
  }).filter((row) => row.matchedWords > 0);
  if (!scored.length) return operated.length === 1 ? operated : [];
  const best = Math.max(...scored.map((row) => row.score));
  return scored.filter((row) => row.score === best).map((row) => row.field);
}

export function contractReferences(contract) {
  const references = new Set();
  for (const entity of contract?.entities || []) {
    if (entity?.name) references.add(normaliseReference(entity.name));
    for (const field of entity?.fields || []) {
      if (!field?.name) continue;
      references.add(normaliseReference(field.name));
      // A step may name a field on its entity ("booking.slotId") as readably as on its own.
      if (entity?.name) references.add(normaliseReference(`${entity.name}.${field.name}`));
    }
  }
  for (const operation of contract?.operations || []) {
    for (const key of [operation?.id, operation?.name]) if (key) references.add(normaliseReference(key));
  }
  return references;
}

/** The contract's declared entity names, and separately its field names — two different kinds. */
export function entityNames(contract) {
  return new Set((contract?.entities || []).map((entity) => normaliseReference(entity?.name)).filter(Boolean));
}

export function fieldNames(contract) {
  const names = new Set();
  for (const entity of contract?.entities || []) {
    for (const field of entity?.fields || []) {
      if (!field?.name) continue;
      names.add(normaliseReference(field.name));
      if (entity?.name) names.add(normaliseReference(`${entity.name}.${field.name}`));
    }
  }
  return names;
}

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
      // OPERANDS AND DEPENDENCIES. `operates` names the controls this step actually manipulates;
      // `reads` names state it merely depends on. A live run failed because "select a party size
      // that does not exceed the slot's remaining capacity" was read as operating the SLOT as well
      // — prose cannot tell a verb's object from its subordinate clause, and it should not have to.
      // A reference to something the contract never declared is caught here, before generation.
      for (const [key, values] of [["operates", step?.operates], ["reads", step?.reads], ["produces", step?.produces]]) {
        if (values === undefined || values === null) continue;
        if (!Array.isArray(values)) {
          problems.push(`${where} step ${stepIndex + 1} declares "${key}" that is not a list`);
          continue;
        }
        for (const reference of values) {
          if (typeof reference !== "string" || !reference.trim()) {
            problems.push(`${where} step ${stepIndex + 1} names an empty ${key} reference`);
            continue;
          }
          const references = key === "produces" ? fieldNames(c) : contractReferences(c);
          if (!references.has(normaliseReference(reference))) {
            problems.push(`${where} step ${stepIndex + 1} ${key} "${reference}" is not a declared `
              + "entity field or operation — a step may only name things the contract defines");
            continue;
          }
          // AN OPERAND HAS A TYPE. `reads` may name anything the contract declares — a field, an
          // operation, a computed fact — because it is context. `operates` names what the step
          // MANIPULATES, and the only thing a browser control can hold is a field.
          //
          // An operation there is meaningful and allowed: it says the step performs that operation,
          // and derivation gives it the action control rather than inventing a text box. An ENTITY
          // is not: "operates the booking" names no control and cannot be resolved to one, so it is
          // refused here, before a single token of generation is spent.
          if (key === "operates" && entityNames(c).has(normaliseReference(reference))
            && !fieldNames(c).has(normaliseReference(reference))) {
            problems.push(`${where} step ${stepIndex + 1} operates "${reference}", which is an entity, `
              + "not a control — name the field(s) the step changes, or the operation it performs");
          }
        }
      }
      if (KEYBOARD_FOCUS_INTENT.test(String(step?.action || ""))) {
        const operatedFields = (step?.operates || []).filter((reference) => (
          fieldNames(c).has(normaliseReference(reference))
        ));
        if (!operatedFields.length) {
          problems.push(`${where} step ${stepIndex + 1} focuses or tabs through controls without naming `
            + "their operated entity field(s) - add operates, and split mixed control types into separate steps");
        }
        if (!["selection", "textbox"].includes(step?.primitive)) {
          problems.push(`${where} step ${stepIndex + 1} focuses or tabs through controls without a driveable `
            + 'primitive - use "textbox" or "selection", and split mixed control types into separate steps');
        }
      }
      const verificationValues = step?.verificationValues;
      if (verificationValues !== undefined && (verificationValues === null
          || Array.isArray(verificationValues) || typeof verificationValues !== "object")) {
        problems.push(`${where} step ${stepIndex + 1} verificationValues is not an object keyed by operated field`);
      } else if (verificationValues) {
        const operated = new Set((step.operates || []).map(normaliseReference));
        for (const [field, value] of Object.entries(verificationValues)) {
          if (!fieldNames(c).has(normaliseReference(field)) || !operated.has(normaliseReference(field))) {
            problems.push(`${where} step ${stepIndex + 1} verificationValues names "${field}", which is not an operated entity field`);
          }
          if (!["string", "number", "boolean"].includes(typeof value)
              || (typeof value === "string" && !value.trim())) {
            problems.push(`${where} step ${stepIndex + 1} verificationValues.${field} must be a non-empty JSON primitive`);
          }
        }
      }
      if (Number(c.version || 1) >= 2 && step?.primitive === "selection") {
        const operatedFields = (step?.operates || []).filter((reference) => (
          fieldNames(c).has(normaliseReference(reference))
        ));
        if (operatedFields.length === 1) {
          const field = operatedFields[0];
          const fixture = Object.entries(verificationValues || {})
            .find(([candidate]) => normaliseReference(candidate) === normaliseReference(field))?.[1];
          const allOptionsSentinel = typeof fixture === "string"
            && /^(?:all|any|every|no preference|no filter)(?:\b|[-_])/i.test(fixture.trim());
          const previouslyChanged = journey.steps.slice(0, stepIndex).some((prior) => (
            (prior?.operates || []).some((reference) => normaliseReference(reference) === normaliseReference(field))
            && Object.entries(prior?.verificationValues || {}).some(([candidate, value]) => (
              normaliseReference(candidate) === normaliseReference(field)
              && !(typeof value === "string"
                && /^(?:all|any|every|no preference|no filter)(?:\b|[-_])/i.test(value.trim()))
            ))
          ));
          if (allOptionsSentinel && !previouslyChanged) {
            problems.push(`${where} step ${stepIndex + 1} selects all-options value ${JSON.stringify(fixture)} `
              + `for ${field} before that field has changed - it is normally the default and gives the browser no transition to verify; `
              + "combine it with another filter that changes, select a non-default value, or first change this field in an earlier step");
          }
        }
      }
      if (Number(c.version || 1) >= 2) {
        for (const field of verificationFixtureFields(step, c)) {
          const declared = Object.entries(verificationValues || {})
            .some(([candidate]) => normaliseReference(candidate) === normaliseReference(field));
          if (!declared) {
            problems.push(`${where} step ${stepIndex + 1} requires verificationValues.${String(field).split(".").pop()} `
              + `because "${step.action}" asks for a domain-constrained value the browser cannot safely invent`);
          }
        }
      }
    }
    if (journey.stage && !STAGES.includes(journey.stage)) problems.push(`${where} names unknown stage "${journey.stage}"`);
  }

  // AN OPERATION'S REFERENCES MUST POINT AT SOMETHING TOO.
  //
  // Steps have been reference-checked since the operand schema landed; operations never were, and
  // they are load-bearing in two places. `journey` is how a lifecycle role is declared — an id that
  // matches nothing silently drops the declaration and lets ownership fall back to guessing from
  // data flow, which is the misclassification that produced case H. `entity` is what a durable
  // outcome is proved against — an entity that does not exist puts a phantom in the manifest.
  // Neither failure announces itself; both are one comparison to catch.
  const declaredJourneys = new Set((c.journeys || []).map((journey) => journey?.id).filter(Boolean));
  const declaredEntities = entityNames(c);
  for (const [index, operation] of (c.operations || []).entries()) {
    const where = operation?.id || `operation ${index + 1}`;
    if (operation?.journey && !declaredJourneys.has(operation.journey)) {
      problems.push(`operation "${where}" names journey "${operation.journey}", which this contract `
        + "does not declare — its lifecycle role would be silently lost");
    }
    if (operation?.entity && !declaredEntities.has(normaliseReference(operation.entity))) {
      problems.push(`operation "${where}" writes entity "${operation.entity}", which this contract `
        + "does not declare — there would be no record to prove it against");
    }
    if (operation?.responsibilities !== undefined && !Array.isArray(operation.responsibilities)) {
      problems.push(`operation "${where}" responsibilities is not a list`);
      continue;
    }
    for (const [responsibilityIndex, responsibility] of (operation?.responsibilities || []).entries()) {
      const label = `operation "${where}" responsibility ${responsibilityIndex + 1}`;
      if (!["persistence", "functional"].includes(responsibility?.type)) {
        problems.push(`${label} has unknown type "${responsibility?.type || ""}"`);
      }
      for (const key of ["reads", "writes"]) {
        if (!Array.isArray(responsibility?.[key])) {
          problems.push(`${label} ${key} is not a list`);
          continue;
        }
        for (const reference of responsibility[key]) {
          const references = key === "writes" ? fieldNames(c) : contractReferences(c);
          if (!references.has(normaliseReference(reference))) {
            problems.push(`${label} ${key} "${reference}" is not a declared ${key === "writes" ? "entity field" : "entity field or operation"}`);
          }
        }
      }
      if (responsibility?.type === "functional") {
        if (!String(responsibility.behavior || operation.description || "").trim()) {
          problems.push(`${label} does not name the functional behavior`);
        }
        if (!responsibility.reads?.length) problems.push(`${label} has no declared functional inputs`);
        if (!responsibility.writes?.length && !functionalOutputEffect(operation, responsibility)) {
          problems.push(`${label} has no declared functional outputs`);
        }
      }
      if (responsibility?.type === "persistence"
          && entityPersistencePolicy(c, operation?.entity) === "transient") {
        problems.push(`${label} contradicts entity "${operation?.entity || "unknown"}", whose storage policy is transient`);
      }
      if (responsibility?.capability && !responsibility?.capabilityMethod) {
        problems.push(`${label} names capability "${responsibility.capability}" without a capabilityMethod`);
      }
    }
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
      if (step.verificationValues && Object.keys(step.verificationValues).length) {
        lines.push(`     verification inputs: ${JSON.stringify(step.verificationValues)}`);
      }
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
