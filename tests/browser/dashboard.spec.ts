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
  await page.getByRole("link", { name: "Connections", exact: true }).click();
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
  await page.getByRole("link", { name: "Connections", exact: true }).click();
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
  await page.getByRole("link", { name: "API keys", exact: true }).click();
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
    page.getByRole("link", { name: "Usage", exact: true }),
  ).toBeVisible();
});

test("dashboard routes survive refresh, direct links, and browser history", async ({
  page,
}) => {
  await page.goto("/keys");
  await page
    .getByLabel("Dashboard key", { exact: true })
    .fill("browser-test-dashboard-key");
  await page.getByRole("button", { name: "Unlock dashboard" }).click();
  await expect(page).toHaveURL(/\/keys$/);
  await expect(
    page.getByRole("heading", { name: "API keys", exact: true }),
  ).toBeVisible();

  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  await navigation
    .getByRole("link", { name: "Connections", exact: true })
    .click();
  await expect(page).toHaveURL(/\/connections$/);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Connections", exact: true }),
  ).toBeVisible();
  await navigation.getByRole("link", { name: "Activity", exact: true }).click();
  await expect(page).toHaveURL(/\/activity$/);
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "Connections", exact: true }),
  ).toBeVisible();
  await page.goForward();
  await expect(
    page.getByRole("heading", { name: "Activity", exact: true }),
  ).toBeVisible();

  for (const [path, title] of [
    ["/usage", "Usage"],
    ["/keys", "API keys"],
    ["/activity", "Activity"],
  ]) {
    await page.goto(path);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
    await expect(
      navigation.getByRole("link", { name: title, exact: true }),
    ).toHaveAttribute("aria-current", "page");
  }
  await page.goto("/missing-page");
  await expect(page).toHaveURL(/\/usage$/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/usage$/);
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

