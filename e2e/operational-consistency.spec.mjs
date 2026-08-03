// Cross-surface operational consistency.
//
// The Health page, the Overview tile, the project card and the Domains panel all describe the same
// two facts: is the site up, and does the domain work. They used to get their words from three
// different places — health labels defined inside HealthView.jsx, domain labels in
// publishLifecycle.js, and the card comparing `health.status !== "healthy"` as a bare string.
//
// These assert on the WORDS a person sees, on every surface, from one stubbed state.

import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function supabaseRef() {
  try {
    const env = readFileSync(fileURLToPath(new URL("../shell/web/.env", import.meta.url)), "utf8");
    const url = env.match(/VITE_SUPABASE_URL\s*=\s*(\S+)/)?.[1] || "";
    return new URL(url).hostname.split(".")[0] || null;
  } catch { return null; }
}
const REF = supabaseRef();

const SESSION = {
  access_token: "e2e-fake-token", refresh_token: "e2e-fake-refresh", token_type: "bearer",
  expires_in: 86_400, expires_at: Math.floor(Date.now() / 1000) + 86_400,
  user: {
    id: "00000000-0000-4000-8000-000000000001", aud: "authenticated", role: "authenticated",
    email: "e2e@thrallo.com", user_metadata: { full_name: "Enid Tester" },
    app_metadata: { provider: "email" }, created_at: "2026-01-01T00:00:00Z",
  },
};

const PROJECT = "11111111-1111-4111-8111-111111111111";

const SITE = (domains = []) => ({
  projectId: PROJECT, currentProjectId: PROJECT, productId: "prod-1", name: "FocusFlow",
  slug: "focusflow", url: "https://focusflow.app.thrallo.com", environment: "production",
  publishedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
  firstPublishedAt: "2026-07-01T00:00:00.000Z", unpublishedAt: null,
  live: true, updateAvailable: false, status: "published",
  customDomain: domains.find((d) => d.status === "active")?.domain || null,
  domains,
});

const DOMAIN = (status, over = {}) => ({
  domain: "shop.example.com", projectId: PROJECT, status,
  sslStatus: status === "active" ? "active" : "pending",
  verifiedAt: null, lastCheckedAt: new Date(Date.now() - 90_000).toISOString(),
  failureReason: null,
  records: [
    { purpose: "verification", type: "TXT", name: "_thrallo-verify.shop.example.com", value: "thrallo-verify=abc", note: "Proves you own this domain." },
    { purpose: "routing", type: "CNAME", name: "shop.example.com", value: "focusflow.app.thrallo.com", note: "Points the domain at your Thrallo site." },
  ],
  ...over,
});

const HEALTH = (status) => ({
  status: status ? {
    status, since: new Date(Date.now() - 20 * 60_000).toISOString(),
    lastCheckedAt: new Date(Date.now() - 60_000).toISOString(),
    lastHealthyAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    url: "https://focusflow.app.thrallo.com/", httpStatus: 200, responseMs: 120,
    sslValidTo: "2026-10-30T00:00:00Z", sslDaysLeft: 88, dnsOk: true, detail: null,
  } : null,
  uptime: status ? 100 : null, checks: status ? 12 : 0, windowDays: 30,
  responseTime: status ? { medianMs: 120, p95Ms: 300, slowestMs: 400 } : null,
  daily: [], incidents: [], recent: [],
});

const DEPLOYMENTS = [{
  id: "22222222-2222-4222-8222-222222222222", number: 3, status: "live", environment: "production",
  triggeredByKind: "user", buildRunId: "33333333-3333-4333-8333-333333333333",
  buildDurationMs: 1800, deployDurationMs: 300,
  deployedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
  createdAt: new Date(Date.now() - 7 * 60_000).toISOString(),
  url: "https://focusflow.app.thrallo.com", failureReason: null, rolledBackFrom: null,
  sourceAvailable: true,
}];

