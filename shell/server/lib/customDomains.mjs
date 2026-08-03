// Custom domains, with ownership verified before any certificate is requested.
//
// The rule that matters: Caddy asks Thrallo whether it may mint a certificate for a hostname, and
// Thrallo now answers yes ONLY for a domain in `active`. Reaching active requires two independent
// proofs — a TXT token nobody else could publish, and the domain actually resolving here. Without
// the first, anyone could point a hostname at the VPS and have Thrallo request a certificate for
// it; without the second, an "active" domain could be one that has never worked.

import { promises as dns } from "node:dns";
import { randomBytes } from "node:crypto";
import { serviceClient } from "./supabase.mjs";
import { optionalEnv } from "./env.mjs";
import { ownerSubscription } from "./usageBudgets.mjs";

export const DOMAIN_STATUS = Object.freeze({
  pendingDns: "pending_dns",
  verifying: "verifying",
  active: "active",
  failed: "failed",
});

// Unlimited is null rather than Infinity so it survives JSON.
export const DOMAIN_LIMITS = Object.freeze({ free: 0, starter: 1, pro: null });

// Long enough to cover slow propagation (hour-long TTLs are common, and registrars can be slower)
// without polling a domain nobody intends to fix. Retry restarts the clock.
const GIVE_UP_AFTER_MS = 48 * 60 * 60 * 1000;
const VERIFY_PREFIX = "_thrallo-verify";

const publicIp = () => optionalEnv("THRALLO_PUBLIC_IP", "51.195.136.189");
const appSuffix = () => optionalEnv("APP_DOMAIN_SUFFIX", "app.thrallo.com");

// Rejects anything that is not a plain registrable hostname: no scheme, no path, no ports, and
// never a Thrallo suffix (those are ours to hand out, not to claim).
export function normalizeDomain(input) {
  const cleaned = String(input || "").trim().toLowerCase()
    .replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
  if (!/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(cleaned)) return null;
  if (cleaned.endsWith(".thrallo.com") || cleaned === "thrallo.com") return null;
  return cleaned;
}

// An apex domain cannot be a CNAME, so the A record is what is offered there; a subdomain gets the
// friendlier CNAME. Both forms are shown as copyable records rather than described in prose.
export function dnsRecordsFor(domain, token, slug) {
  const labels = domain.split(".");
  const isApex = labels.length === 2;
  return [
    {
      purpose: "verification",
      type: "TXT",
      name: `${VERIFY_PREFIX}.${domain}`,
      value: token,
      note: "Proves you own this domain. It can be removed once the domain is Active.",
    },
    isApex
      ? {
        purpose: "routing", type: "A", name: domain, value: publicIp(),
        note: "Points the domain at Thrallo.",
      }
      : {
        purpose: "routing", type: "CNAME", name: domain, value: `${slug}.${appSuffix()}`,
        note: "Points the domain at your Thrallo site.",
      },
  ];
}

export function domainLimitFor(plan) {
  return Object.prototype.hasOwnProperty.call(DOMAIN_LIMITS, plan) ? DOMAIN_LIMITS[plan] : 0;
}

function publicDomain(row) {
  return {
    domain: row.domain,
    projectId: row.project_id,
    status: row.status,
    sslStatus: row.ssl_status,
    verifiedAt: row.verified_at,
    lastCheckedAt: row.last_checked_at,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    records: dnsRecordsFor(row.domain, row.verification_token || "", row.slug),
  };
}

export async function listDomains(owner, projectId, client = serviceClient()) {
  const { data, error } = await client.from("custom_domains")
    .select("*").eq("owner", owner).eq("project_id", String(projectId))
    .order("created_at", { ascending: true });
  if (error) throw new Error(`custom_domains read failed: ${error.message || error}`);
  return (data || []).map(publicDomain);
}

export async function domainAllowance(owner, { store = null, client = serviceClient() } = {}) {
  const subscription = await ownerSubscription(owner, store ? { store } : {});
  const limit = domainLimitFor(subscription.plan);
  const { count } = await client.from("custom_domains")
    .select("domain", { count: "exact", head: true }).eq("owner", owner);
  return { plan: subscription.plan, limit, used: count || 0, unlimited: limit === null };
}

function billingError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

