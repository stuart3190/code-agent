// Workflow module v1 — platform infrastructure, do not edit or reimplement.
//
// A multi-step flow is a declared STATE GRAPH, not a step index a screen increments (audit §7.2).
// The generated code that this replaces kept a number, moved it on every click, validated whatever
// the current screen happened to remember, and had no idea what "already confirmed" meant. Three
// rules make the difference:
//
//   1. A transition is REFUSED, with a reason, when the step it leaves is not valid. Refusing is
//      not the same as doing nothing: the caller gets `{ ok: false, reason, errors }` and the
//      screen can say why, which is the behaviour the retained corpus never had.
//   2. A terminal state is terminal. Once confirmed or cancelled, no transition, no second
//      confirmation and no further value change is accepted — a double-submitted booking is the
//      exact defect this forecloses.
//   3. Persistence mode is EXPLICIT: "none", "session" (a caller-supplied adapter) or "durable"
//      (the entities repository). Nothing is written anywhere unless the mode says so, and a flow
//      that declares durable persistence reports whether it has read its own storage yet, because
//      a restored flow and a fresh one are different things.
//
// Headless: state and functions only. Layout, copy and animation stay the application's.

export const WORKFLOW_MODULE_VERSION = "1.0.0";

export const WORKFLOW_STATUS = Object.freeze({
  ACTIVE: "active", INVALID: "invalid", REVIEW: "review", CONFIRMED: "confirmed", CANCELLED: "cancelled",
});
export const WORKFLOW_PERSISTENCE = Object.freeze(["none", "session", "durable"]);
const TERMINAL = new Set([WORKFLOW_STATUS.CONFIRMED, WORKFLOW_STATUS.CANCELLED]);

export const WORKFLOW_ERROR = Object.freeze({
  UNKNOWN_STEP: "workflow_step_unknown",
  STEP_INVALID: "workflow_step_invalid",
  TERMINAL: "workflow_terminal",
  NOT_REVIEWABLE: "workflow_not_reviewable",
  PERSISTENCE: "workflow_persistence_unavailable",
});

export class WorkflowError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.code = code;
    if (details) this.details = details;
  }
}

const clone = (value) => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
const freeze = (value) => Object.freeze(value);
const listOf = (value) => (Array.isArray(value) ? value : []);

/**
 * Compile a workflow declaration into a state graph.
 *   steps: [{ id, fields?, requires?, optional?, validate? }]
 * The graph is linear by declaration order unless a step names `next`; either way the compiled
 * transitions are explicit, so "what can happen from here" is a lookup rather than arithmetic.
 */
export function compileWorkflow({ id = null, steps = [], review = true } = {}) {
  const declared = listOf(steps).map((step) => (typeof step === "string" ? { id: step } : step || {}));
  const ids = declared.map((step) => String(step.id || "").trim());
  if (ids.length < 2) throw new WorkflowError(WORKFLOW_ERROR.UNKNOWN_STEP, "a workflow needs at least two steps");
  if (ids.some((step) => !step) || new Set(ids).size !== ids.length) {
    throw new WorkflowError(WORKFLOW_ERROR.UNKNOWN_STEP, "workflow step ids must be non-empty and unique");
  }
  const compiled = declared.map((step, index) => freeze({
    id: ids[index],
    fields: freeze(listOf(step.fields).map(String)),
    required: freeze(listOf(step.fields).map(String).filter((field) => !listOf(step.optional).map(String).includes(field))),
    next: step.next ? String(step.next) : (ids[index + 1] || null),
    back: index > 0 ? ids[index - 1] : null,
    ...(typeof step.validate === "function" ? { validate: step.validate } : {}),
  }));
  for (const step of compiled) {
    if (step.next && !ids.includes(step.next)) {
      throw new WorkflowError(WORKFLOW_ERROR.UNKNOWN_STEP, `step "${step.id}" transitions to unknown step "${step.next}"`);
    }
  }
  return freeze({
    version: WORKFLOW_MODULE_VERSION, id: id ? String(id) : `workflow:${ids.join(":")}`,
    steps: compiled, ids: freeze([...ids]), review: review !== false,
  });
}

