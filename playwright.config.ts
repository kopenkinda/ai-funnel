import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4319",
    headless: true,
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "node tests/fixture-upstream.ts",
      port: 4320,
      reuseExistingServer: false,
    },
    {
      command:
        "NODE_ENV=production PORT=4319 DATA_DIR=/tmp/ai-funnel-browser-tests ADMIN_TOKEN=browser-test-dashboard-key node server/index.ts",
      port: 4319,
      reuseExistingServer: false,
    },
  ],
});
