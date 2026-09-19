// WP7 — query/collections, forms/interactions and async resource state.
//
// Filtering is a validated specification the backend executes across pages; cursors are opaque,
// composite and bound to their query; forms coerce and validate before a single submission path;
// resources cancel superseded loads; mutations roll back optimistic patches on failure; the
// facade exposes useCollection/useForm/useResource/useMutation while the old scaffold hook names
// keep working.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { compileSchema } from "../../src/scaffolds/reactVite/lib/modules/schema.js";
import { QueryError, backendOptions, compileQuery, decodeCursor, encodeCursor, matchesQuery, runQuery } from "../../src/scaffolds/reactVite/lib/modules/query.js";
import { createCollection } from "../../src/scaffolds/reactVite/lib/modules/collections.js";
import { coerceFieldValue, createForm } from "../../src/scaffolds/reactVite/lib/modules/forms.js";
import { createMutation, createResource, createResourceCache } from "../../src/scaffolds/reactVite/lib/modules/asyncState.js";
import { createEntityRepository } from "../../src/scaffolds/reactVite/lib/modules/entities.js";
import { createSupabaseBackend } from "../../src/scaffolds/reactVite/lib/backend/supabaseBackend.js";
import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import { APP_FACADE_ENTITIES_PATH, composeCapabilityFoundation } from "../../shell/server/lib/builderV2/capabilityComposer.mjs";
import { SCAFFOLD_PRIMITIVES_PATH, renderScaffoldFoundation } from "../../shell/server/lib/builderV2/scaffoldComposer.mjs";
import { moduleManifest, validateModuleRegistry } from "../../shell/server/lib/builderV2/platformModules/registry.mjs";
import { lintQueryBindings } from "../../shell/server/lib/builderV2/platformModules/queryLint.mjs";
import { severityOf } from "../../shell/server/lib/builderV2/validationSeverity.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";

const require = createRequire(new URL("../../harness/.deps/node_modules/", import.meta.url));
const React = require("react");
const { renderToString } = require("react-dom/server");

const SCHEMA = compileSchema([{ name: "project", fields: [
  { name: "name", type: "string", required: true }, { name: "budget", type: "number", minimum: 0 },
  { name: "status", options: ["draft", "active"] }, { name: "notes", type: "text" }, { name: "specs", type: "json" },
] }]);
const RECORDS = Array.from({ length: 9 }, (_, i) => ({ id: `p${i}`, version: 1, createdAt: `2026-09-1${i}T00:00:00Z`, updatedAt: null,
  values: { name: `Project ${i}`, budget: i * 10, status: i % 2 ? "active" : "draft" } }));
// Two records with the SAME created_at: the tie-breaker is what keeps pages stable.
RECORDS[4] = { ...RECORDS[4], createdAt: RECORDS[3].createdAt };

test("WP7 — a query is a validated specification: allow-listed fields and operators, normalised values, no json filters", () => {
  const compiled = compileQuery(SCHEMA, "project", { filters: { budget: { gte: "20", lte: 60 }, status: "active", name: { ilike: "%proj%" } }, sort: { field: "created_at", direction: "asc" }, page: { size: 3 } });
  assert.deepEqual(compiled.filters, [
    { field: "budget", operator: "gte", value: 20 }, { field: "budget", operator: "lte", value: 60 },
    { field: "name", operator: "ilike", value: "%proj%" }, { field: "status", operator: "eq", value: "active" },
  ]);
  assert.equal(compiled.key, compileQuery(SCHEMA, "project", { filters: { status: "active", name: { ilike: "%proj%" }, budget: { lte: 60, gte: 20 } }, sort: { field: "created_at", direction: "asc" } }).key, "the key is canonical");
  assert.throws(() => compileQuery(SCHEMA, "project", { filters: { secret: 1 } }), (error) => error instanceof QueryError && error.code === "query_field_not_allowed");
  assert.throws(() => compileQuery(SCHEMA, "project", { filters: { specs: { eq: 1 } } }), (error) => error.code === "query_field_not_allowed", "json fields are not queryable");
  assert.throws(() => compileQuery(SCHEMA, "project", { filters: { name: { gte: "a" } } }), (error) => error.code === "query_operator_not_allowed");
  assert.throws(() => compileQuery(SCHEMA, "project", { filters: { budget: "lots" } }), (error) => error.code === "query_value_invalid");
  assert.throws(() => compileQuery(SCHEMA, "project", { sort: { field: "budget" } }), (error) => error.code === "query_sort_not_allowed", "only server-stable orders paginate");
  assert.throws(() => compileQuery(SCHEMA, "project", { search: { fields: ["budget"], text: "x" } }), (error) => error.code === "query_search_not_allowed");
  assert.deepEqual(backendOptions(compiled), { filters: { budget: { gte: 20, lte: 60 }, name: { ilike: "%proj%" }, status: { eq: "active" } }, order: "created_at", ascending: true, limit: 4, cursor: null });
});

