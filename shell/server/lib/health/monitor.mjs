// The health monitor: probe every live site, record it, and alert on change.
//
// The rule that keeps this usable is that alerts fire on TRANSITION, not on state. A site down
// overnight is one notification, not two hundred, and a site that recovers says so. Each alert
// kind is tracked separately, so a certificate expiring while a site is already slow still gets
// through.

import { serviceClient } from "../supabase.mjs";
import { optionalEnv } from "../env.mjs";
import { notifyOwner } from "../notifications/notificationService.mjs";
import { probeSite, HEALTH, SSL_WARN_DAYS } from "./probe.mjs";

const TICK_MS = 5 * 60_000;
export const CHECK_RETENTION_DAYS = 30;
// One slow or failed probe is usually the internet, not an outage. Two in a row is worth waking
// someone for.
const FAILURES_BEFORE_ALERT = 2;

let timer = null;

export async function liveSites(client) {
  const { data, error } = await client.from("published_sites")
    .select("owner,project_id,url,slug").is("unpublished_at", null);
  // Surfaced, not swallowed. A read failure here means NOTHING gets monitored, and the previous
  // version reported that as "0 sites" — indistinguishable from having no sites at all.
  if (error) throw new Error(`health: could not list published sites: ${error.message}`);
  const sites = data || [];
  if (!sites.length) return [];

  const { data: domains, error: domainError } = await client.from("custom_domains")
    .select("domain,project_id,created_at").eq("status", "active");
  if (domainError) throw new Error(`health: could not list custom domains: ${domainError.message}`);

  const byProject = new Map();
  for (const row of [...(domains || [])].sort((a, b) => Date.parse(a.created_at || 0) - Date.parse(b.created_at || 0))) {
    const key = String(row.project_id);
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key).push(row.domain);
  }

  return sites.map((site) => {
    const custom = byProject.get(String(site.project_id)) || [];
    // EVERY address a visitor might use, not just the primary one. A custom domain can break while
    // the Thrallo address is fine, and vice versa — monitoring one of them hides the other.
    return {
      ...site,
      customDomain: custom[0] || null,
      targets: [
        { url: site.url, kind: "thrallo" },
        ...custom.map((domain) => ({ url: `https://${domain}`, kind: "custom", domain })),
      ],
    };
  });
}

// What should be alerted about, given the previous state. Returns the alerts to send and the new
// alert bookkeeping, so the decision is testable without touching the network or the database.
export function decideAlerts({ previous, result, now = new Date() }) {
  const wasAlerted = previous?.alerted || {};
  const alerted = { ...wasAlerted };
  const alerts = [];

  const failures = result.status === HEALTH.offline ? (previous?.consecutive_failures || 0) + 1 : 0;

  if (result.status === HEALTH.offline) {
    // Held back until it has failed twice, so a single blip does not cry wolf.
    if (failures >= FAILURES_BEFORE_ALERT && !wasAlerted.offline) {
      alerts.push({ kind: "offline", title: "Your site is down", body: result.detail || "The site did not respond." });
      alerted.offline = now.toISOString();
    }
  } else if (wasAlerted.offline) {
    alerts.push({ kind: "recovered", title: "Your site is back online", body: "It is responding normally again." });
    delete alerted.offline;
  }

  const sslSoon = Number.isFinite(result.sslDaysLeft) && result.sslDaysLeft <= SSL_WARN_DAYS;
  if (sslSoon && !wasAlerted.ssl) {
    alerts.push({
      kind: "ssl",
      title: "HTTPS certificate needs attention",
      body: result.detail || `The certificate expires in ${result.sslDaysLeft} days.`,
    });
    alerted.ssl = now.toISOString();
  } else if (!sslSoon && wasAlerted.ssl) {
    delete alerted.ssl;                        // renewed; a future problem should alert again
  }

  // Damped the same way an outage is, and for the same reason: a single resolver hiccup would
  // otherwise tell a customer their domain is misconfigured when nothing had changed. The previous
  // row already records the last DNS result, so "twice in a row" needs no extra counter.
  const dnsFailedTwice = result.dnsOk === false && previous?.dns_ok === false;
  if (dnsFailedTwice && !wasAlerted.dns) {
    alerts.push({
      kind: "dns",
      title: "Custom domain is misconfigured",
      body: "The domain no longer points to Thrallo, so the site will stop working.",
    });
    alerted.dns = now.toISOString();
  } else if (result.dnsOk !== false && wasAlerted.dns) {
    delete alerted.dns;
  }

  return { alerts, alerted, failures };
}

const RANK = { [HEALTH.healthy]: 0, [HEALTH.warning]: 1, [HEALTH.offline]: 2 };

/**
 * A project's health is the WORST of its addresses.
 *
 * Reporting only the primary address hid the case that matters most: a custom domain broken while
 * the Thrallo URL is fine. The owner gave people the custom domain.
 */
export function worstOf(results) {
  return results.reduce((worst, r) => (RANK[r.status] > RANK[worst.status] ? r : worst), results[0]);
}

