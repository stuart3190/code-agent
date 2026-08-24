// Journey surface integration.
//
// A generated journey is implemented only when the route the browser opens can reach its
// behaviour. Builder V2 used to brief secondary increments with App.jsx plus a list of paths,
// but omitted the already-mounted route and its current flow component. The model therefore
// produced a sound journey component that nothing imported. Browser repair then kept editing the
// dead component because the mounted route was absent from the causal boundary.
//
// This module is deliberately deterministic and source-only. It identifies the contracted route,
// resolves that route through the existing App ROUTES map, and follows direct imports to the
// mounted flow. It never decides whether the rendered behaviour is correct; the browser remains
// the authority for that.

import path from "node:path";

import { indexTree } from "./indexer.mjs";
import { memoryGraph } from "./graphStore.mjs";

const SOURCE = /^src\/.+\.(?:jsx?|tsx?)$/;
const ENTRY = /^src\/(?:main|index|App)\.(?:jsx?|tsx?)$/;
const APP_FILES = ["src/App.jsx", "src/App.tsx", "src/App.js", "src/App.ts"];

const unique = (values) => [...new Set((values || []).filter(Boolean))];
const normalized = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");

function sourceCandidates(base) {
  return unique([
    base,
    `${base}.jsx`, `${base}.tsx`, `${base}.js`, `${base}.ts`,
    `${base}/index.jsx`, `${base}/index.tsx`, `${base}/index.js`, `${base}/index.ts`,
  ]);
}

function resolveImport(fromPath, specifier, tree) {
  if (!specifier?.startsWith(".")) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), specifier));
  return sourceCandidates(base).find((candidate) => typeof tree?.[candidate] === "string") || null;
}

