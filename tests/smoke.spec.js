import { expect, test } from "@playwright/test";

async function openLocalApp(page) {
  await page.route("**/supabase-config.js", (route) => route.fulfill({
    contentType: "application/javascript",
    body: "window.CAR_SHARE_SUPABASE = { enabled: false, url: '', anonKey: '', ledgerId: 'test-ledger' };"
  }));
  await page.goto("/");
  await expect(page.locator("#tripForm")).toBeVisible();
}

async function chooseFirstSelectOption(select) {
  const options = await select.locator("option").evaluateAll((items) =>
    items.map((item) => item.value).filter(Boolean)
  );
  if (options.length > 0) await select.selectOption(options[0]);
}

test.beforeEach(async ({ page }) => {
  await page.goto("about:blank");
  await page.evaluate(() => localStorage.clear());
});

test("create trip and fuel log, then refresh with data still visible", async ({ page }) => {
  await openLocalApp(page);

  await chooseFirstSelectOption(page.locator("#currentUser"));
  await chooseFirstSelectOption(page.locator("#tripDriver"));
  await page.locator("#tripDate").fill("2026-06-10");
  await page.locator("#startKm").fill("1000");
  await page.locator("#endKm").fill("1042");
  await page.locator("#tripNote").fill("Playwright smoke trip");
  await page.locator("#tripForm").evaluate((form) => form.requestSubmit());

  await expect(page.locator("#tripList")).toContainText("Playwright smoke trip");

  await chooseFirstSelectOption(page.locator("#fuelPayer"));
  await page.locator("#fuelDate").fill("2026-06-10");
  await page.locator("#fuelAmount").fill("321.45");
  await page.locator("#fuelForm").evaluate((form) => form.requestSubmit());

  await expect(page.locator("#fuelList")).toContainText("321.45");

  const beforeReload = await page.evaluate(() => JSON.parse(localStorage.getItem("car-share-ledger-v1")));
  expect(beforeReload.trips).toHaveLength(1);
  expect(beforeReload.fuel).toHaveLength(1);

  await page.reload();
  await expect(page.locator("#tripList")).toContainText("Playwright smoke trip");
  await expect(page.locator("#fuelList")).toContainText("321.45");
});

test("critical runtime modules are loaded before app.js", async ({ page }) => {
  await openLocalApp(page);
  const modules = await page.evaluate(() => ({
    utils: Boolean(window.FuelUtils),
    supabaseHelpers: Boolean(window.FuelSupabaseHelpers),
    dataStore: Boolean(window.FuelDataStore),
    settlementCalculations: Boolean(window.FuelSettlementCalculations),
    uiMessages: Boolean(window.FuelUiMessages),
    notifications: Boolean(window.FuelNotifications),
    adminTools: Boolean(window.FuelAdminTools)
  }));
  expect(modules).toEqual({
    utils: true,
    supabaseHelpers: true,
    dataStore: true,
    settlementCalculations: true,
    uiMessages: true,
    notifications: true,
    adminTools: true
  });
});
