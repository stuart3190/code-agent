// The project dashboard as a commercial surface: how it loads, how it fails, how it is navigated.
//
// The tabs already claimed role="tablist" and role="tab", which promises a screen-reader user arrow
// key navigation and a labelled panel. Claiming the pattern without implementing it is worse than
// not claiming it — the promise is announced and then broken. These assert the promise is kept,
// and that every tab meets the same three states rather than six dialects of them.

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

const SITE = {
  projectId: PROJECT, currentProjectId: PROJECT, productId: "prod-1", name: "FocusFlow",
  slug: "focusflow", url: "https://focusflow.app.thrallo.com", environment: "production",
  publishedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
  firstPublishedAt: "2026-07-01T00:00:00.000Z", unpublishedAt: null,
  live: true, updateAvailable: false, status: "published", customDomain: null, domains: [],
  health: { status: "healthy", lastCheckedAt: new Date().toISOString() },
  deployment: null, lastAttempt: null,
};

const EMPTY_ANALYTICS = {
  capabilities: { plan: "pro", retentionDays: null, fullAnalytics: true, errorReporting: true, export: true },
  window: { days: 30, from: "2026-07-05", clamped: false, comparable: true },
  totals: { pageviews: 0, visitors: 0, sessions: 0, errors: 0 }, series: [],
  sameDayReturning: { visitors: 0, note: "n/a" }, topPages: [], referrers: [],
  browsers: [], operatingSystems: [], devices: [], vitals: null, errors: [],
  countries: { available: false },
};

async function stub(page, { fail = [], slow = [] } = {}) {
  await page.addInitScript(([key, session]) => {
    window.localStorage.setItem(key, JSON.stringify(session));
  }, [`sb-${REF}-auth-token`, SESSION]);

  const conversation = {
    id: "c1", title: "FocusFlow", state: "idle", productId: "prod-1",
    publishStatus: "published", site: SITE, health: SITE.health,
  };
  const listRoute = (r) => r.fulfill({ json: {
    conversations: [conversation], counts: { all: 1, published: 1, drafts: 0, updates: 0 },
    page: { offset: 0, limit: 20, total: 1, nextOffset: null, tab: "all", search: null },
  } });
  await page.route("**/api/v1/conversations", listRoute);
  await page.route("**/api/v1/conversations?**", listRoute);
  await page.route("**/api/v1/conversations/deleted", (r) => r.fulfill({ json: { items: [], recoveryDays: 7 } }));
  await page.route(/\/api\/v1\/conversations\/c\d+$/, (r) => r.fulfill({ json: { conversation, turns: [] } }));
  await page.route("**/api/v1/conversations/*/events**", (r) => r.fulfill({ contentType: "text/event-stream", body: "" }));
  await page.route("**/api/v1/publish-state", (r) => r.fulfill({ json: { sites: [SITE] } }));
  await page.route("**/api/v1/billing", (r) => r.fulfill({ json: {
    subscription: { plan: "pro", planName: "Pro", status: "active", pendingPlan: null },
    plans: [], budgets: {}, period: {}, stripeConfigured: true,
  } }));

  // Each tab's data source, individually failable and delayable.
  const answer = (name, json) => async (r) => {
    if (fail.includes(name)) return r.fulfill({ status: 500, json: { error: `${name} is unavailable right now.` } });
    if (slow.includes(name)) await new Promise((resolve) => setTimeout(resolve, 1_500));
    return r.fulfill({ json });
  };
  await page.route("**/api/v1/projects/*/domains", answer("domains", {
    domains: [], allowance: { plan: "pro", limit: null, used: 0, unlimited: true },
  }));
  await page.route("**/api/v1/projects/*/deployments", answer("deployments", { deployments: [] }));
  await page.route("**/api/v1/projects/*/health", answer("health", {
    status: null, uptime: null, checks: 0, windowDays: 30, responseTime: null,
    daily: [], incidents: [], recent: [],
  }));
  await page.route("**/api/v1/projects/*/analytics/live", (r) => r.fulfill({ json: { live: 0, windowMinutes: 5, pages: [] } }));
  await page.route("**/api/v1/projects/*/analytics**", answer("analytics", EMPTY_ANALYTICS));
  await page.route("**/api/v1/projects/*/logs/runs", (r) => r.fulfill({ json: { runs: [] } }));
  await page.route("**/api/v1/projects/*/logs/stream**", (r) => r.fulfill({ contentType: "text/event-stream", body: "" }));
  await page.route("**/api/v1/projects/*/logs?**", answer("logs", {
    entries: [], nextCursor: null, retentionDays: null, plan: "pro",
  }));

  await page.route(`https://${REF}.supabase.co/**`, (r) => r.fulfill({ json: {} }));
  await page.route(`https://${REF}.supabase.co/auth/v1/user**`, (r) => r.fulfill({ json: SESSION.user }));
}

