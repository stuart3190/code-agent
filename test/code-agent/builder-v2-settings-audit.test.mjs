// WP8 — settings and audit history.
//
// The defect this replaces is the audit's "settings singleton inferred from prose": a contract
// that says "the administrator sets the default lux level" used to produce an ordinary entity
// with one fabricated record, generated default-glue on every screen that read it, and no
// authority check worth the name. WP8 replaces it with typed keys that carry a declared scope and
// a declared default, a service that isolates scopes and demands the settings grant for an
// application-wide value, and append-only history the application can read but never write.
//
// The negative controls matter as much as the positive ones: a keyed lookup table must NOT be
// claimed as settings (that would delete a real application concept), the application must have
// no way to append an event, and a deployment without the accounts service must block rather than
// fall back to a generated settings record.

import test from "node:test";
import assert from "node:assert/strict";

import {
  SETTINGS_ERROR, SettingsError, coerceSetting, compileSettings, createSettingsController,
} from "../../src/scaffolds/reactVite/lib/modules/settings.js";
import {
  ALWAYS_SENSITIVE, AUDIT_REDACTED, changedFields, createHistoryController, redactEvent,
} from "../../src/scaffolds/reactVite/lib/modules/audit.js";
import {
  createPlatformStateService, memoryPlatformStateStorage,
} from "../../supabase/functions/app-accounts/platformStateService.mjs";
import { buildPolicy } from "../../supabase/functions/app-accounts/policy.js";
import { accountPolicyFromContract } from "../../shell/server/lib/appAccounts/accountPolicyStore.mjs";
import { deriveSettingsPlan, isSettingsSingleton } from "../../shell/server/lib/builderV2/platformModules/settingsPlan.mjs";
import { normalizeContractOwnership } from "../../shell/shared/contractOwnership.mjs";
import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import {
  APP_FACADE_SETTINGS_PATH, AUDIT_COMPOSED_PATH, SETTINGS_COMPOSED_PATH, composeCapabilityFoundation,
} from "../../shell/server/lib/builderV2/capabilityComposer.mjs";
import { platformModuleRequests } from "../../shell/server/lib/builderV2/platformModules/selection.mjs";
import { moduleManifest } from "../../shell/server/lib/builderV2/platformModules/registry.mjs";
import { availabilityFromEnv } from "../../shell/server/lib/builderV2/platformModules/availability.mjs";
import { compileEntitySchema } from "../../shell/server/lib/builderV2/platformModules/schema.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";

const DECLARATIONS = [
  { key: "defaultLux", scope: "app", type: "number", default: 400 },
  { key: "invoiceFooter", scope: "app", type: "text", default: "" },
  { key: "bookingWindow", scope: "app", options: ["7", "14", "30"], default: "14" },
  { key: "emailDigest", scope: "user", type: "boolean", default: true },
  { key: "workspaceTheme", scope: "workspace", type: "string", default: "light" },
];

const ADMIN = { userId: "u-admin", email: "admin@example.com", role: "admin", status: "active", appId: "app-1" };
const MEMBER = { userId: "u-member", email: "member@example.com", role: "member", status: "active", appId: "app-1" };
const POLICY = buildPolicy({ roles: ["admin", "member"] });

function service({ config = { "app-1": { enabled: true, sensitiveFields: ["invoiceFooter"] } }, schema = compileSettings(DECLARATIONS) } = {}) {
  const storage = memoryPlatformStateStorage({ config });
  let tick = 0;
  return {
    storage,
    api: createPlatformStateService({
      storage, policy: POLICY, settingsSchema: schema,
      now: () => `2026-09-18T00:00:${String(tick++).padStart(2, "0")}.000Z`,
    }),
  };
}

