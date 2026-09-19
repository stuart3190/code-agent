// Contract-authoritative routing.
//
// WHERE a journey step happens is a fact of the contract, never an inference from its prose. The
// previous rule scored route names against step text by token overlap: "Task List" in an expectation
// moved a controller to a route named "Task List"; a step that named no route was placed by the words
// in the journey's title. Generation then briefed one screen while the composition gate validated
// another, and repair rounds "changed nothing" until the allowance ran out (retained: dd7970e,
// 5bcf0b2 - navigation vs mutation target, created project detail navigation).
//
// Resolution here is a fixed ladder of exact relations, each of which the contract could have
// written down itself:
//   1. `step.route`            - the declared route path (authoritative)
//   2. `step.target` is a path - a declared route path used as the target
//   3. auth capability         - a step that performs a declared auth operation happens on the
//                                contract's one authentication route
//   4. route identity          - the target IS a declared route's name (exact, after dropping
//                                articles and "page/screen/route/view/tab/section" - not overlap)
//   5. entity relation         - the step's declared operation/field entity owns exactly one route:
//                                the collection route, or the `:entityId` detail route when the step
//                                READS that identity
//   6. reload / back           - a reload stays on the current screen; back returns to the previous
//   7. single route            - an application with one route has one screen
//   8. journey start           - a journey that names no first screen starts on its own entity's
//                                collection route, where its first navigation leads, or where the
//                                application starts
// A step that opens a named SURFACE ("the task list page", "the board view") which binds to no route
// by any relation is UNRESOLVED: a contract defect the contract repair round fixes by naming the
// route. Opening anything else that is not a route ("the status breakdown") is an in-screen action:
// the step stays on the mounted screen (scaffold ownership). Nothing here guesses.

import { canonicalOperationKind } from "./lifecycleOperations.mjs";
import { isSessionOperation } from "../../../shared/implementationContract.mjs";

export const ROUTE_RESOLUTION_VERSION = 1;
export const ROUTE_UNRESOLVED_ISSUE = "journey_route_unresolved";
export const ROUTE_BASIS = Object.freeze({
  DECLARED_ROUTE: "declared_route",
  TARGET_PATH: "target_path",
  CAPABILITY_ROUTE: "capability_route",
  ROUTE_NAME: "route_name",
  ENTITY_RELATION: "entity_relation",
  RELOAD: "reload",
  BACK: "back",
  SINGLE_ROUTE: "single_route",
  JOURNEY_ENTITY: "journey_entity",
  FIRST_NAVIGATION: "first_navigation",
  ENTRY_ROUTE: "entry_route",
  UNRESOLVED: "unresolved",
});

const list = (value) => (Array.isArray(value) ? value.filter((row) => row != null && row !== "") : []);
const unique = (values) => [...new Set((values || []).filter(Boolean))];
const normalized = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const SURFACE_WORDS = /\b(?:the|a|an|page|screen|route|view|tab|section|area|panel)\b/gi;
const SURFACE_TRIGGER = /\b(?:page|screen|route|view)\b/i;
const surfaceIdentity = (value) => normalized(String(value || "").replace(SURFACE_WORDS, " "));
const NAVIGATION_VERB = /\b(?:open|visit|navigate|go|return|reload|refresh|back)\b/i;
const RELOAD_VERB = /\b(?:reload|refresh)\b/i;
const BACK_VERB = /\b(?:go back|return to the previous|back to the previous|navigate back)\b/i;
const AUTH_ROUTE_IDENTITY = new Set(["signin", "login", "logon", "signon", "auth", "authenticate", "authentication", "account"]);

export function structuredRoutePath(value = "") {
  const target = String(value || "").trim();
  return target === "/" || /^\/(?:[\w-]+|:[A-Za-z_$][\w$]*)(?:\/(?:[\w-]+|:[A-Za-z_$][\w$]*))*\/?$/.test(target)
    ? (target.length > 1 ? target.replace(/\/+$/, "") : target) : null;
}

const routePaths = (contract) => unique((contract?.routes || []).map((route) => structuredRoutePath(route?.path)));
const declaredRoute = (contract, path) => {
  const wanted = structuredRoutePath(path);
  return wanted && routePaths(contract).includes(wanted) ? wanted : null;
};
const lastStaticSegment = (path) => String(path || "").split("/").filter(Boolean).filter((segment) => !segment.startsWith(":")).at(-1) || "";

/** Plural forms an entity's collection route may use; exact equality against a path segment only. */
function entityAliases(name) {
  const base = normalized(name);
  if (!base) return [];
  return unique([base, `${base}s`, `${base}es`, base.endsWith("y") ? `${base.slice(0, -1)}ies` : null]);
}

