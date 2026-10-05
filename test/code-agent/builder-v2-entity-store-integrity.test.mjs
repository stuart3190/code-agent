// Entity/store integrity — advisory mount check for every durable entity.
//
// A durable entity has to be declared in the composed schema or entityStores, and some module
// the running application can actually load has to call its facade or store. The finding is
// advisory until the false-rejection corpus reports none of them.

import test from "node:test";
import assert from "node:assert/strict";

import {
  lintEntityStoreIntegrity, runStaticApplicationGate,
} from "../../shell/server/lib/builderV2/staticApplicationGate.mjs";
import { reachableSourcePaths } from "../../shell/server/lib/builderV2/surfaceIntegration.mjs";
import { SEVERITY, isBlocking, severityOf } from "../../shell/server/lib/builderV2/validationSeverity.mjs";

const MANIFEST = "src/lib/scaffolds/composed/manifest.js";

function contract() {
  return {
    scaffoldGraph: { extensions: [], screens: [], routes: [], journeyOwnership: [] },
    entities: [
      { name: "project", fields: [{ name: "name", type: "string" }] },
      { name: "room", fields: [{ name: "name", type: "string" }] },
      { name: "draft", storage: "client session", fields: [{ name: "step" }] },
      { name: "appUser", platform: "accounts", fields: [{ name: "email" }] },
    ],
    operations: [
      { id: "create-project", entity: "project", kind: "create" },
      { id: "list-rooms", entity: "room", kind: "list" },
      { id: "save-draft", entity: "draft", kind: "create" },
      { id: "create-user", entity: "appUser", kind: "create" },
    ],
    journeys: [],
    routes: [],
  };
}

function composed({ schema = ["project", "room"], stores = ["project", "room"] } = {}) {
  const files = {};
  if (schema) {
    files["src/lib/capabilities/composed/entities.js"] = `export const entityDefinitions = Object.freeze(${JSON.stringify(schema.map((name) => ({
      name, fields: [{ name: "title", type: "string" }],
    })))});
export const entitySchema = compileSchema(entityDefinitions);`;
  }
  if (stores) {
    files["src/lib/capabilities/composed/crud.js"] = `export const entityStores = Object.freeze({
${stores.map((name) => `  ${JSON.stringify(name)}: makeEntityStore(${JSON.stringify(name)}),`).join("\n")}
});
export function entityStore(entityType) {
  const store = entityStores[String(entityType)];
  return store;
}`;
  }
  return files;
}

function application(screen, { mounted = true } = {}) {
  return {
    "src/main.jsx": `import App from "./App.jsx";`,
    "src/App.jsx": mounted
      ? `import Screen from "./screens/Screen.jsx"; export default function App(){ return <Screen/>; }`
      : `export default function App(){ return null; }`,
    "src/screens/Screen.jsx": screen,
  };
}

const CALLS = {
  entityStore: `import { entityStore } from "../lib/capabilities/composed/crud.js";
const projects = entityStore("project");
const rooms = entityStore("room");
export default function Screen(){ return <button onClick={() => projects.create({ name: "A" })}>Save</button>; }`,
  "db.entity": `import { db } from "../lib/backend/index.js";
export default function Screen(){
  return <button onClick={() => { db.entity("project").create({ name: "A" }); db.entity("room").list(); }}>Save</button>;
}`,
  repository: `import { repository } from "../lib/app/entities.js";
export default function Screen(){
  return <button onClick={() => { repository("project").create({ name: "A" }); repository("room").list(); }}>Save</button>;
}`,
  useEntityMutation: `import { useEntityMutation } from "../lib/app/entities.js";
export default function Screen(){
  const save = useEntityMutation("project");
  repository("room");
  return <button onClick={() => save.create({ name: "A" })}>Save</button>;
}`,
  alias: `import { entityStore as store, db as backend } from "../lib/capabilities/composed/crud.js";
const entity = "project";
const projects = store(entity);
export default function Screen(){ return <button onClick={() => backend.entity("room").create({})}>Save</button>; }`,
  map: `import { entityStores, repositories } from "../lib/capabilities/composed/index.js";
const projects = entityStores["project"];
export default function Screen(){ return <button onClick={() => repositories.room.list()}>Save</button>; }`,
};

function treeFor(screen, composition = {}, { mounted = true } = {}) {
  return { ...application(screen, { mounted }), ...composed(composition) };
}

