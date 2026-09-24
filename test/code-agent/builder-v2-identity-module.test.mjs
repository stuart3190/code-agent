// WP3 — the identity/session vertical slice.
//
// One deterministic session controller owns sign-in, sign-up, sign-out, reset, reload recovery
// and expiry with an explicit state vocabulary; a visitor never satisfies a member requirement;
// the composer renders it per application from the identity plan and exposes it through the
// public application facade; generated code that reaches past the facade is caught by the ABI
// lint; the legacy session capability keeps its exports; retained trees compose unchanged.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

import {
  IDENTITY_ERROR, IDENTITY_MODE, SESSION_STATUS, classifyIdentityError, createIdentityController, identityGuard,
} from "../../src/scaffolds/reactVite/lib/modules/identity.js";
import { deriveIdentityPlan, identityVerificationPlan, validateIdentityPlan } from "../../shell/server/lib/builderV2/platformModules/identityPlan.mjs";
import { MODULE_REGISTRY, moduleForCapability, moduleManifest, validateModuleRegistry } from "../../shell/server/lib/builderV2/platformModules/registry.mjs";
import { resolveModules } from "../../shell/server/lib/builderV2/platformModules/resolver.mjs";
import { buildModuleLock, verifyModuleLock } from "../../shell/server/lib/builderV2/platformModules/lock.mjs";
import { ABI_ENFORCEMENT, lintPlatformAbi } from "../../shell/server/lib/builderV2/platformModules/abiLint.mjs";
import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import {
  APP_FACADE_IDENTITY_PATH, APP_FACADE_INDEX_PATH, IDENTITY_COMPOSED_PATH, MODULE_LOCK_PATH,
  composeCapabilityFoundation, validateCapabilityComposition,
} from "../../shell/server/lib/builderV2/capabilityComposer.mjs";
import { isProtectedPath } from "../../shell/server/lib/builderV2/patchEngine.mjs";
import { validateModuleConformance } from "../../shell/server/lib/builderV2/moduleContracts.mjs";
import { partitionFindings, severityOf } from "../../shell/server/lib/builderV2/validationSeverity.mjs";
import { CAPABILITIES } from "../../shell/server/lib/builderV2/capabilityRegistry.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";

// The scaffold's own React, as every generated application resolves it.
const require = createRequire(new URL("../../harness/.deps/node_modules/", import.meta.url));
const React = require("react");
const { renderToString } = require("react-dom/server");

/** A fake backend auth SDK with a persistent "browser" so a fresh controller can recover a session. */
function fakeAuth({ storage = new Map(), users = new Map(), failures = {} } = {}) {
  const principal = (email) => ({ id: `user-${email}`, email });
  const auth = {
    calls: [],
    async signUp({ email, password }) {
      auth.calls.push("signUp");
      if (users.has(email)) throw Object.assign(new Error("User already registered"), { status: 409 });
      users.set(email, password);
      storage.set("session", email);
      return principal(email);
    },
    async signIn({ email, password }) {
      auth.calls.push("signIn");
      if (failures.signIn) throw failures.signIn;
      if (users.get(email) !== password) throw Object.assign(new Error("Invalid login credentials"), { status: 401 });
      storage.set("session", email);
      return principal(email);
    },
    async signOut() { auth.calls.push("signOut"); storage.delete("session"); },
    async currentUser() {
      auth.calls.push("currentUser");
      if (failures.currentUser) throw failures.currentUser;
      const email = storage.get("session");
      return email ? principal(email) : null;
    },
    async resetPassword({ email }) { auth.calls.push("resetPassword"); storage.set(`reset:${email}`, "123456"); },
    async confirmReset({ email, code, newPassword }) {
      auth.calls.push("confirmReset");
      if (storage.get(`reset:${email}`) !== code) throw new Error("invalid code");
      users.set(email, newPassword);
      storage.set("session", email);
      return principal(email);
    },
  };
  return { auth, storage, users };
}

const visitor = async () => ({ id: "visitor-1" });

