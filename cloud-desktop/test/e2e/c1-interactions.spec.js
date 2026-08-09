import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

async function openLauncher(page) {
  await page.locator("[data-launcher-button]").click();
  await expect(page.locator("[data-launcher]")).toBeVisible();
}

async function openApp(page, appId) {
  await page.locator(`[data-taskbar-app='${appId}']`).click();
  await expect(page.locator(`[data-application-window='${appId}']`)).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("[data-desktop-shell]")).toBeVisible();
});

test("launcher search, keyboard dismissal, and fixture app opening", async ({ page }) => {
  await openLauncher(page);
  const search = page.getByPlaceholder("Search apps");
  await search.fill("terminal");
  await expect(page.locator("[data-launch-app='terminal']")).toBeVisible();
  await expect(page.locator("[data-launch-app='files']")).toHaveCount(0);
  await page.locator("[data-launch-app='terminal']").click();
  await expect(page.locator("[data-application-window='terminal']")).toBeVisible();
  await openLauncher(page);
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-launcher]")).toHaveCount(0);
  await page.keyboard.press("Alt+l");
  await expect(page.locator("[data-launcher]")).toBeVisible();
  await expect(page.locator("[data-launch-app='thrallo']")).toContainText("Recent");
  await page.locator(".desktop-header").click({ position: { x: 400, y: 20 } });
  await expect(page.locator("[data-launcher]")).toHaveCount(0);
});

test("desktop shortcuts open and focus apps while launcher and taskbar stay synchronized", async ({ page }) => {
  await page.getByLabel("Fixture scenario").selectOption("first-launch");
  const shortcuts = page.locator("[data-desktop-shortcut]");
  await expect(shortcuts).toHaveCount(7);

  await page.locator("[data-desktop-shortcut='files']").dblclick();
  await expect(page.locator("[data-application-window='files']")).toBeVisible();
  await expect(page.locator("[data-desktop-shortcut='files']")).toHaveAttribute("data-focused", "true");
  await expect(page.locator("[data-taskbar-app='files']")).toHaveAttribute("aria-label", /focused/);

  await openLauncher(page);
  await expect(page.locator("[data-launch-app='files']")).toContainText("Running");
  await page.keyboard.press("Escape");

  const terminalShortcut = page.locator("[data-desktop-shortcut='terminal']");
  await terminalShortcut.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-application-window='terminal']")).toBeVisible();
  await expect(page.locator("[data-taskbar-app='terminal']")).toHaveAttribute("aria-label", /focused/);

  await page.locator("[data-desktop-shortcut='github']").dispatchEvent("pointerup", { pointerType: "touch", pointerId: 17, button: 0 });
  await expect(page.locator("[data-application-window='github']")).toBeVisible();
  await expect(page.locator("[data-desktop-shortcut='github']")).toHaveAttribute("data-focused", "true");
});

