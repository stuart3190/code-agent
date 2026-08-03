// One operational vocabulary, shared by every surface and by the server.
//
// Before this, health labels lived inside HealthView.jsx and were imported by OverviewTab — a
// component reaching into another component for its words — domain labels lived in
// publishLifecycle.js, and the project card compared `health.status !== "healthy"` as a bare
// string. Four surfaces, three sources, and no structural reason they would agree.

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  HEALTH_STATUS, HEALTH_LABEL, HEALTH_TONE, HEALTH_DOT, healthStateOf, healthExplanation,
  isHealthProblem, DOMAIN_STATUS, DOMAIN_LABEL, DOMAIN_TONE, domainExplanation, isDomainLive,
  SSL_LABEL, sslExplanation, operationalSummary,
} from "../../shell/shared/operationalState.mjs";

// ── Never a green tick nobody earned ────────────────────────────────────────────────────

test("a site with no health record is 'not checked yet', never Healthy", () => {
  // HealthView had `status?.status || "healthy"`, which would render a green hero for a site that
  // had never been probed the moment anything else on that page changed.
  assert.equal(healthStateOf(null), HEALTH_STATUS.unchecked);
  assert.equal(healthStateOf({}), HEALTH_STATUS.unchecked);
  assert.equal(healthStateOf({ status: "nonsense" }), HEALTH_STATUS.unchecked);
  assert.equal(HEALTH_LABEL[healthStateOf(null)], "Not checked yet");
  assert.equal(healthStateOf({ status: "healthy" }), HEALTH_STATUS.healthy);
});

test("every health state has a label, a tone, a dot and an explanation", () => {
  for (const state of Object.values(HEALTH_STATUS)) {
    assert.ok(HEALTH_LABEL[state], `${state} needs a label`);
    assert.ok(HEALTH_TONE[state], `${state} needs a tone`);
    assert.ok(HEALTH_DOT[state], `${state} needs a dot`);
    assert.ok(healthExplanation(state), `${state} needs an explanation`);
  }
  assert.equal(HEALTH_LABEL.warning, "Degraded", "it describes the site, not the database row");
  // The states someone is actually confused by have to say what is happening. "Healthy" does not
  // need a paragraph; "Degraded" does, because it is the one that reads as ambiguous.
  assert.match(healthExplanation(HEALTH_STATUS.warning), /serving/,
    "Degraded must say the site is still up — that is the whole distinction from Offline");
  assert.match(healthExplanation(HEALTH_STATUS.offline), /two checks in a row/,
    "and Offline must say why it is confident");
  assert.match(healthExplanation(HEALTH_STATUS.unchecked), /Monitoring begins/);
});

test("a problem is a problem on every surface", () => {
  assert.equal(isHealthProblem(HEALTH_STATUS.offline), true);
  assert.equal(isHealthProblem(HEALTH_STATUS.warning), true);
  assert.equal(isHealthProblem(HEALTH_STATUS.healthy), false);
  assert.equal(isHealthProblem(HEALTH_STATUS.unchecked), false,
    "unchecked is not a fault — nobody has looked yet");
});

// ── Domain states mean the same thing everywhere ────────────────────────────────────────

test("every domain state has a label and an explanation that says what to do", () => {
  for (const state of Object.values(DOMAIN_STATUS)) {
    assert.ok(DOMAIN_LABEL[state], `${state} needs a label`);
    assert.ok(DOMAIN_TONE[state], `${state} needs a tone`);
    assert.ok(domainExplanation(state), `${state} needs an explanation`);
  }
  // The two states a person is most likely to be stuck on must name the next action.
  assert.match(domainExplanation(DOMAIN_STATUS.pendingDns), /DNS records/);
  assert.match(domainExplanation(DOMAIN_STATUS.failed), /retry/i);
  assert.match(domainExplanation(DOMAIN_STATUS.failed), /same token/,
    "so the user knows DNS they already set up stays valid");
});

test("only an active domain is live", () => {
  assert.equal(isDomainLive(DOMAIN_STATUS.active), true);
  for (const state of ["pending_dns", "verifying", "failed", undefined]) {
    assert.equal(isDomainLive(state), false, `${state} must not be treated as an address`);
  }
});

test("SSL is described independently of verification, but relatedly", () => {
  // Conflating them made "Active" mean two things: verified, and secured.
  assert.match(sslExplanation("pending", DOMAIN_STATUS.pendingDns), /until ownership is verified/);
  assert.match(sslExplanation("pending", DOMAIN_STATUS.active), /first visit/);
  assert.match(sslExplanation("active", DOMAIN_STATUS.active), /installed and serving/);
  assert.equal(SSL_LABEL.active, "HTTPS active");
});

