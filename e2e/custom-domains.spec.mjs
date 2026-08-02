// Custom domains in Project Settings, and the LIVE badge on the dashboard.
//
// Every control asserted here does something: add, check, retry, remove. The Thrallo address is
// asserted to survive all of it, because "will this break my existing URL?" is the question that
// stops people connecting a domain at all.

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
  unpublishedAt: null, live: true, updateAvailable: false, status: "published",
};

const PUBLISHED = { id: "c1", title: "FocusFlow", state: "idle", productId: "prod-1", publishStatus: "published", site: SITE };
const DRAFT = { id: "c2", title: "Draft idea", state: "idle", productId: "prod-2", publishStatus: "draft", site: null };
const UPDATE_AVAILABLE = {
  ...PUBLISHED, publishStatus: "update_available",
  site: { ...SITE, status: "update_available", updateAvailable: true },
};

const DOMAIN = (over = {}) => ({
  domain: "shop.example.com", projectId: SITE.projectId,
  status: "pending_dns", sslStatus: "pending", verifiedAt: null,
  lastCheckedAt: new Date(Date.now() - 90_000).toISOString(), failureReason: null,
  records: [
    { purpose: "verification", type: "TXT", name: "_thrallo-verify.shop.example.com", value: "thrallo-verify=abc", note: "Proves you own this domain." },
    { purpose: "routing", type: "CNAME", name: "shop.example.com", value: "focusflow.app.thrallo.com", note: "Points the domain at your Thrallo site." },
  ],
  ...over,
});

const UNLIMITED = { plan: "pro", limit: null, used: 0, unlimited: true };

async function stub(page, conversations) {
  await page.addInitScript(([key, session]) => {
    window.localStorage.setItem(key, JSON.stringify(session));
  }, [`sb-${REF}-auth-token`, SESSION]);
  await page.route("**/api/v1/conversations", (r) => r.fulfill({ json: { conversations } }));
  await page.route("**/api/v1/conversations/deleted", (r) => r.fulfill({ json: { items: [], recoveryDays: 7 } }));
  await page.route("**/api/v1/conversations/*/events**", (r) => r.fulfill({ contentType: "text/event-stream", body: "" }));
  await page.route("**/api/v1/publish-state", (r) => r.fulfill({ json: { sites: conversations.map((c) => c.site).filter(Boolean) } }));
  await page.route("**/api/v1/billing", (r) => r.fulfill({ json: {
    subscription: { plan: "pro", planName: "Pro", status: "active", pendingPlan: null },
    plans: [], budgets: {}, period: {}, stripeConfigured: true,
  } }));
  await page.route(`https://${REF}.supabase.co/**`, (r) => r.fulfill({ json: {} }));
  await page.route(`https://${REF}.supabase.co/auth/v1/user**`, (r) => r.fulfill({ json: SESSION.user }));
}

const card = (page, title) => page.locator(".ct-project").filter({ hasText: title });
const sheetOf = (page) => page.locator(".ct-sheet").filter({ hasText: "Project settings" });

async function openSettings(page, { domains = [], allowance = UNLIMITED, onDomains = null } = {}) {
  const state = { domains, allowance };
  await page.route("**/domains", (route) => (onDomains ? onDomains(route, state) : route.fulfill({ json: state })));
  await page.route("**/domains/*", (route) => (onDomains ? onDomains(route, state) : route.fulfill({ json: state })));
  await page.goto("/");
  await card(page, "FocusFlow").getByRole("button", { name: "Project Settings" }).click();
  await expect(sheetOf(page)).toBeVisible();
  return state;
}

test.skip(!REF, "requires shell/web/.env auth config (skipped in CI)");

test("the Thrallo address is shown first and cannot be removed", async ({ page }) => {
  await stub(page, [PUBLISHED]);
  await openSettings(page, { domains: [DOMAIN({ status: "active" })] });
  const sheet = sheetOf(page);
  await expect(sheet).toContainText("focusflow.app.thrallo.com");
  await expect(sheet).toContainText("Always active");
  // One Remove — for the custom domain. The default address is never removable.
  await expect(sheet.getByRole("button", { name: "Remove" })).toHaveCount(1);
});