test("WP8 — a settings declaration compiles into typed keys with declared scopes and defaults", () => {
  const schema = compileSettings(DECLARATIONS);
  assert.deepEqual(schema.keys, ["defaultLux", "invoiceFooter", "bookingWindow", "emailDigest", "workspaceTheme"]);
  assert.equal(schema.definitions.defaultLux.type, "number");
  assert.equal(schema.definitions.defaultLux.default, 400);
  assert.equal(schema.definitions.bookingWindow.type, "enum", "declared options make the key an enum");
  assert.deepEqual([...schema.definitions.bookingWindow.options], ["7", "14", "30"]);
  assert.equal(schema.definitions.emailDigest.scope, "user");
  // Typed coercion: what a form hands back is a string, and the stored value is not.
  assert.equal(coerceSetting(schema.definitions.defaultLux, "550"), 550);
  assert.equal(coerceSetting(schema.definitions.emailDigest, "false"), false);
  assert.throws(() => coerceSetting(schema.definitions.defaultLux, "bright"),
    (error) => error instanceof SettingsError && error.code === SETTINGS_ERROR.INVALID_VALUE);
  assert.throws(() => coerceSetting(schema.definitions.bookingWindow, "21"),
    (error) => error.code === SETTINGS_ERROR.INVALID_VALUE, "a value outside the declared options is refused");
});

test("WP8 — a declared default answers a read that was never written, and a change survives a reload", async () => {
  const { api } = service();
  const controller = createSettingsController({
    schema: compileSettings(DECLARATIONS),
    transport: {
      get: (scope, target) => api.settings("app-1", ADMIN, { scope, target }),
      set: (scope, target, key, value) => api.setSetting("app-1", ADMIN, { key, value, target }).then((row) => row.value),
    },
  });
  // Nothing has ever been written: every read answers with the declared default rather than
  // undefined, which is exactly the invention each generated screen used to make for itself.
  assert.equal(await controller.get("defaultLux"), 400);
  assert.deepEqual({ ...(await controller.all({ scope: "app" })) },
    { defaultLux: 400, invoiceFooter: "", bookingWindow: "14" });

  await controller.set("defaultLux", "550");
  assert.equal(await controller.get("defaultLux"), 550, "the coerced number, not the submitted string");

  // Reload: a new controller over the same service reads the stored value, not a cache.
  const reloaded = createSettingsController({
    schema: compileSettings(DECLARATIONS),
    transport: { get: (scope, target) => api.settings("app-1", ADMIN, { scope, target }), set: () => { throw new Error("not used"); } },
  });
  assert.equal(await reloaded.get("defaultLux"), 550);
  assert.equal(await reloaded.get("invoiceFooter"), "", "an untouched key still answers with its default");

  await controller.reset("defaultLux");
  assert.equal(await controller.get("defaultLux"), 400, "a reset key reads as its declared default again");
});

test("WP8 — scopes are isolated server-side: a member's preference is keyed by that member and never by a request", async () => {
  const { api } = service();
  await api.setSetting("app-1", MEMBER, { key: "emailDigest", value: false });
  await api.setSetting("app-1", ADMIN, { key: "emailDigest", value: true });
  assert.deepEqual(await api.settings("app-1", MEMBER, { scope: "user" }), { emailDigest: false });
  assert.deepEqual(await api.settings("app-1", ADMIN, { scope: "user" }), { emailDigest: true },
    "two members' user-scoped values do not collide");
  // A caller cannot reach another member's scope by naming a target: the service keys the user
  // scope by the ACTOR, so the request's target is ignored entirely.
  assert.deepEqual(await api.settings("app-1", MEMBER, { scope: "user", target: ADMIN.userId }), { emailDigest: false });

  // Workspace values are isolated by their record, and a workspace read without one is refused.
  await api.setSetting("app-1", ADMIN, { key: "workspaceTheme", value: "dark", target: "w-1" });
  assert.deepEqual(await api.settings("app-1", ADMIN, { scope: "workspace", target: "w-1" }), { workspaceTheme: "dark" });
  assert.deepEqual(await api.settings("app-1", ADMIN, { scope: "workspace", target: "w-2" }), {});
  await assert.rejects(() => api.settings("app-1", ADMIN, { scope: "workspace" }),
    (error) => error.code === "setting_scope_target_required");
  // An application scope is not a member's business to write, and an unknown key is not a key.
  await assert.rejects(() => api.setSetting("app-1", MEMBER, { key: "defaultLux", value: 800 }),
    (error) => error.code === "forbidden" && error.status === 403, "an application value needs the settings grant");
  await assert.rejects(() => api.setSetting("app-1", ADMIN, { key: "madeUpKey", value: 1 }),
    (error) => error.code === "setting_unknown" && error.status === 400);
  // Cross-application isolation: an actor of another application is not authenticated here.
  await assert.rejects(() => api.settings("app-2", ADMIN, { scope: "app" }),
    (error) => error.code === "unauthenticated" && error.status === 401);
});

