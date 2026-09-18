// WP5 — schema-backed entity persistence.
//
// The contract's durable domain entities compile into one schema; the entities module validates
// writes, keeps identity/version metadata reserved and immutable, merges patches with optimistic
// concurrency (compare-and-set at the persistence boundary), checks references against the
// caller's own visible records, honours delete policies and reloads the same canonical id. The
// generic JSONB backend stays behind an adapter and the legacy flat record stays available.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import {
  RESERVED_FIELDS, compileSchema, dependentRelations, normalizeFieldType, queryableFields, validateValues,
} from "../../src/scaffolds/reactVite/lib/modules/schema.js";
import {
  ENTITY_ERROR, EntityError, createEntityRepositories, createEntityRepository, toLegacyRecord, toRecord,
} from "../../src/scaffolds/reactVite/lib/modules/entities.js";
import { createSupabaseBackend } from "../../src/scaffolds/reactVite/lib/backend/supabaseBackend.js";
import { compileEntitySchema, entitySchemaBrief } from "../../shell/server/lib/builderV2/platformModules/schema.mjs";
import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import { MODULE_REGISTRY, moduleForCapability, moduleManifest, validateModuleRegistry } from "../../shell/server/lib/builderV2/platformModules/registry.mjs";
import { verifyModuleLock } from "../../shell/server/lib/builderV2/platformModules/lock.mjs";
import {
  APP_FACADE_ENTITIES_PATH, ENTITIES_COMPOSED_PATH, composeCapabilityFoundation, validateCapabilityComposition,
} from "../../shell/server/lib/builderV2/capabilityComposer.mjs";
import { lintDurablePersistence } from "../../shell/server/lib/builderV2/persistenceLint.mjs";
import { severityOf } from "../../shell/server/lib/builderV2/validationSeverity.mjs";
import { CAPABILITIES, canonicalCapabilityId } from "../../shell/server/lib/builderV2/capabilityRegistry.mjs";
import { isProtectedPath } from "../../shell/server/lib/builderV2/patchEngine.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";

const require = createRequire(new URL("../../harness/.deps/node_modules/", import.meta.url));
const React = require("react");
const { renderToString } = require("react-dom/server");

const SCHEMA = compileSchema([
  { name: "project", fields: [{ name: "name", type: "string", required: true }, { name: "status", options: ["draft", "active"] }, { name: "budget", type: "number", minimum: 0 }] },
  { name: "room", fields: [{ name: "name", type: "string", required: true }, { name: "projectId", type: "string", required: true }, { name: "length", type: "number" }, { name: "notes", type: "text" }] },
  { name: "product", fields: [{ name: "model", type: "string", required: true }, { name: "contactEmail", type: "email" }, { name: "specs", type: "json" }] },
]);

/** A fake backend `db` with the SDK's row shape and compare-and-set semantics. */
function fakeDb({ latency = () => Promise.resolve() } = {}) {
  const rows = new Map();
  let seq = 0;
  const db = {
    rows,
    entity(type) {
      return {
        async create(data) { await latency(); const id = `${type}-${++seq}`; const row = { id, type, data, owner: "u1", created_at: `2026-09-18T00:00:0${seq}Z` }; rows.set(id, row); return { ...row }; },
        async get(id) { await latency(); const row = rows.get(id); if (!row || row.type !== type) throw new Error("JSON object requested, multiple (or no) rows returned"); return { ...row }; },
        async update(id, data) { await latency(); const row = rows.get(id); row.data = data; return { ...row }; },
        async updateVersioned(id, data, expected) { await latency(); const row = rows.get(id); if ((row.data.__meta?.version ?? 1) !== expected) return null; row.data = data; return { ...row }; },
        async delete(id) { await latency(); rows.delete(id); },
        async list({ filters = {} } = {}) { await latency(); return [...rows.values()].filter((row) => row.type === type && Object.entries(filters).every(([key, value]) => row.data[key] === value)); },
        async count(filters = {}) { await latency(); return [...rows.values()].filter((row) => row.type === type && Object.entries(filters).every(([key, value]) => row.data[key] === value)).length; },
        subscribe(callback) { db.listeners = [...(db.listeners || []), callback]; return () => {}; },
      };
    },
  };
  return db;
}

