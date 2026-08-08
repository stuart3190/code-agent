import crypto from "node:crypto";
import net from "node:net";

const KIB = 1024;
const MIB = 1024 * KIB;

export class HttpInputError extends Error {
  constructor(message, status = 400, code = "bad_request") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const BODY_LIMITS = Object.freeze({
  webhook: 1 * MIB,
  tree: 8 * MIB,
  standard: 128 * KIB,
});

export function readBody(req, maxBytes = BODY_LIMITS.standard) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers?.["content-length"] || 0);
    if (Number.isFinite(declared) && declared > maxBytes) {
      req.resume?.();
      return reject(new HttpInputError("Request is too large.", 413, "request_too_large"));
    }

    const chunks = [];
    let bytes = 0;
    let overflow = false;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        overflow = true;
        chunks.length = 0;
      } else if (!overflow) {
        chunks.push(chunk);
      }
    });
    req.on("end", () => overflow
      ? reject(new HttpInputError("Request is too large.", 413, "request_too_large"))
      : resolve(Buffer.concat(chunks)));
    req.on("error", () => reject(new HttpInputError("Request could not be read.", 400, "bad_request")));
  });
}

export function parseJson(buffer) {
  try {
    return JSON.parse(buffer.toString("utf8") || "{}");
  } catch {
    throw new HttpInputError("Request body must be valid JSON.", 400, "invalid_json");
  }
}

/**
 * Which origins may call this API cross-origin.
 *
 * Derived from APP_URL, not a hard-coded list. It used to contain https://buildr101.com and
 * https://www.buildr101.com unconditionally — a DIFFERENT product's domains — plus the Vite dev
 * origins. Production was verified serving `Access-Control-Allow-Origin: https://buildr101.com`
 * to a request that asked for it: Thrallo's API trusted another product's front end, permanently,
 * and a developer's localhost as well.
 *
 * Not a full compromise on its own — no credentials are allowed and auth is a bearer token, so a
 * page on those origins still needs a token it has no way to obtain — but it is trust granted for
 * no reason, and the isolation between these two products is the rule this codebase is built on.
 *
 * The dev origins are added only when APP_URL is itself a development address, so a production
 * deployment cannot be reached from a page on someone's laptop.
 */
export function allowedOrigins(appUrl = "http://localhost:5173") {
  const origins = new Set();
  let parsed = null;
  try { parsed = new URL(appUrl); } catch { /* fall through to dev defaults */ }
  if (parsed) origins.add(parsed.origin);

  const isDev = !parsed || parsed.protocol !== "https:"
    || ["localhost", "127.0.0.1"].includes(parsed.hostname);
  if (isDev) {
    origins.add("http://localhost:5173");
    origins.add("http://127.0.0.1:5173");
  }
  return origins;
}

// Thrallo Desktop's conversation panel is a VS Code webview whose fetches carry the
// sandboxed webview origin. Auth is bearer-token only (no cookies), so allowing these
// origins grants nothing by itself — the request still needs a valid PAT.
function isDesktopWebviewOrigin(origin) {
  return /^vscode-webview:\/\//.test(origin) || /^https:\/\/[a-z0-9-]+\.vscode-webview\.net$/i.test(origin);
}

export function applyCors(res, origin, origins) {
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (!origin) return true;
  if (!origins.has(origin) && !isDesktopWebviewOrigin(origin)) return false;
  res.setHeader("Access-Control-Allow-Origin", origin);
  return true;
}

export function applySecurityHeaders(res) {
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    // No third-party script or connect origins: the Meta pixel was a Buildr101 marketing
    // dependency that Thrallo never carried over — the landing page contains zero Facebook
    // references, so allowing connect.facebook.net / www.facebook.com only widened the policy.
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
    // The buildr101 preview origin is LOAD-BEARING, not leftover. provisiond on the production VPS
    // runs with PREVIEW_PUBLIC_SUFFIX=preview.buildr101.com, so every live preview iframe in
    // Thrallo is served from that origin — verified on the box, not assumed. Removing it from
    // frame-src breaks every preview in the product. It comes out when the suffix is migrated to
    // preview.thrallo.com, and not before; the app.buildr101.com entry rides with it because the
    // publish suffix has the same provenance.
    "frame-src https://*.preview.thrallo.com https://*.app.thrallo.com https://*.preview.buildr101.com https://*.app.buildr101.com http://localhost:* http://127.0.0.1:*",
    "form-action 'self' https://checkout.stripe.com",
  ].join("; "));
}

export function staticCacheControl(pathname) {
  return pathname.startsWith("/assets/")
    ? "public, max-age=31536000, immutable"
    : "no-cache";
}

function normalizedAddress(value) {
  const raw = String(value || "").trim().replace(/^\[|\]$/g, "");
  return raw.startsWith("::ffff:") && net.isIP(raw.slice(7)) === 4 ? raw.slice(7) : raw;
}

function ipv4Number(value) {
  if (net.isIP(value) !== 4) return null;
  return value.split(".").reduce((n, part) => ((n << 8) | Number(part)) >>> 0, 0);
}

