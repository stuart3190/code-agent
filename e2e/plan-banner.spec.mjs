// The Free-plan upgrade banner and the /pricing page.
//
// The point of the banner is that a Free user cannot miss it and a paying user never sees it.
// Both halves are asserted here, along with the scheduled-downgrade variant, because "shows for
// everyone" and "shows for nobody" are the two ways this feature fails silently.
//
// Same harness as chat-shell.spec.mjs: a fake Supabase session in localStorage and stubbed APIs,
// so no live account or Stripe call is involved. Skips in CI where the auth config is absent.

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

const PLANS = [
  { id: "free", name: "Free", description: "Evaluate Thrallo.", priceGbp: 0, priceApproved: true,
    monthly: { runs: 20, managedTokens: 1_500_000, computeSeconds: 10_800 } },
  { id: "starter", name: "Starter", description: "Daily agent work for an individual engineer.", priceGbp: 19, priceApproved: true,
    monthly: { runs: 200, managedTokens: 20_000_000, computeSeconds: 108_000 } },
  { id: "pro", name: "Pro", description: "Heavy multi-repository automation.", priceGbp: 49, priceApproved: true,
    monthly: { runs: 1_000, managedTokens: 100_000_000, computeSeconds: 432_000 } },
];

const budgets = {
  runs: { used: 3, limit: 20 },
  managedTokens: { used: 100, limit: 1_500_000 },
  computeSeconds: { used: 60, limit: 10_800 },
};

function billingPayload(subscription) {
  return {
    subscription, plans: PLANS, stripeConfigured: true, budgets,
    period: { start: "2026-08-01T00:00:00Z", end: "2026-09-01T00:00:00Z" },
  };
}

const FREE = { plan: "free", planName: "Free", status: "active", stripeManaged: false, currentPeriodEnd: null, pendingPlan: null, pendingPlanName: null, pendingPlanAt: null, overrides: {} };
const PRO = { plan: "pro", planName: "Pro", status: "active", stripeManaged: true, currentPeriodEnd: "2026-09-01T00:00:00Z", pendingPlan: null, pendingPlanName: null, pendingPlanAt: null, overrides: {} };
const PRO_DOWNGRADING = { ...PRO, pendingPlan: "starter", pendingPlanName: "Starter", pendingPlanAt: "2026-09-01T00:00:00Z" };

async function stub(page, subscription, { onPlanSelect = null, onPortal = null } = {}) {
  await page.addInitScript(([key, session]) => {
    window.localStorage.setItem(key, JSON.stringify(session));
  }, [`sb-${REF}-auth-token`, SESSION]);
  await page.route("**/api/v1/conversations", (r) => r.fulfill({ json: { conversations: [] } }));
  await page.route("**/api/v1/conversations/deleted", (r) => r.fulfill({ json: { items: [], recoveryDays: 7 } }));
  await page.route("**/api/v1/billing/plan", (r) => {
    const body = JSON.parse(r.request().postData() || "{}");
    return onPlanSelect ? onPlanSelect(r, body) : r.fulfill({ json: { url: "https://checkout.stripe.com/c/pay/stub" } });
  });
  await page.route("**/api/v1/billing/portal", (r) => (onPortal ? onPortal(r) : r.fulfill({ json: { url: "https://billing.stripe.com/p/session/stub" } })));
  await page.route("**/api/v1/usage", (r) => r.fulfill({ json: {
    plan: { id: subscription.plan, name: subscription.planName },
    budgets: { managedTokens: { limit: 1_500_000, remaining: 1_400_000 } },
  } }));
  await page.route("**/api/v1/billing", (r) => r.fulfill({ json: billingPayload(subscription) }));
  await page.route(`https://${REF}.supabase.co/**`, (r) => r.fulfill({ json: {} }));
  await page.route(`https://${REF}.supabase.co/auth/v1/user**`, (r) => r.fulfill({ json: SESSION.user }));
}

test.skip(!REF, "requires shell/web/.env auth config (skipped in CI)");

test("a Free account sees the upgrade banner", async ({ page }) => {
  await stub(page, FREE);
  await page.goto("/");
  const banner = page.locator(".ct-planbar");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("You're currently on the Free plan");
  await expect(banner.getByRole("button", { name: "Upgrade Now" })).toBeVisible();
});

