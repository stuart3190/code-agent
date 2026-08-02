// Caddy's on_demand_tls "ask" gate, re-homed onto Thrallo (Phase 19). The shared Caddy front
// consults GET /api/domain-check?domain=x before minting a certificate for ANY on-demand
// hostname. 200 = issue, 404 = refuse. Unauthenticated by design (read-only yes/no) and must
// stay fast — Caddy blocks the TLS handshake on this answer.
//
// Two families of hostnames arrive here:
//   * <label>.preview.thrallo.com — Thrallo previews. Approved only when the label corresponds
//     to a real preview container / published dir (provisiond /exists), so strangers pointing
//     invented SNI at the VPS cannot burn the CA rate limit for the suffix.
//   * anything else — Buildr101 custom domains during the read-only freeze. Passed through to
//     the legacy shell's own /api/domain-check (its custom_domains table), which keeps existing
//     customer certs renewing until Phase 24 decides their fate. No Buildr data is read here.

const json = (res, code, obj) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
};

const previewSuffix = () => (process.env.PREVIEW_DOMAIN_SUFFIX || "preview.thrallo.com").toLowerCase();
const appSuffix = () => (process.env.APP_DOMAIN_SUFFIX || "app.thrallo.com").toLowerCase();
const LABEL_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

async function labelExists(label, fetchImpl) {
  const base = process.env.PROVISIOND_URL;
  if (!LABEL_RE.test(label) || !base) return false;
  try {
    const r = await fetchImpl(`${base}/exists?label=${encodeURIComponent(label)}`, {
      headers: { Authorization: `Bearer ${process.env.PROVISIOND_TOKEN || ""}` },
      signal: AbortSignal.timeout(3_000),
    });
    if (!r.ok) return false;
    const data = await r.json().catch(() => ({}));
    return data.exists === true;
  } catch {
    return false;
  }
}

// Thrallo custom domains: approved ONLY once ownership has been verified.
//
// This previously returned true for any row that existed, which meant adding a domain was enough
// to make Thrallo ask the CA for a certificate covering a hostname the requester might not own.
// Verification now gates issuance: a domain reaches `active` only after a TXT token it could not
// have published without control of the zone, AND the domain resolving here.
async function thralloCustomDomain(domain) {
  try {
    const { serviceClient } = await import("../lib/supabase.mjs");
    const { data } = await serviceClient().from("custom_domains")
      .select("domain,status").eq("domain", domain).eq("status", "active").maybeSingle();
    return !!data;
  } catch {
    return false;
  }
}

export async function previewDomainAllowed(domain, { fetchImpl = fetch } = {}) {
  const d = String(domain || "").trim().toLowerCase();

  for (const suffix of [`.${previewSuffix()}`, `.${appSuffix()}`]) {
    if (d.endsWith(suffix)) return labelExists(d.slice(0, -suffix.length), fetchImpl);
  }

  if (await thralloCustomDomain(d)) return true;

  const legacy = process.env.LEGACY_DOMAIN_CHECK_URL;
  if (legacy) {
    try {
      const r = await fetchImpl(`${legacy}?domain=${encodeURIComponent(d)}`, {
        signal: AbortSignal.timeout(3_000),
      });
      return r.status === 200;
    } catch {
      return false;
    }
  }
  return false;
}

export async function handlePreviewDomainCheck(req, res, url, opts = {}) {
  const ok = await previewDomainAllowed(url.searchParams.get("domain"), opts);
  return json(res, ok ? 200 : 404, { ok });
}
