// Analytics ingest.
//
// This is the one endpoint that accepts data from the open internet, because it is called by every
// visitor to every published site. Everything about it is therefore defensive: the project is
// resolved from the app id server-side (never trusted from the body), payloads are clamped, bots
// are dropped, and nothing that could identify a person is written.

import { serviceClient } from "../supabase.mjs";
import { identify } from "./visitorIdentity.mjs";
import { isBot, parseUserAgent, referrerHost, normalizePath } from "./userAgent.mjs";
import { countryFor } from "./geoip.mjs";
import { scrubErrorFields } from "./scrub.mjs";

const KINDS = new Set(["pageview", "vitals", "error"]);
const MAX_STACK = 4_000;
const MAX_MESSAGE = 500;

// A published site's app id is its slug; the site row proves which owner and project it belongs to.
// Resolving here means a forged body cannot write events into someone else's project.
const siteCache = new Map();
const SITE_TTL_MS = 60_000;

export async function resolveSite(appId, client = serviceClient()) {
  const cached = siteCache.get(appId);
  if (cached && cached.at > Date.now() - SITE_TTL_MS) return cached.site;
  const { data } = await client.from("published_sites")
    .select("owner,project_id,slug,unpublished_at").eq("slug", appId).maybeSingle();
  const site = data && !data.unpublished_at ? data : null;
  siteCache.set(appId, { site, at: Date.now() });
  return site;
}

const clampInt = (value, max) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 0 && n <= max ? n : null;
};

export function __resetIngestCacheForTests() {
  siteCache.clear();
}

/**
 * Record one beacon. Returns what happened rather than throwing, because a visitor's browser must
 * never see an error from analytics and the site must never be affected by one.
 */
export async function recordBeacon({
  body = {}, ip = "", userAgent = "", client = serviceClient(), now = new Date(),
} = {}) {
  const kind = String(body.kind || "pageview");
  if (!KINDS.has(kind)) return { accepted: false, reason: "unknown_kind" };

  // Counting bots would make every number a lie, and the owner cannot act on them.
  if (isBot(userAgent)) return { accepted: false, reason: "bot" };

  const appId = String(body.appId || "").trim().toLowerCase().slice(0, 80);
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(appId)) return { accepted: false, reason: "bad_app" };

  const site = await resolveSite(appId, client);
  // An unpublished or unknown site silently accepts and discards: a stale page still beaconing
  // after unpublish is normal, not an error worth surfacing to anyone.
  if (!site) return { accepted: false, reason: "unknown_site" };

  const { visitorHash, sessionHash } = await identify({ ip, userAgent, appId, now, client });
  const { browser, os, device } = parseUserAgent(userAgent);
  // Country is resolved HERE, in the same short window the address is already being hashed in, and
  // only the two-letter code survives the request. No raw IP is written by this line or any other.
  // A missing or unavailable database yields null and changes nothing else about the event.
  const country = countryFor(ip);

  const row = {
    owner: site.owner,
    project_id: String(site.project_id),
    app_id: appId,
    kind,
    occurred_at: now.toISOString(),
    visitor_hash: visitorHash,
    session_hash: sessionHash,
    path: normalizePath(body.path),
    browser,
    os,
    device,
    country,
  };

  if (kind === "pageview") {
    row.referrer_host = referrerHost(body.referrer, body.host);
    row.load_ms = clampInt(body.loadMs, 600_000);
  }

  if (kind === "vitals") {
    row.lcp_ms = clampInt(body.lcp, 600_000);
    row.fcp_ms = clampInt(body.fcp, 600_000);
    row.inp_ms = clampInt(body.inp, 600_000);
    row.ttfb_ms = clampInt(body.ttfb, 600_000);
    const cls = Number(body.cls);
    row.cls = Number.isFinite(cls) && cls >= 0 && cls <= 100 ? Number(cls.toFixed(4)) : null;
    // A vitals beacon carrying no measurements is noise.
    if (!row.lcp_ms && !row.fcp_ms && !row.inp_ms && !row.ttfb_ms && row.cls === null) {
      return { accepted: false, reason: "empty_vitals" };
    }
  }

  if (kind === "error") {
    // Scrubbed on the way IN, not on the way out. A stack trace prints the URL it tried, the token
    // it was given and the file paths of whoever built the app; storing that raw and cleaning it at
    // render time would leave the secret in the database and in every backup of it.
    const clean = scrubErrorFields(body);
    row.error_message = clean.message || "Unknown error";
    row.error_source = clean.source;
    row.error_stack = clean.stack;
    row.status_code = clampInt(body.status, 599);
    // Only the path is kept from a request URL, for the same reason query strings are stripped
    // from page paths: they carry tokens and identifiers belonging to the site's own users.
    row.request_url = body.requestUrl ? normalizePath(body.requestUrl) : null;
    row.request_method = body.requestMethod ? String(body.requestMethod).toUpperCase().slice(0, 10) : null;
  }

  const { error } = await client.from("analytics_events").insert(row);
  if (error) return { accepted: false, reason: "storage" };
  return { accepted: true, kind };
}
