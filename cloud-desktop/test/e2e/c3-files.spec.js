import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

async function openFiles(page, scenario = null) {
  await page.goto(scenario ? `/?filesScenario=${scenario}` : "/");
  await page.locator("[data-taskbar-app='files']").click();
  const files = page.locator("[data-application-window='files']");
  await expect(files).toBeVisible();
  return files;
}

test("@c3 folder navigation, breadcrumbs, history, search, sort and views", async ({ page }) => {
  const files = await openFiles(page);
  const list = files.getByRole("listbox");
  await files.getByLabel("Fixture folders").getByRole("button", { name: "Projects" }).click();
  await list.getByRole("option", { name: /Website/ }).dblclick();
  await expect(files.getByLabel("Current virtual path")).toContainText("Website");
  await files.getByPlaceholder("Search this folder").fill("package");
  await expect(list.getByRole("option")).toHaveCount(1);
  await files.getByPlaceholder("Search this folder").fill("");
  await files.getByLabel("Sort files").selectOption("size-desc");
  await files.getByLabel("Grid view").click();
  await expect(files.locator(".c3-file-list")).toHaveClass(/view-grid/);
  await files.getByLabel("Back").click();
  await expect(files.getByLabel("Current virtual path")).toContainText("Projects");
  await files.getByLabel("Forward").click();
  await expect(files.getByLabel("Current virtual path")).toContainText("Website");
  await files.getByLabel("Up one folder").click();
  await expect(files.getByLabel("Current virtual path")).toContainText("Projects");
});

test("@c3 create, rename, multi-select, move, copy and stale conflicts are fixture-only", async ({ page }) => {
  const files = await openFiles(page);
  await files.getByRole("button", { name: "New folder", exact: true }).click();
  await files.getByLabel("Item name").fill("Launch notes");
  await files.getByRole("button", { name: "Create folder" }).click();
  const created = files.getByRole("option", { name: /Launch notes/ });
  await created.click();
  await files.getByRole("button", { name: "Actions" }).click();
  await files.getByRole("menuitem", { name: /Rename/ }).click();
  await files.getByLabel("Item name").fill("Launch plans");
  await files.getByRole("button", { name: "Rename" }).click();
  await expect(files.getByRole("option", { name: /Launch plans/ })).toBeVisible();
  await files.getByRole("button", { name: "Actions" }).click();
  await files.getByRole("menuitem", { name: /Copy to/ }).click();
  await files.getByLabel("Destination").selectOption("/Projects");
  await files.getByRole("button", { name: "Copy fixture" }).click();
  await files.getByLabel("Fixture folders").getByRole("button", { name: "Projects" }).click();
  await expect(files.getByRole("option", { name: /Launch plans/ })).toBeVisible();
  const options = files.getByRole("listbox").getByRole("option");
  await options.nth(0).click();
  await options.nth(1).click({ modifiers: ["Control"] });
  await expect(files.getByLabel("Selected file actions")).toContainText("2 selected");

  const stale = await openFiles(page, "stale-revision");
  await stale.getByRole("option", { name: /Welcome to Thrallo/ }).click();
  await stale.getByRole("button", { name: "Actions" }).click();
  await stale.getByRole("menuitem", { name: /Rename/ }).click();
  await stale.getByLabel("Item name").fill("Welcome.txt");
  await stale.getByRole("button", { name: "Rename" }).click();
  await expect(page.getByRole("dialog", { name: "Fixture file operation" })).toContainText(/revision is stale/i);
});

test("@c3 Trash restore/delete and synthetic transfers update fixture storage", async ({ page }) => {
  const files = await openFiles(page);
  await files.getByRole("option", { name: /Welcome to Thrallo/ }).click();
  await files.getByRole("button", { name: "Actions" }).click();
  await files.getByRole("menuitem", { name: /Move to Trash/ }).click();
  await files.getByLabel("Fixture folders").getByRole("button", { name: "Trash" }).click();
  await files.getByRole("option", { name: /Welcome to Thrallo/ }).click();
  await files.getByRole("button", { name: "Actions" }).click();
  await files.getByRole("menuitem", { name: "Restore" }).click();
  await files.getByLabel("Fixture folders").getByRole("button", { name: "My Files" }).click();
  await expect(files.getByRole("option", { name: /Welcome to Thrallo/ })).toBeVisible();

  await files.getByRole("button", { name: "Synthetic fixture upload" }).click();
  await expect(page.locator("input[type=file]")).toHaveCount(0);
  await files.getByRole("button", { name: "Start fixture upload" }).click();
  await expect(files.getByLabel("Fixture transfers")).toContainText("uploading");
  await files.getByRole("button", { name: "Advance fixture" }).click();
  await expect(files.getByRole("option", { name: /campaign-board/ })).toBeVisible();
  await files.getByRole("option", { name: /campaign-board/ }).click();
  await files.getByRole("button", { name: "Actions" }).click();
  await files.getByRole("menuitem", { name: /Fixture download/ }).click();
  await expect(files.getByLabel("Fixture transfers")).toContainText("preparing");
});

test("@c3 large directory is bounded and offline/unavailable states fail closed", async ({ page }) => {
  let files = await openFiles(page, "large-folder");
  await expect(files).toContainText("5,000 items");
  await expect(files.getByRole("listbox").getByRole("option")).toHaveCount(100);
  await expect(files.getByLabel("Large directory pages")).toContainText("Page 1 of 50");
  await files.getByRole("button", { name: /Next/ }).click();
  await expect(files.getByLabel("Large directory pages")).toContainText("Page 2 of 50");
  files = await openFiles(page, "offline-files");
  await expect(files).toContainText("Files are offline");
  files = await openFiles(page, "unavailable-files");
  await expect(files).toContainText("Files are unavailable");
});

test("@c3 @accessibility keyboard, touch-sized controls, persistence and redirection guards", async ({ page }) => {
  const requests = [];
  page.on("request", (request) => requests.push(request.url()));
  const files = await openFiles(page);
  const first = files.getByRole("listbox").getByRole("option").first();
  await first.focus();
  await page.keyboard.press("Space");
  await expect(first).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await expect(files.getByRole("listbox").getByRole("option").nth(1)).toBeFocused();
  await files.getByRole("button", { name: "Actions" }).click();
  await expect(files.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(files.getByRole("menuitem").nth(1)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(files.getByRole("button", { name: "Actions" })).toBeFocused();
  await files.getByLabel("Grid view").click();
  await page.reload();
  await page.locator("[data-taskbar-app='files']").click();
  await expect(page.locator(".c3-file-list")).toHaveClass(/view-grid/);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("[data-application-window='files']")).toBeVisible();
  const violations = await new AxeBuilder({ page }).include("[data-application-window='files']").analyze();
  expect(violations.violations.filter((entry) => ["serious", "critical"].includes(entry.impact))).toEqual([]);
  for (const request of requests) expect(new URL(request).host).toBe("127.0.0.1:4174");
});