test("WP8 — history is append-only, attributed, and never written by the application", async () => {
  const { api, storage } = service();
  await api.setSetting("app-1", ADMIN, { key: "defaultLux", value: 550 });
  await api.setSetting("app-1", ADMIN, { key: "defaultLux", value: 600 });

  const page = await api.history("app-1", ADMIN, {});
  assert.equal(page.events.length, 2);
  const [newest, oldest] = page.events;
  assert.equal(newest.action, "settings.set");
  assert.equal(newest.resourceId, "defaultLux");
  assert.equal(newest.actorEmail, ADMIN.email, "every event names who made the change");
  assert.deepEqual([oldest.after.defaultLux, newest.after.defaultLux], [550, 600], "newest first");
  assert.deepEqual(newest.before, { defaultLux: 550 }, "the superseded value is recorded, not overwritten");

  // Append-only by construction: the service exposes no application-reachable write, and a later
  // change adds a row rather than editing the one that already stands.
  assert.equal(typeof api.appendEvent, "undefined");
  assert.equal(typeof api.deleteEvent, "undefined");
  await api.setSetting("app-1", ADMIN, { key: "defaultLux", value: 650 });
  const after = await api.history("app-1", ADMIN, {});
  assert.equal(after.events.length, 3);
  assert.deepEqual(after.events.map((event) => event.after.defaultLux), [650, 600, 550]);
  assert.deepEqual(storage.state.events.map((row) => row.id), ["event-1", "event-2", "event-3"]);

  // A member without the history grant reads none of it.
  await assert.rejects(() => api.history("app-1", MEMBER, {}),
    (error) => error.code === "forbidden" && error.status === 403);
});

test("WP8 — a sensitive value never reaches an event, on the server and again before rendering", async () => {
  const { api, storage } = service();
  await api.setSetting("app-1", ADMIN, { key: "invoiceFooter", value: "account 12345678" });
  // The declaration marked this key sensitive in the audit config, so the stored row carries no
  // value at all — redaction that only happened at render time would still leave the row readable.
  const stored = storage.state.events.at(-1);
  assert.equal(stored.action, "settings.set");
  assert.equal(stored.resourceId, "invoiceFooter");
  assert.equal(JSON.stringify(stored).includes("12345678"), false, "the value never entered the row");

  // And always-sensitive names are redacted whatever an application calls them, including in a
  // row that predates the declaration.
  const legacy = redactEvent({ action: "account.update", after: { email: "a@b.c", apiKey: "sk-live-1", nested: { resetToken: "t" } } });
  assert.equal(legacy.after.apiKey, AUDIT_REDACTED);
  assert.equal(legacy.after.nested.resetToken, AUDIT_REDACTED);
  assert.equal(legacy.after.email, "a@b.c", "a non-sensitive field is untouched");
  assert.ok(ALWAYS_SENSITIVE.includes("password") && ALWAYS_SENSITIVE.includes("sessionToken"));
  assert.deepEqual(changedFields({ before: { a: 1, b: 2 }, after: { a: 1, b: 3 } }), ["b"]);
});

