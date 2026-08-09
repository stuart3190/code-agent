import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

const evidenceDirectory = path.resolve("evidence/c1/screenshots");

async function setScenario(page, scenarioId) {
  await page.getByLabel("Fixture scenario").selectOption(scenarioId);
  await page.waitForTimeout(120);
}

async function capture(page, name) {
  mkdirSync(evidenceDirectory, { recursive: true });
  await page.screenshot({ path: path.join(evidenceDirectory, `${name}.png`), fullPage: true, animations: "disabled" });
}

test("@visual captures all required browser-rendered C1 review states", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("chromium"), "C1 screenshots are captured once in Chromium");
  await page.goto("/");

  await setScenario(page, "first-launch");
  await capture(page, "01-first-launch");

  await setScenario(page, "normal-active");
  await capture(page, "02-normal-desktop");

  await setScenario(page, "several-apps");
  await capture(page, "03-multiple-overlapping-windows");

  await page.locator("[data-launcher-button]").click();
  await capture(page, "04-launcher-open");
  await page.keyboard.press("Escape");

  await page.locator("[data-taskbar-app='thrallo']").click();
  await capture(page, "05-thrallo-placeholder");
  await page.locator("[data-taskbar-app='browser']").click();
  await capture(page, "06-browser-app");
  await page.locator("[data-taskbar-app='files']").click();
  await capture(page, "07-files-app");
  await page.locator("[data-taskbar-app='terminal']").click();
  await capture(page, "08-terminal-app");
  await page.locator("[data-taskbar-app='github']").click();
  await capture(page, "09-github-app");

  await setScenario(page, "storage-warning");
  await capture(page, "10-storage-warning");
  await page.locator("[data-taskbar-app='settings']").click();
  await capture(page, "11-settings-app");

  await page.setViewportSize({ width: 834, height: 1112 });
  await setScenario(page, "normal-active");
  await capture(page, "12-tablet-portrait");

  await page.setViewportSize({ width: 1112, height: 834 });
  await capture(page, "13-tablet-landscape");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("[data-launcher-button]").click();
  await capture(page, "14-mobile-app-switcher");

  await page.setViewportSize({ width: 1440, height: 1024 });
  await setScenario(page, "dark-compatibility");
  await capture(page, "15-dark-theme-compatibility");

  await expect(page.locator("[data-theme='dark']")).toBeVisible();
});
