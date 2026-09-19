// Workspace lifecycle module v1 — platform infrastructure, do not edit or reimplement.
//
// "Create, open, save, reopen" is the shape of every project/document application, and the
// generated version of it was wrong in the same way every time (audit §7.2): a draft held in a
// component, a save that called create() whenever the active record happened to be null, and a
// reopen that fetched the row again and quietly produced a SECOND record with the same name. The
// audit's proof for this module is exactly that failure: same-ID save and reopen.
//
// Four rules:
//
//   1. An OPEN workspace has a durable identity. Every save from that point updates that id. The
//      only path that creates a record is one that was explicitly opened as new.
//   2. Saving is a compare-and-set on the record's version. A save onto a record another writer
//      moved is a CONFLICT the application can resolve — never a silent overwrite of their work.
//   3. `dirty` is computed from the draft against the last saved record, not set by a flag a
//      screen has to remember to clear.
//   4. Discarding restores the saved record exactly; it never clears the record itself.
//
// Headless: state and functions only.

export const WORKSPACE_MODULE_VERSION = "1.0.0";

export const WORKSPACE_STATUS = Object.freeze({
  EMPTY: "empty", LOADING: "loading", DRAFT: "draft", READY: "ready", SAVING: "saving",
  CONFLICT: "conflict", ERROR: "error",
});

export const WORKSPACE_ERROR = Object.freeze({
  NOT_OPEN: "workspace_not_open",
  CONFLICT: "workspace_version_conflict",
  NOT_FOUND: "workspace_not_found",
  INVALID: "workspace_invalid",
});

export class WorkspaceError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.code = code;
    if (details) this.details = details;
  }
}

const clone = (value) => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
const freeze = (value) => Object.freeze(value);

/** Field-wise comparison against the saved record: order and key insertion never make it dirty. */
export function draftDiffers(draft = {}, saved = {}, fields = null) {
  const keys = fields?.length ? fields : [...new Set([...Object.keys(draft || {}), ...Object.keys(saved || {})])];
  return keys.some((key) => JSON.stringify(draft?.[key] ?? null) !== JSON.stringify(saved?.[key] ?? null));
}

/**
 * @param {object} options
 * @param {object} options.repository an entity repository (WP5) for the workspace's root entity
 * @param {string[]} [options.fields] the draft fields; defaults to the schema's declared fields
 * @param {object} [options.initialDraft] values a NEW workspace starts from
 */
