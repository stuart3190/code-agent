// The versioned module registry (audit §6, WP1).
//
// The eight registered Builder V2 capabilities are wrapped here as module manifests WITHOUT any
// change to their public imports: `src/lib/capabilities/*` keeps shipping the same bytes and the
// same exports, and the capability registry stays the source of truth for their legacy metadata.
// What changes is that selection, locking, availability and ownership can now be reasoned about
// per module version rather than per method name.
//
// A capability id (crud, session, …) is a *provided capability* of a module; a module id is the
// versioned owner. Later work packages add new versions beside these, never edit them in place.

import { CAPABILITIES, canonicalCapabilityId } from "../capabilityRegistry.mjs";
import { MANIFEST_SCHEMA_VERSION, defineModule, validateModuleManifest } from "./manifest.mjs";
import { compareVersions, maxSatisfying } from "./semver.mjs";

export const MODULE_REGISTRY_VERSION = 1;

/** Deployment services a module may require; availability.mjs answers whether each is present. */
export const SERVICES = Object.freeze([
  "backend_sdk", "app_auth", "entities", "storage", "payments", "notifications", "analytics",
  "runtime_actions", "knowledge", "meta_connector", "realtime",
  "accounts", // WP4: the app-accounts Edge Function plus the memberships migration
]);

const CAPABILITY_MODULE_IDS = Object.freeze({
  crud: "thrallo.entities",
  session: "thrallo.identity",
  roles: "thrallo.authorization",
  booking: "thrallo.booking",
  wizard: "thrallo.workflow",
  contact: "thrallo.contact",
  newsletter: "thrallo.newsletter",
  "interaction-primitives": "thrallo.forms",
  // WP4
  accounts: "thrallo.accounts",
  authorization: "thrallo.authorization",
  admin: "thrallo.admin",
  // WP8
  settings: "thrallo.settings",
  audit: "thrallo.audit",
});

const REQUIRED_SERVICES = Object.freeze({
  crud: ["backend_sdk", "entities"],
  session: ["backend_sdk", "app_auth"],
  roles: [],
  booking: ["backend_sdk", "entities"],
  wizard: ["backend_sdk", "entities"],
  contact: ["backend_sdk", "entities"],
  newsletter: ["backend_sdk", "entities"],
  "interaction-primitives": [],
  accounts: ["backend_sdk", "app_auth", "accounts"],
  authorization: [],
  admin: ["backend_sdk", "app_auth", "accounts"],
});

const SERVER_ABI = Object.freeze({
  crud: "entities-jsonb@1", session: "app-auth@1", roles: null, booking: "entities-jsonb@1",
  wizard: "entities-jsonb@1", contact: "entities-jsonb@1", newsletter: "entities-jsonb@1",
  "interaction-primitives": null,
  accounts: "app-accounts@1", authorization: "app-accounts@1", admin: "app-accounts@1",
});

// Capabilities wrapped one-to-one by legacyCapabilityModule(); the rest are composed below.
const LEGACY_WRAPPED = Object.freeze(["crud", "session", "roles", "booking", "wizard", "contact", "newsletter", "interaction-primitives"]);

const QUERY_OPERATIONS = new Set([
  "list", "get", "count", "subscribe", "getBooking", "listBookings", "remaining", "getState",
  "validateCurrent", "load", "isOwner", "requireOwner", "subscribe_state", "field", "selection",
  "action", "flow_advance", "status", "current",
]);
const SESSION_OPERATIONS = new Set(["ensure", "recover", "signUp", "signIn", "signOut", "resetPassword", "confirmReset"]);
const NON_IDEMPOTENT = new Set(["create", "createBooking", "signUp", "submitContact", "subscribe_newsletter", "confirm"]);

const KNOWN_ERRORS = Object.freeze({
  booking: { createBooking: ["invalid", "over_capacity"], getBooking: ["not_found"], cancelBooking: ["not_found"] },
  contact: { submitContact: ["invalid"] },
  newsletter: { subscribe: ["invalid", "duplicate"] },
  session: { signIn: ["invalid_credentials"], signUp: ["email_taken", "weak_password"], confirmReset: ["invalid_code"] },
  crud: { get: ["not_found"], update: ["not_found"], remove: ["not_found"] },
  roles: { requireOwner: ["forbidden"] },
});

const effectFor = (capabilityId, operation) => {
  if (capabilityId === "session" && SESSION_OPERATIONS.has(operation)) return "session";
  if (capabilityId === "newsletter" && operation === "subscribe") return "mutation";
  if (capabilityId === "wizard" && operation === "subscribe") return "query";
  return QUERY_OPERATIONS.has(operation) ? "query" : "mutation";
};

const idempotencyFor = (capabilityId, operation) => {
  if (capabilityId === "newsletter" && operation === "subscribe") return "supported"; // duplicate policy
  if (NON_IDEMPOTENT.has(operation)) return "none";
  return "supported";
};

function operationDefinitions(capabilityId) {
  const capability = CAPABILITIES[capabilityId];
  const requiredInputs = capability.requiredInputs?.operations || {};
  const outputs = capability.operationOutputs || {};
  return capability.supportedOperations.map((operation) => ({
    id: operation,
    input: { type: "object", required: [...(requiredInputs[operation] || [])] },
    output: { type: "object", description: (outputs[operation] || []).join(", ") || Object.keys(capability.outputs || {}).join(", ") || "void" },
    execution: "client",
    transport: REQUIRED_SERVICES[capabilityId].includes("backend_sdk") ? "backend_sdk" : "in_process",
    effect: effectFor(capabilityId, operation),
    stateOwner: capability.stateOwnership?.owns || capabilityId,
    authorization: capability.persistenceSemantics?.durable ? "rls:owner" : null,
    idempotency: idempotencyFor(capabilityId, operation),
    // Legacy crud.update is a client read followed by a merged write: it is NOT versioned or
    // transactional, and the manifest says so instead of promising what WP5 will supply.
    concurrency: null,
    errors: KNOWN_ERRORS[capabilityId]?.[operation] || [],
    verificationHooks: [...(capability.verificationSemantics?.observe || [])],
  }));
}

