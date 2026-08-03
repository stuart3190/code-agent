// Thrallo Analytics: privacy properties first, then correctness.
//
// The privacy assertions are the load-bearing ones. The reason this needs no cookie banner is that
// a visitor hash cannot be recomputed once its daily salt is destroyed — if that stops being true,
// the feature becomes unlawful rather than merely inaccurate, and nothing in the UI would show it.

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  hashVisitor, hashSession, saltFor, sweepSalts, dayKey, __resetSaltCacheForTests,
} from "../../shell/server/lib/analytics/visitorIdentity.mjs";
import { parseUserAgent, isBot, referrerHost, normalizePath } from "../../shell/server/lib/analytics/userAgent.mjs";
import { recordBeacon, __resetIngestCacheForTests } from "../../shell/server/lib/analytics/ingest.mjs";
import { rollupAnalytics } from "../../shell/server/lib/analytics/rollup.mjs";
import { retentionFor, resolveWindow, analyticsCapabilities } from "../../shell/server/lib/analytics/reports.mjs";
import { injectAnalytics, analyticsScript, ANALYTICS_SCRIPT_PATH } from "../../shell/server/lib/analytics/clientScript.mjs";
import { scrubErrorFields, scrubText, errorSignature } from "../../shell/server/lib/analytics/scrub.mjs";

const OWNER = "66666666-6666-4666-8666-666666666666";
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

function fakeDb({ site = { owner: OWNER, project_id: "p1", slug: "focusflow", unpublished_at: null }, salts = [], events = [] } = {}) {
  const db = {
    salts: [...salts], events: [...events], daily: [],
    from(table) {
      const filters = {};
      let pending = null;
      const api = {
        select() { return api; },
        eq(c, v) { filters[c] = v; return api; },
        gte(c, v) { filters[`gte_${c}`] = v; return api; },
        lt(c, v) { filters[`lt_${c}`] = v; return api; },
        order() { return api; },
        limit() { return api; },
        delete() { pending = "delete"; return api; },
        insert(row) {
          if (table === "analytics_salts") {
            if (db.salts.some((s) => s.day === row.day)) return Promise.resolve({ error: { message: "duplicate" } });
            db.salts.push(row);
          }
          if (table === "analytics_events") db.events.push(row);
          return Promise.resolve({ error: null });
        },
        upsert(rows) { db.daily = rows; return Promise.resolve({ error: null }); },
        maybeSingle: async () => {
          if (table === "published_sites") return { data: site && site.slug === filters.slug ? site : null, error: null };
          if (table === "analytics_salts") return { data: db.salts.find((s) => s.day === filters.day) || null, error: null };
          return { data: null, error: null };
        },
        then(resolve) {
          if (pending === "delete") {
            if (table === "analytics_salts") db.salts = db.salts.filter((s) => !(s.day < filters.lt_day));
            if (table === "analytics_events") db.events = db.events.filter((e) => !(e.occurred_at < filters.lt_occurred_at));
            return resolve({ error: null });
          }
          if (table === "analytics_events") {
            return resolve({ data: db.events.filter((e) => !filters.gte_occurred_at || e.occurred_at >= filters.gte_occurred_at), error: null });
          }
          return resolve({ data: [], error: null });
        },
      };
      return api;
    },
  };
  return db;
}

// ── Privacy ─────────────────────────────────────────────────────────────────────────────

test("the same person on two days is two different hashes", () => {
  // No cookie, no device storage, and no identifier that survives midnight. This is what stops the
  // hash being a pseudonymous identifier that would need consent.
  const monday = hashVisitor({ salt: "salt-monday", ip: "1.2.3.4", userAgent: CHROME, appId: "app" });
  const tuesday = hashVisitor({ salt: "salt-tuesday", ip: "1.2.3.4", userAgent: CHROME, appId: "app" });
  assert.notEqual(monday, tuesday);
});

