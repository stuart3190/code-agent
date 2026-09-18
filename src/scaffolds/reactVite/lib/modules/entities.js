// Entities module v1.1 — platform infrastructure, do not edit or reimplement.
//
// Typed, schema-validated persistence over the generic entities backend (audit §9):
//
//   EntityRecord<T> = { id, version, createdAt, updatedAt, values: T }
//
// Identity and versions are platform metadata — reserved, immutable, never redefined by a domain
// field. Updates are validated patches merged atomically with optimistic concurrency: the write
// succeeds only when the record still has the version the caller read (a compare-and-set at the
// persistence boundary), otherwise it fails with `version_conflict`. References are checked
// against the caller's own visible records before a write (RLS proves the target is theirs), and
// deletion honours the declared relation policy. Reload resolves the same canonical id.
//
// The legacy flat record (`{ id, createdAt, ...fields }` from makeEntityStore) stays available
// through toLegacyRecord(); new code uses the documented shape above.

import { RESERVED_FIELDS, dependentRelations, validateValues } from "./schema.js";

export const ENTITIES_MODULE_VERSION = "1.1.0";
export const META_KEY = "__meta";

export const ENTITY_ERROR = Object.freeze({
  VALIDATION_FAILED: "validation_failed",
  NOT_FOUND: "not_found",
  VERSION_CONFLICT: "version_conflict",
  REFERENCE_NOT_FOUND: "reference_not_found",
  REFERENCE_RESTRICTED: "reference_restricted",
  BACKEND_UNAVAILABLE: "backend_unavailable",
});

export class EntityError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.code = code;
    if (details) this.details = details;
  }
}

/** The documented record shape from a raw backend row. */
export function toRecord(row) {
  if (!row) return null;
  const { [META_KEY]: meta, ...values } = row.data || {};
  return Object.freeze({
    id: row.id,
    version: Number(meta?.version) > 0 ? Number(meta.version) : 1,
    createdAt: row.created_at || meta?.createdAt || null,
    updatedAt: meta?.updatedAt || row.created_at || null,
    values: Object.freeze({ ...values }),
  });
}

/** Legacy adapter: the flat shape the crud capability has always returned. */
export function toLegacyRecord(record) {
  if (!record) return null;
  return { id: record.id, createdAt: record.createdAt, ...record.values };
}

const isNotFound = (error) => /not found|no rows|PGRST116|0 rows|JSON object requested/i.test(String(error?.message || error?.code || ""));
const isUnconfigured = (error) => /not configured/i.test(String(error?.message || ""));

/**
 * @param {object} options
 * @param {object} options.db the backend `db` surface (db.entity(type))
 * @param {object} options.schema a compiled schema (schema.js compileSchema)
 * @param {string} options.entity the entity name
 */