test("WP7 — pagination is stable across pages with a composite cursor bound to its query", () => {
  const spec = { filters: { status: { in: ["draft", "active"] } }, sort: { field: "created_at", direction: "asc" }, page: { size: 4 } };
  const first = runQuery(compileQuery(SCHEMA, "project", spec), RECORDS);
  assert.deepEqual(first.items.map((row) => row.id), ["p0", "p1", "p2", "p3"]);
  assert.equal(first.count, 9);
  const second = runQuery(compileQuery(SCHEMA, "project", { ...spec, page: { size: 4, cursor: first.nextCursor } }), RECORDS);
  assert.deepEqual(second.items.map((row) => row.id), ["p4", "p5", "p6", "p7"], "the tied created_at row is neither skipped nor repeated");
  const third = runQuery(compileQuery(SCHEMA, "project", { ...spec, page: { size: 4, cursor: second.nextCursor } }), RECORDS);
  assert.deepEqual([third.items.map((row) => row.id), third.nextCursor], [["p8"], null]);
  const cursor = decodeCursor(first.nextCursor, compileQuery(SCHEMA, "project", spec).key);
  assert.deepEqual(cursor, { sortValue: RECORDS[3].createdAt, id: "p3" });
  assert.throws(() => compileQuery(SCHEMA, "project", { filters: { status: "draft" }, page: { cursor: first.nextCursor } }), (error) => error.code === "query_cursor_mismatch", "a cursor cannot continue another query");
  assert.throws(() => compileQuery(SCHEMA, "project", { page: { cursor: "nonsense" } }), (error) => error.code === "query_cursor_invalid");
  assert.equal(encodeCursor(compileQuery(SCHEMA, "project", spec), null), null);
  // The same predicate, client and server: filtering only a fetched page is impossible by construction.
  const active = compileQuery(SCHEMA, "project", { filters: { status: "active", budget: { gte: 30 } } });
  assert.deepEqual(RECORDS.filter((row) => matchesQuery(active, row)).map((row) => row.id), ["p3", "p5", "p7"]);
});

test("WP7 — the SDK executes the specification server-side: operator filters, count with operators, and a composite cursor", async () => {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: decodeURIComponent(String(url)), method: init.method, headers: init.headers });
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "u1" }), { status: 200, headers: { "Content-Type": "application/json" } });
    return new Response("[]", { status: 200, headers: { "Content-Type": "application/json", "Content-Range": "0-0/7" } });
  };
  const backend = createSupabaseBackend({ url: "https://x.supabase.co", anonKey: "anon", fetchImpl });
  const store = backend.db.entity("project");
  await store.list({ filters: { budget: { gte: 20 }, status: { in: ["draft", "active"] } }, order: "created_at", ascending: true, limit: 4, cursor: { createdAt: "2026-09-13T00:00:00Z", id: "p3" } });
  const list = requests.find((request) => request.method === "GET" && request.url.includes("/rest/v1/entities"));
  assert.match(list.url, /data->>budget=gte\.20/);
  assert.match(list.url, /data->>status=in\.\(draft,active\)/);
  assert.match(list.url, /or=\(created_at\.gt\.2026-09-13T00:00:00Z,and\(created_at\.eq\.2026-09-13T00:00:00Z,id\.gt\.p3\)\)/, "the composite cursor is a keyset condition with the id tie-breaker");
  assert.match(list.url, /order=created_at\.asc,id\.asc/);
  const count = await store.count({ budget: { gte: 20 }, status: "active" });
  const head = requests.filter((request) => request.method === "HEAD" || /select=id/.test(request.url)).at(-1);
  assert.match(head.url, /data->>budget=gte\.20/, "count applies the same operator filters as list");
  assert.equal(count, 7);
});