/** Durable persistence over the entities repository. One row per workflow id, per owner. */
export function durableWorkflowPersistence({ repository, entity = "workflowState", key } = {}) {
  const stable = String(key || "").trim();
  if (!repository) throw new WorkflowError(WORKFLOW_ERROR.PERSISTENCE, "durable persistence needs an entity repository");
  if (!stable) throw new WorkflowError(WORKFLOW_ERROR.PERSISTENCE, "durable persistence needs a stable workflow key");
  const store = () => repository.entity(entity);
  const existing = async () => (await store().list({ filters: { key: stable }, page: { size: 1 } }))?.records?.[0]
    || (await store().list({ filters: { key: stable } }))?.[0] || null;
  return {
    mode: "durable",
    async save(state) {
      const current = await existing();
      const values = { key: stable, state: clone(state), updatedAt: new Date().toISOString() };
      return current?.id ? store().update(current.id, values) : store().create(values);
    },
    async load() {
      const current = await existing();
      return clone(current?.values?.state ?? current?.state ?? null);
    },
    async clear() {
      const current = await existing();
      if (current?.id) await store().remove(current.id);
    },
  };
}

/**
 * @param {object} options
 * @param {object} options.definition compileWorkflow() output
 * @param {object} [options.values] initial values
 * @param {(values, step) => object} [options.validate] cross-field validation returning { field: message }
 * @param {object} [options.persistence] { mode, save, load, clear } — "none" when omitted
 * @param {(values) => Promise<any>} [options.onConfirm] the domain effect; runs at most once
 */
