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


async function requestAllOpenPayments(page) {
  // The settlement UI re-renders after each status change, so do not iterate
  // through a stale locator index list. Keep clicking the first currently
  // available Requested button until none remain.
  for (let attempts = 0; attempts < 20; attempts += 1) {
    const button = page.locator('button[data-payment-status="requested"]').first();
    if (await button.count() === 0) return;
    await button.evaluate((element) => element.click());
    await page.waitForTimeout(25);
  }
  throw new Error("Timed out while requesting all open payments");
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

  const expectedFuelAmount = fuelAmount.replace(".", "[,.]");
  await expect(page.locator("#fuelList")).toContainText(new RegExp(expectedFuelAmount));
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
  await expect(page.locator("#auditLog")).toContainText("Trip created");
  await expect(page.locator("#auditLog")).toContainText("Fuel log created");
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
  await expect(page.locator("#auditLog")).toContainText("Payment requested");

  const reopenButton = page.locator('button[data-payment-status="open"]').first();
  await expect(reopenButton).toHaveCount(1);
  await expect(page.locator("#startKm")).toBeDisabled();
  await expect(page.locator("#fuelAmount")).toBeDisabled();
  await expect(page.locator("body")).toContainText(/reopen/i);

  await reopenButton.evaluate((button) => button.click());
  await expect(page.locator("#auditLog")).toContainText("Payment reopened");
  await expect(page.locator("#startKm")).toBeEnabled();
  await expect(page.locator("#fuelAmount")).toBeEnabled();
});


test("period-aware audit log clears current history and freezes closed-period history", async ({ page }) => {
  await openLocalApp(page);
  page.on("dialog", (dialog) => dialog.accept());

  await createBasicTripAndFuel(page, { note: "Audit reset smoke trip", fuelAmount: "111.11" });
  await expect(page.locator("#auditLog")).toContainText("Trip created");
  await expect(page.locator("#auditLog")).toContainText("Fuel log created");

  await page.locator("#resetPeriod").evaluate((button) => button.click());
  await expect(page.locator("#auditLog")).toContainText("No important changes have been recorded yet.");
  await expect(page.locator("#tripList")).not.toContainText("Audit reset smoke trip");
  await expect(page.locator("#fuelList")).not.toContainText(/111[,.]11/);

  await createBasicTripAndFuel(page, { note: "Audit archive smoke trip", fuelAmount: "222.22" });
  await expect(page.locator("#auditLog")).toContainText("Trip created");
  await expect(page.locator("#auditLog")).toContainText("Fuel log created");

  await requestAllOpenPayments(page);
  await expect(page.locator("#auditLog")).toContainText("Payment requested");
  await page.locator("#closePeriod").evaluate((button) => button.click());

  await expect(page.locator("#auditLog")).toContainText("No important changes have been recorded yet.");
  await page.locator('[data-view-tab="history"]').click();
  await expect(page.locator("#periodList")).toContainText("Change log");
  await expect(page.locator("#periodArchiveSummary")).toContainText("Showing");
  await page.locator("#periodSearch").fill("Audit archive smoke trip");
  await expect(page.locator("#periodList")).toContainText("Audit archive smoke trip");
  await page.locator("#periodSearch").fill("no-matching-period");
  await expect(page.locator("#periodList")).toContainText("No closed periods match");
  await page.locator("#clearPeriodFilters").click();
  await expect(page.locator("#periodList")).toContainText("Trip created");
  await expect(page.locator("#periodList")).toContainText("Fuel log created");
  await expect(page.locator("#periodList")).toContainText("Payment requested");
  await expect(page.locator("#periodList")).toContainText("Settlement closed");
  await expect(page.locator("[data-archive-csv]")).toHaveCount(1);
  await expect(page.locator("[data-archive-audit-csv]")).toHaveCount(1);
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
    auditLog: Boolean(window.FuelAuditLog),
    notifications: Boolean(window.FuelNotifications),
    adminTools: Boolean(window.FuelAdminTools),
    buildInfo: Boolean(window.FuelBuildInfo)
  }));
  expect(modules).toEqual({
    utils: true,
    supabaseHelpers: true,
    dataStore: true,
    settlementCalculations: true,
    uiMessages: true,
    auditLog: true,
    notifications: true,
    adminTools: true,
    buildInfo: true
  });
});


test("build info is visible to all users in About and admin panels", async ({ page }) => {
  await openLocalApp(page);
  await page.evaluate(() => window.FuelBuildInfo?.refreshBuildInfo?.());

  await page.locator('[data-view-tab="about"]').click();
  await expect(page.locator("#aboutBuildInfoPanel")).toContainText("2026.06.11.4");
  await expect(page.locator("#aboutBuildInfoPanel")).toContainText("safari-csv-fallback-panel");
  await expect(page.locator("#aboutBuildInfoPanel")).toContainText("fuel-ledger-v23");

  await page.locator('[data-view-tab="admin"]').click();
  await expect(page.locator("#buildInfoPanel")).toContainText("2026.06.11.4");
  await expect(page.locator("#buildInfoPanel")).toContainText("safari-csv-fallback-panel");
  await expect(page.locator("#buildInfoPanel")).toContainText("fuel-ledger-v23");
});
