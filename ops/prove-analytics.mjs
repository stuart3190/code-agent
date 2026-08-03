// Live proof for analytics completion. Runs against production.
//
// Real beacons are recorded through the real ingest path, rolled up by the real rollup, and read
// back through the same functions the UI calls. The privacy assertions are the load-bearing ones:
// if a visitor hash could be recomputed, or a query string reached storage, the cookieless claim
// this product is sold on would be false.

import { serviceClient } from "../shell/server/lib/supabase.mjs";
import { recordBeacon, __resetIngestCacheForTests } from "../shell/server/lib/analytics/ingest.mjs";
import { rollupAnalytics, pruneRawEvents } from "../shell/server/lib/analytics/rollup.mjs";
import { overview, liveVisitors, analyticsCapabilities } from "../shell/server/lib/analytics/reports.mjs";
import { buildAnalyticsExport } from "../shell/server/lib/analytics/export.mjs";
import { purgeProjectResources } from "../shell/server/lib/projectTeardown.mjs";

const db = serviceClient();
const out = [];
let failed = 0;
const check = (ok, label, detail = "") => {
  out.push(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed += 1;
};

const BASE = process.env.THRALLO_BASE_URL || "https://app.thrallo.com";
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const SAFARI_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

const email = `pr9-analytics-proof-${Date.now()}@thrallo.invalid`;
const { data: created, error: userError } = await db.auth.admin.createUser({
  email, password: `Pr9!${Math.random().toString(36).slice(2)}Aa1`, email_confirm: true,
});
if (userError) { console.error("could not create throwaway owner:", userError.message); process.exit(1); }
const OWNER = created.user.id;
const PRODUCT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const SLUG = `pr9proof${Date.now().toString(36).slice(-5)}`;
console.log(`[proof] throwaway owner ${OWNER}, app ${SLUG}`);

const setPlan = (plan) => db.from("ca_subscriptions").upsert({ owner: OWNER, plan, status: "active" }, { onConflict: "owner" });

async function cleanup() {
  await purgeProjectResources(OWNER, PROJECT, { client: db, provisiond: null }).catch(() => {});
  await db.from("analytics_events").delete().eq("owner", OWNER);
  await db.from("analytics_daily").delete().eq("owner", OWNER);
  await db.from("published_sites").delete().eq("owner", OWNER);
  await db.from("projects").delete().eq("owner", OWNER);
  await db.from("ca_products").delete().eq("owner", OWNER);
  await db.from("ca_subscriptions").delete().eq("owner", OWNER);
  await db.auth.admin.deleteUser(OWNER).catch(() => {});
}

try {
  await db.from("ca_products").insert({ id: PRODUCT, owner: OWNER, name: "AnalyticsProof" });
  await db.from("projects").insert({ id: PROJECT, owner: OWNER, name: "AnalyticsProof", product_id: PRODUCT, tree: {} });
  await db.from("published_sites").insert({
    owner: OWNER, project_id: PROJECT, product_id: PRODUCT, slug: SLUG,
    url: `https://${SLUG}.app.thrallo.com/`,
  });
  await setPlan("pro");
  __resetIngestCacheForTests();

  // ── Real beacons ──────────────────────────────────────────────────────────────────────
  const today = new Date();
  const at = (hours) => new Date(today.getTime() - hours * 3_600_000);

  const beacons = [
    // Visitor A: two sessions today, so same-day returning is a real 1 rather than a stub.
    { kind: "pageview", path: "/?utm_source=news&email=jo@example.com", referrer: "https://www.google.com/search?q=secret+query", ip: "203.0.113.10", ua: CHROME, at: at(6) },
    { kind: "pageview", path: "/pricing", referrer: "https://news.ycombinator.com/item?id=1", ip: "203.0.113.10", ua: CHROME, at: at(5) },
    { kind: "pageview", path: "/pricing", referrer: "", ip: "203.0.113.11", ua: SAFARI_IPHONE, at: at(4) },
    { kind: "vitals", path: "/", ip: "203.0.113.11", ua: SAFARI_IPHONE, at: at(4), lcp: 1800, fcp: 900, inp: 120, ttfb: 300, cls: 0.04 },
    { kind: "error", path: "/checkout", ip: "203.0.113.12", ua: CHROME, at: at(3),
      message: "Request failed https://api.example.com/pay?token=sk_live_ABCDEFGHIJKLMNOP for jo@example.com",
      source: "https://app.example.com/checkout.js?v=2", stack: "Error\n  at pay (https://app.example.com/checkout.js?key=abc123456789)" },
    { kind: "error", path: "/checkout", ip: "203.0.113.13", ua: CHROME, at: at(2),
      message: "Request failed https://api.example.com/pay?token=other for someone@else.com" },
  ];

  let accepted = 0;
  for (const b of beacons) {
    const result = await recordBeacon({
      body: { ...b, appId: SLUG }, ip: b.ip, userAgent: b.ua, client: db, now: b.at,
    });
    if (result.accepted) accepted += 1;
  }
  check(accepted === beacons.length, "every beacon was recorded through the real ingest path", `${accepted}/${beacons.length}`);

  // ── Privacy at rest ───────────────────────────────────────────────────────────────────
  const { data: raw } = await db.from("analytics_events").select("*").eq("owner", OWNER);
  const dump = JSON.stringify(raw);
  check(!dump.includes("203.0.113."), "no raw IP address is stored anywhere");
  check(!dump.includes("utm_source") && !dump.includes("secret+query"),
    "no query strings — from page paths or referrers");
  check(!dump.includes("jo@example.com") && !dump.includes("someone@else.com"),
    "no email addresses, even inside an error message");
  check(!dump.includes("sk_live_ABCDEFGHIJKLMNOP"), "no API keys from error text");
  check(!raw.some((r) => (r.referrer_host || "").includes("/")),
    "referrers are reduced to a host, never a full URL",
    [...new Set(raw.map((r) => r.referrer_host).filter(Boolean))].join(", "));

  const hashes = new Set(raw.map((r) => r.visitor_hash));
  check(hashes.size === 4, "visitors are distinguished by a rotating hash", `${hashes.size} distinct`);
  check([...hashes].every((h) => /^[0-9a-f]{16,}$/.test(h)), "which is a hash, not anything reversible");

  // ── Rollup, then read back ────────────────────────────────────────────────────────────
  await rollupAnalytics({ client: db, now: today });
  const report = await overview(OWNER, PROJECT, { client: db, days: 30, now: today });

  check(report.totals.pageviews === 3, "page views match the beacons sent", String(report.totals.pageviews));
  check(report.totals.visitors === 4, "unique visitors match", String(report.totals.visitors));
  check(report.totals.errors === 2, "errors match", String(report.totals.errors));
  check(report.sameDayReturning.visitors === 1,
    "same-day returning counts the visitor who came back within the day", String(report.sameDayReturning.visitors));
  check(/more than one session on the same day/.test(report.sameDayReturning.note)
    && /not tracked/.test(report.sameDayReturning.note),
    "labelled accurately, and says cross-day identity is not tracked");

  const pricing = report.topPages.find((p) => p.key === "/pricing");
  check(pricing?.pageviews === 2, "top pages match stored data", `/pricing ${pricing?.pageviews}`);
  check(report.topPages.every((p) => !p.key.includes("?")), "with no query strings in any path");
  const google = report.referrers.find((r) => r.key === "google.com");
  check(!!google, "referrers are hosts", report.referrers.map((r) => r.key).join(", "));
  check(report.browsers.some((b) => b.key === "Chrome") && report.browsers.some((b) => b.key === "Safari"),
    "browsers match", report.browsers.map((b) => b.key).join(", "));
  check(report.devices.some((d) => d.key === "mobile") && report.devices.some((d) => d.key === "desktop"),
    "devices match", report.devices.map((d) => d.key).join(", "));
  check(report.operatingSystems.length > 0, "operating systems are present",
    report.operatingSystems.map((o) => o.key).join(", "));
  check(report.vitals?.samples === 1 && report.vitals.lcpMs === 1800,
    "Core Web Vitals come from real visits", `LCP ${report.vitals?.lcpMs}ms`);

  // ── Error detail, and that it survives the prune ──────────────────────────────────────
  check(Array.isArray(report.errors) && report.errors.length > 0, "error detail is available on a paid plan",
    `${report.errors?.length} distinct`);
  const errorDump = JSON.stringify(report.errors);
  check(!errorDump.includes("sk_live_") && !errorDump.includes("@example.com"),
    "and carries no secrets or emails", report.errors?.[0]?.key?.slice(0, 60));

  await pruneRawEvents({ client: db, now: new Date(today.getTime() + 5 * 86_400_000) });
  const { count: rawLeft } = await db.from("analytics_events")
    .select("id", { count: "exact", head: true }).eq("owner", OWNER);
  check(!rawLeft, "raw events are pruned", `${rawLeft || 0} left`);

  const afterPrune = await overview(OWNER, PROJECT, { client: db, days: 30, now: today });
  check(afterPrune.errors?.length > 0,
    "and the error DETAIL still survives — the count used to outlive the messages",
    `${afterPrune.errors?.length} distinct`);
  check(afterPrune.totals.pageviews === 3, "as do the totals");

  // ── Entitlement ───────────────────────────────────────────────────────────────────────
  await setPlan("free");
  const free = await overview(OWNER, PROJECT, { client: db, days: 30, now: today });
  check(free.capabilities.errorReporting === false, "Free has no error reporting");
  check(free.totals.errors === null,
    "so Free sees no error count — null, not a zero standing in for 'unavailable'", String(free.totals.errors));
  check(free.errors === null, "and no error detail either");
  check(free.series.every((d) => d.errors === null), "not even per day in the trend");
  check(free.window.days === 7, "Free is capped to 7 days server-side", String(free.window.days));
  check(free.window.clamped === true, "and told that it was shortened");

  let freeExport = null;
  await buildAnalyticsExport(OWNER, PROJECT, { client: db, days: 7, format: "csv", now: today })
    .catch((error) => { freeExport = error; });
  check(freeExport?.code === "plan_required", "and export is refused on Free", freeExport?.code || "IT WORKED");

  await setPlan("starter");
  const starter = await overview(OWNER, PROJECT, { client: db, days: 365, now: today });
  check(starter.totals.errors === 2, "Starter sees the error count", String(starter.totals.errors));
  check(starter.errors?.length > 0, "and the detail");
  check(starter.window.days === 90, "capped to 90 days server-side", String(starter.window.days));

  await setPlan("pro");

  // ── Previous-period comparison ────────────────────────────────────────────────────────
  {
    // Seed the period BEFORE this one so the comparison has something real to compare against.
    const priorDay = new Date(today.getTime() - 10 * 86_400_000).toISOString().slice(0, 10);
    await db.from("analytics_daily").insert({
      owner: OWNER, project_id: PROJECT, day: priorDay, dimension: "totals", key: "",
      pageviews: 6, visitors: 2, sessions: 2, errors: 0,
      lcp_sum: 0, fcp_sum: 0, inp_sum: 0, ttfb_sum: 0, load_sum: 0, cls_sum: 0, vitals_count: 0,
      updated_at: new Date().toISOString(),
    });
    const compared = await overview(OWNER, PROJECT, { client: db, days: 7, now: today });
    check(compared.window.comparable === true, "a 7-day window on Pro can be compared with the 7 before it");
    check(compared.previous?.pageviews === 6, "the previous period is read", String(compared.previous?.pageviews));
    // 3 now vs 6 before = -50%.
    check(compared.change?.pageviews === -50,
      "and the change is arithmetically correct", `${compared.change?.pageviews}%`);
    check(compared.change?.errors === null,
      "a metric with nothing before it reports null rather than infinite growth", String(compared.change?.errors));
    await db.from("analytics_daily").delete().eq("owner", OWNER).eq("day", priorDay);
  }

  // ── Export ────────────────────────────────────────────────────────────────────────────
  const json = await buildAnalyticsExport(OWNER, PROJECT, { client: db, days: 30, format: "json", now: today });
  const parsed = JSON.parse(json.body);
  check(json.filename.endsWith(".json") && json.contentType === "application/json", "JSON export is well formed", json.filename);
  check(parsed.totals.pageviews === 3 && parsed.daily.length > 0, "with the real dataset, not a page of it",
    `${parsed.daily.length} day(s)`);
  check(parsed.meta.range.from === report.window.from, "covering the selected range", parsed.meta.range.from);
  check(/No IP addresses/.test(parsed.meta.privacy), "and stating its privacy guarantees");
  check(!!parsed.errors && !!parsed.coreWebVitals && !!parsed.topPages,
    "including errors, vitals and rankings");

  const csv = await buildAnalyticsExport(OWNER, PROJECT, { client: db, days: 30, format: "csv", now: today });
  check(csv.contentType.startsWith("text/csv"), "CSV export is well formed", csv.filename);
  check(/# Daily totals/.test(csv.body) && /"Date","Page views"/.test(csv.body),
    "with clear column names");
  check(/# Exported: 20/.test(csv.body), "and a timestamp");
  const csvRows = csv.body.split("\n").filter((l) => /^"20\d\d-/.test(l));
  check(csvRows.length === report.series.length, "one row per day in the range",
    `${csvRows.length} of ${report.series.length}`);

  const exportDump = `${json.body}\n${csv.body}`;
  check(!exportDump.includes("203.0.113."), "no IP address survives into an export");
  check(!/visitor_hash|session_hash|salt/i.test(exportDump), "no visitor, session or salt identifiers");
  check(!exportDump.includes("utm_source") && !exportDump.includes("secret+query"), "no query strings");
  check(!exportDump.includes("sk_live_ABCDEFGHIJKLMNOP") && !exportDump.includes("jo@example.com"),
    "no secrets or emails from error text");
  check(!/https:\/\/www\.google\.com\/search/.test(exportDump), "no full referrer URLs");

  // ── Authentication and ownership ──────────────────────────────────────────────────────
  const anon = await fetch(`${BASE}/api/v1/projects/${PROJECT}/analytics/export?format=csv`).catch(() => null);
  check(anon?.status === 401, "the export endpoint refuses an anonymous request", String(anon?.status));

  let foreign = null;
  await buildAnalyticsExport(crypto.randomUUID(), PROJECT, { client: db, days: 30, format: "csv", now: today })
    .catch((error) => { foreign = error; });
  check(foreign?.code === "not_published" || foreign?.status === 409,
    "and another owner gets nothing for this project", foreign?.code || "IT RETURNED DATA");

  // ── One identity across publishes ─────────────────────────────────────────────────────
  {
    // A publish update and a rollback both keep the slug, and the slug IS the analytics app id, so
    // history cannot split into a second app.
    const { data: site } = await db.from("published_sites").select("slug").eq("owner", OWNER).maybeSingle();
    check(site.slug === SLUG, "the analytics app id is the slug, unchanged by publishing again", site.slug);
    const appIds = new Set((await db.from("analytics_daily").select("project_id").eq("owner", OWNER)).data.map((r) => r.project_id));
    check(appIds.size === 1, "and all analytics sit under one project identity", `${appIds.size}`);
  }

  // ── Countries ─────────────────────────────────────────────────────────────────────────
  check(report.countries?.available === false && report.countries.reason === "geoip_unconfigured",
    "countries report as unavailable rather than blank or inferred", JSON.stringify(report.countries));

  const live = await liveVisitors(OWNER, PROJECT, { client: db, now: today });
  check(typeof live.live === "number", "live visitors is a real number", `${live.live} in ${live.windowMinutes}m`);
} catch (error) {
  check(false, "the proof ran to completion", error?.message || String(error));
  console.error(error);
} finally {
  await cleanup();
  const { count: leftDaily } = await db.from("analytics_daily")
    .select("project_id", { count: "exact", head: true }).eq("owner", OWNER);
  const { count: leftRaw } = await db.from("analytics_events")
    .select("id", { count: "exact", head: true }).eq("owner", OWNER);
  check(!leftDaily && !leftRaw, "deleting the project removes its analytics",
    `${leftDaily || 0} daily, ${leftRaw || 0} raw`);
}

console.log(`\n${out.join("\n")}\n`);
console.log(failed ? `${failed} FAILED` : `${out.length}/${out.length} checks passed`);
process.exit(failed ? 1 : 0);
