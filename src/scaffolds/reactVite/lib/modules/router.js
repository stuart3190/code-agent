// Router store v1 — platform infrastructure, do not edit or reimplement.
//
// The browser-facing half of the routing module: current path, matched route with typed params,
// guard outcome against the identity controller, loader execution with cancellation, history
// navigation and not-found. The composed ScaffoldApp renders whatever the application's layout
// decides for each state; nothing here renders.

import { evaluateGuard, loaderArgs, matchRoute, routeHref, RouteError, normalizePath } from "./routing.js";

export const ROUTER_MODULE_VERSION = "1.0.0";

const freeze = (value) => Object.freeze(value);

/**
 * @param {object} options
 * @param {object} options.table compileRoutes() output
 * @param {object} [options.identity] identity controller (getState/subscribe/ensure)
 * @param {object} [options.loaders] { "<entity>.get": async (args) => record }
 * @param {string|null} [options.signInRoute]
 * @param {object} [options.history] window.history-like ({ pushState, replaceState })
 * @param {() => string} [options.currentPath]
 */
export function createRouter({ table, identity = null, loaders = {}, signInRoute = null, history = globalThis.history, currentPath = () => normalizePath(globalThis.location?.pathname || "/") } = {}) {
  if (!table?.routes) throw new Error("createRouter: a compiled route table is required");
  const listeners = new Set();
  let generation = 0;
  let state = freeze({ path: currentPath(), route: null, params: freeze({}), state: "loading", reason: null, redirectTo: null, data: null, error: null });
  const emit = () => { for (const listener of [...listeners]) listener(state); };
  const set = (patch) => { state = freeze({ ...state, ...patch }); emit(); return state; };

  async function resolve(path) {
    const mine = ++generation;
    let match = null;
    try { match = matchRoute(table, path); }
    catch (error) {
      if (error instanceof RouteError) return set({ path, route: null, params: freeze({}), state: "not_found", reason: error.code, redirectTo: null, data: null, error: { code: error.code, message: error.message } });
      throw error;
    }
    if (!match) return set({ path, route: null, params: freeze({}), state: "not_found", reason: "no_route", redirectTo: null, data: null, error: null });
    set({ path, route: match.route, params: match.params, state: "loading", reason: null, redirectTo: null, data: null, error: null });
    if (match.route.guard !== "any" && identity) await identity.ensure?.();
    if (generation !== mine) return state;
    const guard = evaluateGuard(match.route, identity?.getState?.() || { status: "signed_out" }, { signInRoute });
    if (guard.state !== "ready") return set({ state: guard.state, reason: guard.reason, redirectTo: guard.redirectTo });
    if (match.route.loader) {
      const loader = loaders[match.route.loader.operation];
      if (typeof loader !== "function") return set({ state: "error", reason: "loader_missing", error: { code: "loader_missing", message: `no loader for ${match.route.loader.operation}` } });
      try {
        const data = await loader(loaderArgs(match.route.loader, match.params), { params: match.params, route: match.route });
        if (generation !== mine) return state;
        return set({ state: data == null ? "not_found" : "ready", reason: data == null ? "record_missing" : null, data });
      } catch (error) {
        if (generation !== mine) return state;
        const notFound = error?.code === "not_found";
        return set({ state: notFound ? "not_found" : "error", reason: notFound ? "record_missing" : error?.code || "loader_failed", error: { code: error?.code || "loader_failed", message: String(error?.message || error) } });
      }
    }
    return set({ state: "ready", reason: null });
  }

  const router = {
    table,
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start() {
      const onPop = () => { void resolve(currentPath()); };
      globalThis.addEventListener?.("popstate", onPop);
      void resolve(currentPath());
      return () => globalThis.removeEventListener?.("popstate", onPop);
    },
    href: (id, params) => routeHref(table, id, params),
    /** Navigate to a path or to { id, params }. Same target twice is a no-op; history is pushed unless replace. */
    navigate(target, { replace = false } = {}) {
      const path = typeof target === "string" ? normalizePath(target) : routeHref(table, target.id, target.params || {});
      if (path === state.path && state.state !== "not_found") return Promise.resolve(state);
      if (replace) history?.replaceState?.({}, "", path); else history?.pushState?.({}, "", path);
      return resolve(path);
    },
    reload() { return resolve(state.path); },
    /** For tests and server rendering: resolve without touching history. */
    resolve,
  };
  return router;
}
