// THE operational vocabulary: what health, domain verification and SSL states are called, what
// they mean, and what a person should do about them.
//
// This exists for the same reason publishResolution.mjs does. Health labels lived inside
// HealthView.jsx and were imported by OverviewTab — a component reaching into another component
// for its vocabulary — while domain labels lived in publishLifecycle.js and the project card
// compared `health.status !== "healthy"` as a bare string. Four surfaces, three sources, and no
// structural reason they would agree.
//
// Pure and dependency-free, so the server can import it too: a notification about a domain becoming
// Active should use the same word the panel does.

export const HEALTH_STATUS = Object.freeze({
  healthy: "healthy",
  warning: "warning",
  offline: "offline",
  unchecked: "unchecked",
});

// "Degraded", not "Warning": it describes the site, not the database row. "Not yet checked" is a
// real state and never silently becomes Healthy — a site nobody has looked at has not earned a
// green tick.
export const HEALTH_LABEL = Object.freeze({
  healthy: "Healthy",
  warning: "Degraded",
  offline: "Offline",
  unchecked: "Not checked yet",
});

export const HEALTH_TONE = Object.freeze({
  healthy: "live", warning: "update", offline: "failed", unchecked: "muted",
});

export const HEALTH_DOT = Object.freeze({
  healthy: "🟢", warning: "🟡", offline: "🔴", unchecked: "⚪",
});

export function healthExplanation(status, detail = null) {
  if (detail) return detail;
  switch (status) {
    case HEALTH_STATUS.healthy: return "Responding normally.";
    case HEALTH_STATUS.warning:
      return "The site is serving, but something is wrong — a slow response, an expiring certificate, or one failed check.";
    case HEALTH_STATUS.offline:
      return "The site did not respond to two checks in a row.";
    default:
      return "Monitoring begins within a few minutes of publishing.";
  }
}

// The status of a site as every surface should read it. `null` health means no check has been
// recorded, which is `unchecked` — never healthy.
export function healthStateOf(health) {
  const status = health?.status;
  return HEALTH_STATUS[status] ? status : HEALTH_STATUS.unchecked;
}

export const isHealthProblem = (status) =>
  status === HEALTH_STATUS.warning || status === HEALTH_STATUS.offline;

// ── Domains ─────────────────────────────────────────────────────────────────────────────

export const DOMAIN_STATUS = Object.freeze({
  pendingDns: "pending_dns",
  verifying: "verifying",
  active: "active",
  failed: "failed",
});

export const DOMAIN_LABEL = Object.freeze({
  pending_dns: "Pending DNS",
  verifying: "Verifying",
  active: "Active",
  failed: "Verification failed",
});

export const DOMAIN_TONE = Object.freeze({
  pending_dns: "update", verifying: "update", active: "live", failed: "failed",
});

/**
 * What each domain state means and what to do about it.
 *
 * Written for the person who just added a domain and is wondering whether they did it wrong. Each
 * one names the record to check rather than saying "waiting" — a status that gives no next step is
 * a status that generates a support email.
 */
export function domainExplanation(status) {
  switch (status) {
    case DOMAIN_STATUS.pendingDns:
      return "Add the two DNS records below at your domain provider. We check every minute, and DNS can take up to an hour to propagate.";
    case DOMAIN_STATUS.verifying:
      return "Ownership is confirmed. Waiting for the domain itself to point at Thrallo — that is the second record.";
    case DOMAIN_STATUS.active:
      return "Live and secured with HTTPS.";
    case DOMAIN_STATUS.failed:
      return "We stopped checking after 48 hours. Check both records are exactly as shown, then retry — retrying keeps the same token, so DNS you have already set up stays valid.";
    default:
      return "This domain is not connected.";
  }
}

// A domain only counts as an address people can be sent to when it is active. Anything else and the
// Thrallo URL is still the real one.
export const isDomainLive = (status) => status === DOMAIN_STATUS.active;

// ── SSL ─────────────────────────────────────────────────────────────────────────────────
//
// Deliberately separate from verification status. A domain can be verified and routed while the
// certificate is still seconds away, and conflating the two made "Active" mean two things.

export const SSL_LABEL = Object.freeze({ active: "HTTPS active", pending: "HTTPS pending" });

export function sslExplanation(sslStatus, domainStatus) {
  if (!isDomainLive(domainStatus)) {
    return "No certificate is requested until ownership is verified — that is the whole point of the check.";
  }
  return sslStatus === "active"
    ? "A certificate is installed and serving."
    : "The certificate is issued on the first visit to the domain, which takes a few seconds.";
}

// ── One summary, for every surface ──────────────────────────────────────────────────────

/**
 * Everything operational about one project, resolved once.
 *
 * `attention` is what a card badge or a tile should show: the single most urgent thing wrong, or
 * null when nothing is. Computing it here rather than in each surface is what stops the card
 * saying one thing and the panel another.
 */
export function operationalSummary({ health = null, domains = [], deployment = null } = {}) {
  const healthState = healthStateOf(health);
  const list = (domains || []).map((d) => ({
    ...d,
    label: DOMAIN_LABEL[d.status] || d.status,
    tone: DOMAIN_TONE[d.status] || "muted",
    explanation: domainExplanation(d.status),
    sslLabel: SSL_LABEL[d.sslStatus] || SSL_LABEL.pending,
    sslExplanation: sslExplanation(d.sslStatus, d.status),
    live: isDomainLive(d.status),
  }));

  const activeDomain = list.find((d) => d.live) || null;
  const pendingDomain = list.find((d) => !d.live) || null;

  // Ordered by how much it matters to someone glancing at a dashboard: the site being down beats a
  // failed deployment, which beats a domain that will not verify, which beats a slow response.
  let attention = null;
  if (healthState === HEALTH_STATUS.offline) {
    attention = { kind: "offline", tone: "failed", label: "Offline", detail: healthExplanation(healthState, health?.detail) };
  } else if (deployment && deployment.status === "failed") {
    attention = { kind: "deploy_failed", tone: "failed", label: `Deployment #${deployment.number} failed`, detail: deployment.failureReason || null };
  } else if (list.some((d) => d.status === DOMAIN_STATUS.failed)) {
    const bad = list.find((d) => d.status === DOMAIN_STATUS.failed);
    attention = { kind: "domain_failed", tone: "failed", label: `${bad.domain} could not be verified`, detail: bad.explanation };
  } else if (healthState === HEALTH_STATUS.warning) {
    attention = { kind: "degraded", tone: "update", label: "Degraded", detail: healthExplanation(healthState, health?.detail) };
  } else if (pendingDomain) {
    attention = { kind: "domain_pending", tone: "update", label: `${pendingDomain.domain} — ${pendingDomain.label}`, detail: pendingDomain.explanation };
  }

  return {
    health: {
      status: healthState,
      label: HEALTH_LABEL[healthState],
      tone: HEALTH_TONE[healthState],
      dot: HEALTH_DOT[healthState],
      explanation: healthExplanation(healthState, health?.detail),
      checked: healthState !== HEALTH_STATUS.unchecked,
    },
    domains: list,
    activeDomain,
    pendingDomain,
    // The address to show. Only an active domain replaces the Thrallo one.
    attention,
  };
}