test("WP8 — the history controller pages, redacts and discards a superseded load", async () => {
  const { api } = service();
  for (let index = 0; index < 5; index += 1) await api.setSetting("app-1", ADMIN, { key: "defaultLux", value: 400 + index });
  const controller = createHistoryController({
    transport: { list: (query) => api.history("app-1", ADMIN, { ...query, limit: 2 }) },
    sensitiveFields: ["defaultLux"],
  });
  await controller.load({});
  assert.equal(controller.getState().status, "ready");
  assert.equal(controller.getState().events.length, 2);
  assert.equal(controller.getState().events[0].after.defaultLux, AUDIT_REDACTED,
    "a field the application declared sensitive is redacted before anything renders");
  await controller.more();
  assert.equal(controller.getState().events.length, 4, "more() appends the next page");

  const empty = createHistoryController({ transport: { list: async () => ({ events: [], nextCursor: null }) } });
  await empty.load({});
  assert.equal(empty.getState().status, "empty", "empty is distinguished from ready");

  const failing = createHistoryController({ transport: { list: async () => { const error = new Error("nope"); error.code = "forbidden"; throw error; } } });
  await failing.load({});
  assert.equal(failing.getState().status, "error");
  assert.equal(failing.getState().error.code, "forbidden");
});

test("WP8 — a settings singleton is claimed; a keyed lookup table stays a domain entity", () => {
  const singleton = { name: "settings", fields: [{ name: "id" }, { name: "defaultLux", type: "number", default: 400 }] };
  const lookup = { name: "settings", fields: [{ name: "id" }, { name: "roomTypeKey" }, { name: "lux", type: "number" }] };
  const contract = { entities: [singleton], operations: [{ id: "read-settings", kind: "read", entity: "settings" }] };
  assert.equal(isSettingsSingleton(contract, singleton), true);
  assert.equal(isSettingsSingleton({ ...contract, entities: [lookup] }, lookup), false,
    "a key-like field means rows are addressed by something: a lookup table the application owns");
  // A create or a collection read is a table by any other name, whatever it is called.
  assert.equal(isSettingsSingleton({ entities: [singleton], operations: [{ id: "add", kind: "create", entity: "settings" }] }, singleton), false);
  assert.equal(isSettingsSingleton({ entities: [singleton], operations: [{ id: "all", kind: "list", entity: "settings" }] }, singleton), false);
  assert.equal(isSettingsSingleton(contract, { name: "roomType", fields: [{ name: "id" }] }), false);
});