test("a paying account sees no banner at all", async ({ page }) => {
  await stub(page, PRO);
  await page.goto("/");
  // Wait for billing to have loaded, so this is "absent", not "not yet rendered".
  await expect(page.locator(".ct-begin")).toBeVisible();
  await page.waitForResponse((r) => r.url().includes("/api/v1/billing"));
  await expect(page.locator(".ct-planbar")).toHaveCount(0);
});

test("a scheduled downgrade shows an information banner with Keep Current Plan", async ({ page }) => {
  await stub(page, PRO_DOWNGRADING, {
    onPlanSelect: (route, body) => {
      expect(body.plan).toBe("pro");     // keeping the CURRENT plan cancels the change
      return route.fulfill({ json: { ...billingPayload(PRO), planChange: { applied: "pending_change_cancelled", message: "Your scheduled change was cancelled. You stay on Pro." } } });
    },
  });
  await page.goto("/");
  const banner = page.locator(".ct-planbar.info");
  await expect(banner).toContainText("Your plan changes to");
  await expect(banner).toContainText("Starter");
  await banner.getByRole("button", { name: "Keep Current Plan" }).click();
  await expect(banner).toContainText("scheduled change was cancelled");
});

test("Upgrade Now opens /pricing, which offers Starter and Pro only", async ({ page }) => {
  await stub(page, FREE);
  await page.goto("/");
  await page.locator(".ct-planbar").getByRole("button", { name: "Upgrade Now" }).click();

  await expect(page).toHaveURL(/\/pricing$/);
  const cards = page.locator(".ct-pricecard");
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText("Starter");
  await expect(cards.nth(0)).toContainText("£19");
  await expect(cards.nth(1)).toContainText("Pro");
  await expect(cards.nth(1)).toContainText("£49");
  // Free is never offered for purchase, and no unsold tier appears.
  await expect(page.locator(".ct-pricing")).not.toContainText("Business");
  await expect(cards.nth(0)).toContainText("200 builds a month");
  await expect(cards.nth(0)).toContainText("30 hours of sandbox compute");
  await expect(cards.nth(1)).toContainText("1,000 builds a month");
  await expect(cards.nth(1)).toContainText("120 hours of sandbox compute");
});

test("Choose Plan starts Stripe Checkout for the plan that was clicked", async ({ page }) => {
  let requested = null;
  await stub(page, FREE, {
    onPlanSelect: (route, body) => {
      requested = body.plan;
      return route.fulfill({ json: { url: "https://checkout.stripe.com/c/pay/stub" } });
    },
  });
  // Stop the browser actually leaving for Stripe.
  await page.route("https://checkout.stripe.com/**", (r) =>
    r.fulfill({ contentType: "text/html", body: "<!doctype html><title>stub checkout</title>" }));

  await page.goto("/pricing");
  await page.locator(".ct-pricecard").filter({ hasText: "Pro" }).getByRole("button", { name: "Choose Plan" }).click();
  await page.waitForURL(/checkout\.stripe\.com/);
  expect(requested).toBe("pro");
});