test.skip(!REF, "requires shell/web/.env auth config (skipped in CI)");

const dash = (page) => page.locator(".ct-projdash");
const open = async (page, tab = "overview") => {
  await page.goto(`/projects/${PROJECT}/${tab}`);
  await expect(dash(page)).toBeVisible();
};

// ── The header carries context on every tab ─────────────────────────────────────────────

test("the header names the project, its status, its health and its address", async ({ page }) => {
  await stub(page);
  await open(page);
  const head = dash(page).locator(".ct-projdash-head");
  await expect(head).toContainText("FocusFlow");
  await expect(head).toContainText("LIVE");
  await expect(head).toContainText("Healthy");
  await expect(head.locator(".ct-projdash-url")).toContainText("focusflow.app.thrallo.com");

  // And it stays put as tabs change, so those two facts never scroll away.
  await dash(page).getByRole("tab", { name: "Logs" }).click();
  await expect(head).toContainText("LIVE");
  await expect(head.locator(".ct-projdash-url")).toBeVisible();
});

test("the address opens in a new tab", async ({ page }) => {
  await stub(page);
  await open(page);
  const link = dash(page).locator(".ct-projdash-url");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", /noopener/);
});

// ── Keyboard navigation, as the ARIA promises ───────────────────────────────────────────

