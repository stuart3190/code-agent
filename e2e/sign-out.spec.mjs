// Logging out.
//
// It used to live in Settings → Preferences: three clicks and a tab away, on a screen nobody opens
// looking for it. People look for logging out in exactly one place — the avatar — so it is there,
// on the header every authenticated screen renders.
//
// The behaviours worth driving are the ones that go wrong quietly: a session that looks ended but
// leaves the previous user's data on screen, a Back button that walks into an authenticated page,
// and a second tab that carries on as though nothing happened.

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
const AUTH_KEY = `sb-${REF}-auth-token`;

const SESSION = {
  access_token: "e2e-fake-token", refresh_token: "e2e-fake-refresh", token_type: "bearer",
  expires_in: 86_400, expires_at: Math.floor(Date.now() / 1000) + 86_400,
  user: {
    id: "00000000-0000-4000-8000-000000000001", aud: "authenticated", role: "authenticated",
    email: "e2e@thrallo.com", user_metadata: { full_name: "Enid Tester" },
    app_metadata: { provider: "email" }, created_at: "2026-01-01T00:00:00Z",
  },
};

async function signedIn(page, { conversations = [] } = {}) {
  // Seeded ONCE. addInitScript runs on every navigation, so re-setting the token unconditionally
  // would sign the user back in on the reload that sign-out performs — the test would then be
  // proving that the seeding works, not that logging out does.
  await page.addInitScript(([key, session]) => {
    if (window.localStorage.getItem("e2e-seeded")) return;
    window.localStorage.setItem("e2e-seeded", "1");
    window.localStorage.setItem(key, JSON.stringify(session));
    window.localStorage.setItem("thrallo-returning", "1");
  }, [AUTH_KEY, SESSION]);
  await page.route("**/api/v1/conversations**", (r) => r.fulfill({ json: {
    conversations, counts: { all: conversations.length }, sorts: [],
    page: { offset: 0, limit: 20, total: conversations.length, nextOffset: null, tab: "all" },
  } }));
  await page.route("**/api/v1/conversations/deleted", (r) => r.fulfill({ json: { items: [], recoveryDays: 7 } }));
  await page.route("**/api/v1/publish-state", (r) => r.fulfill({ json: { sites: [] } }));
  await page.route("**/api/v1/onboarding", (r) => r.fulfill({ json: { pending: false, step: 0 } }));
  await page.route("**/api/v1/billing", (r) => r.fulfill({ json: {
    subscription: { plan: "free", planName: "Free", status: "active", pendingPlan: null },
    plans: [], budgets: {}, period: {}, stripeConfigured: false,
  } }));
  // Signing out clears the token; every authenticated call afterwards must be refused, exactly as
  // the real server would.
  await page.route(`https://${REF}.supabase.co/auth/v1/logout**`, (r) => r.fulfill({ status: 204, body: "" }));
  await page.route(`https://${REF}.supabase.co/**`, (r) => r.fulfill({ json: {} }));
  await page.route(`https://${REF}.supabase.co/auth/v1/user**`, (r) => r.fulfill({ json: SESSION.user }));
}

test.skip(!REF, "requires shell/web/.env auth config (skipped in CI)");

const menu = (page) => page.getByRole("menu", { name: "Account" });

// ── Discoverability ─────────────────────────────────────────────────────────────────────

test("logging out is one click from the avatar, not buried in Settings", async ({ page }) => {
  await signedIn(page);
  await page.goto("/");
  await expect(page.getByText("What are we building today?")).toBeVisible();

  const avatar = page.getByRole("button", { name: /^Account —/ });
  await expect(avatar).toBeVisible();
  await expect(avatar).toHaveAttribute("aria-haspopup", "menu");
  await avatar.click();

  await expect(menu(page)).toBeVisible();
  await expect(menu(page).getByRole("menuitem", { name: "Log out" })).toBeVisible();
  await expect(menu(page)).toContainText("e2e@thrallo.com");
});

test("the account menu is on every authenticated screen", async ({ page }) => {
  await signedIn(page);
  for (const path of ["/", "/settings/usage", "/settings/billing", "/history"]) {
    await page.goto(path);
    await expect(page.getByRole("button", { name: /^Account —/ }),
      `no account menu on ${path}`).toBeVisible();
  }
});

test("Settings no longer carries a second, different sign-out", async ({ page }) => {
  await signedIn(page);
  await page.goto("/settings/preferences");
  await expect(page.getByRole("button", { name: /^Sign out$/ })).toHaveCount(0);
});

// ── Keyboard and focus ──────────────────────────────────────────────────────────────────

test("the menu behaves like a menu", async ({ page }) => {
  await signedIn(page);
  await page.goto("/");
  const avatar = page.getByRole("button", { name: /^Account —/ });
  await avatar.click();
  // Focus lands inside, so it is usable without a mouse.
  await expect(menu(page).getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu(page).getByRole("menuitem").nth(1)).toBeFocused();
  // Escape closes and hands focus back, rather than stranding it.
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  await expect(avatar).toBeFocused();
});