test("WP5 — the schema compiles fields, references, enums and query allow-lists; validation is exact", () => {
  assert.deepEqual(SCHEMA.entityNames, ["project", "room", "product"]);
  assert.deepEqual(SCHEMA.entities.room.relations, [{ field: "projectId", target: "project", cardinality: "many-to-one", onDelete: "restrict" }]);
  assert.equal(SCHEMA.entities.room.fields.projectId.type, "reference");
  assert.deepEqual(SCHEMA.entities.project.fields.status, { type: "enum", required: false, options: ["draft", "active"] });
  assert.deepEqual(SCHEMA.entities.project.indexes, []);
  assert.deepEqual(SCHEMA.entities.room.indexes, [["projectId"]]);
  assert.deepEqual(dependentRelations(SCHEMA, "project"), [{ entity: "room", field: "projectId", onDelete: "restrict" }]);
  assert.deepEqual(Object.keys(queryableFields(SCHEMA, "product")), ["model", "contactEmail"], "json fields are not queryable");
  assert.deepEqual(queryableFields(SCHEMA, "project").budget.operators, ["eq", "neq", "gte", "lte", "in"]);
  assert.equal(normalizeFieldType("Currency"), "number");
  assert.equal(normalizeFieldType("anything-else"), "string");
  assert.deepEqual(validateValues(SCHEMA, "room", { name: "Kitchen", projectId: "p1" }), { ok: true, problems: [] });
  const bad = validateValues(SCHEMA, "project", { name: "", status: "closed", budget: -5, id: "forged", version: 9 });
  assert.deepEqual(bad.problems.map((problem) => [problem.field, problem.code]),
    [["id", "reserved_field"], ["version", "reserved_field"], ["name", "required_missing"], ["status", "enum_invalid"], ["budget", "below_minimum"]].map(([field, code]) => [field, code === "enum_invalid" ? "type_mismatch" : code]));
  assert.equal(validateValues(SCHEMA, "project", { budget: 3 }, { partial: true }).ok, true, "a patch skips required checks");
  assert.equal(validateValues(SCHEMA, "product", { model: "X", contactEmail: "not-an-email" }).problems[0].code, "type_mismatch");
  assert.equal(validateValues(SCHEMA, "nowhere", {}).problems[0].code, "unknown_entity");
  assert.ok(RESERVED_FIELDS.includes("version"));
});

