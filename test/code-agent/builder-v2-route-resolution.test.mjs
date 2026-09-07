// ROUTING IS CONTRACT-AUTHORITATIVE.
//
// Retained defects: dd7970e (three screens imported react-router-dom because nothing bound the
// contracted parameterised route to a primitive), 5bcf0b2 (a navigation step was planned as a
// mutation target; the created project's detail navigation went to the wrong screen). Both trace to
// one rule: route names were SCORED against step prose by token overlap, so "Task List" in an
// expectation moved a controller, and a journey with no route evidence was placed by its title.
//
// The rule is now a fixed ladder of exact relations (routeResolution.mjs): declared route, path
// target, auth capability route, exact route name, entity relation, single route, journey start.
// A named surface that binds to nothing is an unresolved contract issue the contract repair round
// names a route for; anything else "opened" is an in-screen action. No overlap, no guess.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  isNavigationStep, resolveContractRoutes, resolveJourneyRoutes, ROUTE_BASIS, ROUTE_UNRESOLVED_ISSUE,
  stampResolvedRoutes, stepEntity,
} from "../../shell/server/lib/builderV2/routeResolution.mjs";
import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import { deriveScaffoldGraph, validateScaffoldGraph } from "../../shell/server/lib/builderV2/scaffoldGraph.mjs";
import {
  contractDependencyRepairScope, mergeContractDependencyRepair, ROUTE_REPAIR_INSTRUCTION,
} from "../../shell/server/lib/appBuild/contractAgent.mjs";
import { validateContract } from "../../shell/shared/implementationContract.mjs";
import { preflightImports, composedRouterPrimitives } from "../../shell/server/lib/appBuild/importPreflight.mjs";
import { renderScaffoldFoundation, SCAFFOLD_PRIMITIVES_PATH } from "../../shell/server/lib/builderV2/scaffoldComposer.mjs";

const field = (name, type = "string") => ({ name, type, required: true });
const persistence = (fields, method) => ({ type: "persistence", reads: fields, writes: fields, capability: "crud", capabilityMethod: method });

/** Alder-shaped: projects with a parameterised detail route, a task board, analytics and admin. */
const alder = (journeys) => {
  const operations = [
    { id: "create-project", kind: "create", entity: "project", journey: "create-project", description: "persist a project",
      responsibilities: [persistence(["title", "status", "ownerId"], "create")] },
    { id: "create-task", kind: "create", entity: "task", journey: "create-task", description: "persist a task",
      responsibilities: [persistence(["projectId", "title", "status"], "create")] },
    { id: "update-member-role", kind: "update", entity: "member", journey: "admin", description: "persist a role",
      responsibilities: [persistence(["role"], "update")] },
    { id: "sign-in", kind: "auth", entity: "session", journey: "create-project", description: "authenticate",
      responsibilities: [{ type: "persistence", capability: "auth", capabilityMethod: "signIn", reads: ["email", "password"], writes: [] }] },
  ].filter((operation) => operation.id === "sign-in" || journeys.some((journey) => journey.id === operation.journey))
    .map((operation) => (journeys.some((journey) => journey.id === operation.journey) ? operation : { ...operation, journey: journeys[0].id }));
  return {
    summary: "Alder Studio work tracker", projectType: "dashboard", version: 1, auth: { required: true },
    routes: [
      { path: "/login", name: "Sign in", auth: false, purpose: "authenticate" },
      { path: "/projects", name: "Projects", auth: true, purpose: "projects list" },
      { path: "/projects/:projectId", name: "Project", auth: true, purpose: "one project and its tasks" },
      { path: "/board", name: "Task Board", auth: true, purpose: "tasks by status" },
      { path: "/analytics", name: "Analytics", auth: true, purpose: "computed summary" },
      { path: "/admin", name: "Admin", auth: true, purpose: "member roles" },
    ],
    entities: [
      { name: "session", storage: "external platform authentication", fields: [field("email"), field("password")] },
      { name: "project", fields: [field("projectId"), field("title"), field("status"), field("ownerId")] },
      { name: "task", fields: [field("taskId"), field("projectId"), field("title"), field("status"), field("ownerId")] },
      { name: "member", fields: [field("memberId"), field("role")] },
    ],
    operations,
    sampleData: { member: [{ memberId: "m1", role: "member" }], task: [{ taskId: "t1", projectId: "p1", title: "Seed", status: "To Do", ownerId: "m1" }] },
    journeys,
    acceptance: [], states: [], deferred: [], imageIntents: [], integrations: [],
  };
};