function legacyCapabilityModule(capabilityId) {
  const capability = CAPABILITIES[capabilityId];
  const id = CAPABILITY_MODULE_IDS[capabilityId];
  const dependencyModules = [
    { id: "thrallo.core", range: "^1.0.0" },
    ...capability.dependencies.map((dependency) => ({ id: CAPABILITY_MODULE_IDS[dependency], range: `^${CAPABILITIES[dependency].version}` })),
  ];
  return defineModule({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    id,
    version: capability.version,
    status: "qualified",
    title: `${capabilityId} (legacy capability wrapper)`,
    legacyCapabilityId: capabilityId,
    compatibility: {
      contractVersions: [1, 2],
      clientAbi: `${capabilityId}@${String(capability.version).split(".")[0]}`,
      serverAbi: SERVER_ABI[capabilityId],
      runtimeRange: "^1.0.0",
    },
    requires: {
      modules: dependencyModules,
      capabilities: [...capability.dependencies],
      services: [...REQUIRED_SERVICES[capabilityId]],
    },
    provides: {
      capabilities: [capabilityId, ...(capability.aliases || [])],
      operations: operationDefinitions(capabilityId),
    },
    conflicts: [],
    configSchema: { type: "object", properties: Object.fromEntries((capability.requiredInputs?.factory || []).map((key) => [key, {}])) },
    entityContributions: (capability.entities || []).map((entity) => ({ name: entity, storage: "entities-jsonb", ownership: "generic_owner_policy" })),
    routeContributions: [],
    surfaceBindings: (capability.uiContract || []).map((state) => ({ state, required: true })),
    runtime: {
      clientEntrypoints: [
        { module: capability.package, exports: [...capability.interface] },
        { module: `src/lib/capabilities/composed/${capabilityId}.js`, exports: [], composed: true },
      ],
      serverHandlers: capabilityId === "session" ? [{ handler: "supabase/functions/app-auth", actions: ["signup", "signin", "reset", "reset-confirm"] }] : [],
      protectedArtifacts: [
        { path: capability.package, kind: "runtime" },
        { path: `src/lib/capabilities/composed/${capabilityId}.js`, kind: "composed" },
      ],
      packageDependencies: [],
    },
    permissions: capability.persistenceSemantics?.durable
      ? [{ id: "rls:owner", scope: "record", enforcedBy: "database", description: "rows belong to the app-scoped owner session" }]
      : [],
    migrations: [],
    lifecycle: { install: "compose", uninstall: "retain_data" },
    verification: {
      deterministicTests: [...capability.testContract],
      browserEvidence: [...(capability.verificationSemantics?.observe || [])],
    },
    qualification: { basis: "baseline_runtime", revision: "e83d4ef212b08fc2aa9d9ddc0937cd279ad8d042", proof: "test/code-agent/builder-v2-capabilities.test.mjs" },
  });
}

const CORE_MODULE = defineModule({
  schemaVersion: MANIFEST_SCHEMA_VERSION,
  id: "thrallo.core",
  version: "1.0.0",
  status: "qualified",
  title: "Runtime core",
  compatibility: { contractVersions: [1, 2], clientAbi: "backend@1", serverAbi: "supabase-runtime@1", runtimeRange: "^1.0.0" },
  requires: { modules: [], capabilities: [], services: ["backend_sdk"] },
  provides: {
    capabilities: [],
    operations: [
      { id: "availability", input: { type: "object" }, output: { type: "object", description: "declared deployment availability" },
        execution: "client", effect: "query", stateOwner: "runtime configuration", idempotency: "supported", errors: [], verificationHooks: ["runtime preflight"] },
      { id: "ensureVisitorSession", input: { type: "object" }, output: { type: "object", description: "app-scoped visitor user" },
        execution: "client", effect: "session", stateOwner: "visitor identity", idempotency: "supported", errors: ["backend_unconfigured"], verificationHooks: ["visitor session established"] },
    ],
  },
  conflicts: [],
  configSchema: { type: "object" },
  entityContributions: [],
  routeContributions: [],
  surfaceBindings: [],
  runtime: {
    clientEntrypoints: [
      { module: "src/lib/backend/index.js", exports: ["auth", "db", "storage", "payments", "notifications", "actions", "usage", "knowledge", "integrations", "analytics"] },
      { module: "src/lib/visitorSession.js", exports: ["ensureVisitorSession"] },
      { module: "src/lib/capabilities/index.js", exports: ["CAPABILITY_VERSIONS"] },
    ],
    serverHandlers: [],
    protectedArtifacts: [
      { path: "src/lib/backend/index.js", kind: "runtime" },
      { path: "src/lib/backend/supabaseBackend.js", kind: "runtime" },
      { path: "src/lib/visitorSession.js", kind: "runtime" },
      { path: "src/lib/capabilities/index.js", kind: "runtime" },
      { path: "src/lib/assets.js", kind: "runtime" },
    ],
    packageDependencies: [],
  },
  permissions: [],
  migrations: [],
  lifecycle: { install: "scaffold", uninstall: "retain_data" },
  verification: { deterministicTests: ["backend surface", "fail-soft unconfigured"], browserEvidence: ["app renders without env", "visitor session established"] },
  qualification: { basis: "baseline_runtime", revision: "e83d4ef212b08fc2aa9d9ddc0937cd279ad8d042", proof: "scripts/prove-app-backend.mjs" },
});

// WP3: identity 1.2.0 — the legacy session capability wrapper plus the deterministic session
// controller (src/lib/modules/identity.js), the React bindings and the composed per-application
// controller. 1.1.0 stays registered so snapshots locked to it remain verifiable.
const IDENTITY_1_2 = (() => {
  const legacy = legacyCapabilityModule("session");
  const extraOperations = [
    { id: "requireMember", input: { type: "object" }, output: { type: "object", description: "member principal" },
      execution: "client", transport: "in_process", effect: "session", stateOwner: "authentication and session identity",
      authorization: null, idempotency: "supported", concurrency: null, errors: ["member_required"], verificationHooks: ["visitor denied on a member route"] },
    { id: "markExpired", input: { type: "object" }, output: { type: "object", description: "expired session state" },
      execution: "client", transport: "in_process", effect: "session", stateOwner: "authentication and session identity",
      authorization: null, idempotency: "supported", concurrency: null, errors: [], verificationHooks: ["expired then recovered"] },
  ];
  return defineModule({
    ...legacy,
    version: "1.2.0",
    title: "identity/session (deterministic session controller)",
    compatibility: { ...legacy.compatibility, clientAbi: "identity@1" },
    provides: { capabilities: [...legacy.provides.capabilities],
      operations: [...legacy.provides.operations, ...extraOperations] },
    runtime: {
      ...legacy.runtime,
      clientEntrypoints: [
        ...legacy.runtime.clientEntrypoints,
        { module: "src/lib/modules/identity.js", exports: ["createIdentityController", "identityGuard", "classifyIdentityError", "SESSION_STATUS", "IDENTITY_MODE", "IDENTITY_ERROR"] },
        { module: "src/lib/modules/identityReact.js", exports: ["useIdentityState", "useIdentityAction", "useIdentityGuard"] },
        { module: "src/lib/capabilities/composed/identity.js", exports: ["identity", "identityPlan"], composed: true },
        { module: "src/lib/app/identity.js", exports: ["useSession", "useSignIn", "useSignUp", "useSignOut", "usePasswordReset", "useConfirmReset", "useSessionGuard"], composed: true },
      ],
      protectedArtifacts: [
        ...legacy.runtime.protectedArtifacts,
        { path: "src/lib/modules/identity.js", kind: "runtime" },
        { path: "src/lib/modules/identityReact.js", kind: "runtime" },
        { path: "src/lib/capabilities/composed/identity.js", kind: "composed" },
        { path: "src/lib/app/identity.js", kind: "composed" },
      ],
    },
    surfaceBindings: [
      { state: "initializing", required: true }, { state: "signed_out", required: true },
      { state: "visitor", required: false }, { state: "signed_in", required: true },
      { state: "expired", required: true }, { state: "error", required: true },
    ],
    verification: {
      deterministicTests: ["initial state", "sign in", "sign up", "reload keeps principal", "sign out", "reset", "expiry then recover", "visitor denied on member route", "UI binding"],
      browserEvidence: [...legacy.verification.browserEvidence, "signed-in surface after submit", "protected route denied to a visitor"],
    },
    qualification: { basis: "module_suite", proof: "test/code-agent/builder-v2-identity-module.test.mjs" },
  });
})();