async function stub(page, { domainStatus = null, healthStatus = "healthy" } = {}) {
  const domains = domainStatus ? [DOMAIN(domainStatus)] : [];
  const site = SITE(domains);
  const conversation = {
    id: "c1", title: "FocusFlow", state: "idle", productId: "prod-1",
    publishStatus: "published", site, health: HEALTH(healthStatus).status,
  };

  await page.addInitScript(([key, session]) => {
    window.localStorage.setItem(key, JSON.stringify(session));
  }, [`sb-${REF}-auth-token`, SESSION]);

  const listRoute = (r) => r.fulfill({ json: {
    conversations: [conversation], counts: { all: 1, published: 1, drafts: 0, updates: 0 },
    page: { offset: 0, limit: 20, total: 1, nextOffset: null, tab: "all", search: null },
  } });
  await page.route("**/api/v1/conversations", listRoute);
  await page.route("**/api/v1/conversations?**", listRoute);
  await page.route("**/api/v1/conversations/deleted", (r) => r.fulfill({ json: { items: [], recoveryDays: 7 } }));
  await page.route("**/api/v1/conversations/*/events**", (r) => r.fulfill({ contentType: "text/event-stream", body: "" }));
  await page.route("**/api/v1/publish-state", (r) => r.fulfill({ json: { sites: [site] } }));
  await page.route("**/api/v1/billing", (r) => r.fulfill({ json: {
    subscription: { plan: "pro", planName: "Pro", status: "active", pendingPlan: null },
    plans: [], budgets: {}, period: {}, stripeConfigured: true,
  } }));
  await page.route("**/api/v1/projects/*/health", (r) => r.fulfill({ json: HEALTH(healthStatus) }));
  await page.route("**/api/v1/projects/*/domains", (r) => r.fulfill({ json: { domains, allowance: { plan: "pro", limit: null, used: domains.length, unlimited: true } } }));
  await page.route("**/api/v1/projects/*/deployments", (r) => r.fulfill({ json: { deployments: DEPLOYMENTS } }));
  await page.route("**/api/v1/projects/*/analytics**", (r) => r.fulfill({ json: { capabilities: { plan: "pro", retentionDays: null, fullAnalytics: true, errorReporting: true, export: true }, window: { days: 30, from: "2026-07-05", clamped: false, comparable: true }, totals: { pageviews: 0, visitors: 0, sessions: 0, errors: 0 }, series: [], sameDayReturning: { visitors: 0, note: "n/a" }, topPages: [], referrers: [], browsers: [], operatingSystems: [], devices: [], vitals: null, errors: [], countries: { available: false } } }));
  await page.route("**/api/v1/projects/*/logs**", (r) => r.fulfill({ json: { entries: [], nextCursor: null, retentionDays: null, plan: "pro" } }));

  await page.route(`https://${REF}.supabase.co/**`, (r) => r.fulfill({ json: {} }));
  await page.route(`https://${REF}.supabase.co/auth/v1/user**`, (r) => r.fulfill({ json: SESSION.user }));
}

test.skip(!REF, "requires shell/web/.env auth config (skipped in CI)");

const dash = (page) => page.locator(".ct-projdash");
const openTab = async (page, name) => {
  await page.goto(`/projects/${PROJECT}/${name}`);
  await expect(dash(page)).toBeVisible();
};

// ── Pending DNS, everywhere ─────────────────────────────────────────────────────────────

test("a pending domain says Pending DNS on Overview, Health and Domains alike", async ({ page }) => {
  await stub(page, { domainStatus: "pending_dns" });

  await openTab(page, "overview");
  // The exact bug this replaces: a domain part-way through verification rendered as "Add a
  // domain", offering to start something already underway.
  await expect(dash(page)).toContainText("shop.example.com");
  await expect(dash(page)).toContainText("Pending DNS");
  await expect(dash(page)).not.toContainText("Add a domain");

  await dash(page).getByRole("tab", { name: "Health" }).click();
  await expect(dash(page)).toContainText("shop.example.com");
  await expect(dash(page)).toContainText("Pending DNS");

  await dash(page).getByRole("tab", { name: "Domains" }).click();
  await expect(dash(page)).toContainText("Pending DNS");
});