test("key access can be edited, archived, and restored with the same credential", async ({
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
  await page.getByRole("link", { name: "API keys", exact: true }).click();
  await page
    .getByRole("button", { name: "Select Editable devices", exact: true })
    .click();
  const dialog = page.getByRole("form", { name: "API key settings" });
  await expect(dialog.getByLabel("Key name", { exact: true })).toHaveValue(
    "Editable devices",
  );
  await expect(dialog.getByLabel("Requests per day")).toHaveValue("50");
  const subscriptionOnly = dialog.getByRole("checkbox", {
    name: "Subscription only",
    exact: true,
  });
  await expect(subscriptionOnly).not.toBeChecked();
  await subscriptionOnly.check();
  await dialog.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(subscriptionOnly).not.toBeChecked();
  await subscriptionOnly.check();
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeDisabled();
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
    {
      connectionId: "codex",
      accountIds: null,
      models: [models[1]],
      subscriptionOnly: true,
    },
    { connectionId: "claude", accountIds: null, models: null },
  ]);
  await page.reload();
  await page.getByRole("link", { name: "API keys", exact: true }).click();
  await page
    .getByRole("button", { name: "Select Coding tools", exact: true })
    .click();
  await expect(dialog.getByLabel("Selected models")).toContainText(models[1]);
  await expect(subscriptionOnly).toBeChecked();
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
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .getByRole("button", { name: "Archive Coding tools", exact: true })
    .click();
  const confirmation = page.getByRole("alertdialog", { name: "Archive key?" });
  await expect(confirmation).toBeVisible();
  await confirmation
    .getByRole("button", { name: "Archive key", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Select Coding tools", exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("region", { name: "Lifetime cost by API key" })
      .getByRole("listitem")
      .filter({ hasText: "Coding tools" }),
  ).toContainText("Archived");
  await page.reload();
  await page.getByRole("link", { name: "API keys", exact: true }).click();
  const filter = page.getByRole("group", { name: "Key status" });
  await filter.getByRole("button", { name: /^Archived/ }).click();
  await page
    .getByRole("button", { name: "Select Coding tools", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Coding tools", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("switch", { name: /Coding tools/ })).toHaveCount(
    0,
  );
  await expect(
    dialog.getByRole("checkbox", { name: "All models", exact: true }),
  ).toBeChecked();
  expect(
    (
      await request.get("/providers/codex/codex/v1/models", {
        headers: { Authorization: `Bearer ${created.token}` },
      })
    ).status(),
  ).toBe(401);
  await page.screenshot({
    path: "/tmp/ai-funnel-archived-key-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/ai-funnel-archived-key-mobile.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Restore Coding tools", exact: true })
    .click();
  await expect(
    page.getByText("No archived keys", { exact: true }),
  ).toBeVisible();
  await filter.getByRole("button", { name: "Current", exact: true }).click();
  const resume = page.getByRole("switch", {
    name: "Resume Coding tools",
    exact: true,
  });
  await expect(resume).not.toBeChecked();
  expect(
    (
      await request.get("/providers/codex/codex/v1/models", {
        headers: { Authorization: `Bearer ${created.token}` },
      })
    ).status(),
  ).toBe(401);
  await resume.click();
  expect(
    (
      await request.get("/providers/codex/codex/v1/models", {
        headers: { Authorization: `Bearer ${created.token}` },
      })
    ).status(),
  ).toBe(200);
});

test("lifetime key charts rank cost and tokens independently", async ({
  page,
}) => {
  const createdAt = new Date().toISOString();
  const keys = ["Laptop@example.com", "Terminal", "Unused"].map(
    (name, index) => ({
      id: `key-${index}`,
      name,
      prefix: "sk-test-",
      enabled: index !== 1,
      archivedAt: index === 1 ? createdAt : null,
      expiresAt: null,
      dailyLimit: null,
      grants: [{ connectionId: "codex", accountIds: null, models: null }],
      imported: false,
      createdAt,
      lastUsedAt: null,
      requestsToday: 0,
    }),
  );
  const totals = (total: number, min: number, max = min, unpriced = 0) => ({
    tokens: {
      input: total,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      reasoning: 0,
      unclassified: 0,
      total,
    },
    cost: {
      min,
      max,
      input: min,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      reasoning: 0,
      priced: true,
    },
    requests: 1,
    unpriced,
  });
  const keyUsage = {
    "key-0": totals(1_000_000, 6),
    "key-1": totals(3_000_000, 2),
  };
  await page.route("**/api/connections/codex/models", (route) =>
    route.fulfill({ json: { data: [{ id: "gpt-6.1-sol" }] } }),
  );
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route("**/api/session", (route) =>
    route.fulfill({ json: { authenticated: true } }),
  );
  await page.route("**/api/state", (route) =>
    route.fulfill({
      json: {
        connections: [
          {
            id: "codex",
            provider: "codex",
            name: "Codex",
            enabled: true,
            accounts: [],
            models: [],
            createdAt,
            syncedAt: null,
            error: null,
          },
        ],
        keys,
        keyUsage,
        requests: [],
        publicUrl: "",
      },
    }),
  );
  await page.goto("/");
  await page.getByRole("link", { name: "API keys", exact: true }).click();
  const cost = page.getByRole("region", { name: "Lifetime cost by API key" });
  const tokens = page.getByRole("region", {
    name: "Lifetime tokens by API key",
  });
  await expect(cost.getByRole("listitem").first()).toContainText("$6.00 · 75%");
  await expect(tokens.getByRole("listitem").first()).toContainText("Terminal");
  await expect(tokens.getByRole("listitem").first()).toContainText("3M · 75%");
  await expect(cost.getByText("Laptop@example.com", { exact: true })).toHaveCSS(
    "filter",
    /blur\(/,
  );
  await expect(cost.getByText(/sk-test/)).toHaveCount(0);
  await expect(
    cost.getByRole("progressbar", { name: "Laptop@example.com cost share" }),
  ).toHaveAttribute("aria-valuenow", "75");
  await expect(cost.getByRole("listitem").last()).toContainText("$0.00 · 0%");
  await cost.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "/tmp/ai-funnel-key-usage-desktop.png",
    fullPage: true,
  });
  await page
    .getByRole("region", { name: "Lifetime API key usage" })
    .screenshot({ path: "/tmp/ai-funnel-key-comparison.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await cost.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "/tmp/ai-funnel-key-usage-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  keyUsage["key-0"] = totals(1_000_000, 6, 8);
  keyUsage["key-1"] = totals(3_000_000, 0, 0, 1);
  await page.reload();
  await page.getByRole("link", { name: "API keys", exact: true }).click();
  await expect(cost.getByRole("listitem").first()).toContainText(
    "$6.00 to $8.00 · ≈100%",
  );
  await expect(cost.getByText("Unpriced", { exact: true })).toBeVisible();
});

test("usage orders reported limits and persists email privacy", async ({
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
                  { label: "Code review 7d", remaining: 92, resetsAt: null },
                  { label: "7d", remaining: 73, resetsAt: null },
                  { label: "Monthly", remaining: null, resetsAt: null },
                  { label: "5h", remaining: 81, resetsAt: null },
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
                quotas: [
                  { label: "Fable 7d", remaining: 0, resetsAt: null },
                  { label: "30d", remaining: 60, resetsAt: null },
                  { label: "7d", remaining: 73, resetsAt: null },
                  { label: "5h", remaining: 81, resetsAt: null },
                ],
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
  await expect(codex.getByText("Monthly usage", { exact: true })).toHaveCount(
    0,
  );
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
  for (const [provider, labels, titles] of [
    [
      codex,
      ["5h", "7d", "Code review 7d"],
      ["5-hour usage", "Weekly usage", "Code review weekly usage"],
    ],
    [
      claude,
      ["5h", "7d", "Fable 7d", "30d"],
      ["5-hour usage", "Weekly usage", "Fable weekly usage", "Monthly usage"],
    ],
  ] as const) {
    await expect(provider.locator('[data-slot="card-title"]')).toHaveText([
      ...titles,
    ]);
    expect(
      await provider
        .getByRole("progressbar")
        .evaluateAll((bars) =>
          bars.map((bar) => bar.getAttribute("aria-label")),
        ),
    ).toEqual(labels.map((label) => `Account ${label} remaining`));
  }
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

test("account rows keep plans inline and only show exceptional statuses", async ({
  page,
}) => {
  const at = new Date().toISOString();
  const quota = [
    {
      label: "7d",
      remaining: 73,
      resetsAt: new Date(Date.now() + 86400000).toISOString(),
    },
  ];
  const account = (
    id: string,
    plan: string,
    status = "active",
    planTier?: string,
  ) => ({
    id,
    name: `${id}@example.com`,
    email: `${id}@example.com`,
    plan,
    planTier,
    status,
    quotas: quota,
  });
  const credit = (id: string, hours?: number) => ({
    id,
    status: "available",
    expires_at:
      hours === undefined
        ? undefined
        : new Date(Date.now() + hours * 3600000).toISOString(),
    resets_left: 1,
  });
  const codexCredits = {
    available: 2,
    items: [credit("later", 48), credit("next", 1.5), credit("expired", -1)],
  };
  const claudeCredits = { available: 1, items: [credit("grant")] };
  const resetRequests: { creditId: string; requestId: string }[] = [];
  const connections = [
    {
      id: "codex",
      provider: "codex",
      name: "Codex",
      enabled: true,
      models: [],
      createdAt: at,
      error: null,
      accounts: [
        account("free", "free"),
        account("plus", "plus"),
        account("business", "team", "paused"),
        {
          ...account("pro100", "prolite", "rate_limited"),
          resetCredits: codexCredits,
        },
        account("pro200", "pro", "error"),
        account("pro500", "promax"),
        { ...account("quota", "plus"), quotaError: "Lookup failed" },
      ],
    },
    {
      id: "claude",
      provider: "claude",
      name: "Claude",
      enabled: true,
      models: [],
      createdAt: at,
      error: null,
      accounts: [
        account("claudepro", "pro"),
        account("max5", "claude_max", "active", "default_claude_max_5x"),
        {
          ...account("max20", "claude_max", "active", "default_claude_max_20x"),
          resetCredits: claudeCredits,
        },
        account("unknown", "Subscription"),
      ],
    },
  ];
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route("**/api/session", (route) =>
    route.fulfill({ json: { authenticated: true } }),
  );
  await page.route("**/api/state", (route) =>
    route.fulfill({
      json: { connections, keys: [], requests: [], publicUrl: "" },
    }),
  );
  await page.route("**/api/accounts/*/reset", (route) => {
    const body = route.request().postDataJSON();
    resetRequests.push(body);
    if (body.creditId === "next") {
      codexCredits.items = codexCredits.items.filter(
        (credit) => credit.id !== "next",
      );
      codexCredits.available--;
    } else {
      claudeCredits.items = [];
      claudeCredits.available = 0;
    }
    return route.fulfill({ json: { result: "reset" } });
  });
  await page.goto("/usage");
  const codex = page.getByRole("table", {
    name: "Codex accounts",
    exact: true,
  });
  const claude = page.getByRole("table", {
    name: "Claude accounts",
    exact: true,
  });
  await expect(codex.getByRole("columnheader")).toHaveText([
    "Account",
    "Quota",
    "Actions",
  ]);
  await expect(codex.getByText(/^ID /)).toHaveCount(0);
  await expect(codex.getByText("Active", { exact: true })).toHaveCount(0);
  await expect(
    codex.getByRole("img", { name: "Free", exact: true }),
  ).toBeVisible();
  await expect(
    codex.getByRole("img", { name: "Plus · 1×", exact: true }),
  ).toHaveCount(2);
  await expect(
    codex.getByRole("img", { name: "Business · 1×", exact: true }),
  ).toBeVisible();
  await expect(
    codex.getByRole("img", { name: "Pro 100 · 5×", exact: true }),
  ).toBeVisible();
  await expect(
    codex.getByRole("img", { name: "Pro 200 · 10×", exact: true }),
  ).toBeVisible();
  const pro500 = codex.getByRole("img", { name: "Pro 500 · 20×", exact: true });
  await pro500.focus();
  await expect(page.getByRole("tooltip")).toHaveText("Pro 500 · 20×");
  await pro500.press("Escape");
  for (const status of [
    "Paused",
    "Rate limited",
    "Error",
    "Quota unavailable",
  ]) {
    const text = codex.getByText(status, { exact: true });
    await expect(text).toBeVisible();
    await expect(text.locator("..").getByText(/@example.com/)).toHaveCount(1);
    await expect(text).not.toHaveAttribute("data-slot", "badge");
  }
  await expect(
    claude.getByRole("img", { name: "Pro · 1×", exact: true }),
  ).toBeVisible();
  await expect(
    claude.getByRole("img", { name: "Max · 5×", exact: true }),
  ).toBeVisible();
  await expect(
    claude.getByRole("img", { name: "Max · 20×", exact: true }),
  ).toBeVisible();
  await expect(
    claude.getByRole("img", { name: "Subscription", exact: true }),
  ).toBeVisible();
  await expect(codex.getByRole("link")).toHaveCount(0);
  await expect(
    codex.getByRole("button", { name: "Use reset", exact: true }),
  ).toHaveCount(1);
  const codexReset = codex
    .getByRole("row")
    .filter({ hasText: "pro100@example.com" })
    .getByRole("cell")
    .last();
  await expect(codexReset).toContainText("Expires in 1h");
  await codexReset
    .getByRole("button", { name: "Use reset", exact: true })
    .click();
  await expect(codexReset).toContainText("Expires in 2d");
  expect(resetRequests[0].creditId).toBe("next");
  expect(resetRequests[0].requestId).toMatch(/^[a-f0-9-]{36}$/);
  const claudeReset = claude
    .getByRole("row")
    .filter({ hasText: "max20@example.com" })
    .getByRole("cell")
    .last();
  await expect(claudeReset).toContainText("No expiry");
  await claudeReset
    .getByRole("button", { name: "Use reset", exact: true })
    .click();
  await expect(claudeReset.getByRole("button")).toHaveCount(0);
  expect(resetRequests[1].creditId).toBe("grant");
  await page.getByRole("heading", { name: "Usage", exact: true }).click();
  await page.screenshot({
    path: "/tmp/ai-funnel-account-rows-desktop.png",
    fullPage: true,
  });
  connections[1].enabled = false;
  await page.reload();
  await expect(claude.getByText("Paused", { exact: true })).toHaveCount(4);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/ai-funnel-account-rows-mobile.png",
    fullPage: true,
  });
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
  await page.getByRole("link", { name: "Activity", exact: true }).click();
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
  await page.getByRole("link", { name: "Usage", exact: true }).click();
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

test("usage summary filters by provider and maps upcoming resets", async ({
  page,
}) => {
  const at = (hours: number) =>
    new Date(Date.now() + hours * 3600000).toISOString();
  const account = (id: string, quotas: unknown[], items: unknown[] = []) => ({
    id,
    name: `${id}@example.com`,
    email: `${id}@example.com`,
    plan: "Plus",
    status: "active",
    quotas,
    resetCredits: { available: items.length, applicable: 0, items },
  });
  const connection = {
    enabled: true,
    models: [],
    syncedAt: null,
    error: null,
    createdAt: new Date().toISOString(),
    hasApiKey: true,
    hasManagementAccess: true,
  };
  const hour = new Date();
  hour.setUTCMinutes(0, 0, 0);
  const usage = (provider: string, total: number) => ({
    day: hour.toISOString().slice(0, 10),
    hour: hour.toISOString(),
    provider,
    requests: 1,
    unpriced: 0,
    tokens: {
      input: total,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      reasoning: 0,
      unclassified: 0,
      total,
    },
    cost: {
      min: 0,
      max: 0,
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      reasoning: 0,
      priced: true,
    },
  });
  await page.route("**/api/session", (route) =>
    route.fulfill({ json: { authenticated: true } }),
  );
  await page.route("**/api/state", (route) =>
    route.fulfill({
      json: {
        keys: [],
        requests: [],
        publicUrl: "",
        daily: {},
        hourly: {
          codex: usage("codex", 1000),
          claude: usage("claude", 3000),
        },
        connections: [
          {
            ...connection,
            id: "codex",
            provider: "codex",
            name: "Codex",
            accounts: [
              account("a", [
                { label: "5h", remaining: 60, resetsAt: at(1.5) },
                { label: "7d", remaining: 60, resetsAt: at(140) },
              ]),
            ],
          },
          {
            ...connection,
            id: "claude",
            provider: "claude",
            name: "Claude",
            accounts: [
              account(
                "b",
                [
                  { label: "5h", remaining: 60, resetsAt: at(1.6) },
                  { label: "Fable 7d", remaining: 60, resetsAt: at(9) },
                  { label: "30d", remaining: 60, resetsAt: at(15) },
                ],
                [
                  {
                    id: "x",
                    status: "available",
                    resets_left: 1,
                    expires_at: at(6),
                  },
                ],
              ),
            ],
          },
        ],
      },
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Today" }).click();
  const summary = page.getByRole("region", { name: "API usage summary" });
  const timeline = summary.getByRole("group", {
    name: "Resets in the next 22 hours",
  });
  await expect(
    timeline
      .getByRole("button")
      .evaluateAll((marks) =>
        marks.map((mark) => mark.getAttribute("aria-label")!.split(" at ")[0]),
      ),
  ).resolves.toEqual([
    "5-hour reset",
    "Banked reset expires",
    "Weekly reset",
    "Monthly reset",
  ]);
  await expect(
    timeline.getByRole("button", { name: /^5-hour reset/ }),
  ).toHaveAccessibleName(/2 accounts$/);
  const tokens = summary.getByRole("button", { name: "Token breakdown" });
  await expect(tokens).toHaveText("4K");
  await summary.getByRole("button", { name: "Claude" }).click();
  await expect(tokens).toHaveText("3K");
  await expect(summary.getByText("Today · Claude").first()).toBeVisible();
  await expect(
    timeline.getByRole("button", { name: /^5-hour reset/ }),
  ).toHaveAccessibleName(/1 account$/);
  await summary.getByRole("button", { name: "Codex" }).click();
  await expect(tokens).toHaveText("4K");
  await summary.getByRole("button", { name: "Claude" }).click();
  await expect(tokens).toHaveText("1K");
  await expect(timeline.getByRole("button")).toHaveCount(1);
  await summary.getByRole("button", { name: "Codex" }).click();
  await expect(tokens).toHaveText("4K");
  await expect(timeline.getByRole("button")).toHaveCount(4);
});