// WP4: accounts, authorization 1.1 (the ownership adapter plus real policy over memberships)
// and admin management. Every command is enforced by the app-accounts service; the deployment
// must declare the "accounts" service or a contract that needs these blocks before generation.
const ACCOUNT_ARTIFACTS = [
  { path: "src/lib/modules/policy.js", kind: "runtime" },
  { path: "src/lib/modules/accounts.js", kind: "runtime" },
  { path: "src/lib/modules/accountsReact.js", kind: "runtime" },
];
const accountsModule = (capabilityId, extra = {}) => {
  const base = legacyCapabilityModule(capabilityId);
  return defineModule({
    ...base,
    title: extra.title || base.title,
    provides: { capabilities: [capabilityId, ...(extra.alsoProvides || [])], operations: [...base.provides.operations, ...(extra.operations || [])] },
    runtime: {
      ...base.runtime,
      clientEntrypoints: [
        ...base.runtime.clientEntrypoints,
        ...(extra.clientEntrypoints || []),
      ],
      serverHandlers: [{ handler: "supabase/functions/app-accounts", actions: ["me", "updateMe", "permissions", "member", "members", "invite", "provision", "setRole", "setStatus"] }],
      protectedArtifacts: [...new Map([...base.runtime.protectedArtifacts, ...ACCOUNT_ARTIFACTS, ...(extra.protectedArtifacts || [])]
        .map((artifact) => [artifact.path, artifact])).values()],
    },
    permissions: [
      { id: "members.read", scope: "application", enforcedBy: "app-accounts", description: "list memberships" },
      { id: "members.invite", scope: "application", enforcedBy: "app-accounts", description: "invite a member" },
      { id: "members.provision", scope: "application", enforcedBy: "app-accounts", description: "provision an account" },
      { id: "members.role", scope: "membership", enforcedBy: "app-accounts", description: "change a member's role; never one's own" },
      { id: "members.status", scope: "membership", enforcedBy: "app-accounts", description: "suspend or reinstate; never one's own; never the last admin" },
      { id: "profile.read", scope: "self", enforcedBy: "app-accounts", description: "read own profile" },
      { id: "profile.write", scope: "self", enforcedBy: "app-accounts", description: "write allow-listed profile fields" },
    ],
    migrations: [{ id: "20260918120000_app_accounts_memberships", additive: true, destructive: false }],
    qualification: { basis: "module_suite", proof: "test/code-agent/builder-v2-accounts-module.test.mjs" },
  });
};
const ACCOUNTS_MODULE = accountsModule("accounts", { title: "Accounts/profiles", clientEntrypoints: [
  { module: "src/lib/capabilities/composed/accounts.js", exports: ["accountsController", "accountPolicy"], composed: true },
  { module: "src/lib/app/accounts.js", exports: ["useProfile", "usePermissions", "useAdminMembers", "useAdminOperation"], composed: true },
], protectedArtifacts: [{ path: "src/lib/capabilities/composed/accounts.js", kind: "composed" }, { path: "src/lib/app/accounts.js", kind: "composed" }] });
const AUTHORIZATION_1_1 = (() => {
  const roles = legacyCapabilityModule("roles");
  const manifest = accountsModule("authorization", { title: "Authorization (ownership adapter + membership policy)", alsoProvides: ["roles"],
    operations: roles.provides.operations.filter((row) => !["isOwner", "requireOwner"].includes(row.id)),
    clientEntrypoints: [...roles.runtime.clientEntrypoints,
      { module: "src/lib/capabilities/composed/authorization.js", exports: ["authorization"], composed: true }],
    protectedArtifacts: [...roles.runtime.protectedArtifacts, { path: "src/lib/capabilities/composed/authorization.js", kind: "composed" }] });
  // The ownership adapter needs no accounts service; policy over memberships does. The module
  // itself stays installable everywhere; admin (which needs grants) declares the service.
  return defineModule({ ...manifest, requires: { ...manifest.requires, services: [] }, compatibility: { ...manifest.compatibility, serverAbi: "app-accounts@1|rls-owner@1" } });
})();
const ADMIN_MODULE = accountsModule("admin", { title: "Admin management", clientEntrypoints: [
  { module: "src/lib/capabilities/composed/admin.js", exports: ["admin"], composed: true },
], protectedArtifacts: [{ path: "src/lib/capabilities/composed/admin.js", kind: "composed" }] });

// WP5: entities 1.1.0 — the legacy crud wrapper plus schema-validated typed repositories with
// optimistic concurrency at the persistence boundary. 1.0.0 stays registered for old locks.
const ENTITIES_1_1 = (() => {
  const legacy = legacyCapabilityModule("crud");
  const operations = legacy.provides.operations.map((operation) => (operation.id === "update"
    ? { ...operation, concurrency: "versioned", errors: [...operation.errors, "version_conflict", "validation_failed", "reference_not_found"] }
    : operation.id === "create" ? { ...operation, errors: [...operation.errors, "validation_failed", "reference_not_found"] }
      : operation.id === "remove" ? { ...operation, errors: [...operation.errors, "reference_restricted"] } : operation));
  return defineModule({
    ...legacy,
    version: "1.1.0",
    title: "entities (schema-validated typed repositories over the generic entities backend)",
    compatibility: { ...legacy.compatibility, clientAbi: "entities@1" },
    provides: { capabilities: [...legacy.provides.capabilities], operations },
    runtime: {
      ...legacy.runtime,
      clientEntrypoints: [
        ...legacy.runtime.clientEntrypoints,
        { module: "src/lib/modules/schema.js", exports: ["compileSchema", "validateValues", "queryableFields", "RESERVED_FIELDS"] },
        { module: "src/lib/modules/entities.js", exports: ["createEntityRepository", "createEntityRepositories", "toRecord", "toLegacyRecord", "EntityError", "ENTITY_ERROR"] },
        { module: "src/lib/modules/entitiesReact.js", exports: ["useEntity", "useEntityMutation"] },
        { module: "src/lib/capabilities/composed/entities.js", exports: ["entitySchema", "repositories", "repository"], composed: true },
        { module: "src/lib/app/entities.js", exports: ["repository", "useEntity", "useEntityMutation"], composed: true },
      ],
      protectedArtifacts: [
        ...legacy.runtime.protectedArtifacts,
        { path: "src/lib/modules/schema.js", kind: "runtime" },
        { path: "src/lib/modules/entities.js", kind: "runtime" },
        { path: "src/lib/modules/entitiesReact.js", kind: "runtime" },
        { path: "src/lib/capabilities/composed/entities.js", kind: "composed" },
        { path: "src/lib/app/entities.js", kind: "composed" },
      ],
    },
    entityContributions: [{ name: "*", storage: "entities-jsonb", ownership: "generic_owner_policy", metadata: "data.__meta { version, createdAt, updatedAt }" }],
    verification: {
      deterministicTests: ["create with server identity", "validated patch", "compare-and-set conflict", "reference check", "restrict on delete", "canonical reload", "legacy adapter"],
      browserEvidence: [...legacy.verification.browserEvidence, "saved record survives reload by canonical id"],
    },
    qualification: { basis: "module_suite", proof: "test/code-agent/builder-v2-entities-module.test.mjs" },
  });
})();

