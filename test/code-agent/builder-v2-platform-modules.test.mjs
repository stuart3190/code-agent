// WP1 — manifest, resolver, lock and availability.
//
// The eight capabilities are wrapped as versioned modules without any change to their public
// imports. Resolution is deterministic, dependency-complete and explainable; an unavailable
// required service blocks BEFORE generation with a typed, configuration-required problem; the
// lock records exact versions and artefact hashes; a tampered or drifted runtime is detected;
// old (v3) specs adapt without re-derivation of anything they did not carry.

import test from "node:test";
import assert from "node:assert/strict";

import {
  MANIFEST_SCHEMA_VERSION, defineModule, validateModuleManifest, validateOperationDefinition,
} from "../../shell/server/lib/builderV2/platformModules/manifest.mjs";
import {
  LEGACY_CAPABILITY_MODULES, MODULE_REGISTRY, capabilityIdsForModule, moduleForCapability, moduleManifest,
  registeredModuleIds, validateModuleRegistry,
} from "../../shell/server/lib/builderV2/platformModules/registry.mjs";
import {
  RESOLUTION_PROBLEMS, configurationRequiredProblems, resolveModules, resolvedModuleIds,
} from "../../shell/server/lib/builderV2/platformModules/resolver.mjs";
import {
  availabilityFromEnv, baselineDeploymentAvailability, declaredAvailability, intersectAvailability,
} from "../../shell/server/lib/builderV2/platformModules/availability.mjs";
import {
  MODULE_LOCK_VERSION, buildModuleLock, lockFromLegacySpec, moduleLockDelta, moduleLockDigest, moduleLockFromTree,
  scaffoldArtifactSource, verifyModuleLock,
} from "../../shell/server/lib/builderV2/platformModules/lock.mjs";
import { compareVersions, maxSatisfying, satisfiesRange } from "../../shell/server/lib/builderV2/platformModules/semver.mjs";
import { CAPABILITIES } from "../../shell/server/lib/builderV2/capabilityRegistry.mjs";
import { BUILD_SPEC_VERSION, buildSpecSummary, deriveBuildSpec, scopeBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import {
  MODULE_LOCK_PATH, capabilityCompositionPlan, composeCapabilityFoundation, validateCapabilityComposition,
} from "../../shell/server/lib/builderV2/capabilityComposer.mjs";
import { sourceContractDigest } from "../../shell/server/lib/builderV2/executionProvenance.mjs";
import { isProtectedPath } from "../../shell/server/lib/builderV2/patchEngine.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";

const CONTRACT = {
  summary: "A workshop booking system with review, recovery and cancellation",
  entities: [{ name: "booking", fields: [{ name: "date" }, { name: "slot" }, { name: "email" }] }],
  operations: [{ id: "create-booking", entity: "booking", action: "create" }],
  routes: [{ path: "/", name: "Booking" }, { path: "/manage", name: "Manage" }],
  auth: { required: false },
  journeys: [
    { id: "book", title: "Complete a booking", priority: "primary", steps: [
      { action: "select a date", target: "date", expect: "date becomes active" },
      { action: "select a slot", target: "slot", expect: "slot becomes active" },
      { action: "enter your email", target: "email", expect: "email accepted" },
      { action: "review the booking", target: "review", expect: "review shows the values" },
      { action: "confirm booking", target: "confirm", expect: "booking reference" },
      { action: "cancel booking", target: "cancel", expect: "cancelled status" },
    ] },
    { id: "newsletter", title: "Join the newsletter", priority: "secondary", steps: [
      { action: "submit the newsletter form", target: "/manage", expect: "subscribed confirmation" },
    ] },
  ],
};

const baseManifest = (overrides = {}) => ({
  schemaVersion: MANIFEST_SCHEMA_VERSION, id: "thrallo.example", version: "1.0.0", status: "experimental",
  compatibility: { contractVersions: [2], clientAbi: "example@1", serverAbi: null, runtimeRange: "^1.0.0" },
  requires: { modules: [{ id: "thrallo.core", range: "^1.0.0" }], capabilities: [], services: [] },
  provides: { capabilities: ["example"], operations: [] },
  conflicts: [], configSchema: { type: "object" }, entityContributions: [], routeContributions: [], surfaceBindings: [],
  runtime: { clientEntrypoints: [], serverHandlers: [], protectedArtifacts: [], packageDependencies: [] },
  permissions: [], migrations: [], lifecycle: { install: "compose", uninstall: "retain_data" },
  verification: { deterministicTests: [], browserEvidence: [] },
  ...overrides,
});

const registryWith = (...manifests) => {
  const next = Object.fromEntries(Object.entries(MODULE_REGISTRY).map(([id, versions]) => [id, [...versions]]));
  for (const manifest of manifests) {
    next[manifest.id] = [...(next[manifest.id] || []), manifest].sort((a, b) => compareVersions(a.version, b.version));
  }
  return next;
};

test("semver — ranges resolve deterministically and reject malformed input", () => {
  assert.equal(satisfiesRange("1.4.2", "^1.0.0"), true);
  assert.equal(satisfiesRange("2.0.0", "^1.0.0"), false);
  assert.equal(satisfiesRange("0.2.9", "^0.2.1"), true);
  assert.equal(satisfiesRange("0.3.0", "^0.2.1"), false);
  assert.equal(satisfiesRange("1.2.9", "~1.2.0"), true);
  assert.equal(satisfiesRange("1.3.0", "~1.2.0"), false);
  assert.equal(satisfiesRange("1.5.0", ">=1.2.0 <2.0.0"), true);
  assert.equal(satisfiesRange("1.5.0", "1.x"), true);
  assert.equal(satisfiesRange("1.5.0", "1.4.0 || 1.5.0"), true);
  assert.equal(satisfiesRange("1.0.0", "*"), true);
  assert.equal(maxSatisfying(["1.0.0", "1.2.0", "2.0.0"], ["^1.0.0", ">=1.1.0"]), "1.2.0");
  assert.equal(maxSatisfying(["1.0.0"], ["^2.0.0"]), null);
  assert.throws(() => satisfiesRange("banana", "^1.0.0"), /invalid semantic version/);
});

test("manifest — the schema rejects every malformed shape the audit forbids", () => {
  assert.equal(validateModuleManifest(baseManifest()).ok, true);
  assert.match(validateModuleManifest(baseManifest({ id: "entities" })).problems.join(), /id must match/);
  assert.match(validateModuleManifest(baseManifest({ version: "latest" })).problems.join(), /version must be semantic/);
  assert.match(validateModuleManifest(baseManifest({ lifecycle: { install: "compose", uninstall: "drop_tables" } })).problems.join(),
    /never implicitly deletes its data/);
  assert.match(validateModuleManifest(baseManifest({ status: "qualified" })).problems.join(), /qualification basis/);
  assert.match(validateModuleManifest(baseManifest({ runtime: { clientEntrypoints: [], serverHandlers: [],
    protectedArtifacts: [{ path: "node_modules/x.js" }], packageDependencies: [] } })).problems.join(), /src\/ paths/);
  assert.match(validateModuleManifest(baseManifest({ runtime: { clientEntrypoints: [], serverHandlers: [],
    protectedArtifacts: [], packageDependencies: [{ package: "three", version: "^0.185.1" }] } })).problems.join(), /exact versions/);
  const op = { id: "rename", input: { type: "object" }, output: { type: "object" }, execution: "server", effect: "mutation",
    stateOwner: "entity", idempotency: "required", errors: [], verificationHooks: [] };
  assert.match(validateOperationDefinition(op).join(), /server mutation must name its authorization/);
  assert.deepEqual(validateOperationDefinition({ ...op, authorization: "project.write" }), []);
  assert.match(validateOperationDefinition({ ...op, authorization: "x", effect: "sideEffect" }).join(), /effect must be one of/);
  assert.throws(() => defineModule(baseManifest({ id: "bad id" })), /invalid module manifest/);
});

test("registry — every legacy capability is wrapped by a validated module; public imports are unchanged", () => {
  assert.deepEqual(validateModuleRegistry(), { ok: true, problems: [] });
  assert.deepEqual(registeredModuleIds(), [
    "thrallo.authorization", "thrallo.booking", "thrallo.contact", "thrallo.core", "thrallo.entities",
    "thrallo.forms", "thrallo.identity", "thrallo.newsletter", "thrallo.workflow",
  ]);
  for (const [capabilityId, capability] of Object.entries(CAPABILITIES)) {
    const manifest = moduleForCapability(capabilityId);
    assert.ok(manifest, `${capabilityId} has a module`);
    assert.equal(manifest.id, LEGACY_CAPABILITY_MODULES[capabilityId]);
    // A module may advance beyond its legacy capability (identity 1.2.0 wraps session 1.1.0) but
    // never across a major: the capability's public imports are unchanged by construction.
    assert.equal(manifest.version.split(".")[0], String(capability.version).split(".")[0], `${capabilityId} module major equals the capability major`);
    assert.ok(satisfiesRange(manifest.version, `^${capability.version}`), `${capabilityId} module ${manifest.version} satisfies ^${capability.version}`);
    for (const operation of capability.supportedOperations) {
      assert.ok(manifest.provides.operations.some((row) => row.id === operation),
        `${capabilityId} module provides the registry operation ${operation}`);
    }
    // The protected runtime artefact is the same file the capability registry has always shipped.
    assert.equal(manifest.runtime.protectedArtifacts[0].path, capability.package);
    assert.ok(typeof REACT_VITE[capability.package] === "string", `${capability.package} still ships in the scaffold`);
    assert.ok(isProtectedPath(capability.package), `${capability.package} stays under the write guard`);
    assert.equal(manifest.lifecycle.uninstall, "retain_data");
  }
  assert.equal(moduleForCapability("auth").id, "thrallo.identity", "the auth alias resolves to identity");
  assert.deepEqual(capabilityIdsForModule("thrallo.identity"), ["session", "auth"]);
  // Legacy crud.update is honestly declared: not versioned, not transactional.
  const update = moduleManifest("thrallo.entities").provides.operations.find((row) => row.id === "update");
  assert.equal(update.concurrency, null);
  assert.equal(update.effect, "mutation");
  const signIn = moduleManifest("thrallo.identity").provides.operations.find((row) => row.id === "signIn");
  assert.equal(signIn.effect, "session");
  assert.deepEqual(signIn.input.required, ["email", "password"]);
});

test("resolver — selection is deterministic, dependency-complete and explainable", () => {
  const bindings = [{ name: "crud", version: "1.0.0" }, { name: "session", version: "1.1.0" }, { name: "roles" }];
  const first = resolveModules({ bindings });
  const second = resolveModules({ bindings: [...bindings].reverse() });
  assert.equal(first.ok, true, JSON.stringify(first.problems));
  assert.deepEqual(resolvedModuleIds(first), ["thrallo.core", "thrallo.identity", "thrallo.authorization", "thrallo.entities"]);
  assert.deepEqual(first, second, "binding order does not change the resolution");
  const entities = first.modules.find((row) => row.id === "thrallo.entities");
  assert.deepEqual(entities.requires, ["thrallo.core", "thrallo.identity"]);
  assert.deepEqual(entities.reasons, ["capability:crud"]);
  const identity = first.modules.find((row) => row.id === "thrallo.identity");
  assert.deepEqual(identity.reasons, ["capability:session", "required by thrallo.authorization", "required by thrallo.entities"]);
  assert.deepEqual(first.explanations, ["crud → thrallo.entities (^1.0.0)", "roles → thrallo.authorization (^1.0.0)", "session → thrallo.identity (^1.1.0)"]);
  // The dependency closure is minimal: nothing the bindings did not ask for.
  assert.equal(first.modules.some((row) => row.id === "thrallo.booking"), false);
});

test("resolver — negative controls: range conflict, declared conflict, duplicate ownership, deprecation, unknown", () => {
  const conflict = resolveModules({ bindings: [{ name: "crud", version: "2.0.0" }] });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.problems[0].code, RESOLUTION_PROBLEMS.RANGE_CONFLICT);
  assert.deepEqual(conflict.problems[0].available, ["1.0.0"]);

  const rival = defineModule(baseManifest({ id: "thrallo.rivalEntities", status: "qualified",
    qualification: { basis: "test" }, provides: { capabilities: ["crud"], operations: [] } }));
  const duplicate = resolveModules({ bindings: [{ name: "crud" }], requestedModules: [{ id: "thrallo.rivalEntities" }],
    registry: registryWith(rival) });
  assert.equal(duplicate.ok, false);
  assert.ok(duplicate.problems.some((problem) => problem.code === RESOLUTION_PROBLEMS.CAPABILITY_OWNERSHIP
    && problem.modules.join() === "thrallo.entities,thrallo.rivalEntities"));

  const declared = defineModule(baseManifest({ id: "thrallo.legacyOnly", status: "qualified", qualification: { basis: "test" },
    conflicts: [{ module: "thrallo.entities", range: "^1.0.0" }] }));
  const conflicting = resolveModules({ bindings: [{ name: "crud" }], requestedModules: [{ id: "thrallo.legacyOnly" }],
    registry: registryWith(declared) });
  assert.ok(conflicting.problems.some((problem) => problem.code === RESOLUTION_PROBLEMS.DECLARED_CONFLICT));

  const retired = defineModule(baseManifest({ id: "thrallo.retired", status: "deprecated" }));
  const deprecated = resolveModules({ requestedModules: [{ id: "thrallo.retired" }], registry: registryWith(retired) });
  assert.ok(deprecated.problems.some((problem) => problem.code === RESOLUTION_PROBLEMS.DEPRECATED));

  const experimental = resolveModules({ requestedModules: [{ id: "thrallo.example" }], registry: registryWith(defineModule(baseManifest())) });
  assert.ok(experimental.problems.some((problem) => problem.code === RESOLUTION_PROBLEMS.UNAVAILABLE && /experimental/.test(problem.message)));
  assert.equal(resolveModules({ requestedModules: [{ id: "thrallo.example" }], registry: registryWith(defineModule(baseManifest())),
    allowExperimental: true }).ok, true);

  const unknown = resolveModules({ bindings: [{ name: "telepathy" }] });
  assert.equal(unknown.problems[0].code, RESOLUTION_PROBLEMS.UNKNOWN_CAPABILITY);
});

