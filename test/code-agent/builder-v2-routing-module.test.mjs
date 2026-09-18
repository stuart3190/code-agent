// WP6 — typed routing and generated layouts.
//
// The route compiler owns matching precedence, ambiguity rejection, typed parameters, href
// generation, guards, loaders and not-found; the composed shell mounts a generated layout with an
// outlet instead of enforcing one navigation design; a parameterised route never appears as a
// literal navigation destination; a visitor cannot enter a member route; an unknown id or path
// renders not_found instead of the first route.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { compileRoutes, evaluateGuard, matchRoute, routeHref, RouteError } from "../../src/scaffolds/reactVite/lib/modules/routing.js";
import { createRouter } from "../../src/scaffolds/reactVite/lib/modules/router.js";
import { deriveRoutePlan } from "../../shell/server/lib/builderV2/platformModules/routePlan.mjs";
import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import {
  APP_FACADE_ROUTING_PATH, ROUTES_COMPOSED_PATH, composeCapabilityFoundation,
} from "../../shell/server/lib/builderV2/capabilityComposer.mjs";
import {
  APP_LAYOUT_PATH, ROUTE_STATES_PATH, ROUTING_RUNTIME_PATH, SCAFFOLD_APP_PATH, composeScaffoldFoundation,
  scaffoldCompositionPlanFor, validateScaffoldComposition,
} from "../../shell/server/lib/builderV2/scaffoldComposer.mjs";
import { lintPlatformAbi } from "../../shell/server/lib/builderV2/platformModules/abiLint.mjs";
import { moduleManifest, validateModuleRegistry } from "../../shell/server/lib/builderV2/platformModules/registry.mjs";
import { verifyModuleLock } from "../../shell/server/lib/builderV2/platformModules/lock.mjs";
import { isProtectedPath } from "../../shell/server/lib/builderV2/patchEngine.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";

const require = createRequire(new URL("../../harness/.deps/node_modules/", import.meta.url));
const React = require("react");
const { renderToString } = require("react-dom/server");

const CONTRACT = {
  summary: "Lighting planner with projects and rooms", projectType: "tool", version: 2, auth: { required: true, rules: [] },
  routes: [
    { path: "/signin", name: "Sign in" }, { path: "/projects", name: "Projects", auth: true },
    { path: "/projects/:projectId", name: "Project", auth: true }, { path: "/projects/new", name: "New project", auth: true },
  ],
  entities: [{ name: "project", owned: true, fields: [{ name: "name", type: "string", required: true }] }],
  operations: [
    { id: "sign-in", kind: "signIn", journey: "plan", description: "sign in", responsibilities: [{ type: "functional", capability: "session", capabilityMethod: "signIn", behavior: "session", reads: ["authEmail", "authPassword"], writes: [] }] },
    { id: "create-project", entity: "project", kind: "create", journey: "plan", description: "create a project", responsibilities: [{ type: "persistence", capability: "crud", capabilityMethod: "create", reads: ["name"], writes: ["name"] }] },
    { id: "open-project", entity: "project", kind: "read", journey: "plan", description: "open a project", responsibilities: [{ type: "persistence", capability: "crud", capabilityMethod: "get", reads: ["name"], writes: [] }] },
  ],
  journeys: [{ id: "plan", title: "Plan a project", priority: "primary", stage: "primary_journey", steps: [
    { action: "open sign in", target: "/signin", expect: "sign-in panel" },
    { action: "sign in", target: "authentication form", operates: ["authEmail", "authPassword", "sign-in"], expect: "projects visible" },
    { action: "create a project", target: "new project form", operates: ["name", "create-project"], expect: "the project is listed" },
    { action: "open the project", target: "/projects/:projectId", operates: ["open-project"], expect: "the project name is shown" },
    { action: "reload", target: "reload", expect: "the project is still shown" },
  ], acceptance: ["persists"] }],
  acceptance: [{ id: "a1", statement: "a project survives reload", journey: "plan", kind: "persistence" }, { id: "a2", statement: "the detail route shows the project", journey: "plan", kind: "behavior" }, { id: "a3", statement: "sign-in shows projects", journey: "plan", kind: "behavior" }],
  states: [], integrations: [], deferred: [],
};

