import { expect, test } from "@playwright/test";

test("serves the isolated C1 cloud desktop without external requests", async ({ page }) => {
  const requests = [];
  const browserErrors = [];
  page.on("request", (request) => requests.push(request.url()));
  page.on("console", (message) => { if (message.type() === "error") browserErrors.push(message.text()); });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  const response = await page.goto("/");

  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Thrallo Cloud Desktop prototype" })).toBeVisible();
  await expect(page.locator("main[data-provider-kind='fixture']")).toHaveCount(1);
  await expect(page.locator("[data-desktop-shell]")).toHaveCount(1);
  await expect(page.locator("[data-taskbar]")).toHaveCount(1);
  await expect(page.locator("[data-application-window='browser']")).toBeVisible();
  const desktopBackground = await page.locator(".desktop-canvas").evaluate((element) => getComputedStyle(element).backgroundImage);
  expect(desktopBackground).toContain("thrallo-cloud-workspace-background.png");

  for (const requestUrl of requests) {
    const url = new URL(requestUrl);
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.port).toBe("4174");
  }
  expect(browserErrors).toEqual([]);
});
