import { expect, test } from "@playwright/test";

test("serves the neutral C0 prototype without external requests", async ({ page }) => {
  const requests = [];
  page.on("request", (request) => requests.push(request.url()));

  const response = await page.goto("/");

  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Thrallo Cloud Desktop prototype" })).toBeVisible();
  await expect(page.locator("main[data-provider-kind='fixture']")).toHaveCount(1);
  await expect(page.locator("[data-desktop-shell], [data-taskbar], [data-application-window]")).toHaveCount(0);

  for (const requestUrl of requests) {
    const url = new URL(requestUrl);
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.port).toBe("4174");
  }
});
