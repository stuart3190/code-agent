// Identity/session module v1 — platform infrastructure, do not edit or reimplement.
//
// One deterministic session controller for a generated application. It owns the explicit
// session state the audit asks for, so no screen has to orchestrate sign-in, recovery or expiry:
//
//   { status: "initializing" }
//   { status: "signed_out" }
//   { status: "visitor",   principal: { kind: "visitor", id } }
//   { status: "signed_in", principal: { kind: "member", id, email } }
//   { status: "expired" }
//   { status: "error",     error: { code, message } }
//
// A visitor session never satisfies a member requirement: identityGuard() says so explicitly.
// Credentials are operation inputs, never state — the controller keeps no password anywhere.
//
// The controller is a plain external store (getState/subscribe) so React binds it through the
// same hooks every capability uses. The legacy session capability (ensureSession, signIn, …)
// keeps working unchanged beside it; this controller composes over the same backend auth SDK.

export const IDENTITY_MODULE_VERSION = "1.2.0";

export const SESSION_STATUS = Object.freeze({
  INITIALIZING: "initializing",
  SIGNED_OUT: "signed_out",
  VISITOR: "visitor",
  SIGNED_IN: "signed_in",
  EXPIRED: "expired",
  ERROR: "error",
});

export const IDENTITY_MODE = Object.freeze({ MEMBER: "member", VISITOR: "visitor" });

export const IDENTITY_ERROR = Object.freeze({
  INVALID_CREDENTIALS: "invalid_credentials",
  EMAIL_TAKEN: "email_taken",
  WEAK_PASSWORD: "weak_password",
  INVALID_CODE: "invalid_code",
  MEMBER_REQUIRED: "member_required",
  SESSION_EXPIRED: "session_expired",
  BACKEND_UNAVAILABLE: "backend_unavailable",
  UNKNOWN: "identity_error",
});

const freeze = (value) => Object.freeze(value);

function memberPrincipal(user) {
  return freeze({ kind: "member", id: String(user?.id ?? ""), email: user?.email ? String(user.email) : null });
}

function visitorPrincipal(user) {
  return freeze({ kind: "visitor", id: String(user?.id ?? "") });
}

/** Classify a backend error into one stable identity error code without leaking secrets. */
export function classifyIdentityError(error, { operation = null } = {}) {
  const status = Number(error?.status || 0);
  const message = String(error?.message || error || "").toLowerCase();
  let code = IDENTITY_ERROR.UNKNOWN;
  if (error?.code && Object.values(IDENTITY_ERROR).includes(error.code)) code = error.code;
  else if (status === 401 || /invalid (?:login )?credentials|invalid email or password|wrong password/.test(message)) code = IDENTITY_ERROR.INVALID_CREDENTIALS;
  else if (status === 409 || /already (?:registered|exists|taken)|email_taken/.test(message)) code = IDENTITY_ERROR.EMAIL_TAKEN;
  else if (/weak password|password (?:is )?too short|weak_password/.test(message)) code = IDENTITY_ERROR.WEAK_PASSWORD;
  else if (/invalid code|code expired|invalid_code/.test(message)) code = IDENTITY_ERROR.INVALID_CODE;
  else if (/expired|jwt|token/.test(message)) code = IDENTITY_ERROR.SESSION_EXPIRED;
  else if (/not configured|backend is not configured|failed to fetch|network/.test(message)) code = IDENTITY_ERROR.BACKEND_UNAVAILABLE;
  else if (operation === "signIn" && status >= 400 && status < 500) code = IDENTITY_ERROR.INVALID_CREDENTIALS;
  return freeze({ code, message: String(error?.message || "Identity operation failed").slice(0, 200), operation });
}

/**
 * Decide whether a session state satisfies a requirement.
 *   requirement: "member" (a signed-in account), "visitor" (any established identity), "any".
 */
export function identityGuard(state, requirement = "member") {
  const status = state?.status;
  if (requirement === "any") return freeze({ allowed: true, reason: null });
  if (status === SESSION_STATUS.INITIALIZING) return freeze({ allowed: false, reason: "initializing", pending: true });
  if (requirement === "visitor") {
    const allowed = status === SESSION_STATUS.VISITOR || status === SESSION_STATUS.SIGNED_IN;
    return freeze({ allowed, reason: allowed ? null : status });
  }
  if (status === SESSION_STATUS.SIGNED_IN) return freeze({ allowed: true, reason: null });
  // A visitor is NOT a member, however authenticated the transport underneath it is.
  return freeze({ allowed: false, reason: status === SESSION_STATUS.VISITOR ? IDENTITY_ERROR.MEMBER_REQUIRED : status });
}

/**
 * @param {object} options
 * @param {object} options.auth the backend auth SDK ({ signIn, signUp, signOut, currentUser, resetPassword, confirmReset })
 * @param {() => Promise<object>} [options.ensureVisitorSession] visitor establishment (visitor mode)
 * @param {"member"|"visitor"} [options.mode]
 */
