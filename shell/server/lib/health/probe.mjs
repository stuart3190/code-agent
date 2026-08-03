// Probing one published site.
//
// Three independent questions, because they fail independently and an owner needs to know which:
// does it answer, is the certificate healthy, and does the domain still point here. A site can
// serve perfectly while its certificate expires in three days, and that is a warning worth having
// before it becomes an outage.

import tls from "node:tls";
import { promises as dns } from "node:dns";
import { optionalEnv } from "../env.mjs";

// One source for the address a custom domain must resolve to. customDomains.mjs reads the same
// variable; a hardcoded copy here meant health reported every custom domain MISCONFIGURED the
// moment the env var was set, while verification said Active.
export const publicIp = () => optionalEnv("THRALLO_PUBLIC_IP", "51.195.136.189");

// Slow enough to matter to a visitor, not so slow that a cold start looks like an outage.
export const SLOW_MS = 2_500;
// Certificates renew automatically, but a renewal that has silently stopped working needs to
// surface with time to act rather than on the morning it expires.
export const SSL_WARN_DAYS = 14;
const TIMEOUT_MS = 10_000;

export const HEALTH = Object.freeze({ healthy: "healthy", warning: "warning", offline: "offline" });

/**
 * Read the TLS certificate without fetching the page.
 *
 * Deliberately its own connection: a fetch that succeeds tells you the certificate was valid at
 * that moment, not how long it stays valid, and expiry is the thing worth warning about early.
 */
export async function inspectCertificate(hostname, { connect = tls.connect, now = new Date() } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };

    let socket;
    try {
      socket = connect({ host: hostname, port: 443, servername: hostname, timeout: TIMEOUT_MS });
    } catch {
      return done({ ok: false, reason: "connect_failed" });
    }

    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      if (!cert || !cert.valid_to) return done({ ok: false, reason: "no_certificate" });
      const validTo = new Date(cert.valid_to);
      const daysLeft = Math.floor((validTo.getTime() - now.getTime()) / 86_400_000);
      done({
        ok: socket.authorized !== false && daysLeft >= 0,
        validTo: Number.isFinite(validTo.getTime()) ? validTo.toISOString() : null,
        daysLeft,
        // Node reports the reason a chain failed; it is the difference between "expired" and
        // "issued for a different hostname", which need different fixes.
        reason: socket.authorized === false ? String(socket.authorizationError || "untrusted") : null,
      });
    });
    socket.once("timeout", () => { socket.destroy(); done({ ok: false, reason: "timeout" }); });
    socket.once("error", (error) => { done({ ok: false, reason: error?.code || "error" }); });
    return undefined;
  });
}

// Does the hostname still resolve to us? A custom domain whose DNS is edited later would keep
// serving from cache for a while and then simply stop, with nothing in Thrallo explaining why.
export async function checkDns(hostname, expectedIp = publicIp(), { resolver = dns, appSuffix = optionalEnv("APP_DOMAIN_SUFFIX", "app.thrallo.com") } = {}) {
  if (!hostname || hostname.endsWith(appSuffix)) return { ok: true, checked: false };
  try {
    const addresses = await resolver.resolve4(hostname);
    if (addresses.includes(expectedIp)) return { ok: true, checked: true };
  } catch { /* try CNAME */ }
  try {
    const target = (await resolver.resolveCname(hostname))[0];
    if (target && target.replace(/\.$/, "").endsWith(appSuffix)) return { ok: true, checked: true };
    if (target && (await resolver.resolve4(target)).includes(expectedIp)) return { ok: true, checked: true };
  } catch { /* nothing resolves here */ }
  return { ok: false, checked: true };
}

/**
 * Probe a site and classify it. Never throws — a monitor that crashes on a broken site is worse
 * than no monitor, because the dashboard would silently stop updating for everyone.
 */
export async function probeSite(url, {
  fetchImpl = fetch, certificate = inspectCertificate, dnsCheck = checkDns,
  expectedIp = publicIp(), now = new Date(),
} = {}) {
  let hostname = "";
  try { hostname = new URL(url).hostname; } catch { /* handled below */ }
  if (!hostname) return { status: HEALTH.offline, detail: "That address cannot be checked.", url };

  const startedAt = Date.now();
  let httpStatus = null;
  let reachable = false;
  try {
    const response = await fetchImpl(url, {
      // HEAD keeps the probe cheap; redirect: manual so a redirect is reported as itself rather
      // than silently following somewhere that happens to work.
      method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "User-Agent": "Thrallo-Health/1.0 (+https://thrallo.com)" },
    });
    httpStatus = response.status;
    reachable = true;
  } catch {
    reachable = false;
  }
  const responseMs = Date.now() - startedAt;

  const [cert, dnsResult] = await Promise.all([
    certificate(hostname, { now }).catch(() => ({ ok: false, reason: "error" })),
    dnsCheck(hostname, expectedIp).catch(() => ({ ok: true, checked: false })),
  ]);

  const base = {
    url,
    httpStatus,
    responseMs: reachable ? responseMs : null,
    sslValidTo: cert.validTo || null,
    sslDaysLeft: Number.isFinite(cert.daysLeft) ? cert.daysLeft : null,
    dnsOk: dnsResult.ok,
  };

  // Offline first: nothing else matters if visitors cannot reach it.
  if (!reachable) {
    return { ...base, status: HEALTH.offline, detail: "The site did not respond." };
  }
  if (httpStatus >= 500) {
    return { ...base, status: HEALTH.offline, detail: `The site returned ${httpStatus}.` };
  }
  if (!dnsResult.ok) {
    // It is answering now, but the domain no longer points here — it will stop.
    return { ...base, status: HEALTH.warning, detail: "The custom domain no longer points to Thrallo." };
  }
  if (cert.ok === false) {
    return {
      ...base, status: HEALTH.warning,
      detail: cert.reason === "timeout" ? "The certificate could not be checked."
        : `There is a problem with the HTTPS certificate (${cert.reason || "invalid"}).`,
    };
  }
  if (Number.isFinite(cert.daysLeft) && cert.daysLeft <= SSL_WARN_DAYS) {
    return {
      ...base, status: HEALTH.warning,
      detail: cert.daysLeft <= 0
        ? "The HTTPS certificate has expired."
        : `The HTTPS certificate expires in ${cert.daysLeft} day${cert.daysLeft === 1 ? "" : "s"}.`,
    };
  }
  if (httpStatus >= 400) {
    return { ...base, status: HEALTH.warning, detail: `The site returned ${httpStatus}.` };
  }
  if (responseMs > SLOW_MS) {
    return { ...base, status: HEALTH.warning, detail: `Responding slowly (${(responseMs / 1000).toFixed(1)}s).` };
  }
  return { ...base, status: HEALTH.healthy, detail: null };
}