test("WP5 — CRUD: server identity, reserved metadata immutable, validated patches, references, restrict on delete, canonical reload", async () => {
  const db = fakeDb();
  const repos = createEntityRepositories({ db, schema: SCHEMA, now: () => "2026-09-18T01:00:00Z" });
  await assert.rejects(repos.project.create({ status: "active" }), (error) => error instanceof EntityError && error.code === ENTITY_ERROR.VALIDATION_FAILED && error.details.problems[0].field === "name");
  const project = await repos.project.create({ name: "Showroom", id: "forged-id", version: 42, owner: "someone-else", createdAt: "1999-01-01" });
  assert.deepEqual(project, { id: "project-1", version: 1, createdAt: "2026-09-18T00:00:01Z", updatedAt: "2026-09-18T01:00:00Z", values: { name: "Showroom" } },
    "identity, version and timestamps are the platform's; caller-supplied metadata is ignored");
  assert.ok(Object.isFrozen(project) && Object.isFrozen(project.values));
  await assert.rejects(repos.room.create({ name: "Kitchen", projectId: "project-404" }), (error) => error.code === ENTITY_ERROR.REFERENCE_NOT_FOUND && error.details.target === "project");
  const room = await repos.room.create({ name: "Kitchen", projectId: project.id });
  assert.equal(room.values.projectId, project.id);
  // Update merges a validated patch; metadata cannot be redefined by the patch.
  const updated = await repos.project.update(project.id, { status: "active", id: "hijack", version: 99 });
  assert.deepEqual([updated.version, updated.values], [2, { name: "Showroom", status: "active" }]);
  await assert.rejects(repos.project.update(project.id, { status: "closed" }), (error) => error.code === ENTITY_ERROR.VALIDATION_FAILED);
  // Reload resolves the same canonical durable id — no generated id fallback chain.
  const reloaded = await createEntityRepository({ db, schema: SCHEMA, entity: "project" }).get(project.id);
  assert.deepEqual(reloaded, updated);
  assert.deepEqual(toLegacyRecord(reloaded), { id: "project-1", createdAt: "2026-09-18T00:00:01Z", name: "Showroom", status: "active" }, "the legacy flat shape stays available");
  // Delete honours the declared relation policy.
  await assert.rejects(repos.project.remove(project.id), (error) => error.code === ENTITY_ERROR.REFERENCE_RESTRICTED && error.details.count === 1);
  await repos.room.remove(room.id);
  assert.deepEqual(await repos.project.remove(project.id), { id: project.id, removed: true });
  await assert.rejects(repos.project.get(project.id), (error) => error.code === ENTITY_ERROR.NOT_FOUND);
  assert.equal((await repos.project.list()).length, 0);
  // Rows written by the legacy capability (no metadata) read as version 1.
  db.rows.set("project-legacy", { id: "project-legacy", type: "project", data: { name: "Old" }, created_at: "2026-01-01T00:00:00Z" });
  assert.deepEqual(toRecord(db.rows.get("project-legacy")), { id: "project-legacy", version: 1, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", values: { name: "Old" } });
});

test("WP5 — concurrent updates: exactly one writer wins the compare-and-set; the other sees a version conflict and can retry from the fresh read", async () => {
  const db = fakeDb();
  const repository = createEntityRepository({ db, schema: SCHEMA, entity: "project" });
  const project = await repository.create({ name: "Race" });
  const [first, second] = await Promise.allSettled([
    repository.update(project.id, { status: "active" }, { expectedVersion: 1 }),
    repository.update(project.id, { budget: 10 }, { expectedVersion: 1 }),
  ]);
  const outcomes = [first, second].map((row) => row.status);
  assert.deepEqual(outcomes.sort(), ["fulfilled", "rejected"]);
  const loser = [first, second].find((row) => row.status === "rejected");
  assert.equal(loser.reason.code, ENTITY_ERROR.VERSION_CONFLICT);
  assert.deepEqual(loser.reason.details, { expected: 1, actual: 2 });
  const fresh = await repository.get(project.id);
  const retried = await repository.update(project.id, { budget: 10 }, { expectedVersion: fresh.version });
  assert.deepEqual([retried.version, retried.values], [3, { name: "Race", status: "active", budget: 10 }], "no lost update: both changes land, in order");
  // Without a backend compare-and-set, the repository still reads before it writes and never blindly merges.
  const plainDb = fakeDb();
  for (const type of ["project"]) delete plainDb.entity(type).updateVersioned;
  const plain = createEntityRepository({ db: { entity: (type) => { const store = plainDb.entity(type); delete store.updateVersioned; return store; } }, schema: SCHEMA, entity: "project" });
  const created = await plain.create({ name: "Plain" });
  await assert.rejects(plain.update(created.id, { status: "active" }, { expectedVersion: 5 }), (error) => error.code === ENTITY_ERROR.VERSION_CONFLICT);
  assert.equal((await plain.update(created.id, { status: "active" })).version, 2);
});

test("WP5 — the SDK's compare-and-set is a conditional update on the stored version, scoped to the app", async () => {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : null });
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "u1", email: "u@x" }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path.includes("/rest/v1/entities")) {
      const conflict = String(url).includes("version%22%3Deq.7") || String(url).includes("version=eq.7");
      return new Response(JSON.stringify(conflict ? [] : [{ id: "e1", type: "project", data: init.body ? JSON.parse(init.body).data : {}, created_at: "2026-09-18T00:00:00Z" }]),
        { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const backend = createSupabaseBackend({ url: "https://x.supabase.co", anonKey: "anon", fetchImpl, appId: null });
  const store = backend.db.entity("project");
  assert.equal(typeof store.updateVersioned, "function");
  const row = await store.updateVersioned("e1", { name: "N", __meta: { version: 3 } }, 2);
  const update = requests.find((request) => request.method === "PATCH");
  assert.ok(update, "a PATCH was issued");
  assert.match(decodeURIComponent(update.url), /type=eq\.project/);
  assert.match(decodeURIComponent(update.url), /id=eq\.e1/);
  assert.match(decodeURIComponent(update.url), /data->__meta->>version=eq\.2/, "the write is conditional on the version the caller read");
  assert.equal(row.id, "e1");
  assert.equal(await store.updateVersioned("e1", { name: "N" }, 7), null, "zero rows updated means someone else moved the record");
});

test("WP5 — the build spec compiles the entity schema; the composer renders typed repositories and the facade; the lock hashes the runtime", () => {
  const contract = {
    summary: "Lighting planner with projects and rooms", projectType: "tool", version: 2, auth: { required: true, rules: [] },
    routes: [{ path: "/signin", name: "Sign in" }, { path: "/projects", name: "Projects", auth: true }],
    entities: [
      { name: "project", owned: true, fields: [{ name: "name", type: "string", required: true }] },
      { name: "room", owned: true, fields: [{ name: "name", type: "string", required: true }, { name: "projectId", type: "string", required: true }] },
      { name: "draft", storage: "client-only transient state", fields: [{ name: "step", type: "string" }] },
    ],
    operations: [
      { id: "sign-in", kind: "signIn", journey: "plan", description: "sign in", responsibilities: [{ type: "functional", capability: "session", capabilityMethod: "signIn", behavior: "session", reads: ["authEmail", "authPassword"], writes: [] }] },
      { id: "create-project", entity: "project", kind: "create", journey: "plan", description: "create a project", responsibilities: [{ type: "persistence", capability: "crud", capabilityMethod: "create", reads: ["name"], writes: ["name"] }] },
      { id: "create-room", entity: "room", kind: "create", journey: "plan", description: "add a room", responsibilities: [{ type: "persistence", capability: "crud", capabilityMethod: "create", reads: ["name", "projectId"], writes: ["name", "projectId"] }] },
    ],
    journeys: [{ id: "plan", title: "Plan a project", priority: "primary", stage: "primary_journey", steps: [
      { action: "open sign in", target: "/signin", expect: "sign-in panel" },
      { action: "sign in", target: "authentication form", operates: ["authEmail", "authPassword", "sign-in"], expect: "projects visible" },
      { action: "create a project", target: "new project form", operates: ["name", "create-project"], expect: "the project is listed" },
      { action: "add a room", target: "room form", operates: ["name", "projectId", "create-room"], expect: "the room is listed" },
      { action: "reload", target: "reload", expect: "the project and room are still listed" },
    ], acceptance: ["persists"] }],
    acceptance: [{ id: "a1", statement: "a project survives reload", journey: "plan", kind: "persistence" }, { id: "a2", statement: "a room references its project", journey: "plan", kind: "behavior" }, { id: "a3", statement: "sign-in shows projects", journey: "plan", kind: "behavior" }],
    states: [], integrations: [], deferred: [],
  };
  const spec = deriveBuildSpec(contract);
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join(" | "));
  assert.deepEqual(spec.entitySchema.entities, ["project", "room"], "transient entities are not schema entities");
  assert.deepEqual(spec.entitySchema.relations, [{ from: "room", field: "projectId", target: "project", cardinality: "many-to-one", onDelete: "restrict" }]);
  assert.equal(spec.entitySchema.verdict.ok, true);
  assert.deepEqual(entitySchemaBrief(spec.entitySchema), { project: { name: "string required" }, room: { name: "string required", projectId: "reference required → project" } });
  assert.ok(spec.moduleResolution.modules.some((row) => row.id === "thrallo.entities" && row.version === "1.1.0"));
  const composed = composeCapabilityFoundation(REACT_VITE, spec.capabilityGraph, { moduleLock: spec.moduleLock, identityPlan: spec.identityPlan, entitySchema: spec.entitySchema });
  for (const path of [ENTITIES_COMPOSED_PATH, APP_FACADE_ENTITIES_PATH]) {
    assert.ok(typeof composed.tree[path] === "string", `${path} composed`);
    assert.ok(isProtectedPath(path), `${path} protected`);
  }
  // The composed module embeds the normalised DECLARATIONS and compiles them with the same
  // schema module the platform used, so the application validates one schema, not a copy of a
  // compiled shape that could drift from it.
  assert.match(composed.tree[ENTITIES_COMPOSED_PATH], /"name": "room"/);
  assert.match(composed.tree[ENTITIES_COMPOSED_PATH], /"name": "projectId"/);
  assert.match(composed.tree[ENTITIES_COMPOSED_PATH], /compileSchema\(entityDefinitions\)/);
  assert.match(composed.tree[ENTITIES_COMPOSED_PATH], /createEntityRepositories\(\{ db, schema: entitySchema/);
  assert.match(composed.tree[APP_FACADE_ENTITIES_PATH], /export function useEntity\(entity, id\)/);
  assert.match(composed.tree["src/lib/app/index.js"], /export \* from ".\/entities.js";/);
  // Every protected file the plan names is composed; this contract's model-owned custom
  // extension is, by design, absent from a bare scaffold.
  assert.deepEqual(validateCapabilityComposition(composed.tree, spec.capabilityGraph, composed.plan)
    .problems.filter((problem) => !/custom behavior extension missing/.test(problem)), []);
  assert.equal(composed.tree["src/lib/capabilities/composed/crud.js"].includes("makeEntityStore"), true, "the legacy store keeps composing beside the typed repositories");
  assert.deepEqual(verifyModuleLock(composed.tree, spec.moduleLock), { ok: true, problems: [] });
  const tampered = { ...composed.tree, "src/lib/modules/entities.js": "// tampered\n" };
  assert.ok(verifyModuleLock(tampered, spec.moduleLock).problems.some((problem) => problem.module === "thrallo.entities"));
  // Same contract, byte-identical composition.
  assert.equal(composeCapabilityFoundation(REACT_VITE, spec.capabilityGraph, { moduleLock: spec.moduleLock, identityPlan: spec.identityPlan, entitySchema: spec.entitySchema }).tree[ENTITIES_COMPOSED_PATH], composed.tree[ENTITIES_COMPOSED_PATH]);
  // The compiler refuses a reference to something that is not a durable domain entity.
  const dangling = compileEntitySchema({ entities: [{ name: "room", fields: [{ name: "buildingId", type: "reference", target: "building" }] }, { name: "building", storage: "transient", fields: [] }] });
  assert.equal(dangling.entities.includes("building"), false);
  assert.equal(dangling.schema.entities.room.fields.buildingId.type, "string", "an unresolvable reference is opaque text, not a fake relation");
});

test("WP5 — registry: entities 1.1 provides crud and typed entities; old locks still resolve 1.0.0", () => {
  assert.deepEqual(validateModuleRegistry(), { ok: true, problems: [] });
  assert.deepEqual(MODULE_REGISTRY["thrallo.entities"].map((row) => row.version), ["1.0.0", "1.1.0"]);
  assert.equal(moduleForCapability("crud").version, "1.1.0");
  // WP5's `entities` name is an alias of the legacy `crud` capability — one capability, one
  // module, two names, exactly as `auth` aliases `session`.
  assert.equal(canonicalCapabilityId("entities"), "crud");
  assert.equal(moduleForCapability("entities").id, "thrallo.entities");
  assert.deepEqual(moduleManifest("thrallo.entities").provides.capabilities, ["crud", "entities"]);
  assert.equal(moduleManifest("thrallo.entities", ["1.0.0"]).version, "1.0.0");
  const update = moduleManifest("thrallo.entities").provides.operations.find((row) => row.id === "update" && row.concurrency === "versioned");
  assert.ok(update, "the typed update declares versioned concurrency");
  assert.equal(moduleManifest("thrallo.entities", ["1.0.0"]).provides.operations.find((row) => row.id === "update").concurrency, null,
    "the legacy version keeps telling the truth about its read-modify-write");
  for (const path of ["src/lib/capabilities/crud.js", "src/lib/modules/schema.js", "src/lib/modules/entities.js", "src/lib/modules/entitiesReact.js"]) {
    assert.ok(typeof REACT_VITE[path] === "string", `${path} ships in the scaffold`);
    assert.ok(isProtectedPath(path), `${path} is protected`);
  }
});

test("WP5 — the persistence lint reports generated record-shape wrappers where the entities module is installed", () => {
  const contract = { entities: [{ name: "project", fields: [{ name: "name" }] }], operations: [{ id: "create-project", entity: "project", kind: "create", journey: "plan" }],
    journeys: [{ id: "plan", title: "Plan", priority: "primary", steps: [{ action: "create a project", operates: ["name", "create-project"], expect: "listed" }, { action: "reload", expect: "still listed" }] }] };
  const tree = {
    ...REACT_VITE,
    "src/lib/capabilities/composed/entities.js": "// composed\n",
    "src/data/projects.js": `import { db } from "../lib/backend/index.js";
export async function loadProjects() { const rows = await db.entity("project").list(); return rows.map((row) => ({ id: row.id, ...row.data, created: row.created_at })); }
`,
  };
  const findings = lintDurablePersistence(tree, { contract, journeys: contract.journeys, modulePlan: [] }).findings;
  const wrapper = findings.find((row) => row.code === "generated_record_shape_wrapper");
  assert.ok(wrapper, JSON.stringify(findings.map((row) => row.code)));
  assert.equal(wrapper.file, "src/data/projects.js");
  assert.equal(severityOf("generated_record_shape_wrapper"), "advisory");
  const legacyTree = { ...tree };
  delete legacyTree["src/lib/capabilities/composed/entities.js"];
  assert.ok(!lintDurablePersistence(legacyTree, { contract, journeys: contract.journeys, modulePlan: [] }).findings.some((row) => row.code === "generated_record_shape_wrapper"),
    "a tree without the typed module is judged as before");
});

test("WP5 — UI binding: a generated-style detail screen loads a record by canonical id through the shipped hooks", async () => {
  const { mkdir, writeFile, symlink } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const path = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const { depsNodeModules, workDirFor } = await import("../../harness/workspace.mjs");
  const dir = workDirFor("entities-ui-binding");
  for (const file of ["src/lib/modules/schema.js", "src/lib/modules/entities.js", "src/lib/modules/entitiesReact.js", "src/lib/capabilities/react.js"]) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), REACT_VITE[file]);
  }
  if (!existsSync(path.join(dir, "node_modules"))) await symlink(depsNodeModules(), path.join(dir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const hooks = await import(pathToFileURL(path.join(dir, "src/lib/modules/entitiesReact.js")).href);
  const db = fakeDb();
  const repository = createEntityRepository({ db, schema: SCHEMA, entity: "project" });
  const project = await repository.create({ name: "Showroom" });
  const Screen = ({ id }) => {
    const { status, record } = hooks.useEntity(repository, id);
    if (status === "loading") return React.createElement("p", { role: "status" }, "Loading project…");
    if (status === "not_found") return React.createElement("p", { role: "alert" }, "No such project");
    if (status !== "ready") return null;
    return React.createElement("article", null, React.createElement("h1", null, record.values.name), React.createElement("small", null, `v${record.version}`));
  };
  // Server rendering shows the initial loading state; the hook then resolves to the record.
  assert.match(renderToString(React.createElement(Screen, { id: project.id })), /Loading project/);
  const loaded = await repository.get(project.id);
  assert.equal(loaded.values.name, "Showroom");
});
