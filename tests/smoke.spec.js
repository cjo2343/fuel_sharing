import { expect, test } from "@playwright/test";

function makeCleanState() {
  return {
    currency: "DKK",
    members: ["Christian", "Emilie", "Jonas", "Marie"],
    trips: [],
    bookings: [],
    fuel: [],
    paymentStatuses: {},
    auditLog: [],
    closedPeriods: [],
    lastOdometer: "",
    memberProfiles: {
      Christian: { email: "", role: "admin", mobilepayPhone: "" },
      Emilie: { email: "", role: "member", mobilepayPhone: "" },
      Jonas: { email: "", role: "member", mobilepayPhone: "" },
      Marie: { email: "", role: "member", mobilepayPhone: "" }
    },
    fuelType: "diesel",
    fuelConsumption: 5.3,
    fuelFallbackPrice: 14.5,
    fuelWarningThreshold: 70,
    fuelPriceWarningRange: { min: 8, max: 25 },
    carSettingsVersion: 2
  };
}

test.beforeEach(async ({ request }) => {
  // The smoke tests run against the real local server.py. Reset the isolated
  // Playwright state file before each test so trips/fuel/payments from one
  // test cannot leak into another test through /api/state.
  await request.put("/api/state", { data: makeCleanState() });
});


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

function decimalPattern(value, fractionDigits = null) {
  const numeric = Number(value);
  const rounded = Number.isFinite(numeric) && fractionDigits !== null
    ? String(Math.round(numeric * (10 ** fractionDigits)) / (10 ** fractionDigits))
    : String(value);
  return rounded.replace(".", "[,.]");
}

function litersDisplayPattern(value) {
  return new RegExp(`${decimalPattern(value, 1)}\\s*L`);
}



function makeSeededPermissionState() {
  return {
    currency: "DKK",
    members: ["Christian", "Emilie"],
    memberProfiles: {
      Christian: { email: "christian@example.com", role: "admin", mobilepayPhone: "" },
      Emilie: { email: "emilie@example.com", role: "member", mobilepayPhone: "" }
    },
    trips: [
      {
        id: "permission-trip-1",
        driver: "Christian",
        date: "2026-06-10",
        startKm: 1000,
        endKm: 1042,
        participants: ["Christian", "Emilie"],
        note: "Christian-owned permission smoke trip"
      }
    ],
    bookings: [],
    fuel: [
      {
        id: "permission-fuel-1",
        payer: "Christian",
        date: "2026-06-10",
        amount: 321.45,
        liters: 20,
        pricePerLiter: 16.0725,
        odometer: 1042,
        station: "Permission Smoke Station",
        fullTank: true
      }
    ],
    paymentStatuses: {},
    auditLog: [],
    currentPeriodId: "permission-period-1",
    closedPeriods: [],
    lastOdometer: 1042,
    fuelType: "diesel",
    fuelConsumption: 5.3,
    fuelFallbackPrice: 14.5,
    fuelWarningThreshold: 70,
    carSettingsVersion: 2
  };
}

