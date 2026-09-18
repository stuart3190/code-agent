// The identity/session installation plan (WP3).
//
// Derived once per build from the typed contract: which session mode the application runs in,
// which session methods it uses, which routes are protected, where a signed-out visitor is sent
// and where a signed-in member lands. The composer renders the controller from it; the verifier
// reads the same plan for its identity probes. No prose is consulted — only auth.required, the
// declared routes and the identity-owned operations.

const AUTH_ROUTE_IDENTITY = /^(?:signin|login|logon|signon|auth|authenticate|authentication|account|signup|register)$/;
const normalized = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const lastSegment = (path) => String(path || "").split("/").filter(Boolean).at(-1) || "";
const unique = (values) => [...new Set((values || []).filter(Boolean))];

export const IDENTITY_PLAN_VERSION = 1;
export const IDENTITY_MODES = Object.freeze(["member", "visitor"]);

/** Session methods the contract's identity-owned operations use, plus the ones every app needs. */
function sessionMethods(contract) {
  const declared = (contract?.operations || []).flatMap((operation) => {
    if (operation?.module === "thrallo.identity" && operation.moduleOperation) return [operation.moduleOperation];
    return (operation?.responsibilities || [])
      .filter((row) => ["session", "auth"].includes(String(row?.capability || row?.capabilityId || "").toLowerCase()))
      .map((row) => row?.capabilityMethod || row?.method).filter(Boolean);
  });
  return unique(["ensure", "current", ...declared]);
}

export function deriveIdentityPlan(contract) {
  const required = contract?.auth?.required === true;
  const mode = required ? "member" : "visitor";
  const routes = (contract?.routes || []).filter((route) => typeof route?.path === "string");
  const protectedRoutes = routes.filter((route) => route.auth === true).map((route) => route.path);
  const signInRoute = routes.find((route) => AUTH_ROUTE_IDENTITY.test(normalized(lastSegment(route.path)))
    || AUTH_ROUTE_IDENTITY.test(normalized(route.name)))?.path
    || (required ? routes.find((route) => route.auth !== true)?.path || "/" : null);
  const homeRoute = protectedRoutes[0] || routes.find((route) => route.path !== signInRoute)?.path || routes[0]?.path || "/";
  const methods = sessionMethods(contract);
  return {
    version: IDENTITY_PLAN_VERSION,
    module: "thrallo.identity",
    mode,
    methods,
    protectedRoutes,
    redirect: { signedOut: required ? signInRoute : null, signedIn: required ? homeRoute : null },
    roles: unique((contract?.auth?.roles || []).map(String)),
    verification: identityVerificationPlan({ mode, methods, protectedRoutes }),
  };
}

/** The deterministic probes a build's identity installation must pass — by state, not by noun. */
export function identityVerificationPlan({ mode, methods = [], protectedRoutes = [] } = {}) {
  const probes = [{ id: "session.initial", expect: mode === "member" ? "signed_out" : "visitor" }];
  if (methods.includes("signUp")) probes.push({ id: "session.signUp", expect: "signed_in", principal: "member" });
  if (methods.includes("signIn")) probes.push({ id: "session.signIn", expect: "signed_in", principal: "member" });
  if (methods.includes("signIn") || methods.includes("signUp")) {
    probes.push({ id: "session.reload", expect: "signed_in", note: "the same principal after reload" });
    probes.push({ id: "session.expiry", expect: "expired", then: "recover" });
  }
  if (methods.includes("signOut")) probes.push({ id: "session.signOut", expect: mode === "member" ? "signed_out" : "visitor" });
  if (methods.includes("resetPassword")) probes.push({ id: "session.resetPassword", expect: "resetRequested" });
  if (methods.includes("confirmReset")) probes.push({ id: "session.confirmReset", expect: "signed_in" });
  if (mode === "member" && protectedRoutes.length) {
    probes.push({ id: "session.visitorDenied", expect: "member_required", routes: [...protectedRoutes] });
  }
  return probes;
}

export function validateIdentityPlan(plan) {
  const problems = [];
  if (plan?.version !== IDENTITY_PLAN_VERSION) problems.push("identity plan version mismatch");
  if (!IDENTITY_MODES.includes(plan?.mode)) problems.push(`identity mode must be one of ${IDENTITY_MODES.join("|")}`);
  if (plan?.mode === "member" && !plan?.redirect?.signedOut) problems.push("a member application needs a signed-out route");
  return { ok: problems.length === 0, problems };
}
