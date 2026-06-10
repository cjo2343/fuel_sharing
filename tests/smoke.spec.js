import { expect, test } from "@playwright/test";

async function openLocalApp(page) {
  await page.route("**/supabase-config.js", (route) => route.fulfill({
    contentType: "application/javascript",
    body: "window.CAR_SHARE_SUPABASE = { enabled: false, url: '', anonKey: '', ledgerId: 'test-ledger' };"
  }));

  await page.goto("/");

  // localStorage is only available after navigating to an HTTP origin.
  // Do not clear it from about:blank; WebKit/Chromium can throw SecurityError.
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  await expect(page.locator("#tripForm")).toBeVisible();
  await expect(page.locator("#startKm")).toBeEnabled();
}

async function chooseFirstSelectOption(select) {
  const options = await select.locator("option").evaluateAll((items) =>
    items.map((item) => item.value).filter(Boolean)
  );
  if (options.length > 0) await select.selectOption(options[0]);
}

async function createBasicTripAndFuel(page, { note = "Playwright smoke trip", fuelAmount = "321.45" } = {}) {
  await chooseFirstSelectOption(page.locator("#currentUser"));
  await chooseFirstSelectOption(page.locator("#tripDriver"));
  await page.locator("#tripDate").fill("2026-06-10");
  await page.locator("#startKm").fill("1000");
  await page.locator("#endKm").fill("1042");
  await page.locator("#tripNote").fill(note);
  await page.locator("#tripForm").evaluate((form) => form.requestSubmit());

  await expect(page.locator("#tripList")).toContainText(note);

  await chooseFirstSelectOption(page.locator("#fuelPayer"));
  await page.locator("#fuelDate").fill("2026-06-10");
  await page.locator("#fuelAmount").fill(fuelAmount);
  await page.locator("#fuelForm").evaluate((form) => form.requestSubmit());

  await expect(page.locator("#fuelList")).toContainText(/321[,.]45/);
}

test("create trip and fuel log, then refresh with data still visible", async ({ page }) => {
  await openLocalApp(page);

  await createBasicTripAndFuel(page);

  const beforeReload = await page.evaluate(() => JSON.parse(localStorage.getItem("car-share-ledger-v1")));
  expect(beforeReload.trips).toHaveLength(1);
  expect(beforeReload.fuel).toHaveLength(1);

  await page.reload();
  await expect(page.locator("#tripList")).toContainText("Playwright smoke trip");
  await expect(page.locator("#fuelList")).toContainText(/321[,.]45/);
});

test("requested payments lock settlement-affecting trip and fuel changes until reopened", async ({ page }) => {
  await openLocalApp(page);
  page.on("dialog", (dialog) => dialog.accept());

  await createBasicTripAndFuel(page, { note: "Payment lock smoke trip" });

  const requestButton = page.locator('button[data-payment-status="requested"]').first();
  await expect(requestButton).toHaveCount(1);
  // Settlement controls can be inside a collapsed/compact section in the UI.
  // Click the DOM button directly so this test verifies behavior, not layout visibility.
  await requestButton.evaluate((button) => button.click());

  const reopenButton = page.locator('button[data-payment-status="open"]').first();
  await expect(reopenButton).toHaveCount(1);
  await expect(page.locator("#startKm")).toBeDisabled();
  await expect(page.locator("#fuelAmount")).toBeDisabled();
  await expect(page.locator("body")).toContainText(/reopen/i);

  await reopenButton.evaluate((button) => button.click());
  await expect(page.locator("#startKm")).toBeEnabled();
  await expect(page.locator("#fuelAmount")).toBeEnabled();
});

test("critical runtime modules are loaded before app.js", async ({ page }) => {
  await openLocalApp(page);
  const modules = await page.evaluate(() => ({
    // utils.js and settlement-calculations.js currently expose classic global functions,
    // while the newer modules expose window.Fuel* namespaces.
    utils: typeof window.formatMoney === "function" && typeof window.escapeHtml === "function",
    supabaseHelpers: Boolean(window.FuelSupabaseHelpers),
    dataStore: Boolean(window.FuelDataStore),
    settlementCalculations: typeof window.calculateLedger === "function" && typeof window.buildSettlements === "function",
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
