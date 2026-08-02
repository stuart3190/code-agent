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

async function liveSites(client) {
  const { data } = await client.from("published_sites")
    .select("owner,project_id,url,slug").is("unpublished_at", null);
  const sites = data || [];
  if (!sites.length) return [];

  // A verified custom domain is the address visitors actually use, so it is the address monitored.
  const { data: domains } = await client.from("custom_domains")
    .select("domain,project_id,created_at").eq("status", "active");
  const byProject = new Map();
  for (const row of [...(domains || [])].sort((a, b) => Date.parse(a.created_at || 0) - Date.parse(b.created_at || 0))) {
    if (!byProject.has(String(row.project_id))) byProject.set(String(row.project_id), row.domain);
  }
  return sites.map((site) => {
    const custom = byProject.get(String(site.project_id));
    return { ...site, monitorUrl: custom ? `https://${custom}` : site.url, customDomain: custom || null };
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

  if (result.dnsOk === false && !wasAlerted.dns) {
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

export async function checkProject(site, { client = serviceClient(), probe = probeSite, notify = notifyOwner, now = new Date() } = {}) {
  const result = await probe(site.monitorUrl || site.url, { now });

  const { data: previous } = await client.from("health_status")
    .select("*").eq("project_id", String(site.project_id)).maybeSingle();

  const { alerts, alerted, failures } = decideAlerts({ previous, result, now });
  const changed = previous?.status !== result.status;

  await client.from("health_checks").insert({
    owner: site.owner, project_id: String(site.project_id), checked_at: now.toISOString(),
    url: result.url, status: result.status, http_status: result.httpStatus,
    response_ms: result.responseMs, ssl_valid_to: result.sslValidTo,
    ssl_days_left: result.sslDaysLeft, dns_ok: result.dnsOk, detail: result.detail,
  });

  await client.from("health_status").upsert({
    project_id: String(site.project_id), owner: site.owner,
    status: result.status,
    // `since` marks when the CURRENT state began, which is what "down for 20 minutes" needs.
    since: changed || !previous ? now.toISOString() : previous.since,
    last_checked_at: now.toISOString(),
    last_healthy_at: result.status === HEALTH.healthy ? now.toISOString() : previous?.last_healthy_at || null,
    url: result.url, http_status: result.httpStatus, response_ms: result.responseMs,
    ssl_valid_to: result.sslValidTo, ssl_days_left: result.sslDaysLeft,
    dns_ok: result.dnsOk, detail: result.detail,
    consecutive_failures: failures, alerted,
    updated_at: now.toISOString(),
  }, { onConflict: "project_id" });

  for (const alert of alerts) {
    // An alert that fails to send must not stop the ones after it, or lose the check itself.
    await notify(site.owner, {
      title: alert.title, body: alert.body, url: result.url, tag: `health-${alert.kind}-${site.project_id}`,
    }).catch((error) => console.error(`[health] alert ${alert.kind}: ${error?.message}`));
  }

  return { ...result, alerts: alerts.map((a) => a.kind), changed };
}

export async function sweepHealth({ client = serviceClient(), now = new Date(), ...options } = {}) {
  const sites = await liveSites(client);
  let checked = 0;
  for (const site of sites) {
    try {
      await checkProject(site, { client, now, ...options });
      checked += 1;
    } catch (error) {
      // One unreachable site must not stop the sweep for everyone else.
      console.error(`[health] ${site.project_id}: ${error?.message || error}`);
    }
  }
  const cutoff = new Date(now.getTime() - CHECK_RETENTION_DAYS * 86_400_000).toISOString();
  await client.from("health_checks").delete().lt("checked_at", cutoff);
  return { sites: sites.length, checked };
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
