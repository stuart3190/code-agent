// Accounts, authorization and admin modules v1 — platform infrastructure, do not edit.
//
// Real accounts are platform-owned: the profile, the membership role and status, invitations
// and role changes all live behind the app-accounts service, which derives the actor from the
// signed-in session and enforces the policy independently of anything rendered here. These
// controllers give a screen reactive state and typed operations; the client-side policy
// evaluation only improves UX (which controls to show). It is never the security boundary.

import { allowedActions as policyAllowedActions, evaluate } from "./policy.js";

export const ACCOUNTS_MODULE_VERSION = "1.0.0";

export const ACCOUNT_ERROR = Object.freeze({
  UNAUTHENTICATED: "unauthenticated",
  FORBIDDEN: "forbidden",
  ACCOUNT_SUSPENDED: "account_suspended",
  MEMBER_NOT_FOUND: "member_not_found",
  UNKNOWN_ROLE: "unknown_role",
  LAST_ADMIN: "last_admin",
  UNAVAILABLE: "accounts_unavailable",
});

const freeze = (value) => Object.freeze(value);

function store(initial) {
  const listeners = new Set();
  let state = freeze(initial);
  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    set(next) {
      const frozen = freeze(next);
      if (JSON.stringify(frozen) === JSON.stringify(state)) return state;
      state = frozen;
      for (const listener of [...listeners]) listener(state);
      return state;
    },
  };
}

function classify(error) {
  const code = error?.code && Object.values(ACCOUNT_ERROR).includes(error.code) ? error.code
    : error?.code ? String(error.code)
      : /not configured|unavailable/i.test(String(error?.message || "")) ? ACCOUNT_ERROR.UNAVAILABLE
        : ACCOUNT_ERROR.FORBIDDEN;
  return Object.assign(new Error(String(error?.message || "Account operation failed").slice(0, 200)), { code, cause: error });
}

/**
 * Profile + membership of the signed-in member.
 *   state: { status: "idle" | "loading" | "ready" | "error", principal, membership, profile, profileFields, allowedActions, error }
 */
export function createAccountsController({ accounts, identity = null } = {}) {
  if (!accounts || typeof accounts.me !== "function") throw new Error("createAccountsController: the accounts SDK surface is required");
  const state = store({ status: "idle", principal: null, membership: null, profile: null, profileFields: [], allowedActions: [], error: null });
  let flight = null;
  async function load() {
    if (identity && typeof identity.ensure === "function") await identity.ensure();
    state.set({ ...state.getState(), status: "loading", error: null });
    try {
      const me = await accounts.me();
      return state.set({ status: "ready", principal: me.principal, membership: me.membership, profile: me.profile || {},
        profileFields: me.profileFields || [], allowedActions: me.allowedActions || [], error: null });
    } catch (error) {
      const classified = classify(error);
      return state.set({ ...state.getState(), status: "error", error: { code: classified.code, message: classified.message } });
    }
  }
  return {
    getState: state.getState,
    subscribe: state.subscribe,
    async ensure() {
      if (state.getState().status === "ready") return state.getState();
      if (!flight) flight = load().finally(() => { flight = null; });
      return flight;
    },
    reload: load,
    async updateMe(values = {}) {
      try {
        const result = await accounts.updateMe(values);
        return state.set({ ...state.getState(), profile: result.profile, profileFields: result.profileFields || state.getState().profileFields });
      } catch (error) { throw classify(error); }
    },
    async getMember(target) {
      try { return await accounts.member(target); } catch (error) { throw classify(error); }
    },
    /** The actor shape the policy evaluates — from the server's answer, never from a record. */
    actor() {
      const current = state.getState();
      if (!current.principal) return null;
      return { userId: current.principal.id, email: current.principal.email, role: current.membership?.role, status: current.membership?.status };
    },
  };
}

/** Client-side policy evaluation over the server-derived actor; the server enforces independently. */
export function createAuthorization({ policy, accountsController } = {}) {
  if (!policy) throw new Error("createAuthorization: a policy is required");
  return {
    policy,
    can(action, target = null) {
      const actor = accountsController?.actor?.() || null;
      return evaluate(policy, actor, action, { target });
    },
    authorize(action, target = null) {
      const decision = this.can(action, target);
      if (!decision.allowed) throw Object.assign(new Error(`Not allowed: ${action}`), { code: decision.reason === "unauthenticated" ? ACCOUNT_ERROR.UNAUTHENTICATED : ACCOUNT_ERROR.FORBIDDEN, reason: decision.reason });
      return decision;
    },
    explainAllowedActions() {
      const server = accountsController?.getState?.().allowedActions;
      if (Array.isArray(server) && server.length) return [...server];
      return policyAllowedActions(policy, accountsController?.actor?.() || null);
    },
    role() { return accountsController?.actor?.()?.role || null; },
  };
}

/**
 * Administration commands. Each one is pre-checked locally (so a denied control can be hidden)
 * and enforced by the server (so hiding is never the boundary).
 *   state: { status: "idle" | "loading" | "ready" | "error", members: [], error }
 */
export function createAdmin({ accounts, authorization } = {}) {
  if (!accounts || typeof accounts.members !== "function") throw new Error("createAdmin: the accounts SDK surface is required");
  const state = store({ status: "idle", members: [], error: null });
  const guarded = async (action, run) => {
    if (authorization) authorization.authorize(action);
    try { return await run(); } catch (error) { throw classify(error); }
  };
  const replace = (member) => {
    const members = state.getState().members.filter((row) => row.email !== member.email);
    state.set({ ...state.getState(), members: [...members, member].sort((a, b) => a.email.localeCompare(b.email)) });
    return member;
  };
  return {
    getState: state.getState,
    subscribe: state.subscribe,
    async listMembers() {
      state.set({ ...state.getState(), status: "loading", error: null });
      try {
        const members = await guarded("members.read", () => accounts.members());
        state.set({ status: "ready", members, error: null });
        return members;
      } catch (error) {
        state.set({ ...state.getState(), status: "error", error: { code: error.code, message: error.message } });
        throw error;
      }
    },
    async inviteMember({ email, role = null } = {}) { return replace(await guarded("members.invite", () => accounts.invite({ email, role }))); },
    async provisionMember({ email, role = null } = {}) { return replace(await guarded("members.provision", () => accounts.provision({ email, role }))); },
    async setMemberRole({ userId = null, email = null, role } = {}) { return replace(await guarded("members.role", () => accounts.setRole({ userId, email, role }))); },
    async setMemberStatus({ userId = null, email = null, status } = {}) { return replace(await guarded("members.status", () => accounts.setStatus({ userId, email, status }))); },
  };
}