test("the same person on two different sites is two different hashes", () => {
  // Cross-site tracking is impossible by construction, not by policy.
  const a = hashVisitor({ salt: "s", ip: "1.2.3.4", userAgent: CHROME, appId: "app-a" });
  const b = hashVisitor({ salt: "s", ip: "1.2.3.4", userAgent: CHROME, appId: "app-b" });
  assert.notEqual(a, b);
});

test("the same person on the same day and site counts once", () => {
  const first = hashVisitor({ salt: "s", ip: "1.2.3.4", userAgent: CHROME, appId: "app" });
  const second = hashVisitor({ salt: "s", ip: "1.2.3.4", userAgent: CHROME, appId: "app" });
  assert.equal(first, second, "otherwise unique visitors would be meaningless");
});

test("a hash reveals nothing about the IP it came from", () => {
  const hash = hashVisitor({ salt: "s", ip: "203.0.113.9", userAgent: CHROME, appId: "app" });
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.ok(!hash.includes("203"), "the address must not survive in any form");
});

test("salts are destroyed, so old hashes cannot be recomputed", async () => {
  const db = fakeDb({ salts: [
    { day: "2026-01-01", salt: "old" },
    { day: dayKey(), salt: "current" },
  ] });
  await sweepSalts(db, new Date());
  assert.deepEqual(db.salts.map((s) => s.day), [dayKey()],
    "an undeleted salt would let any past hash be recomputed from a raw IP");
});

test("two ingests racing on the first request of a day settle on ONE salt", async () => {
  // If they did not, the same person would be counted twice for that day.
  __resetSaltCacheForTests();
  const db = fakeDb();
  const [a, b] = await Promise.all([saltFor("2026-08-03", db), saltFor("2026-08-03", db)]);
  assert.equal(a, b);
  assert.equal(db.salts.length, 1);
});

test("a session is the same visitor inside a 30-minute window", () => {
  const t = Date.parse("2026-08-03T12:00:00Z");
  assert.equal(hashSession("v", t), hashSession("v", t + 10 * 60_000));
  assert.notEqual(hashSession("v", t), hashSession("v", t + 45 * 60_000));
});

// ── Ingest ──────────────────────────────────────────────────────────────────────────────

test("the project is resolved from the app id, never taken from the body", async () => {
  __resetIngestCacheForTests(); __resetSaltCacheForTests();
  const db = fakeDb();
  await recordBeacon({
    // A forged body claiming someone else's project and owner.
    body: { kind: "pageview", appId: "focusflow", path: "/", owner: "attacker", project_id: "victim" },
    ip: "1.2.3.4", userAgent: CHROME, client: db,
  });
  assert.equal(db.events.length, 1);
  assert.equal(db.events[0].owner, OWNER, "the owner comes from published_sites, not the request");
  assert.equal(db.events[0].project_id, "p1");
});

test("an unknown or unpublished site is accepted and discarded", async () => {
  __resetIngestCacheForTests();
  // A page still beaconing after unpublish is normal, not an error worth surfacing.
  const gone = fakeDb({ site: { owner: OWNER, project_id: "p1", slug: "focusflow", unpublished_at: "2026-08-01T00:00:00Z" } });
  assert.deepEqual(await recordBeacon({ body: { kind: "pageview", appId: "focusflow" }, client: gone }), { accepted: false, reason: "unknown_site" });
  assert.equal(gone.events.length, 0);

  __resetIngestCacheForTests();
  const missing = fakeDb({ site: null });
  assert.equal((await recordBeacon({ body: { kind: "pageview", appId: "nothing" }, client: missing })).accepted, false);
});

test("bots are dropped", async () => {
  __resetIngestCacheForTests();
  const db = fakeDb();
  for (const ua of ["Googlebot/2.1", "curl/8.4.0", "UptimeRobot/2.0", "HeadlessChrome/120"]) {
    const result = await recordBeacon({ body: { kind: "pageview", appId: "focusflow" }, userAgent: ua, client: db });
    assert.equal(result.reason, "bot", ua);
  }
  assert.equal(db.events.length, 0, "counting bots would make every number a lie");
});

