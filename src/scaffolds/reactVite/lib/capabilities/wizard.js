// Headless multi-step workflow capability v1 — platform infrastructure, do not edit.
// It owns behaviour only. Generated components decide all markup, layout, animation and styling.

import { db as defaultDb } from "../backend/index.js";
import { ensureSession as defaultEnsureSession } from "./session.js";

export const WIZARD_STATUS = Object.freeze({
  ACTIVE: "active", INVALID: "invalid", CONFIRMING: "confirming",
  CONFIRMED: "confirmed", CANCELLED: "cancelled",
});

const clone = (value) => JSON.parse(JSON.stringify(value));

const flatten = (row) => (row ? { id: row.id, ...(row.data || {}) } : null);

/** Durable app-scoped persistence. No browser storage and no visual opinions. */
export function makeWizardPersistence({ key, entity = "wizardState", deps = {} } = {}) {
  const stableKey = String(key || "").trim();
  if (!stableKey) throw new Error("wizard persistence needs a stable key");
  const db = deps.db || defaultDb;
  const ensureSession = deps.ensureSession || defaultEnsureSession;
  const store = () => db.entity(entity);
  const existing = async () => flatten((await store().list({ filters: { key: stableKey }, limit: 1 }))[0]);
  return {
    async save(state) {
      await ensureSession();
      const current = await existing();
      const value = { key: stableKey, state: clone(state), updatedAt: new Date().toISOString() };
      if (current) {
        const { id, ...prior } = current;
        await store().update(id, { ...prior, ...value });
      } else {
        await store().create(value);
      }
    },
    async load() {
      await ensureSession();
      return clone((await existing())?.state || null);
    },
    async clear() {
      await ensureSession();
      const current = await existing();
      if (current) await store().delete(current.id);
    },
  };
}

export function makeWizardMachine({
  id = null, steps = [], initialValues = {}, validate = () => ({}), persistence,
  onConfirm = null, deps = {},
} = {}) {
  if (!Array.isArray(steps) || steps.length < 2) throw new Error("a wizard needs at least two steps");
  const ids = steps.map((step) => String(typeof step === "string" ? step : step?.id || "").trim());
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) throw new Error("wizard step ids must be non-empty and unique");
  const durable = persistence === undefined
    ? makeWizardPersistence({ key: String(id || `wizard:${ids.join(":")}`), deps })
    : persistence;
  const listeners = new Set();
  let state = {
    status: WIZARD_STATUS.ACTIVE, stepIndex: 0, stepId: ids[0], values: clone(initialValues),
    errors: {}, confirmation: null, cancelledAt: null, revision: 0,
  };

  // Hydration state, reported in every snapshot. A durable wizard that has not yet read its own
  // storage is not the same thing as a fresh one, and a component that cannot tell them apart
  // renders step 1 of a booking the visitor already completed.
  let hydration = { hydrated: !durable?.load, hydrating: false, error: null };
  let hydrationFlight = null;

  const snapshot = () => ({
    ...clone(state),
    // `stepId` is canonical. The aliases keep generated applications written against the
    // common step/currentStep/current names reactive instead of silently pinning their UI to
    // a fallback landing screen while the machine itself advances correctly.
    step: state.stepId, currentStep: state.stepId, current: state.stepId,
    stepCount: ids.length,
    isFirst: state.stepIndex === 0, isLast: state.stepIndex === ids.length - 1,
    progress: (state.stepIndex + 1) / ids.length,
    hydrated: hydration.hydrated, hydrating: hydration.hydrating, hydrationError: hydration.error,
  });
  const emit = () => {
    const next = snapshot();
    for (const listener of listeners) listener(next);
    return next;
  };
  const save = async () => { if (durable?.save) await durable.save(snapshot()); };
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
    // Controlled React inputs must observe the new value before durable persistence yields to the
    // network. Waiting for save() first lets React re-render the old controlled value in response
    // to the input event, so the browser sees the character it just typed immediately disappear.
    // The durable write still remains part of the operation and is still awaited by callers.
    const next = emit();
    await save();
    return next;
  };

  async function restoreState() {
    if (!durable?.load) return snapshot();
    const saved = await durable.load();
    if (!saved || !ids.includes(saved.stepId) || !Number.isInteger(saved.stepIndex)) return snapshot();
    const restoredStatus = Object.values(WIZARD_STATUS).includes(saved.status)
      ? saved.status : WIZARD_STATUS.ACTIVE;
    state = {
      ...state, stepIndex: ids.indexOf(saved.stepId), stepId: saved.stepId,
      values: clone(saved.values || {}), status: restoredStatus,
      errors: clone(saved.errors || {}), confirmation: clone(saved.confirmation || null),
      cancelledAt: saved.cancelledAt || null,
      revision: Math.max(state.revision, Number(saved.revision || 0)),
    };
    return emit();
  }

  async function hydrateOnce() {
    if (hydration.hydrated) return snapshot();
    if (hydrationFlight) return hydrationFlight;
    hydration = { ...hydration, hydrating: true, error: null };
    emit();
    hydrationFlight = (async () => {
      try {
        const restored = await restoreState();
        hydration = { hydrated: true, hydrating: false, error: null };
        emit();
        return restored;
      } catch (error) {
        // Visible, never a silent reset: a storage failure that quietly restarted the flow would
        // look exactly like a fresh visitor and lose a confirmed booking without saying so.
        hydration = { hydrated: false, hydrating: false, error: error?.message || "hydration failed" };
        emit();
        throw error;
      } finally {
        hydrationFlight = null;
      }
    })();
    return hydrationFlight;
  }

  return {
    WIZARD_STATUS,
    getState: snapshot,
    /**
     * Subscribing HYDRATES. A durable wizard used to restart from step one unless the application
     * remembered to await restore() before rendering — an undocumented ritual, invisible when
     * skipped, and the reason a live build's reload/recovery steps could not pass. Reading the
     * store is now enough; the first subscriber triggers exactly one restore and every consumer
     * sees the result through the normal emit.
     *
     * Single-flight: concurrent subscribers share one promise, so ten components mounting
     * together perform one read, not ten. Idempotent: once hydrated it never re-reads, so a later
     * subscriber cannot resurrect storage over live state the visitor has since changed.
     */
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot());
      if (!hydration.hydrated && !hydration.hydrating) hydrateOnce().catch(() => {});
      return () => listeners.delete(listener);
    },
    /** Restore once, ever. Safe to call from anywhere; returns the same promise while in flight. */
    async hydrate() { return hydrateOnce(); },
    async restore() { return restoreState(); },
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
        await save();
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
      await save(); return emit();
    },
    async reset() {
      state = { status: WIZARD_STATUS.ACTIVE, stepIndex: 0, stepId: ids[0], values: clone(initialValues),
        errors: {}, confirmation: null, cancelledAt: null, revision: state.revision + 1 };
      await durable?.clear?.(); return emit();
    },
  };
}
