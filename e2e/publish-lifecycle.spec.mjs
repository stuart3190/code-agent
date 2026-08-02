// The publish lifecycle on the Projects dashboard.
//
// draft → published → update available → unpublished → published again, plus the tabs, the badges
// and the requirement that the dashboard settles WITHOUT a page reload. Publish state travels with
// the conversation rows, so these stub /api/v1/conversations and assert the UI follows it.

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

const SITE = {
  projectId: "11111111-1111-4111-8111-111111111111",
  currentProjectId: "11111111-1111-4111-8111-111111111111",
  productId: "prod-1", name: "FocusFlow", slug: "focusflow",
  url: "https://focusflow.app.thrallo.com", environment: "production",
  publishedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
  firstPublishedAt: "2026-07-01T00:00:00.000Z", unpublishedAt: null,
  live: true, updateAvailable: false, status: "published",
};

const convo = (over = {}) => ({ id: "c1", title: "FocusFlow", state: "idle", productId: "prod-1", ...over });
const DRAFT = { id: "c2", title: "Draft idea", state: "idle", productId: "prod-2", publishStatus: "draft", site: null };

const PUBLISHED = convo({ publishStatus: "published", site: SITE });
const UPDATE_AVAILABLE = convo({
  publishStatus: "update_available",
  site: { ...SITE, status: "update_available", updateAvailable: true },
});
const UNPUBLISHED = convo({
  publishStatus: "unpublished",
  site: { ...SITE, status: "unpublished", live: false, updateAvailable: false, unpublishedAt: new Date().toISOString() },
});

// listState lets a test change what the server returns mid-run, so "the dashboard refreshes
// without a reload" is asserted rather than assumed.
async function stub(page, initial, { onUnpublish = null } = {}) {
  const state = { conversations: initial };
  await page.addInitScript(([key, session]) => {
    window.localStorage.setItem(key, JSON.stringify(session));
  }, [`sb-${REF}-auth-token`, SESSION]);
  await page.route("**/api/v1/conversations", (r) => r.fulfill({ json: { conversations: state.conversations } }));
  await page.route("**/api/v1/conversations/deleted", (r) => r.fulfill({ json: { items: [], recoveryDays: 7 } }));
  await page.route("**/api/v1/conversations/*/events**", (r) =>
    r.fulfill({ contentType: "text/event-stream", body: "" }));
  await page.route("**/api/v1/publish-state", (r) => r.fulfill({ json: {
    sites: state.conversations.map((c) => c.site).filter(Boolean),
  } }));
  await page.route("**/api/v1/billing", (r) => r.fulfill({ json: {
    subscription: { plan: "pro", planName: "Pro", status: "active", pendingPlan: null },
    plans: [], budgets: {}, period: {}, stripeConfigured: true,
  } }));
  if (onUnpublish) await page.route("**/unpublish", (r) => onUnpublish(r, state));
  await page.route(`https://${REF}.supabase.co/**`, (r) => r.fulfill({ json: {} }));
  await page.route(`https://${REF}.supabase.co/auth/v1/user**`, (r) => r.fulfill({ json: SESSION.user }));
  return state;
}

const card = (page, title) => page.locator(".ct-project").filter({ hasText: title });

test.skip(!REF, "requires shell/web/.env auth config (skipped in CI)");

// ── Status is visible on every project ──────────────────────────────────────────────────

test("every project states its lifecycle position, drafts included", async ({ page }) => {
  await stub(page, [PUBLISHED, DRAFT]);
  await page.goto("/");
  await expect(card(page, "FocusFlow").locator(".ct-live-badge")).toHaveText(/Published/);
  await expect(card(page, "Draft idea").locator(".ct-live-badge")).toHaveText(/Draft/);
});

test("a changed project keeps its live URL and says Update Available", async ({ page }) => {
  await stub(page, [UPDATE_AVAILABLE]);
  await page.goto("/");
  const c = card(page, "FocusFlow");
  await expect(c.locator(".ct-live-badge")).toHaveText(/Update Available/);
  // The site is still online, so the URL must still be shown and still be a link.
  await expect(c.locator(".ct-pubrow-url")).toHaveText("focusflow.app.thrallo.com");
  await expect(c.locator(".ct-pubrow-url")).toHaveAttribute("href", SITE.url);
});

test("an unpublished project shows Unpublished and no live link", async ({ page }) => {
  await stub(page, [UNPUBLISHED]);
  await page.goto("/");
  const c = card(page, "FocusFlow");
  await expect(c.locator(".ct-live-badge")).toHaveText(/Unpublished/);
  await expect(c.locator(".ct-pubrow-url.offline")).toBeVisible();
  await expect(c.getByRole("link", { name: "Open Live Site" })).toHaveCount(0);
  await expect(c.getByRole("button", { name: "Publish Again" })).toBeVisible();
});

// ── Tabs ────────────────────────────────────────────────────────────────────────────────

test("tabs filter by lifecycle and every project appears under All", async ({ page }) => {
  await stub(page, [PUBLISHED, DRAFT, { ...UPDATE_AVAILABLE, id: "c3", title: "Changed app", productId: "prod-3" }]);
  await page.goto("/");

  await expect(page.locator(".ct-ws-tab")).toHaveCount(4);
  await expect(page.locator(".ct-project")).toHaveCount(3);

  await page.getByRole("tab", { name: /Published/ }).click();
  await expect(page.locator(".ct-project")).toHaveCount(1);
  await expect(card(page, "FocusFlow")).toBeVisible();

  await page.getByRole("tab", { name: /Update Available/ }).click();
  await expect(page.locator(".ct-project")).toHaveCount(1);
  await expect(card(page, "Changed app")).toBeVisible();

  await page.getByRole("tab", { name: /Drafts/ }).click();
  await expect(card(page, "Draft idea")).toBeVisible();

  await page.getByRole("tab", { name: /^All/ }).click();
  await expect(page.locator(".ct-project")).toHaveCount(3);
});