test("WP3 — the controller walks the explicit session states: sign up, sign in, sign out, reset", async () => {
  const { auth } = fakeAuth();
  const identity = createIdentityController({ auth, mode: IDENTITY_MODE.MEMBER });
  const seen = [];
  identity.subscribe((state) => seen.push(state.status));
  assert.equal(identity.getState().status, SESSION_STATUS.INITIALIZING);
  assert.equal((await identity.ensure()).status, SESSION_STATUS.SIGNED_OUT);
  assert.equal(await identity.ensure(), identity.getState(), "ensure is idempotent once resolved");
  const signedUp = await identity.signUp({ email: "a@x.test", password: "pw-1" });
  assert.deepEqual(signedUp.principal, { kind: "member", id: "user-a@x.test", email: "a@x.test" });
  assert.equal((await identity.signOut()).status, SESSION_STATUS.SIGNED_OUT);
  await assert.rejects(identity.signIn({ email: "a@x.test", password: "wrong" }), (error) => error.code === IDENTITY_ERROR.INVALID_CREDENTIALS);
  assert.equal(identity.getState().status, SESSION_STATUS.SIGNED_OUT, "a failed sign-in changes nothing");
  assert.equal((await identity.signIn({ email: "a@x.test", password: "pw-1" })).status, SESSION_STATUS.SIGNED_IN);
  assert.deepEqual(await identity.resetPassword({ email: "a@x.test" }), { resetRequested: true });
  assert.equal((await identity.confirmReset({ email: "a@x.test", code: "123456", newPassword: "pw-2" })).status, SESSION_STATUS.SIGNED_IN);
  await assert.rejects(identity.confirmReset({ email: "a@x.test", code: "000000", newPassword: "pw-3" }), (error) => error.code === IDENTITY_ERROR.INVALID_CODE);
  assert.deepEqual(seen, ["signed_out", "signed_in", "signed_out", "signed_in"], "one emission per real transition");
  assert.equal(Object.isFrozen(identity.getState()), true);
  assert.ok(!JSON.stringify(identity.getState()).includes("pw-"), "no credential ever enters state");
});

test("WP3 — reload keeps the same canonical principal; expiry is explicit and recoverable", async () => {
  const browser = fakeAuth();
  const first = createIdentityController({ auth: browser.auth });
  await first.signUp({ email: "b@x.test", password: "pw" });
  // A reload: a new controller over the same persisted session.
  const reloaded = createIdentityController({ auth: browser.auth });
  const recovered = await reloaded.ensure();
  assert.equal(recovered.status, SESSION_STATUS.SIGNED_IN);
  assert.deepEqual(recovered.principal, first.getState().principal, "the same durable identity after reload");
  // Expiry: the backend no longer knows the member.
  browser.storage.delete("session");
  assert.equal((await reloaded.recover()).status, SESSION_STATUS.EXPIRED);
  assert.equal(identityGuard(reloaded.getState()).allowed, false);
  // markExpired from a protected call's 401, then ensure() re-establishes.
  const again = createIdentityController({ auth: browser.auth });
  await again.signIn({ email: "b@x.test", password: "pw" });
  assert.equal(again.markExpired().status, SESSION_STATUS.EXPIRED);
  assert.equal((await again.ensure()).status, SESSION_STATUS.SIGNED_IN, "ensure() after expiry recovers the still-valid backend session");
  // A backend error surfaces as an error state, never as a fake signed-out.
  const broken = createIdentityController({ auth: fakeAuth({ failures: { currentUser: new Error("Backend is not configured") } }).auth });
  const errored = await broken.ensure();
  assert.equal(errored.status, SESSION_STATUS.ERROR);
  assert.equal(errored.error.code, IDENTITY_ERROR.BACKEND_UNAVAILABLE);
});

