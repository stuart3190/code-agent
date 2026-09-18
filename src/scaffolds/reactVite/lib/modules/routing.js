// Routing module v1 — platform infrastructure, do not edit or reimplement.
//
// The deterministic route compiler (audit §10). Given the application's route declarations it
// owns matching precedence and ambiguity rejection, parameter parsing/encoding, typed href
// generation, guard evaluation and not-found semantics. Pure: the same functions run in the
// composed router, in the platform's verifier and in tests. Navigation placement, layout and
// the presentation of loading/denied/not-found states remain entirely the application's.
//
//   RouteDefinition = {
//     id, path, params: { [name]: { type: "string" | "entityId" | "integer", entity? } },
//     guard: "any" | "visitor" | "member", loader?: { operation, args }, states: [...]
//   }

export const ROUTING_MODULE_VERSION = "1.0.0";

export const ROUTE_STATES = Object.freeze(["loading", "ready", "not_found", "forbidden", "error"]);

export class RouteError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.code = code;
    if (details) this.details = details;
  }
}

export function normalizePath(value) {
  const path = String(value || "/").split(/[?#]/)[0] || "/";
  const collapsed = path.replace(/\/{2,}/g, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed;
}

const segmentsOf = (path) => normalizePath(path).split("/").filter(Boolean);

/** Static segments outrank parameters; longer patterns outrank shorter; catch-all last. */
function specificity(path) {
  const segments = segmentsOf(path);
  let score = 0;
  for (const segment of segments) {
    if (segment === "*") score += 0;
    else if (segment.startsWith(":")) score += 1;
    else score += 3;
  }
  return score * 100 + segments.length;
}

function paramNames(path) {
  return segmentsOf(path).filter((segment) => segment.startsWith(":")).map((segment) => segment.slice(1));
}

/**
 * Compile declarations into an ordered, validated route table. Throws on duplicate ids, duplicate
 * patterns and ambiguous patterns (two routes that would match the same path with equal
 * specificity), so a contract can never ship an undecidable router.
 */
export function compileRoutes(definitions = []) {
  const routes = [];
  const seenIds = new Set();
  const seenPatterns = new Map();
  for (const definition of definitions) {
    if (!definition?.id || typeof definition.id !== "string") throw new RouteError("route_id_missing", "every route needs an id");
    if (seenIds.has(definition.id)) throw new RouteError("route_id_duplicate", `route id ${definition.id} is declared twice`);
    seenIds.add(definition.id);
    const path = normalizePath(definition.path);
    if (!/^\/(?:(?:[\w.-]+|:[A-Za-z_$][\w$]*|\*)(?:\/(?:[\w.-]+|:[A-Za-z_$][\w$]*|\*))*)?$/.test(path)) {
      throw new RouteError("route_path_invalid", `route ${definition.id} has an invalid path ${definition.path}`);
    }
    const shape = segmentsOf(path).map((segment) => (segment.startsWith(":") ? ":" : segment)).join("/");
    if (seenPatterns.has(shape)) throw new RouteError("route_pattern_duplicate", `routes ${seenPatterns.get(shape)} and ${definition.id} share the pattern ${path}`);
    seenPatterns.set(shape, definition.id);
    const declaredParams = definition.params || {};
    const params = Object.fromEntries(paramNames(path).map((name) => [name, { type: "string", ...(declaredParams[name] || {}) }]));
    routes.push(Object.freeze({
      id: definition.id, path, params: Object.freeze(params),
      guard: definition.guard || "any",
      loader: definition.loader || null,
      states: Object.freeze([...(definition.states || ROUTE_STATES)]),
      screen: definition.screen || null,
      name: definition.name || definition.id,
      specificity: specificity(path),
    }));
  }
  routes.sort((a, b) => b.specificity - a.specificity || a.id.localeCompare(b.id));
  return Object.freeze({ version: ROUTING_MODULE_VERSION, routes: Object.freeze(routes), byId: Object.freeze(Object.fromEntries(routes.map((route) => [route.id, route]))) });
}

function coerce(name, definition, raw) {
  let value;
  try { value = decodeURIComponent(raw); } catch { value = raw; }
  if (definition.type === "integer") {
    if (!/^-?\d+$/.test(value)) throw new RouteError("route_param_invalid", `${name} must be a whole number`, { name, value });
    return Number(value);
  }
  if (definition.type === "entityId" && !value) throw new RouteError("route_param_invalid", `${name} must identify a ${definition.entity || "record"}`, { name, value });
  return value;
}

/** The most specific matching route with typed params, or null (not found). A bad param is an error, not a miss. */
export function matchRoute(table, actualPath) {
  const seen = segmentsOf(actualPath);
  for (const route of table.routes) {
    const wanted = segmentsOf(route.path);
    const catchAll = wanted.at(-1) === "*";
    if (!catchAll && wanted.length !== seen.length) continue;
    if (catchAll && seen.length < wanted.length - 1) continue;
    const params = {};
    let ok = true;
    for (let index = 0; index < wanted.length; index += 1) {
      const part = wanted[index];
      if (part === "*") break;
      if (part.startsWith(":")) {
        const name = part.slice(1);
        params[name] = coerce(name, route.params[name] || { type: "string" }, seen[index]);
      } else if (part !== seen[index]) { ok = false; break; }
    }
    if (ok) return { route, params: Object.freeze(params), path: normalizePath(actualPath) };
  }
  return null;
}

/** A concrete href for a route id. Every declared parameter must be supplied — never a literal ":projectId". */
export function routeHref(table, id, params = {}) {
  const route = table.byId[id];
  if (!route) throw new RouteError("route_unknown", `no route ${id}`);
  const href = segmentsOf(route.path).map((segment) => {
    if (segment === "*") return "";
    if (!segment.startsWith(":")) return segment;
    const name = segment.slice(1);
    const value = params[name];
    if (value === undefined || value === null || value === "") {
      throw new RouteError("route_param_missing", `route ${id} needs ${name}`, { id, name });
    }
    return encodeURIComponent(String(value));
  }).filter((segment) => segment !== "").join("/");
  return `/${href}`;
}

/**
 * Evaluate a route guard against a session state ({ status }). Returns the outcome the
 * application renders or acts on; the platform never renders it.
 */
export function evaluateGuard(route, sessionState, { signInRoute = null } = {}) {
  const status = sessionState?.status || "initializing";
  const guard = route?.guard || "any";
  if (guard === "any") return Object.freeze({ state: "ready", reason: null, redirectTo: null });
  if (status === "initializing") return Object.freeze({ state: "loading", reason: "session_initializing", redirectTo: null });
  if (guard === "visitor") {
    const allowed = status === "visitor" || status === "signed_in";
    return Object.freeze({ state: allowed ? "ready" : "forbidden", reason: allowed ? null : status, redirectTo: allowed ? null : signInRoute });
  }
  if (status === "signed_in") return Object.freeze({ state: "ready", reason: null, redirectTo: null });
  return Object.freeze({ state: "forbidden", reason: status === "visitor" ? "member_required" : status, redirectTo: signInRoute });
}

/** Resolve a loader's args against matched params ("$params.projectId"). */
export function loaderArgs(loader, params = {}) {
  if (!loader?.args) return {};
  return Object.fromEntries(Object.entries(loader.args).map(([key, value]) => [key,
    typeof value === "string" && value.startsWith("$params.") ? params[value.slice("$params.".length)] : value]));
}