function routeEntityCandidates(contract, entity) {
  const aliases = new Set(entityAliases(entity));
  return unique((contract?.routes || []).filter((route) => {
    const path = structuredRoutePath(route?.path);
    if (!path) return false;
    const statics = path.split("/").filter(Boolean).filter((segment) => !segment.startsWith(":")).map(normalized);
    return statics.some((segment) => aliases.has(segment)) || aliases.has(normalized(route?.name));
  }).map((route) => structuredRoutePath(route.path)));
}

/** The one declared entity a step's machine facts name, or null when they name none or several. */
export function stepEntity(contract, step) {
  const entities = (contract?.entities || []).map((entity) => entity?.name).filter(Boolean);
  const operations = new Map((contract?.operations || []).map((operation) => [
    normalized(operation?.id || operation?.name), operation,
  ]));
  const fieldOwners = new Map();
  for (const entity of contract?.entities || []) {
    for (const field of entity?.fields || []) {
      const key = normalized(field?.name ?? field);
      if (!key) continue;
      if (!fieldOwners.has(key)) fieldOwners.set(key, new Set());
      fieldOwners.get(key).add(entity.name);
    }
  }
  const operands = [...list(step?.operates), ...list(step?.reads), ...list(step?.produces)]
    .map((value) => normalized(String(value).split(".").pop()));
  const fromOperations = unique(operands.map((key) => operations.get(key)?.entity));
  if (fromOperations.length === 1) return fromOperations[0];
  if (fromOperations.length > 1) return null;
  // An identity field names its entity by construction: projectId is the project's identity even
  // when the task entity also carries a projectId foreign key.
  const fromIdentity = unique(operands.flatMap((key) => entities.filter((entity) => key === `${normalized(entity)}id`)));
  if (fromIdentity.length === 1) return fromIdentity[0];
  if (fromIdentity.length > 1) return null;
  const fromFields = unique(operands.flatMap((key) => {
    const owners = fieldOwners.get(key);
    return owners && owners.size === 1 ? [...owners] : [];
  }));
  return fromFields.length === 1 ? fromFields[0] : null;
}

/** Reading an entity's identity puts the step on that record's detail; selecting it does not. */
function readsIdentityOf(step, entity) {
  const identity = `${normalized(entity)}id`;
  return list(step?.reads).some((value) => normalized(String(value).split(".").pop()) === identity);
}

/** Entity relation: exactly one route owns the entity the step names. */
function entityRelation(contract, step, entity) {
  if (!entity) return null;
  const candidates = routeEntityCandidates(contract, entity);
  if (!candidates.length) return null;
  const identity = `:${normalized(entity)}id`;
  const detail = candidates.filter((path) => path.toLowerCase().includes(identity));
  const collection = candidates.filter((path) => !path.includes(":"));
  if (readsIdentityOf(step, entity) && detail.length === 1) return { routePath: detail[0], candidates };
  if (collection.length === 1) return { routePath: collection[0], candidates };
  if (candidates.length === 1) return { routePath: candidates[0], candidates };
  return { routePath: null, candidates };
}

/** Route identity: the target IS a route's name or its collection segment (parameterised routes excluded). */
function routeByName(contract, target) {
  const wanted = surfaceIdentity(target);
  if (!wanted) return null;
  const matches = unique((contract?.routes || []).filter((route) => {
    const path = structuredRoutePath(route?.path);
    if (!path) return false;
    if (surfaceIdentity(route?.name) === wanted) return true;
    return !path.includes(":") && normalized(lastStaticSegment(path)) === wanted;
  }).map((route) => structuredRoutePath(route.path)));
  return matches.length === 1 ? matches[0] : null;
}

/** The contract's one authentication route, when a step performs a declared auth operation. */
function authRoute(contract, step) {
  const operations = new Map((contract?.operations || []).map((operation) => [
    normalized(operation?.id || operation?.name), operation,
  ]));
  const performsAuth = list(step?.operates).some((value) => {
    const operation = operations.get(normalized(value));
    if (!operation) return false;
    const kind = normalized(operation.kind || operation.action || "");
    const capabilities = (operation.responsibilities || []).map((row) => normalized(row?.capability));
    // The canonical session vocabulary (capability "session", kinds signIn/signUp/signOut) is
    // the same authentication as the legacy "auth" spelling; before WP2 a contract written the
    // way the prompt teaches never received the authentication route basis at all.
    return kind === "auth" || kind === "signin" || kind === "login" || capabilities.includes("auth")
      || isSessionOperation(operation);
  });
  if (!performsAuth) return null;
  const routes = unique((contract?.routes || []).filter((route) => {
    const path = structuredRoutePath(route?.path);
    if (!path) return false;
    return AUTH_ROUTE_IDENTITY.has(surfaceIdentity(route?.name)) || AUTH_ROUTE_IDENTITY.has(normalized(lastStaticSegment(path)))
      || /authenticat/i.test(String(route?.purpose || ""));
  }).map((route) => structuredRoutePath(route.path)));
  return routes.length === 1 ? routes[0] : null;
}

