// Theme system verification: light default, Light/Dark/System selector, live System
// tracking, persistence across reload, and measured contrast in BOTH themes across the
// main surfaces. Guards the light-mode regression report of 2026-07-31.

import { test, expect } from "@playwright/test";
import { openPreferences } from "./accountMenu.mjs";
import { stubSettings } from "./settingsStub.mjs";
import { readFile } from "node:fs/promises";

let REF = null;
try {
  REF = new URL((await readFile("shell/web/.env", "utf8")).match(/VITE_SUPABASE_URL=(\S+)/)[1]).hostname.split(".")[0];
} catch { REF = null; }

test.skip(!REF, "requires shell/web/.env auth config (skipped in CI)");

const SESSION = {
  access_token: "e2e-token", token_type: "bearer", expires_at: Math.floor(Date.now() / 1000) + 3600,
  refresh_token: "e2e-refresh", user: { id: "u-e2e", email: "e2e@thrallo.com", user_metadata: { full_name: "Enid Tester" } },
};

async function stub(page) {
  await page.addInitScript(([key, session]) => {
    window.localStorage.setItem(key, JSON.stringify(session));
  }, [`sb-${REF}-auth-token`, SESSION]);
  await page.route(`https://${REF}.supabase.co/**`, (route) => route.fulfill({ json: {} }));
  await page.route(`https://${REF}.supabase.co/auth/v1/user**`, (route) => route.fulfill({ json: SESSION.user }));
  await page.route("**/api/v1/conversations", (route) => route.fulfill({ json: { conversations: [] } }));
  await page.route("**/api/v1/conversations/deleted", (route) => route.fulfill({ json: { items: [] } }));
}

const rootTheme = (page) => page.evaluate(() => document.documentElement.dataset.theme || "light");
const cssVar = (page, name) => page.evaluate((v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim(), name);

// WCAG relative-luminance contrast between two CSS colors, resolved by the browser.
async function contrast(page, fg, bg) {
  return page.evaluate(([f, b]) => {
    const resolve = (color) => {
      const el = document.createElement("div");
      el.style.color = color;
      document.body.appendChild(el);
      const rgb = getComputedStyle(el).color.match(/[\d.]+/g).slice(0, 3).map(Number);
      el.remove();
      return rgb;
    };
    const lum = (rgb) => {
      const [r, g, bl] = rgb.map((c) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
    };
    const l1 = lum(resolve(f)), l2 = lum(resolve(b));
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }, [fg, bg]);
}

async function assertThemeReadable(page, label) {
  const ink = await cssVar(page, "--ink"), ink2 = await cssVar(page, "--ink-2");
  const bg = await cssVar(page, "--bg"), surface = await cssVar(page, "--surface");
  const accent = await cssVar(page, "--accent"), accentInk = await cssVar(page, "--accent-ink");
  expect(ink, `${label}: --ink defined`).toBeTruthy();
  expect(await contrast(page, ink, bg), `${label}: body text on canvas`).toBeGreaterThan(7);
  expect(await contrast(page, ink, surface), `${label}: body text on cards`).toBeGreaterThan(7);
  expect(await contrast(page, ink2, surface), `${label}: secondary text on cards`).toBeGreaterThan(4.5);
  expect(await contrast(page, accentInk, accent), `${label}: button label on accent`).toBeGreaterThan(3);
}

test("light is the default; Light/Dark/System round-trip, persist, and stay readable", async ({ page }) => {
  await stub(page);
  await page.emulateMedia({ colorScheme: "dark" }); // a dark OS must NOT darken the app by itself
  await stubSettings(page);
  await page.goto("/");
  await expect(page.locator(".ct-question")).toBeVisible();
  expect(await rootTheme(page), "fresh load defaults to light even on a dark OS").toBe("light");
  await assertThemeReadable(page, "light");

  // Selector: all three options present; Dark applies and is readable.
  await openPreferences(page);
  const group = page.getByRole("group", { name: "Theme" });
  await expect(group.getByRole("button", { name: "Light" })).toBeVisible();
  await expect(group.getByRole("button", { name: "Dark" })).toBeVisible();
  await expect(group.getByRole("button", { name: "System" })).toBeVisible();

  await group.getByRole("button", { name: "Dark" }).click();
  expect(await rootTheme(page)).toBe("dark");
  await assertThemeReadable(page, "dark");

  // Back to Light — the reported regression: this must always work.
  await group.getByRole("button", { name: "Light" }).click();
  expect(await rootTheme(page)).toBe("light");
  await assertThemeReadable(page, "light after round-trip");

  // System follows the OS live, in both directions.
  await group.getByRole("button", { name: "System" }).click();
  await expect.poll(() => rootTheme(page), { message: "system + dark OS" }).toBe("dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(() => rootTheme(page), { message: "system tracks OS change to light" }).toBe("light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => rootTheme(page), { message: "system tracks OS change to dark" }).toBe("dark");

  // Persistence: the preference survives reload and applies before the app mounts.
  await page.reload();
  await expect(page.locator(".ct-question")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("thrallo-theme"))).toBe("system");
  expect(await rootTheme(page), "system persisted across reload").toBe("dark");

  // Explicit light persists too. Settings is an address now, so the reload above restored the
  // Preferences tab exactly where it was — reopening it would click an avatar that the sheet covers.
  await expect(group.getByRole("button", { name: "Light" })).toBeVisible();
  await group.getByRole("button", { name: "Light" }).click();
  await page.reload();
  await expect(page.locator(".ct-question")).toBeVisible();
  expect(await rootTheme(page), "light persisted across reload despite dark OS").toBe("light");
});

test("account preference follows the user to a fresh device", async ({ page }) => {
  await stub(page);
  // Fresh device: no local preference; the account carries thrallo_theme=dark.
  await page.unroute(`https://${REF}.supabase.co/auth/v1/user**`);
  await page.route(`https://${REF}.supabase.co/auth/v1/user**`, (route) => route.fulfill({
    json: { ...SESSION.user, user_metadata: { ...SESSION.user.user_metadata, thrallo_theme: "dark" } },
  }));
  await stubSettings(page);
  await page.goto("/");
  await expect(page.locator(".ct-question")).toBeVisible();
  await expect.poll(() => rootTheme(page), { message: "account dark preference adopted" }).toBe("dark");
  expect(await page.evaluate(() => localStorage.getItem("thrallo-theme"))).toBe("dark");
});
