// Query/collections module v1 — platform infrastructure, do not edit or reimplement.
//
// One deterministic query runtime over the entities backend (audit §7.1 "Query/collections",
// §9 operation semantics): a validated query specification (allow-listed fields and operators
// from the schema), stable ordering with an id tie-breaker, an opaque composite cursor tied to
// the query and order, consistent value normalisation, and a count that runs the same predicate.
// Filtering is a specification the backend executes, never a predicate over a fetched page.
// Pure: no I/O here; the repository/backend runs the compiled specification.

import { queryableFields } from "./schema.js";

export const QUERY_MODULE_VERSION = "1.0.0";
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export class QueryError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.code = code;
    if (details) this.details = details;
  }
}

const SORTABLE_META = Object.freeze(["created_at", "id"]);

function normalizeValue(type, value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  switch (type) {
    case "number": case "integer": {
      const number = typeof value === "number" ? value : Number(String(value).trim());
      if (!Number.isFinite(number)) throw new QueryError("query_value_invalid", `expected a number, got ${JSON.stringify(value)}`);
      return number;
    }
    case "boolean":
      if (typeof value === "boolean") return value;
      if (["true", "1", "yes"].includes(String(value).toLowerCase())) return true;
      if (["false", "0", "no"].includes(String(value).toLowerCase())) return false;
      throw new QueryError("query_value_invalid", `expected true or false, got ${JSON.stringify(value)}`);
    case "email": case "string": case "text": case "url":
      return String(value).trim();
    default:
      return typeof value === "string" ? value.trim() : value;
  }
}

/**
 * Compile a query specification against the schema.
 *   spec: { filters: { field: value | { op: value } }, search?: { fields: [..], text }, sort?: { field, direction }, page?: { size, cursor } }
 * Returns the backend-ready specification plus a canonical key.
 */
export function compileQuery(schema, entityName, spec = {}) {
  const fields = queryableFields(schema, entityName);
  if (!schema?.entities?.[entityName]) throw new QueryError("query_entity_unknown", `no schema for ${entityName}`);
  const filters = [];
  for (const [field, raw] of Object.entries(spec.filters || {})) {
    const definition = fields[field];
    if (!definition) throw new QueryError("query_field_not_allowed", `${entityName}.${field} is not a queryable field`, { field, allowed: Object.keys(fields) });
    const clauses = raw && typeof raw === "object" && !Array.isArray(raw) ? Object.entries(raw) : [["eq", raw]];
    for (const [operator, value] of clauses) {
      if (!definition.operators.includes(operator)) {
        throw new QueryError("query_operator_not_allowed", `${operator} is not allowed on ${entityName}.${field} (${definition.operators.join(", ")})`, { field, operator });
      }
      const normalized = operator === "in"
        ? (Array.isArray(value) ? value : [value]).map((item) => normalizeValue(definition.type, item))
        : normalizeValue(definition.type, value);
      if (normalized === undefined) continue;
      filters.push({ field, operator, value: normalized });
    }
  }
  let search = null;
  if (spec.search?.text !== undefined && String(spec.search.text).trim() !== "") {
    const candidates = (spec.search.fields || []).filter((field) => fields[field]?.operators.includes("ilike"));
    if (!candidates.length) throw new QueryError("query_search_not_allowed", `no searchable text field for ${entityName}`, { requested: spec.search.fields || [] });
    search = { fields: candidates, text: String(spec.search.text).trim() };
  }
  // Server-stable ordering only: the backend orders by created_at or id with a composite cursor.
  // Sorting a page by a domain field client-side would make pagination unstable (rows skipped or
  // repeated across pages), so it is refused here rather than silently approximated.
  const sortField = spec.sort?.field || "created_at";
  if (!SORTABLE_META.includes(sortField)) {
    throw new QueryError("query_sort_not_allowed", `${entityName} cannot be paginated in ${sortField} order; sort by created_at or id`, { field: sortField, allowed: [...SORTABLE_META] });
  }
  const direction = spec.sort?.direction === "asc" ? "asc" : "desc";
  const size = Math.max(1, Math.min(MAX_PAGE_SIZE, Number(spec.page?.size) || DEFAULT_PAGE_SIZE));
  const compiled = Object.freeze({
    version: QUERY_MODULE_VERSION, entity: entityName,
    filters: Object.freeze(filters.sort((a, b) => `${a.field}:${a.operator}`.localeCompare(`${b.field}:${b.operator}`))),
    search, sort: Object.freeze({ field: sortField, direction }), page: Object.freeze({ size }),
  });
  const key = JSON.stringify({ entity: compiled.entity, filters: compiled.filters, search: compiled.search, sort: compiled.sort });
  return Object.freeze({ ...compiled, key, cursor: decodeCursor(spec.page?.cursor, key) });
}