/**
 * One failed probe is usually the internet, not an outage.
 *
 * A single failure reports DEGRADED, not offline — honest about something being wrong without
 * claiming the site is down. Only a second consecutive failure transitions to offline. Without
 * this, one dropped packet showed a customer that their site was down.
 */
export function dampen(observed, consecutiveFailures) {
  if (observed !== HEALTH.offline) return observed;
  return consecutiveFailures >= FAILURES_BEFORE_ALERT ? HEALTH.offline : HEALTH.warning;
}

export async function checkProject(site, { client = serviceClient(), probe = probeSite, notify = notifyOwner, now = new Date() } = {}) {
  const targets = site.targets?.length ? site.targets : [{ url: site.url, kind: "thrallo" }];
  const expectedIp = optionalEnv("THRALLO_PUBLIC_IP", "51.195.136.189");

  // Every address, not just the primary one.
  const observations = [];
  for (const target of targets) {
    const result = await probe(target.url, { now, expectedIp });
    observations.push({ ...result, kind: target.kind, domain: target.domain || null });
  }
  const result = worstOf(observations);

  const { data: previous, error: readError } = await client.from("health_status")
    .select("*").eq("project_id", String(site.project_id)).maybeSingle();
  if (readError) throw new Error(`health: could not read status for ${site.project_id}: ${readError.message}`);

  const { alerts, alerted, failures } = decideAlerts({ previous, result, now });
  // Damped: a single failure is degraded, not down.
  const status = dampen(result.status, failures);
  const changed = previous?.status !== status;

  // One row per address, so the history can show which one broke.
  const { error: insertError } = await client.from("health_checks").insert(observations.map((o) => ({
    owner: site.owner, project_id: String(site.project_id), checked_at: now.toISOString(),
    url: o.url, status: o.status, http_status: o.httpStatus,
    response_ms: o.responseMs, ssl_valid_to: o.sslValidTo,
    ssl_days_left: o.sslDaysLeft, dns_ok: o.dnsOk, detail: o.detail,
  })));
  if (insertError) throw new Error(`health: could not record checks for ${site.project_id}: ${insertError.message}`);

  const { error: upsertError } = await client.from("health_status").upsert({
    project_id: String(site.project_id), owner: site.owner,
    status,
    // `since` marks when the CURRENT state began, which is what "down for 20 minutes" needs.
    since: changed || !previous ? now.toISOString() : previous.since,
    last_checked_at: now.toISOString(),
    last_healthy_at: status === HEALTH.healthy ? now.toISOString() : previous?.last_healthy_at || null,
    url: result.url, http_status: result.httpStatus, response_ms: result.responseMs,
    ssl_valid_to: result.sslValidTo, ssl_days_left: result.sslDaysLeft,
    dns_ok: result.dnsOk, detail: result.detail,
    consecutive_failures: failures, alerted,
    updated_at: now.toISOString(),
  }, { onConflict: "project_id" });
  if (upsertError) throw new Error(`health: could not update status for ${site.project_id}: ${upsertError.message}`);

  for (const alert of alerts) {
    // An alert that fails to send must not stop the ones after it, or lose the check itself.
    await notify(site.owner, {
      title: alert.title, body: alert.body, url: result.url, tag: `health-${alert.kind}-${site.project_id}`,
    }).catch((error) => console.error(`[health] alert ${alert.kind}: ${error?.message}`));
  }

  return { ...result, status, observations, alerts: alerts.map((a) => a.kind), changed };
}

export async function sweepHealth({ client = serviceClient(), now = new Date(), ...options } = {}) {
  const sites = await liveSites(client);
  const failures = [];
  let checked = 0;
  for (const site of sites) {
    try {
      await checkProject(site, { client, now, ...options });
      checked += 1;
    } catch (error) {
      // One unreachable site must not stop the sweep for everyone else — but it must not vanish
      // either. A sweep that silently checks nothing looks identical to a healthy estate.
      failures.push({ projectId: String(site.project_id), error: error?.message || String(error) });
      console.error(`[health] ${site.project_id}: ${error?.message || error}`);
    }
  }

  const cutoff = new Date(now.getTime() - CHECK_RETENTION_DAYS * 86_400_000).toISOString();
  const { error: pruneError } = await client.from("health_checks").delete().lt("checked_at", cutoff);
  if (pruneError) {
    failures.push({ projectId: null, error: `prune failed: ${pruneError.message}` });
    console.error(`[health] prune: ${pruneError.message}`);
  }

  if (failures.length) {
    console.error(`[health] sweep finished with ${failures.length} failure(s) of ${sites.length} site(s)`);
  }
  return { sites: sites.length, checked, failures };
}

export function startHealthMonitor() {
  if (timer) return;
  if (optionalEnv("THRALLO_HEALTH_MONITOR", "on").toLowerCase() === "off") return;
  timer = setInterval(() => {
    sweepHealth().catch((error) => console.error(`[health] ${error?.message || error}`));
  }, TICK_MS);
  timer.unref?.();
}

export function stopHealthMonitor() {
  if (timer) clearInterval(timer);
  timer = null;
}