export function createWorkspace({ repository, fields = null, initialDraft = {} } = {}) {
  if (!repository?.entity) throw new WorkspaceError(WORKSPACE_ERROR.INVALID, "createWorkspace needs an entity repository");
  const draftFields = fields?.length
    ? fields.map(String)
    : Object.keys(repository.schema?.fields || {});
  const listeners = new Set();
  let state = {
    status: WORKSPACE_STATUS.EMPTY, entity: repository.entity,
    recordId: null, record: null, version: null,
    draft: clone(initialDraft), dirty: false, savedAt: null, error: null, conflict: null,
  };
  let snapshot = null;
  const emit = () => { for (const listener of [...listeners]) listener(getState()); };
  const commit = (patch) => {
    const next = { ...state, ...patch };
    // Dirty is DERIVED. A screen cannot forget to clear it and cannot fake it.
    next.dirty = next.record ? draftDiffers(next.draft, next.record.values, draftFields) : draftDiffers(next.draft, initialDraft, draftFields);
    state = next;
    snapshot = null;
    emit();
    return getState();
  };
  const getState = () => {
    if (!snapshot) snapshot = freeze({ ...clone(state), fields: freeze([...draftFields]) });
    return snapshot;
  };
  const only = (values) => Object.fromEntries(Object.entries(values || {}).filter(([key]) => draftFields.includes(key)));

  return {
    entity: repository.entity,
    getState,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },

    /** Begin a workspace that has no durable record yet. The first save creates exactly one. */
    openNew(values = {}) {
      return commit({
        status: WORKSPACE_STATUS.DRAFT, recordId: null, record: null, version: null,
        draft: { ...clone(initialDraft), ...clone(values) }, savedAt: null, error: null, conflict: null,
      });
    },

    /** Open a durable record by id. Its identity is fixed for every later save. */
    async open(id) {
      commit({ status: WORKSPACE_STATUS.LOADING, error: null, conflict: null });
      try {
        const record = await repository.get(id);
        return commit({
          status: WORKSPACE_STATUS.READY, recordId: record.id, record, version: record.version,
          draft: clone(record.values), savedAt: record.updatedAt || record.createdAt, error: null, conflict: null,
        });
      } catch (error) {
        return commit({
          status: WORKSPACE_STATUS.ERROR,
          error: { code: error?.code || WORKSPACE_ERROR.NOT_FOUND, message: String(error?.message || error) },
        });
      }
    },

    setDraft(patch = {}) {
      return commit({ draft: { ...state.draft, ...clone(patch) }, status: state.status === WORKSPACE_STATUS.EMPTY ? WORKSPACE_STATUS.DRAFT : state.status });
    },
    replaceDraft(values = {}) {
      return commit({ draft: clone(values), status: state.status === WORKSPACE_STATUS.EMPTY ? WORKSPACE_STATUS.DRAFT : state.status });
    },

    /**
     * Save. An open workspace UPDATES its own record — this is the same-ID guarantee — and the
     * update is a compare-and-set against the version this workspace last read.
     */
    async save(overrides = {}) {
      if (state.status === WORKSPACE_STATUS.EMPTY) {
        return { ok: false, reason: WORKSPACE_ERROR.NOT_OPEN, state: getState() };
      }
      const values = only({ ...state.draft, ...clone(overrides) });
      commit({ status: WORKSPACE_STATUS.SAVING, error: null, conflict: null });
      try {
        const record = state.recordId
          ? await repository.update(state.recordId, values, { expectedVersion: state.version })
          : await repository.create(values);
        commit({
          status: WORKSPACE_STATUS.READY, recordId: record.id, record, version: record.version,
          draft: clone(record.values), savedAt: record.updatedAt || record.createdAt, error: null, conflict: null,
        });
        return { ok: true, record, state: getState() };
      } catch (error) {
        const conflict = String(error?.code || "") === "version_conflict";
        commit({
          status: conflict ? WORKSPACE_STATUS.CONFLICT : WORKSPACE_STATUS.ERROR,
          // The draft is NOT discarded on a conflict: the visitor's unsaved work is the one thing
          // that cannot be recovered from anywhere else.
          error: { code: error?.code || "workspace_save_failed", message: String(error?.message || error) },
          conflict: conflict ? { expected: state.version, actual: error?.details?.actual ?? null } : null,
        });
        return { ok: false, reason: conflict ? WORKSPACE_ERROR.CONFLICT : "workspace_save_failed", state: getState() };
      }
    },

    /** Re-read this workspace's own record. The identity never changes. */
    async reopen() {
      if (!state.recordId) return { ok: false, reason: WORKSPACE_ERROR.NOT_OPEN, state: getState() };
      const before = state.recordId;
      await this.open(before);
      return { ok: state.recordId === before, state: getState() };
    },

    /** Take the other writer's record as the new base, keeping the draft for the app to merge. */
    async refreshFromConflict() {
      if (!state.recordId) return { ok: false, reason: WORKSPACE_ERROR.NOT_OPEN, state: getState() };
      const record = await repository.get(state.recordId);
      commit({ status: WORKSPACE_STATUS.READY, record, version: record.version, conflict: null, error: null });
      return { ok: true, record, theirs: record.values, mine: clone(state.draft), state: getState() };
    },

    /** Restore the draft to the saved record. Never clears the record itself. */
    discard() {
      return commit({
        draft: state.record ? clone(state.record.values) : clone(initialDraft),
        status: state.record ? WORKSPACE_STATUS.READY : WORKSPACE_STATUS.EMPTY,
        error: null, conflict: null,
      });
    },

    close() {
      return commit({
        status: WORKSPACE_STATUS.EMPTY, recordId: null, record: null, version: null,
        draft: clone(initialDraft), savedAt: null, error: null, conflict: null,
      });
    },
  };
}