test("no raw IP is ever written", async () => {
  __resetIngestCacheForTests(); __resetSaltCacheForTests();
  const db = fakeDb();
  await recordBeacon({ body: { kind: "pageview", appId: "focusflow" }, ip: "203.0.113.9", userAgent: CHROME, client: db });
  assert.ok(!JSON.stringify(db.events[0]).includes("203.0.113.9"));
});

test("query strings are stripped from paths", () => {
  // They routinely carry emails, tokens and order references.
  assert.equal(normalizePath("/checkout?email=someone@example.com&token=abc"), "/checkout");
  assert.equal(normalizePath("/a/b/"), "/a/b");
  assert.equal(normalizePath(""), "/");
});

test("only the referrer host is kept", () => {
  assert.equal(referrerHost("https://www.google.com/search?q=private+search+terms"), "google.com");
  assert.equal(referrerHost(""), "Direct");
  assert.equal(referrerHost("https://mysite.com/a", "mysite.com"), null, "internal navigation is not a referrer");
});

test("a vitals beacon with no measurements is refused", async () => {
  __resetIngestCacheForTests();
  const db = fakeDb();
  const result = await recordBeacon({ body: { kind: "vitals", appId: "focusflow" }, userAgent: CHROME, client: db });
  assert.equal(result.reason, "empty_vitals");
});

test("oversized error payloads are clamped rather than rejected", async () => {
  __resetIngestCacheForTests(); __resetSaltCacheForTests();
  const db = fakeDb();
  await recordBeacon({
    body: { kind: "error", appId: "focusflow", message: "x".repeat(5_000), stack: "y".repeat(50_000) },
    userAgent: CHROME, client: db,
  });
  assert.ok(db.events[0].error_message.length <= 500);
  assert.ok(db.events[0].error_stack.length <= 4_000);
});

