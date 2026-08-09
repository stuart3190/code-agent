import { mkdirSync } from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";

const evidenceDirectory = path.resolve("evidence/c2/screenshots");
const capture = async (page, name) => {
  mkdirSync(evidenceDirectory, { recursive: true });
  await page.screenshot({ path: path.join(evidenceDirectory, `${name}.png`), fullPage: true, animations: "disabled" });
};

test("@visual captures actual C2 hardened shell states", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("chromium"), "C2 screenshots are captured once in Chromium");
  await page.goto("/");
  await capture(page, "01-normal-desktop");
  await page.getByLabel("Fixture scenario").selectOption("several-apps");
  await capture(page, "02-overlapping-windows");
  const files = page.locator("[data-application-window='files']");
  await files.getByLabel("Arrange Files").click();
  await files.getByRole("menuitem", { name: "Snap left" }).click();
  await capture(page, "03-left-snap");
  await files.getByLabel("Arrange Files").click();
  await files.getByRole("menuitem", { name: "Snap right" }).click();
  await capture(page, "04-right-snap");
  await files.getByLabel("Restore Files").click();
  await files.getByLabel("Maximize Files").click();
  await capture(page, "05-maximized-app");
  await page.locator("[data-launcher-button]").click();
  await capture(page, "06-launcher-and-window");
  await page.keyboard.press("Escape");
  await page.getByLabel("Fixture scenario").selectOption("workspace-waking");
  await capture(page, "07-workspace-waking");
  await page.getByLabel("Fixture scenario").selectOption("workspace-reconnecting");
  await capture(page, "08-workspace-reconnecting");
  await page.getByLabel("Fixture scenario").selectOption("normal-active");
  await page.setViewportSize({ width: 834, height: 1112 });
  await capture(page, "09-tablet-portrait");
  await page.setViewportSize({ width: 1112, height: 834 });
  await capture(page, "10-tablet-landscape");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("[data-launcher-button]").click();
  await capture(page, "11-mobile-app-switcher");
  await page.setViewportSize({ width: 720, height: 512 });
  await capture(page, "12-zoom-200-percent");
  await page.setViewportSize({ width: 1440, height: 1024 });
  await page.getByLabel("Fixture scenario").selectOption("dark-compatibility");
  await capture(page, "13-dark-theme-compatibility");
});