/** An opaque cursor bound to the query key so a page from one query can never continue another. */
export function encodeCursor(compiled, lastRecord) {
  if (!lastRecord) return null;
  const sortValue = compiled.sort.field === "created_at" ? lastRecord.createdAt
    : compiled.sort.field === "id" ? lastRecord.id : lastRecord.values?.[compiled.sort.field];
  const payload = JSON.stringify({ k: compiled.key, s: sortValue ?? null, id: lastRecord.id });
  return typeof btoa === "function" ? btoa(unescape(encodeURIComponent(payload))) : Buffer.from(payload, "utf8").toString("base64");
}

export function decodeCursor(cursor, key) {
  if (!cursor) return null;
  let payload;
  try {
    const text = typeof atob === "function" ? decodeURIComponent(escape(atob(String(cursor)))) : Buffer.from(String(cursor), "base64").toString("utf8");
    payload = JSON.parse(text);
  } catch { throw new QueryError("query_cursor_invalid", "the page cursor is not valid"); }
  if (payload?.k !== key) throw new QueryError("query_cursor_mismatch", "the page cursor belongs to a different query");
  return Object.freeze({ sortValue: payload.s, id: payload.id });
}

/** The same predicate the backend applies, for consistency checks, tests and optimistic caches. */
export function matchesQuery(compiled, record) {
  const values = record?.values || {};
  for (const clause of compiled.filters) {
    const actual = values[clause.field];
    switch (clause.operator) {
      case "eq": if (actual !== clause.value) return false; break;
      case "neq": if (actual === clause.value) return false; break;
      case "gte": if (!(actual >= clause.value)) return false; break;
      case "lte": if (!(actual <= clause.value)) return false; break;
      case "in": if (!clause.value.includes(actual)) return false; break;
      case "ilike": if (!String(actual ?? "").toLowerCase().includes(String(clause.value).replace(/%/g, "").toLowerCase())) return false; break;
      default: return false;
    }
  }
  if (compiled.search) {
    const needle = compiled.search.text.toLowerCase();
    if (!compiled.search.fields.some((field) => String(values[field] ?? "").toLowerCase().includes(needle))) return false;
  }
  return true;
}

/** Stable order: the sort field, then the id as tie-breaker, so pages never skip or repeat rows. */
export function compareRecords(compiled, a, b) {
  const pick = (record) => (compiled.sort.field === "created_at" ? record.createdAt : compiled.sort.field === "id" ? record.id : record.values?.[compiled.sort.field]);
  const left = pick(a);
  const right = pick(b);
  let order = 0;
  if (left !== right) order = left === undefined || left === null ? 1 : right === undefined || right === null ? -1 : left < right ? -1 : 1;
  if (order === 0) order = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return compiled.sort.direction === "asc" ? order : -order;
}

/**
 * Run a compiled query over an in-memory collection of records with the backend's semantics:
 * filter, search, stable sort, cursor continuation, page + next cursor. Used by tests and by
 * offline/optimistic caches; the backend adapter runs the same specification server-side.
 */
export function runQuery(compiled, records) {
  const matched = records.filter((record) => matchesQuery(compiled, record)).sort((a, b) => compareRecords(compiled, a, b));
  let start = 0;
  if (compiled.cursor) {
    const index = matched.findIndex((record) => record.id === compiled.cursor.id);
    start = index >= 0 ? index + 1 : 0;
  }
  const page = matched.slice(start, start + compiled.page.size);
  const hasMore = start + compiled.page.size < matched.length;
  return Object.freeze({ items: page, count: matched.length, nextCursor: hasMore ? encodeCursor(compiled, page.at(-1)) : null });
}

/** Translate a compiled query into the backend list/count options (filters, order, cursor, limit). */
export function backendOptions(compiled) {
  const filters = {};
  for (const clause of compiled.filters) {
    filters[clause.field] = { ...(filters[clause.field] || {}), [clause.operator]: clause.value };
  }
  if (compiled.search) {
    // The backend applies a single ilike per field; several search fields fall back to the first.
    filters[compiled.search.fields[0]] = { ...(filters[compiled.search.fields[0]] || {}), ilike: `%${compiled.search.text}%` };
  }
  return {
    filters,
    order: SORTABLE_META.includes(compiled.sort.field) ? compiled.sort.field : "created_at",
    ascending: compiled.sort.direction === "asc",
    limit: compiled.page.size + 1,
    // The composite cursor the backend turns into a keyset condition: the last row's sort value
    // and its id, so a page boundary that lands on equal sort values still advances exactly once.
    cursor: compiled.cursor ? { createdAt: compiled.cursor.sortValue, id: compiled.cursor.id } : null,
  };
}