test("user agents are grouped correctly, with Chromium browsers not all called Chrome", () => {
  assert.equal(parseUserAgent(CHROME).browser, "Chrome");
  assert.equal(parseUserAgent("Mozilla/5.0 ... Chrome/120 Safari/537.36 Edg/120").browser, "Edge");
  assert.equal(parseUserAgent("Mozilla/5.0 ... Chrome/120 Safari/537.36 OPR/106").browser, "Opera");
  assert.equal(parseUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit Version/17.0 Mobile/15E148 Safari/604.1").browser, "Safari");
  assert.equal(parseUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) ... Mobile Safari").device, "mobile");
  assert.equal(parseUserAgent("Mozilla/5.0 (iPad; CPU OS 17_0) ... Safari").device, "tablet");
  assert.equal(parseUserAgent(CHROME).device, "desktop");
  assert.ok(isBot("Mozilla/5.0 (compatible; bingbot/2.0)"));
});

// ── Rollup ──────────────────────────────────────────────────────────────────────────────

test("rolling up twice does not double-count", async () => {
  const day = "2026-08-03T10:00:00.000Z";
  const events = [
    { owner: OWNER, project_id: "p1", kind: "pageview", occurred_at: day, visitor_hash: "v1", session_hash: "s1", path: "/", browser: "Chrome", os: "Windows", device: "desktop", referrer_host: "google.com" },
    { owner: OWNER, project_id: "p1", kind: "pageview", occurred_at: day, visitor_hash: "v1", session_hash: "s1", path: "/about", browser: "Chrome", os: "Windows", device: "desktop" },
    { owner: OWNER, project_id: "p1", kind: "pageview", occurred_at: day, visitor_hash: "v2", session_hash: "s2", path: "/", browser: "Safari", os: "macOS", device: "desktop" },
  ];
  const db = fakeDb({ events });
  const first = await rollupAnalytics({ client: db, now: new Date("2026-08-03T12:00:00Z") });
  const totals = () => db.daily.find((r) => r.dimension === "totals");
  assert.equal(totals().pageviews, 3);
  assert.equal(totals().visitors, 2, "two distinct visitors, three views");
  assert.equal(totals().sessions, 2);

  // Recomputes whole days rather than accumulating deltas, so a re-run after a crash is safe.
  await rollupAnalytics({ client: db, now: new Date("2026-08-03T12:00:00Z") });
  assert.equal(totals().pageviews, 3, "a second rollup must not double the numbers");
  assert.equal(first.rows, db.daily.length);
});

test("vitals are stored as sums plus a count so days can be merged accurately", async () => {
  const db = fakeDb({ events: [
    { owner: OWNER, project_id: "p1", kind: "vitals", occurred_at: "2026-08-03T10:00:00.000Z", visitor_hash: "v1", session_hash: "s1", lcp_ms: 1000, cls: 0.1 },
    { owner: OWNER, project_id: "p1", kind: "vitals", occurred_at: "2026-08-03T11:00:00.000Z", visitor_hash: "v2", session_hash: "s2", lcp_ms: 3000, cls: 0.3 },
  ] });
  await rollupAnalytics({ client: db, now: new Date("2026-08-03T12:00:00Z") });
  const totals = db.daily.find((r) => r.dimension === "totals");
  assert.equal(totals.vitals_count, 2);
  assert.equal(totals.lcp_sum, 4000, "averaging averages would drift; sums do not");
});

// ── Plans ───────────────────────────────────────────────────────────────────────────────

test("retention is 7 days Free, 90 Starter, unlimited Pro", () => {
  assert.equal(retentionFor("free"), 7);
  assert.equal(retentionFor("starter"), 90);
  assert.equal(retentionFor("pro"), null);
  assert.equal(retentionFor("unknown"), 7, "an unrecognised plan gets the least, never the most");
});

test("asking for more history than the plan allows returns less, not an error", () => {
  const free = resolveWindow({ requestedDays: 365, plan: "free" });
  assert.equal(free.days, 7);
  assert.equal(free.clamped, true, "the UI must be able to say why");
  assert.equal(resolveWindow({ requestedDays: 365, plan: "pro" }).days, 365);
  assert.equal(resolveWindow({ requestedDays: 30, plan: "starter" }).days, 30, "asking for less than the cap is honoured");
});

test("capabilities gate breakdowns and export, but never the headline numbers", () => {
  const free = analyticsCapabilities("free");
  assert.equal(free.fullAnalytics, false);
  assert.equal(free.export, false);
  // Analytics itself is on every plan: Free still gets visitors, views and the trend.
  assert.equal(free.retentionDays, 7);
  assert.equal(analyticsCapabilities("starter").errorReporting, true);
  assert.equal(analyticsCapabilities("pro").export, true);
});

// ── The injected script ─────────────────────────────────────────────────────────────────

test("the beacon uses a CORS-safelisted content type", () => {
  const script = analyticsScript({ endpoint: "https://app.thrallo.com/api/analytics/collect", appId: "focusflow" });
  // With application/json every cross-origin beacon would trigger a preflight the browser blocks,
  // and analytics would silently record nothing.
  assert.match(script, /text\/plain/);
  assert.doesNotMatch(script, /"Content-Type":"application\/json"/);
});

test("the script stores nothing on the visitor's device", () => {
  const script = analyticsScript({ endpoint: "/collect", appId: "a" });
  for (const forbidden of ["localStorage", "sessionStorage", "document.cookie", "indexedDB"]) {
    assert.ok(!script.includes(forbidden), `${forbidden} would make this require a consent banner`);
  }
});

test("the script cannot break the page it runs on", () => {
  const script = analyticsScript({ endpoint: "/collect", appId: "a" });
  // Every entry point is wrapped, and errors are observed rather than intercepted.
  assert.ok((script.match(/try\{/g) || []).length >= 6);
  assert.doesNotMatch(script, /preventDefault|stopPropagation/,
    "the site's own error handling must still run");
});

test("injection is idempotent and lands in the head", () => {
  const html = "<html><head><title>x</title></head><body>hi</body></html>";
  const once = injectAnalytics(html);
  assert.ok(once.includes(ANALYTICS_SCRIPT_PATH));
  assert.ok(once.indexOf(ANALYTICS_SCRIPT_PATH) < once.indexOf("</head>"));
  // Republishing must not accumulate copies.
  assert.equal(injectAnalytics(once), once);
  // No head: falls back to the body rather than silently doing nothing.
  assert.ok(injectAnalytics("<html><body>hi</body></html>").includes(ANALYTICS_SCRIPT_PATH));
});

test("the tag is deferred and carries no inline code", () => {
  const html = injectAnalytics("<html><head></head><body></body></html>");
  assert.match(html, /<script defer src="[^"]+"><\/script>/,
    "inline code would force published sites to loosen their Content-Security-Policy");
});

test("publishing injects analytics; exporting a project does not", async () => {
  const publish = await readFile(fileURLToPath(new URL("../../shell/server/lib/appBuild/appPublishService.mjs", import.meta.url)), "utf8");
  assert.match(publish, /withAnalytics\(built, slug\)/);

  // Analytics belongs to Thrallo hosting, not to the user's source. A downloaded project must not
  // carry a beacon pointing at our servers.
  const exportLib = await readFile(fileURLToPath(new URL("../../shell/server/lib/exportProject.mjs", import.meta.url)), "utf8");
  assert.doesNotMatch(exportLib, /analytics\/clientScript/);
});

// ── Secrets never reach storage ─────────────────────────────────────────────────────────
//
// A pageview path has its query string stripped at ingest because query strings carry tokens
// belonging to the SITE's own users. Error messages, sources and stack traces had no such
// treatment, and a failed fetch prints the whole URL it tried.

test("error text is scrubbed of tokens, keys, emails and addresses before storage", () => {
  const clean = scrubErrorFields({
    message: "Request failed: https://api.example.com/v1/orders?token=abc123secret&email=jo@example.com",
    source: "https://app.example.com/checkout?session=sk_live_ABCDEFGHIJKLMNOP",
    stack: "Error: bad\n  at fetch (https://x.example.com/a.js?key=xyz)\n  Authorization: Bearer eyJhbGciOi.eyJzdWIiOiI.SflKxwRJSM\n  from 203.0.113.9",
  });

  const all = `${clean.message}\n${clean.source}\n${clean.stack}`;
  assert.doesNotMatch(all, /token=abc123secret/, "query strings carry tokens");
  assert.doesNotMatch(all, /jo@example\.com/, "and the site's own users' emails");
  assert.doesNotMatch(all, /sk_live_ABCDEFGHIJKLMNOP/, "API keys must never be stored");
  assert.doesNotMatch(all, /eyJhbGciOi\.eyJzdWIiOiI/, "nor JWTs");
  assert.doesNotMatch(all, /203\.0\.113\.9/, "nor IP addresses");
  // Still useful afterwards.
  assert.match(clean.message, /api\.example\.com\/v1\/orders/, "what failed is still legible");
});

test("scrubbing happens at ingest, so the raw value never reaches the database", async () => {
  __resetIngestCacheForTests();
  const db = fakeDb();
  await recordBeacon({
    body: { kind: "error", appId: "focusflow", path: "/checkout", message: "Failed: password=hunter2 for jo@example.com" },
    ip: "203.0.113.5", userAgent: CHROME, client: db, now: new Date("2026-08-03T10:00:00Z"),
  });
  const stored = db.events.find((e) => e.kind === "error");
  assert.ok(stored, "the error was recorded");
  assert.doesNotMatch(stored.error_message, /hunter2/,
    "cleaning at render time would leave the secret in the database and in every backup");
  assert.doesNotMatch(stored.error_message, /jo@example\.com/);
});

test("errors with the same fault at different line numbers group together", () => {
  const a = errorSignature("Cannot read properties of undefined (reading 'id') at line 42");
  const b = errorSignature("Cannot read properties of undefined (reading 'id') at line 91");
  assert.equal(a, b, "otherwise one bug fills the whole list");
  assert.doesNotMatch(a, /\d\d/, "and the signature carries no identifying values");
});

// ── Error detail survives the raw prune ─────────────────────────────────────────────────

test("error detail is rolled into aggregates, so it outlives the three-day raw window", async () => {
  const day = "2026-08-03";
  const events = [
    { owner: OWNER, project_id: "p1", kind: "error", occurred_at: `${day}T10:00:00Z`, visitor_hash: "v1", session_hash: "s1", error_message: "Cannot read properties of undefined", error_source: "/app.js" },
    { owner: OWNER, project_id: "p1", kind: "error", occurred_at: `${day}T11:00:00Z`, visitor_hash: "v2", session_hash: "s2", error_message: "Cannot read properties of undefined", error_source: "/app.js" },
    { owner: OWNER, project_id: "p1", kind: "error", occurred_at: `${day}T12:00:00Z`, visitor_hash: "v1", session_hash: "s1", error_message: "Network request failed" },
  ];
  const db = fakeDb({ events });
  await rollupAnalytics({ client: db, now: new Date(`${day}T23:00:00Z`) });

  const detail = db.daily.filter((r) => r.dimension === "error");
  assert.equal(detail.length, 2, "one row per distinct fault");
  const top = detail.find((r) => /Cannot read properties/.test(r.key));
  assert.equal(top.errors, 2, "occurrences are counted");
  assert.equal(top.visitors, 2, "and how many visitors hit it");

  const totals = db.daily.find((r) => r.dimension === "totals");
  assert.equal(totals.errors, 3, "the headline count still agrees with the detail");
});

test("same-day returning counts visitors with more than one session that day", async () => {
  const day = "2026-08-03";
  const events = [
    // v1 comes back in a second session; v2 does not.
    { owner: OWNER, project_id: "p1", kind: "pageview", occurred_at: `${day}T09:00:00Z`, visitor_hash: "v1", session_hash: "s1", path: "/" },
    { owner: OWNER, project_id: "p1", kind: "pageview", occurred_at: `${day}T18:00:00Z`, visitor_hash: "v1", session_hash: "s2", path: "/" },
    { owner: OWNER, project_id: "p1", kind: "pageview", occurred_at: `${day}T10:00:00Z`, visitor_hash: "v2", session_hash: "s3", path: "/" },
  ];
  const db = fakeDb({ events });
  await rollupAnalytics({ client: db, now: new Date(`${day}T23:00:00Z`) });

  const returning = db.daily.find((r) => r.dimension === "returning");
  assert.equal(returning.visitors, 1, "one visitor returned within the day");
  // The stored row must carry no identity at all — this is an aggregate that outlives the salts.
  assert.doesNotMatch(JSON.stringify(returning), /v1|v2|s1|s2|s3/,
    "a returning row that stored hashes would defeat the whole privacy model");
});

// ── Entitlement ─────────────────────────────────────────────────────────────────────────

test("the errorReporting entitlement is actually consulted", async () => {
  const source = await readFile(fileURLToPath(new URL("../../shell/server/lib/analytics/reports.mjs", import.meta.url)), "utf8");
  assert.match(source, /capabilities\.errorReporting/,
    "the flag existed and nothing read it, so Free saw a number its plan says it does not get");
  // Null, not zero: "you do not have this" and "there were none" are different answers.
  assert.match(source, /totals\.errors = null/);
});

test("Free gets no error data; Starter and Pro do", () => {
  assert.equal(analyticsCapabilities("free").errorReporting, false);
  assert.equal(analyticsCapabilities("starter").errorReporting, true);
  assert.equal(analyticsCapabilities("pro").errorReporting, true);
  assert.equal(analyticsCapabilities("pro").export, true);
  assert.equal(analyticsCapabilities("starter").export, false, "export is what Pro adds");
});

test("retention is enforced server-side, whatever the client asks for", () => {
  assert.equal(resolveWindow({ requestedDays: 365, plan: "free" }).days, 7);
  assert.equal(resolveWindow({ requestedDays: 365, plan: "free" }).clamped, true);
  assert.equal(resolveWindow({ requestedDays: 365, plan: "starter" }).days, 90);
  assert.equal(resolveWindow({ requestedDays: 365, plan: "pro" }).days, 365, "Pro keeps everything");
  assert.equal(resolveWindow({ requestedDays: 7, plan: "pro" }).clamped, false);
});
