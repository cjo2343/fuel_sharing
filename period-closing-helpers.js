// Period closing safety helpers.
// Loaded before app.js; exposes pure helpers on window.FuelPeriodClosing.
(function () {
  const VALID_BLOCK_REASONS = new Set(["permission", "empty", "open-payments", "duplicate", "busy"]);

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function normalizeId(value) {
    return String(value || "").trim();
  }

  function sortedEntryIds(entries) {
    return asArray(entries)
      .map((entry) => normalizeId(entry && entry.id))
      .filter(Boolean)
      .sort();
  }

  function periodEntryFingerprint(trips, fuel) {
    return JSON.stringify({ trips: sortedEntryIds(trips), fuel: sortedEntryIds(fuel) });
  }

  function periodSnapshotFingerprint(period) {
    if (!period || typeof period !== "object") return periodEntryFingerprint([], []);
    if (period.entryFingerprint) return String(period.entryFingerprint);
    return periodEntryFingerprint(period.trips, period.fuel);
  }

  function isDuplicatePeriodSnapshot(current, closedPeriods) {
    const currentFingerprint = periodEntryFingerprint(current && current.trips, current && current.fuel);
    if (currentFingerprint === periodEntryFingerprint([], [])) return false;
    return asArray(closedPeriods).some((period) => periodSnapshotFingerprint(period) === currentFingerprint);
  }

  function normalizeProgress(progress) {
    const source = progress && typeof progress === "object" ? progress : {};
    return {
      totalCount: Math.max(0, Number(source.totalCount || 0)),
      openCount: Math.max(0, Number(source.openCount || 0)),
      requestedCount: Math.max(0, Number(source.requestedCount || 0)),
      paidCount: Math.max(0, Number(source.paidCount || 0))
    };
  }

  function getClosePeriodReadiness(input = {}) {
    const trips = asArray(input.trips);
    const fuel = asArray(input.fuel);
    const progress = normalizeProgress(input.progress);
    const options = input.options && typeof input.options === "object" ? input.options : {};
    const blockers = [];

    if (input.closingInProgress) blockers.push({ reason: "busy", message: "A period close is already in progress." });
    if (!input.isAdmin && !options.allowMemberClose) blockers.push({ reason: "permission", message: "Only an admin can close periods manually." });
    if (trips.length === 0 && fuel.length === 0) blockers.push({ reason: "empty", message: "Add trips or fuel before closing a period." });
    if (progress.openCount > 0 && !options.allowOpenPayments) {
      blockers.push({
        reason: "open-payments",
        message: `Request all settlement payments before closing this period. ${progress.openCount} payment${progress.openCount === 1 ? " is" : "s are"} still not requested.`
      });
    }
    if (!options.allowDuplicatePeriod && isDuplicatePeriodSnapshot({ trips, fuel }, input.closedPeriods)) {
      blockers.push({ reason: "duplicate", message: "This exact set of trips and fuel logs is already archived in a closed period." });
    }

    return {
      ok: blockers.length === 0,
      blockers,
      firstMessage: blockers[0] ? blockers[0].message : "",
      entryFingerprint: periodEntryFingerprint(trips, fuel),
      progress
    };
  }

  function assertKnownBlockers(result) {
    return asArray(result && result.blockers).every((blocker) => VALID_BLOCK_REASONS.has(blocker.reason));
  }

  window.FuelPeriodClosing = Object.freeze({
    periodEntryFingerprint,
    periodSnapshotFingerprint,
    isDuplicatePeriodSnapshot,
    getClosePeriodReadiness,
    assertKnownBlockers
  });
})();
