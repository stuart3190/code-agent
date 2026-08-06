export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function requestOrigin(value) {
  try {
    const url = new URL(String(value || ""));
    const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
    if (url.username || url.password || (url.protocol !== "https:" && !localHttp)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function originOf(value) {
  try { return new URL(String(value || "")).origin; } catch { return null; }
}

/**
 * @param {string|null} origin
 * @param {{previewRef?: string|null, site?: {url?: string, slug?: string, unpublished_at?: string|null}|null, domain?: {domain?: string, verified_at?: string|null}|null}} options
 */
export function originIsEligible(origin, { previewRef = null, site = null, domain = null } = {}) {
  if (!origin) return false;
  if (previewRef && originOf(previewRef) === origin) return true;
  if (site && !site.unpublished_at) {
    if (originOf(site.url) === origin) return true;
    try {
      const host = new URL(origin).hostname.toLowerCase();
      if (site.slug && [".app.thrallo.com", ".app.buildr101.com"].some((suffix) => host === `${site.slug}${suffix}`)) return true;
    } catch { /* invalid origins were rejected before this point */ }
  }
  if (domain?.verified_at) {
    try { return new URL(origin).hostname.toLowerCase() === String(domain.domain || "").toLowerCase(); } catch { return false; }
  }
  return false;
}

export async function hmacHex(secret, message) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(signature)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
