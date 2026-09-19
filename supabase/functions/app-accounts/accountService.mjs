// Application account service — the one authority for profiles, memberships and admin commands.
//
// Pure ESM over a storage seam so the same logic runs in the app-accounts Edge Function (Deno,
// service-role Supabase storage) and in the shell/tests (Node, memory storage). Every operation
// is app-scoped: the actor is derived from the app's user mapping and membership, never from
// anything the client sends. Denials are typed errors with an HTTP status.

import { DEFAULT_POLICY, MEMBER_STATUS, allowedActions, evaluate, isAdminRole } from "./policy.js";

export const ACCOUNT_SERVICE_VERSION = 1;

export class AccountError extends Error {
  constructor(code, message, status = 403, details = null) {
    super(message);
    this.code = code;
    this.status = status;
    if (details) this.details = details;
  }
}

const lower = (value) => String(value || "").trim().toLowerCase();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** In-memory storage twin (tests, shell previews). Rows are plain objects keyed by app. */
export function memoryAccountStorage({ mappings = [], memberships = [], profiles = [], policies = {} } = {}) {
  const state = {
    mappings: mappings.map((row) => ({ ...row, email: lower(row.email) })),
    memberships: memberships.map((row) => ({ ...row, email: lower(row.email) })),
    profiles: [...profiles],
    events: [],
    policies: { ...policies },
  };
  const byApp = (rows, appId) => rows.filter((row) => row.appId === appId);
  return {
    state,
    async getMapping(appId, { authUserId = null, email = null } = {}) {
      return byApp(state.mappings, appId).find((row) => (authUserId && row.authUserId === authUserId) || (email && row.email === lower(email))) || null;
    },
    async getMembership(appId, { authUserId = null, email = null } = {}) {
      return byApp(state.memberships, appId).find((row) => (authUserId && row.authUserId === authUserId) || (email && row.email === lower(email))) || null;
    },
    async listMemberships(appId) { return byApp(state.memberships, appId).map((row) => ({ ...row })); },
    async upsertMembership(row) {
      const email = lower(row.email);
      const index = state.memberships.findIndex((candidate) => candidate.appId === row.appId && candidate.email === email);
      const next = { ...(index >= 0 ? state.memberships[index] : {}), ...row, email };
      if (index >= 0) state.memberships[index] = next; else state.memberships.push(next);
      return { ...next };
    },
    async getProfile(appId, authUserId) {
      return state.profiles.find((row) => row.appId === appId && row.authUserId === authUserId)?.data || null;
    },
    async setProfile(appId, authUserId, data) {
      const index = state.profiles.findIndex((row) => row.appId === appId && row.authUserId === authUserId);
      const next = { appId, authUserId, data: { ...data } };
      if (index >= 0) state.profiles[index] = next; else state.profiles.push(next);
      return { ...next.data };
    },
    async appendEvent(row) { state.events.push({ ...row }); return row; },
    async getPolicy(appId) { return state.policies[appId] || null; },
  };
}

/**
 * @param {object} options
 * @param {object} options.storage the storage seam
 * @param {object} [options.policy] the app's account policy (falls back to storage.getPolicy, then DEFAULT_POLICY)
 * @param {string[]} [options.profileFields] allow-listed self-editable profile fields
 * @param {() => string} [options.now]
 */
