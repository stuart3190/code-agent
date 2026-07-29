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
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
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
