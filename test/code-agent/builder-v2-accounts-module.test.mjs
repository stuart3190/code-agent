// WP4 — accounts, authorization and admin users.
//
// Real accounts are platform-owned: the account service derives the actor from the app's user
// mapping and membership rows, enforces the policy (admin allow/deny, cross-app isolation,
// suspension, role change, last-admin protection) and records every command. The contract
// side stops fabricating account records: an account-shaped entity becomes platform-owned, its
// CRUD becomes invite/role/status commands, and a deployment without the accounts service blocks
// before generation with a configuration-required result — never a generated fallback.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import {
  ACTIONS, DEFAULT_POLICY, MEMBER_STATUS, allowedActions, buildPolicy, evaluate, isAdminRole,
} from "../../supabase/functions/app-accounts/policy.js";
import { AccountError, createAccountService, memoryAccountStorage } from "../../supabase/functions/app-accounts/accountService.mjs";
import { accountPolicyFromContract } from "../../shell/server/lib/appAccounts/accountPolicyStore.mjs";
import { PLATFORM_REQUIREMENT_ENFORCEMENT, normalizeContractOwnership } from "../../shell/shared/contractOwnership.mjs";
import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import {
  availabilityFromEnv, baselineDeploymentAvailability, declaredAvailability, legacyDeploymentAvailability,
} from "../../shell/server/lib/builderV2/platformModules/availability.mjs";
import { moduleForCapability, moduleManifest, validateModuleRegistry } from "../../shell/server/lib/builderV2/platformModules/registry.mjs";
import { buildModuleLock, verifyModuleLock } from "../../shell/server/lib/builderV2/platformModules/lock.mjs";
import {
  ACCOUNTS_COMPOSED_PATH, ADMIN_COMPOSED_PATH, APP_FACADE_ACCOUNTS_PATH, APP_FACADE_INDEX_PATH, AUTHORIZATION_COMPOSED_PATH,
  composeCapabilityFoundation, validateCapabilityComposition,
} from "../../shell/server/lib/builderV2/capabilityComposer.mjs";
import { CAPABILITIES } from "../../shell/server/lib/builderV2/capabilityRegistry.mjs";
import { isProtectedPath } from "../../shell/server/lib/builderV2/patchEngine.mjs";
import { createAccountsController, createAdmin, createAuthorization } from "../../src/scaffolds/reactVite/lib/modules/accounts.js";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";

const require = createRequire(new URL("../../harness/.deps/node_modules/", import.meta.url));
const React = require("react");
const { renderToString } = require("react-dom/server");

const WITH_ACCOUNTS = declaredAvailability({ backend_sdk: true, app_auth: true, entities: true, realtime: true, accounts: true });

function twoAppStorage() {
  return memoryAccountStorage({
    mappings: [
      { appId: "app-a", authUserId: "u-admin", email: "admin@a.test", status: "active" },
      { appId: "app-a", authUserId: "u-bob", email: "bob@a.test", status: "active" },
      { appId: "app-a", authUserId: "u-sue", email: "sue@a.test", status: "active" },
      { appId: "app-b", authUserId: "u-other", email: "other@b.test", status: "active" },
    ],
    memberships: [
      { appId: "app-a", email: "admin@a.test", authUserId: "u-admin", role: "admin", status: "active" },
      { appId: "app-a", email: "bob@a.test", authUserId: "u-bob", role: "member", status: "active" },
      { appId: "app-b", email: "other@b.test", authUserId: "u-other", role: "admin", status: "active" },
    ],
  });
}