test("WP7 — the collection controller drives filter/search/clear/more against the repository, never a fetched page", async () => {
  const rows = RECORDS.map((row) => ({ id: row.id, type: "project", data: { ...row.values, __meta: { version: 1, createdAt: row.createdAt, updatedAt: row.createdAt } }, created_at: row.createdAt }));
  const calls = [];
  const db = { entity: () => ({
    async list(options) {
      calls.push(["list", options]);
      const filtered = rows.filter((row) => Object.entries(options.filters).every(([field, clauses]) => Object.entries(clauses).every(([op, value]) => (
        op === "eq" ? row.data[field] === value : op === "gte" ? row.data[field] >= value : op === "ilike" ? String(row.data[field]).toLowerCase().includes(String(value).replace(/%/g, "").toLowerCase()) : true))));
      const sorted = filtered.sort((a, b) => (options.ascending ? 1 : -1) * (a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)));
      const start = options.cursor ? sorted.findIndex((row) => row.created_at === options.cursor.createdAt && row.id === options.cursor.id) + 1 : 0;
      return sorted.slice(start, start + options.limit);
    },
    async count(filters) { calls.push(["count", filters]); return rows.filter((row) => Object.entries(filters).every(([field, clauses]) => Object.entries(clauses).every(([op, value]) => (op === "eq" ? row.data[field] === value : op === "gte" ? row.data[field] >= value : true)))).length; },
    async get(id) { const row = rows.find((candidate) => candidate.id === id); if (!row) throw new Error("no rows"); return row; },
    subscribe() { return () => {}; },
  }) };
  const repository = createEntityRepository({ db, schema: SCHEMA, entity: "project" });
  const collection = createCollection({ repository, schema: SCHEMA, entity: "project", initialQuery: { sort: { field: "created_at", direction: "asc" }, page: { size: 4 } } });
  await collection.load();
  assert.deepEqual([collection.getState().status, collection.getState().items.map((row) => row.id), collection.getState().count], ["ready", ["p0", "p1", "p2", "p3"], 9]);
  await collection.more();
  assert.deepEqual(collection.getState().items.map((row) => row.id), ["p0", "p1", "p2", "p3", "p4", "p5", "p6", "p7"]);
  await collection.filter({ status: "active", budget: { gte: 30 } });
  assert.deepEqual(collection.getState().items.map((row) => row.id), ["p3", "p5", "p7"], "the backend ran the predicate over ALL rows, not the loaded page");
  assert.equal(collection.getState().count, 3);
  assert.equal(calls.filter(([kind]) => kind === "list").at(-1)[1].filters.status.eq, "active");
  await collection.search("project 8", ["name"]);
  assert.deepEqual(collection.getState().items.map((row) => row.id), [], "search composes with the active filters");
  assert.equal(collection.getState().status, "empty");
  await collection.clear();
  assert.equal(collection.getState().items.length, 4);
  await collection.filter({ nope: 1 });
  assert.deepEqual([collection.getState().status, collection.getState().error.code], ["error", "query_field_not_allowed"]);
  // A superseded load never overwrites a newer one.
  const slowDb = { entity: () => ({ async list(options) { await new Promise((resolve) => setTimeout(resolve, options.filters.status ? 0 : 30)); return db.entity().list(options); }, async count(filters) { return db.entity().count(filters); }, subscribe() { return () => {}; } }) };
  const racing = createCollection({ repository: createEntityRepository({ db: slowDb, schema: SCHEMA, entity: "project" }), schema: SCHEMA, entity: "project", initialQuery: { page: { size: 4 } } });
  const slow = racing.load();
  await racing.filter({ status: "draft" });
  await slow;
  assert.ok(racing.getState().items.every((row) => row.values.status === "draft"));
});

