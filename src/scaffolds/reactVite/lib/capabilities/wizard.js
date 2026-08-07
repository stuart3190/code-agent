// Headless multi-step workflow capability v1 — platform infrastructure, do not edit.
// It owns behaviour only. Generated components decide all markup, layout, animation and styling.

export const WIZARD_STATUS = Object.freeze({
  ACTIVE: "active", INVALID: "invalid", CONFIRMING: "confirming",
  CONFIRMED: "confirmed", CANCELLED: "cancelled",
});

const clone = (value) => JSON.parse(JSON.stringify(value));

export function makeWizardMachine({
  steps = [], initialValues = {}, validate = () => ({}), persistence = null, onConfirm = null,
} = {}) {
  if (!Array.isArray(steps) || steps.length < 2) throw new Error("a wizard needs at least two steps");
  const ids = steps.map((step) => String(typeof step === "string" ? step : step?.id || "").trim());
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) throw new Error("wizard step ids must be non-empty and unique");
  const listeners = new Set();
  let state = {
    status: WIZARD_STATUS.ACTIVE, stepIndex: 0, stepId: ids[0], values: clone(initialValues),
    errors: {}, confirmation: null, cancelledAt: null, revision: 0,
  };

  const snapshot = () => ({
    ...clone(state), stepCount: ids.length,
    isFirst: state.stepIndex === 0, isLast: state.stepIndex === ids.length - 1,
    progress: (state.stepIndex + 1) / ids.length,
  });
  const emit = () => {
    const next = snapshot();
    for (const listener of listeners) listener(next);
    return next;
  };
  const save = async () => { if (persistence?.save) await persistence.save(snapshot()); };
  const active = () => {
    if ([WIZARD_STATUS.CANCELLED, WIZARD_STATUS.CONFIRMED].includes(state.status)) {
      throw new Error(`wizard is ${state.status}`);
    }
  };
  const validateCurrent = () => {
    const errors = validate({ stepId: state.stepId, stepIndex: state.stepIndex, values: clone(state.values) }) || {};
    state = { ...state, errors: clone(errors), status: Object.keys(errors).length ? WIZARD_STATUS.INVALID : WIZARD_STATUS.ACTIVE };
    return Object.keys(errors).length === 0;
  };
  const move = async (index) => {
    state = { ...state, stepIndex: index, stepId: ids[index], errors: {}, status: WIZARD_STATUS.ACTIVE, revision: state.revision + 1 };
    await save(); return emit();
  };
  const setValue = async (key, value) => {
    active(); state = { ...state, values: { ...state.values, [key]: value }, errors: {}, status: WIZARD_STATUS.ACTIVE,
      revision: state.revision + 1 };
    await save(); return emit();
  };

  return {
    WIZARD_STATUS,
    getState: snapshot,
    subscribe(listener) { listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener); },
    async restore() {
      if (!persistence?.load) return snapshot();
      const saved = await persistence.load();
      if (!saved || !ids.includes(saved.stepId) || !Number.isInteger(saved.stepIndex)) return snapshot();
      state = {
        ...state, stepIndex: ids.indexOf(saved.stepId), stepId: saved.stepId,
        values: clone(saved.values || {}), status: WIZARD_STATUS.ACTIVE,
        revision: Math.max(state.revision, Number(saved.revision || 0)),
      };
      return emit();
    },
    setValue,
    select: setValue,
    validateCurrent() { active(); const ok = validateCurrent(); emit(); return { ok, errors: clone(state.errors) }; },
    async next() {
      active();
      if (!validateCurrent()) { emit(); return { ok: false, state: snapshot() }; }
      if (state.stepIndex === ids.length - 1) return { ok: false, reason: "last_step", state: snapshot() };
      return { ok: true, state: await move(state.stepIndex + 1) };
    },
    async back() {
      active();
      if (state.stepIndex === 0) return { ok: false, reason: "first_step", state: snapshot() };
      return { ok: true, state: await move(state.stepIndex - 1) };
    },
    async goTo(stepId) {
      active();
      const index = ids.indexOf(String(stepId));
      if (index < 0) throw new Error(`unknown wizard step ${stepId}`);
      if (index > state.stepIndex && !validateCurrent()) { emit(); return { ok: false, state: snapshot() }; }
      return { ok: true, state: await move(index) };
    },
    async confirm() {
      active();
      if (state.stepIndex !== ids.length - 1) return { ok: false, reason: "not_last_step", state: snapshot() };
      if (!validateCurrent()) { emit(); return { ok: false, state: snapshot() }; }
      state = { ...state, status: WIZARD_STATUS.CONFIRMING, revision: state.revision + 1 };
      emit();
      try {
        const confirmation = onConfirm ? await onConfirm(clone(state.values)) : { ok: true };
        state = { ...state, status: WIZARD_STATUS.CONFIRMED, confirmation: clone(confirmation), errors: {} };
        await persistence?.clear?.();
        return { ok: true, confirmation: clone(confirmation), state: emit() };
      } catch (error) {
        state = { ...state, status: WIZARD_STATUS.INVALID, errors: { submit: error.message || "Confirmation failed" } };
        await save(); emit(); throw error;
      }
    },
    async cancel() {
      if (state.status === WIZARD_STATUS.CANCELLED) return snapshot();
      if (state.status === WIZARD_STATUS.CONFIRMED) throw new Error("a confirmed wizard cannot be cancelled");
      state = { ...state, status: WIZARD_STATUS.CANCELLED, cancelledAt: new Date().toISOString(), revision: state.revision + 1 };
      await persistence?.clear?.(); return emit();
    },
    async reset() {
      state = { status: WIZARD_STATUS.ACTIVE, stepIndex: 0, stepId: ids[0], values: clone(initialValues),
        errors: {}, confirmation: null, cancelledAt: null, revision: state.revision + 1 };
      await persistence?.clear?.(); return emit();
    },
  };
}