test("WP6 — the compiler orders by specificity, rejects ambiguity and duplicates, types params and builds hrefs", () => {
  const table = compileRoutes([
    { id: "home", path: "/" }, { id: "projects", path: "/projects", guard: "member" },
    { id: "projects.detail", path: "/projects/:projectId", params: { projectId: { type: "entityId", entity: "project" } }, guard: "member" },
    { id: "projects.new", path: "/projects/new", guard: "member" }, { id: "docs", path: "/docs/*" },
    { id: "orders.line", path: "/orders/:orderId/lines/:line", params: { line: { type: "integer" } } },
  ]);
  assert.deepEqual(table.routes.map((route) => route.id), ["orders.line", "projects.new", "projects.detail", "docs", "projects", "home"]);
  assert.equal(matchRoute(table, "/projects/new").route.id, "projects.new", "a static segment outranks a parameter");
  assert.deepEqual(matchRoute(table, "/projects/p%2F1").params, { projectId: "p/1" });
  assert.deepEqual(matchRoute(table, "/orders/o1/lines/3").params, { orderId: "o1", line: 3 });
  assert.throws(() => matchRoute(table, "/orders/o1/lines/three"), (error) => error.code === "route_param_invalid");
  assert.equal(matchRoute(table, "/docs/a/b/c").route.id, "docs");
  assert.equal(matchRoute(table, "/nowhere"), null);
  // A trailing slash is the same route, so a link that ends in "/" is not a 404.
  assert.equal(matchRoute(table, "/projects/").route.id, "projects");
  assert.deepEqual(matchRoute(table, "/projects/").params, {});
  assert.equal(routeHref(table, "projects.detail", { projectId: "p 1" }), "/projects/p%201");
  assert.throws(() => routeHref(table, "projects.detail", {}), (error) => error.code === "route_param_missing", "a literal :projectId can never be a destination");
  assert.throws(() => compileRoutes([{ id: "a", path: "/x/:id" }, { id: "b", path: "/x/:other" }]), (error) => error.code === "route_pattern_duplicate");
  assert.throws(() => compileRoutes([{ id: "a", path: "/x" }, { id: "a", path: "/y" }]), (error) => error.code === "route_id_duplicate");
  assert.throws(() => compileRoutes([{ id: "bad", path: "/x/{id}" }]), (error) => error.code === "route_path_invalid");
  assert.deepEqual(evaluateGuard(table.byId.projects, { status: "visitor" }, { signInRoute: "/signin" }), { state: "forbidden", reason: "member_required", redirectTo: "/signin" });
  assert.deepEqual(evaluateGuard(table.byId.projects, { status: "signed_in" }), { state: "ready", reason: null, redirectTo: null });
  assert.equal(evaluateGuard(table.byId.projects, { status: "initializing" }).state, "loading");
  assert.equal(evaluateGuard(table.byId.home, { status: "signed_out" }).state, "ready");
  assert.ok(new RouteError("x", "y") instanceof Error);
});

test("WP6 — the router resolves direct loads, params, loaders, not-found, guards and history without a page load", async () => {
  const table = compileRoutes([
    { id: "home", path: "/" },
    { id: "project.detail", path: "/projects/:projectId", params: { projectId: { type: "entityId", entity: "project" } }, guard: "member", loader: { operation: "project.get", args: { id: "$params.projectId" } } },
  ]);
  const history = { entries: [], pushState: (_s, _t, path) => history.entries.push(["push", path]), replaceState: (_s, _t, path) => history.entries.push(["replace", path]) };
  const records = { p1: { id: "p1", version: 1, values: { name: "Showroom" } } };
  const loaders = { "project.get": async ({ id }) => records[id] || null };
  const member = createRouter({ table, identity: { getState: () => ({ status: "signed_in" }), ensure: async () => {} }, loaders, signInRoute: "/signin", history, currentPath: () => "/" });
  await member.resolve("/projects/p1");
  assert.deepEqual([member.getState().state, member.getState().params, member.getState().data.values.name], ["ready", { projectId: "p1" }, "Showroom"]);
  await member.resolve("/projects/missing");
  assert.deepEqual([member.getState().state, member.getState().reason], ["not_found", "record_missing"]);
  await member.resolve("/nowhere");
  assert.deepEqual([member.getState().state, member.getState().route], ["not_found", null], "an unknown path is not_found, never the first route");
  await member.navigate({ id: "project.detail", params: { projectId: "p1" } });
  assert.deepEqual(history.entries.at(-1), ["push", "/projects/p1"]);
  await member.navigate("/projects/p1", { replace: true });
  assert.equal(history.entries.length, 1, "navigating to the current path is a no-op");
  // Superseded loads never apply: a slow loader for the first id loses to a fast second navigation.
  const slowLoaders = { "project.get": async ({ id }) => (id === "slow" ? new Promise((resolve) => setTimeout(() => resolve({ id: "slow", values: {} }), 40)) : records[id] || null) };
  const racing = createRouter({ table, identity: { getState: () => ({ status: "signed_in" }), ensure: async () => {} }, loaders: slowLoaders, history: null, currentPath: () => "/" });
  const first = racing.resolve("/projects/slow");
  await racing.resolve("/projects/p1");
  await first;
  assert.equal(racing.getState().data.id, "p1");
  // A visitor is refused at a member route and told where to go; the loader never runs.
  let loaderRan = false;
  const visitor = createRouter({ table, identity: { getState: () => ({ status: "visitor" }), ensure: async () => {} }, loaders: { "project.get": async () => { loaderRan = true; return records.p1; } }, signInRoute: "/signin", history: null, currentPath: () => "/" });
  await visitor.resolve("/projects/p1");
  assert.deepEqual([visitor.getState().state, visitor.getState().reason, visitor.getState().redirectTo, loaderRan], ["forbidden", "member_required", "/signin", false]);
  // A missing loader is a platform error, never a silent ready.
  const unloaded = createRouter({ table, identity: { getState: () => ({ status: "signed_in" }), ensure: async () => {} }, loaders: {}, history: null, currentPath: () => "/" });
  await unloaded.resolve("/projects/p1");
  assert.deepEqual([unloaded.getState().state, unloaded.getState().reason], ["error", "loader_missing"]);
});