/**
 * A platform module with no legacy capability to wrap (WP6/WP7). These are selected by the
 * compiler from the contract's own structure — declared routes, a search operation, a form —
 * rather than by a capability binding, so they carry no `provides.capabilities` entry.
 *
 * WP8 relaxes that for settings and audit only: those ARE capabilities a contract responsibility
 * names, so they declare `capabilities` and resolve through the same capability binding as the
 * legacy eight. A module that declares none is still selected purely from contract structure.
 */
const platformModule = ({ id, version, title, requires = [], services = [], clientAbi, operations, entrypoints, artifacts, deterministicTests, browserEvidence, proof, surfaceBindings = [], capabilities = [] }) => defineModule({
  schemaVersion: MANIFEST_SCHEMA_VERSION,
  id, version, status: "qualified", title,
  compatibility: { contractVersions: [1, 2], clientAbi, serverAbi: null, runtimeRange: "^1.0.0" },
  requires: { modules: [{ id: "thrallo.core", range: "^1.0.0" }, ...requires], capabilities: [], services },
  provides: { capabilities, operations },
  conflicts: [],
  configSchema: { type: "object" },
  entityContributions: [], routeContributions: [], surfaceBindings,
  runtime: { clientEntrypoints: entrypoints, serverHandlers: [], protectedArtifacts: artifacts, packageDependencies: [] },
  permissions: [], migrations: [],
  lifecycle: { install: "compose", uninstall: "retain_data" },
  verification: { deterministicTests, browserEvidence },
  qualification: { basis: "module_suite", proof },
});

const clientOperation = ({ id, effect = "query", stateOwner, errors = [], hooks = [], input = { type: "object" }, output = { type: "object" }, idempotency = "supported", concurrency = null }) => ({
  id, input, output, execution: "client", transport: "in_process", effect, stateOwner,
  authorization: null, idempotency, concurrency, errors, verificationHooks: hooks,
});

// WP6 — the deterministic route compiler: matching precedence, typed parameters, hrefs, guards,
// loaders and not-found. Navigation placement and every route state's appearance stay generated.
const ROUTING_MODULE = platformModule({
  id: "thrallo.routing", version: "1.0.0", title: "Routing (deterministic route compiler)",
  clientAbi: "routing@1",
  requires: [{ id: "thrallo.identity", range: "^1.2.0" }],
  operations: [
    clientOperation({ id: "resolve", stateOwner: "active route", errors: ["route_param_invalid"], hooks: ["the bound record opens on a direct load"] }),
    clientOperation({ id: "href", stateOwner: "active route", errors: ["route_param_missing", "route_unknown"], hooks: ["no literal :param is ever a destination"] }),
    clientOperation({ id: "navigate", effect: "mutation", stateOwner: "active route", idempotency: "supported", hooks: ["back and forward restore the previous screen"] }),
    clientOperation({ id: "guard", stateOwner: "route admission", errors: ["member_required"], hooks: ["a visitor is refused a member route"] }),
    clientOperation({ id: "load", stateOwner: "route data", errors: ["not_found", "loader_missing"], hooks: ["an unknown id renders not_found"] }),
  ],
  entrypoints: [
    { module: "src/lib/modules/routing.js", exports: ["compileRoutes", "matchRoute", "routeHref", "evaluateGuard", "loaderArgs", "normalizePath", "ROUTE_STATES"] },
    { module: "src/lib/modules/router.js", exports: ["createRouter"] },
    { module: "src/lib/modules/uiReact.js", exports: ["useRouterState"] },
    { module: "src/lib/capabilities/composed/routes.js", exports: ["routeTable", "router", "routePlan"], composed: true },
    { module: "src/lib/app/routing.js", exports: ["useRoute", "routeHref", "navigate", "Link"], composed: true },
  ],
  artifacts: [
    { path: "src/lib/modules/routing.js", kind: "runtime" },
    { path: "src/lib/modules/router.js", kind: "runtime" },
    { path: "src/lib/modules/uiReact.js", kind: "runtime" },
    { path: "src/lib/capabilities/composed/routes.js", kind: "composed" },
    { path: "src/lib/app/routing.js", kind: "composed" },
  ],
  surfaceBindings: [
    { state: "loading", required: true }, { state: "ready", required: true },
    { state: "not_found", required: true }, { state: "forbidden", required: true }, { state: "error", required: true },
  ],
  deterministicTests: ["matching precedence", "ambiguity rejected", "typed parameters", "href requires parameters", "guard outcomes", "loader not-found", "history navigation"],
  browserEvidence: ["a detail link opens the right record", "an unknown path renders the application's not-found surface", "a visitor is refused a member route"],
  proof: "test/code-agent/builder-v2-routing-module.test.mjs",
});

// WP7 — the query, form and async-state runtimes. Each replaces a category of repeated generated
// controller work (audit §5) and is selected from the contract's structure, not from a capability.
const QUERY_MODULE = platformModule({
  id: "thrallo.query", version: "1.0.0", title: "Query/collections",
  clientAbi: "query@1",
  requires: [{ id: "thrallo.entities", range: "^1.1.0" }],
  operations: [
    clientOperation({ id: "query", stateOwner: "collection state", errors: ["query_field_not_allowed", "query_operator_not_allowed", "query_value_invalid", "query_cursor_mismatch"], hooks: ["a search control changes the visible result set"] }),
    clientOperation({ id: "count", stateOwner: "collection state", errors: ["query_field_not_allowed"], hooks: ["the total agrees with the page it describes"] }),
    clientOperation({ id: "page", stateOwner: "collection state", errors: ["query_cursor_invalid", "query_cursor_mismatch"], hooks: ["paging never skips or repeats a row"] }),
  ],
  entrypoints: [
    { module: "src/lib/modules/query.js", exports: ["compileQuery", "runQuery", "backendOptions", "matchesQuery", "encodeCursor", "decodeCursor", "QueryError"] },
    { module: "src/lib/modules/collections.js", exports: ["createCollection"] },
    { module: "src/lib/modules/uiReact.js", exports: ["useCollectionState"] },
  ],
  artifacts: [
    { path: "src/lib/modules/query.js", kind: "runtime" },
    { path: "src/lib/modules/collections.js", kind: "runtime" },
  ],
  deterministicTests: ["allow-listed fields and operators", "normalised values", "stable composite cursor", "count matches the predicate", "cursor bound to its query"],
  browserEvidence: ["search controls change the visible result set", "paging shows the next rows"],
  proof: "test/code-agent/builder-v2-query-forms-async.test.mjs",
});