test("an unpublished project moves out of Published and into Drafts", async ({ page }) => {
  await stub(page, [UNPUBLISHED, DRAFT]);
  await page.goto("/");
  // Published is empty, so the tab is not offered at all rather than shown leading nowhere.
  await expect(page.getByRole("tab", { name: /^Published/ })).toHaveCount(0);
  await page.getByRole("tab", { name: /Drafts/ }).click();
  await expect(page.locator(".ct-project")).toHaveCount(2);
});

// ── Transitions, without a page reload ──────────────────────────────────────────────────

test("Published → Unpublished settles on the dashboard with no reload", async ({ page }) => {
  let called = null;
  const state = await stub(page, [PUBLISHED], {
    onUnpublish: (route, s) => {
      called = new URL(route.request().url()).pathname;
      s.conversations = [UNPUBLISHED];        // the server's answer changes
      return route.fulfill({ json: { message: "Your site has been unpublished.", sites: [UNPUBLISHED.site] } });
    },
  });
  await page.goto("/");
  await expect(card(page, "FocusFlow").locator(".ct-live-badge")).toHaveText(/Published/);

  await card(page, "FocusFlow").getByRole("button", { name: "Unpublish" }).click();
  const dialog = page.getByRole("dialog", { name: /offline/i });
  await expect(dialog).toContainText("focusflow.app.thrallo.com");
  await expect(dialog).toContainText("publish history");           // says what survives
  await dialog.getByRole("button", { name: "Unpublish" }).click();

  await expect(page.getByText("Your site has been unpublished.")).toBeVisible();
  // No reload happened, yet the card has moved on.
  await expect(card(page, "FocusFlow").locator(".ct-live-badge")).toHaveText(/Unpublished/);
  expect(called).toMatch(new RegExp(`/api/v1/projects/${SITE.projectId}/unpublish$`));
  expect(state.conversations[0].publishStatus).toBe("unpublished");
});

test("cancelling the dialog leaves the site alone", async ({ page }) => {
  let called = false;
  await stub(page, [PUBLISHED], { onUnpublish: (route) => { called = true; return route.fulfill({ json: {} }); } });
  await page.goto("/");
  await card(page, "FocusFlow").getByRole("button", { name: "Unpublish" }).click();
  await page.getByRole("dialog", { name: /offline/i }).getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog", { name: /offline/i })).toHaveCount(0);
  await expect(card(page, "FocusFlow").locator(".ct-live-badge")).toHaveText(/Published/);
  expect(called).toBe(false);
});

test("a failed unpublish says so and keeps the site listed as live", async ({ page }) => {
  await stub(page, [PUBLISHED], {
    onUnpublish: (route) => route.fulfill({ status: 500, json: { error: "The site could not be taken offline. Please try again." } }),
  });
  await page.goto("/");
  await card(page, "FocusFlow").getByRole("button", { name: "Unpublish" }).click();
  await page.getByRole("dialog", { name: /offline/i }).getByRole("button", { name: "Unpublish" }).click();
  await expect(page.getByRole("dialog", { name: /offline/i })).toContainText("could not be taken offline");
  await page.getByRole("dialog", { name: /offline/i }).getByRole("button", { name: "Cancel" }).click();
  await expect(card(page, "FocusFlow").locator(".ct-live-badge")).toHaveText(/Published/);
});

test("Unpublished → Published again posts to the right conversation", async ({ page }) => {
  let sentTo = null;
  let text = null;
  await stub(page, [UNPUBLISHED]);
  await page.route("**/api/v1/conversations/*/messages", (r) => {
    sentTo = new URL(r.request().url()).pathname.split("/")[4];
    text = JSON.parse(r.request().postData() || "{}").text;
    return r.fulfill({ json: { ok: true } });
  });
  await page.goto("/");
  await card(page, "FocusFlow").getByRole("button", { name: "Publish Again" }).click();

  // `send` reads the active conversation from its closure; publishing from a CARD must still reach
  // that card's conversation rather than starting a new one.
  await expect.poll(() => sentTo).toBe("c1");
  expect(text).toMatch(/publish/i);
});

test("Copy URL on a card copies the live address without opening the project", async ({ page, context, browserName }) => {
  test.skip(browserName !== "chromium", "clipboard permissions are chromium-specific here");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await stub(page, [PUBLISHED]);
  await page.goto("/");
  await card(page, "FocusFlow").getByRole("button", { name: "Copy URL" }).click();
  await expect(card(page, "FocusFlow").getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(SITE.url);
  // The card's own click opens the project — the action buttons must not.
  await expect(page.locator(".ct-begin")).toBeVisible();
});

test("a published card offers exactly the actions that work", async ({ page }) => {
  await stub(page, [PUBLISHED]);
  await page.goto("/");
  const c = card(page, "FocusFlow");
  await expect(c.getByRole("link", { name: "Open Live Site" })).toHaveAttribute("href", SITE.url);
  for (const name of ["Copy URL", "Publish Update", "Unpublish", "Project Settings"]) {
    await expect(c.getByRole("button", { name })).toBeVisible();
  }
  await expect(c).toContainText("Production");
  await expect(c).toContainText("published 6 minutes ago");
});
