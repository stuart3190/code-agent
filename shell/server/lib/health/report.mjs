// Reading health back: the badge for a card, and the detail for the health page.

import { serviceClient } from "../supabase.mjs";

// Uptime counts a site as up unless it was actually offline. A slow response or a certificate
// expiring soon is a warning worth showing, but calling it downtime would make the number
// meaningless — the site was serving.
const isUp = (status) => status !== "offline";

export async function healthForOwner(owner, client = serviceClient()) {
  const { data } = await client.from("health_status").select("*").eq("owner", owner);
  const byProject = new Map();
  for (const row of data || []) {
    byProject.set(String(row.project_id), {
      projectId: String(row.project_id),
      status: row.status,
      since: row.since,
      lastCheckedAt: row.last_checked_at,
      detail: row.detail,
      responseMs: row.response_ms,
      sslDaysLeft: row.ssl_days_left,
    });
  }
  return byProject;
}

export async function healthDetail(owner, projectId, { client = serviceClient(), days = 30, now = new Date() } = {}) {
  const { data: status } = await client.from("health_status")
    .select("*").eq("project_id", String(projectId)).eq("owner", owner).maybeSingle();

  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const { data: rows } = await client.from("health_checks")
    .select("checked_at,status,http_status,response_ms,detail")
    .eq("project_id", String(projectId)).eq("owner", owner)
    .gte("checked_at", since)
    .order("checked_at", { ascending: false });
  const checks = rows || [];

  const up = checks.filter((c) => isUp(c.status)).length;
  const responses = checks.map((c) => c.response_ms).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);

  // Daily buckets, so the page can draw uptime per day rather than one number for the month.
  const byDay = new Map();
  for (const check of checks) {
    const day = String(check.checked_at).slice(0, 10);
    const bucket = byDay.get(day) || { day, total: 0, up: 0, responseSum: 0, responseCount: 0 };
    bucket.total += 1;
    if (isUp(check.status)) bucket.up += 1;
    if (Number.isFinite(check.response_ms)) { bucket.responseSum += check.response_ms; bucket.responseCount += 1; }
    byDay.set(day, bucket);
  }

  // Only actual outages, collapsed into periods rather than one entry per failed check.
  const incidents = [];
  for (const check of [...checks].reverse()) {
    if (check.status === "offline") {
      const open = incidents[incidents.length - 1];
      if (open && !open.endedAt) open.checks += 1;
      else incidents.push({ startedAt: check.checked_at, endedAt: null, checks: 1, detail: check.detail });
    } else {
      const open = incidents[incidents.length - 1];
      if (open && !open.endedAt) open.endedAt = check.checked_at;
    }
  }

  return {
    status: status ? {
      status: status.status,
      since: status.since,
      lastCheckedAt: status.last_checked_at,
      lastHealthyAt: status.last_healthy_at,
      url: status.url,
      httpStatus: status.http_status,
      responseMs: status.response_ms,
      sslValidTo: status.ssl_valid_to,
      sslDaysLeft: status.ssl_days_left,
      dnsOk: status.dns_ok,
      detail: status.detail,
    } : null,
    // Null rather than 100 when nothing has been checked: an unmonitored site has no uptime, and
    // claiming perfection would be the most misleading possible default.
    uptime: checks.length ? Number(((up / checks.length) * 100).toFixed(2)) : null,
    checks: checks.length,
    windowDays: days,
    responseTime: responses.length ? {
      medianMs: responses[Math.floor(responses.length / 2)],
      p95Ms: responses[Math.floor(responses.length * 0.95)] ?? responses[responses.length - 1],
      slowestMs: responses[responses.length - 1],
    } : null,
    daily: [...byDay.values()]
      .map((b) => ({
        day: b.day,
        uptime: Number(((b.up / b.total) * 100).toFixed(2)),
        averageMs: b.responseCount ? Math.round(b.responseSum / b.responseCount) : null,
      }))
      .sort((a, b) => (a.day < b.day ? -1 : 1)),
    incidents: incidents.reverse().slice(0, 20),
    recent: checks.slice(0, 50),
  };
}
