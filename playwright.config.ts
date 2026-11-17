import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "browser.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  outputDir: "/private/tmp/health-app-browser-results",
  use: {
    baseURL: process.env.TEST_BASE_URL || "http://localhost:3000",
    channel: "chrome",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 960 } } },
    { name: "mobile", use: { ...devices["iPhone 13"], defaultBrowserType: "chromium", channel: "chrome" } },
  ],
});
