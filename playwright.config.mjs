import { defineConfig, devices } from "@playwright/test";

const port = 18788;
const baseURL = process.env.E2E_BASE_URL || `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: "line",
  use: { baseURL, trace: "on-first-retry" },
  // Tablet was the one viewport class the 2026-08-01 audit found untested — and it is the
  // width where the layout actually switches: the mobile rules apply below 820px, so a portrait
  // tablet (834px) is the FIRST size that gets the desktop rail, and landscape is the widest
  // touch device. Both orientations run, because they exercise different branches.
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    // iPad geometry and touch behaviour on chromium: the iPad descriptors default to WebKit,
    // which CI does not install (`playwright install chromium`), so the browser is pinned.
    {
      name: "tablet-portrait",
      use: { ...devices["iPad Pro 11"], browserName: "chromium", defaultBrowserType: "chromium" },
    },
    {
      name: "tablet-landscape",
      use: { ...devices["iPad Pro 11 landscape"], browserName: "chromium", defaultBrowserType: "chromium" },
    },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },

    /**
     * Other engines.
     *
     * Every project above is Chromium, so until now "the full matrix" proved four viewports of one
     * rendering engine. Firefox (Gecko) and WebKit cover the two engines Thrallo is not otherwise
     * tested on, and WebKit is the closest thing available here to Safari on macOS and iOS — it is
     * the same engine, not the same browser, and the difference is stated rather than glossed.
     *
     * These run a NAMED subset rather than the whole suite: the cross-engine risks are layout,
     * focus, CSS support and the streaming APIs, not application logic, and running 600 specs three
     * more times would cost half an hour to re-prove the same reducer.
     *
     * Edge is Chromium with the same engine version Playwright ships, so desktop-chromium covers
     * it. Real Safari, real iOS and real Android devices are NOT covered — see PLATFORMS.md.
     */
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
      // Anchored on the separator: a bare "settings" also matched provider-settings.spec.mjs.
      testMatch: /[\\/](cross-browser|chat-shell|settings|projects-experience)\.spec\.mjs$/,
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
      // Anchored on the separator: a bare "settings" also matched provider-settings.spec.mjs.
      testMatch: /[\\/](cross-browser|chat-shell|settings|projects-experience)\.spec\.mjs$/,
    },
  ],
  webServer: process.env.E2E_BASE_URL ? undefined : {
    command: "node shell/server/index.mjs",
    url: `${baseURL}/api/v1/capabilities`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { SHELL_PORT: String(port), SHELL_HOST: "127.0.0.1", CODE_AGENT_WORKER: "off" },
  },
});