export function createWorkflow({ definition, values = {}, validate = null, persistence = null, onConfirm = null } = {}) {
  if (!definition?.steps?.length) throw new WorkflowError(WORKFLOW_ERROR.UNKNOWN_STEP, "createWorkflow needs a compiled definition");
  const mode = persistence?.mode && WORKFLOW_PERSISTENCE.includes(persistence.mode) ? persistence.mode : "none";
  if (mode !== "none" && typeof persistence?.save !== "function") {
    throw new WorkflowError(WORKFLOW_ERROR.PERSISTENCE, `persistence mode "${mode}" needs a save adapter`);
  }
  const listeners = new Set();
  const stepFor = (id) => definition.steps.find((step) => step.id === id) || null;

  let state = {
    status: WORKFLOW_STATUS.ACTIVE, stepId: definition.ids[0], stepIndex: 0,
    values: clone(values), errors: {}, visited: [definition.ids[0]],
    confirmation: null, cancelledAt: null, revision: 0,
    // A durable workflow that has not yet read its own storage is not a fresh one. A screen that
    // cannot tell them apart renders step 1 of a flow the visitor already half-completed.
    restored: false, hydrated: mode === "none", error: null,
  };
  let snapshot = null;
  const emit = () => { for (const listener of [...listeners]) listener(getState()); };
  const commit = (patch) => {
    state = { ...state, ...patch, revision: state.revision + 1 };
    snapshot = null;
    emit();
    return getState();
  };
  const getState = () => {
    if (!snapshot) {
      const step = stepFor(state.stepId);
      snapshot = freeze({
        ...clone(state),
        step, definition,
        isFirst: state.stepIndex === 0,
        isLast: !step?.next,
        terminal: TERMINAL.has(state.status),
      });
    }
    return snapshot;
  };

  /** Errors for one step: declared required fields plus the caller's own validation. */
  function errorsFor(stepId, candidate = state.values) {
    const step = stepFor(stepId);
    if (!step) return { [stepId]: "unknown step" };
    const errors = {};
    for (const field of step.required) {
      const value = candidate[field];
      if (value === undefined || value === null || String(value).trim() === "") errors[field] = "required";
    }
    for (const [field, message] of Object.entries(step.validate?.(candidate, step) || {})) {
      if (message) errors[field] = String(message);
    }
    for (const [field, message] of Object.entries(validate?.(candidate, step) || {})) {
      if (message && step.fields.includes(field)) errors[field] = String(message);
    }
    return errors;
  }

  const persist = async () => {
    if (mode === "none") return null;
    try {
      return await persistence.save({
        stepId: state.stepId, values: state.values, visited: state.visited, status: state.status,
      });
    } catch (error) {
      commit({ error: { code: WORKFLOW_ERROR.PERSISTENCE, message: String(error?.message || error) } });
      return null;
    }
  };

  const refuseIfTerminal = () => (TERMINAL.has(state.status)
    ? { ok: false, reason: WORKFLOW_ERROR.TERMINAL, state: getState() } : null);

  return {
    definition,
    persistenceMode: mode,
    getState,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    errorsFor,

    setValue(field, value) {
      const refused = refuseIfTerminal();
      if (refused) return refused;
      const next = { ...state.values, [field]: value };
      // Clearing an error the moment its field is corrected is the difference between a form that
      // argues with the visitor and one that answers them.
      const errors = { ...state.errors };
      delete errors[field];
      commit({ values: next, errors, status: Object.keys(errors).length ? state.status : WORKFLOW_STATUS.ACTIVE });
      return { ok: true, state: getState() };
    },
    setValues(patch = {}) {
      const refused = refuseIfTerminal();
      if (refused) return refused;
      const next = { ...state.values, ...patch };
      const errors = { ...state.errors };
      for (const field of Object.keys(patch)) delete errors[field];
      commit({ values: next, errors });
      return { ok: true, state: getState() };
    },

    /** Validate the current step without moving. */
    validateCurrent() {
      const errors = errorsFor(state.stepId);
      const ok = Object.keys(errors).length === 0;
      commit({ errors, status: ok ? WORKFLOW_STATUS.ACTIVE : WORKFLOW_STATUS.INVALID });
      return { ok, errors, state: getState() };
    },

    /** Advance. Refused with the failing errors when the current step is not valid. */
    async next() {
      const refused = refuseIfTerminal();
      if (refused) return refused;
      const errors = errorsFor(state.stepId);
      if (Object.keys(errors).length) {
        commit({ errors, status: WORKFLOW_STATUS.INVALID });
        return { ok: false, reason: WORKFLOW_ERROR.STEP_INVALID, errors, state: getState() };
      }
      const step = stepFor(state.stepId);
      if (!step?.next) {
        if (!definition.review) return { ok: false, reason: WORKFLOW_ERROR.NOT_REVIEWABLE, state: getState() };
        commit({ status: WORKFLOW_STATUS.REVIEW, errors: {} });
        await persist();
        return { ok: true, state: getState() };
      }
      const index = definition.ids.indexOf(step.next);
      commit({
        stepId: step.next, stepIndex: index, errors: {}, status: WORKFLOW_STATUS.ACTIVE,
        visited: state.visited.includes(step.next) ? state.visited : [...state.visited, step.next],
      });
      await persist();
      return { ok: true, state: getState() };
    },

    /** Go back. Never validates: a visitor may always return to correct something. */
    back() {
      const refused = refuseIfTerminal();
      if (refused) return refused;
      const step = stepFor(state.stepId);
      const target = state.status === WORKFLOW_STATUS.REVIEW ? state.stepId : step?.back;
      if (state.status === WORKFLOW_STATUS.REVIEW) {
        commit({ status: WORKFLOW_STATUS.ACTIVE, errors: {} });
        return { ok: true, state: getState() };
      }
      if (!target) return { ok: false, reason: WORKFLOW_ERROR.UNKNOWN_STEP, state: getState() };
      commit({ stepId: target, stepIndex: definition.ids.indexOf(target), errors: {}, status: WORKFLOW_STATUS.ACTIVE });
      return { ok: true, state: getState() };
    },

    /** Jump to a VISITED step. Jumping forward past unvalidated steps is refused, not allowed. */
    goTo(stepId) {
      const refused = refuseIfTerminal();
      if (refused) return refused;
      const target = stepFor(String(stepId));
      if (!target) return { ok: false, reason: WORKFLOW_ERROR.UNKNOWN_STEP, state: getState() };
      if (!state.visited.includes(target.id)) {
        return { ok: false, reason: WORKFLOW_ERROR.STEP_INVALID, errors: errorsFor(state.stepId), state: getState() };
      }
      commit({ stepId: target.id, stepIndex: definition.ids.indexOf(target.id), errors: {}, status: WORKFLOW_STATUS.ACTIVE });
      return { ok: true, state: getState() };
    },

    /**
     * Confirm. Every step is validated, not just the last one, so a value cleared after it was
     * accepted cannot slip through; the domain effect runs at most once.
     */
    async confirm() {
      const refused = refuseIfTerminal();
      if (refused) return refused;
      const allErrors = {};
      for (const id of definition.ids) Object.assign(allErrors, errorsFor(id));
      if (Object.keys(allErrors).length) {
        const firstBad = definition.ids.find((id) => Object.keys(errorsFor(id)).length);
        commit({ errors: allErrors, status: WORKFLOW_STATUS.INVALID, stepId: firstBad, stepIndex: definition.ids.indexOf(firstBad) });
        return { ok: false, reason: WORKFLOW_ERROR.STEP_INVALID, errors: allErrors, state: getState() };
      }
      let confirmation = null;
      try {
        confirmation = onConfirm ? await onConfirm(clone(state.values)) : { confirmed: true };
      } catch (error) {
        commit({ status: WORKFLOW_STATUS.REVIEW, error: { code: "workflow_confirm_failed", message: String(error?.message || error) } });
        return { ok: false, reason: "workflow_confirm_failed", state: getState() };
      }
      commit({ status: WORKFLOW_STATUS.CONFIRMED, confirmation: clone(confirmation) ?? { confirmed: true }, errors: {}, error: null });
      if (mode !== "none") await persistence.clear?.();
      return { ok: true, state: getState() };
    },

    async cancel() {
      const refused = refuseIfTerminal();
      if (refused) return refused;
      commit({ status: WORKFLOW_STATUS.CANCELLED, cancelledAt: new Date().toISOString(), errors: {} });
      if (mode !== "none") await persistence.clear?.();
      return { ok: true, state: getState() };
    },

    /** Read saved progress. Reports `restored` so a screen never mistakes a resume for a start. */
    async restore() {
      if (mode === "none") { commit({ hydrated: true }); return { ok: false, reason: WORKFLOW_ERROR.PERSISTENCE, state: getState() }; }
      try {
        const saved = await persistence.load?.();
        if (!saved?.stepId || !stepFor(saved.stepId)) { commit({ hydrated: true }); return { ok: false, reason: "workflow_nothing_saved", state: getState() }; }
        commit({
          stepId: saved.stepId, stepIndex: definition.ids.indexOf(saved.stepId),
          values: { ...clone(values), ...clone(saved.values || {}) },
          visited: listOf(saved.visited).filter((id) => definition.ids.includes(id)) || [saved.stepId],
          status: TERMINAL.has(saved.status) ? saved.status : WORKFLOW_STATUS.ACTIVE,
          restored: true, hydrated: true, errors: {}, error: null,
        });
        return { ok: true, state: getState() };
      } catch (error) {
        commit({ hydrated: true, error: { code: WORKFLOW_ERROR.PERSISTENCE, message: String(error?.message || error) } });
        return { ok: false, reason: WORKFLOW_ERROR.PERSISTENCE, state: getState() };
      }
    },

    async save() { return persist(); },

    /** Start again from the declared beginning, discarding saved progress. */
    async reset() {
      if (mode !== "none") await persistence.clear?.();
      commit({
        status: WORKFLOW_STATUS.ACTIVE, stepId: definition.ids[0], stepIndex: 0, values: clone(values),
        errors: {}, visited: [definition.ids[0]], confirmation: null, cancelledAt: null,
        restored: false, hydrated: true, error: null,
      });
      return { ok: true, state: getState() };
    },
  };
}