/** Route path -> mounted route source, resolved from the existing App ROUTES authority. */
export function mountedRouteBindings(tree = {}) {
  const bindings = new Map();
  for (const appPath of APP_FILES) {
    const source = tree?.[appPath];
    if (typeof source !== "string") continue;
    const imports = new Map();
    for (const match of source.matchAll(/\bimport\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["']/g)) {
      const resolved = resolveImport(appPath, match[2], tree);
      if (resolved) imports.set(match[1], resolved);
    }
    for (const match of source.matchAll(/["'](\/[^"']*)["']\s*:\s*([A-Za-z_$][\w$]*)/g)) {
      const resolved = imports.get(match[2]);
      if (resolved) bindings.set(match[1] || "/", resolved);
    }
  }
  return bindings;
}

function routeTargets(contract, journey) {
  const routes = contract?.routes || [];
  const known = new Set(routes.map((route) => route.path));
  const targets = [];
  for (const step of journey?.steps || []) {
    const raw = String(step?.target || "").trim();
    if (raw.startsWith("/")) {
      const route = raw.split(/[?#]/)[0] || "/";
      if (known.has(route)) targets.push(route);
    }
  }
  if (targets.length) return unique(targets);

  const entryText = `${journey?.title || ""} ${(journey?.steps || []).slice(0, 2)
    .map((step) => `${step?.action || ""} ${step?.target || ""}`).join(" ")}`.toLowerCase();
  for (const route of routes) {
    const name = String(route?.name || "").toLowerCase();
    const segment = String(route?.path || "").split("/").filter(Boolean).at(-1)?.toLowerCase() || "";
    if ((name && entryText.includes(name)) || (segment && entryText.includes(segment))) targets.push(route.path);
  }
  if (!targets.length && /\b(home|homepage|landing)\b/.test(entryText) && known.has("/")) targets.push("/");
  if (!targets.length && routes.length === 1) targets.push(routes[0].path);
  return unique(targets);
}

function fallbackRouteFiles(tree, contract, routePaths) {
  const routes = (contract?.routes || []).filter((route) => routePaths.includes(route.path));
  const identities = new Set(routes.flatMap((route) => [
    normalized(route.name),
    normalized(String(route.path || "").split("/").filter(Boolean).at(-1)),
    route.path === "/" ? "home" : null,
  ]).filter(Boolean));
  return Object.keys(tree || {}).filter((file) => {
    if (!/^src\/routes\/.+\.(?:jsx?|tsx?)$/.test(file)) return false;
    const basename = normalized(path.posix.basename(file).replace(/\.(?:jsx?|tsx?)$/, "").replace(/page$/i, ""));
    return identities.has(basename);
  }).sort();
}

function reachableSource(graph, tree) {
  const seen = new Set();
  const queue = Object.keys(tree || {}).filter((file) => ENTRY.test(file)).sort();
  while (queue.length) {
    const current = queue.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    for (const imported of graph.importsOf(current)) {
      if (SOURCE.test(imported) && !seen.has(imported)) queue.push(imported);
    }
  }
  return seen;
}

/**
 * Source modules that the running application can actually load from its canonical entry points.
 *
 * Keep this authority shared with every journey-surface consumer. A source file merely existing
 * in the tree must never satisfy (or conflict with) a contract implemented on the mounted app.
 */
export function reachableSourcePaths(tree = {}) {
  return reachableSource(memoryGraph("surface-reachability", "surface-reachability", indexTree(tree)), tree);
}

function contractedJourneyModules(tree, contract, journeys, modulePlan) {
  const ids = new Set((journeys || []).map((journey) => journey?.id).filter(Boolean));
  const planned = (modulePlan || []).filter((module) => (
    (module.journeyIds || module.ownedJourneys || []).some((id) => ids.has(id))
  )).map((module) => module.path);
  const flowOwned = (contract?.interactionContract?.flows || []).filter((flow) => ids.has(flow.journeyId))
    .flatMap((flow) => [
      flow.stateOwner, flow.control?.stateOwner, flow.customBehaviorModule,
      ...(flow.responsibleModules || []),
    ]);
  const slugMatches = Object.keys(tree || {}).filter((file) => {
    if (!SOURCE.test(file)) return false;
    const compact = normalized(file);
    return [...ids].some((id) => compact.includes(normalized(id)));
  });
  const scaffoldActive = typeof tree?.["src/lib/scaffolds/composed/manifest.js"] === "string";
  const scaffoldOwned = (scaffoldActive ? contract?.scaffoldGraph?.journeyOwnership || [] : [])
    .filter((row) => ids.has(row.journeyId)).flatMap((row) => [row.mountedModule,
      ...(scaffoldActive ? contract?.scaffoldGraph?.extensions || [] : [])
        .filter((extension) => extension.owningJourneys?.includes(row.journeyId))
        .map((extension) => extension.module)]);
  return unique([...planned, ...flowOwned, ...scaffoldOwned, ...slugMatches])
    .filter((file) => typeof tree?.[file] === "string" && SOURCE.test(file)).sort();
}

/**
 * The exact mounted surface relevant to one or more contracted journeys.
 *
 * `mountedPaths` contains the route and its direct generated-source dependencies. The direct
 * boundary is intentional: it supplies the existing flow without expanding a small increment
 * prompt into the whole application. `unreachableJourneyModules` is evidence only; an unmounted
 * file is not itself a browser failure.
 */
export function journeySurfaceContext(tree = {}, contract = {}, journeys = [], { modulePlan = [] } = {}) {
  const selected = (journeys || []).map((journey) => (
    typeof journey === "string"
      ? (contract?.journeys || []).find((candidate) => candidate?.id === journey) || { id: journey }
      : journey
  )).filter(Boolean);
  const bindings = mountedRouteBindings(tree);
  const scaffoldActive = typeof tree?.["src/lib/scaffolds/composed/manifest.js"] === "string";
  const routePaths = unique(selected.flatMap((journey) => [
    ...routeTargets(contract, journey),
    (scaffoldActive ? contract?.scaffoldGraph?.journeyOwnership || [] : [])
      .find((row) => row.journeyId === journey?.id)?.routePath,
  ]));
  const scaffoldRoutes = scaffoldActive ? contract?.scaffoldGraph?.routes || [] : [];
  const routeFiles = unique([
    ...routePaths.map((route) => scaffoldRoutes.find((candidate) => candidate.routePath === route)?.module)
      .filter(Boolean),
    ...routePaths.map((route) => bindings.get(route)).filter(Boolean),
    ...fallbackRouteFiles(tree, contract, routePaths),
  ]).sort();
  const graph = memoryGraph("surface", "surface", indexTree(tree));
  const mountedPaths = unique(routeFiles.flatMap((file) => [
    file,
    ...graph.importsOf(file).filter((imported) => SOURCE.test(imported)
      && !/^src\/lib\//.test(imported)),
  ])).sort().slice(0, 8);
  const reachable = reachableSource(graph, tree);
  const journeyModules = contractedJourneyModules(tree, contract, selected, modulePlan);
  const unreachableJourneyModules = journeyModules.filter((file) => !reachable.has(file));
  return {
    journeys: selected.map((journey) => journey?.id).filter(Boolean),
    routePaths,
    routeFiles,
    mountedPaths,
    journeyModules,
    unreachableJourneyModules,
  };
}

export function journeySurfaceBrief(context) {
  if (!context?.routeFiles?.length) {
    return "MOUNTED JOURNEY SURFACE: no existing route source was resolved; register any new route in src/App.jsx and make the assigned journey reachable from it.";
  }
  return [
    "MOUNTED JOURNEY SURFACE (current runtime authority):",
    `- Contracted journey(s): [${context.journeys.join(", ")}]`,
    `- Browser entry route(s): [${context.routePaths.join(", ")}]`,
    `- Mounted route source: [${context.routeFiles.join(", ")}]`,
    `- Current direct mounted source: [${context.mountedPaths.join(", ")}]`,
    "Implement the assigned outcome on this already-mounted surface. Either extend the mounted shared flow or mount the new journey component from the route.",
    "A new source file that no reachable route imports does NOT implement the journey. Preserve every already-green journey on the same surface.",
  ].join("\n");
}