test("WP3 — a visitor session never satisfies a member requirement; visitor mode re-establishes after sign-out", async () => {
  const identity = createIdentityController({ auth: fakeAuth().auth, ensureVisitorSession: visitor, mode: IDENTITY_MODE.VISITOR });
  const state = await identity.ensure();
  assert.deepEqual(state, { status: "visitor", principal: { kind: "visitor", id: "visitor-1" } });
  assert.deepEqual(identityGuard(state, "member"), { allowed: false, reason: IDENTITY_ERROR.MEMBER_REQUIRED });
  assert.deepEqual(identityGuard(state, "visitor"), { allowed: true, reason: null });
  assert.throws(() => identity.requireMember(), (error) => error.code === IDENTITY_ERROR.MEMBER_REQUIRED);
  await identity.signUp({ email: "c@x.test", password: "pw" });
  assert.equal(identity.requireMember().kind, "member");
  assert.equal((await identity.signOut()).status, SESSION_STATUS.VISITOR, "persistence keeps a visitor identity after sign-out");
  assert.deepEqual(identityGuard({ status: "initializing" }), { allowed: false, reason: "initializing", pending: true });
  assert.equal(classifyIdentityError({ status: 401 }, { operation: "signIn" }).code, IDENTITY_ERROR.INVALID_CREDENTIALS);
  assert.equal(classifyIdentityError(new Error("JWT expired")).code, IDENTITY_ERROR.SESSION_EXPIRED);
});

test("WP3 — the identity plan is derived from the typed contract: mode, methods, protected routes, redirects, probes", () => {
  const member = deriveIdentityPlan({
    auth: { required: true },
    routes: [{ path: "/signin", name: "Sign in" }, { path: "/workspace", name: "Workspace", auth: true }, { path: "/settings", name: "Settings", auth: true }],
    operations: [
      { id: "sign-in", owner: "module", module: "thrallo.identity", moduleOperation: "signIn" },
      { id: "sign-out", owner: "module", module: "thrallo.identity", moduleOperation: "signOut" },
      { id: "create-plan", owner: "module", module: "thrallo.entities", moduleOperation: "create" },
    ],
  });
  assert.equal(member.mode, "member");
  assert.deepEqual(member.methods, ["ensure", "current", "signIn", "signOut"]);
  assert.deepEqual(member.protectedRoutes, ["/workspace", "/settings"]);
  assert.deepEqual(member.redirect, { signedOut: "/signin", signedIn: "/workspace" });
  assert.deepEqual(member.verification.map((probe) => probe.id),
    ["session.initial", "session.signIn", "session.reload", "session.expiry", "session.signOut", "session.visitorDenied"]);
  assert.equal(validateIdentityPlan(member).ok, true);
  const visitorPlan = deriveIdentityPlan({ auth: { required: false }, routes: [{ path: "/", name: "Home" }], operations: [] });
  assert.deepEqual([visitorPlan.mode, visitorPlan.redirect, visitorPlan.verification[0].expect], ["visitor", { signedOut: null, signedIn: null }, "visitor"]);
  assert.deepEqual(identityVerificationPlan({ mode: "member", methods: ["signUp", "resetPassword", "confirmReset"] }).map((probe) => probe.id),
    ["session.initial", "session.signUp", "session.reload", "session.expiry", "session.resetPassword", "session.confirmReset"]);
});