/** Does this step move the browser? (Its own first step always says where the journey starts.) */
export function isNavigationStep(step, stepIndex) {
  if (structuredRoutePath(step?.route) || structuredRoutePath(step?.target)) return true;
  if (list(step?.operates).length) return false;
  return stepIndex === 0 || NAVIGATION_VERB.test(String(step?.action || ""));
}

/** The entity a journey as a whole is about: the entity of its declared operations when they agree. */
function journeyEntity(contract, journey) {
  const declared = (contract?.operations || []).filter((operation) => operation?.journey === journey?.id
    || (journey?.steps || []).some((step) => list(step?.operates).map(normalized)
      .includes(normalized(operation?.id || operation?.name))));
  const creators = unique(declared
    .filter((operation) => canonicalOperationKind(operation?.kind || operation?.action || operation?.method) === "create")
    .map((operation) => operation?.entity));
  if (creators.length === 1) return creators[0];
  const entities = unique(declared.map((operation) => operation?.entity));
  return entities.length === 1 ? entities[0] : null;
}

/**
 * Resolve every route transition of one journey.
 *
 * Returns `{ initialRoute, initialBasis, transitions: [{ stepIndex, routePath, basis, candidates?,
 * reload? }], unresolved: [{ stepIndex, target, candidates, reason }] }`. `transitions` lists the
 * route mounted from each listed step on; a step not listed stays on the current screen.
 */
export function resolveJourneyRoutes(contract, journey) {
  const paths = routePaths(contract);
  const steps = journey?.steps || [];
  const transitions = [];
  const unresolved = [];
  const reloads = [];
  let current = null;
  let previous = null;
  const move = (stepIndex, routePath, basis, candidates = []) => {
    if (!routePath || current === routePath) return;
    previous = current;
    current = routePath;
    transitions.push({ stepIndex, routePath, basis, ...(candidates.length ? { candidates } : {}) });
  };
  for (const [stepIndex, step] of steps.entries()) {
    const action = String(step?.action || "");
    const target = String(step?.target || "").trim();
    const navigation = isNavigationStep(step, stepIndex);
    if (step?.route !== undefined && step?.route !== null && step.route !== "") {
      const path = declaredRoute(contract, step.route);
      if (path) { move(stepIndex, path, ROUTE_BASIS.DECLARED_ROUTE); continue; }
      unresolved.push({ stepIndex, target: String(step.route), candidates: paths,
        reason: `step ${stepIndex + 1} declares route "${step.route}", which the contract does not declare` });
      continue;
    }
    if (structuredRoutePath(target)) {
      const path = declaredRoute(contract, target);
      if (path) { move(stepIndex, path, ROUTE_BASIS.TARGET_PATH); continue; }
      unresolved.push({ stepIndex, target, candidates: paths,
        reason: `step ${stepIndex + 1} targets path "${target}", which the contract does not declare` });
      continue;
    }
    const auth = authRoute(contract, step);
    if (auth) { move(stepIndex, auth, ROUTE_BASIS.CAPABILITY_ROUTE); continue; }
    // A step that operates controls after the journey has started is owned by the screen it is on.
    if (!navigation && stepIndex > 0) continue;
    if (navigation && RELOAD_VERB.test(action) && (!target || /reload|refresh|browser|same|current/i.test(target))) {
      reloads.push(stepIndex);
      continue;
    }
    if (navigation && BACK_VERB.test(action) && previous) { move(stepIndex, previous, ROUTE_BASIS.BACK); continue; }
    const named = navigation && target ? routeByName(contract, target) : null;
    if (named) { move(stepIndex, named, ROUTE_BASIS.ROUTE_NAME); continue; }
    const relation = entityRelation(contract, step, stepEntity(contract, step));
    if (relation?.routePath) { move(stepIndex, relation.routePath, ROUTE_BASIS.ENTITY_RELATION, relation.candidates); continue; }
    if (paths.length === 1) { move(stepIndex, paths[0], ROUTE_BASIS.SINGLE_ROUTE); continue; }
    if (navigation && target && SURFACE_TRIGGER.test(target)) {
      unresolved.push({ stepIndex, target, candidates: relation?.candidates?.length ? relation.candidates : paths,
        reason: `step ${stepIndex + 1} opens "${target}", which is not a declared route path, a declared route's name, `
          + "or the collection/detail route of the entity the step operates" });
    }
    // Anything else opened is an in-screen action: the step stays on the mounted screen.
  }
  // WHERE THE JOURNEY STARTS when its first step did not say. A first step that operated controls
  // of some OTHER entity (sign-in credentials before the sign-in) happened where the first navigation
  // leads; a first step that touched nothing starts on the journey's own entity's collection route;
  // otherwise the first navigation, otherwise where the application starts.
  if (!transitions.length || transitions[0].stepIndex > 0) {
    const own = entityRelation(contract, {}, journeyEntity(contract, journey));
    const firstNavigation = transitions.length
      ? { stepIndex: 0, routePath: transitions[0].routePath, basis: ROUTE_BASIS.FIRST_NAVIGATION } : null;
    const ownStart = own?.routePath
      ? { stepIndex: 0, routePath: own.routePath, basis: ROUTE_BASIS.JOURNEY_ENTITY, candidates: own.candidates } : null;
    const firstStepOperates = list(steps[0]?.operates).length > 0;
    const initial = (firstStepOperates ? firstNavigation || ownStart : ownStart || firstNavigation)
      || { stepIndex: 0, routePath: paths[0] || "/", basis: paths.length === 1 ? ROUTE_BASIS.SINGLE_ROUTE : ROUTE_BASIS.ENTRY_ROUTE };
    transitions.unshift(initial);
  }
  // A reload re-mounts whatever screen was current at that step.
  for (const stepIndex of reloads) {
    const routePath = [...transitions].filter((row) => !row.reload && row.stepIndex <= stepIndex).at(-1)?.routePath || null;
    if (routePath) transitions.push({ stepIndex, routePath, basis: ROUTE_BASIS.RELOAD, reload: true });
  }
  transitions.sort((left, right) => left.stepIndex - right.stepIndex || Number(Boolean(left.reload)) - Number(Boolean(right.reload)));
  return {
    initialRoute: transitions[0].routePath,
    initialBasis: transitions[0].basis,
    transitions,
    unresolved,
  };
}

