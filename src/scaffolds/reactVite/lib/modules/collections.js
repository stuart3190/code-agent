// Collections module v1 — platform infrastructure, do not edit or reimplement.
//
// A query-state controller over one entity repository (audit §7.1 "Query/collections"): the
// screen owns search/filter/sort controls and their presentation; this owns the validated query
// specification, the server round-trip, stable cursor paging and the collection state. Filtering
// is executed by the backend from the compiled specification — never by filtering a fetched page.

import { backendOptions, compileQuery, encodeCursor, QueryError } from "./query.js";

export const COLLECTIONS_MODULE_VERSION = "1.0.0";

const freeze = (value) => Object.freeze(value);

/**
 * @param {object} options
 * @param {object} options.repository an entities repository (list/count returning EntityRecords)
 * @param {object} options.schema compiled schema
 * @param {string} options.entity entity name
 * @param {object} [options.initialQuery] { filters, search, sort, page }
 */
export function createCollection({ repository, schema, entity, initialQuery = {} } = {}) {
  if (!repository || !schema || !entity) throw new Error("createCollection: repository, schema and entity are required");
  const listeners = new Set();
  let generation = 0;
  let spec = { ...initialQuery };
  let compiled = compileQuery(schema, entity, spec);
  let state = freeze({ status: "idle", items: freeze([]), count: null, nextCursor: null, query: compiled, error: null, generation: 0 });
  const emit = () => { for (const listener of [...listeners]) listener(state); };
  const set = (patch) => { state = freeze({ ...state, ...patch }); emit(); return state; };

  async function fetchPage({ append = false } = {}) {
    const mine = ++generation;
    set({ status: "loading", error: null, generation: mine, query: compiled });
    try {
      const options = backendOptions(compiled);
      const [rows, count] = await Promise.all([
        repository.list(options),
        repository.count(options.filters).catch(() => null),
      ]);
      if (generation !== mine) return state;
      const pageSize = compiled.page.size;
      const page = rows.slice(0, pageSize);
      const hasMore = rows.length > pageSize;
      const items = append ? [...state.items, ...page] : page;
      return set({
        status: items.length ? "ready" : "empty", items: freeze(items), count,
        nextCursor: hasMore ? encodeCursor(compiled, page.at(-1)) : null, error: null,
      });
    } catch (error) {
      if (generation !== mine) return state;
      return set({ status: "error", error: { code: error?.code || "collection_load_failed", message: String(error?.message || error) } });
    }
  }

  return {
    entity,
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    /** Replace the query (filters/search/sort) — validated immediately; a bad field is an error state, never a silent no-op. */
    setQuery(next = {}) {
      try {
        spec = { ...spec, ...next, page: { size: next.page?.size || spec.page?.size } };
        compiled = compileQuery(schema, entity, spec);
        set({ query: compiled, nextCursor: null, error: null });
        return fetchPage();
      } catch (error) {
        if (error instanceof QueryError) { set({ status: "error", error: { code: error.code, message: error.message, details: error.details || null } }); return Promise.resolve(state); }
        throw error;
      }
    },
    filter(filters) { return this.setQuery({ filters }); },
    search(text, fields) { return this.setQuery({ search: { text, fields } }); },
    sort(field, direction = "desc") { return this.setQuery({ sort: { field, direction } }); },
    clear() { spec = { page: spec.page }; compiled = compileQuery(schema, entity, spec); set({ query: compiled }); return fetchPage(); },
    load() { return fetchPage(); },
    refresh() { return fetchPage(); },
    /** The next page, continuing the same query through its opaque cursor. */
    async more() {
      if (!state.nextCursor) return state;
      compiled = compileQuery(schema, entity, { ...spec, page: { ...(spec.page || {}), cursor: state.nextCursor } });
      return fetchPage({ append: true });
    },
    query: () => compiled,
  };
}