export function createAccountService({ storage, policy = null, profileFields = ["displayName"], now = () => new Date().toISOString() } = {}) {
  if (!storage) throw new Error("createAccountService: storage is required");

  async function policyFor(appId) {
    return policy || (await storage.getPolicy?.(appId)) || DEFAULT_POLICY;
  }

  const membershipView = (row) => ({
    userId: row.authUserId || null, email: row.email, role: row.role, status: row.status,
    invited: row.status === MEMBER_STATUS.INVITED, provisioned: row.provisioned === true,
    createdAt: row.createdAt || null, updatedAt: row.updatedAt || null,
  });

  /** The actor for an authenticated app user: mapping + membership (implicit member when no row). */
  async function actorFor(appId, authUserId) {
    if (!appId || !authUserId) return null;
    const mapping = await storage.getMapping(appId, { authUserId });
    if (!mapping) return null; // a user of another app is nobody here (cross-app isolation)
    const active = await policyFor(appId);
    const membership = await storage.getMembership(appId, { authUserId })
      || await storage.getMembership(appId, { email: mapping.email });
    const status = mapping.status !== "active" ? MEMBER_STATUS.SUSPENDED
      : membership ? membership.status : MEMBER_STATUS.ACTIVE;
    return {
      appId, userId: authUserId, email: mapping.email,
      role: membership?.role || active.defaultRole, status,
    };
  }

  const require = (policyValue, actor, action, target = null, appId = null) => {
    // An actor is only ever an actor of the application it was derived for; a membership of one
    // application grants nothing in another, whatever object a caller holds.
    if (actor && appId && actor.appId !== appId) {
      throw new AccountError("unauthenticated", "Sign in to this application first.", 401, { action });
    }
    const decision = evaluate(policyValue, actor, action, { target });
    if (!decision.allowed) {
      const status = decision.reason === "unauthenticated" ? 401 : 403;
      throw new AccountError(decision.reason || "forbidden", `Not allowed: ${action} (${decision.reason})`, status, { action });
    }
    return decision;
  };

  async function record(appId, actor, action, target, before, after) {
    await storage.appendEvent({
      appId, action, actorUserId: actor?.userId || null, actorEmail: actor?.email || null,
      targetEmail: target?.email || null, targetUserId: target?.authUserId || target?.userId || null,
      before: before ? { role: before.role, status: before.status } : null,
      after: after ? { role: after.role, status: after.status } : null,
      at: now(),
    });
  }

  async function targetMembership(appId, { userId = null, email = null } = {}) {
    if (!userId && !email) throw new AccountError("invalid_target", "userId or email is required", 400);
    const membership = await storage.getMembership(appId, { authUserId: userId, email });
    if (membership) return membership;
    const mapping = await storage.getMapping(appId, { authUserId: userId, email });
    if (!mapping) throw new AccountError("member_not_found", "No such member of this application", 404);
    const active = await policyFor(appId);
    return { appId, email: mapping.email, authUserId: mapping.authUserId, role: active.defaultRole,
      status: mapping.status === "active" ? MEMBER_STATUS.ACTIVE : MEMBER_STATUS.SUSPENDED, implicit: true };
  }

  return {
    version: ACCOUNT_SERVICE_VERSION,
    actorFor,
    policyFor,

    async me(appId, actor) {
      const active = await policyFor(appId);
      require(active, actor, "profile.read", null, appId);
      const profile = (await storage.getProfile(appId, actor.userId)) || {};
      return {
        principal: { kind: "member", id: actor.userId, email: actor.email },
        membership: { role: actor.role, status: actor.status },
        profile, profileFields: [...profileFields],
        allowedActions: allowedActions(active, actor),
      };
    },

    async updateMe(appId, actor, values = {}) {
      const active = await policyFor(appId);
      require(active, actor, "profile.write", null, appId);
      const current = (await storage.getProfile(appId, actor.userId)) || {};
      const rejected = Object.keys(values || {}).filter((key) => !profileFields.includes(key));
      if (rejected.length) throw new AccountError("profile_field_not_allowed", `Profile fields not allowed: ${rejected.join(", ")}`, 400, { rejected });
      const next = { ...current, ...values };
      const profile = await storage.setProfile(appId, actor.userId, next);
      await record(appId, actor, "profile.update", { userId: actor.userId, email: actor.email }, null, null);
      return { profile, profileFields: [...profileFields] };
    },

    async permissions(appId, actor) {
      const active = await policyFor(appId);
      if (!actor) throw new AccountError("unauthenticated", "Sign in to this app first.", 401);
      return { role: actor.role, status: actor.status, roles: [...active.roles], allowedActions: allowedActions(active, actor) };
    },

    async member(appId, actor, target) {
      const active = await policyFor(appId);
      const row = await targetMembership(appId, target);
      if (row.authUserId !== actor?.userId) require(active, actor, "members.read", null, appId);
      else require(active, actor, "profile.read", null, appId);
      return membershipView(row);
    },

    async members(appId, actor) {
      const active = await policyFor(appId);
      require(active, actor, "members.read", null, appId);
      const rows = await storage.listMemberships(appId);
      return rows.map(membershipView).sort((a, b) => a.email.localeCompare(b.email));
    },

    async invite(appId, actor, { email, role = null, provisioned = false } = {}) {
      const active = await policyFor(appId);
      require(active, actor, provisioned ? "members.provision" : "members.invite", null, appId);
      const address = lower(email);
      if (!EMAIL.test(address)) throw new AccountError("invalid_email", "A valid email is required", 400);
      const wanted = lower(role || active.defaultRole);
      if (!active.roles.includes(wanted)) throw new AccountError("unknown_role", `Role "${role}" is not declared for this application`, 400, { roles: [...active.roles] });
      const existing = await storage.getMembership(appId, { email: address });
      if (existing && existing.status !== MEMBER_STATUS.INVITED) {
        throw new AccountError("already_member", "This person is already a member", 409);
      }
      const mapping = await storage.getMapping(appId, { email: address });
      const row = await storage.upsertMembership({
        appId, email: address, authUserId: mapping?.authUserId || null, role: wanted,
        status: mapping ? MEMBER_STATUS.ACTIVE : MEMBER_STATUS.INVITED,
        grantedBy: actor.userId, provisioned, createdAt: existing?.createdAt || now(), updatedAt: now(),
      });
      await record(appId, actor, provisioned ? "members.provision" : "members.invite", row, existing, row);
      return membershipView(row);
    },

    /** Called by app-auth after a signup: an invitation for that email becomes an active membership. */
    async activateInvitation(appId, { email, authUserId }) {
      const address = lower(email);
      const invited = await storage.getMembership(appId, { email: address });
      if (!invited || invited.status !== MEMBER_STATUS.INVITED) return null;
      const row = await storage.upsertMembership({ ...invited, authUserId, status: MEMBER_STATUS.ACTIVE, updatedAt: now() });
      await record(appId, null, "members.activate", row, invited, row);
      return membershipView(row);
    },

    async setRole(appId, actor, { userId = null, email = null, role } = {}) {
      const active = await policyFor(appId);
      const current = await targetMembership(appId, { userId, email });
      require(active, actor, "members.role", { userId: current.authUserId }, appId);
      const wanted = lower(role);
      if (!active.roles.includes(wanted)) throw new AccountError("unknown_role", `Role "${role}" is not declared for this application`, 400, { roles: [...active.roles] });
      if (isAdminRole(active, current.role) && !isAdminRole(active, wanted)) {
        const admins = (await storage.listMemberships(appId)).filter((row) => row.status === MEMBER_STATUS.ACTIVE && isAdminRole(active, row.role));
        if (admins.length <= 1 && admins.some((row) => row.email === current.email)) {
          throw new AccountError("last_admin", "The last administrator cannot be demoted", 409);
        }
      }
      const row = await storage.upsertMembership({ ...current, implicit: undefined, role: wanted, updatedAt: now(), grantedBy: actor.userId });
      await record(appId, actor, "members.role", row, current, row);
      return membershipView(row);
    },

    async setStatus(appId, actor, { userId = null, email = null, status } = {}) {
      const active = await policyFor(appId);
      const current = await targetMembership(appId, { userId, email });
      require(active, actor, "members.status", { userId: current.authUserId }, appId);
      if (![MEMBER_STATUS.ACTIVE, MEMBER_STATUS.SUSPENDED].includes(status)) {
        throw new AccountError("invalid_status", "status must be active or suspended", 400);
      }
      if (status === MEMBER_STATUS.SUSPENDED && isAdminRole(active, current.role)) {
        const admins = (await storage.listMemberships(appId)).filter((row) => row.status === MEMBER_STATUS.ACTIVE && isAdminRole(active, row.role));
        if (admins.length <= 1 && admins.some((row) => row.email === current.email)) {
          throw new AccountError("last_admin", "The last administrator cannot be suspended", 409);
        }
      }
      const row = await storage.upsertMembership({ ...current, implicit: undefined, status, updatedAt: now(), grantedBy: actor.userId });
      await record(appId, actor, "members.status", row, current, row);
      return membershipView(row);
    },
  };
}
