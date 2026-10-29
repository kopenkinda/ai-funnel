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
  await expect(page.getByText("No usage yet", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Connect.*provider/ }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  const disabled = page.getByRole("region", { name: "Disabled providers" });
  const codex = page.getByRole("region", {
    name: "Codex connection",
    exact: true,
  });
  const claude = page.getByRole("region", {
    name: "Claude connection",
    exact: true,
  });
  await expect(disabled.getByRole("region")).toHaveCount(2);
  const unsupported = page.getByRole("region", {
    name: "Unsupported providers",
  });
  await expect(unsupported).toBeVisible();
  await expect(unsupported.getByRole("button")).toHaveCount(0);
  await expect(unsupported.locator('[data-slot="card-title"]')).toHaveText([
    "Gemini",
    "Google AI Studio",
    "Vertex AI",
    "Antigravity",
    "Grok",
    "Kimi",
    "Devin",
    "Meta",
    "OpenAI compatible",
  ]);
  await claude
    .getByRole("button", { name: "Add account", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Add Claude account" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "JSON file", exact: true }).click();
  await expect(
    page.getByLabel("Credential JSON", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await codex.getByRole("button", { name: "Add account", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Add Codex account" }),
  ).toBeVisible();
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
  await expect(
    page.getByRole("region", { name: "Codex usage", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await expect(disabled.getByRole("region")).toHaveCount(2);
  await codex.getByRole("button", { name: "Add account", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Add Codex account" }),
  ).toBeVisible();
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
  await expect(
    page.getByRole("dialog", { name: "Add Codex account" }),
  ).toHaveCount(0);
  const imported = await request
    .get("/api/state", {
      headers: { Authorization: "Bearer browser-test-dashboard-key" },
    })
    .then((r) => r.json());
  expect(imported.connections[0].accounts[0].email).toBe("browser@example.com");
  const enabled = page.getByRole("region", { name: "Enabled providers" });
  await expect(
    enabled.getByRole("region", { name: "Codex connection" }),
  ).toBeVisible();
  await expect(
    disabled.getByRole("region", { name: "Claude connection" }),
  ).toBeVisible();
  await codex.getByRole("button", { name: "Pause Codex", exact: true }).click();
  await expect(disabled.getByRole("region")).toHaveCount(2);
  await codex
    .getByRole("button", { name: "Resume Codex", exact: true })
    .click();
  await expect(
    enabled.getByRole("region", { name: "Codex connection" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "API keys", exact: true }).click();
  await page
    .getByRole("button", { name: "Add your first key", exact: true })
    .click();
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
  await expect(
    page.getByRole("heading", { name: "Devices", exact: true }),
  ).toBeVisible();
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

test("existing key access can be edited with provider model selections", async ({
  page,
  request,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const headers = { Authorization: "Bearer browser-test-dashboard-key" };
  await page.request.post("/api/session", {
    data: { token: "browser-test-dashboard-key" },
  });
  const catalog = await request
    .get("/api/connections/codex/models", { headers })
    .then((r) => r.json());
  const models: string[] = catalog.data
    .slice(0, 2)
    .map((m: { id: string }) => m.id);
  expect(models).toHaveLength(2);
  const created = await request
    .post("/api/keys", {
      headers,
      data: {
        name: "Editable devices",
        dailyLimit: 50,
        grants: [{ connectionId: "codex", accountIds: null, models: null }],
      },
    })
    .then((r) => r.json());
  await request.post("/api/connections", {
    headers,
    data: { provider: "claude", name: "Claude" },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "API keys", exact: true }).click();
  await page
    .getByRole("button", { name: "Select Editable devices", exact: true })
    .click();
  const dialog = page.getByRole("form", { name: "API key settings" });
  await expect(dialog.getByLabel("Key name", { exact: true })).toHaveValue(
    "Editable devices",
  );
  await expect(dialog.getByLabel("Requests per day")).toHaveValue("50");
  await dialog.getByLabel("Key name", { exact: true }).fill("Unsaved name");
  await dialog.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(dialog.getByLabel("Key name", { exact: true })).toHaveValue(
    "Editable devices",
  );
  await page
    .getByRole("switch", { name: "Pause Editable devices", exact: true })
    .click();
  await expect(
    page.getByRole("switch", { name: "Resume Editable devices", exact: true }),
  ).not.toBeChecked();
  await page
    .getByRole("switch", { name: "Resume Editable devices", exact: true })
    .click();
  await expect(
    page.getByRole("switch", { name: "Pause Editable devices", exact: true }),
  ).toBeChecked();
  await expect(dialog.getByRole("group", { name: "Key source" })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Add key", exact: true }).click();
  const createDialog = page.getByRole("dialog", { name: "Add a shared key" });
  await createDialog
    .getByLabel("Key name", { exact: true })
    .fill("Another device");
  await createDialog
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(dialog.getByLabel("Key name", { exact: true })).toHaveValue(
    "Editable devices",
  );
  await dialog
    .getByRole("checkbox", { name: "All models", exact: true })
    .uncheck();
  const picker = dialog.getByRole("combobox", {
    name: "Codex models",
    exact: true,
  });
  await expect(picker).toBeEnabled();
  for (const model of models) {
    await picker.fill(model);
    await page.getByRole("option", { name: model, exact: true }).click();
  }
  await picker.fill("");
  await picker.click();
  await page.getByRole("option", { name: models[1], exact: true }).waitFor();
  await page.screenshot({
    path: "/tmp/ai-funnel-model-picker.png",
    fullPage: true,
  });
  if ((await picker.getAttribute("aria-expanded")) === "true")
    await picker.press("Escape");
  await expect(dialog).toBeVisible();
  const selected = dialog.getByLabel("Selected models", { exact: true });
  for (const model of models) await expect(selected).toContainText(model);
  await selected
    .getByLabel(models[0], { exact: true })
    .getByRole("button")
    .click();
  await expect(selected).not.toContainText(models[0]);
  await dialog.getByRole("checkbox", { name: "Claude", exact: true }).check();
  await dialog.getByLabel("Key name", { exact: true }).fill("Coding tools");
  await dialog.getByLabel("Requests per day").fill("");
  await page.screenshot({
    path: "/tmp/ai-funnel-key-editor-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/ai-funnel-key-editor-mobile.png",
    fullPage: true,
  });
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeDisabled();
  const state = await request
    .get("/api/state", { headers })
    .then((r) => r.json());
  const updated = state.keys.find(
    (k: { id: string }) => k.id === created.key.id,
  );
  expect(updated.name).toBe("Coding tools");
  expect(updated.dailyLimit).toBeNull();
  expect(updated.prefix).toBe(created.key.prefix);
  expect(updated.grants).toEqual([
    { connectionId: "codex", accountIds: null, models: [models[1]] },
    { connectionId: "claude", accountIds: null, models: null },
  ]);
  await page.reload();
  await page.getByRole("button", { name: "API keys", exact: true }).click();
  await page
    .getByRole("button", { name: "Select Coding tools", exact: true })
    .click();
  await expect(dialog.getByLabel("Selected models")).toContainText(models[1]);
  await expect(
    dialog.getByRole("checkbox", { name: "Claude", exact: true }),
  ).toBeChecked();
  await dialog.getByRole("checkbox", { name: "Claude", exact: true }).uncheck();
  await dialog
    .getByRole("checkbox", { name: "All models", exact: true })
    .check();
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeDisabled();
  const visible = await request.get("/providers/codex/codex/v1/models", {
    headers: { Authorization: `Bearer ${created.token}` },
  });
  expect(visible.status()).toBe(200);
  expect((await visible.json()).data.length).toBeGreaterThan(1);
  const removed = await request.get("/providers/claude/claude/v1/models", {
    headers: { Authorization: `Bearer ${created.token}` },
  });
  expect(removed.status()).toBe(403);
});

test("usage shows reported limits and persists email privacy", async ({
  page,
}) => {
  const account = {
    id: "usage-fixture",
    name: "device@example.com",
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
                resetCredits: {
                  available: 3,
                  applicable: 0,
                  items: [
                    {
                      id: "expiring",
                      status: "available",
                      resets_left: 2,
                      expires_at: "2035-01-01T00:00:00Z",
                    },
                    {
                      id: "no-expiry",
                      status: "available",
                      resets_left: 1,
                    },
                  ],
                },
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
  const email = codex.getByText("device@example.com", { exact: true });
  await expect(
    page.getByRole("button", { name: "Show emails" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(email).toHaveCSS("filter", /blur\(/);
  await expect(email.locator("..")).not.toHaveAttribute("title");
  await expect(codex.getByText("73%", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Monthly usage", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Unavailable", { exact: true })).toHaveCount(0);
  const fable = page.getByRole("region", { name: "Fable weekly usage" });
  await expect(fable.getByText("0%", { exact: true })).toBeVisible();
  await page.getByText("2 banked resets", { exact: true }).hover();
  await expect(page.getByRole("tooltip")).toContainText("2 banked");
  await expect(page.getByRole("tooltip")).not.toContainText("usable now");
  await expect(
    page.getByRole("tooltip").getByText("device@example.com"),
  ).toHaveCSS("filter", /blur\(/);
  const claude = page.getByRole("region", {
    name: "Claude usage",
    exact: true,
  });
  await claude.getByText("3 banked resets", { exact: true }).hover();
  const claudeResets = page
    .getByRole("tooltip")
    .filter({ hasText: "3 banked" });
  await expect(claudeResets).toContainText("2 × Use by");
  await expect(claudeResets).toContainText("1 × No expiry");
  await page.getByRole("button", { name: "Show emails" }).click();
  await expect(email).toHaveCSS("filter", "none");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Hide emails" }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(email).toHaveCSS("filter", "none");
  await page.getByRole("button", { name: "Hide emails" }).click();
  await page.reload();
  await expect(email).toHaveCSS("filter", /blur\(/);
});

test("usage accounting, hub settings and request filters", async ({ page }) => {
  const day = new Date().toISOString().slice(0, 10);
  const dateAgo = (days: number) => {
    const date = new Date(`${day}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - days);
    return date.toISOString().slice(0, 10);
  };
  const tokens = {
    input: 200,
    cacheRead: 800,
    cacheWrite: 0,
    output: 60,
    reasoning: 40,
    unclassified: 0,
    total: 1100,
  };
  const cost = {
    min: 0.00148,
    max: 0.00148,
    input: 0.0004,
    cacheRead: 0.00008,
    cacheWrite: 0,
    output: 0.0006,
    reasoning: 0.0004,
    priced: true,
    model: "gpt-6.1-sol",
  };
  await page.request.post("/api/session", {
    data: { token: "browser-test-dashboard-key" },
  });
  await page.route("**/api/state", async (route) => {
    const state = await (await route.fetch()).json();
    await route.fulfill({
      json: {
        ...state,
        daily: Object.fromEntries(
          [0, 10, 40, 100, 400].map((age) => [
            `fixture-${age}`,
            {
              day: dateAgo(age),
              provider: "codex",
              tokens,
              cost,
              requests: 1,
              unpriced: 0,
            },
          ]),
        ),
        hourly: {
          fixture: {
            day,
            hour: `${day}T00:00:00Z`,
            provider: "codex",
            tokens,
            cost,
            requests: 1,
            unpriced: 0,
          },
        },
      },
    });
  });
  const queries: string[] = [];
  await page.route("**/api/requests?*", (route) => {
    queries.push(route.request().url());
    return route.fulfill({
      json: {
        items: [
          {
            id: "request-fixture",
            at: new Date().toISOString(),
            connectionId: "codex",
            keyId: "fixture",
            model: "gpt-6.1-sol",
            accountName: "device@example.com",
            status: 200,
            transport: "WS",
            durationMs: 2000,
            ttftMs: 1000,
            tokens,
            cost,
          },
        ],
        total: 1,
        page: 1,
        pages: 1,
        models: ["gpt-6.1-sol"],
      },
    });
  });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Token breakdown" }),
  ).toHaveText("1.1K");
  await expect(page.getByText("Tracking starts", { exact: false })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Token breakdown" }).hover();
  await expect(page.getByRole("tooltip")).toContainText("Cache read");
  await expect(page.getByRole("tooltip")).toContainText("800");
  const periods = page.getByRole("group", { name: "Usage period" });
  for (const [period, total, cost] of [
    ["Today", "1.1K", "$0.0015"],
    ["30d", "2.2K", "$0.003"],
    ["90d", "3.3K", "$0.0044"],
    ["Year", "4.4K", "$0.0059"],
    ["All time", "5.5K", "$0.0074"],
    ["7d", "1.1K", "$0.0015"],
  ]) {
    await periods.getByRole("button", { name: period, exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Token breakdown" }),
    ).toHaveText(total);
    await expect(
      page.getByRole("button", { name: "Cost breakdown" }),
    ).toHaveText(cost);
    await expect(
      periods.getByRole("button", { name: period, exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
  }
  await expect(page.locator(".recharts-area-curve")).not.toHaveCount(0);
  await expect(page.locator(".recharts-bar")).toHaveCount(0);
  const graph = page
    .getByRole("region", { name: "API usage summary" })
    .locator("[data-chart]")
    .first();
  await graph.hover({ position: { x: 150, y: 30 } });
  await expect(graph.locator(".recharts-tooltip-wrapper")).toContainText(
    "Cache read",
  );
  await expect(graph.locator(".recharts-tooltip-wrapper")).not.toContainText(
    "Invalid Date",
  );
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const auto = page.getByRole("checkbox", {
    name: "Automatically redeem 5 minutes before expiry",
  });
  await expect(auto).not.toBeChecked();
  await auto.check();
  await expect(auto).toBeChecked();
  await expect(page.getByLabel("Hub URL")).toHaveValue(/127\.0\.0\.1:4319/);
  await page
    .getByRole("button", { name: "Generate hub key", exact: true })
    .click();
  await expect(page.getByLabel("Hub management key")).toHaveValue(/^sk-hub-/);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(auto).toBeChecked();
  await auto.uncheck();
  await expect(auto).not.toBeChecked();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "WS", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("device@example.com", { exact: true })).toHaveCSS(
    "filter",
    /blur\(/,
  );
  await page.getByLabel("Search requests").fill("request-fixture");
  await expect.poll(() => queries.at(-1)).toContain("q=request-fixture");
  await page.getByRole("button", { name: "Details", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Request details" }),
  ).toContainText("Cache read");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Usage", exact: true }).click();
  await page.screenshot({
    path: "/tmp/ai-funnel-observability-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/ai-funnel-observability-mobile.png",
    fullPage: true,
  });
});
