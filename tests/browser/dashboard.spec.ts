import { test, expect } from "@playwright/test";

test("dashboard authentication, provider setup, and direct sign-in", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await page
    .getByLabel("Dashboard key", { exact: true })
    .fill("browser-test-dashboard-key");
  await page.getByRole("button", { name: "Unlock dashboard" }).click();
  await expect(
    page.getByRole("button", { name: "Connect your first provider" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Connect your first provider" })
    .click();
  await expect(page.getByLabel("Server URL")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Continue to sign-in" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Auth token", exact: true }).click();
  await expect(page.getByLabel("Auth token", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  const response = await request.post("/api/connections", {
    headers: { Authorization: "Bearer browser-test-dashboard-key" },
    data: { provider: "codex", name: "Codex" },
  });
  expect(response.status()).toBe(201);
  await page.reload();
  expect((await request.get("/providers/codex-dark.svg")).status()).toBe(200);
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Add account", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add account", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Add account" })).toBeVisible();
  await page.getByRole("button", { name: "JSON file", exact: true }).click();
  await page.getByLabel("auth.json", { exact: true }).setInputFiles({
    name: "auth.json",
    mimeType: "application/json",
    buffer: Buffer.from("{"),
  });
  await page.getByRole("button", { name: "Import account" }).click();
  await expect(
    page.getByText("Choose a valid JSON credential file."),
  ).toBeVisible();
  await page.route("**/api/connections/codex/sync", (route) =>
    route.fulfill({ json: {} }),
  );
  await page.getByLabel("auth.json", { exact: true }).setInputFiles({
    name: "auth.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        tokens: {
          access_token: "browser-fixture-access-token",
          account_id: "browser-fixture-account",
        },
        email: "browser@example.com",
      }),
    ),
  });
  await page.getByRole("button", { name: "Import account" }).click();
  await expect(page.getByRole("dialog", { name: "Add account" })).toHaveCount(
    0,
  );
  const imported = await request
    .get("/api/state", {
      headers: { Authorization: "Bearer browser-test-dashboard-key" },
    })
    .then((r) => r.json());
  expect(imported.connections[0].accounts[0].email).toBe("browser@example.com");
  await page.getByRole("button", { name: "API keys", exact: true }).click();
  await page.getByRole("button", { name: "Add shared key" }).click();
  await page.getByLabel("Key name", { exact: true }).fill("Devices");
  await page.getByRole("checkbox", { name: "Codex", exact: true }).check();
  await page
    .locator('button[type="submit"]')
    .filter({ hasText: "Create key" })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Your key is ready" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByText("Devices", { exact: true })).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Usage", exact: true }),
  ).toBeVisible();
});

test("login fits a narrow viewport and keeps demo access removed", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByLabel("Dashboard key", { exact: true })).toBeVisible();
  await expect(page.getByText(/Explore a sample pool/)).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("usage shows reported model pools and banked resets without empty limits", async ({
  page,
}) => {
  const account = {
    id: "usage-fixture",
    name: "Device account",
    email: "device@example.com",
    plan: "Plus",
    status: "active",
  };
  const connection = {
    enabled: true,
    models: [],
    syncedAt: null,
    error: null,
    url: "",
    createdAt: new Date().toISOString(),
    hasApiKey: true,
    hasManagementAccess: true,
  };
  await page.route("**/api/session", (route) =>
    route.fulfill({ json: { authenticated: true } }),
  );
  await page.route("**/api/state", (route) =>
    route.fulfill({
      json: {
        connections: [
          {
            ...connection,
            id: "codex",
            provider: "codex",
            name: "Codex",
            accounts: [
              {
                ...account,
                quotas: [
                  { label: "7d", remaining: 73, resetsAt: null },
                  { label: "Monthly", remaining: null, resetsAt: null },
                ],
                resetCredits: { available: 2, applicable: 0 },
              },
            ],
          },
          {
            ...connection,
            id: "claude",
            provider: "claude",
            name: "Claude",
            accounts: [
              {
                ...account,
                quotas: [{ label: "Fable 7d", remaining: 0, resetsAt: null }],
              },
            ],
          },
        ],
        keys: [],
        requests: [],
        publicUrl: "",
      },
    }),
  );
  await page.goto("/");
  const codex = page.getByRole("region", { name: "Codex usage", exact: true });
  await expect(codex.getByText("73%", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Monthly usage", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Unavailable", { exact: true })).toHaveCount(0);
  const fable = page.getByRole("region", { name: "Fable weekly usage" });
  await expect(fable.getByText("0%", { exact: true })).toBeVisible();
  await page.getByText("2 banked resets", { exact: true }).hover();
  await expect(page.getByRole("tooltip")).toContainText("0 usable now");
  await expect(page.getByRole("tooltip")).toContainText("Device account");
});