test("the project card names the pending domain too", async ({ page }) => {
  await stub(page, { domainStatus: "verifying" });
  await page.goto("/");
  const card = page.locator(".ct-project").filter({ hasText: "FocusFlow" });
  await expect(card).toContainText("shop.example.com");
  await expect(card).toContainText("verifying");
});

test("verification failure reads the same on Health and Domains, and says what to do", async ({ page }) => {
  await stub(page, { domainStatus: "failed" });

  await openTab(page, "health");
  await expect(dash(page)).toContainText("Verification failed");
  await expect(dash(page)).toContainText("retry");

  await dash(page).getByRole("tab", { name: "Domains" }).click();
  await expect(dash(page)).toContainText("Verification failed");
  await expect(dash(page)).toContainText("retry");
});

test("an active domain reads Active with HTTPS active on every surface", async ({ page }) => {
  await stub(page, { domainStatus: "active" });

  await openTab(page, "health");
  await expect(dash(page)).toContainText("Active");
  await expect(dash(page)).toContainText("HTTPS active");

  await dash(page).getByRole("tab", { name: "Domains" }).click();
  await expect(dash(page)).toContainText("HTTPS active");

  await dash(page).getByRole("tab", { name: "Overview" }).click();
  await expect(dash(page)).toContainText("shop.example.com");
  // An active domain is the address, so it is not qualified with a status.
  await expect(dash(page)).not.toContainText("Pending DNS");
});

// ── Health, everywhere ──────────────────────────────────────────────────────────────────

test("Degraded is called Degraded on Overview, Health and the card", async ({ page }) => {
  await stub(page, { healthStatus: "warning" });

  await page.goto("/");
  await expect(page.locator(".ct-project").filter({ hasText: "FocusFlow" })).toContainText("DEGRADED");

  await openTab(page, "overview");
  await expect(dash(page)).toContainText("Degraded");

  await dash(page).getByRole("tab", { name: "Health" }).click();
  await expect(dash(page)).toContainText("Degraded");
  // And says the site is still up, which is the entire distinction from Offline.
  await expect(dash(page)).toContainText("serving");
});

test("a site nobody has checked is never shown as Healthy", async ({ page }) => {
  await stub(page, { healthStatus: null });

  await openTab(page, "overview");
  await expect(dash(page)).toContainText("Not checked yet");
  await expect(dash(page)).not.toContainText("Healthy");

  await dash(page).getByRole("tab", { name: "Health" }).click();
  await expect(dash(page)).toContainText("has not been checked yet");
});

// ── Cross-links ─────────────────────────────────────────────────────────────────────────

test("Health links to the deployment that is serving, and to its exact build log", async ({ page }) => {
  await stub(page, { healthStatus: "healthy" });
  await openTab(page, "health");

  // Deployment health comes from the deployment record, so it cannot disagree with the tab.
  await expect(dash(page)).toContainText("Deployment #3");
  await expect(dash(page)).toContainText("LIVE");

  await dash(page).getByRole("button", { name: /Build log for #3/ }).click();
  // A stable identifier, not a tab switch: the URL names the exact run.
  await expect.poll(() => new URL(page.url()).searchParams.get("ref"))
    .toBe("33333333-3333-4333-8333-333333333333");
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/projects/${PROJECT}/logs`);
});

test("Health links to Domains when a domain needs attention", async ({ page }) => {
  await stub(page, { domainStatus: "pending_dns" });
  await openTab(page, "health");
  await dash(page).getByRole("button", { name: "Manage domains" }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/projects/${PROJECT}/domains`);
});

test("with no domain connected, Health offers to add one rather than staying silent", async ({ page }) => {
  await stub(page, { domainStatus: null });
  await openTab(page, "health");
  await expect(dash(page)).toContainText("None connected");
  await dash(page).getByRole("button", { name: "Add one" }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/projects/${PROJECT}/domains`);
});