test("WP4 — policy: grants derive from declared roles, never from a record; own membership is immutable", () => {
  const policy = buildPolicy({ roles: ["Electrician", "Admin"] });
  assert.deepEqual([...policy.roles], ["electrician", "admin"]);
  assert.equal(policy.defaultRole, "electrician");
  assert.deepEqual([...policy.adminRoles], ["admin"]);
  assert.deepEqual([...policy.grants.electrician], ["profile.read", "profile.write"]);
  assert.deepEqual([...policy.grants.admin], [...ACTIONS]);
  const admin = { userId: "u1", email: "a@x", role: "admin", status: MEMBER_STATUS.ACTIVE };
  const member = { userId: "u2", email: "b@x", role: "electrician", status: MEMBER_STATUS.ACTIVE };
  assert.equal(evaluate(policy, admin, "members.role", { target: { userId: "u2" } }).allowed, true);
  assert.deepEqual(evaluate(policy, admin, "members.role", { target: { userId: "u1" } }), { allowed: false, reason: "cannot_change_own_membership" });
  assert.deepEqual(evaluate(policy, member, "members.invite"), { allowed: false, reason: "forbidden" });
  assert.equal(evaluate(policy, member, "profile.write", { target: { userId: "u2" } }).allowed, true, "self profile");
  assert.equal(evaluate(policy, member, "profile.write", { target: { userId: "u1" } }).allowed, false, "another member's profile");
  assert.deepEqual(evaluate(policy, { ...member, status: MEMBER_STATUS.SUSPENDED }, "profile.read"), { allowed: false, reason: "account_suspended" });
  assert.deepEqual(evaluate(policy, null, "profile.read"), { allowed: false, reason: "unauthenticated" });
  assert.deepEqual(allowedActions(policy, member), ["profile.read", "profile.write"]);
  assert.equal(isAdminRole(DEFAULT_POLICY, "admin"), true);
  // A catalogue with no administrative role still gets one, so provisioning is possible.
  assert.deepEqual([...buildPolicy({ roles: ["viewer"] }).adminRoles], ["admin"]);
});

test("WP4 — service: admin allow/deny, cross-app isolation, suspension, role change and last-admin protection", async () => {
  const storage = twoAppStorage();
  const service = createAccountService({ storage, profileFields: ["displayName"] });
  const admin = await service.actorFor("app-a", "u-admin");
  const bob = await service.actorFor("app-a", "u-bob");
  const sue = await service.actorFor("app-a", "u-sue");
  assert.equal(sue.role, "member", "a mapped user with no membership row is an ordinary member");
  // Non-admin denied every admin command; admin allowed.
  await assert.rejects(service.members("app-a", bob), (error) => error instanceof AccountError && error.code === "forbidden" && error.status === 403);
  await assert.rejects(service.invite("app-a", bob, { email: "new@a.test" }), (error) => error.code === "forbidden");
  await assert.rejects(service.setRole("app-a", bob, { email: "sue@a.test", role: "admin" }), (error) => error.code === "forbidden");
  assert.deepEqual((await service.members("app-a", admin)).map((row) => `${row.email}:${row.role}`), ["admin@a.test:admin", "bob@a.test:member"]);
  // Cross-app isolation: app-b's admin is nobody in app-a; app-a's admin is nobody in app-b.
  assert.equal(await service.actorFor("app-a", "u-other"), null);
  assert.equal(await service.actorFor("app-b", "u-admin"), null);
  const other = await service.actorFor("app-b", "u-other");
  await assert.rejects(service.setRole("app-a", other, { email: "bob@a.test", role: "admin" }), (error) => error.code === "unauthenticated" || error.code === "forbidden");
  assert.ok(!(await service.members("app-b", other)).some((row) => row.email.endsWith("@a.test")));
  // Role change is server-authorised and persisted; the actor's permissions follow.
  const promoted = await service.setRole("app-a", admin, { email: "bob@a.test", role: "admin" });
  assert.equal(promoted.role, "admin");
  const bobAgain = await service.actorFor("app-a", "u-bob");
  assert.deepEqual((await service.permissions("app-a", bobAgain)).allowedActions, [...ACTIONS]);
  await assert.rejects(service.setRole("app-a", admin, { email: "admin@a.test", role: "member" }), (error) => error.code === "cannot_change_own_membership");
  await assert.rejects(service.setRole("app-a", admin, { email: "bob@a.test", role: "wizard" }), (error) => error.code === "unknown_role");
  // Suspension denies everything, including me(); reinstatement restores.
  const suspended = await service.setStatus("app-a", admin, { email: "sue@a.test", status: "suspended" });
  assert.equal(suspended.status, "suspended");
  const sueSuspended = await service.actorFor("app-a", "u-sue");
  await assert.rejects(service.me("app-a", sueSuspended), (error) => error.code === "account_suspended");
  await assert.rejects(service.updateMe("app-a", sueSuspended, { displayName: "x" }), (error) => error.code === "account_suspended");
  assert.equal((await service.setStatus("app-a", admin, { email: "sue@a.test", status: "active" })).status, "active");
  // The last administrator cannot be demoted or suspended.
  await service.setRole("app-a", admin, { email: "bob@a.test", role: "member" });
  await assert.rejects(service.setRole("app-a", bobAgain, { email: "admin@a.test", role: "member" }), (error) => ["forbidden", "last_admin"].includes(error.code));
  const bobMember = await service.actorFor("app-a", "u-bob");
  assert.equal(bobMember.role, "member");
  // Every command left an attributed event.
  const actions = storage.state.events.map((row) => row.action);
  assert.ok(actions.includes("members.role") && actions.includes("members.status"));
  assert.ok(storage.state.events.every((row) => row.appId === "app-a" && row.at));
});