test("WP8 — the singleton leaves the entity schema and its CRUD becomes the settings command it means", () => {
  const contract = {
    version: 2, summary: "lighting studio",
    entities: [
      { name: "settings", fields: [{ name: "id" }, { name: "defaultLux", type: "number", default: 400 }, { name: "invoiceFooter", type: "text" }] },
      { name: "project", fields: [{ name: "id" }, { name: "name" }] },
    ],
    operations: [
      { id: "view-settings", kind: "read", entity: "settings" },
      { id: "update-settings", kind: "update", entity: "settings",
        responsibilities: [
          { type: "functional", behavior: "write the chosen default", reads: ["defaultLux"], writes: ["defaultLux"] },
          { type: "persistence", capability: "crud", capabilityMethod: "update", reads: ["defaultLux"], writes: ["defaultLux"] },
        ] },
      { id: "list-projects", kind: "list", entity: "project" },
    ],
    journeys: [{ id: "admin", title: "Administrator reviews the change history" }],
  };
  const { contract: typed, report } = normalizeContractOwnership(contract);
  const settings = typed.entities.find((entity) => entity.name === "settings");
  assert.equal(settings.platform, "settings");
  assert.equal(settings.owned, false);
  assert.deepEqual(report.settingsEntities.map((entity) => entity.name), ["settings"]);
  assert.deepEqual(report.settingsEntities[0].original.fields.map((field) => field.name),
    ["id", "defaultLux", "invoiceFooter"], "the original declaration is preserved verbatim");

  // No entity store is composed for it: the compiled schema sees the domain entity only.
  assert.deepEqual(compileEntitySchema(typed).entities, ["project"]);

  const update = typed.operations.find((operation) => operation.id === "update-settings");
  assert.equal(update.owner, "module");
  assert.equal(update.module, "thrallo.settings");
  assert.equal(update.moduleOperation, "set");
  assert.equal(update.responsibilities.length, 1, "the transformation that only chose a key is absorbed, not left generated");
  const retarget = report.retargetedOperations.find((row) => row.id === "update-settings");
  assert.equal(retarget.reason, "platform_settings");
  assert.equal(retarget.from.responsibilities.length, 2, "the original is preserved for the record");
  assert.equal(typed.operations.find((operation) => operation.id === "view-settings").moduleOperation, "get");
  assert.equal(typed.operations.find((operation) => operation.id === "list-projects").module, "thrallo.entities",
    "a domain entity is untouched");

  const requirement = report.platformRequirements.find((row) => row.type === "settings");
  assert.deepEqual({ module: requirement.module, status: requirement.status, enforcement: requirement.enforcement },
    { module: "thrallo.settings", status: "resolved", enforcement: "block" });

  // Selection: settings is requested because a singleton is declared; audit because the
  // contract's own vocabulary asks to review changes.
  const plan = deriveSettingsPlan(typed, { entitySchema: compileEntitySchema(typed) });
  assert.deepEqual(plan.declarations.map((row) => row.key), ["defaultLux", "invoiceFooter"]);
  assert.equal(plan.declarations[0].default, 400);
  assert.equal(plan.audit.enabled, true);
  const requests = platformModuleRequests(typed, { entitySchema: compileEntitySchema(typed), settingsPlan: plan });
  assert.deepEqual(requests.filter((row) => ["thrallo.settings", "thrallo.audit"].includes(row.id)).map((row) => row.id),
    ["thrallo.settings", "thrallo.audit"]);
  // Audit is NOT requested where nothing reviews changes: history nobody reads is history nobody
  // can check, and an unread table of events is not a feature.
  const quiet = deriveSettingsPlan({ ...typed, journeys: [{ id: "admin", title: "Administrator sets the defaults" }] },
    { entitySchema: compileEntitySchema(typed) });
  assert.equal(quiet.audit.enabled, false);
  assert.equal(platformModuleRequests({ ...typed, journeys: [] }, { entitySchema: compileEntitySchema(typed), settingsPlan: quiet })
    .some((row) => row.id === "thrallo.audit"), false);
});

test("WP8 — a build carrying a settings singleton locks both modules and composes a protected facade", () => {
  const contract = {
    version: 2, summary: "lighting studio", auth: { required: true, roles: ["admin", "member"] },
    entities: [
      { name: "settings", fields: [{ name: "id" }, { name: "defaultLux", type: "number", default: 400 }] },
      { name: "project", fields: [{ name: "id" }, { name: "name", type: "string", required: true }] },
    ],
    operations: [
      { id: "view-settings", kind: "read", entity: "settings" },
      { id: "update-settings", kind: "update", entity: "settings" },
      { id: "list-projects", kind: "list", entity: "project" },
    ],
    journeys: [{ id: "admin-settings", title: "Administrator changes defaults and reviews the change history",
      steps: [{ id: "s1", operates: ["update-settings"], expect: "the new default is stored" }] }],
  };
  const spec = deriveBuildSpec(contract);
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join(" | "));
  assert.deepEqual(spec.settingsPlan.declarations.map((row) => row.key), ["defaultLux"]);
  const locked = spec.moduleLock.modules.map((row) => row.id);
  assert.ok(locked.includes("thrallo.settings"), "the settings module is locked into the build");
  assert.ok(locked.includes("thrallo.audit"), "so is audit, because the journey reviews changes");

  const { tree } = composeCapabilityFoundation({ ...REACT_VITE }, spec.capabilityGraph, {
    moduleLock: spec.moduleLock, identityPlan: spec.identityPlan, entitySchema: spec.entitySchema,
    routePlan: spec.routePlan, settingsPlan: spec.settingsPlan,
  });
  assert.ok(tree[SETTINGS_COMPOSED_PATH].includes('"key": "defaultLux"'), "the declaration is embedded, not re-derived");
  assert.ok(tree[SETTINGS_COMPOSED_PATH].includes("compileSettings("));
  assert.ok(tree[AUDIT_COMPOSED_PATH].includes("createHistoryController("));
  const auditCode = tree[AUDIT_COMPOSED_PATH].split(String.fromCharCode(10)).filter((line) => { const text = line.trim(); return !text.startsWith("//") && !text.startsWith("*") && !text.startsWith("/*"); }).join(String.fromCharCode(10));
  assert.equal(/append/i.test(auditCode), false, "the composed history exposes no append path, only a list transport");
  assert.ok(tree[APP_FACADE_SETTINGS_PATH].includes("export function useSettings("));
  assert.ok(tree[APP_FACADE_SETTINGS_PATH].includes("export function useHistory("));
  assert.ok(tree["src/lib/app/index.js"].includes('export * from "./settings.js";'));
  for (const path of [SETTINGS_COMPOSED_PATH, AUDIT_COMPOSED_PATH, APP_FACADE_SETTINGS_PATH]) {
    assert.ok(tree[path].includes("Protected deterministic foundation"), path + " states it is platform-owned");
  }

  // A contract with no settings singleton composes exactly as before: no settings files at all.
  const plain = deriveBuildSpec({ ...contract, entities: contract.entities.filter((entity) => entity.name !== "settings"),
    operations: contract.operations.filter((operation) => operation.entity !== "settings"),
    journeys: [{ id: "projects", title: "Member lists projects", steps: [{ id: "s1", operates: ["list-projects"], expect: "the projects are listed" }] }] });
  const { tree: plainTree } = composeCapabilityFoundation({ ...REACT_VITE }, plain.capabilityGraph, {
    moduleLock: plain.moduleLock, identityPlan: plain.identityPlan, entitySchema: plain.entitySchema,
    routePlan: plain.routePlan, settingsPlan: plain.settingsPlan,
  });
  assert.equal(SETTINGS_COMPOSED_PATH in plainTree, false);
  assert.equal(APP_FACADE_SETTINGS_PATH in plainTree, false);
  assert.equal(plain.moduleLock.modules.some((row) => row.id === "thrallo.settings"), false);
});

