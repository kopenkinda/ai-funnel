import { test, expect } from "@playwright/test";

test("sample workspace is explicit, searchable, and responsive", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByRole("button", { name: "Explore a sample pool" }).click();
  await expect(
    page.getByText("Example accounts and quotas.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("Daily driver", { exact: true }).first(),
  ).toBeVisible();
  await page.getByLabel("Search accounts").fill("Reserve");
  await expect(page.locator("[data-account-row]")).toHaveCount(1);
  await page.getByLabel("Search accounts").clear();
  await page
    .getByRole("button", { name: "Connection details" })
    .first()
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "supports_websockets = false",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.screenshot({ path: "/tmp/ai-funnel-desktop.png", fullPage: true });
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
  await navigation
    .getByRole("button", { name: "Account pool", exact: true })
    .click();
  await expect(
    page.getByText("Daily driver", { exact: true }).first(),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("connect a pool, create a scoped key, pause it, and remove the connection", async ({
  page,
  request,
}) => {
  await request.post("/api/session", {
    data: { token: "browser-test-dashboard-key" },
  });
  const state = await (await request.get("/api/state")).json();
  for (const c of state.connections)
    await request.delete(`/api/connections/${c.id}`);
  for (const k of state.keys) await request.delete(`/api/keys/${k.id}`);
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
    page.getByText("Browser test account", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByText("73", { exact: false }).first()).toBeVisible();
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
  await page.goto("/");
  await page.getByRole("button", { name: "Explore a sample pool" }).click();
  await page
    .getByRole("button", { name: "Connection details" })
    .first()
    .click();
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
