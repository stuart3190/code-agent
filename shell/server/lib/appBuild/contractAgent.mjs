// Turn a request into an implementation contract.
//
// The planner used to emit prose — "Key features: booking, availability, confirmation" — which is
// unverifiable by construction. This asks for the same understanding in a shape that can be
// checked, then REFUSES to accept it if it comes back vague, because a contract full of "add
// booking functionality" is worse than no contract: every later stage would trust it.
//
// One retry on a failed validation, with the specific problems fed back. If it still fails, the
// build proceeds without a contract rather than blocking — a missing contract costs verification,
// a blocked build costs the customer everything.

import { runAgent } from "../../../../src/engine/runAgent.mjs";
import {
  CONTRACT_VERSION, STAGES, validateContract, contractSummary, functionalOutputEffect,
} from "../../../shared/implementationContract.mjs";
import {
  adoptBuildProfile, buildProfileBrief, requestUsesTransientSimulation, resolveBuildProfile,
  validateBuildProfileContract,
} from "../../../shared/buildProfile.mjs";
import { deriveBuildSpec } from "../builderV2/buildSpec.mjs";

// Exported so a test can hold the brief and the code that enforces it to the same statement:
// the operand type confusion of 2026-08-12 was a disagreement between them.
export const SYSTEM_PROMPT = `You convert an application request into a machine-readable IMPLEMENTATION
CONTRACT. You do not write code and you do not call tools. You reply with ONE JSON object and
nothing else — no prose, no markdown fence.

The contract is what the finished application will be TESTED against by an automated browser. Every
statement must therefore be an OBSERVABLE OUTCOME: something a test could click, type, read or
assert. "Add booking functionality" is not a contract. "Selecting an unavailable slot shows 'That
slot is taken' and does not create a booking" is.

The app is built in a fixed scaffold: Vite + React 18 + Tailwind, with a backend SDK
\`import { auth, db, storage } from "./lib/backend"\` providing auth (signUp/signIn/signOut/
currentUser/resetPassword/confirmReset), generic entity CRUD via db.entity("<type>"), and file
storage. Plan only within that: no extra packages, no raw HTTP, no other providers.

Shape:

{
  "summary": "one sentence describing the working application",
  "projectType": "landing | form | booking | dashboard | tool | saas | other",
  "journeys": [
    {
      "id": "book-a-slot",
      "title": "A visitor books an available slot",
      "priority": "primary",             // EXACTLY ONE journey is "primary" — the one that must
      "stage": "primary_journey",        // work before the preview may be shown. Others: "secondary".
      "steps": [
        { "action": "open the booking page", "target": "/book", "expect": "the list of services is visible" },
        { "action": "select a service and an available slot", "target": "service picker", "operates": ["serviceId", "slotId"], "expect": "the chosen slot is highlighted and the continue control becomes enabled" },
        { "action": "choose a party size within the slot's remaining capacity", "target": "party size control", "operates": ["partySize"], "reads": ["slotId", "slotCapacity"], "expect": "the chosen party size is displayed" },
        { "action": "enter name, email and phone and submit", "target": "details form", "operates": ["guestName", "guestEmail", "guestPhone"], "expect": "a confirmation with a booking reference is shown" },
        { "action": "reload the page and look the booking up by reference", "target": "manage booking", "reads": ["reference"], "expect": "the booking is still there after the reload" }
      ],
      "acceptance": ["a booking made in the browser survives a full page reload"]
    }
  ],
  "routes": [{ "path": "/", "name": "Home", "purpose": "...", "auth": false }],
  "entities": [{
    "name": "booking",
    "fields": [
      { "name": "slotId", "type": "string", "required": true },
      { "name": "guestName", "type": "string", "required": true },
      { "name": "guestEmail", "type": "string", "required": true },
      { "name": "reference", "type": "string", "required": true },
      { "name": "status", "type": "string", "required": true }
    ],
    "owned": true,                        // true when rows belong to the signed-in user
    "relationships": ["a booking references one slot"]
  }],
  "auth": { "required": true, "model": "email + password via the backend SDK", "rules": ["a signed-out visitor cannot see another customer's booking"] },
  "operations": [{
    "id": "create-booking", "entity": "booking", "kind": "create",
    "description": "persist a booking via db.entity('booking').create", "journey": "book-a-slot",
    "responsibilities": [{
      "type": "persistence", "capability": "crud", "capabilityMethod": "create",
      "reads": ["slotId", "guestName", "guestEmail"], "writes": ["reference", "status"]
    }]
  }],
  "integrations": [{ "name": "none", "purpose": "", "required": false }],
  "states": [{ "surface": "booking page", "loading": "skeleton while slots load", "empty": "no slots left this week", "validation": "email must look like an email", "error": "saving failed, try again", "success": "confirmation with reference" }],
  "acceptance": [{ "id": "a1", "statement": "a submitted booking is readable after a page reload", "journey": "book-a-slot", "kind": "persistence" }],
  "deferred": [{ "item": "real card payment", "reason": "payment is taken on arrival" }]
}

Rules:
- EVERY journey has at least two steps, and every step has an "expect" naming something visible.
- A step that manipulates controls lists them in "operates" — the fields it actually changes, by
  their declared entity field names. State the step merely DEPENDS on goes in "reads". A step that
  chooses a party size within a slot's capacity OPERATES partySize and READS slotId; naming the
  slot in "operates" would tell the verifier to re-open a control the previous step already used.
  "operates" may also name the declared OPERATION id the step performs. Fields become value
  controls; an operation id binds the action control and never becomes a textbox. A step may list
  both. "reads" names dependencies the step consumes without performing or changing them.
- When one user action selects an item and atomically supplies related metadata, put only the
  user-operated identity in "operates" and put the derived fields in "produces". For example, one
  product choice may operate productId and produce productTitle and unitPrice; those outputs are
  state written by the same action, not additional controls the visitor must drive.
- Add "primitive": "selection" or "textbox" only when the verb leaves it ambiguous.
- A keyboard-focus or tab-navigation step is a control interaction, not a passive observation. It
  MUST name the focused entity field(s) in "operates" and declare "primitive". Split text-entry
  controls and selection controls into separate journey steps so each step has one primitive.
- When a step asks for a domain-correct or domain-incorrect value that cannot be derived from the
  native input type, add "verificationValues": { "fieldName": "synthetic test value" } for the
  affected operated field. This value is the single non-secret authority used by generation and
  browser verification. The generated sample data/business rule MUST accept or reject it exactly
  as the step asks. Never put a real password, token, credential, customer record, or other secret
  in verificationValues. Ordinary names, emails, numbers and dates need no override when their
  native HTML constraints fully describe validity.
- A transient functional search/filter/query operation also needs verificationValues for EVERY
  operated search or filter field. Choose one exact combination that the generated sample data
  will match; use a non-empty all-options sentinel for optional filters rather than an empty value.
  An all-options sentinel is normally the initial/default selection, so it MUST NOT be the only
  field in its own selection step unless an earlier step changed that same field to a non-default
  value. Keep the sentinel in a compound filter step where another field genuinely changes, choose
  a non-default option, or first change this field so the browser has a real transition to verify.
- EXACTLY ONE journey has priority "primary".
- At least three acceptance entries, each an observable outcome.
- Stages must be one of: ${STAGES.join(", ")}.
- If the request implies stored data, declare the entities and the operations that write them.
- Every operation declares \`responsibilities\`. Persistence and functional transformation are
  separate responsibilities even when they happen behind one button. CRUD may create/read/update/
  delete values supplied by its caller; it never calculates, generates, optimises, allocates or
  otherwise produces domain values. A transformation responsibility uses
  \`{ "type": "functional", "behavior": "...", "reads": [declared input fields],
  "writes": [declared output fields] }\`. Add a separate persistence responsibility when those
  outputs are saved. Only name \`capability\` and \`capabilityMethod\` when that exact registered method
  implements the functional behavior; otherwise leave them absent so Builder V2 creates a bounded
  custom_behavior extension.
- \`operation.entity\` is the output/state owner. Every responsibility \`writes\` entry must be a
  field declared on that entity. Functional \`reads\` may consume fields from other entities.
- Functional operations that return an observable result without mutating entity state use a
  structured read-like or terminal kind: read/get/list/search/export/download/print. Their
  \`writes\` may be empty because Builder V2 gives the returned result transient state ownership;
  they must still declare the fields they \`read\`. Create/update/delete transformations still
  require explicit entity-field \`writes\`.
- Anything you are NOT building goes in "deferred" with a reason. Deferring is honest; a control
  that pretends to work is not.
- Public marketing content (business name, service list, opening hours) is in-code constants, NOT
  backend entities. Only user-created records are entities.
- Do not add reload, recovery, lookup-by-reference, history, authentication, persistence, or backend
  operations unless the REQUEST explicitly requires that behavior. A visible confirmation does not
  imply that it can be recovered later.
- Demo, mock, prototype, placeholder, or simulated submissions are client-only transient state
  unless the REQUEST separately requires saved data, backend storage, reload, history, or recovery.
  Mark their entity storage as transient and use functional responsibilities; do not copy the
  durable booking/recovery example into a basic simulated website.`;