test("availability — a missing required service is an explicit configuration-required block, never a fallback", () => {
  const noAuth = declaredAvailability({ backend_sdk: true, entities: true });
  const resolution = resolveModules({ bindings: [{ name: "crud" }, { name: "session" }], availability: noAuth });
  assert.equal(resolution.ok, false);
  const unavailable = configurationRequiredProblems(resolution);
  assert.equal(unavailable.length, 1);
  assert.equal(unavailable[0].code, RESOLUTION_PROBLEMS.UNAVAILABLE);
  assert.equal(unavailable[0].module, "thrallo.identity");
  assert.equal(unavailable[0].service, "app_auth");
  assert.deepEqual(unavailable[0].requestedBy, ["capability:session", "required by thrallo.entities"]);
  // The module is still listed (nothing was silently dropped or substituted).
  assert.ok(resolvedModuleIds(resolution).includes("thrallo.identity"));

  assert.throws(() => declaredAvailability({ teleport: true }), /unknown deployment services/);
  assert.deepEqual(Object.entries(baselineDeploymentAvailability().services).filter(([, on]) => on).map(([id]) => id),
    ["backend_sdk", "app_auth", "entities", "realtime"]);
  const env = availabilityFromEnv({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "anon", THRALLO_APP_SERVICE_STORAGE: "1" });
  assert.equal(env.services.storage, true);
  assert.equal(env.services.payments, false, "optional services are never assumed");
  assert.equal(availabilityFromEnv({}).services.backend_sdk, false);
  const both = intersectAvailability(baselineDeploymentAvailability(), env);
  assert.equal(both.services.storage, false, "a service must be declared by every source");
  assert.equal(both.services.app_auth, true);
});

