// React bindings for the routing, collections, forms and async-state modules — platform
// infrastructure, do not edit. State and functions only; no JSX, no layout.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useCapabilityState } from "../capabilities/react.js";

/** The router's live state: { path, route, params, state: loading|ready|not_found|forbidden|error, data, redirectTo }. */
export function useRouterState(router) {
  const state = useCapabilityState(router);
  useEffect(() => router.start(), [router]);
  return useMemo(() => ({ ...state, navigate: router.navigate, href: router.href, reload: router.reload }), [state, router]);
}

/** A collection's state plus its query controls. */
export function useCollectionState(collection) {
  const state = useCapabilityState(collection);
  useEffect(() => { if (state?.status === "idle") void collection.load(); }, [collection, state?.status]);
  return useMemo(() => ({
    ...state,
    setQuery: (spec) => collection.setQuery(spec), filter: (filters) => collection.filter(filters),
    search: (text, fields) => collection.search(text, fields), sort: (field, direction) => collection.sort(field, direction),
    clear: () => collection.clear(), more: () => collection.more(), refresh: () => collection.refresh(),
  }), [state, collection]);
}

/** A form's state plus field bindings: field(name) → { value, onChange, error, touched }. */
export function useFormState(form) {
  const state = useCapabilityState(form);
  return useMemo(() => ({
    ...state,
    field: (name) => ({
      name, value: state.values[name] ?? "", error: state.errors[name] || null, touched: state.touched[name] === true,
      onChange: (value) => form.setValue(name, value), onBlur: () => form.touch(name),
      type: form.fieldDefinition(name).type,
    }),
    setValue: form.setValue, setValues: form.setValues, submit: form.submit, reset: form.reset, validate: form.validate,
  }), [state, form]);
}

/** A resource's state plus load/invalidate. */
export function useResourceState(resource, fetcher = null) {
  const state = useCapabilityState(resource);
  useEffect(() => { if (fetcher && state?.status === "idle") void resource.load(fetcher); }, [resource, fetcher, state?.status]);
  return useMemo(() => ({ ...state, load: (run) => resource.load(run || fetcher), invalidate: resource.invalidate }), [state, resource, fetcher]);
}

/** A mutation's state plus run/reset. */
export function useMutationState(mutation) {
  const state = useCapabilityState(mutation);
  return useMemo(() => ({ ...state, run: mutation.run, reset: mutation.reset }), [state, mutation]);
}

/**
 * WP8 — settings. { values, status, error, get, set, reset } for one scope; a key that was never
 * written answers with its declared default, so a screen never invents one.
 */
export function useSettingsState(controller, { scope = "app", target = null } = {}) {
  const state = useCapabilityState(controller);
  const [values, setValues] = useState(null);
  const load = useCallback(async () => setValues(await controller.all({ scope, target })), [controller, scope, target]);
  useEffect(() => { void load(); }, [load]);
  return useMemo(() => ({
    status: state?.status || "idle", error: state?.error || null, values: values || {},
    get: (key) => controller.get(key, { target }),
    set: async (key, value) => { const saved = await controller.set(key, value, { target }); await load(); return saved; },
    reset: async (key) => { const saved = await controller.reset(key, { target }); await load(); return saved; },
    reload: load,
  }), [state, values, controller, target, load]);
}

/** WP8 — authorised history, newest first, already redacted. Loads on first use. */
export function useHistoryState(controller, query = {}) {
  const state = useCapabilityState(controller);
  const key = JSON.stringify(query);
  useEffect(() => { void controller.load(query); }, [controller, key]);
  return useMemo(() => ({ ...state, more: () => controller.more(), reload: () => controller.load(query) }), [state, controller, key]);
}

/**
 * WP9 — a declared workflow. { step, values, errors, status, next, back, goTo, confirm, cancel }.
 * A durable workflow restores itself once on mount, so a resumed flow never renders step 1.
 */
export function useWorkflowState(workflow) {
  const state = useCapabilityState(workflow);
  useEffect(() => {
    if (workflow.persistenceMode !== "none" && !state?.hydrated) void workflow.restore();
  }, [workflow, state?.hydrated]);
  return useMemo(() => ({
    ...state,
    setValue: workflow.setValue, setValues: workflow.setValues,
    next: () => workflow.next(), back: () => workflow.back(), goTo: (id) => workflow.goTo(id),
    confirm: () => workflow.confirm(), cancel: () => workflow.cancel(), reset: () => workflow.reset(),
    validateCurrent: () => workflow.validateCurrent(),
    field: (name) => ({
      name, value: state?.values?.[name] ?? "", error: state?.errors?.[name] || null,
      onChange: (value) => workflow.setValue(name, value),
    }),
  }), [state, workflow]);
}

/** WP9 — one workspace root: { draft, dirty, status, record, open, save, discard, reopen }. */
export function useWorkspaceState(workspace, { open = null } = {}) {
  const state = useCapabilityState(workspace);
  useEffect(() => { if (open) void workspace.open(open); }, [workspace, open]);
  return useMemo(() => ({
    ...state,
    open: (id) => workspace.open(id), openNew: (values) => workspace.openNew(values),
    setDraft: (patch) => workspace.setDraft(patch), replaceDraft: (values) => workspace.replaceDraft(values),
    save: (overrides) => workspace.save(overrides), discard: () => workspace.discard(),
    reopen: () => workspace.reopen(), close: () => workspace.close(),
    refreshFromConflict: () => workspace.refreshFromConflict(),
    field: (name) => ({
      name, value: state?.draft?.[name] ?? "",
      onChange: (value) => workspace.setDraft({ [name]: value }),
    }),
  }), [state, workspace]);
}

/** WP9 — editor state and history: { objects, selected, canUndo, canRedo, execute, undo, redo }. */
export function useEditorState(editor) {
  const state = useCapabilityState(editor);
  return useMemo(() => ({
    ...state,
    select: (id) => editor.select(id), selectMany: (ids) => editor.selectMany(ids),
    toggleSelect: (id) => editor.toggleSelect(id), clearSelection: () => editor.clearSelection(),
    setViewport: (patch) => editor.setViewport(patch),
    execute: (command, payload) => editor.execute(command, payload),
    transaction: (label, run) => editor.transaction(label, run),
    undo: () => editor.undo(), redo: () => editor.redo(), history: () => editor.history(),
  }), [state, editor]);
}