export function addressMatchesRule(address, rule) {
  const target = normalizedAddress(address);
  const value = String(rule || "").trim();
  if (!value) return false;
  if (!value.includes("/")) return target === normalizedAddress(value);
  const [network, rawBits] = value.split("/");
  const bits = Number(rawBits);
  const targetNumber = ipv4Number(target); const networkNumber = ipv4Number(network);
  if (targetNumber === null || networkNumber === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (targetNumber & mask) === (networkNumber & mask);
}

export function trustedProxyRules(value = process.env.THRALLO_TRUSTED_PROXIES || "") {
  return String(value).split(",").map((entry) => entry.trim()).filter(Boolean);
}

/**
 * Resolve the client address without trusting a caller-supplied X-Forwarded-For header.
 * Starting at the socket, walk the chain right-to-left only while each hop is explicitly trusted.
 */
export function resolveClientNetwork(req, { trustedProxies = trustedProxyRules() } = {}) {
  const remote = normalizedAddress(req.socket?.remoteAddress || "unknown");
  const isTrusted = (address) => trustedProxies.some((rule) => addressMatchesRule(address, rule));
  if (!isTrusted(remote)) return remote;
  const forwarded = String(req.headers?.["x-forwarded-for"] || "")
    .split(",").map(normalizedAddress).filter((value) => net.isIP(value));
  let client = remote;
  for (let index = forwarded.length - 1; index >= 0; index -= 1) {
    client = forwarded[index];
    if (!isTrusted(client)) break;
  }
  return client;
}

function tokenSubject(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return /^[0-9a-f-]{36}$/i.test(String(payload.sub || "")) ? String(payload.sub).toLowerCase() : null;
  } catch { return null; }
}

export function requestRateIdentity(req, network = resolveClientNetwork(req)) {
  const authorization = String(req.headers?.authorization || "");
  const token = /^Bearer\s+(.+)$/i.exec(authorization)?.[1] || "";
  const subject = tokenSubject(token);
  const tokenRef = token ? crypto.createHash("sha256").update(token).digest("hex") : null;
  return {
    network,
    actor: subject ? `account:${subject}` : tokenRef ? `token:${tokenRef}` : `network:${network}`,
  };
}

export function sharedRatePolicy(pathname, method) {
  const write = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
  if (pathname === "/api/analytics/collect") {
    return { routeClass: "public_analytics", limit: 120, networkLimit: 240, windowMs: 60_000, failClosed: true };
  }
  if (pathname === "/api/domain-check") {
    return { routeClass: "tls_ask", limit: 120, networkLimit: 240, windowMs: 60_000, failClosed: true };
  }
  if ((/^\/api\/(?:v1\/)?(?:ai|agents|runs|conversations|completions|builds|runtime|qa|generate|preview|publish)(?:\/|$)/.test(pathname)
    || /^\/api\/v1\/(?:repositories|diagnostics)(?:\/|$)/.test(pathname)) && write) {
    return { routeClass: "expensive", limit: 30, networkLimit: 120, windowMs: 60_000, failClosed: true };
  }
  if (/^\/api\/v1\/(?:tokens|github|billing|account)(?:\/|$)/.test(pathname) && write) {
    return { routeClass: "security", limit: 20, networkLimit: 80, windowMs: 60_000, failClosed: true };
  }
  if (write) {
    return { routeClass: "mutation", limit: 120, networkLimit: 480, windowMs: 60_000, failClosed: false };
  }
  return null; // cheap reads do not touch the shared limiter
}

export function createSharedRateLimiter({ clientFactory, now = () => Date.now() } = {}) {
  if (typeof clientFactory !== "function") throw new Error("shared rate limiter requires a database client factory");
  const hash = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
  async function one(key, routeClass, limit, windowMs) {
    const { data, error } = await clientFactory().rpc("consume_http_rate_limit", {
      p_key_hash: hash(key), p_route_class: routeClass, p_limit: limit,
      p_window_seconds: Math.max(1, Math.ceil(windowMs / 1000)),
    });
    if (error) throw Object.assign(new Error(`shared rate limiter unavailable: ${error.message}`), { code: "rate_limit_backend" });
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row.allowed !== "boolean") throw Object.assign(new Error("shared rate limiter returned no verdict"), { code: "rate_limit_backend" });
    return {
      allowed: row.allowed,
      remaining: Number(row.remaining || 0),
      retryAfter: Number(row.retry_after_seconds || 1),
      count: Number(row.current_count || 0),
      at: now(),
    };
  }
  return async function consume(req, policy) {
    const identity = requestRateIdentity(req);
    // A generous network ceiling stops attackers rotating invented bearer values, while the actor
    // bucket prevents authenticated users behind the same NAT from consuming one another's quota.
    const network = await one(`network:${identity.network}`, `${policy.routeClass}_network`, policy.networkLimit, policy.windowMs);
    if (!network.allowed) return network;
    return one(identity.actor, policy.routeClass, policy.limit, policy.windowMs);
  };
}