test("lock — exact versions and artefact hashes; identical input, identical lock; tampering and drift are detected", () => {
  const resolution = resolveModules({ bindings: [{ name: "crud" }, { name: "session" }, { name: "booking", configuration: { entity: "booking" } }] });
  const lock = buildModuleLock({ resolution, contract: CONTRACT, bindings: [{ name: "booking", configuration: { entity: "booking" } }] });
  assert.equal(lock.version, MODULE_LOCK_VERSION);
  assert.equal(lock.legacy, false);
  assert.match(lock.applicationContractHash, /^[0-9a-f]{64}$/);
  for (const row of lock.modules) {
    assert.match(row.artifactHash, /^[0-9a-f]{64}$/, `${row.id} artefact hash`);
    assert.deepEqual(row.missingArtifacts, [], `${row.id} artefacts are all present in the scaffold`);
    assert.match(row.configHash, /^[0-9a-f]{64}$/);
  }
  const again = buildModuleLock({ resolution, contract: CONTRACT, bindings: [{ name: "booking", configuration: { entity: "booking" } }] });
  assert.equal(moduleLockDigest(again), moduleLockDigest(lock));
  const reconfigured = buildModuleLock({ resolution, contract: CONTRACT, bindings: [{ name: "booking", configuration: { entity: "appointment" } }] });
  assert.notEqual(reconfigured.modules.find((row) => row.id === "thrallo.booking").configHash,
    lock.modules.find((row) => row.id === "thrallo.booking").configHash, "configuration is part of the lock");

  // The real scaffold matches its own lock, with or without CRLF line endings.
  assert.deepEqual(verifyModuleLock(REACT_VITE, lock), { ok: true, problems: [] });
  const crlf = Object.fromEntries(Object.entries(REACT_VITE).map(([path, content]) => [path,
    typeof content === "string" ? content.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n") : content]));
  assert.equal(verifyModuleLock(crlf, lock).ok, true, "line endings are a deployment artefact, not an identity");

  // Module tampering: a byte changed inside a protected runtime file is attributed to the module.
  const tampered = { ...REACT_VITE, "src/lib/capabilities/crud.js": `${REACT_VITE["src/lib/capabilities/crud.js"]}\n// tampered\n` };
  const verdict = verifyModuleLock(tampered, lock);
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.problems.map((problem) => [problem.code, problem.module]), [["module_artifact_mismatch", "thrallo.entities"]]);
  assert.deepEqual(verdict.problems[0].paths, ["src/lib/capabilities/crud.js"]);

  // A missing locked artefact is reported by path.
  const stripped = { ...REACT_VITE };
  delete stripped["src/lib/capabilities/session.js"];
  const missing = verifyModuleLock(stripped, lock);
  assert.ok(missing.problems.some((problem) => problem.code === "module_artifact_missing" && problem.path === "src/lib/capabilities/session.js"));
  assert.equal(verifyModuleLock(REACT_VITE, null).problems[0].code, "module_lock_missing");

  const delta = moduleLockDelta(lock, reconfigured);
  assert.deepEqual(delta.changes.map((change) => [change.id, change.change]), [["thrallo.booking", "configuration"]]);
  assert.equal(moduleLockDelta(lock, again).identical, true);
});

test("build spec v4 — the spec carries the resolution and lock; v3 consumers see every old field unchanged", () => {
  assert.equal(BUILD_SPEC_VERSION, 4);
  const spec = deriveBuildSpec(CONTRACT);
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));
  assert.equal(spec.verdict.modules.ok, true);
  // Dependencies first, id tie-break: the exact set the composer emits, interaction primitives included.
  assert.deepEqual(resolvedModuleIds(spec.moduleResolution), [
    "thrallo.core", "thrallo.identity", "thrallo.booking", "thrallo.entities", "thrallo.forms", "thrallo.newsletter", "thrallo.workflow",
  ]);
  assert.deepEqual(spec.compositionPlan.protectedFiles.filter((path) => path.endsWith("lock.js")), [MODULE_LOCK_PATH]);
  assert.equal(spec.contract.moduleLock, spec.moduleLock, "the enriched contract carries the lock so it is persisted with the contract");
  for (const key of ["tiers", "bindings", "modulePlan", "interactionContract", "moduleContracts", "persistencePlan", "imageIntents", "verdict",
    "dependencyPlan", "capabilityGraph", "compositionPlan", "scaffoldGraph", "scaffoldCompositionPlan"]) {
    assert.ok(spec[key], `v3 field ${key} is still present`);
  }
  const summary = buildSpecSummary(spec);
  assert.deepEqual(summary.modules, spec.moduleResolution.modules.map((row) => `${row.id}@${row.version}`));
  assert.equal(summary.moduleLock.modules.length, spec.moduleLock.modules.length);
  // Scoping keeps the lock: an increment never re-resolves modules.
  const scoped = scopeBuildSpec(spec, [CONTRACT.journeys[1]]);
  assert.equal(scoped.moduleLock, spec.moduleLock);
  assert.equal(scoped.scopedContract.moduleLock, spec.moduleLock);
  // Same contract, same lock, twice.
  assert.equal(moduleLockDigest(deriveBuildSpec(CONTRACT).moduleLock), moduleLockDigest(spec.moduleLock));
});