test("WP3 — identity 1.2.0 is registered beside 1.1.0; resolution picks it and the lock hashes the new runtime", () => {
  assert.deepEqual(validateModuleRegistry(), { ok: true, problems: [] });
  assert.deepEqual(MODULE_REGISTRY["thrallo.identity"].map((row) => row.version), ["1.1.0", "1.2.0"]);
  assert.equal(moduleManifest("thrallo.identity", ["^1.1.0"]).version, "1.2.0");
  assert.equal(moduleManifest("thrallo.identity", ["1.1.0"]).version, "1.1.0", "an old lock still resolves its exact version");
  assert.equal(moduleForCapability("session").version, "1.2.0");
  const resolution = resolveModules({ bindings: [{ name: "session", version: CAPABILITIES.session.version }] });
  assert.equal(resolution.modules.find((row) => row.id === "thrallo.identity").version, "1.2.0");
  const lock = buildModuleLock({ resolution, contract: { entities: [], routes: [] } });
  const identity = lock.modules.find((row) => row.id === "thrallo.identity");
  assert.equal(identity.artifactCount, 3, "session.js + identity.js + identityReact.js");
  assert.deepEqual(verifyModuleLock(REACT_VITE, lock), { ok: true, problems: [] });
  const tampered = { ...REACT_VITE, "src/lib/modules/identity.js": "// tampered\n" };
  assert.equal(verifyModuleLock(tampered, lock).problems[0].module, "thrallo.identity");
  // The legacy session capability is untouched: same exports, still protected.
  assert.deepEqual(CAPABILITIES.session.interface, ["ensureSession", "ensureVisitorSession", "currentUser", "signUp", "signIn", "signOut", "resetPassword", "confirmReset"]);
  for (const path of ["src/lib/modules/identity.js", "src/lib/modules/identityReact.js", "src/lib/app/index.js", "src/lib/capabilities/session.js"]) {
    assert.equal(isProtectedPath(path), true, path);
  }
});

const CONTRACT = {
  summary: "Lumen Layouts floor planner with accounts", projectType: "tool", version: 2,
  auth: { required: true, model: "email + password via the backend SDK", rules: [] },
  routes: [{ path: "/signin", name: "Sign in" }, { path: "/workspace", name: "Workspace", auth: true }],
  entities: [{ name: "plan", owned: true, fields: [{ name: "name", type: "string", required: true }] }],
  operations: [
    { id: "sign-in", kind: "signIn", journey: "create-plan", description: "sign in or create the account",
      responsibilities: [{ type: "functional", capability: "session", capabilityMethod: "signIn", behavior: "establish the platform session", reads: ["authEmail", "authPassword"], writes: [] }] },
    { id: "sign-out", kind: "signOut", journey: "create-plan", description: "sign out",
      responsibilities: [{ type: "functional", capability: "session", capabilityMethod: "signOut", behavior: "end the platform session", reads: [], writes: [] }] },
    { id: "create-plan", entity: "plan", kind: "create", journey: "create-plan", description: "persist a plan",
      responsibilities: [{ type: "persistence", capability: "crud", capabilityMethod: "create", reads: ["name"], writes: ["name"] }] },
  ],
  journeys: [{ id: "create-plan", title: "A user signs in and creates a plan", priority: "primary", stage: "primary_journey", steps: [
    { action: "open the sign-in route", target: "/signin", expect: "the sign-in panel is visible" },
    { action: "sign in with email and password", target: "authentication form", operates: ["authEmail", "authPassword", "sign-in"], expect: "the workspace is visible" },
    { action: "create a named plan", target: "new plan form", operates: ["name", "create-plan"], expect: "the plan name appears" },
    { action: "sign out", target: "sign out control", operates: ["sign-out"], expect: "the sign-in panel is visible" },
  ], acceptance: ["a created plan survives reload"] }],
  acceptance: [
    { id: "a1", statement: "a created plan survives a reload", journey: "create-plan", kind: "persistence" },
    { id: "a2", statement: "signing in shows the workspace", journey: "create-plan", kind: "behavior" },
    { id: "a3", statement: "signing out returns to the sign-in panel", journey: "create-plan", kind: "behavior" },
  ],
  states: [], integrations: [], deferred: [],
};