test("WP6 — the route plan derives ids, typed params, guards, loaders and probes from the typed contract", () => {
  const spec = deriveBuildSpec(CONTRACT);
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join(" | "));
  const plan = spec.routePlan;
  assert.equal(plan.verdict.ok, true, plan.verdict.problems.join(" | "));
  assert.deepEqual(plan.order, ["projects.new", "projects.detail", "projects", "signin"]);
  const detail = plan.routes.find((route) => route.id === "projects.detail");
  assert.deepEqual(detail.params, { projectId: { type: "entityId", entity: "project" } });
  assert.deepEqual([detail.guard, detail.loader, detail.screen], ["member", { operation: "project.get", args: { id: "$params.projectId" }, entity: "project" }, "src/screens/scaffold/ProjectScreen.jsx"]);
  assert.deepEqual(detail.states, ["loading", "ready", "not_found", "forbidden", "error"]);
  assert.equal(plan.routes.find((route) => route.id === "signin").guard, "any");
  assert.deepEqual(plan.redirect, { signedOut: "/signin", signedIn: "/projects" });
  assert.deepEqual(plan.verification.map((probe) => probe.id), ["route.directLoad", "route.params", "route.notFound", "route.unknownPath", "route.history", "route.guard"]);
  const dup = deriveRoutePlan({ routes: [{ path: "/a/:x", name: "A" }, { path: "/a/:y", name: "B" }] });
  assert.equal(dup.verdict.ok, false);
  assert.match(dup.verdict.problems.join(), /share the pattern/);
});

