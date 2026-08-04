// Opening Settings the way a user does.
//
// The avatar used to BE the Settings button. It is now the trigger for an account menu — Settings,
// History, Log out — because there was no visible way to sign out and an avatar is the one place
// people look for one. Every spec that reached Settings by clicking the avatar was reaching it
// through a door that no longer opens directly, and this is the shared route through the new one.

import { expect } from "@playwright/test";

/** Open the account menu. Returns the menu locator. */
export async function openAccountMenu(page) {
  await page.locator(".ct-avatar").click();
  const menu = page.getByRole("menu", { name: "Account" });
  await expect(menu).toBeVisible();
  return menu;
}

/** Open Settings from the account menu, and wait for the sheet. */
export async function openSettingsFromMenu(page) {
  const menu = await openAccountMenu(page);
  await menu.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
}
