// Health monitoring.
//
// Two things here are easy to get wrong in ways nobody notices until it matters: what counts as
// down (calling a slow site "down" makes uptime meaningless), and when to alert (alerting on state
// rather than transition means a site down overnight sends hundreds of notifications and the next
// real alert gets ignored).

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { probeSite, checkDns, HEALTH, SLOW_MS, SSL_WARN_DAYS } from "../../shell/server/lib/health/probe.mjs";
import { decideAlerts } from "../../shell/server/lib/health/monitor.mjs";
import { healthDetail } from "../../shell/server/lib/health/report.mjs";

const URL_ = "https://focusflow.app.thrallo.com";
const NOW = new Date("2026-08-03T12:00:00Z");
const IP = "51.195.136.189";

const goodCert = (days = 60) => async () => ({
  ok: true, validTo: new Date(NOW.getTime() + days * 86_400_000).toISOString(), daysLeft: days,
});
const okDns = async () => ({ ok: true, checked: true });
const respond = (status, delay = 0) => async () => {
  if (delay) await new Promise((r) => setTimeout(r, delay));
  return { status };
};

// ── Classification ──────────────────────────────────────────────────────────────────────

test("a fast 200 with a healthy certificate is healthy", async () => {
  const result = await probeSite(URL_, { fetchImpl: respond(200), certificate: goodCert(), dnsCheck: okDns, now: NOW });
  assert.equal(result.status, HEALTH.healthy);
  assert.equal(result.detail, null);
  assert.equal(result.httpStatus, 200);
});

test("no response at all is offline", async () => {
  const result = await probeSite(URL_, {
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
    certificate: goodCert(), dnsCheck: okDns, now: NOW,
  });
  assert.equal(result.status, HEALTH.offline);
  assert.equal(result.responseMs, null, "there is no response time when there was no response");
});

test("a 5xx is offline; a 4xx is a warning", async () => {
  // A server error means the app is broken. A 404 on the root means something is wrong but the
  // server is answering — different problem, different urgency.
  const down = await probeSite(URL_, { fetchImpl: respond(503), certificate: goodCert(), dnsCheck: okDns, now: NOW });
  assert.equal(down.status, HEALTH.offline);
  const missing = await probeSite(URL_, { fetchImpl: respond(404), certificate: goodCert(), dnsCheck: okDns, now: NOW });
  assert.equal(missing.status, HEALTH.warning);
});

test("a slow site is a warning, NOT downtime", async () => {
  // Calling this downtime would make the uptime percentage meaningless: the site served the page.
  const result = await probeSite(URL_, {
    fetchImpl: respond(200, SLOW_MS + 200), certificate: goodCert(), dnsCheck: okDns, now: NOW,
  });
  assert.equal(result.status, HEALTH.warning);
  assert.match(result.detail, /slowly/);
});

test("a certificate close to expiry warns while the site still works", async () => {
  const result = await probeSite(URL_, {
    fetchImpl: respond(200), certificate: goodCert(SSL_WARN_DAYS - 1), dnsCheck: okDns, now: NOW,
  });
  assert.equal(result.status, HEALTH.warning);
  assert.match(result.detail, /expires in 13 days/);
  assert.equal(result.httpStatus, 200, "it is serving fine — that is the point of warning early");
});

test("an expired or untrusted certificate is reported with its reason", async () => {
  const expired = await probeSite(URL_, {
    fetchImpl: respond(200), dnsCheck: okDns, now: NOW,
    certificate: async () => ({ ok: false, reason: "CERT_HAS_EXPIRED", daysLeft: -3, validTo: null }),
  });
  assert.equal(expired.status, HEALTH.warning);
  assert.match(expired.detail, /CERT_HAS_EXPIRED/, "the reason distinguishes expiry from a hostname mismatch");
});

test("a domain that no longer points here warns even while it still answers", async () => {
  // Cached DNS keeps it working for a while and then it simply stops, with nothing explaining why.
  const result = await probeSite(URL_, {
    fetchImpl: respond(200), certificate: goodCert(), now: NOW,
    dnsCheck: async () => ({ ok: false, checked: true }),
  });
  assert.equal(result.status, HEALTH.warning);
  assert.match(result.detail, /no longer points to Thrallo/);
});

test("offline outranks every other problem", async () => {
  // If visitors cannot reach it, the certificate is not the headline.
  const result = await probeSite(URL_, {
    fetchImpl: async () => { throw new Error("down"); },
    certificate: async () => ({ ok: false, reason: "CERT_HAS_EXPIRED", daysLeft: -1 }),
    dnsCheck: async () => ({ ok: false, checked: true }), now: NOW,
  });
  assert.equal(result.status, HEALTH.offline);
  assert.match(result.detail, /did not respond/);
});