test("a pending domain shows its DNS records, each copyable", async ({ page, context, browserName }) => {
  test.skip(browserName !== "chromium", "clipboard permissions are chromium-specific here");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await stub(page, [PUBLISHED]);
  await openSettings(page, { domains: [DOMAIN()] });

  const sheet = sheetOf(page);
  await expect(sheet.locator(".ct-live-badge.dn-pending_dns")).toHaveText(/Pending DNS/);
  await expect(sheet).toContainText("_thrallo-verify.shop.example.com");
  await expect(sheet).toContainText("checked 1 minute ago");

  await sheet.locator(".ct-dns-value").filter({ hasText: "thrallo-verify=abc" })
    .getByRole("button", { name: "Copy" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("thrallo-verify=abc");
});

test("every status is distinguishable, and an active domain hides the setup records", async ({ page }) => {
  await stub(page, [PUBLISHED]);
  await openSettings(page, { domains: [
    DOMAIN({ domain: "a.example.com", status: "pending_dns" }),
    DOMAIN({ domain: "b.example.com", status: "verifying" }),
    DOMAIN({ domain: "c.example.com", status: "active", sslStatus: "active", verifiedAt: new Date().toISOString() }),
    DOMAIN({ domain: "d.example.com", status: "failed", failureReason: "We could not verify this domain." }),
  ] });
  const sheet = sheetOf(page);
  await expect(sheet.locator(".ct-live-badge.dn-pending_dns")).toHaveText(/Pending DNS/);
  await expect(sheet.locator(".ct-live-badge.dn-verifying")).toHaveText(/Verifying/);
  await expect(sheet.locator(".ct-live-badge.dn-active")).toHaveText(/Active/);
  await expect(sheet.locator(".ct-live-badge.dn-failed")).toHaveText(/Failed/);

  // SSL is reported separately from verification, because they settle at different moments.
  await expect(sheet).toContainText("certificate issued");
  await expect(sheet.getByRole("button", { name: "Retry verification" })).toHaveCount(1);
  await expect(sheet).toContainText("We could not verify this domain.");
  // Three unfinished domains show records; the active one does not.
  await expect(sheet.locator(".ct-dns")).toHaveCount(3);
});

test("adding a domain sends it and shows the returned status", async ({ page }) => {
  let added = null;
  await stub(page, [PUBLISHED]);
  await openSettings(page, {
    onDomains: (route, state) => {
      if (route.request().method() === "POST") {
        added = JSON.parse(route.request().postData() || "{}").domain;
        state.domains = [DOMAIN({ domain: added })];
      }
      return route.fulfill({ json: state });
    },
  });
  const sheet = sheetOf(page);
  await sheet.getByLabel("Custom domain").fill("shop.example.com");
  await sheet.getByRole("button", { name: "Add domain" }).click();

  await expect.poll(() => added).toBe("shop.example.com");
  await expect(sheet.locator(".ct-live-badge.dn-pending_dns")).toBeVisible();
});

test("Check now and Retry both reach the server", async ({ page }) => {
  const hits = [];
  await stub(page, [PUBLISHED]);
  await openSettings(page, {
    domains: [DOMAIN({ status: "pending_dns" })],
    onDomains: (route, state) => {
      const url = route.request().url();
      if (url.endsWith("/verify")) hits.push("verify");
      if (url.endsWith("/retry")) hits.push("retry");
      return route.fulfill({ json: state });
    },
  });
  const sheet = sheetOf(page);
  await sheet.getByRole("button", { name: "Check now" }).click();
  await expect.poll(() => hits).toContain("verify");
});

test("a Free account is told domains need a paid plan and cannot add one", async ({ page }) => {
  await stub(page, [PUBLISHED]);
  await openSettings(page, { allowance: { plan: "free", limit: 0, used: 0, unlimited: false } });
  const sheet = sheetOf(page);
  await expect(sheet).toContainText("included on Starter and Pro");
  await expect(sheet.getByRole("button", { name: "Add domain" })).toBeDisabled();
  await expect(sheet.getByLabel("Custom domain")).toBeDisabled();
  // The Thrallo address is unaffected by not having the paid feature.
  await expect(sheet).toContainText("focusflow.app.thrallo.com");
});

test("a Starter account at its limit cannot add a second, but can replace", async ({ page }) => {
  await stub(page, [PUBLISHED]);
  await openSettings(page, {
    domains: [DOMAIN({ status: "active" })],
    allowance: { plan: "starter", limit: 1, used: 1, unlimited: false },
  });
  const sheet = sheetOf(page);
  await expect(sheet).toContainText("1 of 1 custom domain used");
  await expect(sheet.getByRole("button", { name: "Add domain" })).toBeDisabled();
  await expect(sheet.getByRole("button", { name: "Remove" })).toBeEnabled();
});

test("removing a domain asks the server and leaves the Thrallo address alone", async ({ page }) => {
  let removed = null;
  await stub(page, [PUBLISHED]);
  await openSettings(page, {
    domains: [DOMAIN({ status: "active" })],
    onDomains: (route, state) => {
      if (route.request().url().endsWith("/remove")) {
        removed = JSON.parse(route.request().postData() || "{}").domain;
        state.domains = [];
      }
      return route.fulfill({ json: state });
    },
  });
  const sheet = sheetOf(page);
  await sheet.getByRole("button", { name: "Remove" }).click();
  await expect.poll(() => removed).toBe("shop.example.com");
  await expect(sheet.locator(".ct-domain")).toHaveCount(0);
  await expect(sheet).toContainText("focusflow.app.thrallo.com");
});

// ── The LIVE badge ──────────────────────────────────────────────────────────────────────

test("a live project is marked LIVE and stands out from a draft", async ({ page }) => {
  await stub(page, [PUBLISHED, DRAFT]);
  await page.goto("/");
  const live = card(page, "FocusFlow");
  await expect(live.locator(".ct-badge.tone-live")).toHaveText("LIVE");
  await expect(live).toHaveClass(/is-live/);
  await expect(card(page, "Draft idea")).not.toHaveClass(/is-live/);
  // The public URL, its link target and the publish time are all on the card itself.
  await expect(live.locator(".ct-pubrow-url")).toHaveAttribute("href", SITE.url);
  await expect(live).toContainText("published 6 minutes ago");
});

test("a project with an update pending still says LIVE, because it is", async ({ page }) => {
  await stub(page, [UPDATE_AVAILABLE]);
  await page.goto("/");
  const c = card(page, "FocusFlow");
  await expect(c.locator(".ct-badge.tone-update")).toHaveText("UPDATE AVAILABLE");
  await expect(c.locator(".ct-badge.tone-live")).toHaveText("LIVE");
  await expect(c).toHaveClass(/is-live/);
});

test("an active custom domain becomes the address on the card", async ({ page, context, browserName }) => {
  test.skip(browserName !== "chromium", "clipboard permissions are chromium-specific here");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const withDomain = {
    ...PUBLISHED,
    site: { ...SITE, customDomain: "shop.example.com", primaryUrl: "https://shop.example.com" },
  };
  await stub(page, [withDomain]);
  await page.goto("/");
  const c = card(page, "FocusFlow");
  await expect(c.locator(".ct-pubrow-url")).toHaveText("shop.example.com");
  await expect(c.locator(".ct-pubrow-url")).toHaveAttribute("href", "https://shop.example.com");
  await expect(c.getByRole("link", { name: "Open Live Site" })).toHaveAttribute("href", "https://shop.example.com");
  await c.getByRole("button", { name: "Copy URL" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("https://shop.example.com");
  // The Thrallo address is still reachable where it belongs.
  await c.getByRole("button", { name: "Project Settings" }).click();
  await expect(sheetOf(page)).toContainText("focusflow.app.thrallo.com");
});

test("the dashboard groups Live apps, In progress and Drafts", async ({ page }) => {
  await stub(page, [
    PUBLISHED,
    { id: "c3", title: "Building now", state: "idle", productId: "prod-3", publishStatus: "draft", site: null,
      activity: { agent: "Builder", status: "Writing code…" } },
    DRAFT,
  ]);
  await page.goto("/");
  const labels = page.locator(".ct-ws-label");
  await expect(labels).toHaveText(["Live apps", "In progress", "Drafts"]);
  await expect(card(page, "Building now").locator(".ct-badge.tone-building")).toHaveText("BUILDING");
});

test("a live project that is building appears once, under Live apps", async ({ page }) => {
  await stub(page, [{ ...PUBLISHED, activity: { agent: "Builder", status: "Writing code…" } }]);
  await page.goto("/");
  await expect(page.locator(".ct-ws-label")).toHaveText(["Live apps"]);
  await expect(card(page, "FocusFlow")).toHaveCount(1);
  await expect(card(page, "FocusFlow").locator(".ct-badge.tone-live")).toHaveText("LIVE");
  await expect(card(page, "FocusFlow").locator(".ct-badge.tone-building")).toHaveText("BUILDING");
});

test("publishing ends with a success panel offering Connect Domain", async ({ page }) => {
  await stub(page, [PUBLISHED]);
  await page.route("**/domains", (r) => r.fulfill({ json: { domains: [], allowance: UNLIMITED } }));
  await page.goto("/");
  await card(page, "FocusFlow").locator(".ct-pname").click();

  const panel = page.locator(".ct-published");
  await expect(panel.locator(".ct-badge.tone-live")).toHaveText("LIVE");
  await expect(panel.locator(".ct-published-env")).toHaveText("Production");
  await expect(panel.getByRole("link", { name: "Open Site" })).toHaveAttribute("href", SITE.url);
  await expect(panel.getByRole("button", { name: "Copy URL" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Connect Domain" })).toBeVisible();

  await panel.getByRole("button", { name: "Connect Domain" }).click();
  await expect(sheetOf(page)).toContainText("Domains");
});

test("Connect Domain is not offered once a domain is already connected", async ({ page }) => {
  await stub(page, [{
    ...PUBLISHED,
    site: { ...SITE, customDomain: "shop.example.com", primaryUrl: "https://shop.example.com" },
  }]);
  await page.goto("/");
  await card(page, "FocusFlow").locator(".ct-pname").click();
  const panel = page.locator(".ct-published");
  await expect(panel.getByRole("button", { name: "Connect Domain" })).toHaveCount(0);
  await expect(panel.locator(".ct-published-url")).toHaveText("shop.example.com");
});
