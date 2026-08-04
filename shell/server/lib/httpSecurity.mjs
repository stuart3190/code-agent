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
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
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

export function createRateLimiter({ now = () => Date.now() } = {}) {
  const buckets = new Map();
  let calls = 0;
  return function consume(key, limit, windowMs) {
    const time = now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= time) bucket = { count: 0, resetAt: time + windowMs };
    bucket.count += 1;
    buckets.set(key, bucket);
    if ((++calls % 500) === 0) {
      for (const [k, value] of buckets) if (value.resetAt <= time) buckets.delete(k);
    }
    return {
      allowed: bucket.count <= limit,
      remaining: Math.max(0, limit - bucket.count),
      retryAfter: Math.max(1, Math.ceil((bucket.resetAt - time) / 1000)),
    };
  };
}
