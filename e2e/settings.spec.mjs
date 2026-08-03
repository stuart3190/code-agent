// Settings.
//
// Five tabs at a real address, replacing a single scrolling sheet in which Billing sat sixth and
// the only way to see usage was a Details button that opened a second overlay on top of the first.
//
// Every fixture below is a plan state that really exists: Free, Starter mid-period, Pro with a
// scheduled downgrade, a subscription set to cancel, and a failed payment. Each is asserted for the
// wording a paying customer would actually act on — "ends" and "renews" are the same date and
// opposite facts.

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

const HOUR = 3600;
const PLANS = [
  { id: "free", name: "Free", description: "Evaluate Thrallo.", priceGbp: 0, priceApproved: true,
    monthly: { runs: 20, managedTokens: 1_500_000, computeSeconds: 3 * HOUR } },
  { id: "starter", name: "Starter", description: "Daily agent work.", priceGbp: 20, priceApproved: true,
    monthly: { runs: 200, managedTokens: 20_000_000, computeSeconds: 30 * HOUR } },
  { id: "pro", name: "Pro", description: "Heavy automation.", priceGbp: 60, priceApproved: true,
    monthly: { runs: 1_000, managedTokens: 100_000_000, computeSeconds: 120 * HOUR } },
];

const PERIOD_END = "2026-09-12T00:00:00.000Z";

const CAPABILITIES = {
  free: { plan: "free", retentionDays: 7, fullAnalytics: false, errorReporting: false, buildHistory: false, export: false, multiDomain: false },
  starter: { plan: "starter", retentionDays: 90, fullAnalytics: true, errorReporting: true, buildHistory: true, export: false, multiDomain: false },
  pro: { plan: "pro", retentionDays: null, fullAnalytics: true, errorReporting: true, buildHistory: true, export: true, multiDomain: true },
};

function settings({ plan = "free", used = {}, subscription = {}, tokens = [], unread = 0, status = "active" } = {}) {
  const catalogue = PLANS.find((p) => p.id === plan);
  const meter = (key) => {
    const limit = catalogue.monthly[key];
    const usedValue = used[key] ?? 0;
    return { used: usedValue, limit, remaining: Math.max(0, limit - usedValue) };
  };
  const paid = plan !== "free";
  return {
    plan: catalogue,
    subscription: {
      plan, planName: catalogue.name, status, stripeManaged: paid,
      currentPeriodEnd: paid ? PERIOD_END : PERIOD_END,
      cancelAtPeriodEnd: false, periodEndMeans: paid ? "renews" : "resets",
      priceGbp: catalogue.priceGbp,
      pendingPlan: null, pendingPlanName: null, pendingPlanAt: null,
      overrides: { runs: null, managedTokens: null, computeSeconds: null },
      ...subscription,
    },
    plans: PLANS,
    stripeConfigured: true,
    capabilities: CAPABILITIES[plan],
    pastDue: status === "past_due",
    ownerAccount: false, previewPlan: null, unlimited: false,
    period: { start: "2026-08-12T00:00:00.000Z", end: PERIOD_END },
    budgets: { runs: meter("runs"), managedTokens: meter("managedTokens"), computeSeconds: meter("computeSeconds") },
    tokens,
    notifications: { unread, channels: { webpush: true, email: true }, vapidPublicKey: "" },
    counts: { projects: 4, liveSites: 2, deployments: 17 },
  };
}

const NOTIFICATIONS = [
  { id: "n1", source: "domain", title: "Custom domain stopped working", body: "shop.example.com no longer points to Thrallo.", url: "https://shop.example.com", read: false, createdAt: "2026-08-14T09:00:00.000Z" },
  { id: "n2", source: "publish", title: "Published", body: "FocusFlow is live.", url: "https://focusflow.app.thrallo.com", read: false, createdAt: "2026-08-13T09:00:00.000Z" },
  { id: "n3", source: "health", title: "Site recovered", body: "It is responding again.", url: null, read: true, createdAt: "2026-08-12T09:00:00.000Z" },
];