test("the pricing page is reachable directly and back returns to the dashboard", async ({ page }) => {
  await stub(page, FREE);
  await page.goto("/pricing");
  await expect(page.locator(".ct-pricecard")).toHaveCount(2);
  await page.getByRole("button", { name: "Back to your projects" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator(".ct-begin")).toBeVisible();
});

test("the current plan cannot be repurchased from the pricing page", async ({ page }) => {
  await stub(page, PRO);
  await page.goto("/pricing");
  const proCard = page.locator(".ct-pricecard").filter({ hasText: "Pro" });
  await expect(proCard.getByRole("button", { name: "Current Plan" })).toBeDisabled();
  // Moving down is offered, and named honestly.
  await expect(page.locator(".ct-pricecard").filter({ hasText: "Starter" })
    .getByRole("button", { name: "Downgrade" })).toBeEnabled();
});

// ── Settings → Billing ──────────────────────────────────────────────────────────────────

const openSettings = async (page) => {
  await page.goto("/");
  await page.locator(".ct-avatar").click();
  await expect(page.locator(".ct-sheet.show")).toBeVisible();
};

test("Settings → Billing offers a Free account an upgrade", async ({ page }) => {
  await stub(page, FREE);
  await openSettings(page);

  const billing = page.locator(".ct-set-group").filter({ hasText: "Billing" });
  await expect(billing).toContainText("Free plan");
  await expect(billing).toContainText("No payment details held");
  // A Free account has no subscription to manage, so the portal must not be offered.
  await expect(billing.getByRole("button", { name: "Manage Subscription" })).toHaveCount(0);

  await billing.getByRole("button", { name: "Upgrade" }).click();
  await expect(page).toHaveURL(/\/pricing$/);
  await expect(page.locator(".ct-sheet.show")).toHaveCount(0);   // the sheet gets out of the way
  await expect(page.locator(".ct-pricecard")).toHaveCount(2);
});

test("Settings → Billing shows a paid account its plan, renewal and status", async ({ page }) => {
  await stub(page, PRO);
  await openSettings(page);

  const billing = page.locator(".ct-set-group").filter({ hasText: "Billing" });
  await expect(billing).toContainText("Pro plan");
  await expect(billing).toContainText("Renews 1 September 2026");
  await expect(billing).toContainText("Active");
  await expect(billing.getByRole("button", { name: "Upgrade" })).toHaveCount(0);
});

test("Manage Subscription opens the Stripe Customer Portal", async ({ page }) => {
  let called = false;
  await stub(page, PRO, { onPortal: (route) => {
    called = true;
    return route.fulfill({ json: { url: "https://billing.stripe.com/p/session/stub" } });
  } });
  await page.route("https://billing.stripe.com/**", (r) =>
    r.fulfill({ contentType: "text/html", body: "<!doctype html><title>stub portal</title>" }));

  await openSettings(page);
  await page.locator(".ct-set-group").filter({ hasText: "Billing" })
    .getByRole("button", { name: "Manage Subscription" }).click();

  await page.waitForURL(/billing\.stripe\.com/);
  expect(called).toBe(true);
});

test("a scheduled downgrade is stated in Settings, not just on the dashboard", async ({ page }) => {
  await stub(page, PRO_DOWNGRADING);
  await openSettings(page);
  const billing = page.locator(".ct-set-group").filter({ hasText: "Billing" });
  await expect(billing).toContainText("Changes to Starter on 1 September 2026");
});

test("an overdue payment says so plainly and points at the fix", async ({ page }) => {
  await stub(page, { ...PRO, status: "past_due" });
  await openSettings(page);
  const billing = page.locator(".ct-set-group").filter({ hasText: "Billing" });
  await expect(billing).toContainText("Payment overdue");
  await expect(billing).toContainText("Update your card");
});

// ── Pricing page polish ─────────────────────────────────────────────────────────────────

const STARTER_SUB = { plan: "starter", planName: "Starter", status: "active", stripeManaged: true, currentPeriodEnd: "2026-09-01T00:00:00Z", pendingPlan: null, pendingPlanName: null, pendingPlanAt: null, overrides: {} };

test("the pricing page states the current plan up front", async ({ page }) => {
  await stub(page, FREE);
  await page.goto("/pricing");
  await expect(page.locator(".ct-pricing-current")).toContainText("Current Plan: Free");
});

test("Pro is marked Most Popular and visually accented", async ({ page }) => {
  await stub(page, FREE);
  await page.goto("/pricing");
  const pro = page.locator(".ct-pricecard").filter({ hasText: "Pro" });
  await expect(pro.locator(".ct-pricecard-badge")).toHaveText("Most Popular");
  await expect(pro).toHaveClass(/featured/);
  // Only one plan is highlighted, or the accent means nothing.
  await expect(page.locator(".ct-pricecard.featured")).toHaveCount(1);
});

test("a Starter subscriber is offered Upgrade on Pro and cannot rebuy Starter", async ({ page }) => {
  await stub(page, STARTER_SUB);
  await page.goto("/pricing");
  await expect(page.locator(".ct-pricing-current")).toContainText("Current Plan: Starter");

  const starter = page.locator(".ct-pricecard").filter({ hasText: "Starter" });
  const pro = page.locator(".ct-pricecard").filter({ hasText: "Pro" });
  await expect(starter.getByRole("button", { name: "Current Plan" })).toBeDisabled();
  await expect(pro.getByRole("button", { name: "Upgrade" })).toBeEnabled();
});

test("a Pro subscriber is offered Downgrade on Starter and cannot rebuy Pro", async ({ page }) => {
  await stub(page, PRO);
  await page.goto("/pricing");
  const starter = page.locator(".ct-pricecard").filter({ hasText: "Starter" });
  const pro = page.locator(".ct-pricecard").filter({ hasText: "Pro" });
  await expect(pro.getByRole("button", { name: "Current Plan" })).toBeDisabled();
  await expect(starter.getByRole("button", { name: "Downgrade" })).toBeEnabled();
});

test("the comparison table lists all three limits for both plans", async ({ page }) => {
  await stub(page, FREE);
  await page.goto("/pricing");
  const table = page.locator(".ct-compare-table");
  await expect(table.locator("thead th")).toHaveCount(3);           // label + 2 plans
  for (const row of ["Builds per month", "Managed AI tokens", "Sandbox compute"]) {
    await expect(table.locator("tbody tr").filter({ hasText: row })).toHaveCount(1);
  }
  const builds = table.locator("tbody tr").filter({ hasText: "Builds per month" });
  await expect(builds.locator("td").nth(0)).toHaveText("200");
  await expect(builds.locator("td").nth(1)).toHaveText("1,000");
});

test("a scheduled downgrade is explained on the pricing page, without a redundant upgrade prompt", async ({ page }) => {
  await stub(page, PRO_DOWNGRADING);
  await page.goto("/pricing");
  const banner = page.locator(".ct-planbar.info");
  await expect(banner).toContainText("Starter");
  await expect(banner).toContainText("1 September");
  await expect(banner.getByRole("button", { name: "Keep Current Plan" })).toBeVisible();
});

test("the Free upgrade prompt does not appear on the pricing page itself", async ({ page }) => {
  await stub(page, FREE);
  await page.goto("/pricing");
  await expect(page.locator(".ct-pricecard")).toHaveCount(2);
  // Pointing "Upgrade Now" at the page you are already on is noise.
  await expect(page.locator(".ct-planbar")).toHaveCount(0);
});

// ── Post-payment success screen ─────────────────────────────────────────────────────────

test("returning from Stripe confirms activation, the plan and the new limits", async ({ page }) => {
  await stub(page, STARTER_SUB);
  await page.goto("/?billing=success");

  await expect(page.getByText("Subscription activated")).toBeVisible();
  await expect(page.locator(".ct-success")).toContainText("Starter");
  await expect(page.locator(".ct-success")).toContainText("£19 a month");
  const limits = page.locator(".ct-success-limits");
  await expect(limits).toContainText("200");
  await expect(limits).toContainText("20M");
  await expect(limits).toContainText("30h");

  await page.getByRole("button", { name: "Return to dashboard" }).click();
  await expect(page.locator(".ct-begin")).toBeVisible();
  // The query string is cleared, so a refresh does not replay the confirmation.
  await expect(page).toHaveURL(/\/$/);
});

test("the success screen waits for the webhook rather than reporting Free", async ({ page }) => {
  // Stripe redirects the instant the card clears; the webhook lands a beat later. The first reads
  // still say Free — showing that to someone who has just paid is the worst possible moment.
  let reads = 0;
  await stub(page, FREE);
  // Registered AFTER stub(), because Playwright matches the LAST-registered route first.
  await page.route("**/api/v1/billing", (r) => {
    reads += 1;
    return r.fulfill({ json: billingPayload(reads < 3 ? FREE : STARTER_SUB) });
  });
  await page.goto("/?billing=success");

  await expect(page.getByText("Confirming your payment…")).toBeVisible();
  await expect(page.getByText("Subscription activated")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".ct-success")).toContainText("Starter");
});

test("an abandoned checkout lands on the dashboard with the URL cleaned up", async ({ page }) => {
  await stub(page, FREE);
  await page.goto("/?billing=cancelled");
  await expect(page.locator(".ct-begin")).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  // The Free banner is still the right thing to show — they did not buy anything.
  await expect(page.locator(".ct-planbar")).toBeVisible();
});
