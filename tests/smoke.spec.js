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
    fuelTankCapacity: 55,
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



async function gotoLocalSmokeApp(page, url = "/") {
  await page.goto(url, { waitUntil: "load" });
}

async function waitForLocalSmokeAppReady(page) {
  await page.waitForFunction(() => (
    typeof window.formatMoney === "function"
    && Boolean(window.FuelBuildInfo?.BUILD_INFO)
    && Boolean(window.FuelBookingCalendar)
    && Boolean(window.FuelRendering)
    && typeof window.closeCurrentPeriod === "function"
  ), null, { timeout: 10000 });
  await expect(page.locator("#tripForm")).toBeVisible({ timeout: 10000 });
  await expect(page.locator("#startKm")).toBeEnabled({ timeout: 10000 });
  await expect(page.locator("#tripList")).toBeAttached({ timeout: 10000 });
}

async function openLocalApp(page) {
  await page.route("**/supabase-config.js", (route) => route.fulfill({
    contentType: "application/javascript",
    body: "window.CAR_SHARE_SUPABASE = { enabled: false, url: '', anonKey: '', ledgerId: 'test-ledger' };"
  }));

  await gotoLocalSmokeApp(page);

  // localStorage is only available after navigating to an HTTP origin.
  // Do not clear it from about:blank; WebKit/Chromium can throw SecurityError.
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "load" });

  await waitForLocalSmokeAppReady(page);
}


async function openBookView(page) {
  await page.locator('[data-view-tab="book"]').click();
  await expect(page.locator("#tripEstimateDistance")).toBeVisible({ timeout: 10000 });
}

async function chooseFirstSelectOption(select) {
  const options = await select.locator("option").evaluateAll((items) =>
    items.map((item) => item.value).filter(Boolean)
  );
  if (options.length > 0) await select.selectOption(options[0]);
}