function extractJson(text) {
  const raw = String(text || "").trim();
  // Models fence JSON despite instructions; take the outermost object either way.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

// Fill in what the shape needs but a model may omit, so downstream code never guards every field.
export function normaliseContract(contract, { prompt, buildProfile = null, legacy = false }) {
  const c = { ...contract };
  c.version = CONTRACT_VERSION;
  c.summary = String(c.summary || "").trim() || String(prompt || "").slice(0, 160);
  c.projectType = c.projectType || "other";
  for (const key of ["journeys", "routes", "entities", "operations", "integrations", "states", "acceptance", "deferred"]) {
    if (!Array.isArray(c[key])) c[key] = [];
  }
  c.auth = c.auth && typeof c.auth === "object" ? c.auth : { required: false, model: null, rules: [] };
  if (!Array.isArray(c.auth.rules)) c.auth.rules = [];

  c.journeys = c.journeys.map((journey, index) => ({
    ...journey,
    id: journey.id || `journey-${index + 1}`,
    stage: STAGES.includes(journey.stage) ? journey.stage : "primary_journey",
    // A model that omits operates/reads leaves them ABSENT rather than empty: absent means "this
    // contract predates the structured schema, fall back to reading the prose", while an empty
    // list would mean "this step operates nothing", and the two must not be confused.
    steps: (Array.isArray(journey.steps) ? journey.steps : []).map((step) => {
      const list = (value) => (Array.isArray(value) ? value.map(String).filter(Boolean) : null);
      const operates = list(step?.operates);
      const reads = list(step?.reads);
      const produces = list(step?.produces);
      return {
        ...step,
        ...(operates?.length ? { operates } : {}),
        ...(reads?.length ? { reads } : {}),
        ...(produces?.length ? { produces } : {}),
      };
    }),
    acceptance: Array.isArray(journey.acceptance) ? journey.acceptance : [],
  }));
  // Exactly one primary, decided here rather than trusted: a contract with none would fail
  // validation, and a contract with three would make "the primary journey" ambiguous downstream.
  const primaries = c.journeys.filter((j) => j.priority === "primary");
  if (!primaries.length && c.journeys.length) c.journeys[0].priority = "primary";
  else if (primaries.length > 1) primaries.slice(1).forEach((j) => { j.priority = "secondary"; });

  c.entities = c.entities.map((entity) => ({
    ...entity,
    fields: Array.isArray(entity.fields) ? entity.fields : [],
    relationships: Array.isArray(entity.relationships) ? entity.relationships : [],
    owned: entity.owned !== false,
  }));
  c.operations = c.operations.map((operation) => {
    const normalizedOperation = { ...operation };
    if (!Array.isArray(operation?.responsibilities)) return normalizedOperation;
    normalizedOperation.responsibilities = operation.responsibilities.map((responsibility) => {
      const normalizedResponsibility = {
        ...responsibility,
        reads: Array.isArray(responsibility?.reads) ? responsibility.reads.map(String).filter(Boolean) : [],
        writes: Array.isArray(responsibility?.writes) ? responsibility.writes.map(String).filter(Boolean) : [],
      };
      const outputEffect = functionalOutputEffect(normalizedOperation, normalizedResponsibility);
      return outputEffect ? { ...normalizedResponsibility, outputEffect } : normalizedResponsibility;
    });
    return normalizedOperation;
  });
  // A complete profile is an intake authority, not another inference hint. Contract prompts may
  // contain project knowledge or expanded planning prose whose incidental words must not create
  // new product obligations after intake has been resolved.
  c.buildProfile = adoptBuildProfile(buildProfile)
    || resolveBuildProfile({ prompt, input: buildProfile, legacy });
  if (requestUsesTransientSimulation(prompt)) {
    const recoveryPattern = /\b(?:recover(?:y|ed)?|reload|look[ -]?up|lookup|retrieve|read\s+(?:an?\s+)?[^.!?]{0,24}\breference|by reference)\b/i;
    const operationKind = (operation) => String(
      operation?.kind || operation?.type || operation?.action || operation?.id || operation?.name || "",
    ).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)[0] || "";
    const readKinds = new Set(["read", "get", "find", "lookup", "retrieve", "search"]);
    const removedOperations = new Set(c.operations.filter((operation) => (
      readKinds.has(operationKind(operation))
        && recoveryPattern.test(`${operation?.id || ""} ${operation?.name || ""} ${operation?.description || ""}`)
    )).map((operation) => String(operation?.id || operation?.name || "").toLowerCase()).filter(Boolean));
    c.operations = c.operations.filter((operation) => !removedOperations.has(
      String(operation?.id || operation?.name || "").toLowerCase(),
    )).map((operation) => ({
      ...operation,
      responsibilities: (operation.responsibilities || []).map((responsibility) => {
        if (responsibility?.type !== "persistence") return responsibility;
        const {
          capability, capabilityId, capabilityMethod, method, operation: requestedOperation, ...functional
        } = responsibility;
        return {
          ...functional,
          type: "functional",
          behavior: responsibility.behavior || operation.description
            || `produce the simulated ${operation.entity || "result"} state`,
        };
      }),
    }));
    c.entities = c.entities.map((entity) => ({
      ...entity,
      owned: false,
      storage: "client-only transient state for the simulated journey; not persisted to backend",
    }));
    c.journeys = c.journeys.map((journey) => ({
      ...journey,
      steps: (journey.steps || []).filter((step) => {
        const references = [...(step?.operates || []), ...(step?.reads || [])]
          .map((value) => String(value).toLowerCase());
        if (references.some((reference) => removedOperations.has(reference))) return false;
        return !recoveryPattern.test(`${step?.action || ""} ${step?.target || ""}`);
      }),
      acceptance: (journey.acceptance || []).filter((entry) => !recoveryPattern.test(
        typeof entry === "string" ? entry : JSON.stringify(entry),
      )),
    }));
    c.acceptance = c.acceptance.filter((entry) => !recoveryPattern.test(
      typeof entry === "string" ? entry : JSON.stringify(entry),
    ));
  }
  return c;
}