test("an unparseable address is refused rather than throwing", async () => {
  const result = await probeSite("not a url", { now: NOW });
  assert.equal(result.status, HEALTH.offline);
});

test("a Thrallo subdomain skips the DNS check", async () => {
  // We control that zone; checking it would be checking ourselves, and a resolver hiccup would
  // wrongly flag every site at once.
  const result = await checkDns("focusflow.app.thrallo.com", IP, {
    resolver: { resolve4: async () => { throw new Error("should not be called"); } },
  });
  assert.deepEqual(result, { ok: true, checked: false });
});

test("a custom domain passes DNS via A record or CNAME", async () => {
  const viaA = await checkDns("shop.example.com", IP, { resolver: { resolve4: async () => [IP] } });
  assert.equal(viaA.ok, true);

  const viaCname = await checkDns("shop.example.com", IP, {
    resolver: {
      resolve4: async () => { throw new Error("no A"); },
      resolveCname: async () => ["focusflow.app.thrallo.com"],
    },
  });
  assert.equal(viaCname.ok, true);

  const pointingElsewhere = await checkDns("shop.example.com", IP, {
    resolver: {
      resolve4: async () => ["203.0.113.1"],
      resolveCname: async () => { throw new Error("no CNAME"); },
    },
  });
  assert.equal(pointingElsewhere.ok, false);
});

// ── Alerting ────────────────────────────────────────────────────────────────────────────

const offline = { status: HEALTH.offline, detail: "The site did not respond.", dnsOk: true, sslDaysLeft: 60 };
const healthy = { status: HEALTH.healthy, detail: null, dnsOk: true, sslDaysLeft: 60 };

test("one failed check does not alert; two do", async () => {
  // A single blip is usually the internet. Crying wolf is how alerts get ignored.
  const first = decideAlerts({ previous: null, result: offline, now: NOW });
  assert.deepEqual(first.alerts, []);
  assert.equal(first.failures, 1);

  const second = decideAlerts({ previous: { consecutive_failures: 1, alerted: {} }, result: offline, now: NOW });
  assert.deepEqual(second.alerts.map((a) => a.kind), ["offline"]);
});

test("a site that stays down does not alert again", async () => {
  const previous = { consecutive_failures: 5, alerted: { offline: NOW.toISOString() } };
  const again = decideAlerts({ previous, result: offline, now: NOW });
  assert.deepEqual(again.alerts, [], "otherwise an overnight outage sends hundreds of notifications");
});

test("recovery is announced, and a later outage alerts again", async () => {
  const recovered = decideAlerts({
    previous: { consecutive_failures: 3, alerted: { offline: NOW.toISOString() } }, result: healthy, now: NOW,
  });
  assert.deepEqual(recovered.alerts.map((a) => a.kind), ["recovered"]);
  assert.equal(recovered.alerted.offline, undefined, "the flag must clear or the next outage stays silent");
  assert.equal(recovered.failures, 0);

  const laterOutage = decideAlerts({ previous: { consecutive_failures: 1, alerted: recovered.alerted }, result: offline, now: NOW });
  assert.deepEqual(laterOutage.alerts.map((a) => a.kind), ["offline"]);
});

test("certificate expiry alerts once, and clears when renewed", async () => {
  const expiring = { ...healthy, status: HEALTH.warning, sslDaysLeft: 5, detail: "expires in 5 days" };
  const first = decideAlerts({ previous: { alerted: {} }, result: expiring, now: NOW });
  assert.deepEqual(first.alerts.map((a) => a.kind), ["ssl"]);

  const stillExpiring = decideAlerts({ previous: { alerted: first.alerted }, result: expiring, now: NOW });
  assert.deepEqual(stillExpiring.alerts, []);

  const renewed = decideAlerts({ previous: { alerted: first.alerted }, result: healthy, now: NOW });
  assert.deepEqual(renewed.alerts, []);
  assert.equal(renewed.alerted.ssl, undefined, "a future expiry must be able to alert again");
});

test("a certificate problem still alerts while the site is already down", async () => {
  // Tracked per kind, so one ongoing problem cannot mask a new one.
  const both = { status: HEALTH.offline, detail: "down", dnsOk: false, sslDaysLeft: 2 };
  const result = decideAlerts({
    previous: { consecutive_failures: 1, dns_ok: false, alerted: { offline: NOW.toISOString() } },
    result: both, now: NOW,
  });
  assert.deepEqual(result.alerts.map((a) => a.kind).sort(), ["dns", "ssl"]);
});