export function createIdentityController({ auth, ensureVisitorSession = null, mode = IDENTITY_MODE.MEMBER } = {}) {
  if (!auth || typeof auth.currentUser !== "function") throw new Error("createIdentityController: an auth SDK is required");
  const listeners = new Set();
  let state = freeze({ status: SESSION_STATUS.INITIALIZING });
  let ensureFlight = null;
  let lastMember = null;

  const emit = () => { for (const listener of [...listeners]) listener(state); };
  const setState = (next) => {
    const frozen = freeze(next);
    if (frozen.status === state.status && JSON.stringify(frozen) === JSON.stringify(state)) return state;
    state = frozen;
    emit();
    return state;
  };
  const fail = (error, operation) => {
    const classified = classifyIdentityError(error, { operation });
    const thrown = Object.assign(new Error(classified.message), { code: classified.code, operation, cause: error });
    return thrown;
  };

  async function resolveVisitor() {
    if (mode !== IDENTITY_MODE.VISITOR || typeof ensureVisitorSession !== "function") {
      return setState({ status: SESSION_STATUS.SIGNED_OUT });
    }
    const user = await ensureVisitorSession();
    return setState({ status: SESSION_STATUS.VISITOR, principal: visitorPrincipal(user) });
  }

  async function resolve() {
    try {
      const user = await auth.currentUser();
      if (user) {
        lastMember = memberPrincipal(user);
        return setState({ status: SESSION_STATUS.SIGNED_IN, principal: lastMember });
      }
      if (lastMember && state.status === SESSION_STATUS.SIGNED_IN) {
        // A member the backend no longer recognises: the session expired underneath the app.
        lastMember = null;
        return setState({ status: SESSION_STATUS.EXPIRED });
      }
      return await resolveVisitor();
    } catch (error) {
      const classified = classifyIdentityError(error, { operation: "ensure" });
      if (classified.code === IDENTITY_ERROR.SESSION_EXPIRED && lastMember) {
        lastMember = null;
        return setState({ status: SESSION_STATUS.EXPIRED });
      }
      return setState({ status: SESSION_STATUS.ERROR, error: classified });
    }
  }

  const controller = {
    mode,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    /** Establish the current session once (shared by concurrent callers); safe to call repeatedly. */
    async ensure() {
      if (state.status !== SESSION_STATUS.INITIALIZING && state.status !== SESSION_STATUS.EXPIRED
        && state.status !== SESSION_STATUS.ERROR) return state;
      if (!ensureFlight) ensureFlight = resolve().finally(() => { ensureFlight = null; });
      return ensureFlight;
    },
    /** Re-read the backend session: after a reload, a suspected expiry or an error. */
    async recover() { return resolve(); },
    /** Mark the session expired (a backend 401 on a protected call); ensure()/recover() re-establish it. */
    markExpired() {
      if (state.status === SESSION_STATUS.SIGNED_IN) { lastMember = null; setState({ status: SESSION_STATUS.EXPIRED }); }
      return state;
    },
    async signIn({ email, password } = {}) {
      if (!email || !password) throw Object.assign(new Error("email and password are required"), { code: IDENTITY_ERROR.INVALID_CREDENTIALS, operation: "signIn" });
      try {
        const user = await auth.signIn({ email, password });
        lastMember = memberPrincipal(user);
        return setState({ status: SESSION_STATUS.SIGNED_IN, principal: lastMember });
      } catch (error) { throw fail(error, "signIn"); }
    },
    async signUp({ email, password } = {}) {
      if (!email || !password) throw Object.assign(new Error("email and password are required"), { code: IDENTITY_ERROR.INVALID_CREDENTIALS, operation: "signUp" });
      try {
        const user = await auth.signUp({ email, password });
        lastMember = memberPrincipal(user);
        return setState({ status: SESSION_STATUS.SIGNED_IN, principal: lastMember });
      } catch (error) { throw fail(error, "signUp"); }
    },
    async signOut() {
      try { await auth.signOut(); } catch (error) { throw fail(error, "signOut"); }
      lastMember = null;
      setState({ status: SESSION_STATUS.SIGNED_OUT });
      // A visitor-mode app re-establishes its anonymous identity so persistence keeps working.
      if (mode === IDENTITY_MODE.VISITOR) return resolveVisitor();
      return state;
    },
    async resetPassword({ email } = {}) {
      if (!email) throw Object.assign(new Error("email is required"), { code: IDENTITY_ERROR.INVALID_CREDENTIALS, operation: "resetPassword" });
      try { await auth.resetPassword({ email }); } catch (error) { throw fail(error, "resetPassword"); }
      return freeze({ resetRequested: true });
    },
    async confirmReset({ email, code, newPassword } = {}) {
      if (!email || !code || !newPassword) throw Object.assign(new Error("email, code and newPassword are required"), { code: IDENTITY_ERROR.INVALID_CODE, operation: "confirmReset" });
      try {
        const user = await auth.confirmReset({ email, code, newPassword });
        lastMember = memberPrincipal(user);
        return setState({ status: SESSION_STATUS.SIGNED_IN, principal: lastMember });
      } catch (error) { throw fail(error, "confirmReset"); }
    },
    /** The current principal or null — never throws. */
    principal() { return state.principal || null; },
    /** Throw unless a member is signed in; the server enforces the same boundary independently. */
    requireMember() {
      const guard = identityGuard(state, "member");
      if (!guard.allowed) throw Object.assign(new Error("A signed-in account is required."), { code: IDENTITY_ERROR.MEMBER_REQUIRED, reason: guard.reason });
      return state.principal;
    },
    guard(requirement = "member") { return identityGuard(state, requirement); },
  };
  return controller;
}