test("WP7 — the form runtime coerces, validates from the schema plus custom rules, and submits once", async () => {
  const submitted = [];
  const form = createForm({ schema: SCHEMA, entity: "project", initialValues: { name: "", budget: "", status: "draft" },
    validate: (values) => (values.name === "Forbidden" ? [{ field: "name", message: "that name is taken" }] : []),
    submit: async (values) => { submitted.push(values); await new Promise((resolve) => setTimeout(resolve, 5)); return { id: "p-new", values }; } });
  assert.equal(coerceFieldValue({ type: "integer" }, "12.9"), 12);
  assert.equal(coerceFieldValue({ type: "boolean" }, "on"), true);
  form.setValue("budget", "150");
  assert.equal(form.getState().values.budget, 150, "a string from an input becomes the typed value; onChange never sees an event");
  assert.deepEqual(await form.submit(), { ok: false, errors: { name: "name is required" } });
  assert.equal(form.getState().status, "invalid");
  assert.equal(submitted.length, 0, "invalid values never reach the operation");
  form.setValue("name", "Forbidden");
  assert.equal(form.getState().errors.name, "that name is taken", "after a submit attempt, edits re-validate live");
  form.setValue("name", "Showroom");
  form.setValue("budget", "-1");
  assert.equal((await form.submit()).errors.budget, "budget must be at least 0");
  form.setValue("budget", "20");
  const [first, second] = await Promise.all([form.submit(), form.submit()]);
  assert.equal(first.ok && second.ok, true);
  assert.equal(form.getState().status, "submitted");
  assert.equal(form.getState().result.values.name, "Showroom");
  assert.equal(form.getState().dirty, false);
  form.setValue("notes", "x");
  assert.equal(form.getState().status, "idle", "editing after a submission is a new draft");
  form.reset();
  assert.deepEqual([form.getState().values, form.getState().errors, form.getState().submitCount], [{ name: "", budget: "", status: "draft" }, {}, 0]);
  assert.throws(() => form.setValue("nope", 1), /no field nope/);
});

test("WP7 — resources cancel superseded loads; mutations apply optimistically and roll back on failure; caches invalidate by key", async () => {
  const resource = createResource({ key: "projects" });
  const slow = resource.load(() => new Promise((resolve) => setTimeout(() => resolve(["stale"]), 30)));
  await resource.load(async () => ["fresh"]);
  const outcome = await slow;
  assert.deepEqual([outcome.superseded, resource.getState().status, resource.getState().data], [true, "ready", ["fresh"]]);
  await resource.load(async () => []);
  assert.equal(resource.getState().status, "empty");
  await resource.load(async () => { throw Object.assign(new Error("offline"), { code: "backend_unavailable" }); });
  assert.deepEqual([resource.getState().status, resource.getState().error.code], ["error", "backend_unavailable"]);
  await resource.load(async () => ["a"]);
  const failing = createMutation({ operation: async () => { throw Object.assign(new Error("conflict"), { code: "version_conflict" }); }, optimistic: (data, input) => [...data, input], resource });
  await assert.rejects(failing.run("b"));
  assert.deepEqual(resource.getState().data, ["a"], "the optimistic patch was rolled back");
  assert.deepEqual([failing.getState().status, failing.getState().error.code, failing.getState().attempts], ["error", "version_conflict", 1]);
  const cache = createResourceCache();
  const list = cache.resource("project:list");
  await list.load(async () => ["x"]);
  const winning = createMutation({ operation: async (input) => ({ ok: input }), optimistic: (data, input) => [...(data || []), input], resource, invalidates: [list] });
  await winning.run("b");
  assert.deepEqual([resource.getState().data, winning.getState().status, list.getState().status], [["a", "b"], "success", "idle"], "success keeps the optimistic result and invalidates dependants");
  assert.equal(cache.resource("project:list"), list, "one resource per key");
  cache.invalidate("project:");
  assert.equal(list.getState().loadedAt, null);
});

