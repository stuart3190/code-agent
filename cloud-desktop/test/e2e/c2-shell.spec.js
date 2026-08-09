import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("[data-desktop-shell]")).toBeVisible();
});

test("repeated focus, rapid minimize/restore, and taskbar state stay coherent", async ({ page }) => {
  const browser = page.locator("[data-application-window='browser']");
  const thrallo = page.locator("[data-application-window='thrallo']");
  for (let index = 0; index < 20; index += 1) {
    await page.locator(`[data-taskbar-app='${index % 2 ? "browser" : "thrallo"}']`).click();
  }
  await expect(browser).toHaveClass(/is-active/);
  await browser.getByLabel("Minimize Browser").click();
  await expect(browser).toHaveCount(0);
  await page.locator("[data-taskbar-app='browser']").click();
  await expect(page.locator("[data-application-window='browser']")).toHaveClass(/is-active/);
  await expect(page.locator(".app-window.is-active")).toHaveCount(1);
});

test("accessible window menu supports keyboard navigation, snapping, restoration and escape", async ({ page }) => {
  const browser = page.locator("[data-application-window='browser']");
  const menuButton = browser.getByLabel("Arrange Browser");
  await menuButton.focus();
  await page.keyboard.press("Enter");
  const menu = browser.getByRole("menu", { name: "Browser window menu" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Restore" })).toBeDisabled();
  await page.keyboard.press("End");
  await expect(menu.getByRole("menuitem", { name: "Close" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(menuButton).toBeFocused();
  await menuButton.click();
  await menu.getByRole("menuitem", { name: "Snap left" }).click();
  await expect(browser).toHaveAttribute("data-window-state", "left");
  await browser.getByLabel("Arrange Browser").click();
  await browser.getByRole("menuitem", { name: "Restore" }).click();
  await expect(browser).toHaveAttribute("data-window-state", "floating");
});

test("drag snap preview, pointer cancellation and viewport constraints are safe", async ({ page }) => {
  const browser = page.locator("[data-application-window='browser']");
  const titlebar = page.getByTestId("titlebar-browser");
  const initial = await browser.boundingBox();
  const title = await titlebar.boundingBox();
  await page.mouse.move(title.x + 200, title.y + 20);
  await page.mouse.down();
  await page.mouse.move(4, 200);
  await expect(page.locator("[data-snap-preview='left']")).toBeVisible();
  await titlebar.dispatchEvent("pointercancel", { pointerId: 1, pointerType: "mouse", clientX: 4, clientY: 200 });
  await expect(page.locator("[data-snap-preview]")).toHaveCount(0);
  const canceled = await browser.boundingBox();
  expect(canceled.x).toBeCloseTo(initial.x, 0);
  await page.setViewportSize({ width: 1180, height: 700 });
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  await expect.poll(async () => {
    const constrained = await browser.boundingBox();
    return Math.round(constrained.x + constrained.width);
  }).toBeLessThanOrEqual(1180);
  await expect.poll(async () => {
    const constrained = await browser.boundingBox();
    return Math.round(constrained.y + constrained.height);
  }).toBeLessThanOrEqual(648);
});

test("edge and corner resize enforces finite minimum geometry and cancellation", async ({ page }) => {
  const browser = page.locator("[data-application-window='browser']");
  for (const edge of ["n", "e", "s", "w", "ne", "nw", "se", "sw"]) {
    const handle = page.getByTestId(edge === "se" ? "resize-browser" : `resize-browser-${edge}`);
    await expect(handle).toBeAttached();
  }
  const before = await browser.boundingBox();
  const handle = page.getByTestId("resize-browser-nw");
  const box = await handle.boundingBox();
  await handle.dispatchEvent("pointerdown", { pointerId: 51, pointerType: "mouse", clientX: box.x + 5, clientY: box.y + 5, button: 0 });
  await handle.dispatchEvent("pointermove", { pointerId: 51, pointerType: "mouse", clientX: box.x + 100, clientY: box.y + 80, buttons: 1 });
  await handle.dispatchEvent("pointercancel", { pointerId: 51, pointerType: "mouse", clientX: box.x + 100, clientY: box.y + 80 });
  const afterCancel = await browser.boundingBox();
  expect(afterCancel.width).toBeCloseTo(before.width, 0);
  const southeast = page.getByTestId("resize-browser");
  const se = await southeast.boundingBox();
  await page.mouse.move(se.x + 4, se.y + 4);
  await page.mouse.down();
  await page.mouse.move(se.x - 5000, se.y - 5000);
  await page.mouse.up();
  const resized = await browser.boundingBox();
  expect(resized.width).toBeGreaterThanOrEqual(559);
  expect(resized.height).toBeGreaterThanOrEqual(409);
});

test("v1 migration, partial stale recovery, malformed reset and orientation changes preserve access", async ({ page }) => {
  await page.evaluate(() => {
    const current = JSON.parse(localStorage.getItem("thrallo.cloudDesktop.fixture.v1"));
    current.version = 1;
    current.windows.unknownApp = { isOpen: true, bounds: { x: -999, y: -999, width: 10, height: 10 }, zIndex: 99999 };
    current.windows.browser.bounds = { x: -5000, y: 6000, width: 9999, height: 9999 };
    current.focusedApplication = "unknownApp";
    localStorage.setItem("thrallo.cloudDesktop.fixture.v1", JSON.stringify(current));
  });
  await page.reload();
  await expect(page.locator("[data-application-window='browser']")).toBeVisible();
  await expect(page.locator("[data-application-window='unknownApp']")).toHaveCount(0);
  await page.setViewportSize({ width: 834, height: 1112 });
  await expect(page.locator("[data-desktop-shell]")).toHaveAttribute("data-layout", "tablet");
  await page.setViewportSize({ width: 1112, height: 834 });
  await expect(page.locator(".app-window.is-active")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("[data-launcher-button]").click();
  await page.locator("[data-launch-app='files']").click();
  await expect(page.locator("[data-application-window='files']")).toBeVisible();
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.locator("[data-application-window='files']")).toBeVisible();
});

test("fixture lifecycle, offline layout preservation, and recovery remain local", async ({ page }) => {
  await page.getByLabel("Fixture scenario").selectOption("workspace-waking");
  const overlay = page.locator("[data-lifecycle-overlay='waking']");
  await expect(overlay).toContainText("Waking workspace");
  await overlay.getByRole("button", { name: "Recover fixture" }).click();
  await expect(page.locator("[data-lifecycle-overlay]")).toHaveCount(0);
  await expect(page.locator(".connection-recovered")).toContainText("Workspace recovered");
  await page.getByLabel("Fixture scenario").selectOption("offline-recovery");
  await expect(page.locator("[data-lifecycle-overlay='recovery_required']")).toBeVisible();
  await expect(page.locator(".connection-offline")).toContainText("layout preserved");
});

test("@accessibility C2 window menu, lifecycle status, reduced motion and 200 percent reflow", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByLabel("Fixture scenario").selectOption("workspace-reconnecting");
  await page.locator("[data-application-window='browser']").getByLabel("Arrange Browser").click();
  await expect(page.getByRole("menuitem", { name: "Restore" })).toBeDisabled();
  await page.setViewportSize({ width: 720, height: 512 });
  await expect(page.locator("[data-desktop-shell]")).toHaveAttribute("data-layout", "mobile");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(results.violations.filter((violation) => ["serious", "critical"].includes(violation.impact))).toEqual([]);
});

test("all C2 interactions remain on the fixed loopback origin", async ({ page }) => {
  const requests = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.getByLabel("Fixture scenario").selectOption("workspace-degraded");
  await page.locator("[data-taskbar-app='github']").click();
  await page.locator("[data-taskbar-app='terminal']").click();
  for (const requestUrl of requests) {
    const url = new URL(requestUrl);
    expect(`${url.hostname}:${url.port}`).toBe("127.0.0.1:4174");
  }
});
