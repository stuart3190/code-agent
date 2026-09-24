// The typed route plan (WP6).
//
// The contract's route declarations compile ONCE into RouteDefinitions (audit §10): a stable
// route id, typed parameters (an `:entityId` parameter names the entity whose canonical id it
// carries), a guard from the route's `auth` flag and the identity mode, a loader for a detail
// route bound to the entity's module read, and the states the screen must render. The composed
// router and the verifier resolve routes by id and typed parameters, never by prose; the
// application owns navigation placement, layout and the presentation of every state.

import { compileRoutes, normalizePath } from "../../../../../src/scaffolds/reactVite/lib/modules/routing.js";

export const ROUTE_PLAN_VERSION = 1;

const slug = (value) => String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const lower = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");

function routeId(route, path, used) {
  const statics = path.split("/").filter(Boolean).filter((segment) => !segment.startsWith(":"));
  const params = path.split("/").filter(Boolean).filter((segment) => segment.startsWith(":"));
  let base = statics.length ? statics.map(slug).join(".") : slug(route.name) || "home";
  if (params.length) base += ".detail";
  if (!base) base = "home";
  let id = base;
  let counter = 2;
  while (used.has(id)) id = `${base}-${counter++}`;
  used.add(id);
  return id;
}

function paramType(name, entityNames) {
  const match = /^(.+?)[-_]?(?:id|ref)$/i.exec(name);
  if (!match) return { type: "string" };
  const stem = lower(match[1]);
  const entity = entityNames.find((candidate) => lower(candidate) === stem || `${lower(candidate)}s` === stem || lower(candidate) === `${stem}s`);
  return entity ? { type: "entityId", entity } : { type: "string" };
}

/**
 * @param {object} contract the typed contract
 * @param {object} options
 * @param {object} [options.identityPlan] deriveIdentityPlan() output (mode, redirects)
 * @param {object} [options.entitySchema] compileEntitySchema() output (entity names)
 * @param {Array} [options.screens] scaffold graph screens ({ routePath, module, screenId })
 */
export function deriveRoutePlan(contract, { identityPlan = null, entitySchema = null, screens = [] } = {}) {
  const entityNames = entitySchema?.entities || (contract?.entities || []).map((entity) => entity?.name).filter(Boolean);
  const used = new Set();
  const problems = [];
  const memberMode = identityPlan?.mode === "member";
  const definitions = [];
  for (const route of contract?.routes || []) {
    const path = normalizePath(route?.path);
    if (!route?.path || !/^\/(?:(?:[\w.-]+|:[A-Za-z_$][\w$]*)(?:\/(?:[\w.-]+|:[A-Za-z_$][\w$]*))*)?$/.test(path)) {
      problems.push(`route "${route?.name || route?.path}" has an unstructured path ${route?.path}`);
      continue;
    }
    const id = routeId(route, path, used);
    const params = Object.fromEntries(path.split("/").filter(Boolean).filter((segment) => segment.startsWith(":"))
      .map((segment) => [segment.slice(1), paramType(segment.slice(1), entityNames)]));
    const entityParams = Object.entries(params).filter(([, definition]) => definition.type === "entityId");
    const screen = screens.find((candidate) => normalizePath(candidate.routePath) === path) || null;
    definitions.push({
      id, path, name: route.name || id, params,
      guard: route.auth === true ? (memberMode ? "member" : "visitor") : "any",
      loader: entityParams.length === 1 ? { operation: `${entityParams[0][1].entity}.get`, args: { id: `$params.${entityParams[0][0]}` }, entity: entityParams[0][1].entity } : null,
      screen: screen?.module || null,
      screenId: screen?.screenId || null,
      states: entityParams.length ? ["loading", "ready", "not_found", "forbidden", "error"] : ["loading", "ready", "forbidden", "error"],
      auth: route.auth === true,
    });
  }
  let table = null;
  try { table = compileRoutes(definitions); }
  catch (error) { problems.push(`route table: ${error.message}`); }
  const signInRoute = identityPlan?.redirect?.signedOut || null;
  const homeRoute = identityPlan?.redirect?.signedIn || definitions.find((route) => !route.auth)?.path || definitions[0]?.path || "/";
  return {
    version: ROUTE_PLAN_VERSION,
    module: "thrallo.routing",
    routes: table ? table.routes.map((route) => ({ ...route })) : definitions,
    order: table ? table.routes.map((route) => route.id) : definitions.map((route) => route.id),
    parameterised: definitions.filter((route) => Object.keys(route.params).length).map((route) => route.id),
    guarded: definitions.filter((route) => route.guard !== "any").map((route) => route.id),
    notFound: { state: "not_found", fallback: null },
    redirect: { signedOut: signInRoute, signedIn: homeRoute },
    verification: routeVerificationPlan(definitions, { memberMode }),
    verdict: { ok: problems.length === 0, problems },
  };
}

/** Deterministic probes for the installed router: direct load, params, back/forward, 404, guards. */
export function routeVerificationPlan(definitions, { memberMode = false } = {}) {
  const probes = [{ id: "route.directLoad", routes: definitions.filter((route) => !Object.keys(route.params).length).map((route) => route.id) }];
  const parameterised = definitions.filter((route) => Object.keys(route.params).length);
  if (parameterised.length) {
    probes.push({ id: "route.params", routes: parameterised.map((route) => route.id), expect: "the bound record opens; a literal :param never navigates" });
    probes.push({ id: "route.notFound", routes: parameterised.map((route) => route.id), expect: "an unknown id renders not_found, not the first route" });
  }
  probes.push({ id: "route.unknownPath", expect: "an undeclared path renders not_found" });
  if (definitions.length > 1) probes.push({ id: "route.history", expect: "back and forward restore the previous screen without a reload" });
  const guarded = definitions.filter((route) => route.guard !== "any");
  if (guarded.length) probes.push({ id: "route.guard", routes: guarded.map((route) => route.id), expect: memberMode ? "a visitor is redirected/denied; a member enters" : "an identity is required" });
  return probes;
}
