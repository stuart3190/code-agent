// The published state: the dashboard badge and the in-conversation panel.
//
// The failure this replaces was quiet — publishing ended with a line in the thread that scrolled
// away, so "is my app actually live?" had no answer anywhere. These assert that the answer is
// visible without opening anything, and that it distinguishes live-and-current from live-but-stale.

import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function supabaseRef() {
  try {
    const env = readFileSync(fileURLToPath(new URL("../shell/web/.env", import.meta.url)), "utf8");
    const url = env.match(/VITE_SUPABASE_URL\s*=\s*(\S+)/)?.[1] || "";
    return new URL(url).hostname.split(".")[0] || null;
  } catch {
    return null;
  }
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

const LIVE = {
  projectId: "p1", productId: "prod-1", name: "FocusFlow",
  url: "https://focusflow.app.thrallo.com", environment: "production",
  publishedAt: new Date(Date.now() - 7 * 60_000).toISOString(),
  updateAvailable: false,
};
const STALE = { ...LIVE, updateAvailable: true };

const CONVERSATIONS = [
  { id: "c1", title: "FocusFlow", state: "idle", productId: "prod-1" },
  { id: "c2", title: "Draft idea", state: "idle", productId: "prod-2" },
];

async function stub(page, { sites = [], onExport = null } = {}) {
  await page.addInitScript(([key, session]) => {
    window.localStorage.setItem(key, JSON.stringify(session));
  }, [`sb-${REF}-auth-token`, SESSION]);
  await page.route("**/api/v1/conversations", (r) => r.fulfill({ json: { conversations: CONVERSATIONS } }));
  await page.route("**/api/v1/conversations/deleted", (r) => r.fulfill({ json: { items: [], recoveryDays: 7 } }));
  await page.route("**/api/v1/conversations/*/events**", (r) =>
    r.fulfill({ contentType: "text/event-stream", body: "" }));
  await page.route("**/api/v1/publish-state", (r) => r.fulfill({ json: { sites } }));
  await page.route("**/api/v1/billing", (r) => r.fulfill({ json: {
    subscription: { plan: "pro", planName: "Pro", status: "active", pendingPlan: null },
    plans: [], budgets: {}, period: {}, stripeConfigured: true,
  } }));
  if (onExport) await page.route("**/api/export", onExport);
  await page.route(`https://${REF}.supabase.co/**`, (r) => r.fulfill({ json: {} }));
  await page.route(`https://${REF}.supabase.co/auth/v1/user**`, (r) => r.fulfill({ json: SESSION.user }));
}

test.skip(!REF, "requires shell/web/.env auth config (skipped in CI)");

test("a published project is marked on the dashboard; a draft is not", async ({ page }) => {
  await stub(page, { sites: [LIVE] });
  await page.goto("/");
  const published = page.locator(".ct-project").filter({ hasText: "FocusFlow" });
  const draft = page.locator(".ct-project").filter({ hasText: "Draft idea" });
  await expect(published.locator(".ct-live-badge")).toHaveText(/Published/);
  await expect(draft.locator(".ct-live-badge")).toHaveCount(0);
});

test("a project changed since publishing says Update Available instead", async ({ page }) => {
  await stub(page, { sites: [STALE] });
  await page.goto("/");
  const card = page.locator(".ct-project").filter({ hasText: "FocusFlow" });
  await expect(card.locator(".ct-live-badge")).toHaveText(/Update Available/);
  await expect(card.locator(".ct-live-badge")).toHaveClass(/stale/);
});

test("the conversation shows the live URL, status, environment and publish time", async ({ page }) => {
  await stub(page, { sites: [LIVE] });
  await page.goto("/");
  await page.locator(".ct-project").filter({ hasText: "FocusFlow" }).click();

  const panel = page.locator(".ct-published");
  await expect(panel.locator(".ct-published-badge")).toHaveText(/Published/);
  await expect(panel.locator(".ct-published-env")).toHaveText("Production");
  await expect(panel.locator(".ct-published-url")).toHaveText("focusflow.app.thrallo.com");
  await expect(panel.locator(".ct-published-meta")).toContainText("7 minutes ago");

  // It opens the real site in a new tab rather than navigating the app away.
  const open = panel.getByRole("link", { name: "Open Live Site" });
  await expect(open).toHaveAttribute("href", LIVE.url);
  await expect(open).toHaveAttribute("target", "_blank");
});

test("the panel persists — it is not a one-time success message", async ({ page }) => {
  await stub(page, { sites: [LIVE] });
  await page.goto("/");
  await page.locator(".ct-project").filter({ hasText: "FocusFlow" }).click();
  await expect(page.locator(".ct-published")).toBeVisible();

  // Leave, come back, reload: still there, and never celebrating a publish that happened earlier.
  await page.getByRole("button", { name: /Home/ }).first().click();
  await page.locator(".ct-project").filter({ hasText: "FocusFlow" }).click();
  await expect(page.locator(".ct-published")).toBeVisible();
  await expect(page.locator(".ct-published-cheer")).toHaveCount(0);
});

test("an unpublished project shows no panel at all", async ({ page }) => {
  await stub(page, { sites: [LIVE] });
  await page.goto("/");
  await page.locator(".ct-project").filter({ hasText: "Draft idea" }).click();
  await expect(page.locator(".ct-published")).toHaveCount(0);
});

test("Copy URL copies the live address", async ({ page, context, browserName }) => {
  test.skip(browserName !== "chromium", "clipboard permissions are chromium-specific here");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await stub(page, { sites: [LIVE] });
  await page.goto("/");
  await page.locator(".ct-project").filter({ hasText: "FocusFlow" }).click();

  await page.locator(".ct-published").getByRole("button", { name: "Copy URL" }).click();
  await expect(page.locator(".ct-published").getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(LIVE.url);
});

test("Publish Update asks for a republish through the normal conversational path", async ({ page }) => {
  let sent = null;
  await stub(page, { sites: [STALE] });
  await page.route("**/api/v1/conversations/c1/messages", (r) => {
    sent = JSON.parse(r.request().postData() || "{}").text;
    return r.fulfill({ json: { ok: true } });
  });
  await page.goto("/");
  await page.locator(".ct-project").filter({ hasText: "FocusFlow" }).click();
  await page.locator(".ct-published").getByRole("button", { name: "Publish Update" }).click();

  await expect.poll(() => sent).toMatch(/publish/i);
});

test("Project Settings offers only actions that exist, and can download the source", async ({ page }) => {
  let exported = null;
  await stub(page, {
    sites: [LIVE],
    onExport: (route) => {
      exported = JSON.parse(route.request().postData() || "{}").projectId;
      return route.fulfill({
        status: 200,
        headers: { "Content-Type": "application/zip", "Content-Disposition": 'attachment; filename="focusflow.zip"' },
        body: "PKstub",
      });
    },
  });
  await page.goto("/");
  await page.locator(".ct-project").filter({ hasText: "FocusFlow" }).click();
  await page.locator(".ct-published").getByRole("button", { name: "Project Settings" }).click();

  const sheet = page.locator(".ct-sheet").filter({ hasText: "Project settings" });
  await expect(sheet).toContainText("focusflow.app.thrallo.com");
  await expect(sheet).toContainText("Custom domain");

  const download = page.waitForEvent("download");
  await sheet.getByRole("button", { name: "Download" }).click();
  expect((await download).suggestedFilename()).toBe("focusflow.zip");
  expect(exported).toBe("p1");
});