test("entity_store_unmounted is advisory and does not block", () => {
  assert.equal(severityOf("entity_store_unmounted"), SEVERITY.ADVISORY);
  assert.equal(isBlocking("entity_store_unmounted"), false);
  assert.equal(isBlocking({ code: "entity_store_unmounted" }), false);
});

test("each facade or store call mounts a durable entity that the composed schema declares", () => {
  for (const [name, screen] of Object.entries(CALLS)) {
    const findings = lintEntityStoreIntegrity(treeFor(screen), contract());
    assert.deepEqual(findings, [], name);
  }
});

test("schema alone or entityStores alone is enough composition when a reachable module calls the store", () => {
  const screen = CALLS.entityStore;
  assert.deepEqual(lintEntityStoreIntegrity(treeFor(screen, { stores: null }), contract()), []);
  assert.deepEqual(lintEntityStoreIntegrity(treeFor(screen, { schema: null }), contract()), []);
});

test("a durable entity missing from the composed schema and entityStores is reported", () => {
  const findings = lintEntityStoreIntegrity(treeFor(CALLS.entityStore, { schema: ["room"], stores: ["room"] }), contract());
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "entity_store_unmounted");
  assert.equal(findings[0].entity, "project");
  assert.equal(findings[0].composed, false);
  assert.equal(findings[0].reachableCall, true);
  assert.match(findings[0].message, /composed schema or entityStores/);
});

test("a composed entity whose only call sits off the mounted application is unmounted", () => {
  const tree = treeFor(CALLS.entityStore, {}, { mounted: false });
  const reachable = reachableSourcePaths(tree);
  assert.equal(reachable.has("src/screens/Screen.jsx"), false);
  assert.equal(reachable.has("src/App.jsx"), true);
  const findings = lintEntityStoreIntegrity(tree, contract());
  assert.deepEqual(findings.map((finding) => finding.entity), ["project", "room"]);
  assert.ok(findings.every((finding) => finding.composed === true && finding.reachableCall === false));
  assert.match(findings[0].message, /no module reachable from the application entry/);
});

test("comments and string literals do not count as a store call", () => {
  const screen = `export default function Screen(){
    const note = 'entityStore("project")';
    // repository("room")
    return <p>{note}</p>;
  }`;
  const findings = lintEntityStoreIntegrity(treeFor(screen), contract());
  assert.deepEqual(findings.map((finding) => finding.entity), ["project", "room"]);
  assert.ok(findings.every((finding) => finding.reachableCall === false));
});

test("transient storage and platform-owned entities are outside the check", () => {
  const screen = CALLS.entityStore;
  const findings = lintEntityStoreIntegrity(treeFor(screen), contract());
  assert.equal(findings.some((finding) => finding.entity === "draft" || finding.entity === "appUser"), false);
  assert.deepEqual(lintEntityStoreIntegrity(treeFor(screen), {
    entities: [{ name: "draft", storage: "in-memory", fields: [] }],
    operations: [{ id: "save-draft", entity: "draft", kind: "update" }],
  }), []);
});

test("the static application gate records the finding as advisory and still runs", () => {
  const unmounted = {
    ...treeFor(`export default function Screen(){ return <p>Placeholder</p>; }`),
    [MANIFEST]: "export const manifest = {};",
  };
  const open = runStaticApplicationGate(unmounted, { contract: contract(), journeys: [] });
  assert.equal(open.active, true);
  const finding = open.advisory.find((row) => row.code === "entity_store_unmounted");
  assert.ok(finding, JSON.stringify(open.advisory));
  assert.equal(finding.severity, "advisory");
  assert.equal(open.blocking.some((row) => row.code === "entity_store_unmounted"), false);
  assert.equal(open.checks.find((check) => check.name === "entity_store_integrity").ok, false);
  assert.equal(open.ok, open.blocking.length === 0);

  const mounted = {
    ...treeFor(CALLS.repository),
    [MANIFEST]: "export const manifest = {};",
  };
  const clean = runStaticApplicationGate(mounted, { contract: contract(), journeys: [] });
  assert.equal(clean.advisory.some((row) => row.code === "entity_store_unmounted"), false);
  assert.equal(clean.checks.find((check) => check.name === "entity_store_integrity").ok, true);
});
