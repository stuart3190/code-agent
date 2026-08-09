import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const evidence = "evidence/c3/screenshots";
async function capture(page, name) { await mkdir(evidence, { recursive: true }); await page.screenshot({ path: `${evidence}/${name}.png`, fullPage: true }); }
async function filesScenario(page, scenario = "normal-files") {
  await page.goto(`/?filesScenario=${scenario}`);
  await page.locator("[data-taskbar-app='files']").click();
  await expect(page.locator("[data-application-window='files']")).toBeVisible();
  return page.locator("[data-application-window='files']");
}

test("@c3 @visual C3 Files and Storage browser-rendered evidence", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "C3 visual evidence is captured once in Chromium");
  let files = await filesScenario(page);
  await capture(page, "01-files-home");
  await files.getByLabel("Fixture folders").getByRole("button", { name: "Projects" }).click();
  await files.getByRole("option", { name: /Website/ }).dblclick();
  await capture(page, "02-nested-project-folder");
  await files.getByLabel("Grid view").click();
  await capture(page, "03-grid-view");
  await files.getByRole("option", { name: /^src/ }).dblclick();
  await files.getByRole("option", { name: /App.jsx/ }).click();
  await files.getByRole("button", { name: "Details" }).click();
  await capture(page, "04-file-details");
  await files.getByLabel("Close file details").click();
  await files.getByRole("option", { name: /App.jsx/ }).click();
  await files.getByRole("button", { name: "Actions" }).click();
  await files.getByRole("menuitem", { name: /Rename/ }).click();
  await capture(page, "05-rename-dialog");
  await page.getByLabel("Close file dialog").click();
  await files.getByRole("button", { name: "Actions" }).click();
  await files.getByRole("menuitem", { name: /Copy to/ }).click();
  await capture(page, "06-move-copy-destination");
  await page.getByLabel("Close file dialog").click();
  await files.getByRole("button", { name: "Synthetic fixture upload" }).click();
  await capture(page, "07-upload-simulation");
  await page.getByLabel("Close file dialog").click();

  files = await filesScenario(page, "duplicate-filename");
  await files.getByRole("option", { name: /Welcome to Thrallo/ }).click();
  await files.getByRole("button", { name: "Actions" }).click();
  await files.getByRole("menuitem", { name: /Rename/ }).click();
  await files.getByLabel("Item name").fill("Welcome.txt");
  await files.getByRole("button", { name: "Rename" }).click();
  await capture(page, "08-conflict-state");

  files = await filesScenario(page, "trash-populated");
  await capture(page, "09-trash");
  files = await filesScenario(page, "storage-warning");
  await page.locator("[data-taskbar-app='storage']").click();
  await capture(page, "10-storage-warning");
  files = await filesScenario(page, "large-folder");
  await capture(page, "11-large-directory");
  await page.setViewportSize({ width: 834, height: 1112 });
  await capture(page, "12-tablet-files");
  await page.setViewportSize({ width: 390, height: 844 });
  await capture(page, "13-mobile-files");
});