// ── One summary, one answer ─────────────────────────────────────────────────────────────

const health = (status) => ({ status });
const domain = (status, over = {}) => ({ domain: "shop.example.com", status, sslStatus: "pending", ...over });

test("the most urgent problem wins, in a fixed order", () => {
  // A card badge and a health tile must pick the SAME thing to shout about.
  const offline = operationalSummary({ health: health("offline"), domains: [domain("failed")] });
  assert.equal(offline.attention.kind, "offline", "the site being down beats everything");

  const deployFailed = operationalSummary({
    health: health("healthy"), deployment: { status: "failed", number: 4, failureReason: "build failed" },
    domains: [domain("failed")],
  });
  assert.equal(deployFailed.attention.kind, "deploy_failed");

  const domainFailed = operationalSummary({ health: health("healthy"), domains: [domain("failed")] });
  assert.equal(domainFailed.attention.kind, "domain_failed");

  const degraded = operationalSummary({ health: health("warning"), domains: [domain("pending_dns")] });
  assert.equal(degraded.attention.kind, "degraded");

  const pending = operationalSummary({ health: health("healthy"), domains: [domain("pending_dns")] });
  assert.equal(pending.attention.kind, "domain_pending");
  assert.match(pending.attention.label, /shop\.example\.com/);
});

test("nothing wrong means nothing shouted about", () => {
  const clean = operationalSummary({
    health: health("healthy"), domains: [domain("active", { sslStatus: "active" })],
    deployment: { status: "live", number: 3 },
  });
  assert.equal(clean.attention, null, "a badge that is always present says nothing");
  assert.equal(clean.activeDomain.domain, "shop.example.com");
  assert.equal(clean.pendingDomain, null);
});

test("an unchecked site is not reported as a problem", () => {
  const fresh = operationalSummary({ health: null, domains: [] });
  assert.equal(fresh.health.status, HEALTH_STATUS.unchecked);
  assert.equal(fresh.health.checked, false);
  assert.equal(fresh.attention, null, "a site published a minute ago is not broken");
});

test("a pending domain is surfaced rather than read as 'no domain'", () => {
  // The exact bug: a domain part-way through verification rendered as "Add a domain", offering to
  // start something already underway.
  const summary = operationalSummary({ health: health("healthy"), domains: [domain("verifying")] });
  assert.equal(summary.activeDomain, null, "it is not an address yet");
  assert.equal(summary.pendingDomain.domain, "shop.example.com", "but it exists and must be shown");
  assert.equal(summary.pendingDomain.label, "Verifying");
});

// ── No surface keeps its own copy ───────────────────────────────────────────────────────

test("no component defines its own health or domain vocabulary", async () => {
  const read = (p) => readFile(fileURLToPath(new URL(p, import.meta.url)), "utf8");

  const healthView = await read("../../shell/web/src/publish/HealthView.jsx");
  assert.doesNotMatch(healthView, /export const HEALTH_LABEL = \{/,
    "labels must come from the shared module, not be defined in a component");
  assert.doesNotMatch(healthView, /status\?\.status \|\| "healthy"/,
    "an unchecked site must never default to Healthy");

  const overview = await read("../../shell/web/src/publish/OverviewTab.jsx");
  assert.match(overview, /operationalState\.mjs/, "Overview reads the shared vocabulary");

  const card = await read("../../shell/web/src/publish/ProjectPublishRow.jsx");
  assert.doesNotMatch(card, /health\.status !== "healthy"/,
    "a bare string comparison is how a card and a page come to disagree");

  const lifecycle = await read("../../shell/web/src/publish/publishLifecycle.js");
  assert.doesNotMatch(lifecycle, /export const DOMAIN_STATUS_LABEL = Object\.freeze/,
    "domain labels are re-exported from the shared module, never redefined");
});

// ── Notifications fire on transitions, once ─────────────────────────────────────────────

test("domain transitions notify, and only on a real change", async () => {
  const source = await readFile(fileURLToPath(new URL("../../shell/server/lib/customDomains.mjs", import.meta.url)), "utf8");
  assert.match(source, /if \(row\.status !== updated\.status\)/,
    "the verifier re-checks every minute; notifying on STATE would send 1,440 messages a day");
  assert.match(source, /announceDomainTransition/);
  assert.match(source, /tag: `domain-\$\{row\.status\}-\$\{row\.domain\}`/,
    "tagged per domain and per transition so two sweeps cannot stack two notifications");
  // Reaching `verifying` is progress nobody needs waking for.
  const fn = source.slice(source.indexOf("async function announceDomainTransition"));
  assert.doesNotMatch(fn.slice(0, 1_500), /DOMAIN_STATUS\.verifying\]:/,
    "an intermediate step is not news");
});