test("build spec v4 — an unavailable required module fails the verdict before generation with a configuration-required problem", () => {
  const authContract = { ...CONTRACT, auth: { required: true } };
  const blocked = deriveBuildSpec(authContract, { availability: declaredAvailability({ backend_sdk: true, entities: true, realtime: true }) });
  assert.equal(blocked.verdict.ok, false);
  assert.equal(blocked.verdict.modules.ok, false);
  assert.equal(blocked.verdict.modules.configurationRequired, true);
  assert.equal(blocked.moduleLock, null, "no lock is minted for an unresolvable module set");
  assert.ok(blocked.verdict.problems.some((problem) => /module_unavailable.*thrallo\.identity.*app_auth/.test(problem)));
  assert.ok(!("moduleLock" in blocked.contract));
  const allowed = deriveBuildSpec(authContract);
  assert.equal(allowed.verdict.modules.ok, true);
});

test("composition — a locked build ships its lock inside the protected root; unlocked trees compose byte-for-byte as before", () => {
  const spec = deriveBuildSpec(CONTRACT);
  const unlocked = composeCapabilityFoundation(REACT_VITE, spec.capabilityGraph);
  assert.equal(MODULE_LOCK_PATH in unlocked.tree, false);
  assert.equal(unlocked.plan.protectedFiles.includes(MODULE_LOCK_PATH), false);
  const locked = composeCapabilityFoundation(REACT_VITE, spec.capabilityGraph, { moduleLock: spec.moduleLock });
  assert.ok(locked.plan.protectedFiles.includes(MODULE_LOCK_PATH));
  assert.ok(isProtectedPath(MODULE_LOCK_PATH), "the lock file is under the write guard");
  assert.deepEqual(moduleLockFromTree(locked.tree), JSON.parse(JSON.stringify(spec.moduleLock)));
  // Every other composed file is identical with or without the lock.
  for (const path of unlocked.plan.protectedFiles) assert.equal(locked.tree[path], unlocked.tree[path], path);
  const withoutLockFile = { ...locked.tree };
  delete withoutLockFile[MODULE_LOCK_PATH];
  assert.match(validateCapabilityComposition(withoutLockFile, spec.capabilityGraph, locked.plan).problems.join(), /lock\.js/);
  assert.equal(validateCapabilityComposition(withoutLockFile, spec.capabilityGraph,
    capabilityCompositionPlan(spec.capabilityGraph)).ok, true, "legacy plans do not demand a lock");
  assert.equal(verifyModuleLock(locked.tree, spec.moduleLock).ok, true);
});