test("WP4 — service: profile allow-list, invitations activate on signup, provisioning and member lookup", async () => {
  const storage = twoAppStorage();
  const service = createAccountService({ storage, profileFields: ["displayName", "phone"] });
  const admin = await service.actorFor("app-a", "u-admin");
  const bob = await service.actorFor("app-a", "u-bob");
  const me = await service.me("app-a", bob);
  assert.deepEqual(me.principal, { kind: "member", id: "u-bob", email: "bob@a.test" });
  assert.deepEqual(me.membership, { role: "member", status: "active" });
  assert.deepEqual(me.allowedActions, ["profile.read", "profile.write"]);
  await assert.rejects(service.updateMe("app-a", bob, { role: "admin" }), (error) => error.code === "profile_field_not_allowed",
    "a role can never be written through the profile");
  assert.deepEqual((await service.updateMe("app-a", bob, { displayName: "Bob" })).profile, { displayName: "Bob" });
  assert.deepEqual((await service.me("app-a", await service.actorFor("app-a", "u-bob"))).profile, { displayName: "Bob" }, "reload keeps the profile");
  // Invite: a membership in the invited state until the address signs up.
  const invited = await service.invite("app-a", admin, { email: "New@A.test", role: "member" });
  assert.deepEqual([invited.email, invited.status, invited.invited], ["new@a.test", "invited", true]);
  await assert.rejects(service.invite("app-a", admin, { email: "bob@a.test" }), (error) => error.code === "already_member");
  const activated = await service.activateInvitation("app-a", { email: "new@a.test", authUserId: "u-new" });
  assert.deepEqual([activated.status, activated.userId], ["active", "u-new"]);
  assert.equal(await service.activateInvitation("app-a", { email: "bob@a.test", authUserId: "u-bob" }), null, "only invitations activate");
  // Provision: flagged, admin-only.
  const provisioned = await service.invite("app-a", admin, { email: "ops@a.test", role: "admin", provisioned: true });
  assert.equal(provisioned.provisioned, true);
  await assert.rejects(service.invite("app-a", bob, { email: "x@a.test", provisioned: true }), (error) => error.code === "forbidden");
  // Lookup: a member may read their own membership; reading another's needs members.read.
  assert.equal((await service.member("app-a", bob, { userId: "u-bob" })).role, "member");
  await assert.rejects(service.member("app-a", bob, { email: "admin@a.test" }), (error) => error.code === "forbidden");
  assert.equal((await service.member("app-a", admin, { email: "bob@a.test" })).email, "bob@a.test");
  await assert.rejects(service.member("app-a", admin, { email: "nobody@a.test" }), (error) => error.code === "member_not_found" && error.status === 404);
});