/** Resolve every journey; `issues` lists each unresolved navigation step as a contract defect. */
export function resolveContractRoutes(contract) {
  const journeys = {};
  const issues = [];
  for (const journey of contract?.journeys || []) {
    if (!journey?.id) continue;
    const resolution = resolveJourneyRoutes(contract, journey);
    journeys[journey.id] = resolution;
    for (const row of resolution.unresolved) {
      issues.push({
        code: ROUTE_UNRESOLVED_ISSUE, journeyId: journey.id, stepIndex: row.stepIndex,
        target: row.target, candidates: row.candidates, declaredRoutes: routePaths(contract),
        message: `${journey.id} ${row.reason}`,
      });
    }
  }
  return { version: ROUTE_RESOLUTION_VERSION, journeys, issues };
}

const STAMPED_BASES = new Set([ROUTE_BASIS.ROUTE_NAME, ROUTE_BASIS.ENTITY_RELATION]);

/**
 * Stamp every navigation the ladder resolved by NAME or ENTITY RELATION onto its step as `route`,
 * so the interaction contract, the verifier and the prerequisite planner navigate by the declared
 * path instead of re-deriving it. Only real transitions are stamped (a route equal to the one
 * already mounted would re-open the screen and discard what the step before typed). Steps that
 * already declare a route, path targets, reloads and journey-start rows are left exactly as written.
 */
export function stampResolvedRoutes(contract, resolution = resolveContractRoutes(contract)) {
  if (!contract?.journeys?.length) return contract;
  return {
    ...contract,
    journeys: contract.journeys.map((journey) => {
      const resolved = resolution.journeys?.[journey?.id];
      if (!resolved) return journey;
      const byStep = new Map();
      let mounted = null;
      for (const row of resolved.transitions) {
        if (row.reload) continue;
        if (STAMPED_BASES.has(row.basis) && row.stepIndex > 0 && mounted && mounted !== row.routePath) byStep.set(row.stepIndex, row.routePath);
        mounted = row.routePath;
      }
      return {
        ...journey,
        steps: (journey.steps || []).map((step, stepIndex) => {
          if (!byStep.has(stepIndex)) return step;
          if (step?.route !== undefined && step?.route !== null && step.route !== "") return step;
          if (list(step?.operates).length) return step;
          return { ...step, route: byStep.get(stepIndex) };
        }),
      };
    }),
  };
}