const DEPENDENCY_ISSUE = "interaction_state_dependency_missing";
const SEMANTICS_ISSUE = "interaction_contract_semantics_incomplete";
// One field name operated for two entities in one journey shares one control identity (see
// interactionContract.mjs controlIdentityCollisions). Live proof (bv2 medium, build 018625f3):
// the gate named the collision, but the repair lane had no scope for it, fell back to an
// unscoped rewrite, and the model returned the same contract — the build died at 2.9 credits
// having been told exactly what was wrong and given no way to say it back.
const COLLISION_ISSUE = "interaction_control_identity_collision";
export const COLLISION_REPAIR_INSTRUCTION = "A field name listed under invalidControlIdentities is operated "
  + "for two different entities inside one journey, so both controls share one identity. Rename that field on "
  + "the entity that is not the journey's primary subject (for example task.dueDate becomes taskDueDate) and "
  + "use the new name consistently: in that entity's fields, in every operation responsibility that reads or "
  + "writes it, and in every journey step's operates, reads, produces and verificationValues that refer to it. "
  + "Leave the other entity's field name unchanged. Do not add, remove or reorder steps, operations or entities.";

export const DEPENDENCY_REPAIR_INSTRUCTION = "Correct only the supplied invalid dependency or semantic subset. "
  + "Do not invent user actions, operations, entities, fields, or business behavior. You may mark an existing "
  + "step or operation as producing an already-declared field only when its existing observable result already "
  + "exposes that field; this records existing data flow rather than adding behavior. Reorder an existing producer "
  + "only when the declared journey semantics permit it; otherwise connect an already-declared producer or return "
  + "the unresolved dependency unchanged. Do not duplicate journey steps. Listing a field in `operates` means the "
  + "user changes that control; it does not make a navigation or observation step produce the field. Existing "
  + "durable entity data may instead be declared in the journey's durableState when it genuinely exists before the "
  + "journey starts. Prefer a durableState array containing the exact missingStatePath string rather than a nested "
  + "entity object.";