test("WP4 — the client policy copy is byte-identical to the server's, and the migration is additive", async () => {
  const server = await readFile(new URL("../../supabase/functions/app-accounts/policy.js", import.meta.url), "utf8");
  const client = await readFile(new URL("../../src/scaffolds/reactVite/lib/modules/policy.js", import.meta.url), "utf8");
  assert.equal(client, server);
  const migration = await readFile(new URL("../../supabase/migrations/20260918120000_app_accounts_memberships.sql", import.meta.url), "utf8");
  assert.doesNotMatch(migration, /\b(?:drop|truncate|delete from|alter table [^;]* drop)\b/i, "no destructive statement");
  for (const table of ["app_memberships", "app_profiles", "app_membership_events", "app_account_policies"]) {
    assert.match(migration, new RegExp(`create table if not exists public\\.${table}`));
    assert.match(migration, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated`));
  }
  assert.match(migration, /on conflict \(app_id, email\) do nothing/, "the backfill is idempotent");
  assert.match(migration, /'member'/, "backfilled users are ordinary members");
  const edge = await readFile(new URL("../../supabase/functions/app-accounts/index.ts", import.meta.url), "utf8");
  assert.match(edge, /import \{ AccountError, createAccountService \} from "\.\/accountService\.mjs"/);
  const appAuth = await readFile(new URL("../../supabase/functions/app-auth/index.ts", import.meta.url), "utf8");
  assert.match(appAuth, /app_memberships[\s\S]*status: "active"[\s\S]*eq\("status", "invited"\)/, "signup activates an invitation");
});

test("WP4 — contract typing: an account-shaped entity is platform-owned and its CRUD becomes admin/accounts commands", async () => {
  const raw = JSON.parse(await readFile(new URL("./fixtures/retained/medium-20260917-recessed/contract.json", import.meta.url), "utf8"));
  const contract = raw.contract || raw;
  const { contract: typed, report } = normalizeContractOwnership(contract, { buildProfile: contract.buildProfile });
  const appUser = typed.entities.find((entity) => entity.name === "appUser");
  assert.equal(appUser.platform, "accounts");
  assert.equal(appUser.owned, false);
  assert.deepEqual(appUser.fields.map((field) => field.name), ["email", "displayName", "role", "status"], "the vocabulary stays declared");
  assert.deepEqual(report.profileSchema.map((field) => field.name), ["displayName"], "platform fields never become profile data");
  assert.deepEqual(report.accountEntities.map((row) => row.name), ["appUser"]);
  assert.deepEqual(report.accountEntities[0].original, contract.entities.find((entity) => entity.name === "appUser"), "the original is preserved verbatim");
  const byId = Object.fromEntries(typed.operations.map((operation) => [operation.id, operation]));
  assert.deepEqual([byId["create-app-user"].owner, byId["create-app-user"].module, byId["create-app-user"].moduleOperation], ["module", "thrallo.admin", "inviteMember"]);
  assert.deepEqual([byId["update-user-role"].module, byId["update-user-role"].moduleOperation], ["thrallo.admin", "setMemberRole"]);
  assert.deepEqual(byId["update-user-role"].responsibilities, [{ type: "functional", capability: "admin", capabilityMethod: "setMemberRole",
    behavior: "update an app user's role in the admin area", reads: ["email", "role"], writes: [] }]);
  assert.deepEqual(report.retargetedOperations.map((row) => [row.id, row.reason]),
    [["sign-in", "platform_session"], ["create-app-user", "platform_accounts"], ["update-user-role", "platform_accounts"]]);
  const requirements = Object.fromEntries(report.platformRequirements.map((row) => [row.type, row]));
  assert.deepEqual([requirements.accounts.status, requirements.accounts.module, requirements.accounts.enforcement], ["resolved", "thrallo.accounts", "block"]);
  assert.deepEqual([requirements.admin.status, requirements.admin.module], ["resolved", "thrallo.admin"]);
  assert.deepEqual([requirements.authorization.module, requirements.authorization.roles], ["thrallo.authorization", ["Electrician", "Admin"]]);
  assert.equal(PLATFORM_REQUIREMENT_ENFORCEMENT.accounts, "block");
  // The shell records the policy the service enforces: declared roles and the profile fields.
  assert.deepEqual(accountPolicyFromContract(typed), {
    version: 1, roles: ["electrician", "admin"], defaultRole: "electrician", adminRoles: ["admin"],
    grants: { electrician: ["profile.read", "profile.write"], admin: [...ACTIONS] }, profileFields: ["displayName"],
  });
  // Idempotent.
  assert.equal(normalizeContractOwnership(typed).changed, false);
});

test("WP4 — an admin contract blocks before generation on a deployment without the accounts service; with it, no fake account store is composed", async () => {
  const raw = JSON.parse(await readFile(new URL("./fixtures/retained/medium-20260917-recessed/contract.json", import.meta.url), "utf8"));
  const contract = raw.contract || raw;
  // The source baseline can install accounts; a deployment that has not enabled the service
  // (the pre-migration production shape, and what availabilityFromEnv reports without the flag)
  // blocks before generation with a configuration-required result.
  assert.equal(baselineDeploymentAvailability().services.accounts, true);
  assert.equal(legacyDeploymentAvailability().services.accounts, false);
  assert.equal(availabilityFromEnv({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "k" }).services.accounts, false);
  assert.equal(availabilityFromEnv({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "k", THRALLO_APP_SERVICE_ACCOUNTS: "1" }).services.accounts, true);
  const blocked = deriveBuildSpec(contract, { availability: legacyDeploymentAvailability() });
  assert.equal(blocked.verdict.ok, false);
  assert.equal(blocked.verdict.modules.configurationRequired, true);
  assert.ok(blocked.verdict.problems.some((problem) => /module_unavailable.*thrallo\.admin.*"accounts"/.test(problem)));
  assert.equal(blocked.moduleLock, null);
  const spec = deriveBuildSpec(contract, { availability: WITH_ACCOUNTS });
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join(" | "));
  const crud = spec.capabilityGraph.nodes.find((node) => node.id === "capability:crud");
  assert.deepEqual(crud.entities, ["project", "room", "product", "systemSetting"], "no appUser entity store");
  for (const id of ["capability:accounts", "capability:authorization", "capability:admin"]) assert.ok(spec.capabilityGraph.nodes.some((node) => node.id === id), id);
  const customOperations = spec.capabilityGraph.nodes.filter((node) => node.type === "custom_behavior")
    .flatMap((node) => (node.operationResponsibilities || []).map((row) => row.operationId));
  assert.ok(!customOperations.some((id) => /app-user|user-role/.test(id)), `no generated user-management behaviour: ${customOperations.join(",")}`);
  assert.deepEqual(spec.moduleResolution.modules.map((row) => row.id).filter((id) => /accounts|admin|authorization/.test(id)),
    ["thrallo.accounts", "thrallo.authorization", "thrallo.admin"]);
  assert.deepEqual(spec.identityPlan.accountPolicy, { roles: ["electrician", "admin"], profileFields: ["displayName"] });
  const composed = composeCapabilityFoundation(REACT_VITE, spec.capabilityGraph, { moduleLock: spec.moduleLock, identityPlan: spec.identityPlan });
  for (const path of [ACCOUNTS_COMPOSED_PATH, AUTHORIZATION_COMPOSED_PATH, ADMIN_COMPOSED_PATH, APP_FACADE_ACCOUNTS_PATH]) {
    assert.ok(typeof composed.tree[path] === "string", `${path} composed`);
    assert.ok(isProtectedPath(path), `${path} protected`);
  }
  assert.doesNotMatch(composed.tree["src/lib/capabilities/composed/crud.js"], /appUser/);
  assert.match(composed.tree[ACCOUNTS_COMPOSED_PATH], /"roles": \[\s*"electrician",\s*"admin"\s*\]/);
  assert.match(composed.tree[APP_FACADE_INDEX_PATH], /export \* from ".\/accounts.js";/);
  assert.match(composed.tree[APP_FACADE_ACCOUNTS_PATH], /export function useAdminMembers/);
  // Every protected file the plan names is composed; the model-owned custom extensions of this
  // contract's domain journeys are, by design, not present on a bare scaffold.
  const composition = validateCapabilityComposition(composed.tree, spec.capabilityGraph, composed.plan);
  assert.deepEqual(composition.problems.filter((problem) => !/custom behavior extension missing/.test(problem)), []);
  // The lock hashes the accounts runtime; a tampered policy copy is attributed to the module.
  assert.deepEqual(verifyModuleLock(composed.tree, spec.moduleLock), { ok: true, problems: [] });
  const tampered = { ...composed.tree, "src/lib/modules/policy.js": "// tampered\n" };
  assert.ok(verifyModuleLock(tampered, spec.moduleLock).problems.some((problem) => problem.module === "thrallo.accounts" || problem.module === "thrallo.admin"));
});

test("WP4 — registry: accounts, authorization 1.1 (roles retained) and admin are registered, locked and require the accounts service", () => {
  assert.deepEqual(validateModuleRegistry(), { ok: true, problems: [] });
  assert.equal(moduleForCapability("accounts").id, "thrallo.accounts");
  assert.equal(moduleForCapability("admin").id, "thrallo.admin");
  assert.equal(moduleForCapability("roles").version, "1.1.0", "authorization 1.1 also provides the legacy roles capability");
  assert.equal(moduleManifest("thrallo.authorization", ["1.0.0"]).version, "1.0.0", "old locks keep resolving 1.0.0");
  assert.deepEqual(moduleManifest("thrallo.admin").requires.services, ["backend_sdk", "app_auth", "accounts"]);
  assert.deepEqual(moduleManifest("thrallo.authorization").requires.services, [], "the ownership adapter installs everywhere");
  assert.ok(moduleManifest("thrallo.admin").permissions.some((row) => row.id === "members.role"));
  assert.deepEqual(moduleManifest("thrallo.accounts").migrations, [{ id: "20260918120000_app_accounts_memberships", additive: true, destructive: false }]);
  for (const id of ["accounts", "authorization", "admin"]) {
    assert.ok(CAPABILITIES[id], `${id} capability registered`);
    assert.ok(typeof REACT_VITE[CAPABILITIES[id].package] === "string", `${id} runtime ships in the scaffold`);
  }
  const lock = buildModuleLock({ resolution: { ok: true, modules: [{ id: "thrallo.accounts", version: "1.0.0" }] }, contract: {} });
  assert.equal(lock.modules[0].artifactCount, 3);
});

test("WP4 — UI binding: a generated-style admin screen shows and hides controls from server-derived permissions", async () => {
  const { mkdir, writeFile, symlink } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const path = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const { depsNodeModules, workDirFor } = await import("../../harness/workspace.mjs");
  const dir = workDirFor("accounts-ui-binding");
  for (const file of ["src/lib/modules/policy.js", "src/lib/modules/accounts.js", "src/lib/modules/accountsReact.js", "src/lib/capabilities/react.js"]) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), REACT_VITE[file]);
  }
  if (!existsSync(path.join(dir, "node_modules"))) {
    await symlink(depsNodeModules(), path.join(dir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  }
  const hooks = await import(pathToFileURL(path.join(dir, "src/lib/modules/accountsReact.js")).href);
  // A fake accounts SDK backed by the real service and memory storage — the same authority.
  const storage = twoAppStorage();
  const service = createAccountService({ storage, profileFields: ["displayName"] });
  const sdkFor = (userId) => ({
    me: () => service.me("app-a", service.actorFor("app-a", userId).then ? null : null),
  });
  const sdk = (userId) => {
    const actor = () => service.actorFor("app-a", userId);
    return {
      async me() { return service.me("app-a", await actor()); },
      async updateMe(values) { return service.updateMe("app-a", await actor(), values); },
      async member(target) { return service.member("app-a", await actor(), target); },
      async members() { return service.members("app-a", await actor()); },
      async invite(input) { return service.invite("app-a", await actor(), input); },
      async provision(input) { return service.invite("app-a", await actor(), { ...input, provisioned: true }); },
      async setRole(input) { return service.setRole("app-a", await actor(), input); },
      async setStatus(input) { return service.setStatus("app-a", await actor(), input); },
    };
  };
  void sdkFor;
  const policy = buildPolicy({ roles: ["admin", "member"] });
  const Screen = ({ accountsController, authorization, admin }) => {
    const profile = hooks.useProfile(accountsController);
    const permissions = hooks.usePermissions(authorization, accountsController);
    const members = hooks.useAdminMembers(admin);
    if (profile.status !== "ready") return React.createElement("p", { role: "status" }, "Loading your account…");
    return React.createElement("main", null,
      React.createElement("h1", null, `Signed in as ${profile.principal.email} (${permissions.role})`),
      permissions.can("members.invite") ? React.createElement("button", { name: "invite-member" }, "Invite") : null,
      permissions.can("members.read") ? React.createElement("ul", null, (members.members || []).map((row) => React.createElement("li", { key: row.email }, `${row.email}: ${row.role}`))) : React.createElement("p", null, "Members are managed by an administrator."));
  };
  const mount = (userId) => {
    const accountsController = createAccountsController({ accounts: sdk(userId) });
    const authorization = createAuthorization({ policy, accountsController });
    const admin = createAdmin({ accounts: sdk(userId), authorization });
    return { accountsController, authorization, admin, element: React.createElement(Screen, { accountsController, authorization, admin }) };
  };
  const asAdmin = mount("u-admin");
  assert.match(renderToString(asAdmin.element), /Loading your account/);
  await asAdmin.accountsController.ensure();
  await asAdmin.admin.listMembers();
  const adminHtml = renderToString(asAdmin.element);
  assert.match(adminHtml, /Signed in as admin@a\.test \(admin\)/);
  assert.match(adminHtml, /name="invite-member"/);
  assert.match(adminHtml, /bob@a\.test: member/);
  const asBob = mount("u-bob");
  await asBob.accountsController.ensure();
  await assert.rejects(asBob.admin.listMembers(), (error) => error.code === "forbidden", "the client gate mirrors the server denial");
  const bobHtml = renderToString(asBob.element);
  assert.match(bobHtml, /Signed in as bob@a\.test \(member\)/);
  assert.doesNotMatch(bobHtml, /name="invite-member"/);
  assert.match(bobHtml, /managed by an administrator/);
  // A role written through the profile is refused by the service, so the client cannot escalate.
  await assert.rejects(asBob.accountsController.updateMe({ role: "admin" }), (error) => error.code === "profile_field_not_allowed");
});