test("a single DNS failure is not enough to claim a domain is misconfigured", () => {
  // Found by running the real thing against production: a resolver hiccup fired "Custom domain is
  // misconfigured" on the FIRST probe, while an outage — a less alarming claim — needed two. The
  // previous row already records the last DNS result, so this needs no extra counter.
  const broken = { status: HEALTH.healthy, detail: null, dnsOk: false, sslDaysLeft: 60 };

  const once = decideAlerts({ previous: { dns_ok: true, alerted: {} }, result: broken, now: NOW });
  assert.deepEqual(once.alerts, [], "one failed lookup says nothing");

  const twice = decideAlerts({ previous: { dns_ok: false, alerted: {} }, result: broken, now: NOW });
  assert.deepEqual(twice.alerts.map((a) => a.kind), ["dns"], "two in a row is real");

  const never = decideAlerts({ previous: null, result: broken, now: NOW });
  assert.deepEqual(never.alerts, [], "and a site with no history cannot have failed twice");
});

// ── Reporting ───────────────────────────────────────────────────────────────────────────

function fakeDb({ status = null, checks = [] } = {}) {
  return {
    from(table) {
      const api = {
        select() { return api; }, eq() { return api; }, gte() { return api; }, order() { return api; },
        maybeSingle: async () => ({ data: table === "health_status" ? status : null, error: null }),
        then(resolve) { return resolve({ data: table === "health_checks" ? checks : [], error: null }); },
      };
      return api;
    },
  };
}

test("uptime counts warnings as up, because the site was serving", async () => {
  const checks = [
    { checked_at: "2026-08-03T11:00:00Z", status: "healthy", response_ms: 100 },
    { checked_at: "2026-08-03T11:05:00Z", status: "warning", response_ms: 3000 },
    { checked_at: "2026-08-03T11:10:00Z", status: "offline", response_ms: null },
    { checked_at: "2026-08-03T11:15:00Z", status: "healthy", response_ms: 120 },
  ];
  const report = await healthDetail("owner", "p1", { client: fakeDb({ checks }), now: NOW });
  assert.equal(report.uptime, 75, "3 of 4 checks were serving");
  assert.equal(report.responseTime.slowestMs, 3000);
});

test("an unchecked site reports no uptime rather than a perfect score", async () => {
  const report = await healthDetail("owner", "p1", { client: fakeDb(), now: NOW });
  assert.equal(report.uptime, null, "claiming 100% for a site never checked is the worst default");
  assert.equal(report.status, null);
});

test("consecutive failures collapse into one incident", async () => {
  const checks = [
    { checked_at: "2026-08-03T11:20:00Z", status: "healthy" },
    { checked_at: "2026-08-03T11:15:00Z", status: "offline", detail: "no response" },
    { checked_at: "2026-08-03T11:10:00Z", status: "offline", detail: "no response" },
    { checked_at: "2026-08-03T11:05:00Z", status: "healthy" },
  ];
  const report = await healthDetail("owner", "p1", { client: fakeDb({ checks }), now: NOW });
  assert.equal(report.incidents.length, 1, "one outage, not one entry per failed check");
  assert.equal(report.incidents[0].startedAt, "2026-08-03T11:10:00Z");
  assert.ok(report.incidents[0].endedAt, "and it is marked resolved once it recovered");
});

// ── PR 4: reliability, not just a populated UI ──────────────────────────────────────────

import { worstOf, dampen, liveSites, sweepHealth } from "../../shell/server/lib/health/monitor.mjs";

const observation = (status, over = {}) => ({ status, url: "https://x", httpStatus: 200, responseMs: 100, dnsOk: true, sslDaysLeft: 60, detail: null, ...over });

test("a project's health is the WORST of all its addresses", () => {
  // A custom domain can break while the Thrallo URL is fine. The owner gave people the custom one.
  const worst = worstOf([
    observation(HEALTH.healthy, { url: "https://app.thrallo.com" }),
    observation(HEALTH.offline, { url: "https://shop.example.com" }),
  ]);
  assert.equal(worst.status, HEALTH.offline);
  assert.equal(worst.url, "https://shop.example.com", "and it names the address that is broken");

  assert.equal(worstOf([observation(HEALTH.healthy), observation(HEALTH.warning)]).status, HEALTH.warning);
  assert.equal(worstOf([observation(HEALTH.healthy)]).status, HEALTH.healthy);
});