test("WP6 — the composer ships the route table, a generated layout with an outlet and route-state slots; the shell never renders its own navigation design", () => {
  const spec = deriveBuildSpec(CONTRACT);
  const capability = composeCapabilityFoundation(REACT_VITE, spec.capabilityGraph, { moduleLock: spec.moduleLock, identityPlan: spec.identityPlan, entitySchema: spec.entitySchema, routePlan: spec.routePlan });
  assert.ok(typeof capability.tree[ROUTES_COMPOSED_PATH] === "string");
  assert.match(capability.tree[ROUTES_COMPOSED_PATH], /"id": "projects\.detail"/);
  assert.match(capability.tree[ROUTES_COMPOSED_PATH], /createRouter\(/);
  assert.match(capability.tree[APP_FACADE_ROUTING_PATH], /export function useRoute\(\)/);
  assert.match(capability.tree[APP_FACADE_ROUTING_PATH], /export const routeHref/);
  assert.match(capability.tree["src/lib/app/index.js"], /export \* from ".\/routing.js";/);
  const scaffold = composeScaffoldFoundation(capability.tree, spec.scaffoldGraph, { routePlan: spec.routePlan });
  const app = scaffold.tree[SCAFFOLD_APP_PATH];
  assert.match(app, /import AppLayout from/, "the protected root mounts the generated layout");
  assert.doesNotMatch(app, /ScaffoldNavigation/, "no enforced navigation list when the routing module is installed");
  assert.match(app, /RouteStates/, "loading/not-found/forbidden/error presentation is the application's");
  assert.ok(typeof scaffold.tree[APP_LAYOUT_PATH] === "string" && !isProtectedPath(APP_LAYOUT_PATH), "the layout is a model-owned slot");
  assert.ok(typeof scaffold.tree[ROUTE_STATES_PATH] === "string" && !isProtectedPath(ROUTE_STATES_PATH));
  assert.match(scaffold.tree[APP_LAYOUT_PATH], /children/);
  const custom = { ...scaffold.tree, [APP_LAYOUT_PATH]: "export default function AppLayout({ children }) { return <div className=\"mine\">{children}</div>; }\n" };
  assert.equal(composeScaffoldFoundation(custom, spec.scaffoldGraph, { routePlan: spec.routePlan }).tree[APP_LAYOUT_PATH], custom[APP_LAYOUT_PATH], "recomposition never overwrites a generated layout");
  assert.equal(validateScaffoldComposition(scaffold.tree, spec.scaffoldGraph, scaffold.plan, { requireExtensions: false, rejectScreenSlots: false }).ok, true);
  assert.deepEqual(verifyModuleLock(scaffold.tree, spec.moduleLock), { ok: true, problems: [] });
  // A tree that does not ship the routing runtime (a legacy base, a retained fixture) keeps the
  // pre-WP6 shell it was generated with — and is JUDGED against that shell, not against a router
  // it never had.
  // The bare scaffold ships the routing RUNTIME but has no composed facade, which is exactly the
  // state of an application whose contract never selected routing.
  assert.equal(typeof REACT_VITE[ROUTING_RUNTIME_PATH], "string");
  const legacy = composeScaffoldFoundation(REACT_VITE, spec.scaffoldGraph);
  assert.match(legacy.tree[SCAFFOLD_APP_PATH], /ScaffoldNavigation/);
  assert.equal(APP_LAYOUT_PATH in legacy.tree, false);
  assert.equal(legacy.plan.protectedFileHashes[SCAFFOLD_APP_PATH],
    scaffoldCompositionPlanFor(legacy.tree, spec.scaffoldGraph).protectedFileHashes[SCAFFOLD_APP_PATH]);
  assert.equal(validateScaffoldComposition(legacy.tree, spec.scaffoldGraph, undefined, { requireExtensions: false, rejectScreenSlots: false }).ok, true,
    "the legacy shell is not reported as a modified protected module");
});

test("WP6 — registry and lint: thrallo.routing is locked; a literal parameterised path in generated code is reported", () => {
  assert.deepEqual(validateModuleRegistry(), { ok: true, problems: [] });
  const routing = moduleManifest("thrallo.routing");
  assert.equal(routing.version, "1.0.0");
  assert.ok(routing.runtime.protectedArtifacts.some((artifact) => artifact.path === "src/lib/modules/routing.js"));
  const spec = deriveBuildSpec(CONTRACT);
  assert.ok(spec.moduleResolution.modules.some((row) => row.id === "thrallo.routing"));
  const tree = {
    ...REACT_VITE, "src/lib/capabilities/composed/routes.js": "// composed\n", "src/lib/capabilities/composed/lock.js": "export const MODULE_LOCK = Object.freeze({});\n",
    "src/screens/scaffold/ProjectsScreen.jsx": `import { Link } from "../../lib/app/index.js";\nexport default function P() { return <Link to="/projects/:projectId">Open</Link>; }\n`,
  };
  const findings = lintPlatformAbi(tree, { locked: true }).findings;
  assert.ok(findings.some((row) => row.code === "route_parameter_literal" && row.module === "src/screens/scaffold/ProjectsScreen.jsx"), JSON.stringify(findings.map((row) => row.code)));
});

test("WP6 — UI binding: a generated layout and screens render every route state through the facade hooks", async () => {
  const { mkdir, writeFile, symlink } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const path = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const { depsNodeModules, workDirFor } = await import("../../harness/workspace.mjs");
  const dir = workDirFor("routing-ui-binding");
  for (const file of ["src/lib/modules/routing.js", "src/lib/modules/router.js", "src/lib/modules/uiReact.js", "src/lib/capabilities/react.js"]) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), REACT_VITE[file]);
  }
  if (!existsSync(path.join(dir, "node_modules"))) await symlink(depsNodeModules(), path.join(dir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const hooks = await import(pathToFileURL(path.join(dir, "src/lib/modules/uiReact.js")).href);
  const table = compileRoutes([{ id: "home", path: "/" }, { id: "project.detail", path: "/projects/:projectId", guard: "member", loader: { operation: "project.get", args: { id: "$params.projectId" } } }]);
  const router = createRouter({ table, identity: { getState: () => ({ status: "visitor" }), ensure: async () => {} }, loaders: { "project.get": async () => null }, signInRoute: "/signin", history: null, currentPath: () => "/projects/p1" });
  await router.resolve("/projects/p1");
  const Layout = ({ children, route }) => React.createElement("div", { className: "brand" }, React.createElement("nav", null, route?.id || "none"), children);
  const Screen = () => {
    const state = hooks.useRouterState(router);
    if (state.state === "forbidden") return React.createElement(Layout, { route: state.route }, React.createElement("p", { role: "alert" }, `Please sign in (${state.reason})`));
    if (state.state === "not_found") return React.createElement(Layout, { route: state.route }, React.createElement("p", null, "Nothing here"));
    return React.createElement(Layout, { route: state.route }, React.createElement("main", null, "Ready"));
  };
  assert.match(renderToString(React.createElement(Screen)), /Please sign in \(member_required\)/);
  await router.resolve("/nowhere");
  assert.match(renderToString(React.createElement(Screen)), /Nothing here/);
});