test("WP3 — the composer renders the identity controller and the public facade from the plan; retained trees compose unchanged", async () => {
  const spec = deriveBuildSpec(CONTRACT);
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));
  assert.equal(spec.identityPlan.mode, "member");
  assert.ok(spec.compositionPlan.protectedFiles.includes(IDENTITY_COMPOSED_PATH));
  assert.ok(spec.compositionPlan.protectedFiles.includes(APP_FACADE_INDEX_PATH));
  const composed = composeCapabilityFoundation(REACT_VITE, spec.capabilityGraph, { moduleLock: spec.moduleLock, identityPlan: spec.identityPlan });
  for (const path of [IDENTITY_COMPOSED_PATH, APP_FACADE_INDEX_PATH, APP_FACADE_IDENTITY_PATH, MODULE_LOCK_PATH]) {
    assert.ok(typeof composed.tree[path] === "string", `${path} composed`);
  }
  assert.match(composed.tree[IDENTITY_COMPOSED_PATH], /mode: identityPlan\.mode/);
  assert.match(composed.tree[IDENTITY_COMPOSED_PATH], /"mode": "member"/);
  assert.match(composed.tree[APP_FACADE_INDEX_PATH], /THRALLO_APP_ABI/);
  assert.match(composed.tree["src/lib/capabilities/composed/index.js"], /export \* from ".\/identity.js";/);
  assert.equal(validateCapabilityComposition(composed.tree, spec.capabilityGraph, composed.plan).ok, true);
  // The composed identity module is byte-stable for the same spec.
  const again = composeCapabilityFoundation(REACT_VITE, spec.capabilityGraph, { moduleLock: spec.moduleLock, identityPlan: spec.identityPlan });
  assert.equal(again.tree[IDENTITY_COMPOSED_PATH], composed.tree[IDENTITY_COMPOSED_PATH]);
  // A retained foundation tree (no module runtime) composes exactly as before: no identity files.
  const retained = JSON.parse(await readFile(new URL("./fixtures/retained/medium-20260917-recessed/tree-foundation-scaffold-77c68fda.json", import.meta.url), "utf8"));
  const legacy = composeCapabilityFoundation(retained, spec.capabilityGraph, { moduleLock: spec.moduleLock, identityPlan: spec.identityPlan });
  assert.equal(IDENTITY_COMPOSED_PATH in legacy.tree, false);
  assert.equal(APP_FACADE_INDEX_PATH in legacy.tree, false);
  assert.equal(legacy.plan.protectedFiles.includes(IDENTITY_COMPOSED_PATH), false, "the plan describes what was actually composed");
});

test("WP3 — UI binding: a generated-style screen renders every session state through the facade hooks", async () => {
  // Evaluate the SHIPPED hook module the way a generated application resolves it: materialised
  // beside the scaffold's shared node_modules so "react" resolves to the one React the app uses.
  const { mkdir, writeFile, symlink } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const path = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const { depsNodeModules, workDirFor } = await import("../../harness/workspace.mjs");
  const dir = workDirFor("identity-ui-binding");
  for (const file of ["src/lib/modules/identity.js", "src/lib/modules/identityReact.js", "src/lib/capabilities/react.js"]) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), REACT_VITE[file]);
  }
  if (!existsSync(path.join(dir, "node_modules"))) {
    await symlink(depsNodeModules(), path.join(dir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  }
  const identityReact = await import(pathToFileURL(path.join(dir, "src/lib/modules/identityReact.js")).href);
  // The screen below is deliberately application-shaped: its markup and copy are its own; only
  // the hooks are the platform's.
  const { auth } = fakeAuth();
  const identity = createIdentityController({ auth, mode: IDENTITY_MODE.MEMBER });
  const Screen = () => {
    const session = identityReact.useIdentityState(identity);
    const guard = identityReact.useIdentityGuard(identity, "member");
    if (session.status === "initializing") return React.createElement("p", { role: "status" }, "Checking your session…");
    if (guard.allowed) return React.createElement("main", null, React.createElement("h1", null, `Welcome ${session.principal.email}`));
    return React.createElement("form", { "aria-label": "authentication form" },
      React.createElement("p", { role: "status" }, session.status === "expired" ? "Your session expired" : "Please sign in"));
  };
  assert.match(renderToString(React.createElement(Screen)), /Checking your session/);
  await identity.ensure();
  assert.match(renderToString(React.createElement(Screen)), /Please sign in/);
  await identity.signUp({ email: "ui@x.test", password: "pw" });
  assert.match(renderToString(React.createElement(Screen)), /Welcome ui@x\.test/);
  identity.markExpired();
  assert.match(renderToString(React.createElement(Screen)), /Your session expired/);
});