// The form runtime belongs to the SAME module as the legacy interaction primitives — the audit's
// "Forms/interactions" — so it is a new VERSION of that wrapper, not a second module claiming the
// same id. 1.0.0 stays registered for snapshots locked to it.
const FORMS_1_1 = (() => {
  const legacy = legacyCapabilityModule("interaction-primitives");
  const formOperations = [
    clientOperation({ id: "setValue", effect: "mutation", stateOwner: "form draft", hooks: ["a typed value reaches the draft, never a DOM event"] }),
    clientOperation({ id: "validate", stateOwner: "form draft", errors: ["validation_failed"], hooks: ["field problems are visible"] }),
    clientOperation({ id: "submit", effect: "mutation", stateOwner: "form draft", idempotency: "none", errors: ["validation_failed", "submit_failed"], hooks: ["an invalid submission never reaches the operation"] }),
    clientOperation({ id: "resetForm", effect: "mutation", stateOwner: "form draft", hooks: ["a reset draft is empty"] }),
  ];
  return defineModule({
    ...legacy,
    version: "1.1.0",
    title: "Forms/interactions (headless form runtime)",
    compatibility: { ...legacy.compatibility, clientAbi: "forms@1" },
    provides: { capabilities: [...legacy.provides.capabilities], operations: [...legacy.provides.operations, ...formOperations] },
    runtime: {
      ...legacy.runtime,
      clientEntrypoints: [
        ...legacy.runtime.clientEntrypoints,
        { module: "src/lib/modules/forms.js", exports: ["createForm", "coerceFieldValue"] },
        { module: "src/lib/modules/uiReact.js", exports: ["useFormState"] },
      ],
      protectedArtifacts: [...legacy.runtime.protectedArtifacts, { path: "src/lib/modules/forms.js", kind: "runtime" }],
    },
    surfaceBindings: [
      { state: "idle", required: true }, { state: "invalid", required: true },
      { state: "submitting", required: true }, { state: "submitted", required: true }, { state: "error", required: true },
    ],
    verification: {
      deterministicTests: [...legacy.verification.deterministicTests, "schema coercion", "schema and custom validation", "one submission path", "stale submit protection", "reset"],
      browserEvidence: [...legacy.verification.browserEvidence, "an invalid form shows its field problems", "a valid submission reports its outcome"],
    },
    qualification: { basis: "module_suite", proof: "test/code-agent/builder-v2-query-forms-async.test.mjs" },
  });
})();

const ASYNC_MODULE = platformModule({
  id: "thrallo.async", version: "1.0.0", title: "Async resource state",
  clientAbi: "async@1",
  operations: [
    clientOperation({ id: "load", stateOwner: "resource state", errors: ["load_failed"], hooks: ["loading, empty and error states are observable"] }),
    clientOperation({ id: "mutate", effect: "mutation", stateOwner: "mutation state", idempotency: "none", errors: ["mutation_failed"], hooks: ["a failed optimistic change is rolled back"] }),
    clientOperation({ id: "invalidate", effect: "mutation", stateOwner: "resource cache", hooks: ["a dependent list reloads after a write"] }),
  ],
  entrypoints: [
    { module: "src/lib/modules/asyncState.js", exports: ["createResource", "createMutation", "createResourceCache"] },
    { module: "src/lib/modules/uiReact.js", exports: ["useResourceState", "useMutationState"] },
  ],
  artifacts: [{ path: "src/lib/modules/asyncState.js", kind: "runtime" }],
  surfaceBindings: [
    { state: "idle", required: false }, { state: "loading", required: true },
    { state: "ready", required: true }, { state: "empty", required: true }, { state: "error", required: true },
  ],
  deterministicTests: ["superseded loads discarded", "empty distinguished from ready", "optimistic rollback", "cache invalidation by key"],
  browserEvidence: ["loading and empty states are usable", "a failed save leaves the previous state"],
  proof: "test/code-agent/builder-v2-query-forms-async.test.mjs",
});

// WP8 — settings and audit history. Both are served by the app-accounts function, so both need
// the same deployment service; an application that selects them on a deployment without it blocks
// before generation rather than falling back to a fabricated settings record.
const SETTINGS_MODULE = platformModule({
  id: "thrallo.settings", version: "1.0.0", title: "Settings/preferences",
  clientAbi: "settings@1", services: ["backend_sdk", "app_auth", "accounts"], capabilities: ["settings"],
  requires: [{ id: "thrallo.identity", range: "^1.2.0" }],
  operations: [
    clientOperation({ id: "get", stateOwner: "application settings", errors: ["setting_unknown"], hooks: ["a declared default answers before anything is written"] }),
    clientOperation({ id: "all", stateOwner: "application settings", errors: ["forbidden"], hooks: ["every declared key of one scope, defaults included"] }),
    clientOperation({ id: "set", effect: "mutation", stateOwner: "application settings", errors: ["setting_unknown", "setting_invalid_value", "forbidden"], hooks: ["a changed value survives a reload"] }),
    clientOperation({ id: "reset", effect: "mutation", stateOwner: "application settings", errors: ["setting_unknown"], hooks: ["a reset key reads as its default again"] }),
  ],
  entrypoints: [
    { module: "src/lib/modules/settings.js", exports: ["compileSettings", "createSettingsController", "coerceSetting", "SETTING_SCOPES", "SettingsError"] },
    { module: "src/lib/modules/uiReact.js", exports: ["useSettingsState"] },
    { module: "src/lib/capabilities/composed/settings.js", exports: ["settings", "settingsSchema"], composed: true },
    { module: "src/lib/app/settings.js", exports: ["useSettings", "useHistory"], composed: true },
  ],
  artifacts: [
    { path: "src/lib/modules/settings.js", kind: "runtime" },
    { path: "src/lib/capabilities/composed/settings.js", kind: "composed" },
    { path: "src/lib/app/settings.js", kind: "composed" },
  ],
  deterministicTests: ["declared defaults", "typed coercion", "scope isolation", "administration required for an application value", "reload"],
  browserEvidence: ["an administrator's change is visible to a member", "a member cannot change an application value"],
  proof: "test/code-agent/builder-v2-settings-audit.test.mjs",
});

