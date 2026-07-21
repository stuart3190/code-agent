import { expect, test } from "@playwright/test";

test("landing page is usable without horizontal overflow", async ({ page }) => {
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") browserErrors.push(message.text()); });
  await page.goto("/");
  await expect(page).toHaveTitle(/Buildr101/i);
  await expect(page.getByRole("heading", { name: /Describe an app/i }), browserErrors.join("\n")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("public shell sends hardened headers and a healthy dependency report", async ({ request }) => {
  const page = await request.get("/");
  expect(page.ok()).toBeTruthy();
  expect(page.headers()["x-content-type-options"]).toBe("nosniff");
  expect(page.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");

  const health = await request.get("/api/health");
  expect(health.ok()).toBeTruthy();
  expect(await health.json()).toMatchObject({ ok: true, supabase: true });
});
