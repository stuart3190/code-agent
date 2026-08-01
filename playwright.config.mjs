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
  ],
  webServer: process.env.E2E_BASE_URL ? undefined : {
    command: "node shell/server/index.mjs",
    url: `${baseURL}/api/v1/capabilities`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { SHELL_PORT: String(port), SHELL_HOST: "127.0.0.1", CODE_AGENT_WORKER: "off" },
  },
});
