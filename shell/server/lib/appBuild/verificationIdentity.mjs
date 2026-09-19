import crypto from "node:crypto";

const stableToken = (...parts) => crypto.createHash("sha256")
  .update(parts.map((part) => String(part || "")).join("\u0000"))
  .digest("hex")
  .slice(0, 24);

export function createVerificationIdentity({ appId, scope, visitorScope = null, secret }) {
  if (!appId || !scope || !secret) {
    throw Object.assign(new Error("browser verification identity authority is unavailable"), {
      code: "verification_identity_authority_missing",
    });
  }
  const seal = (purpose) => crypto.createHmac("sha256", String(secret))
    .update(["thrallo-browser-verifier", appId, purpose].join("\u0000"))
    .digest("hex")
    .slice(0, 32);
  return {
    appId: String(appId),
    scope: String(scope),
    tokens: {
      // A verification round shares one visitor across its related journeys, but a later repair
      // round must not restore the half-completed wizard left by the prior candidate. Explicit
      // account credentials remain journey-stable below; only anonymous app data is round-scoped.
      visitor: seal(visitorScope ? `visitor:${visitorScope}` : "visitor"),
      mechanics: seal(visitorScope ? `mechanics:${visitorScope}` : `mechanics:${scope}`),
      smoke: seal("smoke"),
      journey: seal(`journey:${scope}`),
    },
  };
}

export function hasVerificationIdentity(identity) {
  return Boolean(identity?.appId && identity?.tokens?.visitor
    && identity?.tokens?.smoke && identity?.tokens?.journey);
}

export function verificationToken(identity, purpose) {
  if (!hasVerificationIdentity(identity)) return null;
  if (purpose === "visitor") return stableToken(identity.tokens.visitor, purpose);
  if (purpose === "mechanics") return stableToken(identity.tokens.mechanics || identity.tokens.journey, purpose);
  if (purpose === "smoke") return stableToken(identity.tokens.smoke, purpose);
  return stableToken(identity.tokens.journey, purpose);
}

export function verificationCredentials(identity, purpose, { kind = "account" } = {}) {
  const token = verificationToken(identity, purpose);
  if (!token) return null;
  return kind === "visitor"
    ? { email: `verify-visitor-${token}@visitor.local`, password: `Visitor-${token}-key` }
    : { email: `verify+${token}@thrallo.dev`, password: `Vf-${token}!9a` };
}

/**
 * Give every verification context the same app-scoped visitor credentials for this project.
 * The generated runtime still performs the real app-auth signup/recovery request and receives a
 * real RLS-scoped session; only the browser-persisted credentials are restored. Repeated browser
 * rounds therefore recover one test visitor instead of creating a new auth user every time.
 */
export async function seedVerificationVisitorStorage(context, identity, purpose) {
  if (!hasVerificationIdentity(identity)) return false;
  if (!purpose) {
    throw Object.assign(new Error("verification visitor purpose is required"), {
      code: "verification_visitor_purpose_required",
    });
  }
  const credentials = verificationCredentials(identity, purpose, { kind: "visitor" });
  const key = `visitor-session:${identity.appId}`;
  await context.addInitScript(({ storageKey, storedCredentials }) => {
    try {
      if (!globalThis.localStorage.getItem(storageKey)) {
        globalThis.localStorage.setItem(storageKey, JSON.stringify(storedCredentials));
      }
    } catch { /* an origin without localStorage is irrelevant to the generated app */ }
  }, { storageKey: key, storedCredentials: credentials });
  return true;
}

/** A rate limit on the platform-owned auth function is not an application-source defect. */
export function appAuthRateLimitDefect(response) {
  if (response?.status?.() !== 429) return null;
  let path = "";
  try { path = new URL(response.url()).pathname; } catch { return null; }
  if (!/\/functions\/v1\/app-auth\/?$/.test(path)) return null;

  let email = "";
  try { email = JSON.parse(response.request().postData() || "{}").email || ""; } catch { email = ""; }
  if (!/^(?:verify\+|journey\+|verify-visitor-|visitor-)/i.test(String(email))) return null;
  return {
    code: "journey_verifier_auth_rate_limited",
    detail: "the platform app-auth verifier identity was rate limited (HTTP 429); application repair is not applicable",
  };
}