test("WP8 — negative control: without the accounts service the build blocks; it never falls back to a generated settings record", () => {
  const contract = {
    version: 2, summary: "lighting studio", auth: { required: true, roles: ["admin", "member"] },
    entities: [{ name: "settings", fields: [{ name: "id" }, { name: "defaultLux", type: "number", default: 400 }] }],
    operations: [{ id: "update-settings", kind: "update", entity: "settings" }],
    journeys: [{ id: "admin", title: "Administrator changes defaults" }],
  };
  const without = availabilityFromEnv({ THRALLO_APP_SERVICE_BACKEND_SDK: "1", THRALLO_APP_SERVICE_APP_AUTH: "1", THRALLO_APP_SERVICE_ENTITIES: "1" });
  const spec = deriveBuildSpec(contract, { availability: without });
  assert.equal(spec.verdict.ok, false);
  const problem = spec.moduleResolution.problems.find((row) => row.module === "thrallo.settings");
  assert.equal(problem.code, "module_unavailable");
  assert.equal(problem.configurationRequired, true, "an operator configures the service; the compiler does not generate around it");
  assert.ok(spec.verdict.problems.some((row) => row.includes("thrallo.settings")));

  // The manifest states the same requirement, and declares no append operation.
  const manifest = moduleManifest("thrallo.audit");
  assert.ok(manifest.requires.services.includes("accounts"));
  assert.equal(manifest.provides.operations.some((row) => /append|write|record/i.test(row.id)), false,
    "the application-facing audit ABI is read-only by construction");
  assert.deepEqual(moduleManifest("thrallo.settings").provides.capabilities, ["settings"]);
});

test("WP8 — the settings runtime and its React bindings ship in the scaffold and stay protected", () => {
  for (const path of ["src/lib/modules/settings.js", "src/lib/modules/audit.js", "src/lib/modules/uiReact.js"]) {
    assert.equal(typeof REACT_VITE[path], "string", `${path} ships in the scaffold`);
  }
  assert.ok(REACT_VITE["src/lib/modules/uiReact.js"].includes("export function useSettingsState("));
  assert.ok(REACT_VITE["src/lib/modules/uiReact.js"].includes("export function useHistoryState("));
  // The settings module answers reads from its declared defaults even when the service is down,
  // so an unavailable settings service degrades a screen rather than emptying it.
  assert.ok(REACT_VITE["src/lib/modules/settings.js"].includes("SETTINGS_ERROR"));
});

