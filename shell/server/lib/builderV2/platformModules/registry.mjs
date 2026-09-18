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
});

const SERVER_ABI = Object.freeze({
  crud: "entities-jsonb@1", session: "app-auth@1", roles: null, booking: "entities-jsonb@1",
  wizard: "entities-jsonb@1", contact: "entities-jsonb@1", newsletter: "entities-jsonb@1",
  "interaction-primitives": null,
});

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

const MODULES = [CORE_MODULE, ...Object.keys(CAPABILITY_MODULE_IDS).map(legacyCapabilityModule), IDENTITY_1_2];

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