const AUDIT_MODULE = platformModule({
  id: "thrallo.audit", version: "1.0.0", title: "Audit/history",
  clientAbi: "audit@1", services: ["backend_sdk", "app_auth", "accounts"], capabilities: ["audit"],
  requires: [{ id: "thrallo.identity", range: "^1.2.0" }],
  // There is deliberately no append operation: history is written by the platform, and an
  // application that could append its own history could also write a false one.
  operations: [
    clientOperation({ id: "list", stateOwner: "audit history", errors: ["forbidden", "history_unavailable"], hooks: ["an administrative change appears, attributed"] }),
    clientOperation({ id: "redact", stateOwner: "audit history", hooks: ["no sensitive value appears in any event"] }),
  ],
  entrypoints: [
    { module: "src/lib/modules/audit.js", exports: ["createHistoryController", "redactEvent", "redactValues", "changedFields", "ALWAYS_SENSITIVE"] },
    { module: "src/lib/modules/uiReact.js", exports: ["useHistoryState"] },
    { module: "src/lib/capabilities/composed/audit.js", exports: ["history"], composed: true },
  ],
  artifacts: [
    { path: "src/lib/modules/audit.js", kind: "runtime" },
    { path: "src/lib/capabilities/composed/audit.js", kind: "composed" },
  ],
  deterministicTests: ["append-only", "attribution", "redaction of always-sensitive and declared fields", "authorised read", "paging"],
  browserEvidence: ["a change is listed with who made it", "a member without the grant sees no history"],
  proof: "test/code-agent/builder-v2-settings-audit.test.mjs",
});

// WP9 — workflow 1.1.0: the legacy wizard wrapper plus a declared state graph with refused
// transitions, terminal states and an EXPLICIT persistence mode. 1.0.0 stays registered for locks
// that pinned it, exactly as entities 1.0.0 and forms 1.0.0 do.
const WORKFLOW_1_1 = (() => {
  const legacy = legacyCapabilityModule("wizard");
  const workflowOperations = [
    clientOperation({ id: "transition", effect: "mutation", stateOwner: "workflow position", errors: ["workflow_step_invalid", "workflow_terminal", "workflow_step_unknown"], hooks: ["an invalid step refuses to advance and says why"] }),
    clientOperation({ id: "confirmWorkflow", effect: "mutation", stateOwner: "workflow position", errors: ["workflow_step_invalid", "workflow_terminal", "workflow_confirm_failed"], hooks: ["a confirmed workflow refuses a second confirmation"] }),
  ];
  return defineModule({
    ...legacy,
    version: "1.1.0",
    title: "workflow (declared state graph, refused transitions, explicit persistence mode)",
    compatibility: { ...legacy.compatibility, clientAbi: "workflow@1" },
    provides: { capabilities: [...legacy.provides.capabilities],
      operations: [...legacy.provides.operations.map((operation) => (operation.id === "restore"
        ? { ...operation, errors: [...operation.errors, "workflow_persistence_unavailable"], hooks: [...(operation.hooks || []), "saved progress reopens on the step it was left on"] }
        : operation)), ...workflowOperations] },
    runtime: {
      ...legacy.runtime,
      clientEntrypoints: [
        ...legacy.runtime.clientEntrypoints,
        { module: "src/lib/modules/workflow.js", exports: ["compileWorkflow", "createWorkflow", "durableWorkflowPersistence", "WORKFLOW_STATUS", "WORKFLOW_PERSISTENCE", "WorkflowError"] },
        { module: "src/lib/modules/uiReact.js", exports: ["useWorkflowState"] },
        { module: "src/lib/capabilities/composed/workflow.js", exports: ["workflows", "workflowDefinitions"], composed: true },
        { module: "src/lib/app/workflow.js", exports: ["useWorkflow", "workflowFor", "workflows"], composed: true },
      ],
      protectedArtifacts: [
        ...legacy.runtime.protectedArtifacts,
        { path: "src/lib/modules/workflow.js", kind: "runtime" },
        { path: "src/lib/capabilities/composed/workflow.js", kind: "composed" },
        { path: "src/lib/app/workflow.js", kind: "composed" },
      ],
    },
    verification: {
      deterministicTests: [...legacy.verification.deterministicTests, "refused transition", "terminal state", "restore", "one confirmation"],
      browserEvidence: [...legacy.verification.browserEvidence, "an incomplete step cannot advance", "a confirmed flow cannot be submitted twice"],
    },
    proof: "test/code-agent/builder-v2-workflow-workspace-editor.test.mjs",
  });
})();

// WP9 — booking 1.1.0: the proven booking system, now declaring the versioned entities repository
// it sits on, so a cancellation is a compare-and-set rather than a blind overwrite.
const BOOKING_1_1 = (() => {
  const legacy = legacyCapabilityModule("booking");
  const operations = legacy.provides.operations.map((operation) => (operation.id === "cancelBooking"
    ? { ...operation, concurrency: "versioned", errors: [...operation.errors, "version_conflict"] } : operation));
  return defineModule({
    ...legacy,
    version: "1.1.0",
    title: "booking (capacity admission by deterministic rank; versioned cancellation)",
    compatibility: { ...legacy.compatibility, clientAbi: "booking@1" },
    provides: { capabilities: [...legacy.provides.capabilities], operations },
    requires: { ...legacy.requires, modules: [...legacy.requires.modules, { id: "thrallo.entities", range: "^1.1.0" }] },
    verification: {
      deterministicTests: [...legacy.verification.deterministicTests, "concurrent admission by rank", "versioned cancellation"],
      browserEvidence: [...legacy.verification.browserEvidence],
    },
    proof: "test/code-agent/builder-v2-workflow-workspace-editor.test.mjs",
  });
})();

