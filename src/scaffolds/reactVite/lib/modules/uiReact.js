// React bindings for the routing, collections, forms and async-state modules — platform
// infrastructure, do not edit. State and functions only; no JSX, no layout.

import { useEffect, useMemo } from "react";
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