test("declared route, path target, auth capability and exact route name resolve; an operating step stays put", () => {
  const contract = alder([{ id: "create-project", title: "create a project", priority: "primary", steps: [
    { action: "enter credentials", target: "sign-in form", operates: ["email", "password"], expect: "the credentials are entered" },
    { action: "submit sign in", target: "sign in button", operates: ["sign-in"], expect: "the projects link is visible" },
    { action: "open the projects page", target: "projects page", expect: "the projects list is shown" },
    { action: "create a project", target: "new project form", operates: ["title", "status", "ownerId", "create-project"],
      expect: "the project appears in the list" },
    { action: "open the analytics view", route: "/analytics", target: "analytics", expect: "cards are visible" },
    { action: "go to the task board", target: "Task Board", expect: "columns are visible" },
    { action: "open the status breakdown", target: "status breakdown", expect: "the breakdown is visible" },
  ] }]);
  const resolved = resolveJourneyRoutes(contract, contract.journeys[0]);
  assert.deepEqual(resolved.unresolved, []);
  assert.deepEqual(resolved.transitions.map((row) => [row.stepIndex, row.routePath, row.basis]), [
    [0, "/login", ROUTE_BASIS.FIRST_NAVIGATION],
    [1, "/login", ROUTE_BASIS.CAPABILITY_ROUTE],
    [2, "/projects", ROUTE_BASIS.ROUTE_NAME],
    [4, "/analytics", ROUTE_BASIS.DECLARED_ROUTE],
    [5, "/board", ROUTE_BASIS.ROUTE_NAME],
  ]);
  // The form step operates controls: it is owned by the screen it is on; "open the status
  // breakdown" names no route, so it is an in-screen action rather than a navigation.
  assert.equal(isNavigationStep(contract.journeys[0].steps[3], 3), false);
  const stamped = stampResolvedRoutes(contract);
  assert.equal(stamped.journeys[0].steps[2].route, "/projects");
  assert.equal(stamped.journeys[0].steps[5].route, "/board");
  assert.equal(stamped.journeys[0].steps[1].route, undefined, "re-opening the mounted sign-in route would discard the typed credentials");
  assert.equal(stamped.journeys[0].steps[6].route, undefined);
});

test("the entity relation binds the collection route, and the detail route when the step reads the identity", () => {
  const contract = alder([{ id: "create-task", title: "create a task", priority: "primary", steps: [
    { action: "choose a project", target: "the list", operates: ["projectId"], primitive: "selection", expect: "projects shown" },
    { action: "open the created project", target: "the created project's card", reads: ["projectId"], expect: "the project detail is shown" },
    { action: "add a task", target: "task form", operates: ["title", "status", "create-task"], reads: ["projectId"], expect: "the task appears" },
  ] }]);
  assert.equal(stepEntity(contract, contract.journeys[0].steps[1]), "project", "projectId is the project's identity even though task also carries it");
  const resolved = resolveJourneyRoutes(contract, contract.journeys[0]);
  assert.deepEqual(resolved.unresolved, []);
  // Selecting a project happens on the collection; reading its identity happens on its detail.
  assert.deepEqual(resolved.transitions.map((row) => [row.stepIndex, row.routePath, row.basis]), [
    [0, "/projects", ROUTE_BASIS.ENTITY_RELATION],
    [1, "/projects/:projectId", ROUTE_BASIS.ENTITY_RELATION],
  ]);
  assert.deepEqual(resolved.transitions[1].candidates.slice().sort(), ["/projects", "/projects/:projectId"]);
  assert.equal(stampResolvedRoutes(contract).journeys[0].steps[1].route, "/projects/:projectId");
});