test("arrow keys move between tabs, Home and End jump to the ends", async ({ page }) => {
  await stub(page);
  await open(page);
  const tablist = dash(page).getByRole("tablist");
  await tablist.getByRole("tab", { name: "Overview" }).focus();

  await page.keyboard.press("ArrowRight");
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/projects/${PROJECT}/analytics`);
  await expect(tablist.getByRole("tab", { name: "Analytics" })).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("ArrowLeft");
  await expect(tablist.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("End");
  await expect(tablist.getByRole("tab", { name: "Settings" })).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("Home");
  await expect(tablist.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");

  // Wrapping, so the strip has no dead ends.
  await page.keyboard.press("ArrowLeft");
  await expect(tablist.getByRole("tab", { name: "Settings" })).toHaveAttribute("aria-selected", "true");
});

test("the tab strip is one tab stop, and the panel is labelled by its tab", async ({ page }) => {
  await stub(page);
  await open(page, "logs");
  const tablist = dash(page).getByRole("tablist");
  // Roving tabindex: only the selected tab is reachable by Tab, the rest by arrow keys.
  await expect(tablist.getByRole("tab", { name: "Logs" })).toHaveAttribute("tabindex", "0");
  await expect(tablist.getByRole("tab", { name: "Overview" })).toHaveAttribute("tabindex", "-1");

  const panel = dash(page).getByRole("tabpanel");
  await expect(panel).toHaveAttribute("aria-labelledby", "projtab-logs");
});

test("Escape closes the dashboard", async ({ page }) => {
  await stub(page);
  await open(page);
  // Focus a tab first. "Visible" only means mounted; the Escape listener is registered by a mount
  // effect, and on a throttled mobile profile the keypress can otherwise land before it exists.
  // Focusing also mirrors the real case — a keyboard user is already inside the dashboard.
  await dash(page).getByRole("tab", { name: "Overview" }).focus();
  await page.keyboard.press("Escape");
  await expect(dash(page)).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).pathname).toBe("/");
});

// ── One set of states, on every tab ─────────────────────────────────────────────────────

for (const [tab, source] of [
  ["analytics", "analytics"], ["health", "health"], ["logs", "logs"],
  ["deployments", "deployments"], ["domains", "domains"],
]) {
  test(`${tab} shows a skeleton while loading, not a blank panel`, async ({ page }) => {
    await stub(page, { slow: [source] });
    await open(page, tab);
    // The shape of what is coming, announced to assistive technology as busy.
    await expect(dash(page).locator(".ct-tabstate.ct-skel")).toBeVisible();
  });

  test(`${tab} surfaces a failure with a way to retry`, async ({ page }) => {
    await stub(page, { fail: [source] });
    await open(page, tab);
    const error = dash(page).locator(".ct-taberror");
    await expect(error).toBeVisible();
    await expect(error).toContainText("unavailable");
    await expect(error.getByRole("button", { name: "Try again" })).toBeVisible();
  });
}

test("a failed domains read never reads as 'you have no domains'", async ({ page }) => {
  // It used to be swallowed entirely, so the section rendered as empty — inviting someone to add a
  // domain they may already have.
  await stub(page, { fail: ["domains"] });
  await open(page, "domains");
  await expect(dash(page).locator(".ct-taberror")).toBeVisible();
  await expect(dash(page)).not.toContainText("Add domain");
  await expect(dash(page)).toContainText("Your Thrallo address is unaffected");
});

test("empty tabs explain themselves and are not mistaken for failures", async ({ page }) => {
  await stub(page);
  await open(page, "deployments");
  const empty = dash(page).locator(".ct-tabempty");
  await expect(empty).toBeVisible();
  await expect(empty).toContainText("Nothing has been deployed yet");
  await expect(dash(page).locator(".ct-taberror")).toHaveCount(0);
});

// ── Responsiveness ──────────────────────────────────────────────────────────────────────

test("the dashboard fits a phone without the body scrolling sideways", async ({ page }) => {
  await stub(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);

  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  // The tab strip is the one thing allowed to scroll, and it does so on its own.
  const strip = dash(page).locator(".ct-projtabs");
  const scrollable = await strip.evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(scrollable).toBe(true);
  await expect(dash(page).getByRole("tab", { name: "Overview" })).toBeVisible();
});

// ── Refinement ──────────────────────────────────────────────────────────────────────────

test("the page is dimmed behind the dashboard, and clicking away closes it", async ({ page }) => {
  await stub(page);
  await open(page);
  await expect(page.locator(".ct-scrim.show")).toBeVisible();

  await page.locator(".ct-scrim.show").click({ position: { x: 5, y: 5 } });
  await expect(dash(page)).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).pathname).toBe("/");
});

test("focus moves into the dashboard on open and returns to the opener on close", async ({ page }) => {
  await stub(page);
  await page.goto("/");
  const card = page.locator(".ct-project").filter({ hasText: "FocusFlow" });
  await card.getByRole("button", { name: "Health" }).click();
  await expect(dash(page)).toBeVisible();

  // The heading, so a screen reader announces what opened before offering its controls.
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe("H2");

  await dash(page).getByRole("button", { name: "Done" }).click();
  await expect(dash(page)).toHaveCount(0);
  // Back to the button that opened it, not the top of the document.
  await expect.poll(() => page.evaluate(() => document.activeElement?.textContent)).toBe("Health");
});

test("typing in the log search does not refetch on every keystroke", async ({ page }) => {
  await stub(page);
  let requests = 0;
  await page.route("**/api/v1/projects/*/logs?**", async (r) => {
    requests += 1;
    await r.fulfill({ json: { entries: [], nextCursor: null, retentionDays: null, plan: "pro" } });
  });
  await open(page, "logs");
  await expect(dash(page).getByLabel("Search logs")).toBeVisible();

  const before = requests;
  await dash(page).getByLabel("Search logs").pressSequentially("timeout", { delay: 40 });
  // Seven characters used to be seven requests and seven live-stream reconnections.
  await page.waitForTimeout(600);
  expect(requests - before).toBeLessThanOrEqual(2);
});