async function ensureTripParticipantsSelected(page) {
  const checkedParticipants = page.locator('#tripParticipants input[type="checkbox"]:checked');
  if (await checkedParticipants.count()) return;

  const driver = await page.locator("#tripDriver").inputValue();
  const selectedDriver = await page.locator('#tripParticipants input[type="checkbox"]').evaluateAll((inputs, selectedDriver) => {
    const match = inputs.find((input) => input.value === selectedDriver);
    if (!match) return false;
    match.checked = true;
    match.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, driver);
  if (selectedDriver) return;

  const firstParticipant = page.locator('#tripParticipants input[type="checkbox"]').first();
  if (await firstParticipant.count()) await firstParticipant.check();
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

function typedRefFromEntry(entry, type = "log") {
  const prefixMap = { booking: "bok", trip: "trp", fuel: "ful", log: "log" };
  const prefix = prefixMap[type] || String(type || "log").toLowerCase();
  const raw = entry?.logRef || `#${String(entry?.id || "LOG000").replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 6)}`;
  const compact = String(raw || "").replace(/[^a-z0-9]/gi, "").replace(/^(BOK|TRP|FUL|LOG)/i, "").toUpperCase().slice(0, 6);
  return compact ? `${prefix}-${compact}` : `${prefix}-unknown`;
}

async function expectUserError(page, expected) {
  const toast = page.locator("#appMessageToast");
  await expect(toast).toBeVisible();
  if (expected instanceof RegExp) {
    await expect(toast).toContainText(expected);
  } else {
    await expect(toast).toContainText(expected);
  }
  await expect(toast).toHaveAttribute("data-type", "error");
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
    fuelTankCapacity: 55,
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

  await page.route(/.*(?:\/npm\/@supabase\/supabase-js@2(?:\.\d+\.\d+)?(?:\/.*)?|\/vendor\/supabase-js-2\.43\.4\/supabase\.js)$/, (route) => route.fulfill({
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
        if (this.table === "car_share_ledgers") {
          return Promise.resolve({ data: { state: seededState, updated_at: "2026-06-11T00:00:00.000Z" }, error: null });
        }
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

  await page.addInitScript(() => {
    localStorage.setItem("fuel-ledger-active-workspace-id", "test-ledger");
  });

  await gotoLocalSmokeApp(page);
  await expect(page.locator("#tripList")).toContainText("Christian-owned permission smoke trip", { timeout: 10000 });
  await expect(page.locator("#fuelList")).toContainText("Permission Smoke Station", { timeout: 10000 });
}



async function closeCurrentPeriodForSmoke(page, options = {}) {
  await page.evaluate(async (closeOptions) => {
    if (typeof window.closeCurrentPeriod !== "function") {
      const button = document.querySelector("#closePeriod");
      if (button) button.click();
      return;
    }
    await window.closeCurrentPeriod({
      skipConfirm: true,
      skipFuelValidation: true,
      ...closeOptions
    });
  }, options);
}

async function openClosedPeriodCard(card) {
  await expect(card).toBeVisible();

  const needsLazyRender = await card.evaluate((details) => (
    details instanceof HTMLDetailsElement && details.dataset.lazyClosedPeriod === "true"
  ));

  if (needsLazyRender) {
    const isOpen = await card.evaluate((details) => (
      details instanceof HTMLDetailsElement ? details.open : false
    ));

    if (isOpen) {
      await card.evaluate((details) => {
        if (details instanceof HTMLDetailsElement) {
          details.dispatchEvent(new Event("toggle", { bubbles: true }));
        }
      });
    } else {
      await card.locator("summary").click();
    }
  }

  await expect(card).not.toHaveAttribute("data-lazy-closed-period", "true");
}


async function waitForPaymentRequestSaved(page, { timeout = 10000 } = {}) {
  await expect.poll(async () => {
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("car-share-ledger-v1") || "{}"));
    const statuses = Object.values(saved.paymentStatuses || {});
    const auditEntries = Array.isArray(saved.auditLog) ? saved.auditLog : [];
    const hasRequestedStatus = statuses.includes("requested");
    const hasRequestedAudit = auditEntries.some((entry) => (
      entry?.type === "payment_requested"
      || `${entry?.summary || ""} ${entry?.detail || ""}`.includes("Payment requested")
    ));
    return { hasRequestedStatus, hasRequestedAudit };
  }, {
    timeout,
    message: "payment request status and audit entry should be persisted before audit-log assertions"
  }).toEqual({ hasRequestedStatus: true, hasRequestedAudit: true });

  await expect(page.locator("#auditLog")).toContainText("Payment requested", { timeout });
  await expect(page.locator("#auditLog")).toContainText(/Status: Not requested .* Requested/, { timeout });
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
  await ensureTripParticipantsSelected(page);
  await page.locator("#tripDate").fill("2026-06-10");
  const currentStartKm = Number(await page.locator("#startKm").inputValue());
  const startKm = Number.isFinite(currentStartKm) && currentStartKm > 0 ? currentStartKm : 1000;
  const endKm = startKm + 42;
  await page.locator("#startKm").fill(String(startKm));
  await page.locator("#endKm").fill(String(endKm));
  await page.locator("#tripNote").fill(note);
  await page.locator("#tripForm").evaluate((form) => form.requestSubmit());

  await expect(page.locator("#tripList")).toContainText(note, { timeout: 10000 });

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


test("booking IDs are visible on booking cards, month chips, and save feedback", async ({ page }) => {
  await openLocalApp(page);

  await page.locator('[data-view-tab="book"]').click();
  await chooseFirstSelectOption(page.locator("#bookingMember"));
  await page.locator("#bookingStart").fill("2026-06-18T08:00");
  await page.locator("#bookingEnd").fill("2026-06-18T10:00");
  await page.locator("#bookingPurpose").fill("Booking ref visibility regression");
  await page.locator("#bookingForm").evaluate((form) => form.requestSubmit());

  const booking = await page.evaluate(() => JSON.parse(localStorage.getItem("car-share-ledger-v1") || "{}").bookings?.[0]);
  const bookingRef = typedRefFromEntry(booking, "booking");
  await expect(page.locator("#appMessageToast")).toContainText(`Car booked as ${bookingRef}.`);
  await expect(page.locator("#bookingCalendar")).toContainText(bookingRef);
  await expect(page.locator(`[data-booking-ref="${bookingRef}"]`).first()).toBeVisible();

  await page.locator('[data-booking-calendar-view="month"]').click();
  await expect(page.locator("#bookingCalendar")).toContainText("Booking ref visibility regression");
  await expect(page.locator("#bookingCalendar")).toContainText(bookingRef);
});

test("booking-to-trip linkage shows booking and trip IDs in log context and pending fuel", async ({ page }) => {
  await openLocalApp(page);

  await page.locator('[data-view-tab="book"]').click();
  await chooseFirstSelectOption(page.locator("#bookingMember"));
  await page.locator("#bookingStart").fill("2026-06-10T21:00");
  await page.locator("#bookingEnd").fill("2026-06-11T23:00");
  await page.locator("#bookingPurpose").fill("Booking ref linkage regression");
  await page.locator("#bookingForm").evaluate((form) => form.requestSubmit());

  const booking = await page.evaluate(() => JSON.parse(localStorage.getItem("car-share-ledger-v1") || "{}").bookings?.[0]);
  const bookingRef = typedRefFromEntry(booking, "booking");
  await page.locator(`[data-convert-booking-to-trip="${booking.id}"]`).click();
  await expect(page.locator('[data-view="log"]#tripLogPanel')).toBeVisible();
  await expect(page.locator("#tripBookingContext")).toContainText(bookingRef);

  await page.locator("#startKm").fill("3000");
  await page.locator("#endKm").fill("3077");
  await page.locator("#tripForm").evaluate((form) => form.requestSubmit());

  const trip = await page.evaluate(() => JSON.parse(localStorage.getItem("car-share-ledger-v1") || "{}").trips?.[0]);
  const tripRef = typedRefFromEntry(trip, "trip");
  await expect(page.locator("#pendingLogList")).toContainText("Fuel log required");
  await expect(page.locator("#pendingLogList")).toContainText(bookingRef);
  await expect(page.locator("#pendingLogList")).toContainText(tripRef);
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
  const createdBooking = afterBooking.bookings.find(
    (booking) => booking.purpose === "Airport pickup" && booking.start === "2026-06-12T09:00" && booking.end === "2026-06-12T11:00"
  );
  expect(createdBooking).toBeTruthy();
  const bookingId = createdBooking.id;

  await page.reload();
  await page.locator('[data-view-tab="book"]').click();
  await expect(page.locator("#bookingCalendar")).toContainText("Airport pickup");

  await page.locator('[data-booking-calendar-view="week"]').click();
  await expect(page.locator("#bookingCalendar")).toContainText("Airport pickup");
  await page.locator('[data-booking-calendar-view="month"]').click();
  await expect(page.locator("#bookingCalendar")).toContainText("Airport pickup");
  await page.locator(`[data-convert-booking-to-trip="${bookingId}"]`).click();
  await expect(page.locator('[data-view="log"]#tripLogPanel')).toBeVisible();
  await expect(page.locator("#tripDriver")).toHaveValue("Christian");
  await expect(page.locator("#tripDate")).toHaveValue("2026-06-12");
  await expect(page.locator("#tripNote")).toHaveValue("Booking: Airport pickup");
  await expect(page.locator('#tripParticipants input[value="Christian"]')).toBeChecked();

  await page.locator('[data-view-tab="book"]').click();
  await page.locator('[data-booking-calendar-view="list"]').click();
  await page.locator("#bookingStart").fill("2026-06-12T10:30");
  await page.locator("#bookingEnd").fill("2026-06-12T12:00");
  await page.locator("#bookingPurpose").fill("Overlapping booking");
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("already booked");
    await dialog.accept();
  });
  await page.locator("#bookingForm").evaluate((form) => form.requestSubmit());

  await expect
    .poll(async () => {
      const state = await page.evaluate(() => JSON.parse(localStorage.getItem("car-share-ledger-v1")));
      return state.bookings.filter((booking) => booking.purpose === "Overlapping booking").length;
    })
    .toBe(0);

  const afterOverlap = await page.evaluate(() => JSON.parse(localStorage.getItem("car-share-ledger-v1")));
  expect(afterOverlap.bookings.some((booking) => booking.purpose === "Overlapping booking")).toBe(false);
  expect(afterOverlap.bookings.some((booking) => booking.id === bookingId)).toBe(true);

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
  expect(afterDelete.bookings.some((booking) => booking.id === bookingId)).toBe(false);
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
  await waitForPaymentRequestSaved(page);

  const reminderButton = page.locator('button[data-payment-reminder="true"]:not([disabled])').first();
  if (await reminderButton.count()) {
    await reminderButton.evaluate((button) => window.setTimeout(() => button.click(), 0));
    await expect(page.locator("body")).toContainText(/Reminder .* recorded|Reminder .* sent|Period locked|Reopen payment requests before changing this period/i);
    await expect(page.locator("body")).toContainText(/Reminder recorded|No active mobile notification subscription|mobile notification|Reminder .* sent|Period locked|Reopen payment requests before changing this period/i);
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
  page.on("dialog", (dialog) => {
    if (dialog.type() === "prompt" && dialog.message().includes("RESET CURRENT PERIOD")) {
      return dialog.accept("RESET CURRENT PERIOD");
    }
    return dialog.accept();
  });

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
  await waitForPaymentRequestSaved(page);
  await expect(page.locator("#closePeriod")).toBeEnabled();
  await closeCurrentPeriodForSmoke(page);

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



test("multi-day booking trip requires linked full-tank fuel before closing", async ({ page }) => {
  await openLocalApp(page);
  page.on("dialog", (dialog) => dialog.accept());

  await page.locator('[data-view-tab="book"]').click();
  await chooseFirstSelectOption(page.locator("#bookingMember"));
  await page.locator("#bookingStart").fill("2026-06-10T21:00");
  await page.locator("#bookingEnd").fill("2026-06-11T23:00");
  await page.locator("#bookingPurpose").fill("Required fuel regression");
  await page.locator("#bookingForm").evaluate((form) => form.requestSubmit());
  await expect(page.locator("#bookingCalendar")).toContainText("Required fuel regression");

  const bookingId = await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem("car-share-ledger-v1"));
    const booking = state.bookings.find((item) =>
      item.purpose === "Required fuel regression"
      && item.start === "2026-06-10T21:00"
      && item.end === "2026-06-11T23:00"
    );
    return booking?.id;
  });
  expect(bookingId).toBeTruthy();
  await page.locator(`[data-convert-booking-to-trip="${bookingId}"]`).click();
  await expect(page.locator('[data-view="log"]#tripLogPanel')).toBeVisible();
  await expect(page.locator("#tripDate")).toHaveValue("2026-06-11");
  await page.locator("#startKm").fill("2000");
  await page.locator("#endKm").fill("2088");
  await page.locator("#tripForm").evaluate((form) => form.requestSubmit());

  await expect(page.locator("#pendingLogList")).toContainText("Fuel log required");
  await page.locator('[data-view-tab="settle"]').click();
  await expect(page.locator("#settlementWarning")).toContainText("multi-day booking trip needs a linked full-tank fuel log");
  await closeCurrentPeriodForSmoke(page);
  await expect(page.locator("#pendingLogList")).toContainText("Required fuel regression");
  await expect(page.locator("#periodList")).not.toContainText("Required fuel regression");

  const requiredFuelAction = page.locator("#pendingLogList .pending-log-card", { hasText: "Required fuel regression" }).locator("[data-add-fuel-for-trip]").first();
  await expect(requiredFuelAction).toBeVisible();
  await requiredFuelAction.evaluate((button) => button.click());
  await expect(page.locator("#fuelTripContext")).toContainText("Required for multi-day booking");
  await page.locator("#fuelAmount").fill("444");
  await page.locator("#fuelLiters").fill("30");
  await page.locator("#fuelForm").evaluate((form) => form.requestSubmit());
  await expect(page.locator("#fuelList")).not.toContainText("444,00 DKK");
  await expect(page.locator("#fuelTripContext")).toContainText("Required for multi-day booking");

  await page.locator("#fuelFullTank").check();
  await page.locator("#fuelForm").evaluate((form) => form.requestSubmit());
  await expect(page.locator("#fuelList")).toContainText("444,00 DKK");
  await expect.poll(async () => {
    const state = await page.evaluate(() => JSON.parse(localStorage.getItem("car-share-ledger-v1")));
    const linkedTrip = state.trips.find((trip) => trip.sourceBookingId === bookingId || trip.note === "Required fuel regression");
    const linkedFuel = state.fuel.find((fuel) =>
      fuel.fullTank === true
      && (fuel.sourceBookingId === bookingId || fuel.sourceTripId === linkedTrip?.id || fuel.tripId === linkedTrip?.id)
    );
    return Boolean(linkedTrip && linkedFuel);
  }, { timeout: 5000 }).toBe(true);

  await page.locator('[data-view-tab="settle"]').click();
  await expect(page.locator("#settlementWarning")).not.toContainText("multi-day booking trip needs");
  await requestAllOpenPayments(page);
  await expect(page.locator("#settlementWarning")).not.toContainText("Request all settlement payments");
  await closeCurrentPeriodForSmoke(page);
  await page.locator('[data-view-tab="history"]').click();
  await openClosedPeriodCard(page.locator(".archived-period-card").first());
  await expect(page.locator("#periodList")).toContainText("Required fuel regression");
});

test("payment deep links route current payments to Settlement and closed payments to archived cards", async ({ page }) => {
  await openLocalApp(page);
  page.on("dialog", (dialog) => dialog.accept());

  await createBasicTripAndFuel(page, { note: "Payment deep link regression", fuelAmount: "222.22" });
  await page.locator('[data-view-tab="settle"]').click();
  await expect(page.locator("#settlements")).toContainText("distance share");
  await expect(page.locator("#settlements")).not.toContainText(/drove or joined\s+42 km/i);

  const paymentCard = page.locator(".settlement-card").first();
  const paymentRef = await paymentCard.getAttribute("data-payment-ref");
  expect(paymentRef).toBeTruthy();
  await expect(paymentCard).toContainText(/fuel share/i);
  await expect(paymentCard).toContainText(/10[,.]5 km distance share/);

  await gotoLocalSmokeApp(page, `/#payment=${paymentRef}&scope=current`);
  await expect(page.locator('[data-view="settle"][aria-labelledby="settleHeading"]')).toBeVisible();
  await expect(page.locator(`.settlement-card[data-payment-ref="${paymentRef}"]`)).toHaveClass(/highlight-pulse/);

  await requestAllOpenPayments(page);
  await closeCurrentPeriodForSmoke(page);
  await page.locator('[data-view-tab="history"]').click();
  const closedPeriodCard = page.locator(".archived-period-card").first();
  await openClosedPeriodCard(closedPeriodCard);
  await expect(closedPeriodCard.locator(`.archive-payment-card[data-payment-ref="${paymentRef}"]`)).toHaveCount(1);
  const periodId = await closedPeriodCard.getAttribute("data-period-id");
  expect(periodId).toBeTruthy();

  await gotoLocalSmokeApp(page, `/#payment=${paymentRef}&scope=closed&period=${periodId}`);
  await expect(page.locator("#periodsHeading")).toContainText("Closed periods");
  const highlightedArchivePayment = page.locator(`.archive-payment-card[data-payment-ref="${paymentRef}"]`);
  await expect(highlightedArchivePayment).toHaveCount(1);
  await expect(highlightedArchivePayment).toHaveClass(/highlight-pulse/);
});


test("service worker script is reachable and matches build metadata", async ({ request }) => {
  const response = await request.get("/service-worker.js");
  expect(response.ok()).toBeTruthy();
  const body = await response.text();
  expect(body).toContain("CACHE_NAME");
  expect(body).toContain("BUILD_LABEL");

  const buildResponse = await request.get("/build-info.js");
  expect(buildResponse.ok()).toBeTruthy();
  const buildBody = await buildResponse.text();
  const expectedCache = buildBody.match(/expectedServiceWorkerCache:\s*"([^"]+)"/)?.[1];
  const expectedBuild = buildBody.match(/buildLabel:\s*"([^"]+)"/)?.[1];
  expect(expectedCache).toBeTruthy();
  expect(expectedBuild).toBeTruthy();
  expect(body).toContain(`CACHE_NAME = "${expectedCache}"`);
  expect(body).toContain(`BUILD_LABEL = "${expectedBuild}"`);
});