async function stub(page, { data = settings(), notifications = NOTIFICATIONS, onCancel = null, onToken = null } = {}) {
  const state = { data: JSON.parse(JSON.stringify(data)), notifications: JSON.parse(JSON.stringify(notifications)) };

  await page.addInitScript(([key, session]) => {
    window.localStorage.setItem(key, JSON.stringify(session));
    window.localStorage.setItem("thrallo-returning", "1");
  }, [`sb-${REF}-auth-token`, SESSION]);

  await page.route("**/api/v1/settings", (r) => r.fulfill({ json: state.data }));
  const notificationList = (r) => r.fulfill({ json: {
    items: state.notifications, unread: state.notifications.filter((n) => !n.read).length,
  } });
  await page.route("**/api/v1/notifications", notificationList);
  await page.route("**/api/v1/notifications?**", notificationList);
  await page.route("**/api/v1/notifications/read", async (r) => {
    const { id, all } = JSON.parse(r.request().postData() || "{}");
    let changed = 0;
    for (const n of state.notifications) {
      if (!n.read && (all || n.id === id)) { n.read = true; changed += 1; }
    }
    return r.fulfill({ json: { changed, unread: state.notifications.filter((n) => !n.read).length } });
  });
  await page.route("**/api/v1/notifications/config", (r) => r.fulfill({ json: { vapidPublicKey: "", channels: { webpush: true, email: true } } }));
  await page.route("**/api/v1/billing/cancel", async (r) => {
    if (onCancel) return onCancel(r);
    const { resume } = JSON.parse(r.request().postData() || "{}");
    const cancel = !resume;
    Object.assign(state.data.subscription, {
      cancelAtPeriodEnd: cancel, periodEndMeans: cancel ? "ends" : "renews",
    });
    return r.fulfill({ json: {
      cancelAtPeriodEnd: cancel, endsAt: PERIOD_END,
      message: cancel ? "Your Starter plan ends on 12 September 2026." : "Your Starter plan will continue.",
      ...state.data,
    } });
  });
  await page.route("**/api/v1/billing/portal", (r) => r.fulfill({ json: { url: "https://billing.stripe.test/session" } }));
  await page.route("**/api/v1/tokens", async (r) => {
    if (onToken) return onToken(r);
    if (r.request().method() === "GET") return r.fulfill({ json: { tokens: state.data.tokens } });
    const { name } = JSON.parse(r.request().postData() || "{}");
    const record = {
      id: `t${state.data.tokens.length + 1}`, name, prefix: "thrallo_pat_abcd", scopes: ["runs"],
      lastUsedAt: null, revokedAt: null, createdAt: "2026-08-14T09:00:00.000Z",
    };
    state.data.tokens = [record, ...state.data.tokens];
    return r.fulfill({ status: 201, json: { token: "thrallo_pat_abcd1234ef5678901234", record, tokens: state.data.tokens } });
  });
  await page.route(/\/api\/v1\/tokens\/[^/]+$/, async (r) => {
    const id = new URL(r.request().url()).pathname.split("/").pop();
    if (r.request().method() === "DELETE") {
      state.data.tokens = state.data.tokens.map((t) => (t.id === id ? { ...t, revokedAt: "2026-08-14T10:00:00.000Z" } : t));
    } else {
      const { name } = JSON.parse(r.request().postData() || "{}");
      state.data.tokens = state.data.tokens.map((t) => (t.id === id ? { ...t, name } : t));
    }
    return r.fulfill({ json: { tokens: state.data.tokens } });
  });

  // Everything the shell loads behind Settings.
  await page.route("**/api/v1/conversations**", (r) => r.fulfill({ json: {
    conversations: [], counts: { all: 0 }, page: { offset: 0, limit: 20, total: 0, nextOffset: null, tab: "all" }, sorts: [],
  } }));
  await page.route("**/api/v1/conversations/deleted", (r) => r.fulfill({ json: { items: [], recoveryDays: 7 } }));
  await page.route("**/api/v1/publish-state", (r) => r.fulfill({ json: { sites: [] } }));
  await page.route("**/api/v1/billing", (r) => r.fulfill({ json: {
    subscription: state.data.subscription, plans: PLANS, budgets: {}, period: {}, stripeConfigured: true,
  } }));
  await page.route("**/api/v1/usage", (r) => r.fulfill({ json: { plan: state.data.plan, budgets: state.data.budgets, records: [] } }));
  await page.route("**/api/v1/usage/insights", (r) => r.fulfill({ json: { recentRequests: [] } }));
  await page.route(`https://${REF}.supabase.co/**`, (r) => r.fulfill({ json: {} }));
  await page.route(`https://${REF}.supabase.co/auth/v1/user**`, (r) => r.fulfill({ json: SESSION.user }));
  return state;
}