/**
 * Build the smallest contract subset needed to repair invalid journey data flow or operation
 * semantics.
 * Unaffected journeys and global contract sections are deliberately omitted.
 */
export function contractDependencyRepairScope(contract, issues = []) {
  const dependencies = (issues || []).filter((issue) => issue?.code === DEPENDENCY_ISSUE);
  const semantics = (issues || []).filter((issue) => issue?.code === SEMANTICS_ISSUE);
  const collisions = (issues || []).filter((issue) => issue?.code === COLLISION_ISSUE);
  if (!contract || (!dependencies.length && !semantics.length && !collisions.length)) return null;
  const semanticOperationIds = new Set(semantics.map((issue) => issue.operationId).filter(Boolean));
  const semanticOperations = (contract.operations || []).filter((operation) => (
    semanticOperationIds.has(operation?.id || operation?.name)
  ));
  const semanticJourneyIds = semantics.map((issue) => issue.journeyId || (contract.journeys || [])
    .map((journey) => journey.id).filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .find((journeyId) => String(issue.interactionId || "").startsWith(`${journeyId}:`)));
  const journeyIds = new Set([
    ...dependencies.map((issue) => issue.journeyId),
    ...semanticJourneyIds,
    ...semanticOperations.map((operation) => operation?.journey),
    ...collisions.map((issue) => issue.journeyId),
  ].filter(Boolean));
  const journeys = (contract.journeys || []).filter((journey) => journeyIds.has(journey.id));
  const operationByIdentity = new Map((contract.operations || []).map((operation) => (
    [String(operation?.id || operation?.name || "").toLowerCase(), operation]
  )).filter(([identity]) => identity));
  const priorOperationCandidates = new Map(dependencies.map((issue) => {
    const journey = journeys.find((candidate) => candidate.id === issue.journeyId);
    const consumerStepIndex = Number.isInteger(issue.consumerStepIndex)
      ? issue.consumerStepIndex : 0;
    const seen = new Set();
    const candidates = (journey?.steps || []).slice(0, consumerStepIndex).flatMap((step, stepIndex) => (
      [...(step?.operates || []), ...(step?.reads || [])].flatMap((value) => {
        const operation = operationByIdentity.get(String(value || "").toLowerCase());
        const operationId = operation?.id || operation?.name || null;
        if (!operationId || seen.has(operationId)) return [];
        seen.add(operationId);
        return [{ operationId, stepIndex }];
      })
    ));
    return [issue, candidates];
  }));
  const operationIds = new Set(dependencies.flatMap((issue) => [
    issue.consumerOperationId,
    ...(issue.candidateProducers || []).map((producer) => producer.operationId),
    ...(priorOperationCandidates.get(issue) || []).map((producer) => producer.operationId),
  ]).filter(Boolean));
  for (const operationId of semanticOperationIds) operationIds.add(operationId);
  for (const issue of collisions) {
    for (const use of issue.uses || []) for (const operationId of use.operationIds || []) operationIds.add(operationId);
  }
  for (const operation of contract.operations || []) {
    if (journeyIds.has(operation?.journey)) operationIds.add(operation.id || operation.name);
  }
  const operations = (contract.operations || []).filter((operation) => (
    operationIds.has(operation?.id || operation?.name)
  ));
  const entityNames = new Set(operations.map((operation) => operation?.entity).filter(Boolean));
  const usedFields = new Set([
    ...dependencies.map((issue) => String(issue.missingStatePath || "").split(".").at(-1)),
    ...journeys.flatMap((journey) => (journey.steps || []).flatMap((step) => [
      ...(step.operates || []), ...(step.reads || []), ...(step.produces || []),
    ])),
    ...operations.flatMap((operation) => (operation.responsibilities || []).flatMap((responsibility) => [
      ...(responsibility.reads || []), ...(responsibility.writes || []),
    ])),
  ].filter(Boolean).map(String));
  const entities = (contract.entities || []).filter((entity) => entityNames.has(entity.name)
    || (entity.fields || []).some((field) => usedFields.has(String(field?.name || field))))
    .map((entity) => ({
      ...entity,
      fields: (entity.fields || []).filter((field) => usedFields.has(String(field?.name || field))),
    }));
  return {
    mode: semantics.length || collisions.length ? "interaction_contract_repair" : "interaction_state_dependency_repair",
    contractSummary: contract.summary || null,
    ...(collisions.length ? { invalidControlIdentities: collisions.map((issue) => ({
      journeyId: issue.journeyId, field: issue.field, machineId: issue.machineId,
      uses: (issue.uses || []).map((use) => ({
        stepIndex: use.stepIndex, entity: use.entity, operationIds: use.operationIds || [],
      })),
    })) } : {}),
    invalidDependencies: dependencies.map((issue) => ({
      journeyId: issue.journeyId,
      consumerStepId: issue.consumerStepId,
      consumerOperationId: issue.consumerOperationId,
      missingStatePath: issue.missingStatePath,
      expectedProducerSource: issue.expectedProducerSource,
      expectedProducerSources: issue.expectedProducerSources,
      candidateProducers: issue.candidateProducers || [],
      priorOperationCandidates: priorOperationCandidates.get(issue) || [],
    })),
    invalidSemantics: semantics.map((issue) => ({
      operationId: issue.operationId || null,
      interactionId: issue.interactionId || null,
      journeyId: issue.journeyId || null,
      missingFields: issue.missingFields || [],
    })),
    journeys,
    operations,
    entities,
    auth: contract.auth || null,
    states: (contract.states || []).filter((state) => {
      const text = JSON.stringify(state);
      return [...usedFields].some((field) => text.includes(field));
    }),
    initialState: contract.initialState || null,
    durableState: contract.durableState || null,
    externalState: contract.externalState || null,
  };
}