async function openLocalAppAsEmilieWithChristianEntries(page) {
  const seededState = makeSeededPermissionState();
  const session = {
    access_token: "test-token",
    user: { email: "emilie@example.com" }
  };

  await page.route("**/supabase-config.js", (route) => route.fulfill({
    contentType: "application/javascript",
    body: "window.CAR_SHARE_SUPABASE = { enabled: true, url: 'https://test.supabase.local', anonKey: 'test-anon-key', ledgerId: 'test-ledger' };"
  }));

  await page.route("**/@supabase/supabase-js@2", (route) => route.fulfill({
    contentType: "application/javascript",
    body: "window.supabase = window.__TEST_SUPABASE__;"
  }));

  await page.addInitScript(({ seededState, session }) => {
    class QueryMock {
      constructor(table) {
        this.table = table;
      }
      select() { return this; }
      eq() { return this; }
      is() { return this; }
      order() { return this; }
      limit() { return this; }
      in() { return this; }
      insert() { return Promise.resolve({ data: null, error: null }); }
      update() { return this; }
      upsert() { return Promise.resolve({ data: null, error: null }); }
      delete() { return Promise.resolve({ data: null, error: null }); }
      maybeSingle() {
        if (this.table === "settlement_periods") return Promise.resolve({ data: null, error: null });
        return Promise.resolve({ data: null, error: null });
      }
      single() {
        if (this.table === "car_share_ledgers") {
          return Promise.resolve({ data: { state: seededState, updated_at: "2026-06-11T00:00:00.000Z" }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      }
      then(resolve) {
        return Promise.resolve({ data: [], error: null }).then(resolve);
      }
    }

    window.__TEST_SUPABASE__ = {
      createClient() {
        return {
          auth: {
            getSession: () => Promise.resolve({ data: { session }, error: null }),
            onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
            signOut: () => Promise.resolve({ error: null })
          },
          from: (table) => new QueryMock(table),
          channel: () => ({ on() { return this; }, subscribe() { return this; } }),
          removeChannel: () => Promise.resolve()
        };
      }
    };
  }, { seededState, session });

  await page.goto("/");
  await expect(page.locator("#tripList")).toContainText("Christian-owned permission smoke trip");
  await expect(page.locator("#fuelList")).toContainText("Permission Smoke Station");
}


async function openClosedPeriodCard(card) {
  await card.evaluate((details) => {
    if (details instanceof HTMLDetailsElement) {
      details.open = true;
      details.dispatchEvent(new Event("toggle", { bubbles: true }));
    }
  });
  await expect(card).not.toHaveAttribute("data-lazy-closed-period", "true");
}

async function requestAllOpenPayments(page) {
  // The settlement UI re-renders after each status change and payment actions
  // may now round-trip through server.py. Keep clicking the first currently
  // available Requested button, then wait for the Close period button to become
  // enabled so tests do not race the async backend action state merge.
  for (let attempts = 0; attempts < 30; attempts += 1) {
    const button = page.locator('button[data-payment-status="requested"]').first();
    if (await button.count() === 0) {
      await expect(page.locator("#closePeriod")).toBeEnabled({ timeout: 5000 });
      return;
    }
    await button.evaluate((element) => element.click());
    await page.waitForTimeout(150);
  }
  throw new Error("Timed out while requesting all open payments");
}

async function createBasicTripAndFuel(page, { note = "Playwright smoke trip", fuelAmount = "321.45", fuelLiters = null } = {}) {
  const effectiveFuelLiters = fuelLiters || String(Math.max(1, Math.round((Number(fuelAmount) / 15) * 100) / 100));
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
  await page.locator("#fuelLiters").fill(effectiveFuelLiters);
  await page.locator("#fuelForm").evaluate((form) => form.requestSubmit());

  const expectedFuelAmount = fuelAmount.replace(".", "[,.]");
  await expect(page.locator("#fuelList")).toContainText(new RegExp(expectedFuelAmount));
  await expect(page.locator("#fuelList")).toContainText(litersDisplayPattern(effectiveFuelLiters));
}


test("fuel logs require liters and configured DKK/L range", async ({ page }) => {
  await openLocalApp(page);

  await chooseFirstSelectOption(page.locator("#currentUser"));
  await chooseFirstSelectOption(page.locator("#fuelPayer"));
  await page.locator("#fuelDate").fill("2026-06-10");
  await page.locator("#fuelAmount").fill("300");

  await expect(page.locator("#fuelLiters")).toBeVisible();
  await expect(page.locator("#fuelLiters")).toHaveAttribute("required", "");
  await page.locator("#fuelForm").evaluate((form) => form.requestSubmit());
  await expect(page.locator("#fuelList")).not.toContainText("300,00 DKK");

  await page.locator("#fuelLiters").fill("5");
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("outside the configured fuel price range");
    await dialog.accept();
  });
  await page.locator("#fuelForm").evaluate((form) => form.requestSubmit());
  await expect(page.locator("#fuelList")).not.toContainText("300,00 DKK");

  await page.locator("#fuelLiters").fill("20");
  await page.locator("#fuelForm").evaluate((form) => form.requestSubmit());
  await expect(page.locator("#fuelList")).toContainText("20 L");
  await expect(page.locator("#fuelList")).toContainText(/15[,.]00 DKK\/L/);
});

test("create, edit, persist, delete booking and reject overlapping booking", async ({ page }) => {
  await openLocalApp(page);

  await page.locator('[data-view-tab="book"]').click();
  await chooseFirstSelectOption(page.locator("#bookingMember"));
  await page.locator("#bookingStart").fill("2026-06-12T09:00");
  await page.locator('[data-booking-duration-hours="4"]').click();
  await expect(page.locator("#bookingEnd")).toHaveValue("2026-06-12T13:00");
  await page.locator("#bookingEnd").fill("2026-06-12T11:00");
  await page.locator("#bookingPurpose").fill("Airport pickup");
  await page.locator("#bookingForm").evaluate((form) => form.requestSubmit());

  await expect(page.locator("#bookingCalendar")).toContainText("Airport pickup");
  await expect(page.locator("#bookingCalendar")).toContainText("Christian");

  const afterBooking = await page.evaluate(() => JSON.parse(localStorage.getItem("car-share-ledger-v1")));
  expect(afterBooking.bookings).toHaveLength(1);
  const bookingId = afterBooking.bookings[0].id;

  await page.reload();
  await page.locator('[data-view-tab="book"]').click();
  await expect(page.locator("#bookingCalendar")).toContainText("Airport pickup");

  await page.locator("#bookingStart").fill("2026-06-12T10:30");
  await page.locator("#bookingEnd").fill("2026-06-12T12:00");
  await page.locator("#bookingPurpose").fill("Overlapping booking");
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("already booked");
    await dialog.accept();
  });
  await page.locator("#bookingForm").evaluate((form) => form.requestSubmit());

  await expect(page.locator("#bookingConflictNotice")).toContainText("Conflicts with");
  const afterOverlap = await page.evaluate(() => JSON.parse(localStorage.getItem("car-share-ledger-v1")));
  expect(afterOverlap.bookings).toHaveLength(1);

  const editButton = page.locator(`[data-edit="bookings:${bookingId}"]`);
  await expect(editButton).toHaveCount(1);
  await editButton.click();
  await page.locator("#bookingPurpose").fill("Airport pickup updated");
  await page.locator("#bookingEnd").fill("2026-06-12T11:30");
  await page.locator("#bookingForm").evaluate((form) => form.requestSubmit());
  await expect(page.locator("#bookingCalendar")).toContainText("Airport pickup updated");

  await page.reload();
  await page.locator('[data-view-tab="book"]').click();
  await expect(page.locator("#bookingCalendar")).toContainText("Airport pickup updated");

  const deleteButton = page.locator(`[data-delete="bookings:${bookingId}"]`);
  await expect(deleteButton).toHaveCount(1);
  await deleteButton.click();
  await expect(page.locator("#bookingCalendar")).not.toContainText("Airport pickup updated");
  const afterDelete = await page.evaluate(() => JSON.parse(localStorage.getItem("car-share-ledger-v1")));
  expect(afterDelete.bookings).toHaveLength(0);
});

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
  await expect(page.locator("#auditLog")).toContainText(/Status: Not requested .* Requested/);

  const reminderButton = page.locator('button[data-payment-reminder="true"]').first();
  if (await reminderButton.count()) {
    await reminderButton.evaluate((button) => button.click());
    await expect(page.locator("#auditLog")).toContainText("Payment reminder sent");
    await expect(page.locator("#auditLog")).toContainText(/Reminder recorded|No active mobile notification subscription|mobile notification/i);
  }

  const reopenButton = page.locator('button[data-payment-status="open"]').first();
  await expect(reopenButton).toHaveCount(1);
  await expect(page.locator("#startKm")).toBeDisabled();
  await expect(page.locator("#fuelAmount")).toBeDisabled();
  await expect(page.locator("body")).toContainText(/reopen/i);

  await reopenButton.evaluate((button) => button.click());
  await expect(page.locator("#auditLog")).toContainText("Payment reopened");
  await expect(page.locator("#auditLog")).toContainText(/Status: Requested .* Not requested/);
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
  await expect(page.locator("#settlementWarning")).toContainText("Request all settlement payments before closing this period.");
  await expect(page.locator("#closePeriod")).toBeDisabled();
  await expect(page.locator("#closePeriod")).toHaveAttribute("title", /Request all settlement payments before closing this period/);

  await requestAllOpenPayments(page);
  await expect(page.locator("#auditLog")).toContainText("Payment requested");
  await expect(page.locator("#auditLog")).toContainText(/Status: Not requested .* Requested/);
  await expect(page.locator("#closePeriod")).toBeEnabled();
  await page.locator("#closePeriod").evaluate((button) => button.click());

  await expect(page.locator("#auditLog")).toContainText("No important changes have been recorded yet.");
  await page.locator('[data-view-tab="history"]').click();
  await expect(page.locator("#periodsHeading")).toContainText("Closed periods");
  await expect(page.locator(".archive-context-note")).toContainText("For unpaid payment follow-up, use the Payments tab.");
  await expect(page.locator("#periodArchiveSummary")).toContainText("Showing");
  const closedPeriodCard = page.locator(".archived-period-card").first();
  await expect(closedPeriodCard).toContainText("Open this period to load final payments, trips, fuel logs, exports, and change log details.");
  await openClosedPeriodCard(closedPeriodCard);
  await expect(closedPeriodCard).toContainText("Change log");
  await expect(closedPeriodCard).toContainText("Trip created");
  await expect(closedPeriodCard).toContainText("Fuel log created");
  await expect(closedPeriodCard).toContainText("Payment requested");
  await expect(closedPeriodCard).toContainText(/Status: Not requested .* Requested/);
  await expect(closedPeriodCard).toContainText("Settlement closed");
  await expect(closedPeriodCard).toContainText("Updates only this payment status and the closed-period change log.");

  await page.locator("#periodSearch").fill("Audit archive smoke trip");
  await expect(page.locator("#periodList")).toContainText("Audit archive smoke trip");
  await page.locator("#periodSearch").fill("no-matching-period");
  await expect(page.locator("#periodList")).toContainText("No closed periods match");
  await page.locator("#clearPeriodFilters").click();
  const resetClosedPeriodCard = page.locator(".archived-period-card").first();
  await openClosedPeriodCard(resetClosedPeriodCard);

  await page.locator('[data-view-tab="payments"]').click();
  await expect(page.locator("#unpaidPaymentSummary")).toContainText("You owe");
  await expect(page.locator("#unpaidPaymentList")).toContainText("pays");
  await expect(page.locator("#unpaidPaymentList")).toContainText("Mark paid");
  await expect(page.locator("#unpaidPaymentList")).toContainText("View closed period");
  await page.locator('[data-view-tab="history"]').click();
  const reopenedClosedPeriodCard = page.locator(".archived-period-card").first();
  await openClosedPeriodCard(reopenedClosedPeriodCard);

  const closedMarkPaid = reopenedClosedPeriodCard.locator('[data-closed-payment-status="paid"]').first();
  await expect(closedMarkPaid).toBeVisible();
  const closedSettlementIndex = Number(await closedMarkPaid.getAttribute("data-closed-settlement-index"));
  await closedMarkPaid.evaluate((button) => button.click());
  const targetClosedPaymentCard = reopenedClosedPeriodCard.locator(".archive-payment-card").nth(closedSettlementIndex);
  await expect(targetClosedPaymentCard).toContainText("Paid after settlement close");
  await expect(targetClosedPaymentCard.locator('button:has-text("Mark paid"):visible')).toHaveCount(0);

  await page.reload();
  await page.locator('[data-view-tab="history"]').click();
  const reloadedClosedPeriodCard = page.locator(".archived-period-card").first();
  await openClosedPeriodCard(reloadedClosedPeriodCard);
  const reloadedPaidClosedPaymentCard = reloadedClosedPeriodCard.locator(".archive-payment-card.paid").first();
  await expect(reloadedPaidClosedPaymentCard).toContainText("Paid after settlement close");
  await expect(reloadedPaidClosedPaymentCard.locator('button:has-text("Mark paid"):visible')).toHaveCount(0);
  await expect(page.locator("[data-archive-csv]")).toHaveCount(1);
  await expect(page.locator("[data-archive-audit-csv]")).toHaveCount(1);
});