test("payment status actions do not mutate booking records or emit normalized sync warnings", async ({ page }) => {
  const consoleMessages = [];
  page.on("console", (message) => {
    consoleMessages.push(`${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => {
    consoleMessages.push(`pageerror: ${error.message}`);
  });

  await openLocalApp(page);
  page.on("dialog", (dialog) => dialog.accept());

  await page.locator('[data-view-tab="book"]').click();
  await chooseFirstSelectOption(page.locator("#bookingMember"));
  await page.locator("#bookingStart").fill("2026-06-15T09:00");
  await page.locator("#bookingEnd").fill("2026-06-15T12:00");
  await page.locator("#bookingPurpose").fill("Payment action booking immutability");
  await page.locator("#bookingForm").evaluate((form) => form.requestSubmit());
  await expect(page.locator("#bookingCalendar")).toContainText("Payment action booking immutability");

  await page.locator('[data-view-tab="log"]').click();
  await expect(page.locator("#tripForm")).toBeVisible();
  await createBasicTripAndFuel(page, { note: "Payment action should not mutate bookings", fuelAmount: "222.22" });

  const beforeBookings = await page.evaluate(() => JSON.parse(localStorage.getItem("car-share-ledger-v1") || "{}").bookings || []);
  expect(beforeBookings).toHaveLength(1);

  await page.locator('[data-view-tab="settle"]').click();
  const requestButton = page.locator('button[data-payment-status="requested"]').first();
  await expect(requestButton).toHaveCount(1);
  await requestButton.evaluate((button) => button.click());
  await expect.poll(async () => {
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("car-share-ledger-v1") || "{}").paymentStatuses || {});
    return Object.values(saved).some((status) => status === "requested");
  }, { timeout: 5000 }).toBe(true);

  const reopenButton = page.locator('button[data-payment-status="open"]').first();
  await expect(reopenButton).toHaveCount(1);
  await reopenButton.evaluate((button) => button.click());
  await expect.poll(async () => {
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("car-share-ledger-v1") || "{}").paymentStatuses || {});
    return Object.values(saved).some((status) => status === "requested");
  }, { timeout: 5000 }).toBe(true);

  const afterBookings = await page.evaluate(() => JSON.parse(localStorage.getItem("car-share-ledger-v1") || "{}").bookings || []);
  expect(afterBookings).toEqual(beforeBookings);

  const noisyOutput = consoleMessages.join("\n");
  expect(noisyOutput).not.toContain("Normalized table dual-write failed");
  expect(noisyOutput).not.toContain("23P01");
  expect(noisyOutput).not.toContain("car_bookings");
});

test("non-admin members see clear permission messages for entries owned by someone else", async ({ page }) => {
  await openLocalAppAsEmilieWithChristianEntries(page);

  await expect(page.locator("#currentUser")).toHaveValue("emilie");
  await expect(page.locator("#tripList")).toContainText("Only Christian, the trip creator, or an admin can edit or delete this trip. You are signed in as emilie.");
  await expect(page.locator("#fuelList")).toContainText("Only Christian, the fuel payer/creator, or an admin can edit or delete this fuel log. You are signed in as emilie.");
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

test("trip planner uses tank capacity for remaining-range guidance", async ({ page }) => {
  await openLocalApp(page);

  await openBookView(page);
  await page.locator("#tripEstimateDistance").fill("350");
  await page.locator("#tripEstimatorParticipants input").first().check();

  await expect(page.locator("#tripEstimateResult")).toContainText("Tank capacity");
  await expect(page.locator("#tripEstimateResult")).toContainText("55 L");
  await expect(page.locator("#tripEstimateResult")).toContainText(/Range after trip|full/i);
  await expect(page.locator("#tripEstimateResult")).toContainText(/full.*tank|full/i);
});

test("tank capacity settings persist and drive trip planner output", async ({ page, request }) => {
  await openLocalApp(page);

  await page.locator('[data-view-tab="admin"]').click();
  await expect(page.locator("#fuelTankCapacity")).toBeVisible();
  await page.locator("#fuelConsumption").fill("5.5");
  await page.locator("#fuelTankCapacity").fill("60");
  await page.locator("#fuelWarningThreshold").fill("75");
  await page.locator("#settingsForm").evaluate((form) => form.requestSubmit());
  await expect.poll(async () => {
    const response = await request.get('/api/state');
    const saved = await response.json();
    return {
      fuelConsumption: String(saved.fuelConsumption),
      fuelTankCapacity: String(saved.fuelTankCapacity),
      fuelWarningThreshold: String(saved.fuelWarningThreshold)
    };
  }).toEqual({
    fuelConsumption: "5.5",
    fuelTankCapacity: "60",
    fuelWarningThreshold: "75"
  });

  await page.reload();
  await page.locator('[data-view-tab="log"]').click();
  await expect(page.locator("#tripForm")).toBeVisible();
  await page.locator('[data-view-tab="admin"]').click();
  await expect(page.locator("#fuelConsumption")).toHaveValue("5.5");
  await expect(page.locator("#fuelTankCapacity")).toHaveValue("60");
  await expect(page.locator("#fuelWarningThreshold")).toHaveValue("75");

  await openBookView(page);
  await page.locator("#tripEstimateDistance").fill("300");
  await page.locator("#tripEstimatorParticipants input").first().check();
  await expect(page.locator("#tripEstimateResult")).toContainText("Tank capacity");
  await expect(page.locator("#tripEstimateResult")).toContainText("60 L");
  await expect(page.locator("#tripEstimateResult")).toContainText(/5[,.]5 L\/100 km/);
});



test("trip planner subtracts planned distance from full-tank baseline without station history", async ({ page, request }) => {
  const seeded = makeCleanState();
  seeded.fuelConsumption = 5.4;
  seeded.fuelTankCapacity = 55;
  seeded.fuelWarningThreshold = 25;
  seeded.fuel = [{
    id: "full-tank-no-station",
    payer: "Christian",
    date: "2026-06-01",
    amount: 500,
    liters: 40,
    odometer: 10000,
    fullTank: true
  }];
  // Simulate stale convenience/default odometer from a previous session. Range
  // planning must use real trip/fuel records, not this stale value.
  seeded.lastOdometer = 10200;
  await request.put("/api/state", { data: seeded });

  await openLocalApp(page);
  await openBookView(page);
  await page.locator("#tripEstimateDistance").fill("366");
  await page.locator("#tripEstimatorParticipants input").first().check();

  await expect(page.locator("#tripEstimateResult")).toContainText("Range after trip");
  await expect(page.locator("#tripEstimateResult")).toContainText(/65[0-5][,.][0-9] km left|65[0-5] km left/);
  await expect(page.locator("#tripEstimateResult")).toContainText(/After the trip: about 35[,.]2 L \/ 65[0-5][,.][0-9] km remaining|After the trip: about 35[,.]2 L \/ 65[0-5] km remaining/);
  await expect(page.locator("#tripEstimateResult")).not.toContainText("Add full-tank odometer logs to make remaining-range predictions smarter");
  await expect(page.locator("#tripEstimateResult")).not.toContainText(/low-range warning threshold|plan a refuel stop|leaves the tank below/i);
});

test("trip planner warns when planned trip crosses configured tank range threshold", async ({ page, request }) => {
  const seeded = makeCleanState();
  seeded.fuelConsumption = 5.5;
  seeded.fuelTankCapacity = 55;
  seeded.fuelWarningThreshold = 70;
  seeded.fuel = [{
    id: "full-tank-range-anchor",
    payer: "Christian",
    date: "2026-06-01",
    amount: 500,
    liters: 36,
    pricePerLiter: 13.89,
    odometer: 1000,
    station: "Range Anchor Station",
    fullTank: true
  }];
  seeded.trips = [{
    id: "range-history-trip",
    driver: "Christian",
    date: "2026-06-08",
    startKm: 1000,
    endKm: 1600,
    participants: ["Christian"],
    note: "Range threshold history trip"
  }];
  seeded.lastOdometer = 1600;
  await request.put("/api/state", { data: seeded });

  await openLocalApp(page);
  await openBookView(page);
  await page.locator("#tripEstimateDistance").fill("200");
  await page.locator("#tripEstimatorParticipants input").first().check();

  await expect(page.locator("#tripEstimateResult")).toContainText("Tank capacity");
  await expect(page.locator("#tripEstimateResult")).toContainText("55 L");
  await expect(page.locator("#tripEstimateResult")).toContainText(/After the trip/i);
  await expect(page.locator("#tripEstimateResult")).toContainText(/low-range warning threshold|plan a refuel stop|leaves the tank below/i);
});


test("trip save is blocked when estimated tank range would go negative", async ({ page, request }) => {
  const seeded = makeCleanState();
  seeded.fuelConsumption = 5.4;
  seeded.fuelTankCapacity = 55;
  seeded.fuelWarningThreshold = 25;
  seeded.fuel = [{
    id: "full-tank-before-overrange-trip",
    payer: "Christian",
    date: "2026-06-01",
    amount: 500,
    liters: 40,
    odometer: 10000,
    fullTank: true
  }];
  seeded.lastOdometer = 10000;
  await request.put("/api/state", { data: seeded });

  await openLocalApp(page);
  await page.locator('[data-view-tab="log"]').click();
  await expect(page.locator("#tripForm")).toBeVisible();
  await page.locator("#tripDriver").selectOption("Christian");
  await page.locator("#tripDate").fill("2026-06-02");
  await page.locator("#startKm").fill("10000");
  await page.locator("#endKm").fill("11100");
  await page.locator('#tripParticipants input[value="Christian"]').check();

  await page.locator("#tripForm").evaluate((form) => {
    window.setTimeout(() => form.requestSubmit(), 0);
  });
  await expectUserError(page, "exceed the estimated fuel remaining");

  await expect.poll(async () => {
    const response = await request.get("/api/state");
    const saved = await response.json();
    return saved.trips.length;
  }).toBe(0);
});

test("smart tank range uses actual data, not unsaved plan estimate", async ({ page, request }) => {
  const seeded = makeCleanState();
  seeded.fuelConsumption = 5.4;
  seeded.fuelTankCapacity = 55;
  seeded.fuelWarningThreshold = 25;
  seeded.fuel = [{
    id: "full-tank-smart-anchor",
    payer: "Christian",
    date: "2026-06-01",
    amount: 500,
    liters: 40,
    odometer: 10000,
    fullTank: true
  }];
  seeded.trips = [{
    id: "actual-trip-before-plan",
    driver: "Christian",
    date: "2026-06-02",
    startKm: 10000,
    endKm: 10200,
    note: "Actual trip before unsaved plan",
    participants: ["Christian", "Marie"]
  }];
  seeded.lastOdometer = 10200;
  await request.put("/api/state", { data: seeded });

  await openLocalApp(page);
  await openBookView(page);
  await page.locator("#tripEstimateDistance").fill("366");
  await page.locator("#tripEstimatorParticipants input").first().check();
  await expect(page.locator("#tripEstimateResult")).toContainText(/45[0-5][,.][0-9] km left|45[0-5] km left/);

  await page.locator('[data-view-tab="insights"]').click();
  await expect(page.locator("#smartPredictions")).toContainText("Tank range now");
  await expect(page.locator("#smartPredictions")).toContainText(/81[5-9][,.][0-9] km now|81[5-9] km now/);
  await expect(page.locator("#smartPredictions")).not.toContainText("after plan");
});

test("plan estimate can be copied into a real booking", async ({ page, request }) => {
  await openLocalApp(page);
  await openBookView(page);
  await page.locator("#tripEstimateDistance").fill("123");
  await page.locator("#tripEstimateStart").fill("Roskilde");
  await page.locator("#tripEstimateDestination").fill("Aarhus");
  await page.locator("#tripEstimatorParticipants").evaluate((container) => {
    const selectedPeople = new Set(["Christian", "Marie"]);
    container.querySelectorAll('input[type="checkbox"]').forEach((input) => {
      input.checked = selectedPeople.has(input.value);
    });
    container.dispatchEvent(new Event("change", { bubbles: true }));
  });

  await expect.poll(async () => {
    return page.locator("#tripEstimateResult").innerText();
  }, { timeout: 5000 }).toContain("Christian, Marie");
  await expect(page.locator("#tripEstimateResult")).toContainText(/People\s+2/);
  await page.getByRole("button", { name: "Use this estimate for booking" }).click();

  await expect(page.locator("#bookingPurpose")).toHaveValue(/Roskilde.*Aarhus.*123/);
  // The booking-status UI only shows the Log trip action for completed bookings.
  // Keep this scenario focused on copying the plan estimate into a real booking,
  // then converting that completed booking into a trip.
  await page.locator("#bookingStart").fill("2026-06-12T15:00");
  await page.locator("#bookingEnd").fill("2026-06-12T17:00");
  await page.locator("#bookingForm").evaluate((form) => form.requestSubmit());
  await expect(page.locator("#bookingCalendar")).toContainText(/123 km estimate|123 km/);

  let booking;
  await expect.poll(async () => {
    const response = await request.get("/api/state");
    const saved = await response.json();
    booking = saved.bookings.find((item) => Number(item.plannedDistanceKm) === 123);
    return Boolean(booking);
  }, { timeout: 5000 }).toBe(true);
  expect(booking).toBeTruthy();
  expect(booking.routeFrom).toBe("Roskilde");
  expect(booking.routeTo).toBe("Aarhus");
  expect(booking.plannedParticipants).toEqual(["Christian", "Marie"]);

  await page.locator(`[data-convert-booking-to-trip="${booking.id}"]`).first().click();
  await expect(page.locator("#tripForm")).toBeVisible();
  await expect(page.locator('#tripParticipants input[value="Christian"]')).toBeChecked();
  await expect(page.locator('#tripParticipants input[value="Marie"]')).toBeChecked();
  await page.locator("#tripParticipants").evaluate((container) => {
    const selectedPeople = new Set(["Christian", "Marie"]);
    container.querySelectorAll('input[type="checkbox"]').forEach((input) => {
      const shouldBeChecked = selectedPeople.has(input.value);
      if (input.checked !== shouldBeChecked) {
        input.checked = shouldBeChecked;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    container.dispatchEvent(new Event("input", { bubbles: true }));
    container.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect.poll(async () => {
    return page.locator('#tripParticipants input[type="checkbox"]:checked').evaluateAll((inputs) => {
      return inputs.map((input) => input.value).sort();
    });
  }, { timeout: 5000 }).toEqual(["Christian", "Marie"].sort());

  await page.locator("#startKm").fill("10000");
  await page.locator("#endKm").fill("10123");
  await page.locator("#tripForm").evaluate((form) => form.requestSubmit());

  await expect.poll(async () => {
    const response = await request.get("/api/state");
    const saved = await response.json();
    const trip = saved.trips.find((item) => item.sourceBookingId === booking.id);
    return [...(trip?.participants || [])].sort();
  }, { timeout: 5000 }).toEqual(["Christian", "Marie"].sort());
});

test("fuel log is blocked when liters exceed configured tank capacity", async ({ page, request }) => {
  const seeded = makeCleanState();
  seeded.fuelTankCapacity = 55;
  seeded.fuelConsumption = 5.4;
  await request.put("/api/state", { data: seeded });

  await openLocalApp(page);
  await page.locator('[data-view-tab="log"]').click();
  await expect(page.locator("#fuelForm")).toBeVisible();
  await page.locator("#fuelPayer").selectOption("Christian");
  await page.locator("#fuelDate").fill("2026-06-01");
  await page.locator("#fuelAmount").fill("900");
  await page.locator("#fuelLiters").fill("60");
  await page.locator("#fuelDetails").evaluate((details) => { details.open = true; });
  await page.locator("#fuelOdometer").fill("10000");

  await page.locator("#fuelForm").evaluate((form) => {
    window.setTimeout(() => form.requestSubmit(), 0);
  });
  await expectUserError(page, "tank capacity");

  await expect.poll(async () => {
    const response = await request.get("/api/state");
    const saved = await response.json();
    return saved.fuel.length;
  }).toBe(0);
});

test("fuel log is blocked when it would overfill estimated tank level", async ({ page, request }) => {
  const seeded = makeCleanState();
  seeded.fuelTankCapacity = 55;
  seeded.fuelConsumption = 5.4;
  seeded.fuel = [{
    id: "full-tank-before-overfill-fuel",
    payer: "Christian",
    date: "2026-06-01",
    amount: 500,
    liters: 40,
    odometer: 10000,
    fullTank: true
  }];
  seeded.lastOdometer = 10000;
  await request.put("/api/state", { data: seeded });

  await openLocalApp(page);
  await page.locator('[data-view-tab="log"]').click();
  await expect(page.locator("#fuelForm")).toBeVisible();
  await page.locator("#fuelPayer").selectOption("Christian");
  await page.locator("#fuelDate").fill("2026-06-02");
  await page.locator("#fuelAmount").fill("600");
  await page.locator("#fuelLiters").fill("40");
  await page.locator("#fuelDetails").evaluate((details) => { details.open = true; });
  await page.locator("#fuelOdometer").fill("10100");
  await page.locator("#fuelFullTank").check();

  await page.locator("#fuelForm").evaluate((form) => {
    window.setTimeout(() => form.requestSubmit(), 0);
  });
  await expectUserError(page, /Only about|overfill|should fit/i);
  await expect(page.locator("#fuelCorrectionPanel")).toContainText("Why these suggestions?");
  await expect(page.locator("#fuelCorrectionPanel")).toContainText("Previous full-tank odometer");
  await expect(page.locator("#fuelCorrectionPanel")).toContainText(/At 5[,.]4 L\/100 km/);

  await expect.poll(async () => {
    const response = await request.get("/api/state");
    const saved = await response.json();
    return saved.fuel.length;
  }).toBe(1);
});