test("provenance — legacy contract digests are unchanged; a lock change invalidates evidence", () => {
  const legacy = { entities: CONTRACT.entities, operations: CONTRACT.operations, routes: CONTRACT.routes, auth: CONTRACT.auth, journeys: CONTRACT.journeys };
  assert.equal(sourceContractDigest(legacy), sourceContractDigest({ ...legacy, moduleLock: null }),
    "a null lock is the same as no lock for historical contracts");
  const spec = deriveBuildSpec(CONTRACT);
  const lockedDigest = sourceContractDigest(spec.contract);
  const otherLock = { ...spec.moduleLock, modules: spec.moduleLock.modules.map((row) => ({ ...row, artifactHash: "0".repeat(64) })) };
  assert.notEqual(lockedDigest, sourceContractDigest({ ...spec.contract, moduleLock: otherLock }));
});

test("old-spec adapter — a v3 spec or persisted contract gains a legacy-flagged lock with the same module set", () => {
  const fresh = deriveBuildSpec(CONTRACT);
  const v3 = { ...fresh, version: 3, moduleLock: undefined, moduleResolution: undefined,
    contract: Object.fromEntries(Object.entries(fresh.contract).filter(([key]) => key !== "moduleLock")) };
  const adapted = lockFromLegacySpec(v3);
  assert.equal(adapted.legacy, true);
  assert.equal(adapted.basis, "host_scaffold");
  assert.deepEqual(adapted.modules.map((row) => `${row.id}@${row.version}`), fresh.moduleLock.modules.map((row) => `${row.id}@${row.version}`));
  assert.deepEqual(adapted.modules.map((row) => row.artifactHash), fresh.moduleLock.modules.map((row) => row.artifactHash));
  // With a snapshot tree the hashes are the snapshot's own bytes.
  const snapshotTree = { ...REACT_VITE, "src/lib/capabilities/crud.js": "// an older crud runtime\n" };
  const fromTree = lockFromLegacySpec(v3, { tree: snapshotTree });
  assert.equal(fromTree.basis, "snapshot_tree");
  assert.notEqual(fromTree.modules.find((row) => row.id === "thrallo.entities").artifactHash,
    adapted.modules.find((row) => row.id === "thrallo.entities").artifactHash);
  assert.equal(lockFromLegacySpec(fresh), fresh.moduleLock, "a spec that already has a lock keeps it");
  // A persisted contract row (the enriched contract carries its capability graph) adapts to the
  // same module set; a bare contract with only its bindings column still adapts, minimally.
  const persisted = { contract: v3.contract };
  assert.deepEqual(lockFromLegacySpec(persisted).modules.map((row) => row.id), adapted.modules.map((row) => row.id));
  const bare = { contract: CONTRACT, bindings: fresh.bindings };
  assert.deepEqual(lockFromLegacySpec(bare).modules.map((row) => row.id),
    ["thrallo.core", "thrallo.identity", "thrallo.booking", "thrallo.entities", "thrallo.newsletter", "thrallo.workflow"],
    "bindings alone omit the graph-added interaction primitives");
  assert.ok(typeof scaffoldArtifactSource("src/lib/capabilities/crud.js") === "string");
});