test("desktop shortcut positions can be moved and survive refresh", async ({ page }) => {
  await page.getByLabel("Fixture scenario").selectOption("first-launch");
  const shortcut = page.locator("[data-desktop-shortcut='settings']");
  const before = await shortcut.boundingBox();
  await page.mouse.move(before.x + 30, before.y + 28);
  await page.mouse.down();
  await page.mouse.move(before.x + 118, before.y + 76, { steps: 5 });
  await page.mouse.up();
  const moved = await shortcut.boundingBox();
  expect(moved.x).toBeGreaterThan(before.x + 60);
  expect(moved.y).toBeGreaterThan(before.y + 20);

  await page.reload();
  const restored = await page.locator("[data-desktop-shortcut='settings']").boundingBox();
  expect(Math.abs(restored.x - moved.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(restored.y - moved.y)).toBeLessThanOrEqual(1);
});

test("window focus, minimize, restore, maximize, snap, close, drag and resize", async ({ page }) => {
  const browserWindow = page.locator("[data-application-window='browser']");
  await browserWindow.getByLabel("Minimize Browser").click();
  await expect(browserWindow).toHaveCount(0);
  await expect(page.locator("[data-taskbar-app='browser']")).toHaveAttribute("aria-label", /minimized/);
  await page.locator("[data-taskbar-app='browser']").click();
  await expect(browserWindow).toBeVisible();

  await browserWindow.getByLabel("Maximize Browser").click();
  await expect(browserWindow).toHaveAttribute("data-window-state", "maximized");
  await browserWindow.getByLabel("Restore Browser").click();
  await expect(browserWindow).toHaveAttribute("data-window-state", "floating");
  await page.getByTestId("titlebar-browser").dblclick({ position: { x: 190, y: 20 } });
  await expect(browserWindow).toHaveAttribute("data-window-state", "maximized");
  await page.getByTestId("titlebar-browser").dblclick({ position: { x: 190, y: 20 } });
  await expect(browserWindow).toHaveAttribute("data-window-state", "floating");

  await browserWindow.getByLabel("Arrange Browser").click();
  await page.getByRole("menuitem", { name: "Left half" }).click();
  await expect(browserWindow).toHaveAttribute("data-window-state", "left");
  await browserWindow.getByLabel("Restore Browser").click();

  const beforeDrag = await browserWindow.boundingBox();
  const titlebar = page.getByTestId("titlebar-browser");
  const titleBox = await titlebar.boundingBox();
  await page.mouse.move(titleBox.x + 180, titleBox.y + 20);
  await page.mouse.down();
  await page.mouse.move(titleBox.x + 80, titleBox.y + 65);
  await page.mouse.up();
  const afterDrag = await browserWindow.boundingBox();
  expect(afterDrag.x).toBeLessThan(beforeDrag.x - 30);

  const resizeHandle = page.getByTestId("resize-browser");
  const resizeBox = await resizeHandle.boundingBox();
  const beforeResize = await browserWindow.boundingBox();
  await page.mouse.move(resizeBox.x + 8, resizeBox.y + 8);
  await page.mouse.down();
  await page.mouse.move(resizeBox.x + 70, resizeBox.y + 48);
  await page.mouse.up();
  const afterResize = await browserWindow.boundingBox();
  expect(afterResize.width).toBeGreaterThan(beforeResize.width + 30);

  await browserWindow.getByLabel("Close Browser").click();
  await expect(browserWindow).toHaveCount(0);
});

test("window layout and settings persist; corrupt state recovers", async ({ page }) => {
  await openApp(page, "settings");
  await page.getByRole("button", { name: /Dark/ }).click();
  await page.getByLabel("Show app labels").uncheck();
  const workspaceInput = page.locator(".workspace-name-setting input");
  await workspaceInput.fill("Review workspace");
  await workspaceInput.press("Enter");
  await page.reload();
  await expect(page.locator("[data-desktop-shell]")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("[data-launcher-button]")).toContainText("Review workspace");
  await expect(page.locator("[data-taskbar]")).toHaveAttribute("data-labels", "false");

  await page.evaluate(() => localStorage.setItem("thrallo.cloudDesktop.fixture.v1", "{broken"));
  await page.reload();
  await expect(page.locator("[data-desktop-shell]")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("[data-application-window='browser']")).toBeVisible();
});

test("Browser tabs, safe history, downloads, and blocked navigation are fixture-only", async ({ page }) => {
  const browser = page.locator("[data-application-window='browser']");
  await browser.getByLabel("New fixture tab").click();
  await expect(browser.getByRole("tab")).toHaveCount(2);
  await browser.getByRole("button", { name: "Browser history" }).click();
  await expect(browser.getByRole("complementary", { name: "Browser history" })).toBeVisible();
  await browser.getByLabel("Close panel").click();
  await browser.getByRole("button", { name: "Fixture downloads" }).click();
  await expect(browser.getByText("workspace-summary.pdf")).toBeVisible();
  await browser.getByLabel("Close panel").click();
  await browser.getByText("Four active projects").click();
  await expect(browser.getByRole("heading", { name: "Your cloud projects" })).toBeVisible();
  await browser.getByLabel("Go back").click();
  await expect(browser.getByRole("heading", { name: "Welcome back to My Workspace" })).toBeVisible();
  await browser.getByLabel("Go forward").click();
  await expect(browser.getByRole("heading", { name: "Your cloud projects" })).toBeVisible();
  await browser.getByLabel("Reload fixture page").click();
  await expect(page.getByRole("dialog")).toContainText("reloaded from bundled fixture data");
  await page.getByLabel("Close dialog").click();
  const address = browser.getByLabel("Fixture address");
  await address.fill("example.invalid");
  await address.press("Enter");
  await expect(page.getByRole("dialog")).toContainText("only open bundled fixture pages");
});

test("Files changes remain deterministic fixture state", async ({ page }) => {
  await openApp(page, "files");
  const files = page.locator("[data-application-window='files']");
  await files.getByRole("button", { name: /New folder/ }).click();
  await expect(files.getByRole("button", { name: /New folder Folder/ })).toBeVisible();
  await files.getByRole("button", { name: /New folder Folder/ }).click();
  await files.getByRole("button", { name: /Rename/ }).click();
  await expect(files.getByRole("button", { name: /New folder renamed Folder/ })).toBeVisible();
  await files.getByLabel("Selected file actions").getByRole("button", { name: "Trash" }).click();
  await files.getByLabel("Fixture folders").getByRole("button", { name: "Trash", exact: true }).click();
  await files.getByRole("button", { name: /New folder renamed Folder/ }).click();
  await files.getByRole("button", { name: /Restore/ }).click();
  await files.getByLabel("Fixture folders").getByRole("button", { name: "Cloud drive", exact: true }).click();
  await files.getByRole("button", { name: /Design System Folder/ }).click();
  await files.getByLabel("Selected file actions").getByRole("button", { name: "Move" }).click();
  await files.getByRole("button", { name: /Fixture upload/ }).click();
  await expect(page.getByRole("dialog")).toContainText("No local file was read");
});

test("Terminal supports only safe deterministic commands", async ({ page }) => {
  await openApp(page, "terminal");
  const terminal = page.locator("[data-application-window='terminal']");
  const input = terminal.getByLabel("Fixture terminal command");
  await input.fill("pwd");
  await input.press("Enter");
  await expect(terminal.getByText("/workspace/my-workspace")).toBeVisible();
  await input.fill("whoami");
  await input.press("Enter");
  await expect(terminal.getByText("thrallo-fixture-user")).toBeVisible();
  await input.fill("curl example.invalid");
  await input.press("Enter");
  await expect(terminal.getByText(/not available in C1 fixture/)).toBeVisible();
  await terminal.getByLabel("New fixture terminal").click();
  await expect(terminal.getByRole("tab")).toHaveCount(2);
});

test("GitHub, Storage, and Settings expose fixture states without live handoff", async ({ page }) => {
  await openApp(page, "github");
  await expect(page.locator("[data-application-window='github']")).toContainText("Connected fixture");
  await page.getByRole("button", { name: /pull requests/i }).click();
  await expect(page.getByText("Refine onboarding layout")).toBeVisible();
  await page.getByRole("button", { name: /Manage connection/ }).click();
  await expect(page.getByRole("dialog")).toContainText("OAuth and GitHub API access are deliberately disabled");
  await page.getByLabel("Close dialog").click();

  await page.getByLabel("Fixture scenario").selectOption("storage-warning");
  await expect(page.locator("[data-testid='storage-app']")).toHaveAttribute("data-storage-tone", "warning");
  await expect(page.locator("[data-application-window='storage']")).toContainText("Storage is getting full");

  await openApp(page, "settings");
  await page.getByRole("button", { name: /Open portal fixture/ }).click();
  await expect(page.getByRole("dialog")).toContainText("records no portal call");
});

test("@accessibility launcher and window controls are keyboard reachable with no serious axe violations", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.keyboard.press("Alt+l");
  await expect(page.getByPlaceholder("Search apps")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("[data-launch-app]").first()).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-application-window='thrallo']")).toBeVisible();
  await page.locator("[data-taskbar-app='browser']").click();
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(page.locator("[data-application-window='browser']")).toHaveAttribute("data-window-state", "left");
  const transitionDuration = await page.locator("[data-application-window='browser']").evaluate((element) => getComputedStyle(element).transitionDuration);
  expect(Number.parseFloat(transitionDuration)).toBeLessThanOrEqual(0.001);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(results.violations.filter((violation) => ["serious", "critical"].includes(violation.impact))).toEqual([]);
});

