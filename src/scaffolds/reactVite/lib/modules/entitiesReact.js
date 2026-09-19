// React bindings for the entities module — platform infrastructure, do not edit.
// State and functions only; presentation belongs to the application.

import { useCallback, useEffect, useRef, useState } from "react";
import { useCapabilityAction } from "../capabilities/react.js";

/**
 * One record by canonical id: { status: "idle" | "loading" | "ready" | "not_found" | "error", record, error, reload }.
 * Stale responses (an id that changed while a load was in flight) never overwrite the newer state.
 */
export function useEntity(repository, id) {
  const [state, setState] = useState({ status: id ? "loading" : "idle", record: null, error: null });
  const ticket = useRef(0);
  const load = useCallback(async () => {
    if (!id) { setState({ status: "idle", record: null, error: null }); return null; }
    const mine = ++ticket.current;
    setState((prior) => ({ ...prior, status: "loading", error: null }));
    try {
      const record = await repository.get(id);
      if (ticket.current === mine) setState({ status: "ready", record, error: null });
      return record;
    } catch (error) {
      if (ticket.current === mine) setState({ status: error?.code === "not_found" ? "not_found" : "error", record: null, error });
      return null;
    }
  }, [repository, id]);
  useEffect(() => { void load(); }, [load]);
  return { ...state, reload: load };
}

/** { create, update, remove, pending, error, result } bound to one repository, stale-result safe. */
export function useEntityMutation(repository) {
  const create = useCapabilityAction((values) => repository.create(values));
  const update = useCapabilityAction((id, patch, options) => repository.update(id, patch, options));
  const remove = useCapabilityAction((id) => repository.remove(id));
  return {
    create: create.run, update: update.run, remove: remove.run,
    pending: create.pending || update.pending || remove.pending,
    error: create.error || update.error || remove.error,
    result: update.result || create.result || remove.result,
  };
}