test("WP7 — the facade exposes useCollection/useForm/useResource/useMutation; the old scaffold hook names keep working", () => {
  const contract = {
    summary: "Projects", projectType: "tool", version: 2, auth: { required: true, rules: [] },
    routes: [{ path: "/signin", name: "Sign in" }, { path: "/projects", name: "Projects", auth: true }],
    entities: [{ name: "project", owned: true, fields: [{ name: "name", type: "string", required: true }, { name: "status", options: ["draft", "active"] }] }],
    operations: [
      { id: "sign-in", kind: "signIn", journey: "plan", description: "sign in", responsibilities: [{ type: "functional", capability: "session", capabilityMethod: "signIn", behavior: "session", reads: ["authEmail", "authPassword"], writes: [] }] },
      { id: "create-project", entity: "project", kind: "create", journey: "plan", description: "create", responsibilities: [{ type: "persistence", capability: "crud", capabilityMethod: "create", reads: ["name"], writes: ["name"] }] },
      { id: "search-projects", entity: "project", kind: "search", journey: "plan", description: "search projects by name", responsibilities: [{ type: "persistence", capability: "crud", capabilityMethod: "list", reads: ["name"], writes: [] }] },
    ],
    journeys: [{ id: "plan", title: "Plan", priority: "primary", stage: "primary_journey", steps: [
      { action: "open sign in", target: "/signin", expect: "panel" },
      { action: "sign in", target: "authentication form", operates: ["authEmail", "authPassword", "sign-in"], expect: "projects" },
      { action: "create a project", target: "form", operates: ["name", "create-project"], expect: "listed" },
      { action: "search projects", target: "search", operates: ["name", "search-projects"], verificationValues: { name: "Show" }, expect: "the matching project is listed" },
    ], acceptance: ["x"] }],
    acceptance: [{ id: "a1", statement: "a", journey: "plan", kind: "behavior" }, { id: "a2", statement: "b", journey: "plan", kind: "behavior" }, { id: "a3", statement: "c", journey: "plan", kind: "behavior" }],
    states: [], integrations: [], deferred: [],
  };
  const spec = deriveBuildSpec(contract);
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join(" | "));
  for (const id of ["thrallo.query", "thrallo.forms", "thrallo.async"]) assert.ok(spec.moduleResolution.modules.some((row) => row.id === id), `${id} resolved`);
  const composed = composeCapabilityFoundation(REACT_VITE, spec.capabilityGraph, { moduleLock: spec.moduleLock, identityPlan: spec.identityPlan, entitySchema: spec.entitySchema, routePlan: spec.routePlan });
  const facade = composed.tree[APP_FACADE_ENTITIES_PATH];
  for (const name of ["useCollection", "useForm", "useResource", "useMutation", "createCollection", "createForm"]) assert.match(facade, new RegExp(`export (?:function|const) ${name}\\b`), name);
  assert.match(facade, /queryableFields/);
  const primitives = renderScaffoldFoundation({ screens: [], routes: [], families: [] }).protectedFiles[SCAFFOLD_PRIMITIVES_PATH];
  for (const name of ["useFormState", "useResourceState", "useCatalogueState", "useWorkflowState"]) assert.match(primitives, new RegExp(`export function ${name}\\b`), `${name} retained for migrated screens`);
  assert.deepEqual(validateModuleRegistry(), { ok: true, problems: [] });
  assert.ok(moduleManifest("thrallo.query").provides.operations.some((row) => row.id === "query" && row.effect === "query"));
});

test("WP7 — the static gate reports query bindings on undeclared fields", () => {
  const spec = deriveBuildSpec({
    summary: "Projects", version: 2, auth: { required: false, rules: [] }, routes: [{ path: "/", name: "Home" }],
    entities: [{ name: "project", fields: [{ name: "name" }, { name: "status" }] }],
    operations: [{ id: "list-projects", entity: "project", kind: "list", journey: "browse", description: "list" }],
    journeys: [{ id: "browse", title: "Browse", priority: "primary", steps: [{ action: "open the list", target: "/", expect: "list" }, { action: "search projects", operates: ["name", "list-projects"], verificationValues: { name: "x" }, expect: "results" }] }],
    acceptance: [{ id: "a", statement: "x", journey: "browse", kind: "behavior" }, { id: "b", statement: "y", journey: "browse", kind: "behavior" }, { id: "c", statement: "z", journey: "browse", kind: "behavior" }],
  });
  const tree = {
    "src/lib/capabilities/composed/entities.js": "// composed\n",
    "src/screens/scaffold/HomeScreen.jsx": `import { useCollection } from "../../lib/app/index.js";
export default function Home() { const projects = useCollection("project", { filters: { owner: "me", status: "draft" } }); return null; }
`,
    "src/screens/scaffold/Other.jsx": `import { useCollection } from "../../lib/app/index.js";
export default function Other() { const c = useCollection("project"); return <button onClick={() => c.filter({ name: { ilike: "%x%" }, secret: 1 })} />; }
`,
  };
  const findings = lintQueryBindings(tree, { entitySchema: spec.entitySchema }).findings;
  assert.deepEqual(findings.map((row) => [row.module, row.field]), [["src/screens/scaffold/HomeScreen.jsx", "owner"], ["src/screens/scaffold/Other.jsx", "secret"]]);
  assert.equal(findings[0].code, "query_field_not_declared");
  assert.equal(severityOf("query_field_not_declared"), "advisory");
});