const mergeScoped = (current, replacements, allowed, identity) => {
  const byId = new Map((replacements || []).map((value) => [identity(value), value]).filter(([id]) => id));
  return (current || []).map((value) => {
    const id = identity(value);
    return allowed.has(id) && byId.has(id) ? byId.get(id) : value;
  });
};

const mergeScopedEntities = (current, replacements, allowed) => {
  const byId = new Map((replacements || []).map((value) => [value?.name, value]).filter(([id]) => id));
  return (current || []).map((entity) => {
    if (!allowed.has(entity?.name) || !byId.has(entity?.name)) return entity;
    const replacement = byId.get(entity.name);
    const replacementFields = new Map((replacement.fields || [])
      .map((field) => [String(field?.name ?? field), field]));
    const retained = (entity.fields || []).map((field) => (
      replacementFields.get(String(field?.name ?? field)) || field
    ));
    const existing = new Set((entity.fields || []).map((field) => String(field?.name ?? field)));
    const added = (replacement.fields || []).filter((field) => !existing.has(String(field?.name ?? field)));
    return { ...entity, ...replacement, name: entity.name, fields: [...retained, ...added] };
  });
};

const nestedObjectKeys = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, nested]) => [key, ...nestedObjectKeys(nested)]);
};

const normalizeRepairJourneyStartState = (journey, scope) => {
  if (!journey || Array.isArray(journey.durableState)
    || !journey.durableState || typeof journey.durableState !== "object") return journey;
  const declaredFields = new Set(nestedObjectKeys(journey.durableState).map((value) => String(value).toLowerCase()));
  const matchingPaths = (scope.invalidDependencies || [])
    .filter((issue) => issue.journeyId === journey.id)
    .map((issue) => String(issue.missingStatePath || ""))
    .filter((path) => path && declaredFields.has(String(path).split(".").at(-1).toLowerCase()));
  if (!matchingPaths.length) return journey;
  // Scoped repair already established the exact missing path and the model explicitly placed its
  // field under durableState. Convert that equivalent structured declaration to the canonical
  // exact-path representation; unrelated object keys cannot acquire start-state authority.
  return { ...journey, durableState: [...new Set(matchingPaths)] };
};