test("one failed probe is DEGRADED, not an outage; the second is offline", () => {
  // A single dropped packet must never tell a customer their site is down.
  assert.equal(dampen(HEALTH.offline, 1), HEALTH.warning, "first failure");
  assert.equal(dampen(HEALTH.offline, 2), HEALTH.offline, "second consecutive failure");
  assert.equal(dampen(HEALTH.offline, 5), HEALTH.offline);
  // Damping only applies to outages — a genuine warning is reported as itself immediately.
  assert.equal(dampen(HEALTH.warning, 1), HEALTH.warning);
  assert.equal(dampen(HEALTH.healthy, 0), HEALTH.healthy);
});

test("every address is monitored, not just the primary one", async () => {
  const client = {
    from(table) {
      const api = {
        select() { return api; }, is() { return api; }, eq() { return api; },
        then(resolve) {
          const data = table === "published_sites"
            ? [{ owner: "o", project_id: "p1", url: "https://thrallo-url/", slug: "s" }]
            : [{ domain: "shop.example.com", project_id: "p1", created_at: "2026-08-01T00:00:00Z" },
              { domain: "www.example.com", project_id: "p1", created_at: "2026-08-02T00:00:00Z" }];
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return api;
    },
  };
  const [site] = await liveSites(client);
  assert.deepEqual(site.targets.map((t) => t.url), [
    "https://thrallo-url/", "https://shop.example.com", "https://www.example.com",
  ]);
  assert.equal(site.customDomain, "shop.example.com", "the oldest stays primary for display");
});

test("a read failure is raised, never reported as 'no sites'", async () => {
  // Swallowing this made a database outage look identical to an account with nothing published.
  const broken = { from: () => ({ select: () => ({ is: () => ({ then: (r) => Promise.resolve({ data: null, error: { message: "connection reset" } }).then(r) }) }) }) };
  await assert.rejects(() => liveSites(broken), /could not list published sites/);
});

test("the sweep reports failures rather than counting them as success", async () => {
  const client = {
    from(table) {
      const api = {
        select() { return api; }, is() { return api; }, eq() { return api; },
        delete() { return api; }, lt() { return api; },
        then(resolve) {
          const data = table === "published_sites"
            ? [{ owner: "o", project_id: "p1", url: "https://x/", slug: "s" }] : [];
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return api;
    },
  };
  const result = await sweepHealth({
    client,
    probe: async () => { throw new Error("probe exploded"); },
    notify: async () => {},
    now: NOW,
  });
  assert.equal(result.sites, 1);
  assert.equal(result.checked, 0);
  assert.equal(result.failures.length, 1, "a sweep that checked nothing must say so");
  assert.match(result.failures[0].error, /probe exploded/);
});

test("the expected IP comes from THRALLO_PUBLIC_IP, not a hardcoded copy", async () => {
  const probeSource = await readFile(fileURLToPath(new URL("../../shell/server/lib/health/probe.mjs", import.meta.url)), "utf8");
  const domainSource = await readFile(fileURLToPath(new URL("../../shell/server/lib/customDomains.mjs", import.meta.url)), "utf8");
  // Both sides must read the same variable, or health reports MISCONFIGURED while verification
  // reports Active the moment it is set.
  assert.match(probeSource, /optionalEnv\("THRALLO_PUBLIC_IP"/);
  assert.match(domainSource, /optionalEnv\("THRALLO_PUBLIC_IP"/);
  const hardcoded = probeSource.split("\n")
    .filter((line) => /51\.195\.136\.189/.test(line) && !/optionalEnv/.test(line));
  assert.deepEqual(hardcoded, [], "the only mention may be the env default");
});

test("health and report failures are surfaced, not discarded", async () => {
  const monitor = await readFile(fileURLToPath(new URL("../../shell/server/lib/health/monitor.mjs", import.meta.url)), "utf8");
  const report = await readFile(fileURLToPath(new URL("../../shell/server/lib/health/report.mjs", import.meta.url)), "utf8");
  // Every write and read used to destructure only `data`. A silent failure here means the whole
  // feature stops with nothing to show for it.
  assert.match(monitor, /insertError/);
  assert.match(monitor, /upsertError/);
  assert.match(monitor, /readError/);
  assert.equal((report.match(/throw new Error\(`health/g) || []).length, 3);
});

test("an active domain that stops resolving loses Active", async () => {
  const source = await readFile(fileURLToPath(new URL("../../shell/server/lib/customDomains.mjs", import.meta.url)), "utf8");
  // It stayed Active forever regardless of DNS, so a zone edit silently broke a live address.
  assert.match(source, /ACTIVE_RECHECK_MS/);
  const unsettled = source.slice(source.indexOf("export async function unsettledDomains"));
  assert.match(unsettled, /DOMAIN_STATUS\.active/, "active domains must be re-checked");
  assert.match(source, /ssl_status: "pending"/, "and stop claiming a certificate is in place");
});