test("token overlap never routes: an unnamed open stays put, a named surface that binds to nothing is unresolved", () => {
  const contract = alder([
    { id: "filters", title: "filter the board and list views", priority: "primary", steps: [
      { action: "open the task list", target: "task list", expect: "the task list shows tasks" },
      { action: "filter by status", target: "status filter", operates: ["status"], primitive: "selection", expect: "only matching tasks are listed" },
    ] },
    { id: "named-surface", title: "open a surface the contract never declared", priority: "secondary", steps: [
      { action: "open the projects page", target: "/projects", expect: "projects" },
      { action: "open the task list page", target: "the task list page", expect: "the task list shows tasks" },
    ] },
  ]);
  const filters = resolveJourneyRoutes(contract, contract.journeys[0]);
  // "Task Board" shares the token "task" with "task list"; the old scorer would have bound it.
  assert.deepEqual(filters.unresolved, []);
  assert.ok(!filters.transitions.some((row) => row.routePath === "/board"), JSON.stringify(filters.transitions));
  // The filter journey's declared operations name no entity with a route: it starts at the entry.
  assert.equal(filters.initialBasis, ROUTE_BASIS.ENTRY_ROUTE);
  const named = resolveJourneyRoutes(contract, contract.journeys[1]);
  assert.equal(named.unresolved.length, 1, JSON.stringify(named));
  assert.equal(named.unresolved[0].stepIndex, 1);
  assert.match(named.unresolved[0].reason, /not a declared route path, a declared route's name/);
  const all = resolveContractRoutes(contract);
  assert.deepEqual(all.issues.map((issue) => [issue.code, issue.journeyId, issue.stepIndex]), [[ROUTE_UNRESOLVED_ISSUE, "named-surface", 1]]);
  assert.deepEqual(all.issues[0].declaredRoutes, contract.routes.map((route) => route.path));
});

test("reload re-mounts the current screen; a journey with no first screen starts on its entity's route or the entry", () => {
  const contract = alder([
    { id: "admin", title: "administrator manages member roles", priority: "secondary", steps: [
      { action: "choose a member", target: "members table", operates: ["memberId"], primitive: "selection", expect: "the member is highlighted" },
      { action: "change the role", target: "role selector", operates: ["role", "update-member-role"], primitive: "selection", expect: "the role is shown" },
      { action: "reload the page", target: "browser reload", expect: "the role is still shown" },
    ] },
    { id: "create-project", title: "create a project", priority: "primary", steps: [
      { action: "fill in the project", target: "new project form", operates: ["title", "status", "ownerId", "create-project"], expect: "the project appears" },
      { action: "reload", expect: "the project is still listed" },
    ] },
  ]);
  const admin = resolveJourneyRoutes(contract, contract.journeys[0]);
  assert.deepEqual(admin.unresolved, []);
  // Members own no route: the journey starts where the application starts, and says so.
  assert.equal(admin.initialRoute, "/login");
  assert.equal(admin.initialBasis, ROUTE_BASIS.ENTRY_ROUTE);
  assert.deepEqual(admin.transitions.filter((row) => row.reload).map((row) => [row.stepIndex, row.routePath]), [[2, "/login"]]);
  const create = resolveJourneyRoutes(contract, contract.journeys[1]);
  assert.deepEqual(create.unresolved, []);
  assert.equal(create.initialRoute, "/projects", "the first step operates the project create: it happens on the projects route");
  assert.equal(create.initialBasis, ROUTE_BASIS.ENTITY_RELATION);
  assert.deepEqual(create.transitions.filter((row) => row.reload).map((row) => row.routePath), ["/projects"]);
  // Reload, entry and journey-start rows are never stamped: only a real transition by name/entity is.
  const stamped = stampResolvedRoutes(contract);
  assert.equal(stamped.journeys[0].steps[2].route, undefined);
  assert.equal(stamped.journeys[1].steps[0].route, undefined);
  assert.equal(stamped.journeys[1].steps[1].route, undefined);
});

test("the build spec stamps resolved routes onto steps, and the interaction contract navigates by them", () => {
  const contract = alder([{ id: "analytics", title: "analytics loads on arrival", priority: "primary", steps: [
    { action: "sign in", target: "/login", operates: ["email", "password", "sign-in"], expect: "signed in" },
    { action: "open the analytics page", target: "analytics page", expect: "cards are visible" },
  ] }]);
  const spec = deriveBuildSpec(contract);
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));
  assert.equal(spec.contract.journeys[0].steps[1].route, "/analytics");
  const navigation = spec.interactionContract.flows.find((flow) => flow.journeyId === "analytics" && flow.stepIndex === 1 && flow.kind === "navigation");
  assert.ok(navigation, JSON.stringify(spec.interactionContract.flows.filter((flow) => flow.stepIndex === 1).map((flow) => flow.kind)));
  assert.equal(navigation.target, "/analytics");
  assert.equal(spec.scaffoldGraph.routeResolution.journeys.analytics.transitions.at(-1).basis, ROUTE_BASIS.ROUTE_NAME);
  const owner = spec.scaffoldGraph.journeyRouteOwnership.filter((row) => row.journeyId === "analytics");
  assert.deepEqual(owner.map((row) => row.routePath), ["/login", "/analytics"]);
  // Stamping is idempotent: a second derivation of the stamped contract changes nothing.
  assert.deepEqual(deriveBuildSpec(spec.contract).contract.journeys, spec.contract.journeys);
});

