// Entity schema module v1 — platform infrastructure, do not edit or reimplement.
//
// The contract defines domain meaning (entities, fields, references); the platform compiles it
// into validation, typed record shapes, relationship enforcement and query field allow-lists
// (audit §9). This file is pure: the same schema and validation run in the generated
// application, in the shell's compiler and in tests. No I/O.

export const SCHEMA_VERSION = 1;

export const FIELD_TYPES = Object.freeze([
  "string", "text", "number", "integer", "boolean", "date", "datetime", "email", "url", "reference", "enum", "json",
]);

/** Metadata the platform owns on every record; never a domain field, never writable by the app. */
export const RESERVED_FIELDS = Object.freeze(["id", "version", "createdAt", "updatedAt", "owner", "created_at", "app_id", "type", "__meta"]);

const TYPE_ALIASES = Object.freeze({
  str: "string", string: "string", text: "text", longtext: "text", richtext: "text", textarea: "text",
  number: "number", numeric: "number", float: "number", decimal: "number", currency: "number", money: "number",
  int: "integer", integer: "integer", count: "integer",
  bool: "boolean", boolean: "boolean", flag: "boolean",
  date: "date", datetime: "datetime", timestamp: "datetime", time: "datetime",
  email: "email", url: "url", link: "url",
  reference: "reference", ref: "reference", relation: "reference", id: "reference", uuid: "reference", foreignkey: "reference",
  enum: "enum", select: "enum", choice: "enum", status: "enum",
  json: "json", object: "json", array: "json", list: "json", map: "json",
});

const lower = (value) => String(value || "").trim().toLowerCase();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

export function normalizeFieldType(raw, { hasOptions = false } = {}) {
  const key = lower(raw).replace(/[^a-z]/g, "");
  if (hasOptions) return "enum";
  return TYPE_ALIASES[key] || "string";
}

/** `<entity>Id` (or `<entity>_id`) names a reference to a declared entity. */
function referenceTarget(fieldName, entityNames) {
  const match = /^(.+?)[-_ ]?(?:id|ref|reference)$/i.exec(String(fieldName || ""));
  if (!match) return null;
  const stem = lower(match[1]).replace(/[^a-z0-9]/g, "");
  return entityNames.find((name) => lower(name).replace(/[^a-z0-9]/g, "") === stem
    || lower(name).replace(/[^a-z0-9]/g, "") === `${stem}s` || `${lower(name).replace(/[^a-z0-9]/g, "")}s` === stem) || null;
}

/**
 * Compile contract entities into a schema.
 *   entities: [{ name, fields: [{ name, type, required, options|enum, target, minimum, maximum }], relationships: [], policy }]
 */
export function compileSchema(entities = [], { defaultPolicy = "owner" } = {}) {
  const names = (entities || []).map((entity) => String(entity?.name || "")).filter(Boolean);
  const compiled = {};
  for (const entity of entities || []) {
    if (!entity?.name) continue;
    const fields = {};
    const relations = [];
    for (const raw of entity.fields || []) {
      const name = typeof raw === "string" ? raw : raw?.name;
      if (!name || RESERVED_FIELDS.includes(name)) continue;
      const options = Array.isArray(raw?.options) ? raw.options : Array.isArray(raw?.enum) ? raw.enum : Array.isArray(raw?.values) ? raw.values : null;
      let type = normalizeFieldType(raw?.type, { hasOptions: Boolean(options?.length) });
      const explicitTarget = raw?.target || raw?.references || raw?.entity;
      const target = explicitTarget && names.includes(String(explicitTarget)) ? String(explicitTarget)
        : (type === "reference" || /(?:id|ref)$/i.test(name)) && name !== "id" ? referenceTarget(name, names.filter((candidate) => candidate !== entity.name)) : null;
      if (target) type = "reference";
      else if (type === "reference") type = "string"; // an id-shaped field with no declared target is opaque text
      const field = {
        type, required: raw?.required === true,
        ...(options?.length ? { options: options.map(String) } : {}),
        ...(target ? { reference: { target, cardinality: "many-to-one", onDelete: String(raw?.onDelete || "restrict") } } : {}),
        ...(Number.isFinite(raw?.minimum) ? { minimum: Number(raw.minimum) } : {}),
        ...(Number.isFinite(raw?.maximum) ? { maximum: Number(raw.maximum) } : {}),
      };
      fields[name] = field;
      if (target) relations.push({ field: name, target, cardinality: "many-to-one", onDelete: field.reference.onDelete });
    }
    compiled[entity.name] = {
      name: entity.name, fields, relations,
      policy: entity.policy || (entity.owned === false ? "shared" : defaultPolicy),
      indexes: relations.map((relation) => [relation.field]),
    };
  }
  return Object.freeze({ version: SCHEMA_VERSION, entities: compiled, entityNames: Object.keys(compiled) });
}