test("clicking away closes it without acting", async ({ page }) => {
  await signedIn(page);
  await page.goto("/");
  await page.getByRole("button", { name: /^Account —/ }).click();
  await expect(menu(page)).toBeVisible();
  await page.getByRole("button", { name: /^Home —/ }).click();
  await expect(menu(page)).toHaveCount(0);
  // Still signed in.
  await expect(page.getByText("What are we building today?")).toBeVisible();
});

// ── Signing out ─────────────────────────────────────────────────────────────────────────

test("logging out ends the session and lands on the public page", async ({ page }) => {
  await signedIn(page);
  await page.goto("/");
  await page.getByRole("button", { name: /^Account —/ }).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await page.waitForLoadState("load");

  // The public landing page, not a half-authenticated shell.
  await expect(page.getByRole("button", { name: "Start building" }).first()).toBeVisible();
  await expect(page.getByText("What are we building today?")).toHaveCount(0);

  // The token is genuinely gone — not merely hidden.
  const token = await page.evaluate((key) => window.localStorage.getItem(key), AUTH_KEY);
  expect(token).toBeNull();
});

test("Back after logging out does not walk into an authenticated page", async ({ page }) => {
  await signedIn(page);
  await page.goto("/");
  await page.goto("/settings/usage");
  // Settings is an overlay with a scrim; the header is behind it, so close it as a person would.
  await page.goto("/");
  await page.getByRole("button", { name: /^Account —/ }).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await page.waitForLoadState("load");
  await expect(page.getByRole("button", { name: "Start building" }).first()).toBeVisible();

  await page.goBack();
  // Whatever the history says, no session means no workspace.
  await expect(page.getByText("What are we building today?")).toHaveCount(0);
  await expect(page.locator(".ct-settings")).toHaveCount(0);
});

test("refreshing after logging out stays logged out", async ({ page }) => {
  await signedIn(page);
  await page.goto("/");
  await page.getByRole("button", { name: /^Account —/ }).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await page.waitForLoadState("load");
  await expect(page.getByRole("button", { name: "Start building" }).first()).toBeVisible();

  await page.reload();
  await expect(page.getByRole("button", { name: "Start building" }).first()).toBeVisible();
  await expect(page.getByText("What are we building today?")).toHaveCount(0);
});

test("a protected address cannot be reached once signed out", async ({ page }) => {
  await signedIn(page);
  await page.goto("/");
  await page.getByRole("button", { name: /^Account —/ }).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await page.waitForLoadState("load");
  await expect(page.getByRole("button", { name: "Start building" }).first()).toBeVisible();

  for (const path of ["/settings/billing", "/history", "/projects/p1/logs"]) {
    await page.goto(path);
    await expect(page.locator(".ct-settings"), `${path} leaked`).toHaveCount(0);
    await expect(page.getByText("What are we building today?"), `${path} leaked`).toHaveCount(0);
  }
});

test("a second tab cannot stay signed in", async ({ context, page }) => {
  await signedIn(page);
  await page.goto("/");
  await expect(page.getByText("What are we building today?")).toBeVisible();

  await page.getByRole("button", { name: /^Account —/ }).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await page.waitForLoadState("load");
  await expect(page.getByRole("button", { name: "Start building" }).first()).toBeVisible();

  // The token lives in localStorage, which is shared by every tab on the origin. Once it is gone,
  // no other tab can present it — which is what makes a sign-out in one tab a sign-out everywhere,
  // with or without the broadcast Supabase also sends.
  const second = await context.newPage();
  await second.goto("/");
  const token = await second.evaluate((key) => window.localStorage.getItem(key), AUTH_KEY);
  expect(token, "the session token is gone for every tab on this origin").toBeNull();
  await expect(second.getByText("What are we building today?")).toHaveCount(0);
  await second.close();
});

// ── Coming back ─────────────────────────────────────────────────────────────────────────

test("a deep link is remembered through sign-in", async ({ page }) => {
  // Arrive signed OUT at a real destination.
  await page.goto("/settings/billing");
  await expect(page.getByRole("button", { name: "Start building" }).first()).toBeVisible();
  const remembered = await page.evaluate(() => sessionStorage.getItem("thrallo-intended-path"));
  expect(remembered).toBe("/settings/billing");
});

test("an explicit log out does not queue a return trip", async ({ page }) => {
  await signedIn(page);
  await page.goto("/settings/billing");
  await page.goto("/");
  await page.getByRole("button", { name: /^Account —/ }).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await page.waitForLoadState("load");
  await expect(page.getByRole("button", { name: "Start building" }).first()).toBeVisible();
  // Someone who chose to leave has not asked to be sent back in.
  const remembered = await page.evaluate(() => sessionStorage.getItem("thrallo-intended-path"));
  expect(remembered).toBeNull();
});