test("an unresolved route fails the gate, opens a route repair scope, and the merged repair closes it", () => {
  const contract = alder([{ id: "filters", title: "filter the board", priority: "primary", steps: [
    { action: "sign in", target: "/login", operates: ["email", "password", "sign-in"], expect: "signed in" },
    { action: "open the task list page", target: "task list page", expect: "tasks are listed" },
    { action: "filter by status", target: "status filter", operates: ["status"], primitive: "selection", expect: "only matching tasks" },
  ] }]);
  const rejected = deriveBuildSpec(contract);
  assert.equal(rejected.verdict.ok, false);
  assert.equal(rejected.verdict.scaffoldGraph.ok, false);
  const issue = rejected.verdict.scaffoldGraph.issues.find((row) => row.code === ROUTE_UNRESOLVED_ISSUE);
  assert.ok(issue, JSON.stringify(rejected.verdict.scaffoldGraph));
  assert.match(rejected.verdict.problems.join("\n"), /filters step 2 opens "task list page"/);
  const graphVerdict = validateScaffoldGraph(deriveScaffoldGraph(contract, rejected.capabilityGraph), contract, rejected.capabilityGraph);
  assert.equal(graphVerdict.ok, false);

  const scope = contractDependencyRepairScope(contract, [issue]);
  assert.ok(scope, "an unresolved route opens a contract repair scope");
  assert.equal(scope.mode, "interaction_contract_repair");
  assert.deepEqual(scope.unresolvedRoutes.map((row) => [row.journeyId, row.stepIndex, row.target]), [["filters", 1, "task list page"]]);
  assert.deepEqual(scope.declaredRoutes, contract.routes.map((route) => route.path));
  assert.ok(scope.journeys.some((journey) => journey.id === "filters"));
  assert.match(ROUTE_REPAIR_INSTRUCTION, /Set that step's "route"/);

  const repairedJourney = structuredClone(scope.journeys[0]);
  repairedJourney.steps[1].route = "/board";
  const repaired = mergeContractDependencyRepair(contract, { contractPatch: { journeys: [repairedJourney], routes: contract.routes } }, scope);
  assert.deepEqual(repaired.routes, contract.routes, "routes the repair did not change keep their identity");
  const accepted = deriveBuildSpec(repaired);
  assert.equal(accepted.verdict.ok, true, accepted.verdict.problems.join("; "));
  assert.equal(accepted.scaffoldGraph.journeyRouteOwnership.find((row) => row.journeyId === "filters" && row.stepIndex === 1)?.routePath, "/board");

  // A repair that names an undeclared route is itself a contract defect.
  const bogus = structuredClone(repaired);
  bogus.journeys[0].steps[1].route = "/nowhere";
  assert.match(validateContract(bogus).problems.join("\n"), /route "\/nowhere" is not a declared route/);
  assert.equal(deriveBuildSpec(bogus).verdict.ok, false);
});

test("the retained medium fixtures resolve every navigation step without prose scoring", async () => {
  for (const name of ["bv2-medium-create-step-contract.json", "bv2-medium-consumer-replay-contract.json",
    "bv2-medium-load-on-arrival-contract.json", "bv2-medium-reset-button-contract.json", "bv2-retained-medium-a5396ba2.json"]) {
    const model = JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
    const resolution = resolveContractRoutes(model);
    assert.deepEqual(resolution.issues, [], `${name}: ${JSON.stringify(resolution.issues)}`);
    for (const [journeyId, resolved] of Object.entries(resolution.journeys)) {
      assert.ok(resolved.initialRoute, `${name} ${journeyId} has an initial route`);
      for (const row of resolved.transitions) assert.notEqual(row.basis, ROUTE_BASIS.UNRESOLVED);
    }
    assert.equal(deriveBuildSpec(model).verdict.ok, true, name);
  }
  // The retained Alder contract: the created project's detail navigation binds to the detail route
  // by the identity it reads (5bcf0b2), and "open the status breakdown section" stays on analytics.
  const alderRetained = JSON.parse(await readFile(new URL("./fixtures/bv2-retained-medium-a5396ba2.json", import.meta.url), "utf8"));
  const resolution = resolveContractRoutes(alderRetained);
  const detail = resolution.journeys["create-and-update-project-work"].transitions.find((row) => row.stepIndex === 2);
  assert.equal(detail?.routePath, "/projects/:projectId");
  assert.equal(detail?.basis, ROUTE_BASIS.ENTITY_RELATION);
  const analytics = resolution.journeys["view-analytics-summary"].transitions.filter((row) => !row.reload).map((row) => row.routePath);
  assert.deepEqual(analytics, ["/analytics"]);
});

// ── react-router-dom in a generated screen ─────────────────────────────────────────────────────

const composedTree = () => {
  const foundation = renderScaffoldFoundation({
    version: 1, registryVersion: 1, families: [], extensions: [],
    screens: [{ routePath: "/", routeName: "Items", screenId: "items", module: "src/screens/scaffold/ItemsScreen.jsx" }],
    routes: [{ routePath: "/", screenId: "items", module: "src/screens/scaffold/ItemsScreen.jsx", journeyIds: [] }],
    journeyRouteOwnership: [],
  });
  return {
    "package.json": JSON.stringify({ name: "app", dependencies: { react: "^18.3.1", "react-dom": "^18.3.1" } }),
    ...foundation.protectedFiles,
    ...foundation.screenFiles,
  };
};

test("the composed primitives export every router name a screen may reach for", () => {
  const tree = composedTree();
  const primitives = composedRouterPrimitives(tree);
  assert.equal(primitives.path, SCAFFOLD_PRIMITIVES_PATH);
  for (const name of ["Link", "RouteLink", "NavLink", "useParams", "useRouteParams", "useNavigate", "useLocation", "Navigate", "useRoute"]) {
    assert.ok(primitives.exports.has(name), `${name} is exported by the composed primitives`);
  }
});

test("react-router-dom imports of supported names are rewritten to the composed primitives", async () => {
  const tree = composedTree();
  tree["src/screens/scaffold/ItemsScreen.jsx"] = `import React from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
export default function ItemsScreen() { const { id } = useParams(); const navigate = useNavigate(); return <Link to="/">{id}</Link>; }
`;
  tree["src/components/Nav.jsx"] = `import { NavLink, useLocation } from 'react-router-dom';
export function Nav() { const location = useLocation(); return <NavLink to="/">{location.pathname}</NavLink>; }
`;
  const result = await preflightImports(tree, { nodeModules: null });
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  const rewrites = result.corrections.filter((row) => row.kind === "rewrote_router_import");
  assert.equal(rewrites.length, 2, JSON.stringify(result.corrections));
  assert.match(result.tree["src/screens/scaffold/ItemsScreen.jsx"],
    /import \{ Link, useParams, useNavigate \} from "\.\.\/\.\.\/lib\/scaffolds\/composed\/primitives\.jsx";/);
  assert.match(result.tree["src/components/Nav.jsx"], /from '\.\.\/lib\/scaffolds\/composed\/primitives\.jsx';/);
  // The rewritten specifier resolves inside the tree: a second preflight finds nothing to fix.
  const again = await preflightImports(result.tree, { nodeModules: null });
  assert.equal(again.ok, true, JSON.stringify(again.problems));
  assert.deepEqual(again.corrections, []);
});

test("a nested router is refused by name, and without the composed primitives the package is simply missing", async () => {
  const tree = composedTree();
  tree["src/screens/scaffold/ItemsScreen.jsx"] = `import { BrowserRouter, Routes, Route, Link } from "react-router-dom";
export default function ItemsScreen() { return <BrowserRouter><Routes><Route path="/" element={<Link to="/">x</Link>} /></Routes></BrowserRouter>; }
`;
  const refused = await preflightImports(tree, { nodeModules: null });
  assert.equal(refused.ok, false);
  const problem = refused.problems.find((row) => row.kind === "unsupported_router_import");
  assert.ok(problem, JSON.stringify(refused.problems));
  assert.deepEqual(problem.names, ["BrowserRouter", "Routes", "Route"]);
  assert.match(problem.message, /composed shell owns the router/);
  assert.equal(refused.corrections.length, 0, "nothing is rewritten when the import cannot be honoured in full");

  const plain = {
    "package.json": JSON.stringify({ name: "app", dependencies: { react: "^18.3.1" } }),
    "src/App.jsx": `import { Link } from "react-router-dom";
export default function App() { return <Link to="/">x</Link>; }
`,
  };
  const missing = await preflightImports(plain, { nodeModules: null });
  assert.equal(missing.ok, false);
  assert.equal(missing.problems[0].kind, "missing_dependency");
});
