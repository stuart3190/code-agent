// Async resource state module v1 — platform infrastructure, do not edit or reimplement.
//
// The shared state protocol for anything that loads or mutates (audit §7.1 "Async resource
// state"): loading/ready/empty/error, cancellation of superseded loads, mutation state with
// optimistic application and rollback on failure, and cache invalidation keyed by resource
// key. No React here; the hooks bind these stores through the capability state hook.

export const ASYNC_MODULE_VERSION = "1.0.0";

const freeze = (value) => Object.freeze(value);

function store(initial) {
  const listeners = new Set();
  let state = freeze(initial);
  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    set(next) { state = freeze(typeof next === "function" ? next(state) : next); for (const listener of [...listeners]) listener(state); return state; },
  };
}

/**
 * A resource: one async read with cancellation. `load(fetcher)` supersedes any in-flight load;
 * a superseded result is discarded, never applied. `empty` is derived from an empty array/null.
 *   state: { status: "idle" | "loading" | "ready" | "empty" | "error", data, error, loadedAt, generation }
 */
export function createResource({ key = null, isEmpty = (data) => data == null || (Array.isArray(data) && data.length === 0) } = {}) {
  const state = store({ status: "idle", data: null, error: null, loadedAt: null, generation: 0, key });
  let generation = 0;
  const resource = {
    key,
    getState: state.getState,
    subscribe: state.subscribe,
    async load(fetcher) {
      const mine = ++generation;
      state.set((prior) => ({ ...prior, status: "loading", error: null, generation: mine }));
      try {
        const data = await fetcher({ generation: mine, cancelled: () => generation !== mine });
        if (generation !== mine) return freeze({ superseded: true, data });
        state.set({ status: isEmpty(data) ? "empty" : "ready", data, error: null, loadedAt: Date.now(), generation: mine, key });
        return freeze({ superseded: false, data });
      } catch (error) {
        if (generation !== mine) return freeze({ superseded: true, error });
        state.set((prior) => ({ ...prior, status: "error", error: { code: error?.code || "load_failed", message: String(error?.message || error) }, generation: mine }));
        return freeze({ superseded: false, error });
      }
    },
    /** Replace data locally (an optimistic patch); returns a rollback function. */
    apply(updater) {
      const before = state.getState();
      state.set((prior) => ({ ...prior, data: updater(prior.data), status: isEmpty(updater(prior.data)) ? "empty" : "ready" }));
      return () => state.set((prior) => ({ ...prior, data: before.data, status: before.status }));
    },
    invalidate() { generation += 1; state.set((prior) => ({ ...prior, status: "idle", loadedAt: null })); },
    reset() { generation += 1; state.set({ status: "idle", data: null, error: null, loadedAt: null, generation, key }); },
  };
  return resource;
}

/**
 * A mutation with optional optimistic application: `run(input)` applies `optimistic(input)` to the
 * bound resource immediately, rolls it back when the operation fails, and invalidates the
 * resources named in `invalidates` on success so they reload from the server.
 *   state: { status: "idle" | "pending" | "success" | "error", result, error, attempts }
 */
export function createMutation({ operation, optimistic = null, resource = null, invalidates = [] } = {}) {
  if (typeof operation !== "function") throw new Error("createMutation: an operation is required");
  const state = store({ status: "idle", result: null, error: null, attempts: 0 });
  let ticket = 0;
  return {
    getState: state.getState,
    subscribe: state.subscribe,
    async run(input) {
      const mine = ++ticket;
      state.set((prior) => ({ ...prior, status: "pending", error: null, attempts: prior.attempts + 1 }));
      const rollback = optimistic && resource ? resource.apply((data) => optimistic(data, input)) : null;
      try {
        const result = await operation(input);
        if (ticket === mine) state.set((prior) => ({ ...prior, status: "success", result, error: null }));
        for (const target of invalidates) target?.invalidate?.();
        return result;
      } catch (error) {
        rollback?.();
        if (ticket === mine) state.set((prior) => ({ ...prior, status: "error", result: null, error: { code: error?.code || "mutation_failed", message: String(error?.message || error), details: error?.details || null } }));
        throw error;
      }
    },
    reset() { ticket += 1; state.set({ status: "idle", result: null, error: null, attempts: 0 }); },
  };
}

/** A keyed cache of resources so two screens reading the same key share one load and one invalidation. */
export function createResourceCache() {
  const resources = new Map();
  return {
    resource(key, options = {}) {
      if (!resources.has(key)) resources.set(key, createResource({ key, ...options }));
      return resources.get(key);
    },
    invalidate(prefix = "") {
      for (const [key, resource] of resources) if (String(key).startsWith(prefix)) resource.invalidate();
    },
    clear() { for (const resource of resources.values()) resource.reset(); resources.clear(); },
    keys: () => [...resources.keys()],
  };
}
