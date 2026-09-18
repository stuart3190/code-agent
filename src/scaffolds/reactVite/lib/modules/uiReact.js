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

/**
 * WP10 — files attached to one subject record. { files, status, progress, upload, remove, url }.
 * The policy is exposed so a screen can state the limit rather than discovering it on failure.
 */
export function useFilesState(controller, { subject = "shared", subjectId = null } = {}) {
  const state = useCapabilityState(controller);
  useEffect(() => { void controller.list({ subject, subjectId }); }, [controller, subject, subjectId]);
  return useMemo(() => ({
    ...state,
    policy: controller.policy,
    check: (file) => controller.check(file, { held: state?.files?.length || 0 }),
    upload: (file, options) => controller.upload(file, { subject, subjectId, ...options }),
    uploadMany: (files, options) => controller.uploadMany(files, { subject, subjectId, ...options }),
    remove: (pathOrId) => controller.remove(pathOrId),
    url: (path, options) => controller.url(path, options),
    reload: () => controller.list({ subject, subjectId }),
  }), [state, controller, subject, subjectId]);
}

/** WP10 — the inbox and its badge, from one set of rows so the two can never disagree. */
export function useNotificationsState(controller, { unreadOnly = false, limit = 50 } = {}) {
  const state = useCapabilityState(controller);
  useEffect(() => { void controller.load({ unreadOnly, limit }); }, [controller, unreadOnly, limit]);
  return useMemo(() => ({
    ...state,
    send: (event, payload, options) => controller.send(event, payload, options),
    markRead: (id) => controller.markRead(id),
    markAllRead: () => controller.markAllRead(),
    reload: () => controller.load({ unreadOnly, limit }),
  }), [state, controller, unreadOnly, limit]);
}

/**
 * WP10 — one declared realtime topic. Unsubscribes when the screen leaves, so a socket never
 * outlives the thing that wanted it, and reports a reconnect rather than hiding it.
 */
export function useLiveState(controller, topic, onEvent = null) {
  const state = useCapabilityState(controller);
  const [last, setLast] = useState(null);
  useEffect(() => {
    let release = null;
    let cancelled = false;
    void controller.watch(topic, (event) => { setLast(event); onEvent?.(event); })
      .then((off) => { if (cancelled) off(); else release = off; })
      .catch(() => { /* the refusal is already in the controller's state */ });
    return () => { cancelled = true; release?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, topic]);
  return useMemo(() => ({
    status: state?.topics?.[topic] || state?.status || "idle",
    error: state?.error || null, reconnects: state?.reconnects || 0, resyncs: state?.resyncs || 0, last,
  }), [state, topic, last]);
}

/**
 * WP11 — one declared metric, or several at once. The value is computed over every matching
 * record by the metrics module, so what a tile shows and what a list totals cannot differ.
 */
export function useMetricState(controller, idOrIds, { filters = {} } = {}) {
  const state = useCapabilityState(controller);
  const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
  const key = JSON.stringify([ids, filters]);
  useEffect(() => {
    if (Array.isArray(idOrIds)) void controller.report(ids, { filters });
    else void controller.value(ids[0], { filters });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, key]);
  return useMemo(() => {
    const results = state?.results || {};
    if (Array.isArray(idOrIds)) {
      return { status: state?.status || "idle", error: state?.error || null, results: Object.fromEntries(ids.map((id) => [id, results[id] || null])) };
    }
    const result = results[ids[0]] || null;
    return {
      status: state?.status || "idle", error: state?.error || null,
      value: result?.value ?? null, series: result?.series || [], total: result?.total ?? 0,
      definition: controller.definition(ids[0]),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, controller, key]);
}

/** WP11 — one declared export: build the artifact, see what it holds, then hand it over. */
export function useExportState(controller, id, { filters = {}, format = null } = {}) {
  const state = useCapabilityState(controller);
  return useMemo(() => ({
    status: state?.status || "idle", error: state?.error || null, artifact: state?.artifact || null,
    definition: controller.definition(id),
    build: () => controller.build(id, { filters, format }),
    download: (artifact) => controller.download(artifact || state?.artifact),
    /** Build and hand over in one call, for a button that just exports. */
    run: async () => {
      const built = await controller.build(id, { filters, format });
      return built.ok ? controller.download(built.artifact) : built;
    },
  }), [state, controller, id, JSON.stringify(filters), format]);
}