test("non-admin members see clear permission messages for entries owned by someone else", async ({ page }) => {
  await openLocalAppAsEmilieWithChristianEntries(page);

  await expect(page.locator("#currentUser")).toHaveValue("Emilie");
  await expect(page.locator("#tripList")).toContainText("Only Christian, the trip creator, or an admin can edit or delete this trip. You are signed in as Emilie.");
  await expect(page.locator("#fuelList")).toContainText("Only Christian, the fuel payer/creator, or an admin can edit or delete this fuel log. You are signed in as Emilie.");
  await expect(page.locator('[data-edit="trips:permission-trip-1"]')).toHaveCount(0);
  await expect(page.locator('[data-delete="trips:permission-trip-1"]')).toHaveCount(0);
  await expect(page.locator('[data-edit="fuel:permission-fuel-1"]')).toHaveCount(0);
  await expect(page.locator('[data-delete="fuel:permission-fuel-1"]')).toHaveCount(0);
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

  const expectedBuildInfo = await page.evaluate(() => window.FuelBuildInfo?.BUILD_INFO);
  expect(expectedBuildInfo).toMatchObject({
    version: expect.any(String),
    buildLabel: expect.any(String),
    expectedServiceWorkerCache: expect.any(String)
  });

  const expectedBuildStrings = [
    expectedBuildInfo.version,
    expectedBuildInfo.buildLabel,
    expectedBuildInfo.expectedServiceWorkerCache
  ];

  await page.locator('[data-view-tab="about"]').click();
  for (const value of expectedBuildStrings) {
    await expect(page.locator("#aboutBuildInfoPanel")).toContainText(value);
  }

  await page.locator('[data-view-tab="admin"]').click();
  for (const value of expectedBuildStrings) {
    await expect(page.locator("#buildInfoPanel")).toContainText(value);
  }
});
