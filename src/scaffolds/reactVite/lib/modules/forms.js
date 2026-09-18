// Forms/interactions module v1 — platform infrastructure, do not edit or reimplement.
//
// A headless form runtime (audit §7.1 "Forms/interactions"): field state, value coercion from the
// schema's field types, validation (schema plus custom rules), touched/dirty tracking, a single
// submission path with stale-submit protection, and semantic identities for the interaction
// primitives. No JSX, no layout; the screen decides how fields, errors and states look.

import { validateValues } from "./schema.js";

export const FORMS_MODULE_VERSION = "1.0.0";

const freeze = (value) => Object.freeze(value);

/** Coerce a raw control value (a string from an input) into the field's typed value. */
export function coerceFieldValue(definition, raw) {
  if (raw === undefined || raw === null) return raw;
  switch (definition?.type) {
    case "number": case "integer": {
      if (raw === "") return "";
      const number = typeof raw === "number" ? raw : Number(String(raw).trim());
      return Number.isFinite(number) ? (definition.type === "integer" ? Math.trunc(number) : number) : raw;
    }
    case "boolean":
      if (typeof raw === "boolean") return raw;
      if (raw === "true" || raw === "on" || raw === "1") return true;
      if (raw === "false" || raw === "off" || raw === "0" || raw === "") return false;
      return Boolean(raw);
    case "email": case "url": case "string": case "text":
      return typeof raw === "string" ? raw : String(raw);
    default:
      return raw;
  }
}

/**
 * @param {object} options
 * @param {object} options.schema compiled schema
 * @param {string} options.entity entity whose fields the form edits (null for a free form)
 * @param {object} [options.initialValues]
 * @param {(values) => Array<{field, message}> | null} [options.validate] custom rules
 * @param {(values) => Promise<any>} options.submit the operation the form submits to
 * @param {string[]} [options.fields] restrict to these fields (default: every schema field)
 */
export function createForm({ schema = null, entity = null, initialValues = {}, validate = null, submit, fields = null } = {}) {
  if (typeof submit !== "function") throw new Error("createForm: a submit operation is required");
  const definition = entity && schema?.entities?.[entity] ? schema.entities[entity] : null;
  const fieldNames = fields || (definition ? Object.keys(definition.fields) : Object.keys(initialValues));
  const listeners = new Set();
  let ticket = 0;
  let state = freeze({
    status: "idle", values: freeze({ ...initialValues }), errors: freeze({}), touched: freeze({}),
    dirty: false, submitCount: 0, result: null, error: null,
  });
  const emit = () => { for (const listener of [...listeners]) listener(state); };
  const set = (patch) => { state = freeze({ ...state, ...patch }); emit(); return state; };

  function runValidation(values) {
    const errors = {};
    if (definition) {
      const verdict = validateValues(schema, entity, values, { partial: false });
      for (const problem of verdict.problems) if (problem.field && fieldNames.includes(problem.field) && !errors[problem.field]) errors[problem.field] = problem.message;
    }
    for (const rule of (typeof validate === "function" ? validate(values) : validate) || []) {
      if (rule?.field && !errors[rule.field]) errors[rule.field] = rule.message || "invalid";
    }
    return freeze(errors);
  }

  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    fields: freeze([...fieldNames]),
    fieldDefinition: (name) => definition?.fields?.[name] || { type: "string" },
    setValue(name, raw) {
      if (!fieldNames.includes(name)) throw new Error(`form has no field ${name}`);
      const value = coerceFieldValue(definition?.fields?.[name], raw);
      const values = freeze({ ...state.values, [name]: value });
      const errors = state.submitCount > 0 || state.touched[name] ? runValidation(values) : state.errors;
      return set({ values, errors, dirty: true, status: state.status === "submitted" ? "idle" : state.status });
    },
    setValues(patch = {}) {
      const values = freeze({ ...state.values, ...Object.fromEntries(Object.entries(patch).map(([name, raw]) => [name, coerceFieldValue(definition?.fields?.[name], raw)])) });
      return set({ values, errors: state.submitCount > 0 ? runValidation(values) : state.errors, dirty: true });
    },
    touch(name) {
      const touched = freeze({ ...state.touched, [name]: true });
      return set({ touched, errors: runValidation(state.values) });
    },
    validate() {
      const errors = runValidation(state.values);
      set({ errors });
      return freeze({ ok: Object.keys(errors).length === 0, errors });
    },
    /** Submit once: invalid values never reach the operation; a superseded submission cannot report. */
    async submit() {
      const errors = runValidation(state.values);
      const mine = ++ticket;
      set({ errors, submitCount: state.submitCount + 1, touched: freeze(Object.fromEntries(fieldNames.map((name) => [name, true]))) });
      if (Object.keys(errors).length) { set({ status: "invalid", error: null }); return freeze({ ok: false, errors }); }
      set({ status: "submitting", error: null });
      try {
        const result = await submit(state.values);
        if (ticket === mine) set({ status: "submitted", result, error: null, dirty: false });
        return freeze({ ok: true, result });
      } catch (error) {
        if (ticket === mine) set({ status: "error", error: { code: error?.code || "submit_failed", message: String(error?.message || error) } });
        return freeze({ ok: false, error });
      }
    },
    /** A reset form is a NEW draft: no values, no errors, no touched fields and no submissions. */
    reset(values = initialValues) {
      ticket += 1;
      return set({ status: "idle", values: freeze({ ...values }), errors: freeze({}), touched: freeze({}), dirty: false, submitCount: 0, result: null, error: null });
    },
  };
}