function typeProblem(field, definition, value) {
  switch (definition.type) {
    case "string": case "text": case "url": return typeof value === "string" ? null : "expected text";
    case "email": return typeof value === "string" && EMAIL.test(value) ? null : "expected an email address";
    case "number": return typeof value === "number" && Number.isFinite(value) ? null : "expected a number";
    case "integer": return Number.isInteger(value) ? null : "expected a whole number";
    case "boolean": return typeof value === "boolean" ? null : "expected true or false";
    case "date": case "datetime": return typeof value === "string" && ISO_DATE.test(value) ? null : "expected an ISO date";
    case "reference": return typeof value === "string" && value.length > 0 ? null : "expected the referenced record's id";
    case "enum": return definition.options?.includes(String(value)) ? null : `expected one of ${(definition.options || []).join(", ")}`;
    case "json": return value !== undefined ? null : "expected a value";
    default: return null;
  }
}

/**
 * Validate values against an entity's schema. Partial validation (an update patch) skips
 * required checks for absent fields. Reserved metadata in `values` is a problem: the platform
 * owns identity and versions.
 */
export function validateValues(schema, entityName, values = {}, { partial = false, allowUnknown = true } = {}) {
  const entity = schema?.entities?.[entityName];
  if (!entity) return { ok: false, problems: [{ field: null, code: "unknown_entity", message: `no schema for ${entityName}` }] };
  const problems = [];
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    return { ok: false, problems: [{ field: null, code: "invalid_values", message: "values must be an object" }] };
  }
  for (const key of Object.keys(values)) {
    if (RESERVED_FIELDS.includes(key)) problems.push({ field: key, code: "reserved_field", message: `${key} is platform metadata and cannot be written` });
    else if (!entity.fields[key] && !allowUnknown) problems.push({ field: key, code: "unknown_field", message: `${key} is not a declared field of ${entityName}` });
  }
  for (const [name, definition] of Object.entries(entity.fields)) {
    const value = values[name];
    const absent = value === undefined || value === null || value === "";
    if (absent) {
      if (definition.required && !partial) problems.push({ field: name, code: "required_missing", message: `${name} is required` });
      continue;
    }
    const problem = typeProblem(name, definition, value);
    if (problem) { problems.push({ field: name, code: "type_mismatch", message: `${name}: ${problem}` }); continue; }
    if (definition.minimum !== undefined && typeof value === "number" && value < definition.minimum) problems.push({ field: name, code: "below_minimum", message: `${name} must be at least ${definition.minimum}` });
    if (definition.maximum !== undefined && typeof value === "number" && value > definition.maximum) problems.push({ field: name, code: "above_maximum", message: `${name} must be at most ${definition.maximum}` });
  }
  return { ok: problems.length === 0, problems };
}

/** Fields the query module may filter/sort on for an entity, with their operators. */
export function queryableFields(schema, entityName) {
  const entity = schema?.entities?.[entityName];
  if (!entity) return {};
  const operators = (type) => (["number", "integer", "date", "datetime"].includes(type) ? ["eq", "neq", "gte", "lte", "in"]
    : ["string", "text", "email", "url"].includes(type) ? ["eq", "neq", "ilike", "in"]
      : type === "boolean" ? ["eq"] : type === "json" ? [] : ["eq", "neq", "in"]);
  return Object.fromEntries(Object.entries(entity.fields).filter(([, field]) => field.type !== "json")
    .map(([name, field]) => [name, { type: field.type, operators: operators(field.type) }]));
}

/** Entities that reference `entityName` and would block its deletion. */
export function dependentRelations(schema, entityName) {
  return Object.values(schema?.entities || {}).flatMap((entity) => entity.relations
    .filter((relation) => relation.target === entityName)
    .map((relation) => ({ entity: entity.name, field: relation.field, onDelete: relation.onDelete })));
}