// WP9 — workspace lifecycle and editor state/history. Neither is a capability a contract declares:
// both are selected from contract STRUCTURE (a workspace scaffold family, an editor family),
// exactly like routing and query.
const WORKSPACE_MODULE = platformModule({
  id: "thrallo.workspace", version: "1.0.0", title: "Workspace lifecycle",
  clientAbi: "workspace@1", services: ["backend_sdk", "entities"],
  requires: [{ id: "thrallo.entities", range: "^1.1.0" }],
  operations: [
    clientOperation({ id: "open", stateOwner: "active workspace", errors: ["workspace_not_found"], hooks: ["a reopened workspace is the same record"] }),
    clientOperation({ id: "save", effect: "mutation", concurrency: "versioned", stateOwner: "active workspace", errors: ["workspace_version_conflict", "validation_failed"], hooks: ["a save updates the record it opened, never a second one"] }),
    clientOperation({ id: "discard", effect: "mutation", stateOwner: "active workspace", hooks: ["discarding restores the saved values"] }),
  ],
  entrypoints: [
    { module: "src/lib/modules/workspace.js", exports: ["createWorkspace", "draftDiffers", "WORKSPACE_STATUS", "WorkspaceError"] },
    { module: "src/lib/modules/uiReact.js", exports: ["useWorkspaceState"] },
    { module: "src/lib/capabilities/composed/workspace.js", exports: ["workspaces"], composed: true },
    { module: "src/lib/app/workspace.js", exports: ["useWorkspace", "workspaces"], composed: true },
  ],
  artifacts: [
    { path: "src/lib/modules/workspace.js", kind: "runtime" },
    { path: "src/lib/capabilities/composed/workspace.js", kind: "composed" },
    { path: "src/lib/app/workspace.js", kind: "composed" },
  ],
  surfaceBindings: [
    { state: "empty", required: true }, { state: "loading", required: true }, { state: "ready", required: true },
    { state: "conflict", required: true }, { state: "error", required: true },
  ],
  deterministicTests: ["same-id save and reopen", "derived dirty state", "version conflict", "discard restores"],
  browserEvidence: ["a saved project reopens with its own values", "an unsaved change is visible as unsaved"],
  proof: "test/code-agent/builder-v2-workflow-workspace-editor.test.mjs",
});

const EDITOR_MODULE = platformModule({
  id: "thrallo.editor", version: "1.0.0", title: "Editor state/history",
  clientAbi: "editor@1", services: [],
  operations: [
    clientOperation({ id: "select", stateOwner: "editor selection", hooks: ["a selection never names an object that is gone"] }),
    clientOperation({ id: "execute", effect: "mutation", stateOwner: "editor document", errors: ["editor_command_unknown", "editor_command_not_reversible", "editor_command_failed"], hooks: ["an unknown command is refused, not ignored"] }),
    clientOperation({ id: "undo", effect: "mutation", stateOwner: "editor document", errors: ["editor_nothing_to_undo"], hooks: ["one transaction is one undo"] }),
    clientOperation({ id: "redo", effect: "mutation", stateOwner: "editor document", errors: ["editor_nothing_to_redo"], hooks: ["a new command discards the redo branch"] }),
  ],
  entrypoints: [
    { module: "src/lib/modules/editor.js", exports: ["createEditor", "compileCommands", "objectCommands", "EditorError"] },
    { module: "src/lib/modules/uiReact.js", exports: ["useEditorState"] },
    { module: "src/lib/capabilities/composed/editor.js", exports: ["createAppEditor", "editorCommands"], composed: true },
    { module: "src/lib/app/editor.js", exports: ["useEditor", "createAppEditor"], composed: true },
  ],
  artifacts: [
    { path: "src/lib/modules/editor.js", kind: "runtime" },
    { path: "src/lib/capabilities/composed/editor.js", kind: "composed" },
    { path: "src/lib/app/editor.js", kind: "composed" },
  ],
  surfaceBindings: [
    { state: "ready", required: true }, { state: "empty", required: true }, { state: "error", required: false },
  ],
  deterministicTests: ["declared inverses", "transaction is one undo", "redo branch truncation", "identity and order restored", "unknown command refused"],
  browserEvidence: ["undo restores what the visitor changed", "redo is unavailable after a new change"],
  proof: "test/code-agent/builder-v2-workflow-workspace-editor.test.mjs",
});

// WP10 — files, notifications and realtime. All three wrap SDK surfaces that already exist; what
// they add is the POLICY and the LIFECYCLE the generated code around those surfaces kept getting
// wrong. Each declares the deployment service it needs, so an application that selects one on a
// deployment without it blocks before generation rather than shipping a dead upload button.
const FILES_MODULE = platformModule({
  id: "thrallo.files", version: "1.0.0", title: "Files/storage",
  clientAbi: "files@1", services: ["backend_sdk", "app_auth", "storage"],
  requires: [{ id: "thrallo.identity", range: "^1.2.0" }],
  operations: [
    clientOperation({ id: "check", stateOwner: "file policy", errors: ["file_type_not_allowed", "file_too_large", "file_quota_exceeded"], hooks: ["a file outside the declared policy is refused before it is sent"] }),
    clientOperation({ id: "upload", effect: "mutation", stateOwner: "stored files", errors: ["file_type_not_allowed", "file_too_large", "file_quota_exceeded", "file_upload_failed"], hooks: ["an accepted file is listed against its subject"] }),
    clientOperation({ id: "fileUrl", stateOwner: "stored files", errors: ["file_not_found"], hooks: ["access is a short-lived signed link, minted on demand"] }),
    clientOperation({ id: "removeFile", effect: "mutation", stateOwner: "stored files", errors: ["file_not_found"], hooks: ["removing a file removes its metadata too"] }),
  ],
  entrypoints: [
    { module: "src/lib/modules/files.js", exports: ["compileFilePolicy", "createFiles", "checkFile", "fileKey", "formatBytes", "FILE_STATUS", "FileError"] },
    { module: "src/lib/modules/uiReact.js", exports: ["useFilesState"] },
    { module: "src/lib/capabilities/composed/files.js", exports: ["files", "filePolicy"], composed: true },
    { module: "src/lib/app/files.js", exports: ["useFiles", "filePolicy"], composed: true },
  ],
  artifacts: [
    { path: "src/lib/modules/files.js", kind: "runtime" },
    { path: "src/lib/capabilities/composed/files.js", kind: "composed" },
    { path: "src/lib/app/files.js", kind: "composed" },
  ],
  surfaceBindings: [
    { state: "idle", required: false }, { state: "uploading", required: true }, { state: "ready", required: true },
    { state: "refused", required: true }, { state: "error", required: true },
  ],
  deterministicTests: ["declared type and size refusal before upload", "per-subject quota", "signed URL expiry", "subject cleanup removes object and metadata"],
  browserEvidence: ["an oversized file is refused with a reason", "an uploaded image is visible after a reload"],
  proof: "test/code-agent/builder-v2-files-notifications-realtime.test.mjs",
});

