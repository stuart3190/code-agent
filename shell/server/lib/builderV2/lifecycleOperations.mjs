// Canonical lifecycle operation semantics.
//
// WHY THIS EXISTS
//
// A journey's relationship to a durable record is a LIFECYCLE question with exactly three answers:
//
//   CREATE an entity record            → this journey PRODUCES the record
//   UPDATE an existing entity record   → this journey CONSUMES a record something else produced
//   CANCEL/ARCHIVE/DELETE an existing record → likewise CONSUMES it
//
// It was being inferred from the data-flow graph alone — "the mutation is fed by draft values that
// name declared entity fields, therefore this journey created the record". That reading is right
// for a creation and wrong for an edit: an update journey references an existing record AND
// supplies substantive edited field values, so it looked exactly like a producer, and the verifier
// then ran it as a fresh visitor with no record to edit.
//
// The contract already states which it is. `contract.operations` declares, per entity, an
// operation `kind` and (when the contract links them) the `journey` that invokes it. That
// metadata is canonical and is read here. Natural-language verbs are NOT consulted: this module
// contains no journey prose, and the language layer (actionIntent.mjs) contains no ownership.

const normalized = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Contract-declared operation kinds, mapped onto the lifecycle vocabulary. Contracts are written
// by a model against a documented shape ("create" | "read" | "update" | "delete"), and these
// synonyms exist so a contract that says "insert" or "archive" is still understood exactly.
const CANONICAL_KINDS = [
  ["create", /^(?:create|insert|add|new|make|write|register|submit)$/],
  ["update", /^(?:update|edit|patch|modify|change|amend|cancel|archive|close|void|restore|set|upsert)$/],
  ["delete", /^(?:delete|remove|destroy|purge|drop)$/],
  ["read", /^(?:read|get|list|find|lookup|search|query|view|fetch)$/],
];

/** One declared operation kind, canonicalised. Returns null for anything unrecognised. */
export function canonicalOperationKind(kind) {
  const value = normalized(kind);
  if (!value) return null;
  return CANONICAL_KINDS.find(([, pattern]) => pattern.test(value))?.[0] || null;
}

/** A create operation makes a new record; every other kind acts on one that already exists. */
export const OPERATES_ON_EXISTING_RECORD = Object.freeze(["update", "delete", "read"]);

/**
 * The contract's declared operations for one journey, restricted to a lifecycle entity.
 *
 * Two canonical links, in order of authority:
 *   1. `operation.journey` — the contract says which journey invokes the operation.
 *   2. `operation.id`/`operation.name` equal to the journey id — still the contract's own
 *      identifiers, never its prose.
 * A contract that links neither declares nothing about this journey, and the caller falls back to
 * the data-flow graph.
 */
export function journeyLifecycleOperations(contract, journey, { entity = null } = {}) {
  const journeyId = String(journey?.id || journey || "");
  if (!journeyId) return [];
  const operations = (contract?.operations || []).filter(Boolean);
  const sameEntity = (operation) => !entity || !operation.entity
    || normalized(operation.entity) === normalized(entity);
  const linked = operations.filter((operation) => operation.journey
    && String(operation.journey) === journeyId);
  if (linked.length) return linked.filter(sameEntity);
  const byIdentity = operations.filter((operation) => [operation.id, operation.name]
    .filter(Boolean).some((identifier) => String(identifier) === journeyId));
  return byIdentity.filter(sameEntity);
}

/** The canonical lifecycle kinds this journey's declared operations perform. */
export function journeyLifecycleKinds(contract, journey, options = {}) {
  return [...new Set(journeyLifecycleOperations(contract, journey, options)
    .map((operation) => canonicalOperationKind(operation.kind || operation.type))
    .filter(Boolean))];
}

/**
 * What the contract DECLARES about this journey's lifecycle role, or null when it declares nothing.
 *
 * "creates" wins over "operates on an existing record": a journey that creates a record and then
 * edits it is still that record's producer, which is exactly generic case E.
 */
export function declaredLifecycleRole(contract, journey, options = {}) {
  const kinds = journeyLifecycleKinds(contract, journey, options);
  if (!kinds.length) return null;
  if (kinds.includes("create")) return "creates";
  if (kinds.some((kind) => OPERATES_ON_EXISTING_RECORD.includes(kind))) return "existing";
  return null;
}
