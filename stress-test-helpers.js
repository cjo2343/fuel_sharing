// Test Lab helpers for generated data, invariant checks, reports and cleanup.
// Loaded before app.js; exposes pure helpers on window.FuelTestLab.
(function () {
  const DEFAULT_TEST_PREFIX = "auto-test-";
  const DEFAULT_TEST_MARKER = "[AUTO TEST]";

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function asObject(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function safeNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function roundMoney(value) {
    return Math.round(safeNumber(value) * 100) / 100;
  }

  function createTestRunId(date = new Date()) {
    return `testlab-${date.toISOString().replace(/[:.]/g, "-")}`;
  }

  function isTestLabEntry(entry, options = {}) {
    if (!entry) return false;
    const prefix = options.prefix || DEFAULT_TEST_PREFIX;
    const marker = options.marker || DEFAULT_TEST_MARKER;
    const fields = [entry.id, entry.note, entry.station, entry.purpose, entry.testRunId, entry.logRef];
    return fields.some((field) => String(field || "").includes(marker) || String(field || "").startsWith(prefix));
  }

  function stateSummary(state) {
    const source = asObject(state);
    return {
      members: asArray(source.members).length,
      trips: asArray(source.trips).length,
      fuel: asArray(source.fuel).length,
      bookings: asArray(source.bookings).length,
      closedPeriods: asArray(source.closedPeriods).length,
      paymentStatuses: Object.keys(asObject(source.paymentStatuses)).length,
      auditEntries: asArray(source.auditLog).length
    };
  }

  function generatedDataSummary(state, options = {}) {
    const source = asObject(state);
    const trips = asArray(source.trips).filter((entry) => isTestLabEntry(entry, options));
    const fuel = asArray(source.fuel).filter((entry) => isTestLabEntry(entry, options));
    const bookings = asArray(source.bookings).filter((entry) => isTestLabEntry(entry, options));
    const closedPeriods = asArray(source.closedPeriods).filter((entry) => isTestLabEntry(entry, options));
    const paymentStatuses = Object.keys(asObject(source.paymentStatuses)).filter((key) => key.includes(options.prefix || DEFAULT_TEST_PREFIX) || key.includes(options.marker || DEFAULT_TEST_MARKER));
    return {
      trips: trips.length,
      fuel: fuel.length,
      bookings: bookings.length,
      closedPeriods: closedPeriods.length,
      paymentStatuses: paymentStatuses.length,
      total: trips.length + fuel.length + bookings.length + closedPeriods.length + paymentStatuses.length
    };
  }

  function uniqueIdCheck(entries, label) {
    const seen = new Set();
    const duplicates = [];
    for (const entry of asArray(entries)) {
      const id = String(entry && entry.id || "").trim();
      if (!id) continue;
      if (seen.has(id)) duplicates.push(id);
      seen.add(id);
    }
    return duplicates.length
      ? fail(`${label} IDs are unique`, `${duplicates.length} duplicate ${label} ID(s): ${duplicates.slice(0, 5).join(", ")}`)
      : pass(`${label} IDs are unique`);
  }

  function pass(name, detail = "") {
    return { ok: true, name, detail };
  }

  function fail(name, detail = "", refs = []) {
    return { ok: false, name, detail, level: "error", refs: asArray(refs) };
  }

  function warn(name, detail = "", refs = []) {
    return { ok: true, name, detail, level: "warning", warning: true, refs: asArray(refs) };
  }

  function isWarning(check) {
    return Boolean(check && check.ok && (check.warning || check.level === "warning"));
  }

  function checkIcon(check) {
    if (!check || !check.ok) return "❌";
    return isWarning(check) ? "⚠️" : "✅";
  }

  function runStateInvariantChecks(input = {}) {
    const state = asObject(input.state);
    const ledger = asObject(input.ledger);
    const knownMembers = new Set(asArray(state.members).map((member) => String(member || "").trim()).filter(Boolean));
    const checks = [];

    checks.push(asArray(state.members).length ? pass("At least one member exists") : fail("At least one member exists", "Add a member before running scenario tests."));
    checks.push(uniqueIdCheck(state.trips, "Trip"));
    checks.push(uniqueIdCheck(state.fuel, "Fuel"));
    checks.push(uniqueIdCheck(state.bookings, "Booking"));

    const negativeTrips = asArray(state.trips).filter((trip) => safeNumber(trip && trip.endKm) < safeNumber(trip && trip.startKm));
    checks.push(negativeTrips.length ? fail("Trip distances are non-negative", `${negativeTrips.length} trip(s) have endKm < startKm.`) : pass("Trip distances are non-negative"));

    const unknownTripPeople = [];
    for (const trip of asArray(state.trips)) {
      if (trip && trip.driver && !knownMembers.has(String(trip.driver))) unknownTripPeople.push(`driver:${trip.driver}`);
      for (const participant of asArray(trip && trip.participants)) {
        if (!knownMembers.has(String(participant))) unknownTripPeople.push(`participant:${participant}`);
      }
    }
    checks.push(unknownTripPeople.length ? fail("Trip people are known members", unknownTripPeople.slice(0, 5).join(", ")) : pass("Trip people are known members"));

    const unknownFuelPayers = asArray(state.fuel).filter((fuel) => fuel && fuel.payer && !knownMembers.has(String(fuel.payer)));
    checks.push(unknownFuelPayers.length ? fail("Fuel payers are known members", `${unknownFuelPayers.length} fuel log(s) have unknown payers.`) : pass("Fuel payers are known members"));

    const peopleSource = ledger.people;
    const people = Array.isArray(peopleSource) ? peopleSource : Object.values(asObject(peopleSource));
    const netTotal = roundMoney(people.reduce((sum, person) => sum + safeNumber(person && (person.balance ?? person.net)), 0));
    checks.push(Math.abs(netTotal) <= 0.01 ? pass("Ledger net balances sum to 0.00", `Net total ${netTotal.toFixed(2)}`) : fail("Ledger net balances sum to 0.00", `Net total ${netTotal.toFixed(2)}`));

    const tripCostTotal = roundMoney(
      people.reduce((sum, person) => sum + safeNumber(person && (person.tripCost ?? person.cost)), 0)
    );
    const totalCost = roundMoney(ledger.totalCost ?? tripCostTotal);
    const totalPaid = roundMoney(safeNumber(ledger.totalPaid));
    const allocatedCost = totalCost || tripCostTotal;
    checks.push(Math.abs(allocatedCost - totalPaid) <= 0.01
      ? pass("Rounded trip costs match fuel paid", `${allocatedCost.toFixed(2)} vs ${totalPaid.toFixed(2)}`)
      : fail("Rounded trip costs match fuel paid", `${allocatedCost.toFixed(2)} vs ${totalPaid.toFixed(2)}`));

    const badSettlements = asArray(ledger.settlements).filter((settlement) => safeNumber(settlement && settlement.amount) <= 0 || !settlement.from || !settlement.to || settlement.from === settlement.to);
    checks.push(badSettlements.length ? fail("Settlement payments are valid", `${badSettlements.length} invalid settlement(s).`) : pass("Settlement payments are valid"));

    if (window.FuelPeriodClosing && typeof window.FuelPeriodClosing.isDuplicatePeriodSnapshot === "function") {
      const duplicate = window.FuelPeriodClosing.isDuplicatePeriodSnapshot({ trips: state.trips, fuel: state.fuel }, state.closedPeriods);
      checks.push(duplicate ? fail("Current period is not already archived", "This trip/fuel snapshot already exists in closed periods.") : pass("Current period is not already archived"));
    }

    return checks;
  }



  function runPaymentLifecycleChecks(input = {}) {
    const transition = typeof input.transition === "function"
      ? input.transition
      : (typeof window.isValidPaymentStatusTransition === "function" ? window.isValidPaymentStatusTransition : null);
    const checks = [];
    if (!transition) {
      checks.push(fail("Payment transition helper is available", "isValidPaymentStatusTransition was not found."));
      return checks;
    }
    checks.push(transition("open", "requested") ? pass("Payment can move open → requested") : fail("Payment can move open → requested"));
    checks.push(transition("requested", "paid") ? pass("Payment can move requested → paid") : fail("Payment can move requested → paid"));
    checks.push(transition("requested", "cancelled") ? pass("Payment can move requested → cancelled") : fail("Payment can move requested → cancelled"));
    checks.push(!transition("open", "paid") ? pass("Payment blocks open → paid") : fail("Payment blocks open → paid", "Payment should be requested before paid."));
    checks.push(!transition("paid", "requested") ? pass("Payment blocks paid → requested") : fail("Payment blocks paid → requested", "Paid payments should not become requested again."));
    return checks;
  }

  function runPermissionBoundaryChecks(input = {}) {
    const helpers = input.permissionHelpers || window.permissionHelpers;
    const checks = [];
    if (!helpers) {
      checks.push(fail("Permission helper module is available", "window.permissionHelpers was not found."));
      return checks;
    }
    const admin = { name: "Admin", role: "admin" };
    const owner = { name: "Owner", role: "member" };
    const other = { name: "Other", role: "member" };
    const trip = { driver: "Owner" };
    const fuel = { payer: "Owner" };
    const booking = { member: "Owner" };
    const settlement = { from: "Owner", to: "Other", amount: 10 };
    checks.push(helpers.canManageTripEntryForProfile(trip, owner) ? pass("Trip owner can edit own trip") : fail("Trip owner can edit own trip"));
    checks.push(!helpers.canManageTripEntryForProfile(trip, other) ? pass("Unrelated member cannot edit another trip") : fail("Unrelated member cannot edit another trip"));
    checks.push(helpers.canManageFuelEntryForProfile(fuel, owner) ? pass("Fuel payer can edit own fuel log") : fail("Fuel payer can edit own fuel log"));
    checks.push(!helpers.canManageFuelEntryForProfile(fuel, other) ? pass("Unrelated member cannot edit another fuel log") : fail("Unrelated member cannot edit another fuel log"));
    checks.push(helpers.canManageBookingEntryForProfile(booking, owner) ? pass("Booking owner can edit own booking") : fail("Booking owner can edit own booking"));
    checks.push(helpers.canManageSettlementRequestForProfile(settlement, other) ? pass("Recipient can request payment") : fail("Recipient can request payment"));
    checks.push(!helpers.canManageSettlementRequestForProfile(settlement, owner) ? pass("Payer cannot request payment to themselves") : fail("Payer cannot request payment to themselves"));
    checks.push(helpers.canMarkSettlementPaidForProfile(settlement, owner) ? pass("Payer can mark payment paid") : fail("Payer can mark payment paid"));
    checks.push(!helpers.canMarkSettlementPaidForProfile(settlement, other) ? pass("Recipient cannot mark payer's payment paid") : fail("Recipient cannot mark payer's payment paid"));
    checks.push(helpers.canManageTripEntryForProfile(trip, admin) && helpers.canManageFuelEntryForProfile(fuel, admin) ? pass("Admin can manage generated entries") : fail("Admin can manage generated entries"));
    const protection = helpers.summarizeMemberAdminProtection({ name: "Admin", role: "admin", is_active: true }, [{ name: "Admin", role: "admin", is_active: true }], admin);
    checks.push(!protection.canDeactivate && !protection.canDemote ? pass("Last/self admin protection is active") : fail("Last/self admin protection is active"));
    return checks;
  }

  function runLocationPrivacyChecks(input = {}) {
    const privacy = input.locationPrivacy || window.FuelLocationPrivacy;
    const checks = [];
    if (!privacy) {
      checks.push(fail("Location privacy helper is available", "window.FuelLocationPrivacy was not found."));
      return checks;
    }
    const defaultPayload = privacy.buildFuelLocationPayload({
      stationName: "Station", stationBrand: "Brand",
      userLatitude: 55.676098, userLongitude: 12.568337,
      stationLatitude: 55.7, stationLongitude: 12.6
    });
    checks.push(defaultPayload.location === null ? pass("Default fuel privacy does not save user GPS") : fail("Default fuel privacy does not save user GPS"));
    checks.push(defaultPayload.stationInfo && defaultPayload.stationInfo.latitude ? pass("Default fuel privacy saves selected station GPS") : fail("Default fuel privacy saves selected station GPS"));
    const noCoords = privacy.buildFuelLocationPayload({ mode: "no-coordinates", stationLatitude: 55.7, stationLongitude: 12.6 });
    checks.push(noCoords.location === null && noCoords.stationInfo === null ? pass("Station-name-only mode saves no coordinates") : fail("Station-name-only mode saves no coordinates"));
    const full = privacy.buildFuelLocationPayload({ mode: "full", userLatitude: 55.676098, userLongitude: 12.568337, stationLatitude: 55.7, stationLongitude: 12.6 });
    checks.push(full.location && full.stationInfo ? pass("Full mode can save user and station GPS") : fail("Full mode can save user and station GPS"));
    checks.push(privacy.inferFuelLocationPrivacyMode({ location: { latitude: 1, longitude: 2 } }) === "full" ? pass("Edit mode infers full GPS logs") : fail("Edit mode infers full GPS logs"));
    return checks;
  }

  function runBackupRoundTripChecks(input = {}) {
    const dataStore = input.dataStore || window.dataStore;
    const state = asObject(input.state);
    const checks = [];
    if (!dataStore || typeof dataStore.validateBackupPayload !== "function") {
      checks.push(fail("Backup validator is available", "dataStore.validateBackupPayload was not found."));
      return checks;
    }
    const payload = { app: "fuel-ledger", version: 1, exportedAt: new Date().toISOString(), state };
    const result = dataStore.validateBackupPayload(payload);
    checks.push(result && result.ok ? pass("Current state passes backup validation") : fail("Current state passes backup validation", asArray(result && result.errors).slice(0, 3).join("; ")));
    const malformed = dataStore.validateBackupPayload({ state: { members: [], trips: "bad" } });
    checks.push(malformed && !malformed.ok ? pass("Malformed backup is rejected") : fail("Malformed backup is rejected"));
    return checks;
  }

  function runBookingEdgeChecks(input = {}) {
    const state = asObject(input.state);
    const checks = [];
    const bookings = asArray(state.bookings);
    checks.push(uniqueIdCheck(bookings, "Booking"));
    const badRanges = bookings.filter((booking) => {
      const start = Date.parse(booking && booking.start || "");
      const end = Date.parse(booking && booking.end || "");
      return Number.isFinite(start) && Number.isFinite(end) && end <= start;
    });
    checks.push(badRanges.length ? fail("Booking end times are after starts", `${badRanges.length} booking(s) end before they start.`) : pass("Booking end times are after starts"));
    const linkedTrips = asArray(state.trips).filter((trip) => trip && trip.bookingId);
    const bookingIds = new Set(bookings.map((booking) => booking && booking.id).filter(Boolean));
    const missingLinks = linkedTrips.filter((trip) => !bookingIds.has(trip.bookingId));
    checks.push(missingLinks.length ? fail("Booking-linked trips reference existing bookings", `${missingLinks.length} linked trip(s) reference missing bookings.`) : pass("Booking-linked trips reference existing bookings"));
    return checks;
  }



  function fuelLogDateMs(fuel) {
    const raw = fuel && (fuel.date || fuel.createdAt || fuel.created_at || fuel.updatedAt || fuel.updated_at);
    const parsed = Date.parse(raw || "");
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function shortEntryId(entry) {
    return String(asObject(entry).id || "entry").slice(0, 8);
  }

  function formatFuelLogRef(fuel) {
    const source = asObject(fuel);
    const id = shortEntryId(source);
    const date = String(source.date || "unknown date");
    const odometer = safeNumber(source.odometer);
    return `#${id} ${date} ${odometer} km`;
  }

  function fuelLogRef(fuel, label = "Fuel log") {
    const source = asObject(fuel);
    return {
      type: "fuel",
      id: String(source.id || ""),
      shortId: shortEntryId(source),
      label,
      summary: formatFuelLogRef(source)
    };
  }

  function runFuelCapacityChecks(input = {}) {
    const state = asObject(input.state);
    const checks = [];
    const tankCapacity = Math.max(1, safeNumber(state.fuelTankCapacity, 55));
    const consumption = Math.max(0.1, safeNumber(state.fuelConsumption, 5.3));
    const toleranceLiters = Math.max(0.25, tankCapacity * 0.02);
    const rawFuelLogs = asArray(state.fuel);
    const productionFuelLogs = rawFuelLogs.filter((fuel) => !isTestLabEntry(fuel));
    const fuelLogs = input.includeGeneratedFuelLogs
      ? rawFuelLogs
      : (productionFuelLogs.length ? productionFuelLogs : rawFuelLogs);

    checks.push(tankCapacity > 0 ? pass("Fuel tank capacity is configured", `${tankCapacity} L`) : fail("Fuel tank capacity is configured"));
    checks.push(consumption > 0 ? pass("Fuel consumption setting is configured", `${consumption} L/100 km`) : fail("Fuel consumption setting is configured"));

    const overCapacityFuel = fuelLogs.filter((fuel) => safeNumber(fuel && fuel.liters) > tankCapacity + toleranceLiters);
    checks.push(overCapacityFuel.length
      ? fail("Fuel logs do not exceed tank capacity", `${overCapacityFuel.length} fuel log(s) exceed ${tankCapacity} L: ${overCapacityFuel.slice(0, 3).map(formatFuelLogRef).join(", ")}`, overCapacityFuel.slice(0, 3).map((fuel) => fuelLogRef(fuel, "Open fuel log")))
      : pass("Fuel logs do not exceed tank capacity"));

    const invalidFuelOdometers = fuelLogs.filter((fuel) => fuel && fuel.odometer !== "" && fuel.odometer != null && safeNumber(fuel.odometer, -1) < 0);
    checks.push(invalidFuelOdometers.length
      ? fail("Fuel odometers are non-negative", `${invalidFuelOdometers.length} fuel log(s) have negative odometers: ${invalidFuelOdometers.slice(0, 3).map(formatFuelLogRef).join(", ")}`, invalidFuelOdometers.slice(0, 3).map((fuel) => fuelLogRef(fuel, "Open fuel log")))
      : pass("Fuel odometers are non-negative"));

    const chronologicalFuelLogs = fuelLogs
      .map((fuel, index) => ({ ...asObject(fuel), odometerValue: safeNumber(fuel && fuel.odometer), dateMs: fuelLogDateMs(fuel), originalIndex: index }))
      .filter((fuel) => fuel.odometerValue > 0)
      .sort((a, b) => (a.dateMs - b.dateMs) || (a.originalIndex - b.originalIndex));

    const backwardsSegments = [];
    const backwardsRefs = [];
    for (let i = 1; i < chronologicalFuelLogs.length; i += 1) {
      const previous = chronologicalFuelLogs[i - 1];
      const current = chronologicalFuelLogs[i];
      if (current.odometerValue < previous.odometerValue) {
        backwardsSegments.push(`${formatFuelLogRef(previous)} -> ${formatFuelLogRef(current)}`);
        backwardsRefs.push(fuelLogRef(previous, "Open previous fuel log"), fuelLogRef(current, "Open next fuel log"));
      }
    }
    checks.push(backwardsSegments.length
      ? fail("Fuel odometers do not go backwards over time", backwardsSegments.slice(0, 3).join("; "), backwardsRefs.slice(0, 6))
      : pass("Fuel odometers do not go backwards over time"));

    const fullTankLogs = chronologicalFuelLogs.filter((fuel) => fuel.fullTank || fuel.full_tank);
    const partialFuelLogs = chronologicalFuelLogs.filter((fuel) => !(fuel.fullTank || fuel.full_tank));
    const impossibleSegments = [];
    for (let i = 1; i < fullTankLogs.length; i += 1) {
      const previous = fullTankLogs[i - 1];
      const current = fullTankLogs[i];
      if (current.odometerValue <= previous.odometerValue) continue;
      const km = current.odometerValue - previous.odometerValue;
      const estimatedUsed = km * consumption / 100;
      const partialFuel = partialFuelLogs
        .filter((fuel) => fuel.odometerValue > previous.odometerValue && fuel.odometerValue <= current.odometerValue)
        .reduce((sum, fuel) => sum + Math.max(0, safeNumber(fuel.liters)), 0);
      if (estimatedUsed > tankCapacity + partialFuel + toleranceLiters) {
        impossibleSegments.push(`${formatFuelLogRef(previous)} -> ${formatFuelLogRef(current)} (${km} km, approx. ${estimatedUsed.toFixed(1)} L used)`);
      }
    }
    checks.push(impossibleSegments.length
      ? warn("Full-tank odometer gaps fit configured capacity", `Large full-tank gap(s) may mean missing fuel logs or a typo: ${impossibleSegments.slice(0, 3).join("; ")}`)
      : pass("Full-tank odometer gaps fit configured capacity"));

    const syntheticTooLarge = tankCapacity + Math.max(1, toleranceLiters * 2);
    checks.push(syntheticTooLarge > tankCapacity + toleranceLiters
      ? pass("Tank-capacity overfill rule is represented", `${syntheticTooLarge.toFixed(1)} L would exceed ${tankCapacity} L.`)
      : fail("Tank-capacity overfill rule is represented"));

    return checks;
  }

  function runRuntimePwaChecks(input = {}) {
    const checks = [];
    const buildInfo = input.buildInfo || window.FuelBuildInfo?.BUILD_INFO;
    checks.push(buildInfo && buildInfo.version ? pass("Build info is loaded", buildInfo.version) : fail("Build info is loaded"));
    if (buildInfo && buildInfo.serviceWorkerCache && buildInfo.expectedServiceWorkerCache) {
      checks.push(buildInfo.serviceWorkerCache === buildInfo.expectedServiceWorkerCache ? pass("Service worker cache matches build info", buildInfo.serviceWorkerCache) : fail("Service worker cache matches build info", `${buildInfo.serviceWorkerCache} vs ${buildInfo.expectedServiceWorkerCache}`));
    } else if (buildInfo && buildInfo.expectedServiceWorkerCache) {
      checks.push(pass("Service worker cache metadata is available", `Unavailable in this browser session; expected ${buildInfo.expectedServiceWorkerCache}. Reload once if the PWA panel looks stale.`));
    } else {
      checks.push(pass("Service worker cache metadata is available", "Unavailable in this browser/session; not treated as a hard Test Lab failure."));
    }
    const runtimeGlobals = input.runtimeGlobals || window;
    const requiredGlobals = ["FuelLedgerModel", "FuelLocationPrivacy", "FuelPeriodClosing", "FuelTestLab", "permissionHelpers"];
    const missing = requiredGlobals.filter((name) => !runtimeGlobals[name]);
    checks.push(missing.length ? fail("Runtime helper modules are loaded", missing.join(", ")) : pass("Runtime helper modules are loaded"));
    return checks;
  }

  function runSyncReportChecks(input = {}) {
    const state = asObject(input.state);
    const reports = asArray(state.testLabReports);
    const checks = [];
    checks.push(reports.length <= 5 ? pass("Synced Test Lab report history is capped", `${reports.length} report(s)`) : fail("Synced Test Lab report history is capped", `${reports.length} report(s)`));
    const latest = reports[0];
    if (latest) {
      checks.push(latest.id && latest.syncedAt ? pass("Latest synced report has export metadata", latest.id) : fail("Latest synced report has export metadata"));
    } else {
      checks.push(pass("Synced report export can start empty", "No synced report yet."));
    }
    return checks;
  }

  function runSupabaseSecurityHealthChecks(input = {}) {
    const helper = input.securityHealthHelper || window.FuelSecurityHealth;
    if (!helper || typeof helper.buildSupabaseSecurityChecks !== "function") {
      return [fail("Supabase security health helper is available", "window.FuelSecurityHealth was not found.")];
    }
    return helper.buildSupabaseSecurityChecks({
      status: input.supabaseSecurityStatus || input.securityStatus || {}
    });
  }

  function runScenarioMatrixChecks(input = {}) {
    const scenarios = [
      { id: "ledger", name: "Ledger invariants", checks: runStateInvariantChecks(input) },
      { id: "payments", name: "Payment lifecycle", checks: runPaymentLifecycleChecks(input) },
      { id: "permissions", name: "Permission boundaries", checks: runPermissionBoundaryChecks(input) },
      { id: "backup", name: "Backup/import validation", checks: runBackupRoundTripChecks(input) },
      { id: "privacy", name: "Location privacy", checks: runLocationPrivacyChecks(input) },
      { id: "bookings", name: "Booking edge checks", checks: runBookingEdgeChecks(input) },
      { id: "fuel-capacity", name: "Fuel capacity and odometer checks", checks: runFuelCapacityChecks(input) },
      { id: "sync", name: "Sync/report storage", checks: runSyncReportChecks(input) },
      { id: "security", name: "Supabase security health", checks: runSupabaseSecurityHealthChecks(input) },
      { id: "runtime", name: "Runtime/PWA metadata", checks: runRuntimePwaChecks(input) }
    ];
    return scenarios.map((scenario) => {
      const checks = asArray(scenario.checks);
      const failedCount = checks.filter((check) => !check.ok).length;
      const warningCount = checks.filter(isWarning).length;
      return {
        ...scenario,
        ok: failedCount === 0,
        hasWarnings: warningCount > 0,
        passedCount: checks.length - failedCount,
        failedCount,
        warningCount
      };
    });
  }

  function flattenScenarioChecks(scenarios) {
    return asArray(scenarios).flatMap((scenario) => asArray(scenario.checks).map((check) => ({
      ...check,
      scenario: scenario.name || scenario.id || "Scenario"
    })));
  }

  function buildTestLabReport(input = {}) {
    const checks = asArray(input.checks);
    const failed = checks.filter((check) => !check.ok);
    const warnings = checks.filter(isWarning);
    return {
      id: input.id || createTestRunId(),
      scenario: input.scenario || "test-lab",
      startedAt: input.startedAt || new Date().toISOString(),
      finishedAt: input.finishedAt || new Date().toISOString(),
      ok: failed.length === 0,
      hasWarnings: warnings.length > 0,
      failedCount: failed.length,
      warningCount: warnings.length,
      passedCount: checks.length - failed.length,
      buildInfo: input.buildInfo || null,
      normalizedTableStatus: input.normalizedTableStatus || null,
      createdBy: input.createdBy || "",
      browser: input.browser || "",
      syncedAt: input.syncedAt || "",
      before: input.before || null,
      after: input.after || null,
      generated: input.generated || null,
      cleanup: input.cleanup || null,
      scenarios: asArray(input.scenarios),
      checks,
      errors: asArray(input.errors)
    };
  }


  function renderCheckRefs(check) {
    const refs = asArray(check && check.refs).filter((ref) => ref && ref.type && ref.id);
    if (!refs.length) return "";
    return `<div class="test-lab-ref-actions">${refs.map((ref) => {
      const type = escapeHtml(ref.type);
      const id = escapeHtml(ref.id);
      const label = escapeHtml(ref.label || `Open ${ref.type}`);
      const summary = ref.summary ? ` title="${escapeHtml(ref.summary)}"` : "";
      return `<button class="subtle-button compact-button" type="button" data-testlab-open-entry="${type}:${id}"${summary}>${label}</button>`;
    }).join("")}</div>`;
  }

  function renderCheckListItem(check, icon = null) {
    const marker = icon || checkIcon(check);
    return `<li>${marker} ${check.scenario ? `<small>${escapeHtml(check.scenario)}:</small> ` : ""}${escapeHtml(check.name)}${check.detail ? ` — <small>${escapeHtml(check.detail)}</small>` : ""}${renderCheckRefs(check)}</li>`;
  }

  function renderReportHtml(report) {
    if (!report) return "";
    const warnings = asArray(report.checks).filter(isWarning);
    const statusText = report.ok ? (warnings.length ? "Passed with warnings" : "Passed") : "Needs review";
    const statusIcon = report.ok ? (warnings.length ? "⚠️" : "✅") : "❌";
    const reportClass = report.ok ? (warnings.length ? "caution" : "ok") : "warning";
    const failedChecks = asArray(report.checks).filter((check) => !check.ok);
    const allChecks = asArray(report.checks);
    const scenarios = asArray(report.scenarios);
    const owner = report.createdBy ? ` · ${escapeHtml(report.createdBy)}` : "";
    const synced = report.syncedAt ? ` · synced ${escapeHtml(formatDateTime(report.syncedAt))}` : "";
    const runId = report.id ? escapeHtml(report.id) : "unknown run";
    const warningCount = report.warningCount ?? warnings.length;
    const scenarioChips = scenarios.length
      ? `<div class="test-lab-scenario-chips">${scenarios.map((scenario) => {
          const total = (scenario.passedCount || 0) + (scenario.failedCount || 0);
          const scenarioWarnings = scenario.warningCount || 0;
          const cls = scenario.ok ? (scenarioWarnings ? "caution" : "ok") : "warning";
          const icon = scenario.ok ? (scenarioWarnings ? "⚠️" : "✅") : "❌";
          const warningLabel = scenarioWarnings ? ` · ${scenarioWarnings} warning${scenarioWarnings === 1 ? "" : "s"}` : "";
          return `<span class="test-lab-chip ${cls}">${icon} ${escapeHtml(scenario.name || scenario.id)} ${scenario.passedCount || 0}/${total}${warningLabel}</span>`;
        }).join("")}</div>`
      : "";
    const failedHtml = failedChecks.length
      ? `<div class="test-lab-failures"><strong>Failed checks</strong><ul>${failedChecks.map((check) => renderCheckListItem(check, "❌")).join("")}</ul></div>`
      : "";
    const warningsHtml = warnings.length
      ? `<div class="test-lab-warnings"><strong>Warnings</strong><ul>${warnings.map((check) => renderCheckListItem(check, "⚠️")).join("")}</ul></div>`
      : "";
    const successHtml = !failedChecks.length && !warnings.length ? `<p class="test-lab-success-note">All reported checks passed.</p>` : "";
    const generated = report.generated
      ? `<p><strong>Generated:</strong> ${report.generated.trips || 0} trips, ${report.generated.fuel || 0} fuel logs, ${report.generated.bookings || 0} bookings.</p>`
      : "";
    const cleanup = report.cleanup
      ? `<p><strong>Cleanup:</strong> ${escapeHtml(report.cleanup.message || "complete")}</p>`
      : "";
    const errors = asArray(report.errors).length
      ? `<div class="test-lab-errors"><strong>Errors</strong><ul>${asArray(report.errors).map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul></div>`
      : "";
    const allChecksHtml = allChecks.length
      ? `<details class="test-lab-details"><summary>Show all ${allChecks.length} checks</summary><ul>${allChecks.map((check) => renderCheckListItem(check)).join("")}</ul></details>`
      : "";
    const countText = `${report.passedCount || 0} passed · ${warningCount || 0} warning${warningCount === 1 ? "" : "s"} · ${report.failedCount || 0} failed`;
    return `
      <div class="test-lab-report ${reportClass}">
        <div class="test-lab-report-header">
          <strong>${statusIcon} ${statusText}: ${escapeHtml(report.scenario || "Test Lab")}</strong>
          <span>${countText}</span>
        </div>
        <p class="entry-meta">${runId}${owner}${synced}</p>
        ${scenarioChips}
        ${failedHtml}
        ${warningsHtml}
        ${successHtml}
        ${generated}
        ${cleanup}
        ${errors}
        ${allChecksHtml}
      </div>
    `;
  }

  function formatDateTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value || "unknown time";
    return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  window.FuelTestLab = {
    DEFAULT_TEST_PREFIX,
    DEFAULT_TEST_MARKER,
    asArray,
    warn,
    createTestRunId,
    isTestLabEntry,
    stateSummary,
    generatedDataSummary,
    runStateInvariantChecks,
    runPaymentLifecycleChecks,
    runPermissionBoundaryChecks,
    runLocationPrivacyChecks,
    runBackupRoundTripChecks,
    runBookingEdgeChecks,
    runFuelCapacityChecks,
    runRuntimePwaChecks,
    runSyncReportChecks,
    runScenarioMatrixChecks,
    flattenScenarioChecks,
    buildTestLabReport,
    renderReportHtml
  };
})();