const NOTIFICATIONS_MODULE = platformModule({
  id: "thrallo.notifications", version: "1.0.0", title: "Notifications",
  clientAbi: "notifications@1", services: ["backend_sdk", "app_auth", "notifications"],
  requires: [{ id: "thrallo.identity", range: "^1.2.0" }],
  operations: [
    clientOperation({ id: "inbox", stateOwner: "notification inbox", errors: ["notifications_unavailable"], hooks: ["the unread badge and the list are one answer"] }),
    clientOperation({ id: "send", effect: "mutation", stateOwner: "notification inbox", errors: ["notification_event_unknown", "notifications_unavailable"], hooks: ["the same event about the same subject is delivered once"] }),
    clientOperation({ id: "markRead", effect: "mutation", stateOwner: "notification inbox", errors: ["notifications_unavailable"], hooks: ["a read receipt survives a reload"] }),
  ],
  entrypoints: [
    { module: "src/lib/modules/notifications.js", exports: ["compileNotifications", "createNotifications", "renderTemplate", "deliveryKey", "RECIPIENT", "NotificationError"] },
    { module: "src/lib/modules/uiReact.js", exports: ["useNotificationsState"] },
    { module: "src/lib/capabilities/composed/notifications.js", exports: ["notifications", "notificationEvents"], composed: true },
    { module: "src/lib/app/notifications.js", exports: ["useNotifications", "notificationEvents"], composed: true },
  ],
  artifacts: [
    { path: "src/lib/modules/notifications.js", kind: "runtime" },
    { path: "src/lib/capabilities/composed/notifications.js", kind: "composed" },
    { path: "src/lib/app/notifications.js", kind: "composed" },
  ],
  surfaceBindings: [
    { state: "loading", required: true }, { state: "ready", required: true },
    { state: "empty", required: true }, { state: "error", required: true },
  ],
  deterministicTests: ["idempotent delivery", "derived unread count", "optimistic read with rollback", "undeclared event refused", "server-only recipient never written from the client"],
  browserEvidence: ["a badge clears and stays cleared after a reload", "the same event twice shows once"],
  proof: "test/code-agent/builder-v2-files-notifications-realtime.test.mjs",
});

const REALTIME_MODULE = platformModule({
  id: "thrallo.realtime", version: "1.0.0", title: "Realtime",
  clientAbi: "realtime@1", services: ["backend_sdk", "app_auth", "realtime"],
  requires: [{ id: "thrallo.identity", range: "^1.2.0" }, { id: "thrallo.entities", range: "^1.1.0" }],
  operations: [
    clientOperation({ id: "watch", stateOwner: "live subscriptions", errors: ["realtime_topic_unknown", "realtime_not_authorized", "realtime_unavailable"], hooks: ["a subscription to an undeclared topic is refused"] }),
    clientOperation({ id: "resync", stateOwner: "live subscriptions", errors: ["realtime_unavailable"], hooks: ["a reconnect re-reads rather than leaving a silent gap"] }),
  ],
  entrypoints: [
    { module: "src/lib/modules/realtime.js", exports: ["compileTopics", "createRealtime", "REALTIME_STATUS", "RealtimeError"] },
    { module: "src/lib/modules/uiReact.js", exports: ["useLiveState"] },
    { module: "src/lib/capabilities/composed/realtime.js", exports: ["realtime", "realtimeTopics"], composed: true },
    { module: "src/lib/app/realtime.js", exports: ["useLive", "realtimeTopics"], composed: true },
  ],
  artifacts: [
    { path: "src/lib/modules/realtime.js", kind: "runtime" },
    { path: "src/lib/capabilities/composed/realtime.js", kind: "composed" },
    { path: "src/lib/app/realtime.js", kind: "composed" },
  ],
  surfaceBindings: [
    { state: "connecting", required: true }, { state: "live", required: true },
    { state: "reconnecting", required: true }, { state: "error", required: true },
  ],
  deterministicTests: ["undeclared topic refused", "unauthorised subscription refused", "one channel per topic", "reconnect resyncs", "close on last unsubscribe"],
  browserEvidence: ["a change made elsewhere appears without a reload", "a dropped connection recovers its missed changes"],
  proof: "test/code-agent/builder-v2-files-notifications-realtime.test.mjs",
});

const MODULES = [
  CORE_MODULE, ...LEGACY_WRAPPED.map(legacyCapabilityModule), IDENTITY_1_2, ACCOUNTS_MODULE, AUTHORIZATION_1_1,
  ADMIN_MODULE, ENTITIES_1_1, ROUTING_MODULE, QUERY_MODULE, FORMS_1_1, ASYNC_MODULE, SETTINGS_MODULE, AUDIT_MODULE,
  WORKFLOW_1_1, BOOKING_1_1, WORKSPACE_MODULE, EDITOR_MODULE,
  FILES_MODULE, NOTIFICATIONS_MODULE, REALTIME_MODULE,
];

/** id → every registered version of that module, highest last. */
const byId = new Map();
for (const manifest of MODULES) {
  if (!byId.has(manifest.id)) byId.set(manifest.id, []);
  byId.get(manifest.id).push(manifest);
}
for (const versions of byId.values()) versions.sort((a, b) => compareVersions(a.version, b.version));

export const MODULE_REGISTRY = Object.freeze(Object.fromEntries([...byId.entries()].sort(([a], [b]) => a.localeCompare(b))
  .map(([id, versions]) => [id, Object.freeze([...versions])])));

export function registeredModuleIds() {
  return Object.keys(MODULE_REGISTRY);
}

/** The manifest for `id`, at the highest version satisfying `ranges` (all of them). */
export function moduleManifest(id, ranges = [], registry = MODULE_REGISTRY) {
  const versions = registry[id];
  if (!versions) return null;
  const version = maxSatisfying(versions.map((manifest) => manifest.version), ranges);
  return version ? versions.find((manifest) => manifest.version === version) : null;
}

/** Which module provides a capability id (aliases included). */
export function moduleForCapability(capabilityId, registry = MODULE_REGISTRY) {
  const canonical = canonicalCapabilityId(capabilityId) || String(capabilityId || "");
  for (const versions of Object.values(registry)) {
    const manifest = versions.at(-1);
    if ((manifest.provides.capabilities || []).includes(canonical)) return manifest;
  }
  return null;
}

export function capabilityIdsForModule(id, registry = MODULE_REGISTRY) {
  return registry[id]?.at(-1)?.provides?.capabilities || [];
}

/** Every registered manifest validates, ids are unique per version, and every legacy capability is wrapped. */
export function validateModuleRegistry(registry = MODULE_REGISTRY) {
  const problems = [];
  const providers = new Map();
  for (const [id, versions] of Object.entries(registry)) {
    const seen = new Set();
    for (const manifest of versions) {
      if (manifest.id !== id) problems.push(`${id}: manifest id mismatch (${manifest.id})`);
      const verdict = validateModuleManifest(manifest);
      problems.push(...verdict.problems);
      if (seen.has(manifest.version)) problems.push(`${id}@${manifest.version}: registered twice`);
      seen.add(manifest.version);
      for (const capability of manifest.provides.capabilities || []) {
        const owner = providers.get(capability);
        if (owner && owner !== id) problems.push(`capability ${capability} is provided by both ${owner} and ${id}`);
        providers.set(capability, id);
      }
      for (const dependency of manifest.requires.modules || []) {
        if (!registry[dependency.id]) problems.push(`${id}: requires unregistered module ${dependency.id}`);
      }
    }
  }
  for (const capabilityId of Object.keys(CAPABILITIES)) {
    if (!moduleForCapability(capabilityId, registry)) problems.push(`capability ${capabilityId} has no module`);
  }
  return { ok: problems.length === 0, problems };
}

export const LEGACY_CAPABILITY_MODULES = Object.freeze({ ...CAPABILITY_MODULE_IDS });
