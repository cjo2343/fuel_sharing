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

  function fail(name, detail = "") {
    return { ok: false, name, detail };
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

    const people = asArray(ledger.people);
    const netTotal = roundMoney(people.reduce((sum, person) => sum + safeNumber(person && person.balance), 0));
    checks.push(Math.abs(netTotal) <= 0.01 ? pass("Ledger net balances sum to 0.00", `Net total ${netTotal.toFixed(2)}`) : fail("Ledger net balances sum to 0.00", `Net total ${netTotal.toFixed(2)}`));

    const tripCostTotal = roundMoney(people.reduce((sum, person) => sum + safeNumber(person && person.cost), 0));
    const totalPaid = roundMoney(safeNumber(ledger.totalPaid));
    checks.push(Math.abs(tripCostTotal - totalPaid) <= 0.01 ? pass("Rounded trip costs match fuel paid", `${tripCostTotal.toFixed(2)} vs ${totalPaid.toFixed(2)}`) : fail("Rounded trip costs match fuel paid", `${tripCostTotal.toFixed(2)} vs ${totalPaid.toFixed(2)}`));

    const badSettlements = asArray(ledger.settlements).filter((settlement) => safeNumber(settlement && settlement.amount) <= 0 || !settlement.from || !settlement.to || settlement.from === settlement.to);
    checks.push(badSettlements.length ? fail("Settlement payments are valid", `${badSettlements.length} invalid settlement(s).`) : pass("Settlement payments are valid"));

    if (window.FuelPeriodClosing && typeof window.FuelPeriodClosing.isDuplicatePeriodSnapshot === "function") {
      const duplicate = window.FuelPeriodClosing.isDuplicatePeriodSnapshot({ trips: state.trips, fuel: state.fuel }, state.closedPeriods);
      checks.push(duplicate ? fail("Current period is not already archived", "This trip/fuel snapshot already exists in closed periods.") : pass("Current period is not already archived"));
    }

    return checks;
  }

  function buildTestLabReport(input = {}) {
    const checks = asArray(input.checks);
    const failed = checks.filter((check) => !check.ok);
    return {
      id: input.id || createTestRunId(),
      scenario: input.scenario || "test-lab",
      startedAt: input.startedAt || new Date().toISOString(),
      finishedAt: input.finishedAt || new Date().toISOString(),
      ok: failed.length === 0,
      failedCount: failed.length,
      passedCount: checks.length - failed.length,
      buildInfo: input.buildInfo || null,
      normalizedTableStatus: input.normalizedTableStatus || null,
      before: input.before || null,
      after: input.after || null,
      generated: input.generated || null,
      cleanup: input.cleanup || null,
      checks,
      errors: asArray(input.errors)
    };
  }

  function renderReportHtml(report) {
    if (!report) return "";
    const status = report.ok ? "✅ Passed" : "❌ Failed";
    const checks = asArray(report.checks).map((check) => `<li>${check.ok ? "✅" : "❌"} ${escapeHtml(check.name)}${check.detail ? ` — <small>${escapeHtml(check.detail)}</small>` : ""}</li>`).join("");
    const generated = report.generated ? `<p><strong>Generated:</strong> ${report.generated.trips || 0} trips, ${report.generated.fuel || 0} fuel logs, ${report.generated.bookings || 0} bookings.</p>` : "";
    const cleanup = report.cleanup ? `<p><strong>Cleanup:</strong> ${escapeHtml(report.cleanup.message || "complete")}</p>` : "";
    return `
      <div class="test-lab-report ${report.ok ? "ok" : "warning"}">
        <strong>${status}: ${escapeHtml(report.scenario || "Test Lab")}</strong>
        <p>${report.passedCount || 0} passed, ${report.failedCount || 0} failed · ${escapeHtml(report.id || "")}</p>
        ${generated}
        ${cleanup}
        <ul>${checks}</ul>
      </div>
    `;
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
    createTestRunId,
    isTestLabEntry,
    stateSummary,
    generatedDataSummary,
    runStateInvariantChecks,
    buildTestLabReport,
    renderReportHtml
  };
})();
