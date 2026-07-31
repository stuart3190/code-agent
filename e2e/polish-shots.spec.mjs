// Visual verification for the polish pass — not assertions, screenshots for review.
// Run explicitly: npx playwright test e2e/polish-shots.spec.mjs (skipped without SHOTS=1).

import { test, expect } from "@playwright/test";

const SHOTS = process.env.SHOTS === "1";
const OUT = process.env.SHOTS_DIR || "test-results/shots";

test.skip(!SHOTS, "screenshot pass only");

test("polish screenshots", async ({ page }, testInfo) => {
  const { default: helpers } = await import("./chat-shell.spec.mjs").catch(() => ({ default: null }));
  void helpers; void expect; void testInfo;
  // Reuse the same stub wiring inline (spec exports nothing).
  const REF = new URL((await import("node:fs/promises").then((fs) => fs.readFile("shell/web/.env", "utf8")))
    .match(/VITE_SUPABASE_URL=(\S+)/)[1]).hostname.split(".")[0];
  const SESSION = {
    access_token: "e2e-token", token_type: "bearer", expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: "e2e-refresh", user: { id: "u-e2e", email: "e2e@thrallo.com", user_metadata: { full_name: "Enid Tester" } },
  };
  await page.addInitScript(([key, session]) => {
    window.localStorage.setItem(key, JSON.stringify(session));
    window.localStorage.setItem("thrallo-returning", "1");
  }, [`sb-${REF}-auth-token`, SESSION]);
  await page.route(`https://${REF}.supabase.co/**`, (route) => route.fulfill({ json: {} }));
  await page.route(`https://${REF}.supabase.co/auth/v1/user**`, (route) => route.fulfill({ json: SESSION.user }));
  await page.route("**/api/v1/conversations", (route) => route.fulfill({ json: { conversations: [
    { id: "c1", title: "FocusFlow", state: "idle", hasPreview: true, verified: true },
    { id: "c2", title: "Orbit CRM", activity: { agent: "Builder", status: "Writing the checkout flow…" } },
  ] } }));
  await page.route("**/api/v1/conversations/deleted", (route) => route.fulfill({ json: { items: [
    { id: "c9", title: "Old prototype", deletedAt: new Date().toISOString(), daysRemaining: 6 },
  ], recoveryDays: 7 } }));

  await page.goto("/");
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/p1-home.png` });

  await page.getByRole("button", { name: /Recently Deleted/ }).click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/p2-recently-deleted.png` });

  await page.locator(".ct-pdelete").first().click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/p3-delete-modal.png` });
  await page.keyboard.press("Escape");

  await page.keyboard.press("Control+k");
  await page.getByPlaceholder(/Type a command/).press("ArrowDown");
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/p4-palette-kb.png` });
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "E", exact: true }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/p5-settings.png` });
});
