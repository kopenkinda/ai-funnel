import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4319",
    headless: true,
    screenshot: "only-on-failure",
  },
  webServer: {
    command:
      "go build -o /tmp/ai-funnel-browser-backend ./cmd/funnel && DATA_DIR=$(mktemp -d /tmp/ai-funnel-browser.XXXXXX) PORT=4319 ADMIN_TOKEN=browser-test-dashboard-key /tmp/ai-funnel-browser-backend",
    port: 4319,
    reuseExistingServer: false,
  },
});
