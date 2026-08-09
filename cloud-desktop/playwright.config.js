import { defineConfig, devices } from "@playwright/test";

const port = 4174;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./test/e2e",
  timeout: 30_000,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: "line",
  use: {
    baseURL,
    trace: "on-first-retry",
    viewport: { width: 1440, height: 1024 },
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "cloud-chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1024 } },
    },
    {
      name: "cloud-firefox",
      use: { ...devices["Desktop Firefox"], viewport: { width: 1440, height: 1024 } },
    },
    {
      name: "cloud-webkit",
      use: { ...devices["Desktop Safari"], viewport: { width: 1440, height: 1024 } },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