/** Merge only the dependency subset the correction call was authorized to change. */
export function mergeContractDependencyRepair(contract, reply, scope) {
  if (!scope) return reply;
  const patch = reply?.contractPatch || reply || {};
  const repairedJourneys = (patch.journeys || [])
    .map((journey) => normalizeRepairJourneyStartState(journey, scope));
  const journeyIds = new Set((scope.journeys || []).map((journey) => journey.id));
  const operationIds = new Set((scope.operations || []).map((operation) => operation.id || operation.name));
  const entityNames = new Set((scope.entities || []).map((entity) => entity.name));
  // A control-identity collision is repaired by RENAMING the colliding field on one entity. The
  // field-preserving merge below would keep the old name beside the new one; when the reply's
  // version of a colliding entity no longer lists the colliding field, that omission is the rename
  // and the old field goes with it. Only colliding fields on colliding entities may disappear.
  const renamedAway = new Map();
  for (const collision of scope.invalidControlIdentities || []) {
    for (const use of collision.uses || []) {
      const replied = (patch.entities || []).find((entity) => entity?.name === use.entity);
      if (!replied) continue;
      const stillListed = (replied.fields || []).some((field) => String(field?.name ?? field) === collision.field);
      if (stillListed) continue;
      if (!renamedAway.has(use.entity)) renamedAway.set(use.entity, new Set());
      renamedAway.get(use.entity).add(collision.field);
    }
  }
  const entities = mergeScopedEntities(contract.entities, patch.entities, entityNames)
    .map((entity) => (renamedAway.has(entity?.name)
      ? { ...entity, fields: (entity.fields || []).filter((field) => !renamedAway.get(entity.name).has(String(field?.name ?? field))) }
      : entity));
  return {
    ...contract,
    journeys: mergeScoped(contract.journeys, repairedJourneys, journeyIds, (journey) => journey?.id),
    operations: mergeScoped(contract.operations, patch.operations, operationIds,
      (operation) => operation?.id || operation?.name),
    // The repair scope intentionally sends only fields used by the invalid journeys. Replacing a
    // shared entity with that subset deletes fields owned by untouched journeys. Merge returned
    // fields by identity and preserve every unlisted field; new corrected fields remain allowed
    // inside the already-authorized entity.
    entities,
  };
}