test("WP8 — an unavailable settings service still answers declared defaults and reports the error", async () => {
  const controller = createSettingsController({
    schema: compileSettings(DECLARATIONS),
    transport: {
      get: async () => { const error = new Error("service down"); error.code = "settings_unavailable"; throw error; },
      set: async () => { throw new Error("service down"); },
    },
  });
  assert.equal(await controller.get("defaultLux"), 400, "the declared default answers");
  assert.equal(controller.getState().status, "error");
  assert.equal(controller.getState().error.code, "settings_unavailable", "the failure stays visible rather than silent");
  await assert.rejects(() => controller.get("noSuchKey"), (error) => error.code === SETTINGS_ERROR.UNKNOWN_KEY);
});

test("WP8 — the service validates against the schema the build declared, not against the request", () => {
  const typed = normalizeContractOwnership({
    version: 2, summary: "studio", auth: { required: true, roles: ["admin", "member"] },
    entities: [{ name: "settings", fields: [{ name: "id" }, { name: "defaultLux", type: "number", default: 400 }, { name: "apiToken" }] }],
    operations: [{ id: "update-settings", kind: "update", entity: "settings" }],
    journeys: [{ id: "admin", title: "Administrator reviews the audit history" }],
  }).contract;
  const plan = deriveSettingsPlan(typed);
  const policy = accountPolicyFromContract(typed, { settingsPlan: plan });
  assert.deepEqual(Object.keys(policy.settings.definitions), ["defaultLux", "apiToken"]);
  // A secret-shaped key stays a setting an administrator may set, but it is marked sensitive, so
  // its value never reaches an audit row. The platform does not encrypt it: settings are not a
  // secret store, and nothing here claims otherwise.
  assert.equal(policy.settings.definitions.apiToken.sensitive, true);
  assert.ok(plan.audit.sensitiveFields.includes("apiToken"));
  assert.deepEqual(policy.settings.definitions.defaultLux, { key: "defaultLux", scope: "app", type: "number", default: 400, version: 1 });
  assert.ok(policy.grants.admin.includes("settings.write"));
  assert.equal(policy.grants.member.includes("settings.write"), false, "a member never writes an application value");
  assert.ok(policy.grants.member.includes("settings.read"));

  // A build that declares no settings records no schema at all, so the service accepts no key.
  const plain = normalizeContractOwnership({
    version: 2, summary: "studio", auth: { required: true, roles: ["admin"] },
    entities: [{ name: "project", fields: [{ name: "id" }, { name: "name" }] }],
    operations: [{ id: "list", kind: "list", entity: "project" }],
  }).contract;
  assert.equal("settings" in accountPolicyFromContract(plain, { settingsPlan: deriveSettingsPlan(plain) }), false);
});

test("WP8 — a row stored before a field was declared sensitive is still redacted on read", async () => {
  const { api, storage } = service({ config: { "app-1": { enabled: true, sensitiveFields: [] } } });
  await api.setSetting("app-1", ADMIN, { key: "invoiceFooter", value: "account 12345678" });
  assert.equal(JSON.stringify(storage.state.events.at(-1)).includes("12345678"), true,
    "nothing was declared sensitive, so the value entered the row");
  // The application later declares the key sensitive. The stored row cannot be rewritten — history
  // is append-only — so the read path applies the declaration instead.
  storage.state.config["app-1"] = { enabled: true, sensitiveFields: ["invoiceFooter"] };
  const page = await api.history("app-1", ADMIN, {});
  assert.equal(page.events[0].after.invoiceFooter, AUDIT_REDACTED);
  assert.equal(JSON.stringify(storage.state.events.at(-1)).includes("12345678"), true, "the row itself is untouched");
});
