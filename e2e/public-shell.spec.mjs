import { expect, test } from "@playwright/test";

test("Thrallo landing page is usable without horizontal overflow", async ({ page }) => {
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") browserErrors.push(message.text()); });
  await page.goto("/");
  await expect(page).toHaveTitle(/Thrallo/i);
  await expect(page.getByRole("heading", { name: /Software that builds/i }), browserErrors.join("\n")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  const createAccount = page.getByRole("button", { name: /Create Thrallo account/i });
  await expect(createAccount).toBeVisible();
  const setupWarning = page.getByText(/Authentication setup required/i);
  if (await setupWarning.count()) {
    await expect(createAccount).toBeDisabled();
  } else {
    await expect(createAccount).toBeEnabled();
  }
  await expect(page.getByText(/From issue to verified patch/i)).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  expect(browserErrors).toEqual([]);
});

test("public shell sends hardened headers and reports runtime setup honestly", async ({ request }) => {
  const page = await request.get("/");
  expect(page.ok()).toBeTruthy();
  expect(page.headers()["x-content-type-options"]).toBe("nosniff");
  expect(page.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");

  const response = await request.get("/api/v1/capabilities");
  expect(response.ok()).toBeTruthy();
  const capability = await response.json();
  expect(capability).toMatchObject({
    product: "Thrallo",
    apiVersion: "v1",
    runner: { id: "daytona" },
  });
  expect(typeof capability.runner.configured).toBe("boolean");
  expect(typeof capability.controlPlane.configured).toBe("boolean");
  expect(capability.ready).toBe(
    capability.controlPlane.configured
      && capability.runner.configured
      && capability.models.some((model) => model.configured),
  );
});