/**
 * Produce and validate the contract.
 *
 * Returns `{ contract, attempts, problems, warnings, usage }`; `contract` is null when the model
 * could not produce a usable one twice, and the caller carries on without it.
 *
 * `priorContract`/`priorProblems` turn the call into a REPAIR: the build gate derived a spec from
 * an accepted contract and could not, and the model is shown the contract it wrote together with
 * the exact obligations that failed. Without them, a contract the gate rejects is unrecoverable —
 * the build blocks before generation with no attempt the model was ever asked to make.
 */
export async function generateContract({
  provider, prompt, buildProfile = null, knowledge = "", log = () => {}, onUsage = null,
  priorContract = null, priorProblems = [], priorIssues = [],
}) {
  const productProfile = adoptBuildProfile(buildProfile)
    || resolveBuildProfile({ prompt, input: buildProfile, legacy: !buildProfile });
  const transientGuidance = requestUsesTransientSimulation(prompt)
    ? "\n- This request explicitly describes a simulated/demo flow without durable storage. Keep it client-only and transient; do not add backend persistence, reload, history, or recovery."
    : "";
  const profileGuidance = `${buildProfileBrief(productProfile)}${transientGuidance}`;
  const baseAsk = `${knowledge ? `${knowledge}\n\n` : ""}${profileGuidance}\n\nREQUEST:\n${prompt}`;
  let lastProblems = (priorProblems || []).map(String).filter(Boolean);
  let lastContract = lastProblems.length ? priorContract : null;
  const repairMode = Boolean(lastContract);
  const dependencyRepairScope = lastContract
    ? contractDependencyRepairScope(lastContract, priorIssues) : null;
  let usageTotal = null;
  // The best contract seen, even if it did not fully validate. Discarding a contract because one
  // acceptance line reads weakly throws away the journeys, the entities and the deferred list —
  // and in production that silently dropped the whole build back to unstaged, uncontracted
  // generation. A contract with a soft edge is worth far more than none.
  let best = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const dependencyAsk = dependencyRepairScope
      ? `${profileGuidance}\n\nSCOPED INTERACTION CONTRACT REPAIR MODE. ${DEPENDENCY_REPAIR_INSTRUCTION} `
        + `${dependencyRepairScope.invalidControlIdentities?.length ? `${COLLISION_REPAIR_INSTRUCTION} ` : ""}`
        + `Return one JSON object containing only corrected `
        + `journeys, operations, and entities from this subset; unlisted contract sections are preserved `
        + `server-side.\n\nINVALID DEPENDENCY SUBSET:\n${JSON.stringify(dependencyRepairScope)}\n\n`
        + `REJECTION DETAILS:\n${lastProblems.map((problem) => `- ${problem}`).join("\n")}`
      : null;
    const ask = dependencyAsk || (lastProblems.length
      ? `${baseAsk}\n\n${lastContract ? `Your previous contract:\n${JSON.stringify(lastContract)}\n\n` : ""}Your previous contract was rejected:\n${lastProblems.map((p) => `- ${p}`).join("\n")}\n\nReturn a corrected contract. Every step and acceptance entry must name something a browser test could observe.`
      : baseAsk);

    const { telemetry, finalText } = await runAgent({
      provider, systemPrompt: SYSTEM_PROMPT, tools: [], toolImpls: {},
      tree: {}, prompt: ask, log, onUsage,
    });
    usageTotal = telemetry;

    const parsed = extractJson(finalText);
    if (!parsed) {
      lastProblems = ["the reply was not a JSON object"];
      lastContract = null;
      log(`contract: attempt ${attempt} did not return JSON`);
      continue;
    }
    // A reply whose SHAPE breaks merge, normalisation or derivation is a rejected attempt with a
    // named reason, never an exception that ends the lane: the second attempt then sees exactly
    // what the first reply did wrong (bv2 medium, build c56cb4c2 — one gate-repair call, then
    // silence).
    let contract;
    let verdict;
    try {
      const repaired = dependencyRepairScope
        ? mergeContractDependencyRepair(priorContract, parsed, dependencyRepairScope) : parsed;
      contract = normaliseContract(repaired, { prompt, buildProfile: productProfile });
      const baseVerdict = validateContract(contract);
      const profileVerdict = validateBuildProfileContract(contract, productProfile);
      // A scoped gate repair is useful only if it closes the same canonical derivation gates that
      // requested the repair. Structural validation alone accepted malformed replies that duplicated
      // navigation steps and put a missing field in `operates`; the orchestrator then rejected the
      // unchanged missing producer without giving the repair lane its built-in correction attempt.
      // Every REPAIR attempt is judged by the canonical derivation, scoped or not: an unscoped
      // repair that structurally validated but still collided was accepted here and rejected by
      // the orchestrator's gate with no second attempt (bv2 medium, build 018625f3).
      const derivedVerdict = dependencyRepairScope || repairMode ? deriveBuildSpec(contract).verdict : null;
      verdict = {
        ok: baseVerdict.ok && profileVerdict.ok && (!derivedVerdict || derivedVerdict.ok),
        problems: [...new Set([
          ...baseVerdict.problems,
          ...profileVerdict.problems,
          ...(derivedVerdict?.problems || []),
        ])],
        warnings: baseVerdict.warnings,
      };
    } catch (error) {
      lastProblems = [`the reply could not be applied as a contract: ${String(error?.message || error).slice(0, 300)}`];
      lastContract = repairMode ? priorContract : null;
      log(`contract: attempt ${attempt} rejected — ${lastProblems[0]}`);
      continue;
    }
    if (verdict.ok) {
      log(`contract: ${contractSummary(contract)}${verdict.warnings.length ? ` (${verdict.warnings.length} warning(s))` : ""}`);
      return { contract, attempts: attempt, problems: [], warnings: verdict.warnings, usage: usageTotal };
    }
    lastProblems = verdict.problems;
    lastContract = contract;
    // Keep the one with fewer problems; a second attempt is not automatically better.
    if (!best || verdict.problems.length < best.problems.length) best = { contract, problems: verdict.problems };
    log(`contract: attempt ${attempt} rejected — ${verdict.problems.slice(0, 3).join("; ")}`);
  }

  // Neither attempt fully validated. Fall back to the better of the two rather than to nothing:
  // its journeys, entities and deferred list are still what the build should be judged against,
  // and the specific weaknesses travel with it so nothing downstream mistakes it for clean.
  if (best?.contract) {
    // A contract with no journeys cannot drive staging or verification — that one really is
    // unusable, and pretending otherwise would produce a stage plan built on nothing.
    const usable = (best.contract.journeys || []).some((j) => (j.steps || []).length >= 2);
    if (usable) {
      log(`contract: accepted with ${best.problems.length} unresolved problem(s) — ${best.problems.slice(0, 2).join("; ")}`);
      return { contract: best.contract, attempts: 2, problems: best.problems, warnings: [], usage: usageTotal, degraded: true };
    }
  }

  log(`contract: unavailable after 2 attempts — ${lastProblems.slice(0, 2).join("; ")}`);
  return { contract: null, attempts: 2, problems: lastProblems, warnings: [], usage: usageTotal };
}