export function createEntityRepository({ db, schema, entity, now = () => new Date().toISOString() } = {}) {
  if (!db || typeof db.entity !== "function") throw new Error("createEntityRepository: the backend db surface is required");
  if (!schema?.entities?.[entity]) throw new Error(`createEntityRepository: no schema for entity "${entity}"`);
  const definition = schema.entities[entity];
  const table = () => db.entity(entity);

  const stripReserved = (values) => {
    const clean = {};
    const ignored = [];
    for (const [key, value] of Object.entries(values || {})) {
      if (RESERVED_FIELDS.includes(key)) ignored.push(key); else clean[key] = value;
    }
    return { clean, ignored };
  };
  const wrap = (error, fallback) => {
    if (error instanceof EntityError) return error;
    if (isNotFound(error)) return new EntityError(ENTITY_ERROR.NOT_FOUND, `${entity} not found`, { cause: error?.message });
    if (isUnconfigured(error)) return new EntityError(ENTITY_ERROR.BACKEND_UNAVAILABLE, String(error.message));
    return Object.assign(fallback ? new EntityError(fallback, String(error?.message || error)) : error, { cause: error });
  };
  const validate = (values, options) => {
    const verdict = validateValues(schema, entity, values, options);
    if (!verdict.ok) throw new EntityError(ENTITY_ERROR.VALIDATION_FAILED, `${entity}: ${verdict.problems.map((problem) => problem.message).join("; ")}`, { problems: verdict.problems });
  };
  async function checkReferences(values) {
    for (const relation of definition.relations) {
      const id = values[relation.field];
      if (id === undefined || id === null || id === "") continue;
      try { await db.entity(relation.target).get(id); }
      catch (error) {
        if (isNotFound(error)) throw new EntityError(ENTITY_ERROR.REFERENCE_NOT_FOUND, `${entity}.${relation.field} references a ${relation.target} that does not exist or is not yours`, { field: relation.field, target: relation.target, id });
        throw wrap(error);
      }
    }
  }
  async function readRow(id) {
    try { return await table().get(id); } catch (error) { throw wrap(error); }
  }

  const repository = {
    entity,
    schema: definition,
    async create(values = {}) {
      const { clean } = stripReserved(values);
      validate(clean, { partial: false });
      await checkReferences(clean);
      const at = now();
      try {
        return toRecord(await table().create({ ...clean, [META_KEY]: { version: 1, createdAt: at, updatedAt: at } }));
      } catch (error) { throw wrap(error); }
    },
    async get(id) {
      if (!id) throw new EntityError(ENTITY_ERROR.NOT_FOUND, `${entity}: an id is required`);
      return toRecord(await readRow(id));
    },
    /**
     * Merge a validated patch atomically. With `expectedVersion`, the write is a compare-and-set:
     * it fails with version_conflict when another writer moved the record first. Without it the
     * current version is read and used as the expectation (last read wins, never a blind merge).
     */
    async update(id, patch = {}, { expectedVersion = null } = {}) {
      const { clean } = stripReserved(patch);
      validate(clean, { partial: true });
      await checkReferences(clean);
      const current = toRecord(await readRow(id));
      const expected = expectedVersion ?? current.version;
      if (current.version !== expected) {
        throw new EntityError(ENTITY_ERROR.VERSION_CONFLICT, `${entity} ${id} changed (version ${current.version}, expected ${expected})`, { expected, actual: current.version });
      }
      const nextData = { ...current.values, ...clean, [META_KEY]: { version: expected + 1, createdAt: current.createdAt, updatedAt: now() } };
      try {
        const store = table();
        if (typeof store.updateVersioned === "function") {
          const row = await store.updateVersioned(id, nextData, expected);
          if (!row) {
            const latest = toRecord(await readRow(id));
            throw new EntityError(ENTITY_ERROR.VERSION_CONFLICT, `${entity} ${id} changed (version ${latest.version}, expected ${expected})`, { expected, actual: latest.version });
          }
          return toRecord(row);
        }
        return toRecord(await store.update(id, nextData));
      } catch (error) { throw wrap(error); }
    },
    async remove(id) {
      for (const dependent of dependentRelations(schema, entity)) {
        if (dependent.onDelete === "cascade") continue;
        let count = 0;
        try { count = await db.entity(dependent.entity).count({ [dependent.field]: id }); } catch (error) { throw wrap(error); }
        if (count > 0) throw new EntityError(ENTITY_ERROR.REFERENCE_RESTRICTED, `${entity} ${id} is referenced by ${count} ${dependent.entity} record(s)`, { entity: dependent.entity, field: dependent.field, count });
      }
      try { await table().delete(id); } catch (error) { throw wrap(error); }
      return Object.freeze({ id, removed: true });
    },
    async list(options = {}) {
      try { return (await table().list(options)).map(toRecord); } catch (error) { throw wrap(error); }
    },
    async count(filters = {}) {
      try { return await table().count(filters); } catch (error) { throw wrap(error); }
    },
    subscribe(callback) {
      return table().subscribe((event) => callback({ ...event, record: event.record ? toRecord(event.record) : null }));
    },
    toLegacyRecord,
  };
  return repository;
}

/** One repository per schema entity, keyed by name. */
export function createEntityRepositories({ db, schema, now } = {}) {
  return Object.freeze(Object.fromEntries((schema?.entityNames || []).map((entity) => [entity, createEntityRepository({ db, schema, entity, now })])));
}