test("responsive tablet and mobile layouts preserve usable app switching", async ({ page }) => {
  await page.setViewportSize({ width: 834, height: 1112 });
  await expect(page.locator("[data-desktop-shell]")).toHaveAttribute("data-layout", "tablet");
  await expect(page.locator("[data-desktop-shortcuts]")).toBeHidden();
  await expect(page.locator("[data-application-window='browser']")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("[data-desktop-shell]")).toHaveAttribute("data-layout", "mobile");
  await expect(page.locator("[data-desktop-shortcuts]")).toBeHidden();
  await page.locator("[data-launcher-button]").click();
  await expect(page.locator("[data-launcher]")).toBeVisible();
  await expect(page.locator("[data-launch-app]")).toHaveCount(7);
  await page.setViewportSize({ width: 384, height: 512 });
  await expect(page.locator("[data-launcher]")).toBeVisible();
  const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(horizontalOverflow).toBeLessThanOrEqual(1);
});

test("all runtime requests stay on the fixed loopback origin", async ({ page }) => {
  const requests = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.reload();
  await openApp(page, "github");
  await openApp(page, "files");
  await openApp(page, "terminal");
  expect(requests.length).toBeGreaterThan(0);
  for (const requestUrl of requests) {
    const url = new URL(requestUrl);
    expect(`${url.hostname}:${url.port}`).toBe("127.0.0.1:4174");
  }
});
