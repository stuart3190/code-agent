// Coming back from Stripe.
//
// The defect this pins: the billing return was handled inside the authenticated workspace, below
// `if (!user) return <Landing />`. Stripe's return is a NAVIGATION, not a session — it arrives in
// whatever browser finished checkout, which is routinely not the one holding the session. A
// customer who had just paid real money was shown the public marketing page, with the payment
// unmentioned. That reads as failure.
//
// Both states are driven here, because they are different screens with different jobs: signed out
// has to say the payment landed and offer sign-IN; signed in has to celebrate and refresh the plan.

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

async function signedIn(page) {
  await page.addInitScript(([key, session]) => {
    window.localStorage.setItem(key, JSON.stringify(session));
    window.localStorage.setItem("thrallo-returning", "1");
  }, [`sb-${REF}-auth-token`, SESSION]);
  await page.route("**/api/v1/conversations**", (r) => r.fulfill({ json: {
    conversations: [], counts: { all: 0 }, sorts: [],
    page: { offset: 0, limit: 20, total: 0, nextOffset: null, tab: "all" },
  } }));
  await page.route("**/api/v1/conversations/deleted", (r) => r.fulfill({ json: { items: [], recoveryDays: 7 } }));
  await page.route("**/api/v1/publish-state", (r) => r.fulfill({ json: { sites: [] } }));
  await page.route("**/api/v1/onboarding", (r) => r.fulfill({ json: { pending: false, step: 0 } }));
  await page.route("**/api/v1/billing", (r) => r.fulfill({ json: {
    subscription: { plan: "starter", planName: "Starter", status: "active", pendingPlan: null },
    // A real catalogue: the success view only claims activation once it can name the plan and its
    // limits, so an empty catalogue leaves it on "Confirming your payment…" — correct behaviour,
    // and the wrong precondition for this test.
    plans: [{ id: "starter", name: "Starter", priceGbp: 19, priceApproved: true,
      monthly: { runs: 200, managedTokens: 20000000, computeSeconds: 108000 } }],
    budgets: {}, period: {}, stripeConfigured: true,
  } }));
  await page.route(`https://${REF}.supabase.co/**`, (r) => r.fulfill({ json: {} }));
  await page.route(`https://${REF}.supabase.co/auth/v1/user**`, (r) => r.fulfill({ json: SESSION.user }));
}

test.skip(!REF, "requires shell/web/.env auth config (skipped in CI)");

// ── Signed out: the state that used to show a marketing page ────────────────────────────

for (const path of ["/billing-success", "/?billing=success"]) {
  test(`signed out, ${path} says the payment landed`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByText("Payment received.")).toBeVisible();
    await expect(page.getByText(/subscription is active/i)).toBeVisible();
    // Sign IN, not sign up — they already have an account; they just paid for it. Scoped to the
    // auth card, because the header carries its own Sign in button.
    await expect(page.getByRole("heading", { name: /Welcome back/i })).toBeVisible();
  });
}

test("signed out, an ordinary visit shows no payment banner", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Payment received.")).toHaveCount(0);
  // And the page still works as a landing page.
  await expect(page.getByRole("button", { name: "Start building" }).first()).toBeVisible();
});

test("signed out, a cancelled return does not claim a payment", async ({ page }) => {
  await page.goto("/?billing=cancelled");
  await expect(page.getByText("Payment received.")).toHaveCount(0);
});

// ── Signed in: the celebration, and that it clears ──────────────────────────────────────

test("signed in, the success view appears and then gets out of the way", async ({ page }) => {
  await signedIn(page);
  await page.goto("/?billing=success");
  // The authenticated success screen, not the landing banner.
  await expect(page.getByText("Payment received.")).toHaveCount(0);
  // It polls the real billing endpoint before claiming anything: "Stripe redirected me" is not
  // proof a subscription exists, so the screen waits for Thrallo to confirm it.
  await expect(page.getByRole("heading", { name: "Subscription activated" })).toBeVisible();

  // Dismissing returns to the workspace.
  await page.getByRole("button", { name: "Return to dashboard" }).click();
  await expect(page.getByText("What are we building today?")).toBeVisible();
});

test("signed in, /billing-success is the same destination as ?billing=success", async ({ page }) => {
  await signedIn(page);
  await page.goto("/billing-success");
  // Whatever renders, it must NOT be the signed-out landing page — that was the bug.
  await expect(page.getByText("Payment received.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start building" })).toHaveCount(0);
});
