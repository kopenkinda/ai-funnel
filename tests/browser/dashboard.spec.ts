import { test, expect, type Page } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  await request.post("/api/session", {
    data: { token: "browser-test-dashboard-key" },
  });
  const state = await (await request.get("/api/state")).json();
  for (const c of state.connections)
    await request.delete(`/api/connections/${c.id}`);
  for (const k of state.keys) await request.delete(`/api/keys/${k.id}`);
});

async function openConnectedPool(page: Page) {
  await page.request.post("/api/session", {
    data: { token: "browser-test-dashboard-key" },
  });
  const response = await page.request.post("/api/connections", {
    data: {
      provider: "codex",
      name: "Browser test pool",
      url: "http://127.0.0.1:4320",
      password: "test-password",
    },
  });
  expect(response.ok()).toBe(true);
  await page.goto("/");
}

test("quota charts distinguish exhausted and unknown limits and remain responsive", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openConnectedPool(page);
  await expect(
    page.getByRole("heading", { name: "Codex usage", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Claude usage", exact: true }),
  ).toHaveCount(0);
  const shortWindow = page.getByRole("region", {
    name: "5-hour usage",
    exact: true,
  });
  const weeklyWindow = page.getByRole("region", {
    name: "Weekly usage",
    exact: true,
  });
  await expect(shortWindow.getByText("36.5%", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Monthly usage", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Browser test account", { exact: true }),
  ).not.toBeVisible();
  await shortWindow.hover();
  const tooltip = page.getByRole("tooltip");
  await expect(
    tooltip.getByText("Browser test account", { exact: true }),
  ).toBeVisible();
  await expect(tooltip.getByText("0%", { exact: true })).toBeVisible();
  await expect(
    tooltip.getByText("Unavailable account", { exact: true }),
  ).toHaveCount(0);
  await expect(tooltip).toContainText("63.5% used");
  await page.screenshot({
    path: "/tmp/ai-funnel-tooltip-light.png",
    fullPage: true,
    animations: "disabled",
  });
  await weeklyWindow.hover();
  await expect(tooltip).toHaveCount(0);
  await expect(
    weeklyWindow.getByText("Unavailable", { exact: true }),
  ).toBeVisible();
  await shortWindow.focus();
  await expect(
    tooltip.getByText("Browser test account", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tooltip).toHaveCount(0);
  await shortWindow.blur();
  await page.mouse.move(1, 1);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: "/tmp/ai-funnel-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await page.screenshot({
    path: "/tmp/ai-funnel-desktop-dark.png",
    fullPage: true,
  });
  await shortWindow.hover();
  await expect(tooltip).toBeVisible();
  await page.screenshot({
    path: "/tmp/ai-funnel-tooltip-dark.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.mouse.move(1, 1);
  await expect(tooltip).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "/tmp/ai-funnel-mobile.png", fullPage: true });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  await navigation
    .getByRole("button", { name: "Connections", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Connections", exact: true }),
  ).toBeVisible();
  await navigation.getByRole("button", { name: "Usage", exact: true }).click();
  await expect(shortWindow).toBeVisible();
  expect(errors).toEqual([]);
});

test("connect a pool, create a scoped key, pause it, and remove the connection", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Dashboard key").fill("browser-test-dashboard-key");
  await page.getByRole("button", { name: "Unlock dashboard" }).click();
  await page
    .getByRole("button", { name: "Connect your first provider" })
    .click();
  await page.getByLabel("Connection name").fill("Browser test pool");
  await page.getByLabel("Server URL").fill("http://127.0.0.1:4320");
  await page.getByLabel("codex-lb password").fill("test-password");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Connect provider", exact: true })
    .click();
  await expect(
    page
      .getByRole("region", { name: "5-hour usage", exact: true })
      .getByText("36.5%", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "API keys", exact: true }).click();
  await page.getByRole("button", { name: "Add shared key" }).click();
  await page.getByLabel("Key name").fill("Browser device");
  await page.getByRole("checkbox", { name: /Browser test pool/ }).check();
  await page
    .getByRole("checkbox", { name: "Allow the whole account pool" })
    .uncheck();
  await page.getByRole("checkbox", { name: "Browser test account" }).check();
  await page
    .getByRole("button", { name: "Create key", exact: true })
    .last()
    .click();
  await expect(page.getByText("Your key is ready")).toBeVisible();
  const token = await page
    .getByLabel("New API key")
    .locator("code")
    .textContent();
  expect(token).toMatch(/^sk-af-/);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Pause Browser device" }).click();
  await expect(
    page.getByLabel("Key Browser device").getByText("Paused", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "View access" }).click();
  await expect(page.getByLabel("Access for Browser device")).toContainText(
    "Browser test account",
  );
  await page.reload();
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await expect(
    page.getByText("Browser test pool", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Remove Browser test pool" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Remove connection", exact: true })
    .click();
  await expect(page.getByText("Bring your accounts together.")).toBeVisible();
});

test("reduced motion disables movement and dialogs retain keyboard focus", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openConnectedPool(page);
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await page.getByRole("button", { name: "URL & setup", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Copy URL", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    dialog.getByRole("button", { name: "Close", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "Copy URL", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(
    await page
      .getByRole("button", { name: "Connect provider", exact: true })
      .first()
      .evaluate((el) => parseFloat(getComputedStyle(el).transitionDuration)),
  ).toBeLessThan(0.001);
});
