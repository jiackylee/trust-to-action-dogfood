import { defineConfig } from "@playwright/test";
import path from "node:path";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  timeout: 30_000,
  expect: { timeout: 6_000 },
  use: { baseURL: "http://127.0.0.1:4174", channel: "chrome", trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:4174",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      ...process.env,
      KNOWLEDGE_PACK_PATH: process.env.KNOWLEDGE_PACK_PATH || path.resolve("knowledge-sample"),
      DATA_DB_PATH: process.env.DATA_DB_PATH || path.resolve("data/playwright-v2.2.sqlite"),
    },
  },
});