export async function addDomain(owner, projectId, input, { client = serviceClient(), store = null } = {}) {
  const domain = normalizeDomain(input);
  if (!domain) {
    throw billingError("That doesn't look like a domain you can connect (e.g. yourbusiness.com).", 400, "bad_domain");
  }

  // The site must exist first: the routing record points at its slug, and a domain attached to
  // nothing would sit pending forever.
  const { data: site } = await client.from("published_sites")
    .select("slug,unpublished_at").eq("project_id", String(projectId)).eq("owner", owner).maybeSingle();
  if (!site) throw billingError("Publish this project first, then connect a domain to it.", 409, "not_published");

  const allowance = await domainAllowance(owner, { store, client });
  if (allowance.limit === 0) {
    throw billingError(
      "Custom domains are available on Starter and Pro. Your Thrallo address keeps working on every plan.",
      402, "plan_required",
    );
  }
  if (allowance.limit !== null && allowance.used >= allowance.limit) {
    throw billingError(
      `Your plan includes ${allowance.limit} custom domain${allowance.limit === 1 ? "" : "s"}. `
      + "Remove one, or upgrade to Pro for unlimited domains.",
      402, "domain_limit",
    );
  }

  const { data: holder } = await client.from("custom_domains")
    .select("owner,project_id").eq("domain", domain).maybeSingle();
  if (holder) {
    // Never reveal WHO holds it — that would leak one customer's domain to another.
    if (holder.owner !== owner) throw billingError("That domain is already connected to another app.", 409, "domain_taken");
    if (String(holder.project_id) === String(projectId)) throw billingError("That domain is already connected to this project.", 409, "already_connected");
    throw billingError("That domain is connected to another of your projects. Remove it there first.", 409, "domain_in_use");
  }

  const row = {
    domain,
    owner,
    project_id: String(projectId),
    slug: site.slug,
    status: DOMAIN_STATUS.pendingDns,
    verification_token: `thrallo-verify=${randomBytes(16).toString("hex")}`,
    ssl_status: "pending",
    verification_started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const { error } = await client.from("custom_domains").insert(row);
  if (error) throw new Error(`custom_domains insert failed: ${error.message || error}`);

  // Check straight away: someone who set DNS up in advance should not wait for a sweep.
  return (await verifyDomain(owner, domain, { client })) || publicDomain(row);
}

export async function removeDomain(owner, domain, { client = serviceClient(), detach = null } = {}) {
  const cleaned = normalizeDomain(domain);
  const { data: row } = await client.from("custom_domains")
    .select("domain,status").eq("domain", cleaned || "").eq("owner", owner).maybeSingle();
  if (!row) throw billingError("That domain isn't connected.", 404, "not_connected");

  // Detach BEFORE deleting the row. If the order were reversed and the detach failed, Caddy would
  // keep serving a hostname that Thrallo no longer knows about.
  if (detach) await detach(cleaned).catch((error) => console.error(`[domains] detach ${cleaned}: ${error?.message}`));

  const { error } = await client.from("custom_domains").delete().eq("domain", cleaned).eq("owner", owner);
  if (error) throw new Error(`custom_domains delete failed: ${error.message || error}`);
  return { removed: cleaned };
}

// ── Verification ────────────────────────────────────────────────────────────────────────

async function txtRecords(domain, resolver) {
  try {
    return (await resolver.resolveTxt(`${VERIFY_PREFIX}.${domain}`)).map((parts) => parts.join(""));
  } catch { return []; }
}

async function pointsHere(domain, resolver) {
  const ip = publicIp();
  try {
    if ((await resolver.resolve4(domain)).includes(ip)) return true;
  } catch { /* fall through to CNAME */ }
  try {
    const target = (await resolver.resolveCname(domain))[0];
    if (!target) return false;
    // A CNAME to a Thrallo host is correct by construction; anything else must resolve to our IP.
    if (target.replace(/\.$/, "").endsWith(appSuffix())) return true;
    return (await resolver.resolve4(target)).includes(ip);
  } catch { return false; }
}

// Has the certificate actually been issued? Caddy mints on first handshake, so a successful TLS
// request is the only honest evidence. Reported separately from `status` because a domain can be
// verified and routed while the certificate is still seconds away.
async function certificateLive(domain, fetchImpl) {
  try {
    const response = await fetchImpl(`https://${domain}/`, {
      method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(6_000),
    });
    return response.status > 0;
  } catch { return false; }
}

/**
 * Re-check one domain and persist the result. Returns the public shape, or null if it is gone.
 *
 * Attaching to Caddy happens only on the transition into `active`, after both proofs pass — that
 * is the gate the whole feature exists for.
 */
export async function verifyDomain(owner, domain, {
  client = serviceClient(),
  resolver = dns,
  attach = null,
  fetchImpl = fetch,
} = {}) {
  const cleaned = normalizeDomain(domain);
  const { data: row } = await client.from("custom_domains")
    .select("*").eq("domain", cleaned || "").eq("owner", owner).maybeSingle();
  if (!row) return null;

  const now = new Date().toISOString();
  const patch = { last_checked_at: now, updated_at: now };

  const tokens = await txtRecords(cleaned, resolver);
  const ownershipProven = !!row.verification_token && tokens.includes(row.verification_token);
  const routed = ownershipProven ? await pointsHere(cleaned, resolver) : false;

  if (ownershipProven && routed) {
    patch.status = DOMAIN_STATUS.active;
    patch.verified_at = row.verified_at || now;
    patch.failure_reason = null;
    if (row.status !== DOMAIN_STATUS.active && attach) {
      // Only now may a certificate be requested for this hostname.
      await attach(cleaned, row.slug).catch((error) => {
        console.error(`[domains] attach ${cleaned}: ${error?.message}`);
      });
    }
    patch.ssl_status = (await certificateLive(cleaned, fetchImpl)) ? "active" : "pending";
  } else {
    // A domain that WAS active and has stopped resolving goes back to verifying rather than
    // straight to pending: the token is still published, only the routing broke, and saying so
    // points the owner at the right record to fix.
    patch.status = ownershipProven ? DOMAIN_STATUS.verifying : DOMAIN_STATUS.pendingDns;
    if (row.status === DOMAIN_STATUS.active) {
      // It is no longer serving, so it must stop claiming a certificate is in place.
      patch.ssl_status = "pending";
    }
    patch.failure_reason = ownershipProven
      ? "The verification record is correct, but the domain does not point to Thrallo yet."
      : "Waiting for the verification TXT record to appear in DNS.";
    // Give up eventually rather than polling a domain nobody is going to fix. Measured from when
    // the domain was added rather than counting attempts, so a restart cannot reset the clock and
    // a slow-propagating record is not punished for being checked often.
    const age = Date.now() - Date.parse(row.verification_started_at || row.created_at || now);
    if (Number.isFinite(age) && age > GIVE_UP_AFTER_MS) {
      patch.status = DOMAIN_STATUS.failed;
      patch.failure_reason = "We could not verify this domain. Check the DNS records and try again.";
    }
  }

  const { data: updated, error } = await client.from("custom_domains")
    .update(patch).eq("domain", cleaned).eq("owner", owner).select("*").single();
  if (error) throw new Error(`custom_domains update failed: ${error.message || error}`);
  return publicDomain(updated);
}

// Retry clears the failure and starts the checks again with the same token, so DNS already set up
// does not have to change.
export async function retryDomain(owner, domain, options = {}) {
  const client = options.client || serviceClient();
  const cleaned = normalizeDomain(domain);
  await client.from("custom_domains")
    .update({
      status: DOMAIN_STATUS.pendingDns, failure_reason: null,
      verification_started_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    })
    .eq("domain", cleaned || "").eq("owner", owner);
  return verifyDomain(owner, cleaned, options);
}

// How often a domain that is already Active is proved still correct. Frequent enough to notice a
// zone edit within a working day, rare enough not to hammer DNS for every domain every minute.
export const ACTIVE_RECHECK_MS = 6 * 60 * 60 * 1000;

/**
 * Domains the verifier should look at: everything still working towards active, plus active
 * domains that have not been confirmed recently.
 *
 * Re-checking active domains is the part that was missing. Once verified, a domain stayed Active
 * regardless of what happened to its DNS afterwards — so a zone edit silently broke a customer's
 * address while Thrallo kept reporting it as working.
 */
export async function unsettledDomains(client = serviceClient(), limit = 25, now = new Date()) {
  const { data: pending, error } = await client.from("custom_domains")
    .select("domain,owner,status,last_checked_at")
    .in("status", [DOMAIN_STATUS.pendingDns, DOMAIN_STATUS.verifying])
    .order("last_checked_at", { ascending: true, nullsFirst: true })
    .limit(limit);
  if (error) throw new Error(`custom_domains read failed: ${error.message || error}`);

  const remaining = limit - (pending?.length || 0);
  if (remaining <= 0) return pending || [];

  const staleBefore = new Date(now.getTime() - ACTIVE_RECHECK_MS).toISOString();
  const { data: active } = await client.from("custom_domains")
    .select("domain,owner,status,last_checked_at")
    .eq("status", DOMAIN_STATUS.active)
    .or(`last_checked_at.is.null,last_checked_at.lt.${staleBefore}`)
    .order("last_checked_at", { ascending: true, nullsFirst: true })
    .limit(remaining);
  return [...(pending || []), ...(active || [])];
}