test("WP3 — the ABI lint blocks private platform imports on a locked tree, reports them on a legacy tree, and flags session orchestration", () => {
  const spec = deriveBuildSpec(CONTRACT);
  const composed = composeCapabilityFoundation(REACT_VITE, spec.capabilityGraph, { moduleLock: spec.moduleLock, identityPlan: spec.identityPlan }).tree;
  const offending = {
    ...composed,
    "src/screens/scaffold/SignInScreen.jsx": `import { auth } from "../../lib/backend/index.js";\nimport { ensureVisitorSession } from "../../lib/visitorSession.js";\nexport default function SignInScreen() { return null; }\n`,
    "src/screens/scaffold/WorkspaceScreen.jsx": `import { useSession } from "../../lib/app/index.js";\nimport { signIn } from "../../lib/capabilities/composed/index.js";\nexport default function W() { const s = useSession(); return null; }\n`,
    "src/screens/scaffold/Legacy.jsx": `import { auth } from "../../lib/backend";\nexport default function L() { auth.signIn({ email: "", password: "" }); return null; }\n`,
    "src/screens/scaffold/Internals.jsx": `import { createIdentityController } from "../../lib/modules/identity.js";\nexport default function I() { return null; }\n`,
  };
  const locked = lintPlatformAbi(offending, { locked: true });
  const byFile = (findings, file) => findings.filter((row) => row.module === file).map((row) => row.code);
  // Module internals were never a taught surface: blocking on a locked tree. The backend SDK is
  // still what the prompt teaches until WP14 re-teaches the facade: reported, not enforced yet.
  assert.deepEqual(ABI_ENFORCEMENT, { modules: "block", backend: "warn", visitorSession: "warn" });
  assert.deepEqual(byFile(locked.findings, "src/screens/scaffold/Internals.jsx"), ["private_platform_import"]);
  assert.deepEqual(byFile(locked.findings, "src/screens/scaffold/SignInScreen.jsx"), ["private_platform_import_legacy", "private_platform_import_legacy"]);
  assert.deepEqual(byFile(locked.findings, "src/screens/scaffold/WorkspaceScreen.jsx"), [], "facade and composed imports are public");
  assert.deepEqual(byFile(locked.findings, "src/screens/scaffold/Legacy.jsx"), ["private_platform_import_legacy", "generated_session_orchestration"]);
  assert.equal(severityOf("private_platform_import"), "blocking");
  assert.equal(severityOf("private_platform_import_legacy"), "advisory");
  assert.equal(severityOf("generated_session_orchestration"), "advisory");
  const legacy = lintPlatformAbi(offending, { locked: false });
  assert.ok(legacy.findings.every((row) => row.code !== "private_platform_import"), "nothing blocks on an unlocked tree");
  // Protected files are never linted: the composed identity module imports the backend by design.
  assert.equal(locked.findings.some((row) => row.module === IDENTITY_COMPOSED_PATH), false);
  // Through the conformance validator, on a locked tree, the private import blocks.
  const conformance = validateModuleConformance(offending, { contract: spec.contract, modulePlan: spec.modulePlan,
    moduleContracts: spec.moduleContracts, interactionContract: spec.interactionContract, bindings: spec.bindings, capabilityGraph: spec.capabilityGraph });
  assert.ok((conformance.blocking || []).some((row) => row.code === "private_platform_import"), JSON.stringify(conformance.blocking?.map((row) => row.code)));
  const withoutLock = { ...offending };
  delete withoutLock[MODULE_LOCK_PATH];
  const legacyConformance = validateModuleConformance(withoutLock, { contract: spec.contract, modulePlan: spec.modulePlan,
    moduleContracts: spec.moduleContracts, interactionContract: spec.interactionContract, bindings: spec.bindings, capabilityGraph: spec.capabilityGraph });
  assert.equal((legacyConformance.blocking || []).some((row) => row.code === "private_platform_import"), false);
  assert.ok(partitionFindings(legacyConformance.advisory || []).advisory.some((row) => row.code === "private_platform_import_legacy"));
});