test.skip(!REF, "requires shell/web/.env auth config (skipped in CI)");

const tab = (page, name) => page.getByRole("tab", { name: new RegExp(`^${name}`) });

// ── Getting there ───────────────────────────────────────────────────────────────────────

test("Settings is an address, so Back works and a refresh returns to the same tab", async ({ page }) => {
  await stub(page);
  await page.goto("/");
  await page.locator(".ct-avatar").click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/settings/usage");

  await tab(page, "Billing").click();
  expect(new URL(page.url()).pathname).toBe("/settings/billing");

  await page.reload();
  await expect(tab(page, "Billing")).toHaveAttribute("aria-selected", "true");

  await page.goBack();
  await expect(tab(page, "Usage")).toHaveAttribute("aria-selected", "true");
});

test("arrow keys move between tabs, as the tablist role promises", async ({ page }) => {
  await stub(page);
  await page.goto("/settings/usage");
  await tab(page, "Usage").focus();
  await page.keyboard.press("ArrowRight");
  await expect(tab(page, "Billing")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(tab(page, "Preferences")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Home");
  await expect(tab(page, "Usage")).toHaveAttribute("aria-selected", "true");
});

test("a failed load says so instead of showing an empty account", async ({ page }) => {
  await stub(page);
  await page.route("**/api/v1/settings", (r) => r.fulfill({ status: 500, json: { error: "Settings are unavailable." } }));
  await page.goto("/settings/usage");
  await expect(page.locator(".mg-error")).toContainText("Settings are unavailable");
});

// ── Usage ───────────────────────────────────────────────────────────────────────────────

test("Free usage names the limit, what is left, and when it resets", async ({ page }) => {
  await stub(page, { data: settings({ plan: "free", used: { runs: 5, managedTokens: 300_000, computeSeconds: 1800 } }) });
  await page.goto("/settings/usage");

  const builds = page.locator(".st-meter").filter({ hasText: "Builds" });
  await expect(builds).toContainText("5");
  await expect(builds).toContainText("20");
  // The question is how much is LEFT; making someone subtract is the thing this replaces.
  await expect(builds).toContainText("15 remaining");
  await expect(page.locator(".st-tab")).toContainText("12 September 2026");
  await expect(page.locator(".st-includes")).toContainText("7 days");
});

test("a nearly-spent allowance warns, and a spent one says what happens next", async ({ page }) => {
  await stub(page, { data: settings({ plan: "free", used: { runs: 19 } }) });
  await page.goto("/settings/usage");
  await expect(page.locator(".st-meter-warn")).toContainText("95% used");

  await stub(page, { data: settings({ plan: "free", used: { runs: 20 } }) });
  await page.goto("/settings/usage");
  await expect(page.locator(".st-notice.tone-bad")).toContainText("An allowance is used up");
  await expect(page.locator(".st-notice.tone-bad")).toContainText("12 September 2026");
});

test("Pro shows what Pro includes, not what Free includes", async ({ page }) => {
  await stub(page, { data: settings({ plan: "pro", used: { runs: 100 } }) });
  await page.goto("/settings/usage");
  await expect(page.locator(".st-includes")).toContainText("kept indefinitely");
  await expect(page.locator(".st-includes")).toContainText("Included");
});

test("storage is never invented, because nothing measures it", async ({ page }) => {
  await stub(page);
  await page.goto("/settings/usage");
  await expect(page.locator(".st-tab")).toContainText("does not meter storage");
  // No meter labelled storage, with or without a limit beside it.
  await expect(page.locator(".st-meter").filter({ hasText: /storage/i })).toHaveCount(0);
});

// ── Billing ─────────────────────────────────────────────────────────────────────────────

test("Free is offered upgrades and told there is no billing account yet", async ({ page }) => {
  await stub(page);
  await page.goto("/settings/billing");
  await expect(page.getByRole("button", { name: "Upgrade to Starter" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Upgrade to Pro" })).toBeVisible();
  await expect(page.locator(".st-tab")).toContainText("no billing account yet");
  await expect(page.getByRole("button", { name: "Manage billing" })).toBeDisabled();
});

test("Starter renews, and can go up or down", async ({ page }) => {
  await stub(page, { data: settings({ plan: "starter" }) });
  await page.goto("/settings/billing");
  await expect(page.locator(".st-headline")).toContainText("£20/month");
  await expect(page.locator(".st-headline")).toContainText("Renews 12 September 2026");
  await expect(page.getByRole("button", { name: "Upgrade to Pro" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Downgrade to Free" })).toBeVisible();
  // Said before the click, not after.
  await expect(page.locator(".st-plans")).toContainText("Takes effect immediately, prorated");
  await expect(page.locator(".st-plans")).toContainText("Takes effect at the end of this period");
});

test("a scheduled downgrade is stated, and the current plan is still named", async ({ page }) => {
  await stub(page, { data: settings({
    plan: "pro",
    subscription: { pendingPlan: "starter", pendingPlanName: "Starter", pendingPlanAt: PERIOD_END, periodEndMeans: "changes" },
  }) });
  await page.goto("/settings/billing");
  await expect(page.locator(".st-notice")).toContainText("Moving to Starter on 12 September 2026");
  await expect(page.locator(".st-notice")).toContainText("Until then you keep Pro");
  await expect(page.locator(".st-plan").filter({ hasText: "Starter" })).toContainText("SCHEDULED");
});

test("a plan set to cancel says it ends — never that it renews", async ({ page }) => {
  await stub(page, { data: settings({
    plan: "starter", subscription: { cancelAtPeriodEnd: true, periodEndMeans: "ends" },
  }) });
  await page.goto("/settings/billing");
  await expect(page.locator(".st-headline")).toContainText("Ends 12 September 2026");
  await expect(page.locator(".st-headline")).not.toContainText("Renews");
  await expect(page.locator(".st-notice.tone-warn")).toContainText("set to end");
  // Cancel is not offered twice; the way out is to keep the plan.
  await expect(page.getByRole("button", { name: "Cancel plan" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Keep my plan" })).toBeVisible();
});

test("cancelling asks first, and says exactly what is kept", async ({ page }) => {
  await stub(page, { data: settings({ plan: "starter" }) });
  await page.goto("/settings/billing");
  await page.getByRole("button", { name: "Cancel plan" }).click();

  const dialog = page.getByRole("dialog", { name: /Cancel your Starter plan/ });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("12 September 2026");
  await expect(dialog).toContainText("not deleted");
  // Focus lands on the safe action, so a stray Enter cannot cancel a subscription.
  await expect(page.locator(".st-confirm .ct-btn-quiet")).toBeFocused();

  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("button", { name: "Cancel plan" })).toBeVisible();

  await page.getByRole("button", { name: "Cancel plan" }).click();
  await page.getByRole("button", { name: "Cancel plan", exact: true }).last().click();
  await expect(page.locator(".st-notice.tone-warn")).toContainText("set to end");
});

test("reactivating restores the plan", async ({ page }) => {
  await stub(page, { data: settings({
    plan: "starter", subscription: { cancelAtPeriodEnd: true, periodEndMeans: "ends" },
  }) });
  await page.goto("/settings/billing");
  await page.getByRole("button", { name: "Keep my plan" }).click();
  await expect(page.locator(".st-headline")).toContainText("Renews 12 September 2026");
  await expect(page.locator(".st-notice.tone-warn")).toHaveCount(0);
});

test("a failed payment is stated wherever the customer is looking", async ({ page }) => {
  await stub(page, { data: settings({ plan: "starter", status: "past_due" }) });
  await page.goto("/settings/billing");
  await expect(page.locator(".st-notice.tone-bad")).toContainText("last payment failed");
  await page.goto("/settings/usage");
  await expect(page.locator(".st-notice.tone-warn")).toContainText("could not take your last payment");
});

test("invoices and cards go to Stripe rather than being rebuilt", async ({ page }) => {
  await stub(page, { data: settings({ plan: "starter" }) });
  await page.goto("/settings/billing");
  await expect(page.locator(".st-tab")).toContainText("Invoices, receipts and payment methods");
  await expect(page.locator(".st-tab")).toContainText("Handled by Stripe");
  await expect(page.getByRole("button", { name: "Manage billing" })).toBeEnabled();
});

// ── API keys ────────────────────────────────────────────────────────────────────────────

test("a key is shown once at creation and never again", async ({ page }) => {
  await stub(page);
  await page.goto("/settings/keys");
  await expect(page.locator(".st-empty")).toContainText("No active keys");

  await page.getByLabel("Name this key").fill("Laptop CLI");
  await page.getByRole("button", { name: "Create key" }).click();

  const secret = page.locator(".st-secret");
  await expect(secret).toContainText("thrallo_pat_abcd1234ef5678901234");
  await expect(page.locator(".st-notice")).toContainText("will not be shown again");
  await page.locator(".ct-settings").getByRole("button", { name: "Done" }).last().click();
  await expect(secret).toHaveCount(0);

  // Leaving and returning must not resurrect it — only the prefix survives.
  await tab(page, "Usage").click();
  await tab(page, "API keys").click();
  await expect(page.locator(".st-secret")).toHaveCount(0);
  await expect(page.locator(".st-token")).toContainText("thrallo_pat_abcd…");
  await expect(page.locator(".st-token")).toContainText("runs");
  await expect(page.locator(".st-token")).toContainText("never used");
});

test("renaming keeps the key, and revoking asks first", async ({ page }) => {
  await stub(page, { data: settings({ tokens: [
    { id: "t1", name: "Old name", prefix: "thrallo_pat_wxyz", scopes: ["runs"], lastUsedAt: "2026-08-10T09:00:00.000Z", revokedAt: null, createdAt: "2026-08-01T09:00:00.000Z" },
  ] }) });
  await page.goto("/settings/keys");

  await page.getByRole("button", { name: "Rename" }).click();
  await page.getByLabel("Rename Old name").fill("Desktop");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator(".st-token")).toContainText("Desktop");
  await expect(page.locator(".st-token")).toContainText("thrallo_pat_wxyz…", { timeout: 5000 });

  await page.getByRole("button", { name: "Revoke" }).click();
  const dialog = page.getByRole("dialog", { name: /Revoke/ });
  await expect(dialog).toContainText("stops working immediately");
  await expect(dialog).toContainText("cannot be undone");
  await dialog.getByRole("button", { name: "Revoke key" }).click();

  // Revoked keys stay visible: seeing that the one you were worried about is dead is the point.
  await expect(page.locator(".st-token.is-revoked")).toContainText("Desktop");
  await expect(page.locator(".st-empty")).toContainText("No active keys");
});

test("a key list that failed to load is not reported as having no keys", async ({ page }) => {
  await stub(page, { data: settings({ tokens: null }) });
  await page.goto("/settings/keys");
  await expect(page.locator(".mg-error")).toContainText("does not mean you have none");
});

// ── Notifications ───────────────────────────────────────────────────────────────────────

test("the history, the unread count and the tab badge agree", async ({ page }) => {
  await stub(page, { data: settings({ unread: 2 }) });
  await page.goto("/settings/notifications");
  await expect(page.locator(".st-tab-count")).toHaveText("2");
  await expect(page.locator(".st-unread-pill")).toContainText("2 unread");
  await expect(page.locator(".st-notif")).toHaveCount(3);
  await expect(page.locator(".st-notif.is-unread")).toHaveCount(2);
  // Labelled by what raised it, so a deploy is distinguishable from a domain problem at a glance.
  await expect(page.locator(".st-notif").first()).toContainText("Domain");
});

test("marking one read leaves the rest, and mark-all clears the badge", async ({ page }) => {
  await stub(page, { data: settings({ unread: 2 }) });
  await page.goto("/settings/notifications");
  await page.locator(".st-notif").first().getByRole("button", { name: "Mark read" }).click();
  await expect(page.locator(".st-unread-pill")).toContainText("1 unread");
  await expect(page.locator(".st-notif.is-unread")).toHaveCount(1);
  await expect(page.locator(".st-tab-count")).toHaveText("1");

  await page.getByRole("button", { name: "Mark all read" }).click();
  await expect(page.locator(".st-notif.is-unread")).toHaveCount(0);
  await expect(page.locator(".st-tab-count")).toHaveCount(0);
  await expect(page.locator(".st-unread-pill")).toHaveCount(0);
});

test("an empty history says what would appear here", async ({ page }) => {
  await stub(page, { notifications: [] });
  await page.goto("/settings/notifications");
  await expect(page.locator(".st-empty")).toContainText("Nothing yet");
  await expect(page.locator(".st-empty")).toContainText("custom domain");
});

// ── Preferences ─────────────────────────────────────────────────────────────────────────

test("preferences offer only settings that do something", async ({ page }) => {
  await stub(page);
  await page.goto("/settings/preferences");
  // The email appears in the sheet header too; this asserts the one on the tab.
  await expect(page.locator(".st-headline-plan")).toContainText("e2e@thrallo.com");

  await page.getByRole("button", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Light" }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", "dark");

  // A default-model control would be a promise the product does not keep: model choice is per
  // conversation, in the composer, and there is no account-level default behind it.
  await expect(page.locator(".st-tab")).toContainText("chosen in the composer, per conversation");
  await expect(page.getByLabel(/default model/i)).toHaveCount(0);
});

// ── Layout ──────────────────────────────────────────────────────────────────────────────

test("no tab scrolls the page sideways", async ({ page }) => {
  await stub(page, { data: settings({ plan: "starter", tokens: [
    { id: "t1", name: "A key with quite a long descriptive name on it", prefix: "thrallo_pat_wxyz", scopes: ["runs"], lastUsedAt: null, revokedAt: null, createdAt: "2026-08-01T09:00:00.000Z" },
  ] }) });
  for (const id of ["usage", "billing", "keys", "notifications", "preferences"]) {
    await page.goto(`/settings/${id}`);
    await expect(page.locator(".ct-settings")).toBeVisible();
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${id} overflows`).toBeLessThanOrEqual(1);
  }
});

test("closing returns focus to whatever opened it", async ({ page }) => {
  await stub(page);
  await page.goto("/");
  await page.locator(".ct-avatar").click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await page.locator(".ct-settings").getByRole("button", { name: "Done" }).click();
  await expect(page.locator(".ct-avatar")).toBeFocused();
});
