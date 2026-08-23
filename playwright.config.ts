import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  timeout: 30_000,
  expect: { timeout: 6_000 },
  use: { baseURL: "http://127.0.0.1:4174", channel: "chrome", trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: { command: "npm run dev", url: "http://127.0.0.1:4174", reuseExistingServer: true, timeout: 120_000 },
});
