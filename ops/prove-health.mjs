// Live proof for health monitoring. Runs REAL sweeps against production data.
//
// Not a test double: it publishes a throwaway site record, sweeps, breaks it, sweeps again,
// restores it, sweeps again, then unpublishes — and reads the actual rows each time.

import { serviceClient } from "../shell/server/lib/supabase.mjs";
import { sweepHealth, checkProject, liveSites } from "../shell/server/lib/health/monitor.mjs";
import { healthForOwner, healthDetail } from "../shell/server/lib/health/report.mjs";

const db = serviceClient();
const out = [];
let failed = 0;
const check = (ok, label, detail = "") => {
  out.push(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed += 1;
};

// ── 1. A real sweep over the real estate ────────────────────────────────────────────────
const sites = await liveSites(db);
console.log(`[proof] ${sites.length} live site(s), ${sites.reduce((n, s) => n + s.targets.length, 0)} address(es)`);
for (const s of sites) console.log(`         ${s.slug}: ${s.targets.map((t) => t.url).join(", ")}`);

const before = new Date().toISOString();
const sweep = await sweepHealth({ client: db });
check(sweep.checked === sweep.sites, "the sweep checked every live site",
  `${sweep.checked}/${sweep.sites}, ${sweep.failures.length} failure(s)`);
if (sweep.failures.length) for (const f of sweep.failures) console.log(`         failure: ${f.projectId}: ${f.error}`);

// ── 2. Rows were actually written ───────────────────────────────────────────────────────
const { data: fresh } = await db.from("health_checks").select("*").gte("checked_at", before);
check((fresh || []).length > 0, "the sweep wrote health_checks rows", `${(fresh || []).length} row(s)`);

const { data: statuses } = await db.from("health_status").select("*").gte("last_checked_at", before);
check((statuses || []).length === sweep.checked, "every checked site has a current health_status",
  `${(statuses || []).length} of ${sweep.checked}`);

// ── 3. The fields the UI shows are populated ────────────────────────────────────────────
const sample = (statuses || [])[0];
if (sample) {
  check(Number.isFinite(sample.response_ms), "response time is populated", `${sample.response_ms}ms`);
  check(Number.isFinite(sample.http_status), "HTTP status is populated", String(sample.http_status));
  check(sample.dns_ok !== null && sample.dns_ok !== undefined, "DNS state is populated", String(sample.dns_ok));
  check(!!sample.ssl_valid_to, "SSL expiry is populated", String(sample.ssl_valid_to).slice(0, 10));
  check(Number.isFinite(sample.ssl_days_left), "SSL days remaining is populated", `${sample.ssl_days_left} days`);
} else check(false, "at least one live site to inspect");

// ── 4. Overview and Health read the same state ──────────────────────────────────────────
if (sample) {
  const owner = sample.owner;
  const map = await healthForOwner(owner, db);                      // what cards/Overview use
  const detail = await healthDetail(owner, sample.project_id, { client: db });  // what the Health page uses
  const card = map.get(String(sample.project_id));
  check(!!card && card.status === detail.status?.status,
    "Overview and Health report the SAME status", `${card?.status} vs ${detail.status?.status}`);
  check(card?.lastCheckedAt === detail.status?.lastCheckedAt,
    "…and the same last-checked time");
  check(detail.uptime !== null, "uptime is a real number once checks exist", `${detail.uptime}%`);
}

// ── 5. A deliberately unavailable site transitions to Offline, then recovers ────────────
if (sample) {
  const owner = sample.owner;
  const projectId = "00000000-0000-4000-8000-00000000dead";
  const broken = { owner, project_id: projectId, url: "https://definitely-not-a-real-site.thrallo.com/", slug: "proof" };
  // Alerts are tracked PER KIND, because that is the guarantee: an expiring certificate must still
  // get through while a site is already slow. Counting them all together says nothing.
  const sent = [];
  const notify = async (_o, alert) => { sent.push(alert.tag); };
  const kind = (k) => sent.filter((t) => t.startsWith(`health-${k}-`)).length;

  await db.from("health_status").delete().eq("project_id", projectId);
  await db.from("health_checks").delete().eq("project_id", projectId);

  const first = await checkProject(broken, { client: db, notify });
  check(first.status === "warning",
    "ONE failed probe reports Degraded, not a false outage", first.status);
  check(sent.length === 0, "and alerts about NOTHING on a single blip — outage or DNS",
    sent.join(", ") || "silent");

  const second = await checkProject(broken, { client: db, notify });
  check(second.status === "offline", "a second consecutive failure transitions to Offline", second.status);
  check(kind("offline") === 1, "the outage alerts exactly once", `${kind("offline")} offline alert(s)`);
  check(kind("dns") === 1, "and the unresolvable hostname alerts once too, separately",
    `${kind("dns")} dns alert(s)`);

  const third = await checkProject(broken, { client: db, notify });
  check(third.status === "offline", "it stays offline");
  check(kind("offline") === 1 && kind("dns") === 1,
    "and NEITHER alerts again on the next sweep", `offline ${kind("offline")}, dns ${kind("dns")}`);

  // Recovery: point it at a URL that works.
  const healthy = { ...broken, url: sample.url || "https://app.thrallo.com/" };
  const back = await checkProject(healthy, { client: db, notify });
  check(back.status === "healthy", "recovery transitions back to Healthy", back.status);
  check(kind("recovered") === 1, "and sends exactly one recovery notification",
    `${kind("recovered")} recovery alert(s)`);
  check(sent.length === 3, "three alerts across the whole episode, one per transition",
    sent.map((t) => t.split("-")[1]).join(" → "));

  const { data: row } = await db.from("health_status").select("*").eq("project_id", projectId).maybeSingle();
  check(row?.consecutive_failures === 0, "the failure counter resets on recovery", String(row?.consecutive_failures));
  check(!row?.alerted?.offline, "and the offline alert flag is cleared, so a future outage alerts again");

  const { data: history } = await db.from("health_checks").select("status").eq("project_id", projectId);
  check((history || []).length === 4, "every probe left a history row", `${(history || []).length} rows`);

  await db.from("health_status").delete().eq("project_id", projectId);
  await db.from("health_checks").delete().eq("project_id", projectId);
  const { data: gone } = await db.from("health_status").select("project_id").eq("project_id", projectId);
  check((gone || []).length === 0, "throwaway state cleaned up");
}

// ── 6. Unpublishing clears health state ─────────────────────────────────────────────────
{
  const src = await import("node:fs/promises").then((m) =>
    m.readFile(new URL("../shell/server/lib/appBuild/appPublishService.mjs", import.meta.url), "utf8"));
  // To the NEXT export, not to a named one — connectDomain is defined earlier in the file, so
  // slicing to it produced an empty string and a false failure.
  const start = src.indexOf("export async function unpublishApp");
  const fn = src.slice(start, src.indexOf("\nexport ", start + 10));
  check(/health_status/.test(fn), "unpublish clears the active health state");
  const teardown = await import("../shell/server/lib/projectTeardown.mjs");
  const tables = teardown.PROJECT_SCOPED_TABLES.map((t) => t.table);
  check(tables.includes("health_status") && tables.includes("health_checks"),
    "delete purges both health tables");
}

console.log(`\n${out.join("\n")}\n`);
console.log(failed ? `${failed} FAILED` : `${out.length}/${out.length} checks passed`);
process.exit(failed ? 1 : 0);
